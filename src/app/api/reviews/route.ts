import { NextRequest } from 'next/server';
import { getAll, create, update, query } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth';
import { sepoliaPublicClient } from '@/lib/chain';
import { CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';
import { nexotiqFactoryABI, nexotiqDealABI } from '@/lib/contracts/abis';

/**
 * Verified Deal Reviews API (Off-Chain Storage)
 *
 * Enforces:
 * 1. Bearer JWT session authentication (wallet ownership)
 * 2. Authentic Sepolia Synq deal verification via NexotiqFactory.isDeal
 * 3. Completed deal status check (status === 2)
 * 4. Buyer authorization (only deal.buyer can review)
 * 5. Authoritative seller binding from deal contract
 * 6. Self-deal rejection (buyer !== seller)
 * 7. One provider review per dealAddress (upsert on re-submission)
 */

const isWallet = (w: unknown): w is string => typeof w === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w);
const lc = (w: string) => w.toLowerCase();
const MAX_COMMENT = 1000;
const MAX_NAME = 60;
const MAX_BATCH_SIZE = 100;

export interface Review {
  id: string;
  sellerWallet: string;
  reviewerWallet: string;
  dealAddress?: string;
  reviewerName?: string;
  rating: number;
  comment: string;
  role: string;
  verifiedDeal?: boolean;
  createdAt: string;
  updatedAt?: string;
}

function summarize(reviews: Review[]) {
  const verified = (reviews || []).filter((r) => r && r.verifiedDeal === true);
  const breakdown: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let sum = 0;
  for (const r of verified) {
    const k = String(r.rating);
    if (breakdown[k] !== undefined) breakdown[k] += 1;
    sum += Number(r.rating) || 0;
  }
  const count = verified.length;
  return { average: count ? sum / count : 0, count, breakdown };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sellersParam = url.searchParams.get('sellers');
  const seller = url.searchParams.get('seller');
  const reviewer = url.searchParams.get('reviewer');

  // Batch review count query: GET /api/reviews?sellers=0x123...,0x456...
  if (sellersParam) {
    const rawWallets = sellersParam.split(',').map((w) => w.trim()).filter(Boolean);
    const validWallets = rawWallets.filter(isWallet).slice(0, MAX_BATCH_SIZE);
    const uniqueWalletsSet = new Set(validWallets.map(lc));
    const all = (await getAll('reviews')) as Review[];

    const counts: Record<string, number> = {};
    for (const w of Array.from(uniqueWalletsSet)) {
      counts[w] = 0;
    }

    for (const r of all) {
      if (r && r.sellerWallet && r.verifiedDeal === true) {
        const w = lc(String(r.sellerWallet));
        if (uniqueWalletsSet.has(w)) {
          counts[w] = (counts[w] || 0) + 1;
        }
      }
    }

    return Response.json({ counts });
  }

  // Single seller query: GET /api/reviews?seller=...
  if (!isWallet(seller)) {
    return Response.json({ error: 'Valid seller wallet required' }, { status: 400 });
  }
  const sellerLc = lc(seller);
  const all = (await getAll('reviews')) as Review[];
  const forSeller = all
    .filter((r) => r && String(r.sellerWallet).toLowerCase() === sellerLc)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());

  const mine = isWallet(reviewer)
    ? forSeller.find((r) => String(r.reviewerWallet).toLowerCase() === lc(reviewer)) || null
    : undefined;

  return Response.json({ reviews: forSeller, summary: summarize(forSeller), mine });
}

