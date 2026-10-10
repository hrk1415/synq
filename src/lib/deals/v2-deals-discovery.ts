/**
 * Synq Standard V2 Deal Discovery & Enumeration Layer
 * Source of truth: contracts/v1/ISynqFactoryV2.sol & contracts/v1/ISynqDeal.sol
 */

import { isAddress, getAddress } from 'viem';
import { synqFactoryV2ABI, synqDealV1ABI } from '@/lib/contracts/abis';
import { ZERO_ADDRESS } from '@/lib/deals/v2';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';

export interface DiscoveredV2Deal {
  dealAddress: `0x${string}`;
  client: `0x${string}`;
  freelancer: `0x${string}`;
  totalEscrow: bigint;
  state: number;
  title: string;
  createdAt?: string;
  protectionSelection?: string;
  proposalId?: string;
}

export interface DealContractState {
  state: number;
  client: `0x${string}`;
  freelancer: `0x${string}`;
  totalEscrow: bigint;
}

export interface DealProposalMetadata {
  title: string;
  proposalId: string;
  createdAt: string;
  protectionSelection: string;
}

export const V2_DEAL_STATE_LABELS: Record<string, string> = {
  '0': 'Draft',
  '1': 'Active',
  '2': 'Completed',
  '3': 'Terminated',
  '4': 'Cancelled',
};

export const V2_STATUS_BADGE_VARIANT: Record<string, 'secondary' | 'info' | 'success' | 'destructive'> = {
  '0': 'secondary',
  '1': 'info',
  '2': 'success',
  '3': 'destructive',
  '4': 'secondary',
};

export const DEFAULT_V2_DEAL_TITLE = 'Synq Deal';

export interface PublicClientReader {
  readContract: (args: any) => Promise<any>;
  multicall?: (args: any) => Promise<any[]>;
}

