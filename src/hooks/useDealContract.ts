'use client';

import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { nexotiqDealABI } from '@/lib/contracts/abis';
import { useEffect, useMemo } from 'react';

export function useDealContract(dealAddress: `0x${string}` | undefined) {
  const config = {
    address: dealAddress,
    abi: nexotiqDealABI,
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

  const write = useWriteContract();
  const { data: txHash, writeContract, isPending } = write;

  const txReceipt = useWaitForTransactionReceipt({ hash: txHash });

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

  function safeWrite(params: Record<string, unknown>) {
    if (!dealAddress) return;
    writeContract({ ...params, address: dealAddress, abi: nexotiqDealABI } as any);
  }

  return {
    buyer, seller, title, description, totalValue, deadline,
    status, currentMilestone, riskScore, protectionEnabled,
    escrowBalance, asset, milestones, dispute,
    writeContract, isPending: isPending || txReceipt.isLoading, txReceipt, refetchAll,
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