export async function POST(req: NextRequest) {
  try {
    // 1. Require Bearer JWT session authentication
    const authUser = getUserFromRequest(req);
    if (!authUser || !authUser.walletAddress) {
      return Response.json({ error: 'Authentication required. Please sign in with your wallet session.' }, { status: 401 });
    }
    const authenticatedWallet = lc(authUser.walletAddress);

    const body = await req.json();
    const { dealAddress, reviewerWallet, sellerWallet, rating, comment, reviewerName } = body;

    // 2. Reject request if body reviewer wallet is supplied and does not match authenticated session
    if (reviewerWallet && isWallet(reviewerWallet) && lc(reviewerWallet) !== authenticatedWallet) {
      return Response.json({ error: 'Unauthorized: Bearer token wallet does not match reviewer wallet' }, { status: 403 });
    }

    // 3. Require dealAddress EVM address
    if (!isWallet(dealAddress)) {
      return Response.json({ error: 'Valid dealAddress EVM address is required for review submission' }, { status: 400 });
    }
    const normalizedDealAddress = lc(dealAddress);

    // 4. Validate rating (integer between 1 and 5)
    if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return Response.json({ error: 'Rating must be an integer between 1 and 5' }, { status: 400 });
    }

    // 5. Validate comment (non-empty trimmed string, max 1000 chars)
    if (typeof comment !== 'string' || comment.trim().length === 0) {
      return Response.json({ error: 'Comment must be a non-empty string' }, { status: 400 });
    }
    const cleanComment = comment.trim();
    if (cleanComment.length > MAX_COMMENT) {
      return Response.json({ error: `Comment cannot exceed ${MAX_COMMENT} characters` }, { status: 400 });
    }
    const cleanName = typeof reviewerName === 'string' ? reviewerName.trim().slice(0, MAX_NAME) : '';

    // 6. Read deal contract details from Sepolia (buyer, seller, status)
    let dealBuyer: string;
    let dealSeller: string;
    let dealStatus: number;

    try {
      const [bRes, sRes, statusRes] = await Promise.all([
        sepoliaPublicClient.readContract({ address: dealAddress as `0x${string}`, abi: nexotiqDealABI, functionName: 'buyer' }),
        sepoliaPublicClient.readContract({ address: dealAddress as `0x${string}`, abi: nexotiqDealABI, functionName: 'seller' }),
        sepoliaPublicClient.readContract({ address: dealAddress as `0x${string}`, abi: nexotiqDealABI, functionName: 'status' }),
      ]);
      dealBuyer = lc(bRes as string);
      dealSeller = lc(sRes as string);
      dealStatus = Number(statusRes);
    } catch {
      return Response.json({ error: 'Failed to read deal contract details from Sepolia network' }, { status: 500 });
    }

    // 7. Verify deal authenticity on Sepolia via NexotiqFactory.getUserDeals
    // Note: The deployed Sepolia Factory predates the local isDeal() helper.
    // Verify Factory membership through the deployed getUserDeals(buyer) interface.
    let isAuthentic = false;
    try {
      const userDeals = (await sepoliaPublicClient.readContract({
        address: CONTRACT_ADDRESSES.sepolia.NexotiqFactory as `0x${string}`,
        abi: nexotiqFactoryABI,
        functionName: 'getUserDeals',
        args: [dealBuyer as `0x${string}`],
      })) as any[];

      isAuthentic = Array.isArray(userDeals) && userDeals.some(
        (d: any) => d && d.dealAddress && lc(String(d.dealAddress)) === normalizedDealAddress
      );
    } catch (err: unknown) {
      console.error(
        '[API /api/reviews] Factory deal-membership verification failed:',
        err instanceof Error ? err.message : String(err)
      );
      return Response.json({ error: 'Failed to verify deal authenticity on Sepolia network. Please retry.' }, { status: 500 });
    }

    if (!isAuthentic) {
      return Response.json({ error: 'Specified deal address is not an authentic Synq deal created by the Factory' }, { status: 404 });
    }

    // 8. Verify deal status is Completed (DealStatus.Completed === 2)
    if (dealStatus !== 2) {
      return Response.json({ error: 'Only Completed deals are eligible for provider reviews' }, { status: 400 });
    }

    // 9. Verify authenticated user is the designated buyer/client of the deal
    if (authenticatedWallet !== dealBuyer) {
      return Response.json({ error: 'Only the designated deal buyer (client) can submit a provider review' }, { status: 403 });
    }

    // 10. Verify sellerWallet if provided in body matches deal seller
    if (sellerWallet && isWallet(sellerWallet) && lc(sellerWallet) !== dealSeller) {
      return Response.json({ error: 'sellerWallet in body does not match the deal seller' }, { status: 400 });
    }

    // 11. Reject self-deals (buyer === seller)
    if (dealBuyer === dealSeller) {
      return Response.json({ error: 'Self-deals are not eligible for provider reviews.' }, { status: 400 });
    }

    // 12. Upsert review based on unique dealAddress
    const existing = (await query(
      'reviews',
      (r: any) => r && r.dealAddress && lc(String(r.dealAddress)) === normalizedDealAddress,
    )) as Review[];

    const patch = {
      dealAddress: normalizedDealAddress,
      reviewerWallet: authenticatedWallet,
      sellerWallet: dealSeller,
      reviewerName: cleanName || undefined,
      rating,
      comment: cleanComment,
      role: 'client',
      verifiedDeal: true,
      updatedAt: new Date().toISOString(),
    };

    const review = existing[0]
      ? await update('reviews', existing[0].id, patch)
      : await create('reviews', { ...patch, createdAt: new Date().toISOString() });

    const all = (await getAll('reviews')) as Review[];
    const forSeller = all.filter((r) => r && lc(String(r.sellerWallet)) === dealSeller);

    return Response.json({ ok: true, review, summary: summarize(forSeller) });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to save review' }, { status: 500 });
  }
}
