'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAccount, useSignTypedData, useWriteContract } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { shortenAddress } from '@/lib/utils';
import { parseUsdcAmount, formatUsdcAmount } from '@/lib/deals/v2';
import { synqResolutionCommitteeABI } from '@/lib/contracts/abis';
import { sepoliaPublicClient } from '@/lib/chain';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
import type { CommitteeQueueItem } from '@/lib/deals/v2-committee-signer';
import type { CanonicalResolutionReportV1 } from '@/lib/deals/v2-resolution-report';
import {
  Scale,
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  Send,
  ArrowLeft,
  Check,
  RotateCcw,
} from 'lucide-react';

interface CommitteeResolutionWorkspaceProps {
  item: CommitteeQueueItem;
  onBack: () => void;
  onSettled: () => void;
}

export function CommitteeResolutionWorkspace({
  item,
  onBack,
  onSettled,
}: CommitteeResolutionWorkspaceProps) {
  const { address } = useAccount();
  const { ensureSepolia } = useSepoliaNetwork();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();
  const { getToken } = useAuthSession();

  const isFinal = item.phase === 'FINAL_RESOLUTION';
  const milestoneAmountBigInt = useMemo(() => BigInt(item.milestoneAmount), [item.milestoneAmount]);

  // Stage Report State
  const [freelancerAmountInput, setFreelancerAmountInput] = useState<string>('');
  const [clientAmountInput, setClientAmountInput] = useState<string>('');
  const [summaryInput, setSummaryInput] = useState<string>('');
  const [findingsInput, setFindingsInput] = useState<string>('');
  const [justificationInput, setJustificationInput] = useState<string>('');

  const [stagedReport, setStagedReport] = useState<CanonicalResolutionReportV1 | null>(null);
  const [stagedReportId, setStagedReportId] = useState<string | null>(null);
  const [stagingInProgress, setStagingInProgress] = useState<boolean>(false);
  const [stageError, setStageError] = useState<string | null>(null);

  // Authorization State
  const [currentAuth, setCurrentAuth] = useState<any | null>(null);
  const [creatingAuth, setCreatingAuth] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Signing State
  const [signingInProgress, setSigningInProgress] = useState<boolean>(false);
  const [signError, setSignError] = useState<string | null>(null);

  // Submission State
  const [preparingExecution, setPreparingExecution] = useState<boolean>(false);
  const [submittingInProgress, setSubmittingInProgress] = useState<boolean>(false);
  const [reconcilingInProgress, setReconcilingInProgress] = useState<boolean>(false);
  const [executionTxHash, setExecutionTxHash] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [reconciliationFailed, setReconciliationFailed] = useState<boolean>(false);

  // 1. Fetch Existing Staged Report and Auths on load
  const loadExistingState = useCallback(async () => {
    try {
      const token = await getToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

      // Load report
      const repRes = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/resolution-reports?phase=${item.phase}`,
        { headers }
      );
      if (repRes.ok) {
        const repData = await repRes.json();
        if (repData.record?.report) {
          setStagedReport(repData.record.report);
          setStagedReportId(repData.record.row?.id || null);
          setFreelancerAmountInput(formatUsdcAmount(repData.record.report.freelancerAmount));
          setClientAmountInput(formatUsdcAmount(repData.record.report.clientAmount));
          setSummaryInput(repData.record.report.summary);
          setFindingsInput(repData.record.report.findings);
          setJustificationInput(repData.record.report.justification);
        }
      }

      // Load authorisations
      const authRes = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/authorizations`,
        { headers }
      );
      if (authRes.ok) {
        const authData = await authRes.json();
        const activeAuth = (authData.authorizations || []).find(
          (a: any) =>
            a.authorization?.phase === item.phase &&
            (a.authorization?.status === 'collecting' ||
              a.authorization?.status === 'threshold_ready')
        );
        if (activeAuth) {
          setCurrentAuth(activeAuth);
        }
      }
    } catch (err) {
      console.warn('[CommitteeResolutionWorkspace] Failed to load initial state:', err);
    }
  }, [item.dealAddress, item.milestoneId, item.phase, getToken]);

  useEffect(() => {
    loadExistingState();
  }, [loadExistingState]);

  // Handle Exact Split Input Sync
  const handleFreelancerAmountChange = (val: string) => {
    setFreelancerAmountInput(val);
    setStageError(null);
    try {
      if (!val.trim()) {
        setClientAmountInput('');
        return;
      }
      const parsedFreelancer = parseUsdcAmount(val);
      if (parsedFreelancer > milestoneAmountBigInt) {
        setStageError('Freelancer amount cannot exceed total milestone amount');
        setClientAmountInput('');
        return;
      }
      const remainingClient = milestoneAmountBigInt - parsedFreelancer;
      setClientAmountInput(formatUsdcAmount(remainingClient));
    } catch {
      setClientAmountInput('');
    }
  };

  const handleClientAmountChange = (val: string) => {
    setClientAmountInput(val);
    setStageError(null);
    try {
      if (!val.trim()) {
        setFreelancerAmountInput('');
        return;
      }
      const parsedClient = parseUsdcAmount(val);
      if (parsedClient > milestoneAmountBigInt) {
        setStageError('Client amount cannot exceed total milestone amount');
        setFreelancerAmountInput('');
        return;
      }
      const remainingFreelancer = milestoneAmountBigInt - parsedClient;
      setFreelancerAmountInput(formatUsdcAmount(remainingFreelancer));
    } catch {
      setFreelancerAmountInput('');
    }
  };

  // 2. Stage Report Action
  const handleStageReport = async () => {
    try {
      setStagingInProgress(true);
      setStageError(null);

      const fAmountBn = parseUsdcAmount(freelancerAmountInput);
      const cAmountBn = parseUsdcAmount(clientAmountInput);

      if (fAmountBn + cAmountBn !== milestoneAmountBigInt) {
        throw new Error('Split sum does not exactly equal total milestone amount');
      }

      const token = await getToken();
      const res = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/resolution-reports`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            phase: item.phase,
            freelancerAmount: fAmountBn.toString(),
            clientAmount: cAmountBn.toString(),
            summary: summaryInput,
            findings: findingsInput,
            justification: justificationInput,
          }),
        }
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Staging failed with HTTP ${res.status}`);
      }

      const data = await res.json();
      setStagedReport(data.report);
      setStagedReportId(data.reportId);
    } catch (err: any) {
      setStageError(err?.message || 'Failed to stage resolution report');
    } finally {
      setStagingInProgress(false);
    }
  };

  // 3. Create Authorization Action
  const handleCreateAuthorization = async () => {
    if (!stagedReportId) return;
    try {
      setCreatingAuth(true);
      setAuthError(null);

      const token = await getToken();
      const res = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/authorizations`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            reportId: stagedReportId,
          }),
        }
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Authorization creation failed with HTTP ${res.status}`);
      }

      const data = await res.json();
      setCurrentAuth({
        authorization: data.authorization,
        typedData: data.typedData,
        signatures: [],
        signers: [],
        thresholdReady: false,
      });
    } catch (err: any) {
      setAuthError(err?.message || 'Failed to generate authorization');
    } finally {
      setCreatingAuth(false);
    }
  };

  // 4. Sign Authorization Action
  const handleSignAuthorization = async () => {
    if (!currentAuth?.authorization?.id) return;
    try {
      setSigningInProgress(true);
      setSignError(null);

      await ensureSepolia();

      const typedData = currentAuth.typedData;
      if (!typedData) {
        throw new Error('EIP-712 typed data not available on authorization');
      }

      const signature = await signTypedDataAsync({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });

      const token = await getToken();
      const res = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/authorizations/${currentAuth.authorization.id}/signatures`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ signature }),
        }
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Signature submission failed with HTTP ${res.status}`);
      }

      await loadExistingState();
    } catch (err: any) {
      setSignError(err?.message || 'Failed to submit committee signature');
    } finally {
      setSigningInProgress(false);
    }
  };

  // 5. Submit On-Chain Execution
  const handleSubmitExecution = async () => {
    if (!currentAuth?.authorization?.id) return;
    try {
      setSubmittingInProgress(true);
      setSubmitError(null);
      setReconciliationFailed(false);

      await ensureSepolia();

      // Step 1: Prepare transaction from verified bundle
      const token = await getToken();
      const prepRes = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/authorizations/${currentAuth.authorization.id}/prepare`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );

      if (!prepRes.ok) {
        const errData = await prepRes.json().catch(() => ({}));
        throw new Error(errData.error || `Execution preparation failed with HTTP ${prepRes.status}`);
      }

      const prepData = await prepRes.json();
      const txReq = prepData.transactionRequest;

      // Step 2: Prompt wallet transaction
      const txHash = await writeContractAsync({
        address: txReq.address as `0x${string}`,
        abi: synqResolutionCommitteeABI,
        functionName: txReq.functionName as any,
        args: txReq.args,
      });

      setExecutionTxHash(txHash);

      // Step 3: Wait for receipt
      await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      // Step 4: Server Reconcile
      await triggerReconcile(txHash);
    } catch (err: any) {
      setSubmitError(err?.message || 'Failed to submit resolution on-chain');
    } finally {
      setSubmittingInProgress(false);
    }
  };

  // Reconcile Helper with Retry Support
  const triggerReconcile = async (txHash?: string) => {
    if (!currentAuth?.authorization?.id) return;
    try {
      setReconcilingInProgress(true);
      const token = await getToken();
      const res = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/authorizations/${currentAuth.authorization.id}/reconcile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ txHash: txHash || executionTxHash }),
        }
      );

      if (!res.ok) {
        setReconciliationFailed(true);
      } else {
        onSettled();
      }
    } catch (err) {
      setReconciliationFailed(true);
    } finally {
      setReconcilingInProgress(false);
    }
  };

  const signatureCount = currentAuth?.signers?.length || 0;
  const isThresholdReady = currentAuth?.authorization?.status === 'threshold_ready' || signatureCount >= 2;
  const hasUserSigned = useMemo(() => {
    if (!address || !currentAuth?.signers) return false;
    return currentAuth.signers.some((s: string) => s.toLowerCase() === address.toLowerCase());
  }, [address, currentAuth?.signers]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={onBack}
          className="h-8 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-900 flex items-center gap-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Queue
        </Button>
        <Badge
          variant="outline"
          className={
            isFinal
              ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
          }
        >
          {isFinal ? 'FINAL RESOLUTION WORKSPACE' : 'INITIAL RESOLUTION WORKSPACE'}
        </Badge>
      </div>

      {/* Snapshot Context Card */}
      <Card className="border-zinc-800 bg-zinc-950/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
            <Scale className="h-4 w-4 text-zinc-400" /> Milestone Case Context
          </CardTitle>
          <CardDescription className="text-xs text-zinc-400">
            Escrow amount: {formatUsdcAmount(item.milestoneAmount)} USDC • Deal {shortenAddress(item.dealAddress)} • Milestone #{item.milestoneId + 1}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono">
            <div className="rounded bg-zinc-900/60 p-2">
              <div className="text-[10px] text-zinc-500 uppercase font-sans">Client</div>
              <div className="text-zinc-200">{shortenAddress(item.client)}</div>
            </div>
            <div className="rounded bg-zinc-900/60 p-2">
              <div className="text-[10px] text-zinc-500 uppercase font-sans">Freelancer</div>
              <div className="text-zinc-200">{shortenAddress(item.freelancer)}</div>
            </div>
            <div className="rounded bg-zinc-900/60 p-2">
              <div className="text-[10px] text-zinc-500 uppercase font-sans">Spec Hash</div>
              <div className="text-zinc-200">{item.specHash.slice(0, 10)}…</div>
            </div>
            <div className="rounded bg-zinc-900/60 p-2">
              <div className="text-[10px] text-zinc-500 uppercase font-sans">Evidence Hash</div>
              <div className="text-zinc-200">{item.evidenceRootHash.slice(0, 10)}…</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* STEP 1: Stage Canonical Report */}
      <Card className="border-zinc-800 bg-zinc-950/60 space-y-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
            <FileText className="h-4 w-4 text-zinc-400" /> 1. Author Resolution Report & Split
          </CardTitle>
          <CardDescription className="text-xs text-zinc-400">
            Determine the exact escrow split and state findings. Sum must equal exactly {formatUsdcAmount(item.milestoneAmount)} USDC.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[11px] text-zinc-400">Freelancer Amount (USDC)</label>
              <Input
                type="text"
                placeholder="0.00"
                value={freelancerAmountInput}
                onChange={(e) => handleFreelancerAmountChange(e.target.value)}
                disabled={Boolean(currentAuth)}
                className="h-8 text-xs bg-zinc-900 border-zinc-700 text-white"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-zinc-400">Client Refund Amount (USDC)</label>
              <Input
                type="text"
                placeholder="0.00"
                value={clientAmountInput}
                onChange={(e) => handleClientAmountChange(e.target.value)}
                disabled={Boolean(currentAuth)}
                className="h-8 text-xs bg-zinc-900 border-zinc-700 text-white"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-zinc-400">Executive Summary</label>
            <Input
              type="text"
              placeholder="High-level summary of determination…"
              value={summaryInput}
              onChange={(e) => setSummaryInput(e.target.value)}
              disabled={Boolean(currentAuth)}
              className="h-8 text-xs bg-zinc-900 border-zinc-700 text-white"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-zinc-400">Detailed Findings</label>
            <textarea
              placeholder="Evaluation of evidence, milestones deliverables, and dispute claims…"
              value={findingsInput}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFindingsInput(e.target.value)}
              disabled={Boolean(currentAuth)}
              rows={3}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2.5 text-xs text-white focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-zinc-400">Legal & Equitable Justification</label>
            <textarea
              placeholder="Justification for split decision and contract adherence…"
              value={justificationInput}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setJustificationInput(e.target.value)}
              disabled={Boolean(currentAuth)}
              rows={3}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2.5 text-xs text-white focus:outline-none"
            />
          </div>

          {stageError && (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2 text-xs text-red-300 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
              <span>{stageError}</span>
            </div>
          )}

          {!currentAuth && (
            <div className="flex justify-end pt-2">
              <Button
                size="sm"
                onClick={handleStageReport}
                disabled={stagingInProgress || !freelancerAmountInput || !clientAmountInput}
                className="h-8 text-xs bg-zinc-100 hover:bg-white text-zinc-950 font-medium"
              >
                {stagingInProgress ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Staging Report…
                  </>
                ) : stagedReport ? (
                  'Update Staged Report'
                ) : (
                  'Stage Resolution Report'
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* STEP 2: Generate Authorization & Signatures */}
      {stagedReport && (
        <Card className="border-zinc-800 bg-zinc-950/60 space-y-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
              <Scale className="h-4 w-4 text-zinc-400" /> 2. Committee Multi-Sig Authorization (2 of 3)
            </CardTitle>
            <CardDescription className="text-xs text-zinc-400">
              Collect 2 distinct committee member signatures over the exact hash-bound resolution payload.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!currentAuth ? (
              <div className="space-y-3">
                <p className="text-xs text-zinc-400">
                  Report staged with cryptographic hash. Generate the formal EIP-712 authorization to begin signature collection.
                </p>
                {authError && (
                  <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2 text-xs text-red-300 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                    <span>{authError}</span>
                  </div>
                )}
                <Button
                  size="sm"
                  onClick={handleCreateAuthorization}
                  disabled={creatingAuth}
                  className="h-8 text-xs bg-zinc-800 hover:bg-zinc-700 text-white"
                >
                  {creatingAuth ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Generating…
                    </>
                  ) : (
                    'Generate Resolution Authorization'
                  )}
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                  <div className="space-y-0.5">
                    <div className="text-xs font-semibold text-white">Signatures Collected</div>
                    <div className="text-[11px] text-zinc-400">
                      {signatureCount} of 2 required signatures collected from active signers.
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      isThresholdReady
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                    }
                  >
                    {isThresholdReady ? '2 / 2 Ready' : `${signatureCount} / 2 Signed`}
                  </Badge>
                </div>

                {signError && (
                  <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2 text-xs text-red-300 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                    <span>{signError}</span>
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                  {!hasUserSigned && (
                    <Button
                      size="sm"
                      onClick={handleSignAuthorization}
                      disabled={signingInProgress}
                      className="h-8 text-xs bg-zinc-100 hover:bg-white text-zinc-950 font-medium"
                    >
                      {signingInProgress ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Signing Typed Data…
                        </>
                      ) : (
                        'Sign Resolution (Wallet)'
                      )}
                    </Button>
                  )}
                  {hasUserSigned && (
                    <div className="text-xs text-emerald-400 flex items-center gap-1.5">
                      <Check className="h-4 w-4" /> You have signed this resolution.
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* STEP 3: On-Chain Submission */}
      {isThresholdReady && (
        <Card className="border-emerald-500/30 bg-emerald-950/10 space-y-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" /> 3. Submit Resolution On-Chain
            </CardTitle>
            <CardDescription className="text-xs text-zinc-400">
              Threshold met. Active committee member submits gateway transaction to execute resolution.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-zinc-300">
              The gateway will forward execution to the Deal clone, disburse funds, and record the resolution justification hash on-chain.
            </p>

            {submitError && (
              <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2.5 text-xs text-red-300 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                <span>{submitError}</span>
              </div>
            )}

            {reconciliationFailed && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-2.5 text-xs text-amber-300 space-y-2">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4 text-amber-400" /> Transaction confirmed on-chain.
                </div>
                <p className="text-[11px] text-zinc-300">
                  Synq could not finish local reconciliation yet. Click below to retry reconciliation safely using the existing transaction.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => triggerReconcile()}
                  disabled={reconcilingInProgress}
                  className="h-7 text-xs border-amber-600/50 text-amber-200 hover:bg-amber-950"
                >
                  {reconcilingInProgress ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RotateCcw className="mr-1 h-3 w-3" />}
                  Retry Reconciliation
                </Button>
              </div>
            )}

            {!reconciliationFailed && (
              <Button
                size="sm"
                onClick={handleSubmitExecution}
                disabled={submittingInProgress}
                className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
              >
                {submittingInProgress ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Submitting to Blockchain…
                  </>
                ) : isFinal ? (
                  'Submit Final Resolution'
                ) : (
                  'Submit Initial Resolution Proposal'
                )}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
