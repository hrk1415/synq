/**
 * Synq Standard V2 Proposal Action Helpers & Pre-flight Validation
 * Source of truth: contracts/v1/ISynqFactoryV2.sol & contracts/v1/SynqFactoryV2.sol
 */

import { getAddress, isAddress } from 'viem';
import type { DealProposalV2, StandardV2MilestoneInit } from '@/types/deal-v2';
import type { SerializedDealProposal } from '@/lib/deals/proposals-db';
import { SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import { synqFactoryV2ABI } from '@/lib/contracts/abis';
import { sepoliaPublicClient } from '@/lib/chain';
import {
  ZERO_ADDRESS,
  ZERO_BYTES32,
  hashStandardV2Milestones,
  hashDealProposalV2,
  verifyDealProposalSignature,
} from '@/lib/deals/v2';
import { normalizeWallet } from '@/lib/utils';

/**
 * Reconstructs the exact canonical DealProposalV2 struct from a serialized proposal record.
 * Guarantees identical field ordering and types matching DEAL_PROPOSAL_TYPEHASH.
 */
export function buildProposalStructFromSerialized(proposal: SerializedDealProposal): DealProposalV2 {
  return {
    client: getAddress(proposal.clientWallet),
    freelancer: getAddress(proposal.freelancerWallet),
    canonicalUsdc: getAddress(proposal.canonicalUsdc),
    dealImplementation: getAddress(proposal.dealImplementation),
    primaryResolver: getAddress(proposal.primaryResolver),
    emergencyResolver: getAddress(proposal.emergencyResolver),
    milestonesHash: proposal.milestonesHash as `0x${string}`,
    isProtected: Boolean(proposal.isProtected),
    protectionModule: getAddress(proposal.protectionModule),
    policyId: proposal.policyId as `0x${string}`,
    proposalNonce: BigInt(proposal.proposalNonce),
    expiry: BigInt(proposal.expiry),
  };
}

/**
 * Reconstructs the exact array of MilestoneInit structs from persisted milestones.
 * Matches: tuple(uint256 amount,uint64 workDeadline,uint64 reviewWindow,uint64 gracePeriod,bytes32 specHash)
 */
export function buildMilestoneInitsFromSerialized(
  milestones: SerializedDealProposal['milestones']
): StandardV2MilestoneInit[] {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    throw new Error('Milestones array must not be empty');
  }

  return milestones.map((m, index) => {
    const specHash = String(m.specHash || '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(specHash)) {
      throw new Error(`Milestone [${index}] has invalid specHash`);
    }

    const amount = BigInt(m.amount);
    const workDeadline = BigInt(m.workDeadline);
    const reviewWindow = BigInt(m.reviewWindow);
    const gracePeriod = BigInt(m.gracePeriod);

    if (amount <= 0n) {
      throw new Error(`Milestone [${index}] amount must be positive`);
    }

    return {
      amount,
      workDeadline,
      reviewWindow,
      gracePeriod,
      specHash: specHash.toLowerCase() as `0x${string}`,
    };
  });
}

/**
 * Pre-flight validation for Freelancer Accept action.
 * Verifies caller role, status, expiry, canonical contracts, milestones hash, and client signature.
 */
