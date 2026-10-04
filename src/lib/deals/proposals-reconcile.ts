/**
 * Synq Standard V2 Proposal On-Chain Receipt Reconciliation Layer
 * Source of truth: contracts/v1/ISynqFactoryV2.sol & contracts/v1/SynqFactoryV2.sol
 */

import { getAddress, isAddress, parseEventLogs, type TransactionReceipt } from 'viem';
import { synqFactoryV2ABI } from '@/lib/contracts/abis';
import { SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import { ZERO_ADDRESS } from '@/lib/deals/v2';
import { sepoliaPublicClient } from '@/lib/chain';
import { normalizeWallet } from '@/lib/utils';
import {
  type SerializedDealProposal,
  type DealProposalRow,
  type IDealProposalRepository,
  defaultDealProposalRepository,
  ProposalAuthError,
  ProposalConflictError,
  ProposalValidationError,
  getDealProposalById,
  updateDealProposalStatus,
} from '@/lib/deals/proposals-db';

export interface VerifiedTerminalEvent {
  proposalId: `0x${string}`;
  status: 'ACCEPTED' | 'DECLINED' | 'CANCELLED';
  client: `0x${string}`;
  freelancer: `0x${string}`;
  nonce: bigint;
  dealAddress?: `0x${string}`;
  txHash: `0x${string}`;
  blockNumber?: bigint;
}

export interface IReceiptVerificationClient {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<TransactionReceipt>;
}

/**
 * Server-side cryptographic receipt verifier for Factory V2 terminal events.
 * Strictly verifies the on-chain receipt against Factory V2 event logs without trusting
 * any browser-supplied status or dealAddress.
 */
export async function verifyFactoryTerminalReceipt(
  txHash: string,
  proposal: {
    proposalId: string;
    clientWallet: string;
    freelancerWallet: string;
    proposalNonce: string;
  },
  client: IReceiptVerificationClient = sepoliaPublicClient
): Promise<VerifiedTerminalEvent> {
  const trimmedTxHash = txHash.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmedTxHash)) {
    throw new ProposalValidationError('Invalid transaction hash format');
  }
  const cleanTxHash = trimmedTxHash.toLowerCase() as `0x${string}`;

  let receipt: TransactionReceipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: cleanTxHash });
  } catch (err: any) {
    throw new ProposalValidationError(`Failed to retrieve transaction receipt: ${err?.message || 'unknown'}`);
  }

  if (!receipt) {
    throw new ProposalValidationError('Transaction receipt not found');
  }

  if (receipt.status !== 'success') {
    throw new ProposalValidationError('Transaction failed or reverted on-chain');
  }

  const factoryAddressNorm = normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.factory);

  // Parse Factory V2 event logs
  const parsedLogs = parseEventLogs({
    abi: synqFactoryV2ABI,
    logs: receipt.logs,
  });

  const targetProposalId = proposal.proposalId.toLowerCase();
  const targetClient = normalizeWallet(proposal.clientWallet);
  const targetFreelancer = normalizeWallet(proposal.freelancerWallet);
  const targetNonce = proposal.proposalNonce.toString();

  for (const log of (parsedLogs as any[])) {
    // Only accept events from the canonical Factory V2 contract
    if (normalizeWallet(log.address) !== factoryAddressNorm) {
      continue;
    }

    if (log.eventName === 'DealProposalAccepted') {
      const args = log.args as {
        proposalId: `0x${string}`;
        client: `0x${string}`;
        freelancer: `0x${string}`;
        dealAddress: `0x${string}`;
        nonce: bigint;
      };

      if (args.proposalId.toLowerCase() !== targetProposalId) {
        continue;
      }

      if (normalizeWallet(args.client) !== targetClient || normalizeWallet(args.freelancer) !== targetFreelancer) {
        throw new ProposalValidationError('Receipt event participant addresses do not match proposal');
      }

      if (args.nonce.toString() !== targetNonce) {
        throw new ProposalValidationError('Receipt event nonce does not match proposal');
      }

      const rawDealAddress = args.dealAddress;
      if (!isAddress(rawDealAddress) || normalizeWallet(rawDealAddress) === normalizeWallet(ZERO_ADDRESS)) {
        throw new ProposalValidationError('Invalid deal address emitted in DealProposalAccepted event');
      }

      return {
        proposalId: args.proposalId.toLowerCase() as `0x${string}`,
        status: 'ACCEPTED',
        client: args.client,
        freelancer: args.freelancer,
        nonce: args.nonce,
        dealAddress: getAddress(rawDealAddress),
        txHash: cleanTxHash,
        blockNumber: receipt.blockNumber,
      };
    }

    if (log.eventName === 'DealProposalDeclined') {
      const args = log.args as {
        proposalId: `0x${string}`;
        client: `0x${string}`;
        freelancer: `0x${string}`;
        nonce: bigint;
      };

      if (args.proposalId.toLowerCase() !== targetProposalId) {
        continue;
      }

      if (normalizeWallet(args.client) !== targetClient || normalizeWallet(args.freelancer) !== targetFreelancer) {
        throw new ProposalValidationError('Receipt event participant addresses do not match proposal');
      }

      if (args.nonce.toString() !== targetNonce) {
        throw new ProposalValidationError('Receipt event nonce does not match proposal');
      }

      return {
        proposalId: args.proposalId.toLowerCase() as `0x${string}`,
        status: 'DECLINED',
        client: args.client,
        freelancer: args.freelancer,
        nonce: args.nonce,
        txHash: cleanTxHash,
        blockNumber: receipt.blockNumber,
      };
    }

    if (log.eventName === 'DealProposalCancelled') {
      const args = log.args as {
        proposalId: `0x${string}`;
        client: `0x${string}`;
        freelancer: `0x${string}`;
        nonce: bigint;
      };

      if (args.proposalId.toLowerCase() !== targetProposalId) {
        continue;
      }

      if (normalizeWallet(args.client) !== targetClient || normalizeWallet(args.freelancer) !== targetFreelancer) {
        throw new ProposalValidationError('Receipt event participant addresses do not match proposal');
      }

      if (args.nonce.toString() !== targetNonce) {
        throw new ProposalValidationError('Receipt event nonce does not match proposal');
      }

      return {
        proposalId: args.proposalId.toLowerCase() as `0x${string}`,
        status: 'CANCELLED',
        client: args.client,
        freelancer: args.freelancer,
        nonce: args.nonce,
        txHash: cleanTxHash,
        blockNumber: receipt.blockNumber,
      };
    }
  }

  throw new ProposalValidationError('Receipt does not contain a verified Factory V2 terminal event for this proposal');
}

