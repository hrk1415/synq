import { sepoliaPublicClient } from '@/lib/chain';
import { nexotiqFactoryABI } from '@/lib/contracts/abis';
import { CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';
import type { Abi } from 'viem';

/** Minimal deal status ABI snippet for reading status() */
export const dealStatusABI = [
  {
    type: 'function',
    name: 'status',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8', internalType: 'enum NexotiqDeal.DealStatus' }],
  },
] as const;

/** Status.Completed in NexotiqDeal enum (Draft=0, Active=1, Completed=2, Disputed=3, Cancelled=4) */
export const STATUS_COMPLETED = 2;

export interface RawFactoryDeal {
  dealAddress?: string;
  buyer?: string;
  seller?: string;
  totalValue?: bigint;
  createdAt?: bigint;
  active?: boolean;
  asset?: string;
}

/**
 * Pure domain helper to filter factory deals for a target freelancer wallet.
 *
 * Rules:
 * 1. deal.seller == targetWallet (case-insensitive)
 * 2. deal.buyer != deal.seller (exclude self-deals)
 */
export function filterSellerDeals(
  deals: readonly RawFactoryDeal[],
  targetWallet: string
): `0x${string}`[] {
  if (!deals || !targetWallet || !targetWallet.startsWith('0x')) return [];
  const targetLower = targetWallet.toLowerCase();
  const addresses: `0x${string}`[] = [];
  const seen = new Set<string>();

  for (const d of deals) {
    if (!d?.dealAddress || !d?.seller || !d?.buyer) continue;
    const dealAddrLower = String(d.dealAddress).toLowerCase();
    const sellerLower = String(d.seller).toLowerCase();
    const buyerLower = String(d.buyer).toLowerCase();

    // Must be seller, must not be self-deal
    if (sellerLower === targetLower && buyerLower !== sellerLower) {
      if (!seen.has(dealAddrLower)) {
        seen.add(dealAddrLower);
        addresses.push(d.dealAddress as `0x${string}`);
      }
    }
  }
  return addresses;
}

/**
 * Server-side batch reader for authoritative freelancer completed deal counts.
 * Uses Viem multicall to fetch getUserDeals for multiple wallets and read status() for all unique deals.
 */
export async function getFreelancerCompletedDealsBatch(
  wallets: string[]
): Promise<Record<string, number>> {
  const factoryAddress = CONTRACT_ADDRESSES.sepolia.NexotiqFactory as `0x${string}`;
  const validWallets = Array.from(
    new Set(
      wallets
        .filter((w) => typeof w === 'string' && w.startsWith('0x') && w.length === 42)
        .map((w) => w.toLowerCase())
    )
  );

  const resultMap: Record<string, number> = {};
  if (validWallets.length === 0) return resultMap;

  try {
    // 1st Multicall: NexotiqFactory.getUserDeals for each wallet
    const getUserDealsCalls = validWallets.map((w) => ({
      address: factoryAddress,
      abi: nexotiqFactoryABI as Abi,
      functionName: 'getUserDeals' as const,
      args: [w as `0x${string}`],
    }));

    const factoryResults = await sepoliaPublicClient.multicall({
      contracts: getUserDealsCalls,
      allowFailure: true,
    });

    const walletDealsMap: Record<string, `0x${string}`[]> = {};
    const uniqueDealAddressesSet = new Set<string>();
    const uniqueDealAddresses: `0x${string}`[] = [];

    validWallets.forEach((walletLower, idx) => {
      const res = factoryResults[idx];
      if (res && res.status === 'success' && Array.isArray(res.result)) {
        const sellerDeals = filterSellerDeals(res.result as RawFactoryDeal[], walletLower);
        walletDealsMap[walletLower] = sellerDeals;
        for (const dealAddr of sellerDeals) {
          const lower = dealAddr.toLowerCase();
          if (!uniqueDealAddressesSet.has(lower)) {
            uniqueDealAddressesSet.add(lower);
            uniqueDealAddresses.push(dealAddr);
          }
        }
      } else {
        walletDealsMap[walletLower] = [];
      }
    });

    if (uniqueDealAddresses.length === 0) {
      validWallets.forEach((w) => {
        resultMap[w] = 0;
      });
      return resultMap;
    }

    // 2nd Multicall: NexotiqDeal.status() for each unique deal
    const statusCalls = uniqueDealAddresses.map((addr) => ({
      address: addr,
      abi: dealStatusABI,
      functionName: 'status' as const,
    }));

    const statusResults = await sepoliaPublicClient.multicall({
      contracts: statusCalls,
      allowFailure: true,
    });

    const dealStatusMap: Record<string, number> = {};
    uniqueDealAddresses.forEach((addr, idx) => {
      const res = statusResults[idx];
      if (res && res.status === 'success') {
        dealStatusMap[addr.toLowerCase()] = Number(res.result);
      }
    });

    validWallets.forEach((walletLower) => {
      const deals = walletDealsMap[walletLower] || [];
      let count = 0;
      for (const dealAddr of deals) {
        const st = dealStatusMap[dealAddr.toLowerCase()];
        if (st === STATUS_COMPLETED) {
          count++;
        }
      }
      resultMap[walletLower] = count;
    });

    return resultMap;
  } catch (err) {
    console.error('[getFreelancerCompletedDealsBatch] Server batch read error:', err);
    return resultMap;
  }
}