/** Helper to bound RPC calls so hanging public nodes fail fast. */
async function withTimeout<T>(promise: Promise<T>, ms: number = 8000, fallbackVal?: T): Promise<T> {
  let timer: any;
  const timeoutPromise = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (fallbackVal !== undefined) resolve(fallbackVal);
      else reject(new Error(`RPC operation timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enumerates all deal addresses associated with a wallet on canonical SynqFactoryV2.
 * Uses on-chain count functions and bounded pagination to ensure deals 51+ are never lost.
 * Employs multicall and request batching to protect public RPC rate limits.
 */
export async function fetchUserDealAddressesFromFactory(
  publicClient: PublicClientReader,
  factoryAddress: `0x${string}`,
  userWallet: string,
  pageSize: number = 50,
): Promise<{ clientDeals: string[]; freelancerDeals: string[] }> {
  if (!userWallet || typeof userWallet !== 'string') {
    return { clientDeals: [], freelancerDeals: [] };
  }
  const trimmed = userWallet.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return { clientDeals: [], freelancerDeals: [] };
  }
  const normUser = getAddress(trimmed);

  // 1. Fetch exact deal counts on-chain (using multicall if available to avoid multiple round trips)
  let clientCount = 0;
  let freelancerCount = 0;
  let countFetched = false;

  if (typeof publicClient.multicall === 'function') {
    try {
      const countResults = await withTimeout(
        publicClient.multicall({
          contracts: [
            {
              address: factoryAddress,
              abi: synqFactoryV2ABI,
              functionName: 'getDealsCountByClient',
              args: [normUser],
            },
            {
              address: factoryAddress,
              abi: synqFactoryV2ABI,
              functionName: 'getDealsCountByFreelancer',
              args: [normUser],
            },
          ],
          allowFailure: true,
        }),
        8000,
      );
      if (countResults && countResults.length === 2) {
        const cItem = countResults[0];
        const fItem = countResults[1];
        const cVal = cItem?.status === 'success' ? cItem.result : (typeof cItem === 'bigint' ? cItem : undefined);
        const fVal = fItem?.status === 'success' ? fItem.result : (typeof fItem === 'bigint' ? fItem : undefined);
        if (cVal !== undefined && fVal !== undefined) {
          clientCount = Number(cVal || 0n);
          freelancerCount = Number(fVal || 0n);
          countFetched = true;
        }
      }
    } catch {
      // Fall through to individual reads
    }
  }

  if (!countFetched) {
    try {
      const [clientCountBn, freelancerCountBn] = await Promise.all([
        publicClient.readContract({
          address: factoryAddress,
          abi: synqFactoryV2ABI,
          functionName: 'getDealsCountByClient',
          args: [normUser],
        }).catch(() => 0n) as Promise<bigint>,
        publicClient.readContract({
          address: factoryAddress,
          abi: synqFactoryV2ABI,
          functionName: 'getDealsCountByFreelancer',
          args: [normUser],
        }).catch(() => 0n) as Promise<bigint>,
      ]);
      clientCount = Number(clientCountBn || 0n);
      freelancerCount = Number(freelancerCountBn || 0n);
    } catch (err) {
      console.warn('[fetchUserDealAddressesFromFactory] Count read error:', err);
    }
  }

  if (clientCount === 0 && freelancerCount === 0) {
    return { clientDeals: [], freelancerDeals: [] };
  }

  // 2. Fetch pages across client and freelancer
  const pageCalls: any[] = [];
  const clientPageIndices: number[] = [];
  const freelancerPageIndices: number[] = [];

  for (let offset = 0; offset < clientCount; offset += pageSize) {
    const limit = Math.min(pageSize, clientCount - offset);
    clientPageIndices.push(pageCalls.length);
    pageCalls.push({
      address: factoryAddress,
      abi: synqFactoryV2ABI,
      functionName: 'getDealsByClient',
      args: [normUser, BigInt(offset), BigInt(limit)],
    });
  }

  for (let offset = 0; offset < freelancerCount; offset += pageSize) {
    const limit = Math.min(pageSize, freelancerCount - offset);
    freelancerPageIndices.push(pageCalls.length);
    pageCalls.push({
      address: factoryAddress,
      abi: synqFactoryV2ABI,
      functionName: 'getDealsByFreelancer',
      args: [normUser, BigInt(offset), BigInt(limit)],
    });
  }

  // Attempt multicall for all page queries in one request
  if (pageCalls.length > 0 && typeof publicClient.multicall === 'function') {
    try {
      const pageResults = await withTimeout(
        publicClient.multicall({
          contracts: pageCalls,
          allowFailure: true,
        }),
        8000,
      );

      const clientDeals = clientPageIndices.flatMap((idx) => {
        const item = pageResults[idx];
        const res = item?.status === 'success' ? item.result : (Array.isArray(item) ? item : undefined);
        return Array.isArray(res) ? (res as string[]) : [];
      });

      const freelancerDeals = freelancerPageIndices.flatMap((idx) => {
        const item = pageResults[idx];
        const res = item?.status === 'success' ? item.result : (Array.isArray(item) ? item : undefined);
        return Array.isArray(res) ? (res as string[]) : [];
      });

      if (clientDeals.length > 0 || freelancerDeals.length > 0) {
        return { clientDeals, freelancerDeals };
      }
    } catch {
      // Fall through to individual page reads
    }
  }

  // Fallback: Individual bounded page reads
  const clientPagePromises: Promise<string[]>[] = [];
  for (let offset = 0; offset < clientCount; offset += pageSize) {
    const limit = Math.min(pageSize, clientCount - offset);
    clientPagePromises.push(
      publicClient.readContract({
        address: factoryAddress,
        abi: synqFactoryV2ABI,
        functionName: 'getDealsByClient',
        args: [normUser, BigInt(offset), BigInt(limit)],
      }).catch(() => []) as Promise<string[]>,
    );
  }

  const freelancerPagePromises: Promise<string[]>[] = [];
  for (let offset = 0; offset < freelancerCount; offset += pageSize) {
    const limit = Math.min(pageSize, freelancerCount - offset);
    freelancerPagePromises.push(
      publicClient.readContract({
        address: factoryAddress,
        abi: synqFactoryV2ABI,
        functionName: 'getDealsByFreelancer',
        args: [normUser, BigInt(offset), BigInt(limit)],
      }).catch(() => []) as Promise<string[]>,
    );
  }

  const [clientPages, freelancerPages] = await Promise.all([
    Promise.all(clientPagePromises),
    Promise.all(freelancerPagePromises),
  ]);

  return {
    clientDeals: clientPages.flat(),
    freelancerDeals: freelancerPages.flat(),
  };
}

/**
 * Deduplicates and normalizes deal addresses case-insensitively.
 * Excludes invalid format and zero addresses.
 */
export function mergeAndDeduplicateDealAddresses(
  clientDeals: readonly string[],
  freelancerDeals: readonly string[],
): `0x${string}`[] {
  const seen = new Set<string>();
  const unique: `0x${string}`[] = [];

  const allDeals = [...(clientDeals || []), ...(freelancerDeals || [])];
  for (const raw of allDeals) {
    if (!raw || typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) continue;
    const lower = trimmed.toLowerCase();
    if (lower === ZERO_ADDRESS.toLowerCase()) continue;
    if (!seen.has(lower)) {
      seen.add(lower);
      unique.push(getAddress(trimmed));
    }
  }

  return unique;
}

/**
 * Batch-reads authoritative V2 deal contract state (state, client, freelancer, totalEscrow).
 * Fails safely per deal so that one corrupt/reverting deal does not crash the dashboard.
 */
export async function fetchV2DealsSummary(
  publicClient: PublicClientReader,
  dealAddresses: readonly `0x${string}`[],
): Promise<Map<string, DealContractState>> {
  const result = new Map<string, DealContractState>();
  if (!dealAddresses.length) return result;

  // If publicClient provides multicall, batch reads efficiently
  if (typeof publicClient.multicall === 'function') {
    const calls = dealAddresses.flatMap((addr) => [
      { address: addr, abi: synqDealV1ABI, functionName: 'state' },
      { address: addr, abi: synqDealV1ABI, functionName: 'client' },
      { address: addr, abi: synqDealV1ABI, functionName: 'freelancer' },
      { address: addr, abi: synqDealV1ABI, functionName: 'totalEscrow' },
    ]);

    try {
      const multiResults = await withTimeout(
        publicClient.multicall({
          contracts: calls,
          allowFailure: true,
        }),
        8000,
      );

      dealAddresses.forEach((addr, i) => {
        const stateRes = multiResults[i * 4];
        const clientRes = multiResults[i * 4 + 1];
        const flRes = multiResults[i * 4 + 2];
        const escrowRes = multiResults[i * 4 + 3];

        const stateVal = stateRes?.status === 'success' ? stateRes.result : (typeof stateRes === 'number' ? stateRes : undefined);
        const clientVal = clientRes?.status === 'success' ? clientRes.result : (typeof clientRes === 'string' ? clientRes : undefined);
        const flVal = flRes?.status === 'success' ? flRes.result : (typeof flRes === 'string' ? flRes : undefined);
        const escrowVal = escrowRes?.status === 'success' ? escrowRes.result : (typeof escrowRes === 'bigint' ? escrowRes : undefined);

        if (
          stateVal !== undefined &&
          clientVal &&
          flVal &&
          escrowVal !== undefined
        ) {
          result.set(addr.toLowerCase(), {
            state: Number(stateVal),
            client: getAddress(clientVal as string),
            freelancer: getAddress(flVal as string),
            totalEscrow: BigInt(escrowVal as string | bigint | number),
          });
        }
      });
      return result;
    } catch (err) {
      console.warn('[fetchV2DealsSummary] Multicall failed, falling back to chunked reads:', err);
    }
  }

  // Fallback: chunked individual contract reads (chunks of 4) to prevent socket & rate limit exhaustion
  const CHUNK_SIZE = 4;
  for (let i = 0; i < dealAddresses.length; i += CHUNK_SIZE) {
    const chunk = dealAddresses.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (addr) => {
        try {
          const [stateNum, client, freelancer, totalEscrow] = await Promise.all([
            publicClient.readContract({ address: addr, abi: synqDealV1ABI, functionName: 'state' }),
            publicClient.readContract({ address: addr, abi: synqDealV1ABI, functionName: 'client' }),
            publicClient.readContract({ address: addr, abi: synqDealV1ABI, functionName: 'freelancer' }),
            publicClient.readContract({ address: addr, abi: synqDealV1ABI, functionName: 'totalEscrow' }),
          ]);
          result.set(addr.toLowerCase(), {
            state: Number(stateNum),
            client: getAddress(client as string),
            freelancer: getAddress(freelancer as string),
            totalEscrow: BigInt(totalEscrow as string | bigint | number),
          });
        } catch (err) {
          console.warn(`[fetchV2DealsSummary] Safe deal read failure for ${addr}:`, err);
        }
      }),
    );
  }

  return result;
}

/**
 * Derives user's counterparty address and role for a deal.
 */
export function determineCounterparty(
  userWallet: string | undefined | null,
  client: string,
  freelancer: string,
): { counterpartyWallet: string; role: 'Client' | 'Freelancer' | 'Participant' } {
  const normUser = userWallet ? userWallet.toLowerCase() : '';
  const normClient = client.toLowerCase();
  const normFreelancer = freelancer.toLowerCase();

  if (normUser && normUser === normClient) {
    return { counterpartyWallet: freelancer, role: 'Client' };
  }
  if (normUser && normUser === normFreelancer) {
    return { counterpartyWallet: client, role: 'Freelancer' };
  }
  return { counterpartyWallet: freelancer, role: 'Participant' };
}

/**
 * Combines authoritative on-chain deal state with optional PostgreSQL metadata.
 * Missing metadata falls back safely to 'Synq Deal' without hiding the card.
 */
export function enrichDealsWithMetadata(
  dealAddresses: readonly `0x${string}`[],
  onChainStates: Map<string, DealContractState>,
  metadataMap: Record<string, DealProposalMetadata>,
): DiscoveredV2Deal[] {
  const deals: DiscoveredV2Deal[] = [];

  for (const addr of dealAddresses) {
    const key = addr.toLowerCase();
    const contractState = onChainStates.get(key);
    if (!contractState) {
      // Contract state read failed completely, skip
      continue;
    }

    const meta = metadataMap[key];
    deals.push({
      dealAddress: addr,
      client: contractState.client,
      freelancer: contractState.freelancer,
      totalEscrow: contractState.totalEscrow,
      state: contractState.state,
      title: meta?.title?.trim() || DEFAULT_V2_DEAL_TITLE,
      createdAt: meta?.createdAt,
      protectionSelection: meta?.protectionSelection,
      proposalId: meta?.proposalId,
    });
  }

  return deals;
}