/**
 * Reconciles a proposal's lifecycle status using a verified on-chain Factory V2 receipt.
 * Ensures strict participant authorization, idempotency, and conflict rejection.
 */
export async function reconcileProposalWithReceipt(
  proposalId: string,
  txHash: string,
  callerWallet: string,
  options?: {
    client?: IReceiptVerificationClient;
    repo?: IDealProposalRepository;
  }
): Promise<{
  proposal: DealProposalRow;
  reconciled: boolean;
  alreadyReconciled: boolean;
  status: 'ACCEPTED' | 'DECLINED' | 'CANCELLED';
  dealAddress?: string;
}> {
  const cleanProposalId = proposalId.trim().toLowerCase();
  if (!/^0x[0-9a-fA-F]{64}$/.test(cleanProposalId)) {
    throw new ProposalValidationError('Invalid proposalId format');
  }

  const repo = options?.repo || defaultDealProposalRepository;
  const proposal = await repo.getById(cleanProposalId);
  if (!proposal) {
    throw new ProposalValidationError('Proposal not found');
  }

  // Authorization: caller must be client or freelancer
  const normCaller = normalizeWallet(callerWallet);
  const normClient = normalizeWallet(proposal.clientWallet);
  const normFreelancer = normalizeWallet(proposal.freelancerWallet);
  if (normCaller !== normClient && normCaller !== normFreelancer) {
    throw new ProposalAuthError('Only proposal participants (client or freelancer) may reconcile proposal status');
  }

  // Cryptographically verify receipt against Factory V2
  const verified = await verifyFactoryTerminalReceipt(
    txHash,
    proposal,
    options?.client
  );

  // Handle Idempotency & Terminal Conflicts
  if (proposal.cachedStatus === verified.status) {
    // If already accepted, verify that dealAddress matches
    if (verified.status === 'ACCEPTED' && proposal.dealAddress && verified.dealAddress) {
      if (normalizeWallet(proposal.dealAddress) !== normalizeWallet(verified.dealAddress)) {
        throw new ProposalConflictError('Conflicting deal address for already accepted proposal');
      }
    }
    return {
      proposal,
      reconciled: true,
      alreadyReconciled: true,
      status: verified.status,
      dealAddress: proposal.dealAddress || verified.dealAddress,
    };
  }

  // If already in a different terminal state, reject conflict
  if (proposal.cachedStatus !== 'PENDING') {
    throw new ProposalConflictError(
      `Conflicting terminal state: proposal is already ${proposal.cachedStatus} and cannot become ${verified.status}`
    );
  }

  // Update proposal status in repository
  const updated = await repo.updateStatus(cleanProposalId, verified.status, {
    dealAddress: verified.dealAddress,
    txHash: verified.txHash,
    terminalType: verified.status,
  });

  if (!updated) {
    throw new Error('Failed to update proposal lifecycle status');
  }

  return {
    proposal: updated,
    reconciled: true,
    alreadyReconciled: false,
    status: verified.status,
    dealAddress: updated.dealAddress || verified.dealAddress,
  };
}
