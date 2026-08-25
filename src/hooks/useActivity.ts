'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseAbiItem } from 'viem';
import { useAccount, useChainId } from 'wagmi';
import { getFactoryAddress } from '@/hooks/useFactoryContract';
import { getProtectionAddress } from '@/hooks/useProtectionContract';
import { getPublicClient } from '@/lib/chain';

export interface ActivityItem {
  id: string;
  type: string;
  title: string;
  description: string;
  timestamp: string;
  dealId?: string;
  amount?: number;
  txHash?: string;
}

const dealCreatedEvent = parseAbiItem('event DealCreated(address indexed dealAddress, address indexed buyer, address indexed seller, uint256 value, uint256 dealId)');
const dealEvents = [
  parseAbiItem('event MilestoneApproved(uint256 milestoneId, uint256 amount, uint256 timestamp)'),
  parseAbiItem('event PaymentReleased(uint256 milestoneId, uint256 amount, address to)'),
  parseAbiItem('event DealCompleted(uint256 timestamp)'),
  parseAbiItem('event DealCancelled(uint256 timestamp)'),
  parseAbiItem('event DisputeOpened(address openedBy, string reason)'),
  parseAbiItem('event DisputeResolved(string resolution)'),
];
const coverageEvent = parseAbiItem('event CoverageCreated(address indexed deal, address indexed buyer, uint256 amount, uint256 premium)');

const MAX_HISTORY_BLOCKS = 1000000n;

function fmtDate(ts: number) {
  return new Date(ts * 1000).toISOString();
}

function fmtAmount(value?: bigint) {
  if (!value) return undefined;
  return Number(value) / 1e18;
}

export function useActivity(limit = 30) {
  const { address } = useAccount();
  const chainId = useChainId();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);

  const client = useMemo(() => getPublicClient(chainId), [chainId]);

  const refetch = useCallback(async () => {
    if (!address || !client) {
      setItems([]);
      setLoading(false);
      return;
    }
    const c = client;
    setLoading(true);
    try {
      const blockTimes = new Map<bigint, number>();
      async function getTs(blockNumber: bigint) {
        if (!blockTimes.has(blockNumber)) {
          const block = await c.getBlock({ blockNumber });
          blockTimes.set(blockNumber, Number(block.timestamp));
        }
        return blockTimes.get(blockNumber)!;
      }

      const latest = await c.getBlockNumber();
      const fromBlock = latest > MAX_HISTORY_BLOCKS ? latest - MAX_HISTORY_BLOCKS : 0n;
      const factory = getFactoryAddress(chainId);
      const out: ActivityItem[] = [];
      const dealIds = new Set<string>();

      if (factory) {
        const [asBuyer, asSeller] = await Promise.all([
          client.getLogs({ address: factory, event: dealCreatedEvent, args: { buyer: address }, fromBlock, toBlock: 'latest' }),
          client.getLogs({ address: factory, event: dealCreatedEvent, args: { seller: address }, fromBlock, toBlock: 'latest' }),
        ]);
        const seen = new Set<string>();
        for (const log of [...asBuyer, ...asSeller]) {
          const key = log.transactionHash;
          if (seen.has(key)) continue;
          seen.add(key);
          const ts = await getTs(log.blockNumber);
          out.push({
            id: key,
            type: 'deal_created',
            title: 'Deal Created',
            description: `New deal worth ${fmtAmount(log.args.value)?.toFixed(4) ?? '?'} ETH`,
            timestamp: fmtDate(ts),
            dealId: log.args.dealAddress,
            amount: fmtAmount(log.args.value),
            txHash: log.transactionHash,
          });
          if (log.args.dealAddress) dealIds.add(log.args.dealAddress);
        }
      }

      const dealLogs = await Promise.all(
        [...dealIds].map((dealAddress) =>
          client.getLogs({ address: dealAddress as `0x${string}`, events: dealEvents, fromBlock, toBlock: 'latest' }).catch(() => [] as any[]),
        ),
      );
      for (const logs of dealLogs) {
        for (const log of logs) {
          const ts = await getTs(log.blockNumber);
          const name = log.eventName;
          if (name === 'MilestoneApproved') {
            out.push({
              id: log.transactionHash + log.logIndex,
              type: 'milestone_completed',
              title: 'Milestone Approved',
              description: `Milestone #${log.args.milestoneId} approved and released`,
              timestamp: fmtDate(ts),
              dealId: log.address,
              amount: fmtAmount(log.args.amount),
              txHash: log.transactionHash,
            });
          } else if (name === 'PaymentReleased') {
            out.push({
              id: log.transactionHash + log.logIndex,
              type: 'payment_released',
              title: 'Payment Released',
              description: `${fmtAmount(log.args.amount)?.toFixed(4) ?? '?'} ETH released from escrow`,
              timestamp: fmtDate(ts),
              dealId: log.address,
              amount: fmtAmount(log.args.amount),
              txHash: log.transactionHash,
            });
          } else if (name === 'DealCompleted') {
            out.push({ id: log.transactionHash + log.logIndex, type: 'deal_completed', title: 'Deal Completed', description: 'Deal finished successfully', timestamp: fmtDate(ts), dealId: log.address, txHash: log.transactionHash });
          } else if (name === 'DealCancelled') {
            out.push({ id: log.transactionHash + log.logIndex, type: 'deal_cancelled', title: 'Deal Cancelled', description: 'Deal was cancelled', timestamp: fmtDate(ts), dealId: log.address, txHash: log.transactionHash });
          } else if (name === 'DisputeOpened') {
            out.push({ id: log.transactionHash + log.logIndex, type: 'dispute_opened', title: 'Dispute Opened', description: `Dispute opened by ${log.args.openedBy}`, timestamp: fmtDate(ts), dealId: log.address, txHash: log.transactionHash });
          } else if (name === 'DisputeResolved') {
            out.push({ id: log.transactionHash + log.logIndex, type: 'dispute_resolved', title: 'Dispute Resolved', description: String(log.args.resolution || 'Resolved'), timestamp: fmtDate(ts), dealId: log.address, txHash: log.transactionHash });
          }
        }
      }

      const protectionAddress = getProtectionAddress(chainId);
      if (protectionAddress) {
        try {
          const logs = await client.getLogs({ address: protectionAddress, event: coverageEvent, args: { buyer: address }, fromBlock, toBlock: 'latest' });
          for (const log of logs) {
            const ts = await getTs(log.blockNumber);
            out.push({
              id: log.transactionHash + log.logIndex,
              type: 'protection_activated',
              title: 'Protection Activated',
              description: `Coverage of ${fmtAmount(log.args.amount)?.toFixed(4) ?? '?'} ETH activated`,
              timestamp: fmtDate(ts),
              dealId: log.args.deal,
              amount: fmtAmount(log.args.amount),
              txHash: log.transactionHash,
            });
          }
        } catch { /* no coverage events yet */ }
      }

      out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
      setItems(out.slice(0, limit));
    } catch (e) {
      console.error('Activity fetch failed:', e);
      setItems([]);
    }
    setLoading(false);
  }, [address, chainId, client, limit]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { items, loading, refetch };
}
