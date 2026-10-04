'use client';

import { useState, useRef, useEffect, Suspense, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Sparkles,
  Loader2,
  MessageSquare,
  ChevronDown,
  ChevronUp,
  Search,
  X,
  Calendar,
  Clock,
  ShieldCheck,
  Plus,
  Trash2,
  FileSignature,
  Info,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Press_Start_2P } from 'next/font/google';
import { useAccount, useSignTypedData } from 'wagmi';
import { getAddress, isAddress } from 'viem';

import { shortenAddress, cn, normalizeWallet } from '@/lib/utils';
import {
  SYNQ_V2_SEPOLIA_CONFIG,
  SEPOLIA_CHAIN_ID,
} from '@/lib/contracts/addresses';
import {
  ZERO_ADDRESS,
  ZERO_BYTES32,
  MIN_REVIEW_WINDOW_SECONDS,
  MAX_REVIEW_WINDOW_SECONDS,
  getStandardV2Eip712Domain,
  DEAL_PROPOSAL_EIP712_TYPES,
  parseUsdcAmount,
  formatUsdcAmount,
  hashMilestoneSpec,
  hashStandardV2Milestones,
  hashDealProposalV2,
  verifyDealProposalSignature,
  validateStandardV2ProtocolRules,
  validateStandardV2UxRules,
} from '@/lib/deals/v2';
import { fetchNextClientProposalNonce } from '@/lib/deals/v2-actions';
import { sepoliaPublicClient } from '@/lib/chain';
import { ChainGuard } from '@/components/shared/ChainGuard';
import { useDirectoryContract } from '@/hooks/useDirectoryContract';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
import { useSidebar } from '@/context/SidebarContext';
import { useBatchFreelancerCompletedDeals } from '@/hooks/useFreelancerStats';
import { useSynqIdentity, useSynqIdentities } from '@/hooks/useSynqIdentity';
import { useAuthSession } from '@/hooks/useAuthSession';
import { DealReceipt } from '@/components/deals/DealReceipt';
import type { DealProposalV2, StandardV2MilestoneInit } from '@/types/deal-v2';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

const tokenize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

const SUGGESTED_JOB_TITLES = [
  'Web Development',
  'Frontend Development',
  'Backend Development',
  'Full Stack Development',
  'Web3 Development',
  'React Development',
  'Next.js Development',
  'Mobile App Development',
  'API Development',
  'Smart Contract Development',
  'Web Design',
  'UI Design',
  'UX Design',
  'UI/UX Design',
  'Landing Page Design',
  'Graphic Design',
  'Logo Design',
  'Product Design',
  'Smart Contract Audit',
  'Blockchain Development',
  'Solidity Development',
  'Web3 Integration',
  'Security Audit',
  'Content Writing',
  'Technical Writing',
  'Copywriting',
  'Documentation',
];

interface FormMilestone {
  title: string;
  description: string;
  amountUsdc: string;
  deadlineDate: string;
  deadlineTime: string;
  reviewWindowSeconds: number;
  gracePeriodSeconds: number;
}

const steps = [
  { title: 'Type', description: 'What are you buying or selling?' },
  { title: 'Counterparty', description: 'Who is the counterparty?' },
  { title: 'Deliverables', description: 'What is the overall scope?' },
  { title: 'Payment', description: 'How should payment be structured?' },
  { title: 'Milestones', description: 'Define deliverables & deadlines' },
  { title: 'Protection', description: 'Adaptive Protection level' },
  { title: 'Review', description: 'Review & sign proposal' },
];

export default function NewDealPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-blue-400" />
        </div>
      }
    >
      <NewDealForm />
    </Suspense>
  );
}

function NewDealForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { address, isConnected } = useAccount();
  const { collapsed } = useSidebar();
  const { ensureSepolia, networkReady } = useSepoliaNetwork();
  const { ensureAuthenticated } = useAuthSession();
  const { signTypedDataAsync } = useSignTypedData();

  const directory = useDirectoryContract(address);
  const initialSeller = searchParams.get('seller') || '';
  const entryMode = useRef<'open' | 'freelancer-prefilled'>(
    initialSeller ? 'freelancer-prefilled' : 'open'
  ).current;

  const [step, setStep] = useState(initialSeller ? 1 : 0);
  const [matches, setMatches] = useState<any[]>([]);
  const [matchState, setMatchState] = useState<'idle' | 'matching' | 'done'>('idle');
  const [matchError, setMatchError] = useState('');

  const prefilledDeadline = searchParams.get('deadline') || '';
  const rawUrlPayment = searchParams.get('payment');
  const initialPaymentStructure =
    rawUrlPayment === '50/50' || rawUrlPayment === '50-50' || rawUrlPayment === 'half'
      ? '50-50'
      : rawUrlPayment === 'single'
      ? 'single'
      : 'custom';

  const [form, setForm] = useState({
    type: searchParams.get('type') || '',
    counterparty: initialSeller,
    budget: searchParams.get('budget') || '1.00',
    deliverables: '',
    paymentStructure: initialPaymentStructure as 'single' | '50-50' | 'custom',
    protection: false,
    expiryDays: 7,
  });

  const getDefaultDeadlineDate = (daysFromNow: number) => {
    const d = new Date(Date.now() + daysFromNow * 86400 * 1000);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const [milestones, setMilestones] = useState<FormMilestone[]>([
    {
      title: 'Milestone 1 — Initial Deliverable',
      description: 'Initial project milestone deliverable and acceptance criteria.',
      amountUsdc: '0.50',
      deadlineDate: prefilledDeadline || getDefaultDeadlineDate(7),
      deadlineTime: '23:59',
      reviewWindowSeconds: 86400,
      gracePeriodSeconds: 0,
    },
    {
      title: 'Milestone 2 — Final Delivery',
      description: 'Final project milestone deliverable, testing, and acceptance.',
      amountUsdc: '0.50',
      deadlineDate: prefilledDeadline || getDefaultDeadlineDate(14),
      deadlineTime: '23:59',
      reviewWindowSeconds: 86400,
      gracePeriodSeconds: 0,
    },
  ]);

  const [signing, setSigning] = useState(false);
  const [error, setError] = useState('');
  const [submittedProposal, setSubmittedProposal] = useState<any | null>(null);
  const [nonceConflict, setNonceConflict] = useState(false);
  const [refreshingNonce, setRefreshingNonce] = useState(false);

  const handleRefreshNonce = async () => {
    try {
      setRefreshingNonce(true);
      setError('');
      if (!address) {
        setError('Please connect your wallet first.');
        return;
      }
      await fetchNextClientProposalNonce(address, sepoliaPublicClient);
      setNonceConflict(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to refresh proposal nonce');
    } finally {
      setRefreshingNonce(false);
    }
  };

  // Negotiator Handoff
  const negotiatorConvId = searchParams.get('negotiatorConversationId');
  const negotiatorMode = searchParams.get('negotiatorMode');
  const [handoffLoading, setHandoffLoading] = useState<boolean>(!!negotiatorConvId);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const handoffLoadedRef = useRef<boolean>(false);

  useEffect(() => {
    if (!negotiatorConvId || handoffLoadedRef.current) return;

    let cancelled = false;
    setHandoffLoading(true);
    setHandoffError(null);

    (async () => {
      try {
        const token = await ensureAuthenticated();
        if (cancelled) return;

        const isEditMode = negotiatorMode === 'edit';
        const url = `/api/negotiator/conversations/${encodeURIComponent(negotiatorConvId)}/deal-handoff${isEditMode ? '?mode=edit' : ''}`;

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (cancelled) return;

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          setHandoffError(errData.error || 'Failed to load negotiated deal draft.');
          setHandoffLoading(false);
          return;
        }

        const data = await res.json();
        if (cancelled || !data?.handoff) return;

        const h = data.handoff;
        handoffLoadedRef.current = true;

        const targetStructure = h.paymentStructure && ['single', '50-50', 'custom'].includes(h.paymentStructure)
          ? h.paymentStructure
          : 'custom';

        const amountStr = h.amount ? String(h.amount) : '1.00';
        const deadlineDateStr = h.deadline || getDefaultDeadlineDate(14);

        setForm((prev) => ({
          ...prev,
          type: h.title ?? prev.type ?? '',
          counterparty: h.seller ?? prev.counterparty ?? '',
          budget: amountStr,
          deliverables: h.scope ?? prev.deliverables ?? '',
          paymentStructure: targetStructure,
        }));

        // Adjust milestones based on negotiated handoff
        if (targetStructure === 'single') {
          setMilestones([
            {
              title: h.title ? `${h.title} — Final Delivery` : 'Final Deliverable',
              description: h.scope || 'Complete deliverable as agreed.',
              amountUsdc: amountStr,
              deadlineDate: deadlineDateStr,
              deadlineTime: '23:59',
              reviewWindowSeconds: 86400,
              gracePeriodSeconds: 0,
            },
          ]);
        } else if (targetStructure === '50-50') {
          let halfAmount = '0.50';
          try {
            const totalUnits = parseUsdcAmount(amountStr);
            halfAmount = formatUsdcAmount(totalUnits / 2n);
          } catch {}
          setMilestones([
            {
              title: 'Milestone 1 — Initial Progress',
              description: 'Initial deliverable components.',
              amountUsdc: halfAmount,
              deadlineDate: getDefaultDeadlineDate(7),
              deadlineTime: '23:59',
              reviewWindowSeconds: 86400,
              gracePeriodSeconds: 0,
            },
            {
              title: 'Milestone 2 — Final Delivery',
              description: h.scope || 'Final deliverable and review.',
              amountUsdc: halfAmount,
              deadlineDate: deadlineDateStr,
              deadlineTime: '23:59',
              reviewWindowSeconds: 86400,
              gracePeriodSeconds: 0,
            },
          ]);
        }

        const targetStep = typeof h.targetStep === 'number' ? Math.min(h.targetStep, 6) : 6;
        setStep(targetStep);
        setHandoffLoading(false);
      } catch (err: any) {
        if (!cancelled) {
          setHandoffError(err?.message || 'Failed to load negotiated deal draft.');
          setHandoffLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [negotiatorConvId, negotiatorMode, ensureAuthenticated]);

  // Adjust milestone amounts when payment structure or budget changes
  const applyPaymentStructure = (struct: 'single' | '50-50' | 'custom', budgetStr: string) => {
    let cleanBudget = budgetStr.trim() || '1.00';
    if (struct === 'single') {
      setMilestones([
        {
          title: form.type ? `${form.type} — Final Delivery` : 'Final Deliverable',
          description: form.deliverables || 'Complete deliverable according to agreed scope.',
          amountUsdc: cleanBudget,
          deadlineDate: milestones[0]?.deadlineDate || getDefaultDeadlineDate(14),
          deadlineTime: '23:59',
          reviewWindowSeconds: 86400,
          gracePeriodSeconds: 0,
        },
      ]);
    } else if (struct === '50-50') {
      let half = '0.50';
      try {
        const total = parseUsdcAmount(cleanBudget);
        half = formatUsdcAmount(total / 2n);
      } catch {}
      setMilestones([
        {
          title: 'Milestone 1 — Initial Deliverable',
          description: 'Initial deliverables and progress demo.',
          amountUsdc: half,
          deadlineDate: milestones[0]?.deadlineDate || getDefaultDeadlineDate(7),
          deadlineTime: '23:59',
          reviewWindowSeconds: 86400,
          gracePeriodSeconds: 0,
        },
        {
          title: 'Milestone 2 — Final Deliverable',
          description: 'Final delivery and documentation.',
          amountUsdc: half,
          deadlineDate: milestones[1]?.deadlineDate || getDefaultDeadlineDate(14),
          deadlineTime: '23:59',
          reviewWindowSeconds: 86400,
          gracePeriodSeconds: 0,
        },
      ]);
    }
  };

  // Live search and freelancer directory state
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showAllMatches, setShowAllMatches] = useState(false);
  const [isAiExpanded, setIsAiExpanded] = useState(false);
  const [avatarsMap, setAvatarsMap] = useState<Record<string, string>>({});
  const [namesMap, setNamesMap] = useState<Record<string, string>>({});
  const [reviewCountsMap, setReviewCountsMap] = useState<Record<string, number>>({});

  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!searchFocused) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [searchFocused]);

  const freelancerIdentity = useSynqIdentity(form.counterparty);
  const clientIdentity = useSynqIdentity(address);

  const formatIdentityDisplay = (idObj: { wallet: string; displayHandle: string | null; shortWallet: string }) => {
    if (!idObj.wallet) return '';
    if (idObj.displayHandle) {
      return `${idObj.displayHandle} (${idObj.shortWallet})`;
    }
    return idObj.shortWallet;
  };

  const freelancerIdentityText = formatIdentityDisplay(freelancerIdentity);
  const clientIdentityText = formatIdentityDisplay(clientIdentity);

  const filteredSuggestions = useMemo(() => {
    const rawInput = form.type.trim();
    if (!rawInput) return [];

    const lowerInput = rawInput.toLowerCase();
    const inputTokens = tokenize(lowerInput);

    return SUGGESTED_JOB_TITLES.filter((title) => {
      const lowerTitle = title.toLowerCase();
      if (lowerTitle === lowerInput) return false;
      if (lowerTitle.includes(lowerInput)) return true;
      if (inputTokens.length > 1) {
        return inputTokens.every((token) => lowerTitle.includes(token));
      }
      return false;
    }).slice(0, 6);
  }, [form.type]);

  const selectFreelancer = (wallet: string) => {
    const normalized = (wallet || '').trim();
    setForm((prev) => ({ ...prev, counterparty: normalized }));
    setError('');
  };

  const clearSelectedFreelancer = () => {
    setForm((prev) => ({ ...prev, counterparty: '' }));
    setMatches([]);
    setMatchState('idle');
    setMatchError('');
  };

  const sellerWallets = useMemo(
    () => (directory.profiles || []).filter((p: any) => p && p.wallet).map((p: any) => String(p.wallet).trim()),
    [directory.profiles]
  );
  const uniqueWalletsKey = useMemo(() => {
    const list = [...sellerWallets];
    if (address) list.push(address.trim());
    return Array.from(new Set(list.filter(Boolean).map((w) => w.toLowerCase()))).sort().join(',');
  }, [sellerWallets, address]);

  const { completedCountsMap } = useBatchFreelancerCompletedDeals(sellerWallets);
  const { identitiesMap: sellerIdentities } = useSynqIdentities(sellerWallets);

  useEffect(() => {
    if (!uniqueWalletsKey) return;
    const uniqueWallets = uniqueWalletsKey.split(',');
    let isMounted = true;
    fetch('/api/profile/public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallets: uniqueWallets }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!isMounted || !Array.isArray(data?.profiles)) return;
        const avatarMap: Record<string, string> = {};
        const nameMap: Record<string, string> = {};
        for (const p of data.profiles) {
          if (p?.wallet) {
            const key = String(p.wallet).toLowerCase();
            if (p.avatar) avatarMap[key] = p.avatar;
            if (p.name) nameMap[key] = p.name;
          }
        }
        setAvatarsMap(avatarMap);
        setNamesMap(nameMap);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, [uniqueWalletsKey]);

  const update = (key: string, value: any) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError('');
    setNonceConflict(false);
  };

  const updateMilestone = (index: number, field: keyof FormMilestone, value: any) => {
    setMilestones((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
    setError('');
    setNonceConflict(false);
  };

  const addMilestone = () => {
    if (milestones.length >= 10) return;
    setMilestones((prev) => [
      ...prev,
      {
        title: `Milestone ${prev.length + 1}`,
        description: 'Deliverable specification.',
        amountUsdc: '0.50',
        deadlineDate: getDefaultDeadlineDate(7 * (prev.length + 1)),
        deadlineTime: '23:59',
        reviewWindowSeconds: 86400,
        gracePeriodSeconds: 0,
      },
    ]);
  };

  const removeMilestone = (index: number) => {
    if (milestones.length <= 1) return;
    setMilestones((prev) => prev.filter((_, i) => i !== index));
  };

  // Total escrow calculation
  const totalEscrowBaseUnits = useMemo(() => {
    let sum = 0n;
    for (const m of milestones) {
      try {
        sum += parseUsdcAmount(m.amountUsdc || '0');
      } catch {}
    }
    return sum;
  }, [milestones]);

  const formattedTotalEscrow = useMemo(() => {
    return formatUsdcAmount(totalEscrowBaseUnits);
  }, [totalEscrowBaseUnits]);

  // Validation
  const canProceed = () => {
    switch (step) {
      case 0:
        return form.type.trim().length > 0;
      case 1:
        return (
          isAddress(form.counterparty) &&
          form.counterparty.toLowerCase() !== ZERO_ADDRESS.toLowerCase() &&
          (!address || form.counterparty.toLowerCase() !== address.toLowerCase())
        );
      case 2:
        return form.deliverables.trim().length > 0;
      case 3:
        return totalEscrowBaseUnits > 0n;
      case 4:
        if (milestones.length === 0 || milestones.length > 10) return false;
        const now = Math.floor(Date.now() / 1000);
        for (const m of milestones) {
          if (!m.title.trim()) return false;
          if (!m.amountUsdc || isNaN(Number(m.amountUsdc)) || Number(m.amountUsdc) <= 0) return false;
          if (!m.deadlineDate) return false;
          const ts = Math.floor(new Date(`${m.deadlineDate}T${m.deadlineTime || '23:59'}`).getTime() / 1000);
          if (isNaN(ts) || ts <= now) return false;
          if (m.reviewWindowSeconds < Number(MIN_REVIEW_WINDOW_SECONDS) || m.reviewWindowSeconds > Number(MAX_REVIEW_WINDOW_SECONDS)) {
            return false;
          }
        }
        return true;
      default:
        return true;
    }
  };

  const handlePrevious = () => {
    setError('');
    setNonceConflict(false);
    if (step > 0) setStep(step - 1);
  };

  // Sign & Send Proposal Action
  const handleSignAndSendProposal = async () => {
    if (!address) {
      setError('Please connect your wallet first.');
      return;
    }

    if (!isAddress(form.counterparty) || form.counterparty.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      setError('Please select a valid freelancer wallet address.');
      return;
    }

    if (address.toLowerCase() === form.counterparty.toLowerCase()) {
      setError('Client and freelancer cannot be the same wallet address (self-deal forbidden).');
      return;
    }

    try {
      setSigning(true);
      setError('');
      setNonceConflict(false);
      await ensureSepolia();

      // 1. Validate milestones and build MilestoneInits
      const nowSec = Math.floor(Date.now() / 1000);
      const normalizedMilestoneInits: StandardV2MilestoneInit[] = [];

      for (let i = 0; i < milestones.length; i++) {
        const m = milestones[i];
        const rawAmount = parseUsdcAmount(m.amountUsdc);
        if (rawAmount <= 0n) {
          throw new Error(`Milestone [${i + 1}] amount must be greater than zero.`);
        }

        const deadlineTs = Math.floor(new Date(`${m.deadlineDate}T${m.deadlineTime || '23:59'}`).getTime() / 1000);
        if (isNaN(deadlineTs) || deadlineTs <= nowSec) {
          throw new Error(`Milestone [${i + 1}] deadline must be a future date and time.`);
        }

        const reviewSec = BigInt(m.reviewWindowSeconds);
        if (reviewSec < MIN_REVIEW_WINDOW_SECONDS || reviewSec > MAX_REVIEW_WINDOW_SECONDS) {
          throw new Error(`Milestone [${i + 1}] review window must be between 1 hour and 30 days.`);
        }

        const graceSec = BigInt(m.gracePeriodSeconds);

        const specText = m.description.trim() || m.title.trim();
        const specHash = hashMilestoneSpec(specText);

        normalizedMilestoneInits.push({
          amount: rawAmount,
          workDeadline: BigInt(deadlineTs),
          reviewWindow: reviewSec,
          gracePeriod: graceSec,
          specHash,
        });
      }

      // 2. Fetch fresh unused client proposal nonce
      const proposalNonce = await fetchNextClientProposalNonce(address, sepoliaPublicClient);

      // 3. Compute milestonesHash
      const milestonesHash = hashStandardV2Milestones(normalizedMilestoneInits);

      // 4. Construct DealProposalV2 struct
      const expiry = BigInt(nowSec + form.expiryDays * 86400);
      const proposalStruct: DealProposalV2 = {
        client: getAddress(address),
        freelancer: getAddress(form.counterparty),
        canonicalUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
        dealImplementation: SYNQ_V2_SEPOLIA_CONFIG.dealImplementation,
        primaryResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver,
        emergencyResolver: SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver,
        milestonesHash,
        isProtected: false,
        protectionModule: ZERO_ADDRESS,
        policyId: ZERO_BYTES32,
        proposalNonce,
        expiry,
      };

      // 5. Pre-validate protocol rules
      const protocolVal = validateStandardV2ProtocolRules(proposalStruct, normalizedMilestoneInits);
      if (!protocolVal.valid) {
        throw new Error(`Proposal validation failed: ${protocolVal.errors.join('; ')}`);
      }

      // 6. Sign EIP-712 DealProposal with client wallet
      const domain = getStandardV2Eip712Domain();
      const clientSignature = await signTypedDataAsync({
        domain,
        types: DEAL_PROPOSAL_EIP712_TYPES,
        primaryType: 'DealProposal',
        message: proposalStruct,
      });

      // 7. Locally verify recovered signer
      const isSigValid = await verifyDealProposalSignature(proposalStruct, clientSignature, domain);
      if (!isSigValid) {
        throw new Error('Local signature verification failed. Please try again.');
      }

      // 8. Ensure Synq authentication session
      const token = await ensureAuthenticated();

      // 9. Persist proposal via API
      const requestPayload = {
        proposal: {
          client: proposalStruct.client,
          freelancer: proposalStruct.freelancer,
          canonicalUsdc: proposalStruct.canonicalUsdc,
          dealImplementation: proposalStruct.dealImplementation,
          primaryResolver: proposalStruct.primaryResolver,
          emergencyResolver: proposalStruct.emergencyResolver,
          milestonesHash: proposalStruct.milestonesHash,
          isProtected: false,
          protectionModule: ZERO_ADDRESS,
          policyId: ZERO_BYTES32,
          proposalNonce: proposalStruct.proposalNonce.toString(),
          expiry: proposalStruct.expiry.toString(),
        },
        milestones: normalizedMilestoneInits.map((m, idx) => ({
          amount: m.amount.toString(),
          workDeadline: m.workDeadline.toString(),
          reviewWindow: m.reviewWindow.toString(),
          gracePeriod: m.gracePeriod.toString(),
          specHash: m.specHash,
          title: milestones[idx].title.trim(),
          description: milestones[idx].description.trim(),
        })),
        clientSignature,
        metadata: {
          title: form.type.trim(),
          scope: form.deliverables.trim() || 'Standard Synq Deal',
        },
      };

      const res = await fetch('/api/deals/proposals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestPayload),
      });

      const resData = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (
          res.status === 409 &&
          (resData.code === 'CONFLICT_NONCE' ||
            (typeof resData.error === 'string' && resData.error.toLowerCase().includes('nonce conflict')))
        ) {
          setNonceConflict(true);
          setError('');
          return;
        }
        throw new Error(resData.error || 'Failed to submit deal proposal');
      }

      setSubmittedProposal(resData.proposal);
      // Route to proposal view
      router.push(`/deals/proposals/${resData.proposal.proposalId}`);
    } catch (err: any) {
      setError(err?.message || 'Failed to create deal proposal');
    } finally {
      setSigning(false);
    }
  };

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <div className="space-y-3">
            <label htmlFor="job-title-input" className="block text-sm font-medium text-zinc-300">
              What do you need done?
            </label>
            <div className="relative">
              <Input
                id="job-title-input"
                value={form.type}
                onChange={(e) => {
                  update('type', e.target.value);
                  setShowSuggestions(true);
                }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => {
                  setTimeout(() => setShowSuggestions(false), 150);
                }}
                placeholder="Type a job title..."
                className="w-full text-sm bg-zinc-900/60 border-zinc-700 text-white placeholder:text-zinc-500 focus:border-blue-500/60"
                autoComplete="off"
              />
              {showSuggestions && filteredSuggestions.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1.5 z-20 overflow-hidden rounded-xl border border-zinc-700/70 bg-zinc-900/95 p-1.5 shadow-xl backdrop-blur-md">
                  <div className="space-y-0.5">
                    {filteredSuggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          update('type', suggestion);
                          setShowSuggestions(false);
                        }}
                        className={cn(
                          'w-full text-left px-3 py-2 rounded-lg text-sm transition-colors text-zinc-200 hover:bg-blue-600/15 hover:text-blue-300',
                          form.type === suggestion && 'bg-blue-600/20 text-blue-400 font-medium'
                        )}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <p className="text-xs text-zinc-500">
              Type any title or pick a suggestion. Custom titles are fully supported.
            </p>
          </div>
        );

      case 1:
        return (
          <div className="space-y-4">
            <p className="text-sm text-zinc-400 mb-2">
              Choose the freelancer you want to propose this deal to.
            </p>

            {/* FREELANCER LIVE SEARCH */}
            <div ref={searchRef} className="relative space-y-1">
              <label htmlFor="freelancer-search-input" className="text-xs text-zinc-400 font-medium block">
                Search Freelancers
              </label>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                <Input
                  id="freelancer-search-input"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSearchFocused(true);
                  }}
                  onFocus={() => setSearchFocused(true)}
                  placeholder="Search freelancers by handle, name, skill, or wallet..."
                  className="w-full pl-9 pr-8 text-sm bg-zinc-900/60 border-zinc-700/60 text-white placeholder:text-zinc-500 focus:border-blue-500/60 rounded-xl"
                  autoComplete="off"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 p-0.5"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {/* SEARCH DROPDOWN */}
              {searchFocused && searchQuery.trim().length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1.5 z-30 overflow-hidden rounded-xl border border-zinc-700/70 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-md">
                  <div className="space-y-1 max-h-72 overflow-y-auto">
                    {(directory.profiles || [])
                      .filter((p: any) => p && p.wallet && p.wallet !== address)
                      .slice(0, 5)
                      .map((p: any) => (
                        <button
                          key={p.wallet}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectFreelancer(p.wallet);
                            setSearchQuery('');
                            setSearchFocused(false);
                          }}
                          className="w-full text-left p-2.5 rounded-lg hover:bg-zinc-800/60 flex items-center justify-between gap-3"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-white truncate">
                              {p.name || shortenAddress(p.wallet)}
                            </div>
                            <div className="text-xs font-mono text-zinc-400 truncate">
                              {shortenAddress(p.wallet)}
                            </div>
                          </div>
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-zinc-400 font-medium block">Freelancer Wallet</label>
                <div className="w-full px-3 py-2 rounded-lg border border-zinc-700/60 bg-zinc-900/60 font-mono text-sm text-zinc-200 h-10 flex items-center select-none truncate">
                  {freelancerIdentityText || form.counterparty || (
                    <span className="text-zinc-500 font-sans italic text-xs">No freelancer selected</span>
                  )}
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-zinc-400 font-medium block">Client Wallet</label>
                <div className="w-full px-3 py-2 rounded-lg border border-zinc-700/60 bg-zinc-900/60 font-mono text-sm text-zinc-200 h-10 flex items-center select-none truncate">
                  {clientIdentityText || shortenAddress(address || '')}
                </div>
              </div>
            </div>
          </div>
        );

      case 2:
        return (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400 mb-2">
              Describe the overall deliverables and scope of the engagement.
            </p>
            <div className="relative space-y-1">
              <textarea
                value={form.deliverables}
                onChange={(e) => update('deliverables', e.target.value)}
                placeholder="Describe project scope, technical requirements, and acceptance standards..."
                className="w-full h-36 rounded-xl border border-zinc-700/60 bg-zinc-900/60 p-4 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/60 resize-none font-sans"
              />
              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] text-zinc-500 font-mono">
                  {form.deliverables.length} characters
                </span>
              </div>
            </div>
          </div>
        );

      case 3:
        return (
          <div className="space-y-5">
            <div>
              <h3 className="text-base font-semibold text-white mb-1">Payment Structure & Total Budget</h3>
              <p className="text-xs text-zinc-400">Standard V2 uses canonical Sepolia USDC (6 decimals) escrow.</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { value: 'single', label: 'Single Release', desc: '100% on final deliverable' },
                { value: '50-50', label: '50/50 Milestones', desc: 'Two equal milestone releases' },
                { value: 'custom', label: 'Custom Stages', desc: 'Tailored milestone breakdown' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    update('paymentStructure', opt.value);
                    applyPaymentStructure(opt.value as any, form.budget);
                  }}
                  className={cn(
                    'p-3.5 rounded-xl border text-left transition-all',
                    form.paymentStructure === opt.value
                      ? 'border-blue-500/50 bg-blue-600/10 shadow-sm'
                      : 'border-zinc-700/50 bg-zinc-800/30 hover:border-zinc-600'
                  )}
                >
                  <div className="text-sm font-semibold text-white">{opt.label}</div>
                  <div className="text-xs text-zinc-400 mt-0.5">{opt.desc}</div>
                </button>
              ))}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="deal-budget-input" className="text-xs text-zinc-400 font-medium block">
                TOTAL DEAL BUDGET (USDC)
              </label>
              <div className="relative">
                <Input
                  id="deal-budget-input"
                  value={form.budget}
                  onChange={(e) => {
                    const val = e.target.value;
                    update('budget', val);
                    if (form.paymentStructure !== 'custom') {
                      applyPaymentStructure(form.paymentStructure, val);
                    }
                  }}
                  placeholder="1.00"
                  className="w-full pl-3.5 pr-16 font-mono text-sm bg-zinc-900/60 border-zinc-700/60 text-white placeholder:text-zinc-500 focus:border-blue-500/60 rounded-xl h-10"
                  type="number"
                  min="0"
                  step="0.01"
                />
                <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-zinc-400 text-xs font-semibold uppercase pointer-events-none">
                  USDC
                </span>
              </div>
            </div>
          </div>
        );

      case 4:
        return (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-white mb-0.5">Milestone Schedule</h3>
                <p className="text-xs text-zinc-400">
                  Total Escrow: <span className="font-semibold text-blue-400">{formattedTotalEscrow} USDC</span> across {milestones.length} milestone{milestones.length === 1 ? '' : 's'}.
                </p>
              </div>
              {form.paymentStructure === 'custom' && milestones.length < 10 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addMilestone}
                  className="text-xs gap-1.5 border-zinc-700 bg-zinc-800/40 text-zinc-300"
                >
                  <Plus size={14} /> Add Milestone
                </Button>
              )}
            </div>

            <div className="space-y-4 max-h-[460px] overflow-y-auto pr-1">
              {milestones.map((m, idx) => (
                <div
                  key={idx}
                  className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/50 space-y-3 relative"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-blue-400">
                      Milestone {idx + 1}
                    </span>
                    {form.paymentStructure === 'custom' && milestones.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeMilestone(idx)}
                        className="text-zinc-500 hover:text-red-400 transition-colors p-1"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold block">
                        Title
                      </label>
                      <Input
                        value={m.title}
                        onChange={(e) => updateMilestone(idx, 'title', e.target.value)}
                        placeholder={`Milestone ${idx + 1} Title`}
                        className="text-xs bg-zinc-950/40 border-zinc-800 text-white h-9"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold block">
                        Amount (USDC)
                      </label>
                      <Input
                        value={m.amountUsdc}
                        onChange={(e) => updateMilestone(idx, 'amountUsdc', e.target.value)}
                        placeholder="0.50"
                        className="text-xs font-mono bg-zinc-950/40 border-zinc-800 text-white h-9"
                        type="number"
                        step="0.01"
                        min="0"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold block">
                      Acceptance Specification
                    </label>
                    <textarea
                      value={m.description}
                      onChange={(e) => updateMilestone(idx, 'description', e.target.value)}
                      placeholder="Specify the work deliverable and acceptance criteria (hashed into specHash)..."
                      className="w-full h-18 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 resize-none"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <label className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold block">
                        Work Deadline
                      </label>
                      <Input
                        type="date"
                        value={m.deadlineDate}
                        onChange={(e) => updateMilestone(idx, 'deadlineDate', e.target.value)}
                        className="text-xs font-mono bg-zinc-950/40 border-zinc-800 text-white h-9"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold block">
                        Review Window
                      </label>
                      <select
                        value={m.reviewWindowSeconds}
                        onChange={(e) => updateMilestone(idx, 'reviewWindowSeconds', Number(e.target.value))}
                        className="w-full rounded-md border border-zinc-800 bg-zinc-950/40 px-3 text-xs text-white h-9"
                      >
                        <option value={86400}>24 Hours</option>
                        <option value={259200}>3 Days</option>
                        <option value={604800}>7 Days</option>
                        <option value={1209600}>14 Days</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold block">
                        Grace Period
                      </label>
                      <select
                        value={m.gracePeriodSeconds}
                        onChange={(e) => updateMilestone(idx, 'gracePeriodSeconds', Number(e.target.value))}
                        className="w-full rounded-md border border-zinc-800 bg-zinc-950/40 px-3 text-xs text-white h-9"
                      >
                        <option value={0}>0 Days</option>
                        <option value={86400}>1 Day</option>
                        <option value={259200}>3 Days</option>
                        <option value={604800}>7 Days</option>
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );

      case 5:
        return (
          <div className="space-y-4">
            <p className="text-sm text-zinc-400">Choose the protection level for this deal.</p>
            <div className="space-y-2.5">
              <button
                type="button"
                className="w-full p-3.5 rounded-xl border border-blue-500/50 bg-blue-600/10 text-left shadow-sm"
              >
                <div className="text-sm font-medium text-white">No Protection</div>
                <div className="text-xs text-zinc-400 mt-0.5">Proceed with standard smart contract escrow</div>
              </button>

              <button
                type="button"
                disabled
                aria-disabled="true"
                tabIndex={-1}
                className="w-full p-3.5 rounded-xl border border-zinc-800/60 bg-zinc-900/30 opacity-60 cursor-not-allowed text-left select-none"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-zinc-300">Adaptive Protection</div>
                    <div className="text-xs text-zinc-500 mt-0.5">Coming soon...</div>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700/50 uppercase tracking-wider">
                    Coming Soon
                  </span>
                </div>
              </button>
            </div>
          </div>
        );

      case 6:
        return (
          <div className="space-y-5">
            <div className="rounded-xl border border-blue-500/30 bg-blue-950/20 p-4 space-y-2">
              <div className="flex items-center gap-2 text-blue-400 text-sm font-semibold">
                <Info size={16} /> Important Protocol Notice
              </div>
              <p className="text-xs text-blue-200/90 leading-relaxed">
                NO FUNDS MOVE WHEN YOU SIGN THIS PROPOSAL. The designated freelancer must review and accept the proposal on-chain before a Deal contract is deployed. You will fund escrow only after acceptance.
              </p>
            </div>

            {/* Proposal Summary Details */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3 border-b border-zinc-800/80 pb-3">
                <div>
                  <span className="text-zinc-500 block uppercase tracking-wider text-[10px]">Client</span>
                  <span className="font-mono text-zinc-200">{shortenAddress(address || '')}</span>
                </div>
                <div>
                  <span className="text-zinc-500 block uppercase tracking-wider text-[10px]">Freelancer</span>
                  <span className="font-mono text-zinc-200">{shortenAddress(form.counterparty || '')}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 border-b border-zinc-800/80 pb-3">
                <div>
                  <span className="text-zinc-500 block uppercase tracking-wider text-[10px]">Total Escrow</span>
                  <span className="font-bold text-white text-sm">{formattedTotalEscrow} USDC</span>
                </div>
                <div>
                  <span className="text-zinc-500 block uppercase tracking-wider text-[10px]">Milestones</span>
                  <span className="font-bold text-white text-sm">{milestones.length}</span>
                </div>
                <div>
                  <span className="text-zinc-500 block uppercase tracking-wider text-[10px]">Protection</span>
                  <span className="text-zinc-300">Disabled (Standard)</span>
                </div>
                <div>
                  <span className="text-zinc-500 block uppercase tracking-wider text-[10px]">Proposal Expiry</span>
                  <span className="text-zinc-300">{form.expiryDays} days</span>
                </div>
              </div>

              <div className="space-y-2">
                <span className="text-zinc-400 font-semibold block text-[11px] uppercase tracking-wider">
                  Milestones Breakdown
                </span>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {milestones.map((m, idx) => (
                    <div key={idx} className="p-2.5 rounded-lg border border-zinc-800/60 bg-zinc-950/40 space-y-1">
                      <div className="flex items-center justify-between text-zinc-200 font-medium">
                        <span>{m.title || `Milestone ${idx + 1}`}</span>
                        <span className="font-mono text-blue-400">{m.amountUsdc} USDC</span>
                      </div>
                      <div className="text-[11px] text-zinc-400 truncate">
                        {m.description || 'No description provided'}
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-zinc-500 pt-0.5">
                        <span>Deadline: {m.deadlineDate}</span>
                        <span>Review: {m.reviewWindowSeconds / 86400}d</span>
                        <span>Grace: {m.gracePeriodSeconds / 86400}d</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Nonce Conflict Banner */}
            {nonceConflict && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
                  <div className="space-y-1">
                    <h4 className="font-semibold text-amber-200 text-sm">Proposal Nonce Conflict</h4>
                    <p className="text-xs text-zinc-300 leading-relaxed">
                      Another proposal from this wallet used this proposal nonce. Your deal terms have not been lost and no funds moved.
                    </p>
                    <p className="text-xs text-zinc-400">
                      Refresh the proposal nonce and sign again to submit.
                    </p>
                  </div>
                </div>
                <div className="pt-1 flex items-center gap-3">
                  <Button
                    type="button"
                    onClick={handleRefreshNonce}
                    disabled={refreshingNonce}
                    className="bg-amber-600 hover:bg-amber-500 text-white font-medium px-4 py-1.5 text-xs rounded-lg flex items-center gap-2"
                  >
                    {refreshingNonce ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        Refreshing Nonce...
                      </>
                    ) : (
                      <>Refresh Nonce & Review</>
                    )}
                  </Button>
                </div>
              </div>
            )}

            {/* Error Message */}
            {error && !nonceConflict && (
              <div className="p-3 rounded-lg bg-red-600/10 border border-red-500/20 text-xs text-red-400">
                {error}
              </div>
            )}

            {/* Sign & Send Action */}
            <div className="flex items-center justify-between pt-2">
              <Button
                variant="outline"
                onClick={handlePrevious}
                disabled={signing}
                className="gap-2 border-zinc-700 bg-zinc-800/40 text-zinc-300"
              >
                <ArrowLeft size={16} /> Previous
              </Button>

              <Button
                onClick={handleSignAndSendProposal}
                disabled={signing || !canProceed()}
                className="gap-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold shadow-lg shadow-blue-900/30"
              >
                {signing ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> Signing & Sending...
                  </>
                ) : (
                  <>
                    <FileSignature size={16} /> Sign & Send Proposal
                  </>
                )}
              </Button>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="space-y-6 pt-0 pb-36">
      {/* PAGE HEADER */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className={`${pressStart2P.className} text-xl md:text-2xl font-normal text-white tracking-tight`}>
          Create a Deal Proposal
        </h1>
      </div>

      <ChainGuard what="Standard V2 proposals are" />

      {/* MAIN CONTAINER */}
      <div className="max-w-5xl mx-auto space-y-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* WIZARD COLUMN */}
          <div className={cn(step < 6 ? 'lg:col-span-8 space-y-6' : 'lg:col-span-8 lg:col-start-3 space-y-6')}>
            <div className="p-6 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 shadow-2xl space-y-6">
              {handoffLoading ? (
                <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
                  <Loader2 size={24} className="animate-spin text-blue-400" />
                  <p className="text-sm font-medium text-zinc-300">Fetching negotiated deal terms...</p>
                  <p className="text-xs text-zinc-500">Loading your draft from AI Negotiator</p>
                </div>
              ) : handoffError ? (
                <div className="py-8 text-center space-y-4">
                  <div className="p-4 rounded-xl bg-red-600/10 border border-red-500/20 text-sm text-red-400 font-medium">
                    {handoffError}
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => router.push('/negotiator')}
                    className="gap-2 border-zinc-700/60 bg-zinc-900/40 text-zinc-300"
                  >
                    <ArrowLeft size={16} /> Back to AI Negotiator
                  </Button>
                </div>
              ) : (
                <AnimatePresence mode="wait">
                  <motion.div key={step} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                    {renderStep()}

                    {error && step < 6 && (
                      <div className="mt-4 p-3 rounded-lg bg-red-600/10 border border-red-500/20 text-sm text-red-400">
                        {error}
                      </div>
                    )}

                    {step < 6 && (
                      <div className="flex items-center justify-between mt-8 pt-4 border-t border-zinc-800/60">
                        <Button
                          variant="outline"
                          onClick={handlePrevious}
                          disabled={step === 0}
                          className="gap-2 border-zinc-700/60 bg-zinc-900/40 text-zinc-300 hover:bg-zinc-800/60 hover:text-white"
                        >
                          <ArrowLeft size={16} /> Previous
                        </Button>
                        <Button onClick={() => setStep(step + 1)} disabled={!canProceed()} className="gap-2 bg-blue-600 hover:bg-blue-500 text-white">
                          Next <ArrowRight size={16} />
                        </Button>
                      </div>
                    )}
                  </motion.div>
                </AnimatePresence>
              )}
            </div>
          </div>

          {/* SIDEBAR PREVIEW (Steps 0-5 only) */}
          {step < 6 && (
            <div className="lg:col-span-4 relative z-10">
              <DealReceipt
                variant="compact"
                title={form.type || 'Standard V2 Deal Proposal'}
                client={{
                  wallet: address,
                  name: address ? namesMap[address.toLowerCase()] || undefined : undefined,
                  handle: clientIdentity.handle,
                  displayHandle: clientIdentity.displayHandle,
                  avatar: address ? avatarsMap[address.toLowerCase()] || null : null,
                }}
                freelancer={
                  form.counterparty
                    ? {
                        wallet: form.counterparty,
                        name: undefined,
                        handle: freelancerIdentity.handle,
                        displayHandle: freelancerIdentity.displayHandle,
                        avatar: avatarsMap[form.counterparty.toLowerCase()] || null,
                      }
                    : undefined
                }
                budget={formattedTotalEscrow}
                asset={{ symbol: 'USDC', isErc20: true }}
                scope={form.deliverables}
                deadline={milestones[milestones.length - 1]?.deadlineDate}
                paymentStructure={form.paymentStructure}
                protectionEnabled={false}
              />
            </div>
          )}
        </div>
      </div>

      {/* PROGRESS TRACKER */}
      <div
        className={cn(
          'fixed bottom-14 right-0 flex justify-center pointer-events-none z-30 px-4 transition-all duration-300 ease-in-out',
          collapsed ? 'left-0 lg:left-[68px]' : 'left-0 lg:left-[240px]'
        )}
      >
        <div className="pointer-events-auto p-4 rounded-xl bg-zinc-900/90 backdrop-blur-md border border-zinc-800/90 shadow-2xl max-w-2xl w-full">
          <div className="relative flex items-center justify-between">
            <div className="absolute top-1/2 left-4 right-4 h-0.5 -translate-y-1/2 bg-zinc-800/80 z-0" />
            <div
              className="absolute top-1/2 left-4 h-0.5 -translate-y-1/2 bg-blue-500 transition-all duration-300 z-0"
              style={{ width: `calc(${(step / (steps.length - 1)) * 100}% - 1rem)` }}
            />
            {steps.map((_, i) => {
              const isCompleted = i < step;
              const isActive = i === step;

              return (
                <div key={i} className="relative z-10 flex items-center justify-center shrink-0 rounded-full bg-zinc-900">
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-all duration-200 ${
                      isActive
                        ? 'bg-blue-600 text-white ring-4 ring-blue-500/20 border border-blue-400'
                        : isCompleted
                        ? 'bg-blue-500/20 text-blue-400 border border-blue-500/50'
                        : 'bg-zinc-900 text-zinc-500 border border-zinc-700/60'
                    }`}
                  >
                    {isCompleted ? <Check size={13} /> : i + 1}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
