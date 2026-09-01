import { NextRequest } from 'next/server';
import { getAll, create, update, query } from '@/lib/db';

/**
 * Buyer → seller reviews (star rating + comment), stored off-chain in the
 * `reviews` collection. Unauthenticated by design — identity in this app is the
 * connected wallet and there is no client session, so wallets are passed in the
 * query/body, exactly like /api/profile and /api/messages. One review per
 * (reviewerWallet, sellerWallet) pair; POST upserts. See the plan's
 * "Notes / limitations" for the follow-up signature-gating.
 */

const isWallet = (w: unknown): w is string => typeof w === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w);
const lc = (w: string) => w.toLowerCase();
const MAX_COMMENT = 600;
const MAX_NAME = 60;

interface Review {
  id: string;
  sellerWallet: string;
  reviewerWallet: string;
  reviewerName?: string;
  rating: number;
  comment: string;
  createdAt: string;
  updatedAt?: string;
}

function summarize(reviews: Review[]) {
  const breakdown: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let sum = 0;
  for (const r of reviews) {
    const k = String(r.rating);
    if (breakdown[k] !== undefined) breakdown[k] += 1;
    sum += Number(r.rating) || 0;
  }
  const count = reviews.length;
  return { average: count ? sum / count : 0, count, breakdown };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const seller = url.searchParams.get('seller');
  const reviewer = url.searchParams.get('reviewer');
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
    const body = await req.json();
    const { sellerWallet, reviewerWallet, rating, comment, reviewerName } = body;

    if (!isWallet(sellerWallet) || !isWallet(reviewerWallet)) {
      return Response.json({ error: 'Valid wallet addresses required' }, { status: 400 });
    }
    if (lc(sellerWallet) === lc(reviewerWallet)) {
      return Response.json({ error: "You can't review yourself" }, { status: 400 });
    }
    const stars = Math.round(Number(rating));
    if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
      return Response.json({ error: 'Rating must be between 1 and 5' }, { status: 400 });
    }
    const cleanComment = typeof comment === 'string' ? comment.trim().slice(0, MAX_COMMENT) : '';
    const cleanName = typeof reviewerName === 'string' ? reviewerName.trim().slice(0, MAX_NAME) : '';

    const sellerLc = lc(sellerWallet);
    const reviewerLc = lc(reviewerWallet);

    const existing = (await query(
      'reviews',
      (r: any) => String(r.reviewerWallet).toLowerCase() === reviewerLc && String(r.sellerWallet).toLowerCase() === sellerLc,
    )) as Review[];

    const patch = {
      sellerWallet: sellerLc,
      reviewerWallet: reviewerLc,
      reviewerName: cleanName || undefined,
      rating: stars,
      comment: cleanComment,
    };

    const review = existing[0]
      ? await update('reviews', existing[0].id, patch)
      : await create('reviews', { ...patch, createdAt: new Date().toISOString() });

    const all = (await getAll('reviews')) as Review[];
    const forSeller = all.filter((r) => r && String(r.sellerWallet).toLowerCase() === sellerLc);

    return Response.json({ ok: true, review, summary: summarize(forSeller) });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to save review' }, { status: 500 });
  }
}