export async function validateAcceptPreflight(
  proposal: SerializedDealProposal,
  connectedWallet: string,
  blockTimestamp?: bigint
): Promise<{ ok: true; proposalStruct: DealProposalV2; milestoneInits: StandardV2MilestoneInit[] } | { ok: false; error: string }> {
  const normConnected = normalizeWallet(connectedWallet);
  const normFreelancer = normalizeWallet(proposal.freelancerWallet);
  if (normConnected !== normFreelancer) {
    return { ok: false, error: 'Only the designated freelancer can accept this proposal' };
  }

  if (proposal.cachedStatus !== 'PENDING') {
    return { ok: false, error: `Proposal is not pending (current status: ${proposal.cachedStatus})` };
  }

  const nowSec = blockTimestamp !== undefined ? blockTimestamp : BigInt(Math.floor(Date.now() / 1000));
  const expirySec = BigInt(proposal.expiry);
  if (nowSec > expirySec) {
    return { ok: false, error: 'Proposal has expired' };
  }

  // Canonical V2 config invariant check
  if (normalizeWallet(proposal.canonicalUsdc) !== normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc)) {
    return { ok: false, error: 'Proposal canonical USDC does not match standard configuration' };
  }
  if (normalizeWallet(proposal.dealImplementation) !== normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.dealImplementation)) {
    return { ok: false, error: 'Proposal deal implementation does not match standard configuration' };
  }
  if (normalizeWallet(proposal.primaryResolver) !== normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.primaryResolver)) {
    return { ok: false, error: 'Proposal primary resolver does not match standard configuration' };
  }
  if (normalizeWallet(proposal.emergencyResolver) !== normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver)) {
    return { ok: false, error: 'Proposal emergency resolver does not match standard configuration' };
  }

  // Standard protection settings
  if (proposal.isProtected || normalizeWallet(proposal.protectionModule) !== normalizeWallet(ZERO_ADDRESS) || proposal.policyId !== ZERO_BYTES32) {
    return { ok: false, error: 'Standard V2 proposals must not have protection module or policyId set' };
  }

  let proposalStruct: DealProposalV2;
  let milestoneInits: StandardV2MilestoneInit[];
  try {
    proposalStruct = buildProposalStructFromSerialized(proposal);
    milestoneInits = buildMilestoneInitsFromSerialized(proposal.milestones);
  } catch (err: any) {
    return { ok: false, error: `Failed to reconstruct proposal parameters: ${err?.message || 'unknown'}` };
  }

  // Verify milestonesHash recomputes correctly
  const computedMilestonesHash = hashStandardV2Milestones(milestoneInits);
  if (computedMilestonesHash.toLowerCase() !== proposal.milestonesHash.toLowerCase()) {
    return { ok: false, error: 'Computed milestonesHash does not match stored proposal' };
  }

  // Verify proposalId recomputes correctly
  const computedProposalId = hashDealProposalV2(proposalStruct);
  if (computedProposalId.toLowerCase() !== proposal.proposalId.toLowerCase()) {
    return { ok: false, error: 'Computed proposalId does not match stored proposal' };
  }

  // Verify client signature
  const isSigValid = await verifyDealProposalSignature(
    proposalStruct,
    proposal.clientSignature as `0x${string}`
  );
  if (!isSigValid) {
    return { ok: false, error: 'Invalid client signature on proposal struct' };
  }

  return { ok: true, proposalStruct, milestoneInits };
}

/**
 * Pre-flight validation for Freelancer Decline action.
 */
export async function validateDeclinePreflight(
  proposal: SerializedDealProposal,
  connectedWallet: string,
  blockTimestamp?: bigint
): Promise<{ ok: true; proposalStruct: DealProposalV2 } | { ok: false; error: string }> {
  const normConnected = normalizeWallet(connectedWallet);
  const normFreelancer = normalizeWallet(proposal.freelancerWallet);
  if (normConnected !== normFreelancer) {
    return { ok: false, error: 'Only the designated freelancer can decline this proposal' };
  }

  if (proposal.cachedStatus !== 'PENDING') {
    return { ok: false, error: `Proposal is not pending (current status: ${proposal.cachedStatus})` };
  }

  const nowSec = blockTimestamp !== undefined ? blockTimestamp : BigInt(Math.floor(Date.now() / 1000));
  const expirySec = BigInt(proposal.expiry);
  if (nowSec > expirySec) {
    return { ok: false, error: 'Proposal has expired' };
  }

  let proposalStruct: DealProposalV2;
  try {
    proposalStruct = buildProposalStructFromSerialized(proposal);
  } catch (err: any) {
    return { ok: false, error: `Failed to reconstruct proposal parameters: ${err?.message || 'unknown'}` };
  }

  const isSigValid = await verifyDealProposalSignature(
    proposalStruct,
    proposal.clientSignature as `0x${string}`
  );
  if (!isSigValid) {
    return { ok: false, error: 'Invalid client signature on proposal struct' };
  }

  return { ok: true, proposalStruct };
}

