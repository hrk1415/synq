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
  Search,
  X,
  Plus,
  Trash2,
  FileSignature,
  Info,
  AlertTriangle,
  Star,
  UserCheck,
  Wallet,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Press_Start_2P } from 'next/font/google';
import { useAccount, useSignTypedData } from 'wagmi';
import { getAddress, isAddress } from 'viem';

import { shortenAddress, cn } from '@/lib/utils';
import {
  SYNQ_V2_SEPOLIA_CONFIG,
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
  verifyDealProposalSignature,
  validateStandardV2ProtocolRules,
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
import { AIFreelancerMatches, calculateFreelancerMatch } from '@/components/deals/AIFreelancerMatches';
import { formatPublicPricing, type FreelancerPricing } from '@/lib/deals/pricing';
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
  { title: 'Type', description: 'What is the deal?' },
  { title: 'Freelancer', description: 'Who is the freelancer?' },
  { title: 'Scope', description: 'What is the overall scope?' },
  { title: 'Budget', description: 'Total deal budget' },
  { title: 'Deadline', description: 'Project completion target' },
  { title: 'Payment Structure', description: 'How should payment be structured?' },
  { title: 'Protection', description: 'Adaptive Protection level' },
  { title: 'Review', description: 'Review and sign deal terms' },
];

