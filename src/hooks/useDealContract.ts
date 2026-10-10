'use client';

import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { nexotiqDealABI } from '@/lib/contracts/abis';
import { useEffect, useMemo } from 'react';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';

export function useDealContract(dealAddress: `0x${string}` | undefined) {
  const config = {
    address: dealAddress,
    abi: nexotiqDealABI,
    chainId: SEPOLIA_CHAIN_ID,
  } as const;

  const { data: buyer, refetch: refetchBuyer } = useReadContract({ ...config, functionName: 'buyer', query: { enabled: !!dealAddress } });
  const { data: seller, refetch: refetchSeller } = useReadContract({ ...config, functionName: 'seller', query: { enabled: !!dealAddress } });
  const { data: title, refetch: refetchTitle } = useReadContract({ ...config, functionName: 'title', query: { enabled: !!dealAddress } });
  const { data: description, refetch: refetchDescription } = useReadContract({ ...config, functionName: 'description', query: { enabled: !!dealAddress } });
  const { data: totalValue, refetch: refetchTotalValue } = useReadContract({ ...config, functionName: 'totalValue', query: { enabled: !!dealAddress } });
  const { data: deadline, refetch: refetchDeadline } = useReadContract({ ...config, functionName: 'deadline', query: { enabled: !!dealAddress } });
  const { data: status, refetch: refetchStatus } = useReadContract({ ...config, functionName: 'status', query: { enabled: !!dealAddress } });
  const { data: currentMilestone, refetch: refetchCurrentMilestone } = useReadContract({ ...config, functionName: 'currentMilestone', query: { enabled: !!dealAddress } });
  const { data: riskScore, refetch: refetchRiskScore } = useReadContract({ ...config, functionName: 'riskScore', query: { enabled: !!dealAddress } });
  const { data: protectionEnabled, refetch: refetchProtectionEnabled } = useReadContract({ ...config, functionName: 'protectionEnabled', query: { enabled: !!dealAddress } });
  const { data: escrowBalance, refetch: refetchEscrowBalance } = useReadContract({ ...config, functionName: 'escrowBalance', query: { enabled: !!dealAddress } });
  const { data: asset, refetch: refetchAsset } = useReadContract({ ...config, functionName: 'asset', query: { enabled: !!dealAddress } });
  const { data: milestones, refetch: refetchMilestones } = useReadContract({ ...config, functionName: 'getMilestones', query: { enabled: !!dealAddress } });
  const { data: dispute, refetch: refetchDispute } = useReadContract({ ...config, functionName: 'dispute', query: { enabled: !!dealAddress } });

  const { ensureSepolia, networkReady, isSwitching, error: networkError } = useSepoliaNetwork();
  const write = useWriteContract();
  const { data: txHash, writeContractAsync, isPending, error: writeError } = write;

  const txReceipt = useWaitForTransactionReceipt({ hash: txHash, chainId: SEPOLIA_CHAIN_ID });

  const refetchAll = useMemo(() => () => {
    refetchBuyer();
    refetchSeller();
    refetchTitle();
    refetchDescription();
    refetchTotalValue();
    refetchDeadline();
    refetchStatus();
    refetchCurrentMilestone();
    refetchRiskScore();
    refetchProtectionEnabled();
    refetchEscrowBalance();
    refetchAsset();
    refetchMilestones();
    refetchDispute();
  }, [
    refetchBuyer, refetchSeller, refetchTitle, refetchDescription, refetchTotalValue,
    refetchDeadline, refetchStatus, refetchCurrentMilestone, refetchRiskScore,
    refetchProtectionEnabled, refetchEscrowBalance, refetchAsset, refetchMilestones, refetchDispute,
  ]);

  useEffect(() => {
    if (txReceipt.isSuccess && txReceipt.data?.transactionHash) {
      refetchAll();
    }
  }, [txReceipt.isSuccess, txReceipt.data?.transactionHash, refetchAll]);

  async function safeWrite(params: Record<string, unknown>) {
    if (!dealAddress) return;
    try {
      await ensureSepolia();
      return await writeContractAsync({ ...params, address: dealAddress, abi: nexotiqDealABI } as any);
    } catch {
      return undefined;
    }
  }

  return {
    buyer, seller, title, description, totalValue, deadline,
    status, currentMilestone, riskScore, protectionEnabled,
    escrowBalance, asset, milestones, dispute,
    networkReady, isSwitching, error: networkError ?? writeError,
    isPending: isPending || txReceipt.isLoading || isSwitching, txReceipt, refetchAll,
    addMilestone: (t: string, d: string, a: bigint, dd: bigint) => safeWrite({ functionName: 'addMilestone', args: [t, d, a, dd] }),
    fundEscrow: (v: bigint) => safeWrite({ functionName: 'fundEscrow', value: v }),
    startMilestone: (id: bigint) => safeWrite({ functionName: 'startMilestone', args: [id] }),
    submitMilestone: (id: bigint, h: string) => safeWrite({ functionName: 'submitMilestone', args: [id, h] }),
    approveMilestone: (id: bigint) => safeWrite({ functionName: 'approveMilestone', args: [id] }),
    requestRevision: (id: bigint) => safeWrite({ functionName: 'requestRevision', args: [id] }),
    openDispute: (r: string) => safeWrite({ functionName: 'openDispute', args: [r] }),
    approveDisputeResolution: () => safeWrite({ functionName: 'approveDisputeResolution' }),
    executeDisputeResolution: (r: string) => safeWrite({ functionName: 'executeDisputeResolution', args: [r] }),
    cancelDeal: () => safeWrite({ functionName: 'cancelDeal' }),
    updateDisputeAI: (s: string, r: string) => safeWrite({ functionName: 'updateDisputeAI', args: [s, r] }),
  };
}