/**
 * Pre-flight validation for Client Cancel action.
 */
export function validateCancelPreflight(
  proposal: SerializedDealProposal,
  connectedWallet: string
): { ok: true; proposalStruct: DealProposalV2 } | { ok: false; error: string } {
  const normConnected = normalizeWallet(connectedWallet);
  const normClient = normalizeWallet(proposal.clientWallet);
  if (normConnected !== normClient) {
    return { ok: false, error: 'Only the proposal client can cancel this proposal' };
  }

  if (proposal.cachedStatus !== 'PENDING') {
    return { ok: false, error: `Proposal is not pending (current status: ${proposal.cachedStatus})` };
  }

  let proposalStruct: DealProposalV2;
  try {
    proposalStruct = buildProposalStructFromSerialized(proposal);
  } catch (err: any) {
    return { ok: false, error: `Failed to reconstruct proposal parameters: ${err?.message || 'unknown'}` };
  }

  return { ok: true, proposalStruct };
}

/**
 * Returns exact arguments for SynqFactoryV2.acceptDealProposal:
 * [DealProposal calldata proposal, MilestoneInit[] calldata milestoneInits, bytes calldata clientSignature]
 */
export function getAcceptContractArgs(
  proposal: SerializedDealProposal
): [DealProposalV2, StandardV2MilestoneInit[], `0x${string}`] {
  const proposalStruct = buildProposalStructFromSerialized(proposal);
  const milestoneInits = buildMilestoneInitsFromSerialized(proposal.milestones);
  return [proposalStruct, milestoneInits, proposal.clientSignature as `0x${string}`];
}

/**
 * Returns exact arguments for SynqFactoryV2.declineDealProposal:
 * [DealProposal calldata proposal, bytes calldata clientSignature]
 */
export function getDeclineContractArgs(
  proposal: SerializedDealProposal
): [DealProposalV2, `0x${string}`] {
  const proposalStruct = buildProposalStructFromSerialized(proposal);
  return [proposalStruct, proposal.clientSignature as `0x${string}`];
}

/**
 * Returns exact arguments for SynqFactoryV2.cancelDealProposal:
 * [DealProposal calldata proposal]
 */
export function getCancelContractArgs(
  proposal: SerializedDealProposal
): [DealProposalV2] {
  const proposalStruct = buildProposalStructFromSerialized(proposal);
  return [proposalStruct];
}

/**
 * On-chain ProposalStatus enum matching Solidity contracts/v1/ISynqFactoryV2.sol:
 * enum ProposalStatus { Pending, Accepted, Declined, Cancelled, Expired }
 */
export enum OnChainProposalStatus {
  Pending = 0,
  Accepted = 1,
  Declined = 2,
  Cancelled = 3,
  Expired = 4,
}

export const ON_CHAIN_PROPOSAL_STATUS_LABELS: Record<OnChainProposalStatus, string> = {
  [OnChainProposalStatus.Pending]: 'Pending',
  [OnChainProposalStatus.Accepted]: 'Accepted',
  [OnChainProposalStatus.Declined]: 'Declined',
  [OnChainProposalStatus.Cancelled]: 'Cancelled',
  [OnChainProposalStatus.Expired]: 'Expired',
};

export interface IProposalReadClient {
  readContract(args: {
    address: `0x${string}`;
    abi: any;
    functionName: string;
    args: readonly any[];
  }): Promise<any>;
}