function FreelancerAvatar({
  avatar,
  name,
  handle,
  wallet,
  size = 'md',
}: {
  avatar?: string | null;
  name?: string | null;
  handle?: string | null;
  wallet?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizeClasses = {
    sm: 'w-7 h-7 text-[10px]',
    md: 'w-9 h-9 text-xs',
    lg: 'w-12 h-12 text-sm',
  }[size];

  if (avatar) {
    return (
      <img
        src={avatar}
        alt={name || 'Avatar'}
        className={cn('rounded-full object-cover shrink-0 border border-zinc-700/60', sizeClasses)}
      />
    );
  }

  const label = name || handle || wallet || 'FL';
  const initials = label.slice(0, 2).toUpperCase();
  return (
    <div
      className={cn(
        'rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-bold shrink-0 border border-zinc-700/60',
        sizeClasses
      )}
    >
      {initials}
    </div>
  );
}

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
  const { address } = useAccount();
  const { collapsed } = useSidebar();
  const { ensureSepolia } = useSepoliaNetwork();
  const { ensureAuthenticated } = useAuthSession();
  const { signTypedDataAsync } = useSignTypedData();

  const directory = useDirectoryContract(address);
  const initialSeller = searchParams.get('seller') || '';

  const [step, setStep] = useState(0);
  const [matches, setMatches] = useState<any[]>([]);
  const [matchState, setMatchState] = useState<'idle' | 'matching' | 'done'>('idle');
  const [matchError, setMatchError] = useState('');
  const [aiPanelExpanded, setAiPanelExpanded] = useState(false);

  const prefilledDeadline = searchParams.get('deadline') || '';
  const [deadlineDate, setDeadlineDate] = useState<string>(prefilledDeadline || '');
  const [deadlineTime, setDeadlineTime] = useState<string>('23:59');
  const [selectedDeadlinePreset, setSelectedDeadlinePreset] = useState<number | null>(null);

  const dateInputRef = useRef<HTMLInputElement>(null);
  const timeInputRef = useRef<HTMLInputElement>(null);

  const openDatePicker = () => {
    try {
      if (dateInputRef.current && 'showPicker' in HTMLInputElement.prototype) {
        dateInputRef.current.showPicker();
      }
    } catch {
      dateInputRef.current?.focus();
    }
  };

  const openTimePicker = () => {
    try {
      if (timeInputRef.current && 'showPicker' in HTMLInputElement.prototype) {
        timeInputRef.current.showPicker();
      }
    } catch {
      timeInputRef.current?.focus();
    }
  };

  const handleDeadlineDateChange = (date: string) => {
    setDeadlineDate(date);
    setSelectedDeadlinePreset(null);
    if (milestones.length > 0) {
      const updated = [...milestones];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        deadlineDate: date,
      };
      if (form.paymentStructure === '50-50' && updated.length === 2 && date) {
        try {
          const targetTs = new Date(`${date}T${deadlineTime || '23:59'}`).getTime();
          const nowTs = Date.now();
          if (targetTs > nowTs) {
            const midTs = new Date(nowTs + (targetTs - nowTs) / 2);
            const y = midTs.getFullYear();
            const m = String(midTs.getMonth() + 1).padStart(2, '0');
            const d = String(midTs.getDate()).padStart(2, '0');
            updated[0] = { ...updated[0], deadlineDate: `${y}-${m}-${d}` };
          }
        } catch {}
      }
      setMilestones(updated);
    }
  };

  const handleDeadlineTimeChange = (time: string) => {
    setDeadlineTime(time);
    setSelectedDeadlinePreset(null);
    if (milestones.length > 0) {
      const updated = [...milestones];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        deadlineTime: time,
      };
      setMilestones(updated);
    }
  };

  const applyDeadlinePreset = (days: number) => {
    setSelectedDeadlinePreset(days);
    const target = new Date();
    target.setDate(target.getDate() + days);
    const y = target.getFullYear();
    const m = String(target.getMonth() + 1).padStart(2, '0');
    const d = String(target.getDate()).padStart(2, '0');
    const hh = String(target.getHours()).padStart(2, '0');
    const mm = String(target.getMinutes()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;
    const timeStr = `${hh}:${mm}`;
    setDeadlineDate(dateStr);
    setDeadlineTime(timeStr);
    if (milestones.length > 0) {
      const updated = [...milestones];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        deadlineDate: dateStr,
        deadlineTime: timeStr,
      };
      if (form.paymentStructure === '50-50' && updated.length === 2 && dateStr) {
        try {
          const targetTs = target.getTime();
          const nowTs = Date.now();
          if (targetTs > nowTs) {
            const midTs = new Date(nowTs + (targetTs - nowTs) / 2);
            const my = midTs.getFullYear();
            const mmth = String(midTs.getMonth() + 1).padStart(2, '0');
            const md = String(midTs.getDate()).padStart(2, '0');
            updated[0] = { ...updated[0], deadlineDate: `${my}-${mmth}-${md}` };
          }
        } catch {}
      }
      setMilestones(updated);
    }
  };

  const formattedLocalDelivery = useMemo(() => {
    if (!deadlineDate || !deadlineTime) return null;
    try {
      const d = new Date(`${deadlineDate}T${deadlineTime}`);
      if (isNaN(d.getTime())) return null;
      const datePart = d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      const timePart = d.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });
      return `${datePart} at ${timePart}`;
    } catch {
      return null;
    }
  }, [deadlineDate, deadlineTime]);

  const rawUrlPayment = searchParams.get('payment');
  const validUrlPayment =
    rawUrlPayment === '50/50' || rawUrlPayment === '50-50' || rawUrlPayment === 'half'
      ? '50-50'
      : rawUrlPayment === 'single'
      ? 'single'
      : rawUrlPayment === 'custom'
      ? 'custom'
      : null;

  const [paymentStructureSelected, setPaymentStructureSelected] = useState<boolean>(!!validUrlPayment);
  const [expandedMilestoneIndex, setExpandedMilestoneIndex] = useState<number | null>(validUrlPayment ? 0 : null);

  const [form, setForm] = useState<{
    type: string;
    counterparty: string;
    budget: string;
    deliverables: string;
    paymentStructure: 'single' | '50-50' | 'custom' | '';
    protection: boolean;
    expiryDays: number;
  }>({
    type: searchParams.get('type') || '',
    counterparty: initialSeller,
    budget: searchParams.get('budget') || '',
    deliverables: '',
    paymentStructure: validUrlPayment || '',
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

  const initialBudgetParam = searchParams.get('budget')?.trim();
  const initialHalfBudget = initialBudgetParam && !isNaN(Number(initialBudgetParam)) && Number(initialBudgetParam) > 0
    ? formatUsdcAmount(parseUsdcAmount(initialBudgetParam) / 2n)
    : '';

  const [milestones, setMilestones] = useState<FormMilestone[]>(() => {
    if (!validUrlPayment) return [];
    if (validUrlPayment === 'single') {
      return [
        {
          title: 'Final Deliverable',
          description: 'Complete deliverable according to agreed scope.',
          amountUsdc: initialBudgetParam || '',
          deadlineDate: prefilledDeadline || getDefaultDeadlineDate(14),
          deadlineTime: '23:59',
          reviewWindowSeconds: 86400,
          gracePeriodSeconds: 0,
        },
      ];
    }
    if (validUrlPayment === '50-50') {
      return [
        {
          title: 'Milestone 1 — Initial Deliverable',
          description: 'Initial deliverables and progress demo.',
          amountUsdc: initialHalfBudget,
          deadlineDate: getDefaultDeadlineDate(7),
          deadlineTime: '23:59',
          reviewWindowSeconds: 86400,
          gracePeriodSeconds: 0,
        },
        {
          title: 'Milestone 2 — Final Deliverable',
          description: 'Final delivery and documentation.',
          amountUsdc: initialHalfBudget,
          deadlineDate: prefilledDeadline || getDefaultDeadlineDate(14),
          deadlineTime: '23:59',
          reviewWindowSeconds: 86400,
          gracePeriodSeconds: 0,
        },
      ];
    }
    return [
      {
        title: '',
        description: '',
        amountUsdc: '',
        deadlineDate: '',
        deadlineTime: '23:59',
        reviewWindowSeconds: 86400,
        gracePeriodSeconds: 0,
      },
    ];
  });

  const [signing, setSigning] = useState(false);
  const [error, setError] = useState('');
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

        const explicitStructure = h.paymentStructure && ['single', '50-50', 'custom'].includes(h.paymentStructure)
          ? (h.paymentStructure as 'single' | '50-50' | 'custom')
          : null;

        if (explicitStructure) {
          setPaymentStructureSelected(true);
        }

        const amountStr = h.amount ? String(h.amount) : '';
        const deadlineDateStr = h.deadline || getDefaultDeadlineDate(14);
        if (h.deadline) {
          setDeadlineDate(h.deadline);
        }

        setForm((prev) => ({
          ...prev,
          type: h.title ?? prev.type ?? '',
          counterparty: h.seller ?? prev.counterparty ?? '',
          budget: amountStr || prev.budget,
          deliverables: h.scope ?? prev.deliverables ?? '',
          paymentStructure: explicitStructure || '',
        }));

        if (explicitStructure === 'single') {
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
          setExpandedMilestoneIndex(0);
        } else if (explicitStructure === '50-50') {
          let halfAmount = '';
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
          setExpandedMilestoneIndex(0);
        } else if (explicitStructure === 'custom') {
          setMilestones([
            {
              title: '',
              description: '',
              amountUsdc: '',
              deadlineDate: '',
              deadlineTime: '23:59',
              reviewWindowSeconds: 86400,
              gracePeriodSeconds: 0,
            },
          ]);
          setExpandedMilestoneIndex(0);
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

  const applyPaymentStructure = (struct: 'single' | '50-50' | 'custom', budgetStr: string) => {
    const rawBudget = (budgetStr || '').trim();
    let hasValidBudget = false;
    let singleAmount = '';
    let half1Amount = '';
    let half2Amount = '';

    if (rawBudget && !isNaN(Number(rawBudget)) && Number(rawBudget) > 0) {
      try {
        const total = parseUsdcAmount(rawBudget);
        hasValidBudget = true;
        singleAmount = formatUsdcAmount(total);
        const half1 = total / 2n;
        const half2 = total - half1;
        half1Amount = formatUsdcAmount(half1);
        half2Amount = formatUsdcAmount(half2);
      } catch {}
    }

    if (struct === 'single') {
      setMilestones([
        {
          title: form.type ? `${form.type} — Final Delivery` : 'Final Deliverable',
          description: form.deliverables || 'Complete deliverable according to agreed scope.',
          amountUsdc: hasValidBudget ? singleAmount : '',
          deadlineDate: deadlineDate || milestones[0]?.deadlineDate || getDefaultDeadlineDate(14),
          deadlineTime: deadlineTime || '23:59',
          reviewWindowSeconds: 86400,
          gracePeriodSeconds: 0,
        },
      ]);
    } else if (struct === '50-50') {
      setMilestones([
        {
          title: 'Milestone 1 — Initial Deliverable',
          description: 'Initial deliverables and progress demo.',
          amountUsdc: hasValidBudget ? half1Amount : '',
          deadlineDate: milestones[0]?.deadlineDate || getDefaultDeadlineDate(7),
          deadlineTime: '23:59',
          reviewWindowSeconds: 86400,
          gracePeriodSeconds: 0,
        },
        {
          title: 'Milestone 2 — Final Deliverable',
          description: form.deliverables || 'Final delivery and documentation.',
          amountUsdc: hasValidBudget ? half2Amount : '',
          deadlineDate: deadlineDate || milestones[1]?.deadlineDate || getDefaultDeadlineDate(14),
          deadlineTime: deadlineTime || '23:59',
          reviewWindowSeconds: 86400,
          gracePeriodSeconds: 0,
        },
      ]);
    } else if (struct === 'custom') {
      setMilestones([
        {
          title: '',
          description: '',
          amountUsdc: '',
          deadlineDate: '',
          deadlineTime: '23:59',
          reviewWindowSeconds: 86400,
          gracePeriodSeconds: 0,
        },
      ]);
    }
  };

  const getMilestoneDisplayTitle = (title: string, index: number) => {
    const prefix = `Milestone ${index + 1}`;
    const trimmed = (title || '').trim();
    if (!trimmed) return prefix;
    if (new RegExp(`^milestone\\s*${index + 1}\\s*([—:\\-]\\s*)?`, 'i').test(trimmed)) {
      const stripped = trimmed.replace(new RegExp(`^milestone\\s*${index + 1}\\s*([—:\\-]\\s*)?`, 'i'), '').trim();
      return stripped ? `${prefix} — ${stripped}` : prefix;
    }
    return `${prefix} — ${trimmed}`;
  };

  const [showSuggestions, setShowSuggestions] = useState(false);
  const [avatarsMap, setAvatarsMap] = useState<Record<string, string>>({});
  const [namesMap, setNamesMap] = useState<Record<string, string>>({});
  const [pricingMap, setPricingMap] = useState<Record<string, FreelancerPricing | null>>({});
  const [reviewCountsMap, setReviewCountsMap] = useState<Record<string, number>>({});

  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
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
        const pMap: Record<string, FreelancerPricing | null> = {};
        for (const p of data.profiles) {
          if (p?.wallet) {
            const key = String(p.wallet).toLowerCase();
            if (p.avatar) avatarMap[key] = p.avatar;
            if (p.name) nameMap[key] = p.name;
            if (p.pricing) {
              pMap[key] = p.pricing;
            } else if (p.startingRateAmount && (p.startingRateType === 'PER_PROJECT' || p.startingRateType === 'PER_HOUR')) {
              pMap[key] = {
                amount: String(p.startingRateAmount),
                currency: 'USDC',
                rateType: p.startingRateType,
              };
            } else {
              pMap[key] = null;
            }
          }
        }
        setAvatarsMap(avatarMap);
        setNamesMap(nameMap);
        setPricingMap(pMap);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, [uniqueWalletsKey]);

  useEffect(() => {
    if (!uniqueWalletsKey) return;
    let isMounted = true;
    fetch(`/api/reviews?sellers=${uniqueWalletsKey}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!isMounted || !data?.counts) return;
        setReviewCountsMap(data.counts);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, [uniqueWalletsKey]);

  const selectedFreelancerProfile = useMemo(() => {
    if (!form.counterparty || !isAddress(form.counterparty)) return null;
    const target = form.counterparty.toLowerCase();
    return (
      (directory.profiles || []).find(
        (p: any) => p?.wallet && String(p.wallet).toLowerCase() === target
      ) || null
    );
  }, [form.counterparty, directory.profiles]);

  // Valid selectable directory freelancers (excluding self, zero address, invalid)
  const availableProfiles = useMemo(() => {
    return (directory.profiles || []).filter((p: any) => {
      if (!p || !p.wallet) return false;
      const w = String(p.wallet).toLowerCase();
      if (w === ZERO_ADDRESS.toLowerCase()) return false;
      if (address && w === address.toLowerCase()) return false;
      return true;
    });
  }, [directory.profiles, address]);

  // Deterministic local freelancer scoring baseline
  const scoreSeller = (p: any, type: string, deliverables: string) => {
    let score = 0;
    const typeLower = (type || '').toLowerCase();
    const cat = String(p.category || '').toLowerCase();
    if (typeLower && typeLower !== 'other') {
      if (cat === typeLower) score += 30;
      else if (cat && (cat.includes(typeLower) || typeLower.includes(cat))) score += 18;
    }
    const skills = (p.skills || []).map((s: string) => String(s).toLowerCase());
    const bio = String(p.bio || '').toLowerCase();
    const name = String(p.name || '').toLowerCase();
    const terms = [
      ...tokenize(type || ''),
      ...tokenize(deliverables || ''),
      typeLower.replace(/\s/g, ''),
    ].filter((t) => t && t.length >= 3);

    const haystack = [name, bio, ...skills].join(' ');
    for (const t of terms) {
      if (skills.some((s: string) => s.includes(t) || t.includes(s))) score += 10;
      else if (haystack.includes(t)) score += 6;
    }
    if (p.available) score += 5;
    const walletKey = String(p.wallet || '').toLowerCase();
    const completedCount = completedCountsMap[walletKey] ?? Number(p.completedDeals || 0);
    score += Math.min(completedCount * 2, 10);
    return score;
  };

  const runMatch = (autoPick = false) => {
    setMatchState('matching');
    setMatchError('');

    if (directory.isLoading) {
      setMatches([]);
      setMatchState('done');
      setMatchError('Loading registered freelancers... try again in a moment.');
      return;
    }

    if (availableProfiles.length === 0) {
      setMatches([]);
      setMatchState('done');
      setMatchError(
        'No freelancers are registered in the Deal Port yet. Register a freelancer profile on the Deal Port page first.'
      );
      return;
    }

    const scored = availableProfiles
      .map((p: any) => ({
        p,
        score: scoreSeller(p, form.type, form.deliverables),
      }))
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 3);

    setMatches(scored);
    setMatchState('done');

    if (autoPick && scored.length > 0) {
      selectFreelancer(scored[0].p.wallet);
    }
  };

  // Real-time typeahead search results
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];

    type ScoredMatch = {
      p: any;
      priority: number;
    };

    const resultList: ScoredMatch[] = [];

    for (const p of availableProfiles) {
      const w = String(p.wallet).toLowerCase();
      const name = String(p.name || '').toLowerCase();
      const cat = String(p.category || '').toLowerCase();
      const skills = (p.skills || []).map((s: string) => String(s).toLowerCase());
      const idInfo = sellerIdentities[w];
      const handle = String(idInfo?.handle || '').toLowerCase();
      const displayHandle = String(idInfo?.displayHandle || '').toLowerCase();
      const publicName = String(namesMap[w] || '').toLowerCase();

      // Direct wallet match
      if (w === query) {
        resultList.push({ p, priority: 100 });
        continue;
      }
      if (w.includes(query)) {
        resultList.push({ p, priority: 60 });
        continue;
      }
      // Handle match
      if (handle === query || displayHandle === query || `@${handle}` === query) {
        resultList.push({ p, priority: 95 });
        continue;
      }
      if (handle.includes(query) || displayHandle.includes(query)) {
        resultList.push({ p, priority: 85 });
        continue;
      }
      // Name match
      if (name === query || publicName === query) {
        resultList.push({ p, priority: 90 });
        continue;
      }
      if (name.includes(query) || publicName.includes(query)) {
        resultList.push({ p, priority: 80 });
        continue;
      }
      // Skills match
      if (skills.some((s: string) => s === query)) {
        resultList.push({ p, priority: 75 });
        continue;
      }
      if (skills.some((s: string) => s.includes(query))) {
        resultList.push({ p, priority: 70 });
        continue;
      }
      // Category match
      if (cat.includes(query)) {
        resultList.push({ p, priority: 65 });
        continue;
      }
    }

    resultList.sort((a, b) => b.priority - a.priority);
    return resultList.map((m) => m.p);
  }, [searchQuery, availableProfiles, sellerIdentities, namesMap]);

  const queryIsAddress = isAddress(searchQuery.trim());
  const queryIsOwnAddress = !!(
    address &&
    queryIsAddress &&
    searchQuery.trim().toLowerCase() === address.toLowerCase()
  );
  const queryMatchesDirectoryProfile = searchResults.some(
    (p) => String(p.wallet).toLowerCase() === searchQuery.trim().toLowerCase()
  );

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
        title: '',
        description: '',
        amountUsdc: '',
        deadlineDate: '',
        deadlineTime: '23:59',
        reviewWindowSeconds: 86400,
        gracePeriodSeconds: 0,
      },
    ]);
    setExpandedMilestoneIndex(milestones.length);
  };

  const removeMilestone = (index: number) => {
    if (milestones.length <= 1) return;
    setMilestones((prev) => prev.filter((_, i) => i !== index));
    if (expandedMilestoneIndex !== null) {
      if (expandedMilestoneIndex === index) {
        setExpandedMilestoneIndex(Math.max(0, index - 1));
      } else if (expandedMilestoneIndex > index) {
        setExpandedMilestoneIndex(expandedMilestoneIndex - 1);
      }
    }
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

  // Context for AI Freelancer Matches (derived strictly from user-entered intent)
  const aiDraftContext = useMemo(
    () => ({
      title: form.type.trim() || undefined,
      counterparty: form.counterparty || undefined,
      deliverables: step >= 2 && form.deliverables.trim() ? form.deliverables.trim() : undefined,
      budget:
        step >= 3 && form.budget.trim() && !isNaN(Number(form.budget)) && Number(form.budget) > 0
          ? form.budget.trim()
          : undefined,
      paymentStructure: step >= 5 ? form.paymentStructure : undefined,
      milestones:
        step >= 5
          ? milestones.map((m) => ({
              title: m.title.trim(),
              description: m.description.trim(),
              amountUsdc: m.amountUsdc,
            }))
          : undefined,
    }),
    [step, form.type, form.counterparty, form.budget, form.deliverables, form.paymentStructure, milestones]
  );

  // Selected freelancer match percentage (calculated with the same deterministic engine)
  const selectedMatchPercentage = useMemo(() => {
    if (!form.counterparty || !isAddress(form.counterparty)) return undefined;
    const p = selectedFreelancerProfile || {
      wallet: form.counterparty,
      name: namesMap[form.counterparty.toLowerCase()] || 'Direct Wallet',
      available: true,
    };
    const completedDeals =
      completedCountsMap[form.counterparty.toLowerCase()] ?? Number(p.completedDeals || 0);
    return calculateFreelancerMatch({
      profile: p,
      draftContext: aiDraftContext,
      completedDeals,
    });
  }, [
    form.counterparty,
    selectedFreelancerProfile,
    namesMap,
    completedCountsMap,
    aiDraftContext,
  ]);

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
        return (
          form.budget.trim().length > 0 &&
          !isNaN(Number(form.budget)) &&
          Number(form.budget) > 0
        );
      case 4: {
        if (!deadlineDate?.trim() || !deadlineTime?.trim()) return false;
        const ts = Math.floor(new Date(`${deadlineDate.trim()}T${deadlineTime.trim()}`).getTime() / 1000);
        const now = Math.floor(Date.now() / 1000);
        return !isNaN(ts) && ts > now;
      }
      case 5: {
        if (!paymentStructureSelected || !form.paymentStructure) return false;
        if (!['single', '50-50', 'custom'].includes(form.paymentStructure)) return false;
        if (milestones.length === 0 || milestones.length > 10) return false;
        if (form.paymentStructure === 'single' && milestones.length !== 1) return false;
        if (form.paymentStructure === '50-50' && milestones.length !== 2) return false;
        if (form.paymentStructure === 'custom' && (milestones.length < 1 || milestones.length > 10)) return false;
        const now = Math.floor(Date.now() / 1000);
        let sumUnits = 0n;
        for (const m of milestones) {
          if (!m.title.trim()) return false;
          if (!m.amountUsdc || isNaN(Number(m.amountUsdc)) || Number(m.amountUsdc) <= 0) return false;
          try {
            const units = parseUsdcAmount(m.amountUsdc);
            if (units <= 0n) return false;
            sumUnits += units;
          } catch {
            return false;
          }
          if (!m.deadlineDate) return false;
          const ts = Math.floor(new Date(`${m.deadlineDate}T${m.deadlineTime || '23:59'}`).getTime() / 1000);
          if (isNaN(ts) || ts <= now) return false;
          if (m.reviewWindowSeconds < Number(MIN_REVIEW_WINDOW_SECONDS) || m.reviewWindowSeconds > Number(MAX_REVIEW_WINDOW_SECONDS)) {
            return false;
          }
        }
        if (form.budget && !isNaN(Number(form.budget)) && Number(form.budget) > 0) {
          try {
            const expectedBudgetUnits = parseUsdcAmount(form.budget);
            if (sumUnits !== expectedBudgetUnits) return false;
          } catch {
            return false;
          }
        }
        return true;
      }
      case 6:
        return true;
      case 7:
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
          <div className="space-y-4">
            <label htmlFor="job-title-input" className="block text-sm font-medium text-zinc-300">
              What&apos;s the Deal?
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
                className="w-full text-sm bg-zinc-900/60 border-zinc-700 text-white placeholder:text-zinc-500 focus:border-blue-500/60 h-11"
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
          <div className="space-y-5">
            <h3 className="text-base font-semibold text-white">
              Choose the freelancer you want to propose this deal to
            </h3>

            {/* SELECTED FREELANCER STATE */}
            {form.counterparty && isAddress(form.counterparty) ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <UserCheck size={16} className="text-emerald-400" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                      Selected Freelancer
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      clearSelectedFreelancer();
                      setSearchQuery('');
                    }}
                    className="text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-600/10 h-7 px-2.5"
                  >
                    Change
                  </Button>
                </div>

                <div className="p-4 rounded-xl border border-zinc-800/80 bg-zinc-900/60 shadow-sm flex items-center justify-between gap-4">
                  {/* LEFT: PFP + NAME/HANDLE + WALLET/STATUS */}
                  <div className="flex items-center gap-3.5 min-w-0 flex-1">
                    <FreelancerAvatar
                      avatar={avatarsMap[form.counterparty.toLowerCase()]}
                      name={selectedFreelancerProfile?.name || namesMap[form.counterparty.toLowerCase()]}
                      handle={freelancerIdentity.handle}
                      wallet={form.counterparty}
                      size="lg"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 flex-wrap truncate">
                        <span className="text-base font-bold text-white truncate">
                          {selectedFreelancerProfile?.name ||
                            namesMap[form.counterparty.toLowerCase()] ||
                            'Direct Wallet'}
                        </span>
                        {freelancerIdentity.displayHandle && (
                          <span className="text-xs font-mono text-blue-400 truncate">
                            {freelancerIdentity.displayHandle}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs font-mono">
                        <span className="text-zinc-400">
                          {shortenAddress(form.counterparty)}
                        </span>
                        <span className="text-zinc-600">•</span>
                        {selectedFreelancerProfile?.available === false ? (
                          <span className="text-amber-400/90 font-sans text-[11px]">
                            ○ Busy
                          </span>
                        ) : (
                          <span className="text-emerald-400 font-sans text-[11px]">
                            ● Active
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* RIGHT: LARGE MATCH % */}
                  {selectedMatchPercentage !== undefined && (
                    <div className="text-right shrink-0 leading-none pl-2">
                      <div className="text-2xl sm:text-3xl font-black text-emerald-400 font-mono tracking-tight">
                        {selectedMatchPercentage}%
                      </div>
                      <div className="text-[9px] uppercase tracking-wider text-zinc-500 font-bold mt-0.5">
                        MATCH
                      </div>
                    </div>
                  )}
                </div>

                <p className="text-xs text-zinc-400">
                  Click <strong className="text-white font-medium">Next</strong> below to confirm this freelancer and continue.
                </p>
              </div>
            ) : (
              /* DISCOVERY & SEARCH MODE */
              <div className="space-y-4">
                {/* SEARCH INPUT & DROPDOWN */}
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
                      placeholder="Search freelancers by handle, name, skill, category, or wallet..."
                      className="w-full pl-9 pr-8 text-sm bg-zinc-900/60 border-zinc-700/60 text-white placeholder:text-zinc-500 focus:border-blue-500/60 rounded-xl h-11"
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

                  {/* REAL-TIME TYPEAHEAD DROPDOWN */}
                  {searchFocused && searchQuery.trim().length > 0 && (
                    <div className="absolute left-0 right-0 top-full mt-1.5 z-30 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900/98 p-1.5 shadow-2xl backdrop-blur-md">
                      <div className="space-y-1 max-h-72 overflow-y-auto">
                        {/* Direct Address Entry (when valid EVM address) */}
                        {queryIsAddress && !queryIsOwnAddress && !queryMatchesDirectoryProfile && (
                          <button
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              selectFreelancer(searchQuery.trim());
                              setSearchQuery('');
                              setSearchFocused(false);
                            }}
                            className="w-full text-left p-2.5 rounded-lg hover:bg-blue-600/15 border border-blue-500/20 bg-blue-950/20 flex items-center justify-between gap-3 transition-colors"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-8 h-8 rounded-full bg-blue-600/30 border border-blue-500/40 flex items-center justify-center text-blue-400 shrink-0">
                                <Wallet size={14} />
                              </div>
                              <div className="min-w-0">
                                <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                                  <span>Use direct address</span>
                                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">
                                    Unregistered
                                  </span>
                                </div>
                                <div className="text-[11px] font-mono text-blue-300 truncate">
                                  {searchQuery.trim()}
                                </div>
                              </div>
                            </div>
                            <span className="text-xs text-blue-400 shrink-0 font-medium">Select →</span>
                          </button>
                        )}

                        {/* Own Wallet Guard */}
                        {queryIsOwnAddress && (
                          <div className="p-3 text-center text-xs text-amber-400 bg-amber-950/20 border border-amber-500/30 rounded-lg">
                            Cannot create a deal proposal with your own wallet address.
                          </div>
                        )}

                        {/* Directory Matches */}
                        {searchResults.map((p: any) => {
                          const w = String(p.wallet).toLowerCase();
                          const idInfo = sellerIdentities[w];
                          const displayName = namesMap[w] || p.name || 'Freelancer';
                          const handle = idInfo?.displayHandle || (p.name ? `@${p.name.toLowerCase().replace(/\s+/g, '')}` : null);
                          const dealsDone = completedCountsMap[w] ?? Number(p.completedDeals || 0);

                          return (
                            <button
                              key={p.wallet}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                selectFreelancer(p.wallet);
                                setSearchQuery('');
                                setSearchFocused(false);
                              }}
                              className="w-full text-left p-2.5 rounded-lg hover:bg-zinc-800/70 border border-transparent hover:border-zinc-700/60 flex items-center justify-between gap-3 transition-colors"
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <FreelancerAvatar
                                  avatar={avatarsMap[w]}
                                  name={displayName}
                                  handle={handle}
                                  wallet={p.wallet}
                                  size="md"
                                />
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-white truncate flex items-center gap-1.5">
                                    <span>{displayName}</span>
                                    {handle && (
                                      <span className="text-xs font-mono text-blue-400 font-normal">
                                        {handle}
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-xs text-zinc-400 truncate">
                                    {p.category && <span className="text-zinc-300 mr-1.5">{p.category}</span>}
                                    {(p.skills || []).slice(0, 3).join(', ')}
                                  </div>
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                {(() => {
                                  const itemPricing = formatPublicPricing(pricingMap[w]);
                                  if (itemPricing) {
                                    return (
                                      <div className="text-xs font-semibold text-white">
                                        {itemPricing.amountDisplay} <span className="text-[10px] text-zinc-400 font-normal">USDC / {pricingMap[w]?.rateType === 'PER_HOUR' ? 'hour' : 'project'}</span>
                                      </div>
                                    );
                                  }
                                  return <div className="text-[11px] text-zinc-500">Rate not set</div>;
                                })()}
                                <div className="text-[10px] text-zinc-500">
                                  {dealsDone} deal{dealsDone === 1 ? '' : 's'}
                                </div>
                              </div>
                            </button>
                          );
                        })}

                        {/* No Results Fallback */}
                        {searchResults.length === 0 && !queryIsAddress && (
                          <div className="p-4 text-center text-xs text-zinc-500">
                            No registered freelancers found matching &quot;{searchQuery}&quot;
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );

      case 2:
        return (
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-white">
              Describe the overall deliverables scope of the engagement.
            </h3>

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
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-white">What&apos;s your budget?</h3>

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
                    if (form.paymentStructure && form.paymentStructure !== 'custom') {
                      applyPaymentStructure(form.paymentStructure, val);
                    }
                  }}
                  placeholder="0.00"
                  className="w-full pl-4 pr-18 font-mono text-base bg-zinc-900/60 border-zinc-700/60 text-white placeholder:text-zinc-500 focus:border-blue-500/60 rounded-xl h-14"
                  type="number"
                  min="0"
                  step="0.01"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400 text-xs font-semibold uppercase pointer-events-none">
                  USDC
                </span>
              </div>
            </div>
          </div>
        );

      case 4: {
        const today = new Date().toISOString().slice(0, 10);
        return (
          <div className="space-y-5">
            <h3 className="text-base font-semibold text-white">When do you need the job done?</h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label htmlFor="deal-deadline-date" className="text-xs text-zinc-400 font-medium block">
                  TARGET COMPLETION DATE
                </label>
                <Input
                  ref={dateInputRef}
                  id="deal-deadline-date"
                  type="date"
                  min={today}
                  value={deadlineDate}
                  onClick={openDatePicker}
                  onChange={(e) => {
                    handleDeadlineDateChange(e.target.value);
                    setSelectedDeadlinePreset(null);
                  }}
                  className="w-full font-mono text-sm bg-zinc-900/60 border-zinc-700/60 text-white focus:border-blue-500/60 rounded-xl h-11 [color-scheme:dark] cursor-pointer [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:scale-125 [&::-webkit-calendar-picker-indicator]:opacity-90 hover:[&::-webkit-calendar-picker-indicator]:opacity-100"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="deal-deadline-time" className="text-xs text-zinc-400 font-medium block">
                  TARGET TIME
                </label>
                <Input
                  ref={timeInputRef}
                  id="deal-deadline-time"
                  type="time"
                  value={deadlineTime}
                  onClick={openTimePicker}
                  onChange={(e) => {
                    handleDeadlineTimeChange(e.target.value);
                    setSelectedDeadlinePreset(null);
                  }}
                  className="w-full font-mono text-sm bg-zinc-900/60 border-zinc-700/60 text-white focus:border-blue-500/60 rounded-xl h-11 [color-scheme:dark] cursor-pointer [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:scale-125 [&::-webkit-calendar-picker-indicator]:opacity-90 hover:[&::-webkit-calendar-picker-indicator]:opacity-100"
                />
              </div>
            </div>

            {/* QUICK PRESET DEADLINE CARDS */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block">
                Quick Presets
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {[
                  { days: 3, label: '3 days' },
                  { days: 5, label: '5 days' },
                  { days: 10, label: '10 days' },
                  { days: 30, label: '30 days' },
                ].map((preset) => {
                  const isSelected = selectedDeadlinePreset === preset.days;
                  return (
                    <button
                      key={preset.days}
                      type="button"
                      onClick={() => applyDeadlinePreset(preset.days)}
                      className={cn(
                        'px-3 py-2 rounded-lg border text-center transition-all text-xs font-medium',
                        isSelected
                          ? 'border-blue-500/60 bg-blue-600/20 text-blue-300 shadow-sm'
                          : 'border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800/40'
                      )}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {formattedLocalDelivery && (
              <div className="p-3.5 rounded-xl border border-zinc-800 bg-zinc-900/40 text-xs text-zinc-400 flex items-center justify-between">
                <span>Target Delivery:</span>
                <span className="font-mono text-zinc-100 text-sm font-semibold">
                  {formattedLocalDelivery}
                </span>
              </div>
            )}
          </div>
        );
      }

      case 5:
        return (
          <div className="space-y-6">
            {/* CARD 1 — PAYMENT STRUCTURE */}
            <div className="p-5 sm:p-6 rounded-2xl bg-zinc-900/80 border border-zinc-800/80 shadow-md space-y-4">
              <h3 className="text-base font-semibold text-white">
                Choose how funds should be released across milestones.
              </h3>

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
                      setPaymentStructureSelected(true);
                      update('paymentStructure', opt.value);
                      applyPaymentStructure(opt.value as any, form.budget);
                      setExpandedMilestoneIndex(0);
                    }}
                    className={cn(
                      'p-3.5 rounded-xl border text-left transition-all',
                      paymentStructureSelected && form.paymentStructure === opt.value
                        ? 'border-blue-500/50 bg-blue-600/10 shadow-sm'
                        : 'border-zinc-700/50 bg-zinc-800/30 hover:border-zinc-600'
                    )}
                  >
                    <div className="text-sm font-semibold text-white">{opt.label}</div>
                    <div className="text-xs text-zinc-400 mt-0.5">{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* CARD 2 — MILESTONES (Rendered ONLY after explicit selection) */}
            {paymentStructureSelected && form.paymentStructure && milestones.length > 0 && (
              <div className="p-5 sm:p-6 rounded-2xl bg-zinc-900/80 border border-zinc-800/80 shadow-md space-y-4">
                {/* Milestone Card Header */}
                <div>
                  <h4 className="text-sm font-semibold text-white">Milestone Breakdown</h4>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Total Escrow: <span className="font-semibold text-blue-400 font-mono">{formattedTotalEscrow} USDC</span> across {milestones.length} milestone{milestones.length === 1 ? '' : 's'}.
                  </p>
                </div>

                {/* Collapsible Accordion List */}
                <div className="space-y-3">
                  {milestones.map((m, idx) => {
                    const isExpanded = expandedMilestoneIndex === idx;
                    const displayTitle = getMilestoneDisplayTitle(m.title, idx);

                    return (
                      <div
                        key={idx}
                        className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden transition-colors"
                      >
                        {/* Collapsed Header Bar */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => setExpandedMilestoneIndex(isExpanded ? null : idx)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setExpandedMilestoneIndex(isExpanded ? null : idx);
                            }
                          }}
                          className="w-full flex items-center justify-between p-3.5 hover:bg-zinc-800/40 cursor-pointer select-none transition-colors"
                        >
                          <span className="text-xs font-semibold text-zinc-200 truncate pr-2">
                            {displayTitle}
                          </span>
                          <div className="flex items-center gap-2 shrink-0">
                            {form.paymentStructure === 'custom' && milestones.length > 1 && (
                              <button
                                type="button"
                                aria-label={`Remove Milestone ${idx + 1}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeMilestone(idx);
                                }}
                                className="text-zinc-500 hover:text-red-400 transition-colors p-1"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                            <div className="text-zinc-400">
                              {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            </div>
                          </div>
                        </div>

                        {/* Expanded State Body */}
                        {isExpanded && (
                          <div className="p-4 pt-2 border-t border-zinc-800/70 space-y-3">
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
                                  placeholder="0.00"
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
                                className="w-full h-18 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 resize-none font-sans"
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
                        )}
                      </div>
                    );
                  })}

                  {/* Add Milestone Bar for Custom Stages */}
                  {form.paymentStructure === 'custom' && milestones.length < 10 && (
                    <button
                      type="button"
                      onClick={addMilestone}
                      className="w-full flex items-center justify-center gap-2 p-3 rounded-xl border border-dashed border-zinc-700/80 bg-zinc-900/30 hover:border-zinc-500 hover:bg-zinc-800/40 text-xs font-medium text-zinc-300 transition-all cursor-pointer"
                    >
                      <Plus size={15} className="text-blue-400" />
                      <span>Add Milestone</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );

      case 6:
        return (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-semibold text-white mb-0.5">Adaptive Protection</h3>
              <p className="text-xs text-zinc-400">Choose the protection level for this deal proposal.</p>
            </div>

            <div className="space-y-2.5">
              <button
                type="button"
                className="w-full p-4 rounded-xl border border-blue-500/50 bg-blue-600/10 text-left shadow-sm"
              >
                <div className="text-sm font-semibold text-white">No Protection (Standard V2 Escrow)</div>
                <div className="text-xs text-zinc-400 mt-0.5">Proceed with non-custodial smart contract escrow and dispute resolution</div>
              </button>

              <button
                type="button"
                disabled
                aria-disabled="true"
                tabIndex={-1}
                className="w-full p-4 rounded-xl border border-zinc-800/60 bg-zinc-900/30 opacity-60 cursor-not-allowed text-left select-none"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-zinc-300">Adaptive Protection</div>
                    <div className="text-xs text-zinc-500 mt-0.5">Pool-backed coverage is currently in development</div>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700/50 uppercase tracking-wider">
                    Coming Soon
                  </span>
                </div>
              </button>
            </div>
          </div>
        );

      case 7:
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
    <div
      className={cn(
        'space-y-6 pt-0 transition-all duration-300',
        !aiPanelExpanded || step < 1 || step >= 7
          ? 'pb-36'
          : step === 1
          ? 'pb-40 lg:pb-[460px]'
          : 'pb-36 sm:pb-40'
      )}
    >
      {/* PAGE HEADER */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className={`${pressStart2P.className} text-xl md:text-2xl font-normal text-white tracking-tight`}>
          Create a Deal Proposal
        </h1>
      </div>

      <ChainGuard what="Standard V2 proposals are" />

      {/* MAIN CONTAINER */}
      <div className="max-w-5xl mx-auto space-y-8">
        <div className={cn('grid grid-cols-1 lg:grid-cols-12 gap-6', (step === 0 || step === 1) ? 'lg:items-center items-start' : 'items-start lg:items-start')}>
          {/* WIZARD COLUMN */}
          <div className={cn('lg:col-span-8 space-y-6', (step === 0 || step === 1) ? '' : 'lg:self-start')}>
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

                    {error && step < 7 && (
                      <div className="mt-4 p-3 rounded-lg bg-red-600/10 border border-red-500/20 text-sm text-red-400">
                        {error}
                      </div>
                    )}

                    {step < 7 && (
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

            {/* AI FREELANCER MATCHES (Persistent across Steps 2 through 7) */}
            {step >= 1 && step < 7 && (
              <AIFreelancerMatches
                draftContext={aiDraftContext}
                availableProfiles={availableProfiles}
                avatarsMap={avatarsMap}
                namesMap={namesMap}
                sellerIdentities={sellerIdentities}
                completedCountsMap={completedCountsMap}
                reviewCountsMap={reviewCountsMap}
                pricingMap={pricingMap}
                clientAddress={address}
                isExpanded={aiPanelExpanded}
                onToggleExpand={() => setAiPanelExpanded((prev) => !prev)}
                onSelectFreelancer={(wallet) => {
                  selectFreelancer(wallet);
                }}
                selectedWallet={form.counterparty}
                anchoredGrowth={step === 1}
              />
            )}
          </div>

          {/* SIDEBAR PREVIEW (Steps 1-7, progressively populated) */}
          <div className={cn('lg:col-span-4 relative z-10', (step === 0 || step === 1) ? '' : 'lg:self-start')}>
            <DealReceipt
              variant="compact"
              title={form.type.trim() || undefined}
              client={{
                wallet: address,
                name: address ? namesMap[address.toLowerCase()] || undefined : undefined,
                handle: clientIdentity.handle,
                displayHandle: clientIdentity.displayHandle,
                avatar: address ? avatarsMap[address.toLowerCase()] || null : null,
              }}
              freelancer={
                step >= 1 &&
                form.counterparty &&
                isAddress(form.counterparty) &&
                form.counterparty.toLowerCase() !== ZERO_ADDRESS.toLowerCase() &&
                (!address || form.counterparty.toLowerCase() !== address.toLowerCase())
                  ? {
                      wallet: form.counterparty,
                      name:
                        selectedFreelancerProfile?.name ||
                        namesMap[form.counterparty.toLowerCase()] ||
                        undefined,
                      handle: freelancerIdentity.handle,
                      displayHandle: freelancerIdentity.displayHandle,
                      avatar: avatarsMap[form.counterparty.toLowerCase()] || null,
                    }
                  : undefined
              }
              scope={step >= 2 && form.deliverables.trim() ? form.deliverables.trim() : undefined}
              budget={
                step >= 3 && form.budget.trim() && !isNaN(Number(form.budget)) && Number(form.budget) > 0
                  ? form.budget.trim()
                  : undefined
              }
              asset={{ symbol: 'USDC', isErc20: true }}
              deadline={
                step >= 4 &&
                deadlineDate?.trim() &&
                deadlineTime?.trim() &&
                !isNaN(new Date(`${deadlineDate.trim()}T${deadlineTime.trim()}`).getTime()) &&
                Math.floor(new Date(`${deadlineDate.trim()}T${deadlineTime.trim()}`).getTime() / 1000) > Math.floor(Date.now() / 1000)
                  ? `${deadlineDate.trim()}T${deadlineTime.trim()}`
                  : undefined
              }
              paymentStructure={step >= 5 && paymentStructureSelected && form.paymentStructure ? form.paymentStructure : undefined}
              protectionEnabled={step >= 6 ? false : undefined}
            />
          </div>
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