export interface ChainProposalStatusResult {
  ok: boolean;
  status: OnChainProposalStatus;
  statusLabel: string;
  error?: string;
}

/**
 * Performs a fresh, chain-authoritative status read against canonical SynqFactoryV2.
 * Calls getProposalStatusById(proposalId, client, nonce, expiry), which inherently evaluates:
 * - whether proposalStatus[proposalId] != Pending (Accepted, Declined, Cancelled)
 * - whether usedClientNonces[client][nonce] == true (Cancelled via nonce cancellation)
 * - whether block.timestamp > expiry (Expired)
 * Returns ok: true ONLY if the status is exactly Pending (0).
 */
export async function verifyProposalPendingOnChain(
  proposal: {
    proposalId?: string;
    clientWallet?: string;
    client?: string;
    proposalNonce: string | bigint | number;
    expiry: string | bigint | number;
  },
  readClient?: IProposalReadClient,
  proposalIdOverride?: string
): Promise<ChainProposalStatusResult> {
  const client = readClient || sepoliaPublicClient;

  try {
    const rawProposalId = (proposal.proposalId || proposalIdOverride || '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(rawProposalId)) {
      return {
        ok: false,
        status: -1 as any,
        statusLabel: 'Unknown',
        error: 'Invalid proposalId format for on-chain status verification',
      };
    }

    const rawClient = proposal.clientWallet || proposal.client;
    if (!rawClient || !isAddress(rawClient)) {
      return {
        ok: false,
        status: -1 as any,
        statusLabel: 'Unknown',
        error: 'Invalid client address for on-chain status verification',
      };
    }

    const rawStatus = await client.readContract({
      address: SYNQ_V2_SEPOLIA_CONFIG.factory,
      abi: synqFactoryV2ABI,
      functionName: 'getProposalStatusById',
      args: [
        rawProposalId.toLowerCase() as `0x${string}`,
        getAddress(rawClient),
        BigInt(proposal.proposalNonce),
        BigInt(proposal.expiry),
      ],
    });

    const statusCode = Number(rawStatus) as OnChainProposalStatus;
    const statusLabel = ON_CHAIN_PROPOSAL_STATUS_LABELS[statusCode] || 'Unknown';

    if (statusCode === OnChainProposalStatus.Pending) {
      return {
        ok: true,
        status: OnChainProposalStatus.Pending,
        statusLabel: 'Pending',
      };
    }

    return {
      ok: false,
      status: statusCode,
      statusLabel,
      error: `Proposal is no longer actionable on-chain (Factory status: ${statusLabel})`,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: -1 as any,
      statusLabel: 'Unknown',
      error: `Unable to verify latest proposal status on Sepolia: ${err?.message || 'network error'}. Please try again.`,
    };
  }
}

/**
 * Queries the next available, unused proposal nonce for a client.
 * Calls /api/deals/proposals?client=${clientAddress} and preflights against Factory V2 if publicClient provided.
 */
export async function fetchNextClientProposalNonce(
  clientAddress: string,
  publicClient?: IProposalReadClient
): Promise<bigint> {
  const normClient = normalizeWallet(clientAddress);
  if (!isAddress(normClient)) {
    throw new Error('Valid client address required');
  }

  // 1. Fetch from server API
  const res = await fetch(`/api/deals/proposals?client=${normClient}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to fetch proposal nonce');
  }
  const data = await res.json();
  let nonce = BigInt(data.nextNonce || '0');

  // 2. Preflight against Factory V2 on chain if client provided
  if (publicClient) {
    let attempts = 0;
    while (attempts < 50) {
      const isUsed = await publicClient.readContract({
        address: SYNQ_V2_SEPOLIA_CONFIG.factory,
        abi: synqFactoryV2ABI,
        functionName: 'isProposalNonceUsed',
        args: [getAddress(normClient), nonce],
      });
      if (!isUsed) {
        break;
      }
      nonce += 1n;
      attempts++;
    }
  }

  return nonce;
}

