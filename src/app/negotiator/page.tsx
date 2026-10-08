'use client';

import { useState, useEffect, useRef, useCallback, useMemo, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter, useSearchParams } from 'next/navigation';
import { Press_Start_2P } from 'next/font/google';
import { Check, X, Loader2, Send, Plus, MessageSquare, Trash2, Search, Shield, TrendingUp, History, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAccount } from 'wagmi';
import { useFactoryContract } from '@/hooks/useFactoryContract';
import { ChainGuard } from '@/components/shared/ChainGuard';
import { cn } from '@/lib/utils';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useSynqIdentity, useSynqIdentities } from '@/hooks/useSynqIdentity';
import { useBatchFreelancerCompletedDeals } from '@/hooks/useFreelancerStats';
import { reconstructAuthoritativeNegotiationState } from '@/lib/ai-negotiator-engine';
import { DraftPanel } from '@/components/negotiator/DraftPanel';
import { FreelancerSearchMessage } from '@/components/negotiator/FreelancerSearchMessage';
import * as Popover from '@radix-ui/react-popover';
import type {
  AiNegotiatorAttachment,
  NegotiationStateData,
  PendingClarificationPayload,
  ResolvedActionPayload,
} from '@/db/schema';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

interface Message {
  id: string;
  role: 'user' | 'ai' | 'system';
  content: string;
  timestamp: string;
  suggestions?: Suggestion[];
  sellers?: SellerResult[];
  attachment?: AiNegotiatorAttachment;
  negotiationState?: NegotiationStateData;
  pendingClarification?: PendingClarificationPayload | null;
  resolvedActions?: ResolvedActionPayload[];
}

interface Suggestion {
  label: string;
  amount: number;
  timeline: string;
  risk: string;
  description: string;
}

interface SellerResult {
  wallet: string;
  name: string;
  category: string;
  skills: string[];
  rate: string;
  bio: string;
  available: boolean;
  match: number;
}

interface DbConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const STARTER_PROMPTS = [
  {
    title: 'Find a Freelancer',
    description: 'Help me find the right freelancer for my project',
    prompt: "I'm looking for a freelancer for my project",
    icon: Search,
  },
  {
    title: 'Understand Escrow',
    description: 'Learn how Synq escrow protects a deal',
    prompt: 'How does Synq escrow work?',
    icon: Shield,
  },
  {
    title: 'Check Market Rates',
    description: 'Get guidance on reasonable freelancer rates',
    prompt: "What's a reasonable rate for a developer?",
    icon: TrendingUp,
  },
];

const SynqAvatar = ({ className = "w-8 h-8 p-1.5" }: { className?: string }) => (
  <div className={cn("rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shrink-0 shadow-sm mt-0.5", className)}>
    <img
      src="/synq-logo.png"
      alt="Synq logo"
      className="w-full h-full object-contain mix-blend-lighten"
    />
  </div>
);

const INITIAL_AI: Message = {
  id: 'init',
  role: 'ai',
  content: "Tell me what you need, your budget and timeline. I will help you find a deal that works for both sides.",
  timestamp: new Date().toISOString(),
};

const freshInitialMessage = (): Message => ({ ...INITIAL_AI, timestamp: new Date().toISOString() });

const formatChatDate = (timestamp: number) => {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const ACTIVE_CONV_KEY_PREFIX = 'synq:negotiator:active:';
const NEW_CHAT_SENTINEL = '__new__';

const getStoredActiveConvId = (wallet: string | null): string | null => {
  if (!wallet || typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(`${ACTIVE_CONV_KEY_PREFIX}${wallet.toLowerCase()}`) || null;
  } catch {
    return null;
  }
};

const setStoredActiveConvId = (wallet: string | null, convId: string | null): void => {
  if (!wallet || typeof window === 'undefined') return;
  try {
    const key = `${ACTIVE_CONV_KEY_PREFIX}${wallet.toLowerCase()}`;
    if (convId) {
      localStorage.setItem(key, convId);
    } else {
      localStorage.removeItem(key);
    }
  } catch {}
};

function NegotiatorContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mounted, setMounted] = useState(false);
  const { address, isConnected, status } = useAccount();
  const factory = useFactoryContract();
  const { ensureAuthenticated } = useAuthSession();

  useEffect(() => {
    setMounted(true);
  }, []);

  // Smooth emergence from #242424 charcoal when arriving from landing Enter transition (B.11.5 Part C / B.11.6 Fix)
  const [emergingFromLanding, setEmergingFromLanding] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      const flag = sessionStorage.getItem('synq_enter_transition');
      if (flag === '1') {
        sessionStorage.removeItem('synq_enter_transition');
        const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        return !prefersReduced;
      }
    } catch {}
    return false;
  });

  // Strict-mode safe auto-unmount fallback for the emergence overlay
  useEffect(() => {
    if (!emergingFromLanding) return;
    const timer = setTimeout(() => {
      setEmergingFromLanding(false);
    }, 450);
    return () => clearTimeout(timer);
  }, [emergingFromLanding]);

  const isAccountRestoring = status === 'connecting' || status === 'reconnecting';
  const effectiveAddress = (mounted && isConnected && !!address && !isAccountRestoring) ? address : undefined;

  const [messages, setMessages] = useState<Message[]>([INITIAL_AI]);
  const [conversations, setConversations] = useState<DbConversationMeta[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [chatCount, setChatCount] = useState(0);
  const [chatLimit, setChatLimit] = useState(10);
  const [limitReached, setLimitReached] = useState(false);

  const [historyLoading, setHistoryLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [mobileDraftOpen, setMobileDraftOpen] = useState(false);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState('');
  const [retryableConvId, setRetryableConvId] = useState<string | null>(null);

  const [draftState, setDraftState] = useState<NegotiationStateData | null>(null);
  const [draftPanelOpen, setDraftPanelOpen] = useState(false);
  const [draftPanelPinned, setDraftPanelPinned] = useState(false);
  const draftHoverTimerRef = useRef<NodeJS.Timeout | null>(null);
  const draftContainerRef = useRef<HTMLDivElement | null>(null);

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [avatarsMap, setAvatarsMap] = useState<Record<string, string>>({});
  const [namesMap, setNamesMap] = useState<Record<string, string>>({});
  const [reviewCountsMap, setReviewCountsMap] = useState<Record<string, number>>({});

  const clientIdentity = useSynqIdentity(effectiveAddress);
  const greetingIdentity = effectiveAddress
    ? namesMap[effectiveAddress.toLowerCase()] || clientIdentity.displayHandle || clientIdentity.shortWallet
    : '';
  const isEmptyChat =
    !messagesLoading &&
    !isThinking &&
    !activeConversationId &&
    messages.length === 1 &&
    messages[0]?.id === 'init';

  // Extract seller wallets from messages and active draft for identity enrichment & stats
  const sellerWallets = useMemo(() => {
    const wallets = new Set<string>();
    for (const msg of messages) {
      if (msg.sellers) {
        for (const s of msg.sellers) {
          if (s.wallet) wallets.add(String(s.wallet).toLowerCase());
        }
      }
      if (msg.attachment?.dealDraft?.seller?.value) {
        wallets.add(String(msg.attachment.dealDraft.seller.value).toLowerCase());
      }
    }
    if (draftState?.seller?.value) {
      wallets.add(String(draftState.seller.value).toLowerCase());
    }
    if (effectiveAddress) {
      wallets.add(effectiveAddress.toLowerCase());
    }
    return Array.from(wallets);
  }, [messages, effectiveAddress, draftState?.seller?.value]);

  const { completedCountsMap } = useBatchFreelancerCompletedDeals(sellerWallets);
  const { identitiesMap } = useSynqIdentities(sellerWallets);

  const uniqueWalletsKey = useMemo(() => {
    return [...sellerWallets].sort().join(',');
  }, [sellerWallets]);

  // Batch fetch public avatars and names
  useEffect(() => {
    if (!uniqueWalletsKey) return;
    const uniqueWallets = uniqueWalletsKey.split(',');
    let cancelled = false;

    fetch('/api/profile/public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallets: uniqueWallets }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data?.profiles)) return;
        const avatarMap: Record<string, string> = {};
        const nameMap: Record<string, string> = {};
        for (const item of data.profiles) {
          if (item?.wallet) {
            const key = String(item.wallet).toLowerCase();
            if (item.avatar) avatarMap[key] = item.avatar;
            if (item.name) nameMap[key] = item.name;
          }
        }
        setAvatarsMap((prev) => ({ ...prev, ...avatarMap }));
        setNamesMap((prev) => ({ ...prev, ...nameMap }));
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [uniqueWalletsKey]);

  // Batch fetch review counts
  useEffect(() => {
    if (!uniqueWalletsKey) return;
    let cancelled = false;

    fetch(`/api/reviews?sellers=${uniqueWalletsKey}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.counts) return;
        setReviewCountsMap((prev) => ({ ...prev, ...data.counts }));
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [uniqueWalletsKey]);

  // Reactive state reconstruction for active conversation draft
  useEffect(() => {
    let active = true;
    reconstructAuthoritativeNegotiationState(messages).then((st) => {
      if (active) {
        setDraftState(st);
      }
    });
    return () => { active = false; };
  }, [messages]);

  const handleDraftMouseEnter = () => {
    if (draftHoverTimerRef.current) {
      clearTimeout(draftHoverTimerRef.current);
      draftHoverTimerRef.current = null;
    }
    setDraftPanelOpen(true);
  };

  const handleDraftMouseLeave = () => {
    if (draftPanelPinned) return;
    draftHoverTimerRef.current = setTimeout(() => {
      setDraftPanelOpen(false);
    }, 200);
  };

  const handleDraftClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (draftPanelPinned) {
      setDraftPanelPinned(false);
      setDraftPanelOpen(false);
    } else {
      setDraftPanelPinned(true);
      setDraftPanelOpen(true);
    }
  };

  const handleDraftEdit = useCallback(() => {
    if (!activeConversationId || draftState?.draftStatus !== 'ACTIVE') return;
    const isComplete = draftState.isReadyToCreate === true;
    if (isComplete) {
      router.push(`/deal/new?negotiatorConversationId=${encodeURIComponent(activeConversationId)}`);
    } else {
      router.push(`/deal/new?negotiatorConversationId=${encodeURIComponent(activeConversationId)}&negotiatorMode=edit`);
    }
  }, [activeConversationId, draftState, router]);

  const handleDraftProceed = useCallback(() => {
    if (!activeConversationId || draftState?.draftStatus !== 'ACTIVE') return;
    router.push(`/deal/new?negotiatorConversationId=${encodeURIComponent(activeConversationId)}`);
  }, [activeConversationId, draftState, router]);

  const clientIdentityObj = useMemo(() => {
    if (!address) return undefined;
    const key = address.toLowerCase();
    const identity = identitiesMap[key];
    return {
      wallet: address,
      name: namesMap[key],
      handle: identity?.handle,
      displayHandle: identity?.displayHandle,
      avatar: avatarsMap[key],
    };
  }, [address, identitiesMap, namesMap, avatarsMap]);

  const freelancerIdentityObj = useMemo(() => {
    const sellerWallet = draftState?.seller?.value;
    if (!sellerWallet) return undefined;
    const key = sellerWallet.toLowerCase();
    const identity = identitiesMap[key];
    const profileName = namesMap[key];
    const draftName = draftState?.sellerName && !draftState.sellerName.startsWith('@') ? draftState.sellerName : undefined;
    return {
      wallet: sellerWallet,
      name: profileName || draftName,
      handle: identity?.handle,
      displayHandle: identity?.displayHandle,
      avatar: avatarsMap[key],
    };
  }, [draftState, identitiesMap, namesMap, avatarsMap]);

  const [pendingSellerWallet, setPendingSellerWallet] = useState('');
  const [pendingDeal, setPendingDeal] = useState<{ title: string; amount: string }>({ title: 'Negotiated Deal', amount: '' });

  // In-memory concurrency and wallet privacy refs
  const currentWalletRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef<number>(0);
  const activeConversationIdRef = useRef<string | null>(null);
  const deletedConvIdsRef = useRef<Set<string>>(new Set());

  const notifiedRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const skipSmoothScrollRef = useRef(false);

  const accepted = factory.txReceipt.isSuccess;

  const showToast = (msg: string) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 3000);
  };

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    const scrollHeight = textareaRef.current.scrollHeight;
    textareaRef.current.style.height = `${Math.min(scrollHeight, 140)}px`;
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const loadConversationDetail = async (
    convId: string,
    token: string,
    reqWallet: string,
    reqGen: number
  ) => {
    skipSmoothScrollRef.current = true;
    setMessagesLoading(true);
    try {
      const res = await fetch(`/api/negotiator/conversations/${convId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (
        currentWalletRef.current !== reqWallet ||
        sessionGenerationRef.current !== reqGen ||
        activeConversationIdRef.current !== convId ||
        deletedConvIdsRef.current.has(convId)
      ) {
        return;
      }

      if (!res.ok) {
        setMessages([freshInitialMessage()]);
        return;
      }

      const data = await res.json();
      if (
        currentWalletRef.current !== reqWallet ||
        sessionGenerationRef.current !== reqGen ||
        activeConversationIdRef.current !== convId ||
        deletedConvIdsRef.current.has(convId)
      ) {
        return;
      }

      const msgs: Message[] = (data.messages || []).map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: typeof m.createdAt === 'string' ? m.createdAt : new Date(m.createdAt).toISOString(),
        suggestions: m.suggestions,
        sellers: m.sellers,
        attachment: m.attachment,
        negotiationState: m.negotiationState,
        pendingClarification: m.pendingClarification !== undefined ? m.pendingClarification : (m.payload?.pendingClarification ?? null),
        resolvedActions: m.resolvedActions || m.payload?.resolvedActions || undefined,
      }));

      setMessages(msgs.length > 0 ? msgs : [freshInitialMessage()]);
    } catch {
      if (
        currentWalletRef.current === reqWallet &&
        sessionGenerationRef.current === reqGen &&
        activeConversationIdRef.current === convId &&
        !deletedConvIdsRef.current.has(convId)
      ) {
        setMessages([freshInitialMessage()]);
      }
    } finally {
      if (
        currentWalletRef.current === reqWallet &&
        sessionGenerationRef.current === reqGen &&
        activeConversationIdRef.current === convId
      ) {
        setMessagesLoading(false);
      }
    }
  };

  const loadHistory = useCallback(
    async (reqWallet: string, reqGen: number, isForcedNewChat?: boolean) => {
      setHistoryLoading(true);
      try {
        const token = await ensureAuthenticated();
        if (currentWalletRef.current !== reqWallet || sessionGenerationRef.current !== reqGen) return;

        const res = await fetch('/api/negotiator/conversations', {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (currentWalletRef.current !== reqWallet || sessionGenerationRef.current !== reqGen) return;

        if (!res.ok) {
          setHistoryLoading(false);
          return;
        }

        const data = await res.json();
        if (currentWalletRef.current !== reqWallet || sessionGenerationRef.current !== reqGen) return;

        const list: DbConversationMeta[] = data.conversations || [];
        setConversations(list);
        const count = data.count ?? list.length;
        const limit = data.limit ?? 10;
        setChatCount(count);
        setChatLimit(limit);
        const isLimitReached = count >= limit;
        setLimitReached(isLimitReached);

        const storedPosition = getStoredActiveConvId(reqWallet);
        const isStoredNewChat = storedPosition === NEW_CHAT_SENTINEL;
        const hasStoredConv =
          !!storedPosition &&
          storedPosition !== NEW_CHAT_SENTINEL &&
          list.some((c) => c.id === storedPosition);

        if (isForcedNewChat || isStoredNewChat) {
          activeConversationIdRef.current = null;
          setActiveConversationId(null);
          setMessages([freshInitialMessage()]);
          setDraftState(null);
          setStoredActiveConvId(reqWallet, NEW_CHAT_SENTINEL);
        } else if (hasStoredConv && storedPosition) {
          activeConversationIdRef.current = storedPosition;
          setActiveConversationId(storedPosition);
          await loadConversationDetail(storedPosition, token, reqWallet, reqGen);
        } else if (list.length > 0) {
          const newestId = list[0].id;
          activeConversationIdRef.current = newestId;
          setActiveConversationId(newestId);
          setStoredActiveConvId(reqWallet, newestId);
          await loadConversationDetail(newestId, token, reqWallet, reqGen);
        } else {
          activeConversationIdRef.current = null;
          setActiveConversationId(null);
          setMessages([freshInitialMessage()]);
          setDraftState(null);
          setStoredActiveConvId(reqWallet, NEW_CHAT_SENTINEL);
        }
      } catch (err: any) {
        if (
          err?.message?.includes('Wallet not connected') ||
          err?.message?.includes('cancelled by user') ||
          err?.message?.includes('User rejected')
        ) {
          return;
        }
        console.error('Failed to load chat history:', err);
      } finally {
        if (currentWalletRef.current === reqWallet && sessionGenerationRef.current === reqGen) {
          setHistoryLoading(false);
        }
      }
    },
    [ensureAuthenticated]
  );

  useEffect(() => {
    if (!mounted || isAccountRestoring) return;

    sessionGenerationRef.current += 1;
    const nextWallet = (isConnected && address) ? address.toLowerCase() : null;
    currentWalletRef.current = nextWallet;
    activeConversationIdRef.current = null;
    deletedConvIdsRef.current.clear();

    setConversations([]);
    setActiveConversationId(null);
    setMessages([freshInitialMessage()]);
    setChatCount(0);
    setLimitReached(false);
    setError('');
    setRetryableConvId(null);

    const isForcedNew = searchParams?.get('new') === '1' || searchParams?.get('new') === 'true';
    if (isForcedNew) {
      if (nextWallet) {
        setStoredActiveConvId(nextWallet, NEW_CHAT_SENTINEL);
      }
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', '/negotiator');
      }
    }

    if (nextWallet) {
      loadHistory(nextWallet, sessionGenerationRef.current, isForcedNew);
    }
  }, [mounted, isAccountRestoring, isConnected, address, searchParams, loadHistory]);

  useEffect(() => {
    if (!messagesEndRef.current) return;
    if (skipSmoothScrollRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'auto', block: 'end' });
      skipSmoothScrollRef.current = false;
    } else {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages, isThinking]);

  const startNewChat = () => {
    if (isThinking) return;

    if (!address) {
      showToast('Connect your wallet to start negotiating.');
      return;
    }

    setStoredActiveConvId(currentWalletRef.current, NEW_CHAT_SENTINEL);

    skipSmoothScrollRef.current = true;
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    setMessages([freshInitialMessage()]);
    setDraftState(null);
    setInput('');
    setIsThinking(false);
    setError('');
    setRetryableConvId(null);
    setMobileHistoryOpen(false);
  };

  const selectChat = async (conv: DbConversationMeta) => {
    if (activeConversationIdRef.current === conv.id || isThinking) return;
    const reqWallet = currentWalletRef.current;
    const reqGen = sessionGenerationRef.current;
    if (!reqWallet) return;

    skipSmoothScrollRef.current = true;
    activeConversationIdRef.current = conv.id;
    setActiveConversationId(conv.id);
    setStoredActiveConvId(reqWallet, conv.id);
    setError('');
    setRetryableConvId(null);
    setMobileHistoryOpen(false);

    try {
      const token = await ensureAuthenticated();
      if (currentWalletRef.current !== reqWallet || sessionGenerationRef.current !== reqGen) return;
      await loadConversationDetail(conv.id, token, reqWallet, reqGen);
    } catch (err: any) {
      if (currentWalletRef.current === reqWallet && sessionGenerationRef.current === reqGen) {
        setError(err?.message || 'Failed to load conversation');
      }
    }
  };

  const deleteChat = async (convId: string) => {
    const reqWallet = currentWalletRef.current;
    const reqGen = sessionGenerationRef.current;
    if (!reqWallet) return;

    deletedConvIdsRef.current.add(convId);

    try {
      const token = await ensureAuthenticated();
      if (currentWalletRef.current !== reqWallet || sessionGenerationRef.current !== reqGen) return;

      const res = await fetch(`/api/negotiator/conversations/${convId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (currentWalletRef.current !== reqWallet || sessionGenerationRef.current !== reqGen) return;

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to delete conversation');
        return;
      }

      const remaining = conversations.filter((c) => c.id !== convId);
      setConversations(remaining);
      const newCount = Math.max(0, chatCount - 1);
      setChatCount(newCount);
      setLimitReached(newCount >= chatLimit);

      if (activeConversationIdRef.current === convId) {
        if (remaining.length > 0) {
          const fallbackId = remaining[0].id;
          activeConversationIdRef.current = fallbackId;
          setActiveConversationId(fallbackId);
          setStoredActiveConvId(reqWallet, fallbackId);
          await loadConversationDetail(fallbackId, token, reqWallet, reqGen);
        } else {
          activeConversationIdRef.current = null;
          setActiveConversationId(null);
          setMessages([freshInitialMessage()]);
          setDraftState(null);
          setStoredActiveConvId(reqWallet, NEW_CHAT_SENTINEL);
        }
      }
    } catch (err: any) {
      if (currentWalletRef.current === reqWallet && sessionGenerationRef.current === reqGen) {
        setError(err?.message || 'Failed to delete conversation');
      }
    }
  };

  useEffect(() => {
    if (accepted && !notifiedRef.current) {
      notifiedRef.current = true;
      void ensureAuthenticated()
        .then((token) => fetch('/api/notify', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            event: 'deal_confirmed',
            recipientWallet: pendingSellerWallet,
            recipientName: 'seller',
            dealTitle: pendingDeal.title,
            dealAmount: pendingDeal.amount,
          }),
        }))
        .catch(() => {});
    }
  }, [accepted, pendingSellerWallet, pendingDeal, ensureAuthenticated]);

  const requestAiResponse = async (
    convId: string,
    token: string,
    reqWallet: string,
    reqGen: number
  ) => {
    setIsThinking(true);
    setError('');

    try {
      const respondRes = await fetch(`/api/negotiator/conversations/${convId}/respond`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (
        currentWalletRef.current !== reqWallet ||
        sessionGenerationRef.current !== reqGen ||
        activeConversationIdRef.current !== convId ||
        deletedConvIdsRef.current.has(convId)
      ) {
        return;
      }

      const respondData = await respondRes.json();

      if (
        currentWalletRef.current !== reqWallet ||
        sessionGenerationRef.current !== reqGen ||
        activeConversationIdRef.current !== convId ||
        deletedConvIdsRef.current.has(convId)
      ) {
        return;
      }

      if (!respondRes.ok && respondRes.status !== 200) {
        if (respondData.code === 'CONVERSATION_TAIL_CHANGED') {
          await loadConversationDetail(convId, token, reqWallet, reqGen);
        } else {
          setError('AI response generation failed.');
          setRetryableConvId(convId);
        }
        setIsThinking(false);
        return;
      }

      const aiMsg: Message = {
        id: respondData.id,
        role: respondData.role,
        content: respondData.content,
        timestamp: respondData.createdAt,
        suggestions: respondData.suggestions,
        sellers: respondData.sellers,
        attachment: respondData.attachment,
        negotiationState: respondData.negotiationState,
        pendingClarification: respondData.pendingClarification !== undefined ? respondData.pendingClarification : (respondData.payload?.pendingClarification ?? null),
        resolvedActions: respondData.resolvedActions || respondData.payload?.resolvedActions || undefined,
      };

      setMessages((prev) => {
        if (prev.some((m) => m.id === aiMsg.id)) return prev;
        return [...prev.filter((m) => m.id !== 'init'), aiMsg];
      });

      setConversations((prev) =>
        prev
          .map((c) => (c.id === convId ? { ...c, updatedAt: respondData.createdAt || new Date().toISOString() } : c))
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      );
    } catch {
      if (
        currentWalletRef.current === reqWallet &&
        sessionGenerationRef.current === reqGen &&
        activeConversationIdRef.current === convId &&
        !deletedConvIdsRef.current.has(convId)
      ) {
        setError('AI service unavailable. Retry AI response.');
        setRetryableConvId(convId);
      }
    } finally {
      if (
        currentWalletRef.current === reqWallet &&
        sessionGenerationRef.current === reqGen &&
        activeConversationIdRef.current === convId
      ) {
        setIsThinking(false);
      }
    }
  };

  const handleRetryAi = async () => {
    if (!retryableConvId || isThinking || !address) return;
    const reqWallet = currentWalletRef.current;
    const reqGen = sessionGenerationRef.current;
    if (!reqWallet) return;

    try {
      const token = await ensureAuthenticated();
      if (!token || currentWalletRef.current !== reqWallet || sessionGenerationRef.current !== reqGen) return;

      const convId = retryableConvId;
      setRetryableConvId(null);
      await requestAiResponse(convId, token, reqWallet, reqGen);
    } catch (err: any) {
      if (currentWalletRef.current === reqWallet && sessionGenerationRef.current === reqGen) {
        setError(err?.message || 'Retry failed');
      }
    }
  };

  const handleSend = async (overrideText?: string) => {
    const textToSubmit = typeof overrideText === 'string' ? overrideText : input;
    if (!textToSubmit.trim() || isThinking) return;

    if (!address) {
      showToast('Connect your wallet to start negotiating.');
      return;
    }

    const reqWallet = currentWalletRef.current;
    const reqGen = sessionGenerationRef.current;
    if (!reqWallet) return;

    if (chatCount >= chatLimit && !activeConversationIdRef.current) {
      showToast("You've reached your 10-chat history limit. Delete one conversation to start a new chat.");
      return;
    }

    const userInput = textToSubmit.trim();
    if (typeof overrideText !== 'string') {
      setInput('');
    }

    const tempUserMsgId = `optimistic_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const optimisticUserMsg: Message = {
      id: tempUserMsgId,
      role: 'user',
      content: userInput,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev.filter((m) => m.id !== 'init'), optimisticUserMsg]);
    setIsThinking(true);
    setError('');
    setRetryableConvId(null);

    try {
      const token = await ensureAuthenticated();
      if (!token || currentWalletRef.current !== reqWallet || sessionGenerationRef.current !== reqGen) return;

      let targetConvId = activeConversationIdRef.current;

      if (!targetConvId) {
        const createRes = await fetch('/api/negotiator/conversations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            message: { content: userInput },
          }),
        });

        if (currentWalletRef.current !== reqWallet || sessionGenerationRef.current !== reqGen) return;

        const createData = await createRes.json();
        if (!createRes.ok) {
          if (currentWalletRef.current === reqWallet && sessionGenerationRef.current === reqGen) {
            setMessages((prev) => prev.filter((m) => m.id !== tempUserMsgId && !m.id.startsWith('optimistic_')));
            setInput(userInput);
            if (createData.code === 'NEGOTIATOR_CHAT_LIMIT_REACHED' || createRes.status === 409) {
              setLimitReached(true);
              showToast("You've reached your 10-chat history limit. Delete one conversation to start a new chat.");
            } else {
              setError(createData.error || 'Failed to start conversation');
            }
            setIsThinking(false);
          }
          return;
        }

        targetConvId = createData.id;
        activeConversationIdRef.current = targetConvId;
        setActiveConversationId(targetConvId);
        setStoredActiveConvId(reqWallet, targetConvId);

        const firstMsg: Message = {
          id: createData.messages[0].id,
          role: createData.messages[0].role,
          content: createData.messages[0].content,
          timestamp: createData.messages[0].createdAt,
        };

        setMessages((prev) => {
          const hasReal = prev.some((m) => m.id === firstMsg.id);
          if (hasReal) return prev;
          return prev.map((m) => (m.id === tempUserMsgId || m.id.startsWith('optimistic_') ? firstMsg : m));
        });

        const newMeta: DbConversationMeta = {
          id: createData.id,
          title: createData.title,
          createdAt: createData.createdAt,
          updatedAt: createData.updatedAt,
        };
        setConversations((prev) => [newMeta, ...prev.filter((c) => c.id !== newMeta.id)]);
        const newCount = chatCount + 1;
        setChatCount(newCount);
        setLimitReached(newCount >= chatLimit);
      } else {
        const userMsgRes = await fetch(`/api/negotiator/conversations/${targetConvId}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            content: userInput,
          }),
        });

        if (
          currentWalletRef.current !== reqWallet ||
          sessionGenerationRef.current !== reqGen ||
          activeConversationIdRef.current !== targetConvId ||
          deletedConvIdsRef.current.has(targetConvId)
        ) {
          return;
        }

        const userMsgData = await userMsgRes.json();
        if (!userMsgRes.ok) {
          if (
            currentWalletRef.current === reqWallet &&
            sessionGenerationRef.current === reqGen &&
            activeConversationIdRef.current === targetConvId
          ) {
            setMessages((prev) => prev.filter((m) => m.id !== tempUserMsgId && !m.id.startsWith('optimistic_')));
            setInput(userInput);
            if (userMsgData.code === 'CONVERSATION_AWAITING_AI') {
              setError('Conversation is awaiting AI response.');
            } else {
              setError(userMsgData.error || 'Failed to append message');
            }
            setIsThinking(false);
          }
          return;
        }

        const appendedUserMsg: Message = {
          id: userMsgData.id,
          role: userMsgData.role,
          content: userMsgData.content,
          timestamp: userMsgData.createdAt,
        };

        setMessages((prev) => {
          const hasReal = prev.some((m) => m.id === appendedUserMsg.id);
          if (hasReal) return prev;
          return prev.map((m) => (m.id === tempUserMsgId || m.id.startsWith('optimistic_') ? appendedUserMsg : m));
        });
      }

      if (!targetConvId) return;
      await requestAiResponse(targetConvId, token, reqWallet, reqGen);
    } catch (err: any) {
      if (currentWalletRef.current === reqWallet && sessionGenerationRef.current === reqGen) {
        setMessages((prev) => prev.filter((m) => m.id !== tempUserMsgId && !m.id.startsWith('optimistic_')));
        setError(err?.message || 'Failed to process message');
        setIsThinking(false);
      }
    }
  };

  const handleSelectSeller = useCallback(
    (seller: SellerResult) => {
      if (isThinking) return;
      const key = (seller.wallet || '').toLowerCase();
      const identity = identitiesMap[key];
      const handle = identity?.handle || identity?.displayHandle;
      let targetCmd = '';
      if (handle) {
        const cleanHandle = handle.replace(/^@/, '');
        targetCmd = `use @${cleanHandle} as the freelancer`;
      } else if (seller.wallet) {
        targetCmd = `use ${seller.wallet} as the freelancer`;
      } else if (seller.name) {
        targetCmd = `use ${seller.name} as the freelancer`;
      }

      if (targetCmd) {
        handleSend(targetCmd);
      }
    },
    [identitiesMap, isThinking, handleSend]
  );

  const renderHistoryContent = () => (
    !effectiveAddress ? (
      <div className="flex h-full min-h-24 flex-col items-center justify-center px-3 text-center text-xs text-zinc-400 gap-1">
        <span>Connect your wallet to view chat history.</span>
      </div>
    ) : historyLoading || isAccountRestoring ? (
      <div className="flex h-full min-h-24 items-center justify-center px-3 text-center text-sm text-zinc-400">
        Loading chat history...
      </div>
    ) : conversations.length === 0 ? (
      <div className="flex h-full min-h-24 items-center justify-center px-3 text-center text-sm text-zinc-400">
        No previous chats yet.
      </div>
    ) : (
      <div className="space-y-1.5">
        {conversations.map((chat) => (
          <div
            key={chat.id}
            className={cn(
              'flex w-full items-center rounded-lg border transition-colors',
              activeConversationId === chat.id
                ? 'border-blue-500/35 bg-blue-500/10'
                : 'border-transparent hover:border-zinc-700/70 hover:bg-zinc-800/40'
            )}
          >
            <button
              onClick={() => selectChat(chat)}
              disabled={isThinking}
              className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left disabled:opacity-50"
            >
              <MessageSquare size={14} className={cn('shrink-0', activeConversationId === chat.id ? 'text-blue-400' : 'text-zinc-400')} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-200">{chat.title}</p>
                <p className="mt-0.5 text-xs text-zinc-400">{formatChatDate(new Date(chat.updatedAt).getTime())}</p>
              </div>
            </button>
            <button
              type="button"
              aria-label={`Delete ${chat.title}`}
              title="Delete chat"
              disabled={isThinking}
              onClick={(event) => {
                event.stopPropagation();
                deleteChat(chat.id);
              }}
              className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-700/70 bg-zinc-900/40 text-zinc-400 transition-colors hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400/50 disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    )
  );

  const renderComposer = (emptyState: boolean) => (
    <div className={cn(!emptyState && 'shrink-0 p-3 sm:p-4')}>
      {error && (
        <div className="flex items-center justify-between text-xs text-red-400 mb-2 px-1 gap-2">
          <span>{error}</span>
          {retryableConvId && (
            <button
              type="button"
              onClick={handleRetryAi}
              disabled={isThinking}
              className="underline font-semibold text-blue-400 hover:text-blue-300 disabled:opacity-50 disabled:no-underline"
            >
              Retry AI
            </button>
          )}
        </div>
      )}
      <div
        className={cn(
          'flex items-center gap-2 bg-zinc-900/90 border border-zinc-700/60 rounded-2xl focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/20 transition-all shadow-xl',
          emptyState ? 'p-3' : 'p-2'
        )}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe the deal you want..."
          className={cn(
            'flex-1 bg-transparent text-sm text-white placeholder:text-zinc-500 outline-none resize-none px-1 max-h-[140px] overflow-y-auto leading-relaxed',
            emptyState ? 'py-2.5 min-h-[44px]' : 'py-1.5 min-h-[36px]'
          )}
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!input.trim() || isThinking}
          className={cn(
            'rounded-xl bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all shrink-0 shadow-sm',
            emptyState ? 'p-3' : 'p-2.5'
          )}
          aria-label="Send message"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-[calc(100dvh-6rem)] min-h-0 flex-col gap-4 overflow-hidden lg:h-[calc(100dvh-4rem)]">
      {/* COMPACT HEADER WITH PRESS START 2P FONT AND HELP TOOLTIP */}
      <div className="flex items-center justify-between flex-wrap gap-3 shrink-0">
        <div className="flex items-center gap-2.5">
          <h1 className={`${pressStart2P.className} text-xl md:text-2xl font-normal text-white tracking-tight`}>
            AI Deal Negotiator
          </h1>
          <div className="relative group inline-block">
            <button
              type="button"
              tabIndex={0}
              aria-label="About AI Deal Negotiator"
              className="w-5 h-5 rounded-full bg-zinc-800/80 hover:bg-zinc-800 border border-zinc-700/60 text-zinc-400 hover:text-white text-[11px] font-bold font-mono inline-flex items-center justify-center shrink-0 transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            >
              ?
            </button>
            <div className="absolute left-0 top-full mt-2 w-72 sm:w-80 p-3 rounded-xl bg-zinc-900 border border-zinc-700/80 text-zinc-200 text-xs leading-relaxed shadow-2xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-all duration-150 z-30">
              Describe the deal you need. Synq AI helps shape the terms, find matching providers, and turn the conversation into a deal proposal. Review deal terms carefully before signing.
            </div>
          </div>
        </div>

        <div className="flex lg:hidden items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMobileDraftOpen(!mobileDraftOpen)}
            className={cn(
              'flex items-center gap-1.5 border-zinc-800 bg-zinc-900/80 text-zinc-300 hover:text-white hover:bg-zinc-800 text-xs',
              mobileDraftOpen && 'border-blue-500/60 text-blue-400'
            )}
            title="Toggle Deal Draft"
          >
            <FileText size={14} />
            <span className="text-xs">Draft</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setMobileHistoryOpen(!mobileHistoryOpen)}
            className="flex items-center gap-1.5 border-zinc-800 bg-zinc-900/80 text-zinc-300 hover:text-white hover:bg-zinc-800 text-xs"
            title="Toggle Chat History"
          >
            <History size={14} />
            <span className="text-xs">History</span>
          </Button>
        </div>
      </div>

      <ChainGuard what="the deal factory is" />

      {/* MAIN CONTENT AREA WITH PERMANENT DESKTOP RIGHT PANEL */}
      <div className="relative flex min-h-0 flex-1 gap-4 overflow-hidden">
        {/* MAIN CHAT WORKSPACE */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            className={cn(
              'min-h-0 flex-1 space-y-6 p-4 sm:p-5',
              isEmptyChat ? 'overflow-y-hidden' : 'overflow-y-auto'
            )}
          >
            {messagesLoading ? (
              <div className="flex h-full min-h-32 items-center justify-center text-sm text-zinc-400 gap-2">
                <Loader2 size={16} className="animate-spin text-blue-400" />
                Loading conversation...
              </div>
            ) : isEmptyChat ? (
              <div className="flex min-h-full w-full items-center justify-center px-1 py-6 sm:px-4">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 sm:gap-7">
                  <h3 className={`${pressStart2P.className} w-full text-center text-lg font-normal leading-relaxed tracking-[-0.05em] [word-spacing:-0.4em] text-white sm:text-xl lg:text-2xl`}>
                    {greetingIdentity ? `Ready to make a deal, ${greetingIdentity}?` : 'Ready to make a deal?'}
                  </h3>

                  {renderComposer(true)}

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {STARTER_PROMPTS.map((item) => {
                    const IconComponent = item.icon;
                    return (
                      <button
                        key={item.title}
                        type="button"
                        onClick={() => {
                          if (isThinking) return;
                          if (address && chatCount >= chatLimit && !activeConversationIdRef.current) {
                            showToast('Chat limit reached. Delete a conversation to start a new chat.');
                            return;
                          }
                          setInput(item.prompt);
                          requestAnimationFrame(() => textareaRef.current?.focus());
                        }}
                        disabled={isThinking}
                        className="group flex min-w-0 flex-col rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-4 text-left transition-all hover:border-zinc-700/80 hover:bg-zinc-800/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/60 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <p className={`${pressStart2P.className} min-w-0 flex-1 text-[10px] font-normal leading-relaxed tracking-[-0.04em] text-zinc-200 transition-colors group-hover:text-white md:whitespace-nowrap`}>{item.title}</p>
                          <IconComponent size={16} className="shrink-0 text-zinc-400 transition-colors group-hover:text-blue-400" />
                        </div>
                        <p className="text-xs leading-relaxed text-zinc-400">{item.description}</p>
                      </button>
                    );
                  })}
                  </div>
                </div>
              </div>
            ) : (
              messages
                .filter(msg => msg.id !== 'init')
                .map((msg) => (
                  <div key={msg.id}>
                    {msg.role === 'user' ? (
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex justify-end gap-2.5 max-w-[85%] ml-auto"
                      >
                        <div className="bg-blue-600 text-white rounded-2xl rounded-tr-xs px-4 py-2.5 shadow-sm text-sm leading-relaxed">
                          <p className="whitespace-pre-wrap">{msg.content}</p>
                        </div>
                      </motion.div>
                    ) : msg.role === 'ai' ? (
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex items-start gap-2.5 max-w-[85%] sm:max-w-[80%]"
                      >
                        <SynqAvatar className="w-8 h-8 p-1.5 mt-0.5 shrink-0" />
                        <div className="bg-zinc-800/80 border border-zinc-700/60 text-zinc-200 rounded-2xl rounded-tl-xs px-4 py-2.5 shadow-xs text-sm leading-relaxed min-w-0">
                          <FreelancerSearchMessage
                            content={msg.content}
                            sellers={msg.sellers}
                            identitiesMap={identitiesMap}
                            namesMap={namesMap}
                            avatarsMap={avatarsMap}
                            completedCountsMap={completedCountsMap}
                            reviewCountsMap={reviewCountsMap}
                            onSelectSeller={handleSelectSeller}
                          />
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="bg-zinc-800/30 text-zinc-400 text-center rounded-lg px-4 py-2 text-xs"
                      >
                        {msg.content}
                      </motion.div>
                    )}
                  </div>
                ))
            )}

            {isThinking && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex items-start gap-2.5 max-w-[85%] sm:max-w-[80%]">
                <SynqAvatar className="w-8 h-8 p-1.5 mt-0.5 shrink-0" />
                <div className="bg-zinc-800/80 border border-zinc-700/60 text-zinc-400 rounded-2xl rounded-tl-xs px-4 py-2.5 shadow-xs text-xs flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin text-blue-400" />
                  Analyzing deal request...
                </div>
              </motion.div>
            )}

            {accepted && (
              <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="p-4 rounded-xl border border-green-500/20 bg-green-600/10">
                <div className="flex items-center gap-2 mb-1">
                  <Check size={18} className="text-green-400" />
                  <span className="text-sm font-medium text-green-400">Deal Created!</span>
                </div>
                <p className="text-xs text-zinc-400">Your deal has been created on-chain.</p>
                <Button size="sm" variant="outline" className="mt-2 gap-1" onClick={() => router.push('/deals')}>
                  <Plus size={14} /> View My Deals
                </Button>
              </motion.div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Floating Modern Composer */}
          {!isEmptyChat && renderComposer(false)}
        </div>

        {/* PERMANENT DESKTOP HISTORY PANEL WITH DRAFT CONTROL */}
        <aside className="hidden lg:flex flex-col min-h-0 w-[300px] shrink-0 border border-zinc-800/80 bg-zinc-950/40 rounded-2xl overflow-hidden relative">
          <div className="p-3.5 border-b border-zinc-800/60 shrink-0 space-y-3 relative" ref={draftContainerRef}>
            {/* Top Control Row */}
            <div className="grid grid-cols-[2fr_3fr] gap-1.5 w-full">
              <Popover.Root
                open={draftPanelOpen}
                onOpenChange={(open) => {
                  if (!open) {
                    setDraftPanelOpen(false);
                    setDraftPanelPinned(false);
                  }
                }}
              >
                <Popover.Trigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onMouseEnter={handleDraftMouseEnter}
                    onMouseLeave={handleDraftMouseLeave}
                    onClick={handleDraftClick}
                    className={cn(
                      'w-full justify-center px-2 py-1 h-8 text-xs border-zinc-700/80 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 transition-all font-medium gap-1.5',
                      (draftPanelOpen || draftPanelPinned) && 'border-blue-500/60 bg-blue-500/10 text-blue-300'
                    )}
                  >
                    <FileText size={13} className={cn((draftPanelOpen || draftPanelPinned) ? 'text-blue-400' : 'text-zinc-400')} />
                    Draft
                  </Button>
                </Popover.Trigger>

                <Popover.Portal>
                  <Popover.Content
                    side="left"
                    align="start"
                    sideOffset={8}
                    onMouseEnter={handleDraftMouseEnter}
                    onMouseLeave={handleDraftMouseLeave}
                    className="z-50 outline-none focus:outline-none"
                  >
                    <DraftPanel
                      state={draftState}
                      clientIdentity={clientIdentityObj}
                      freelancerIdentity={freelancerIdentityObj}
                      onClose={() => { setDraftPanelOpen(false); setDraftPanelPinned(false); }}
                      onEdit={handleDraftEdit}
                      onProceed={handleDraftProceed}
                    />
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>

              <Button
                size="sm"
                onClick={startNewChat}
                disabled={isThinking}
                className="w-full justify-center px-2 py-1 h-8 text-xs bg-blue-600 hover:bg-blue-500 text-white font-semibold gap-1.5"
              >
                <Plus size={13} /> New Chat
              </Button>
            </div>

            {/* Chat History Title & Subtitle */}
            <div>
              <h2 className="text-sm font-semibold text-white">Chat History</h2>
              <p className="text-[11px] text-zinc-300">Recent negotiation sessions</p>
            </div>

            {/* Limit Row */}
            <div className="flex items-center justify-between text-xs text-zinc-300 font-mono pt-0.5">
              <span>Limit</span>
              <span>{address ? `${chatCount} / ${chatLimit}` : '0 / 10'}</span>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {renderHistoryContent()}
          </div>
        </aside>
      </div>

      {/* MOBILE HISTORY OVERLAY DRAWER */}
      <AnimatePresence>
        {mobileHistoryOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileHistoryOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-xs z-40 lg:hidden"
            />
            <motion.aside
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="fixed right-0 top-0 bottom-0 w-[300px] max-w-[85vw] bg-zinc-950 border-l border-zinc-800 z-50 flex flex-col p-4 space-y-3 lg:hidden"
            >
              <div className="flex items-center justify-between gap-2">
                <Button
                  className="flex-1 justify-start gap-2"
                  onClick={startNewChat}
                  disabled={isThinking}
                >
                  <Plus size={15} /> New Chat
                </Button>
                <button
                  type="button"
                  onClick={() => setMobileHistoryOpen(false)}
                  className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800 border border-zinc-800 shrink-0"
                  aria-label="Close history"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-white">Chat History</h2>
                  <p className="text-xs text-zinc-300">Recent negotiation sessions</p>
                </div>
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                  {address ? `${chatCount} / ${chatLimit}` : '0 / 10'}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pt-2">
                {renderHistoryContent()}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* MOBILE DRAFT OVERLAY MODAL */}
      <AnimatePresence>
        {mobileDraftOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileDraftOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-xs z-40 lg:hidden"
            />
            <div className="fixed inset-x-4 top-16 z-50 flex justify-center lg:hidden pointer-events-auto">
              <DraftPanel
                state={draftState}
                clientIdentity={clientIdentityObj}
                freelancerIdentity={freelancerIdentityObj}
                onClose={() => setMobileDraftOpen(false)}
                onEdit={handleDraftEdit}
                onProceed={handleDraftProceed}
              />
            </div>
          </>
        )}
      </AnimatePresence>

      {/* TEMPORARY FLOATING LIMIT / WALLET TOAST OVERLAY */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl bg-zinc-900/95 border border-zinc-700/80 text-zinc-100 text-xs sm:text-sm font-medium shadow-2xl backdrop-blur-md flex items-center gap-2.5 pointer-events-auto"
          >
            <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
            <span>{toastMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Landing-to-Negotiator Continuous Emergence Overlay (B.11.5 Part C / B.11.6 Fix) */}
      {emergingFromLanding && (
        <>
          <style>{`
            @keyframes synq-emergence-fade {
              0% { opacity: 1; }
              100% { opacity: 0; }
            }
          `}</style>
          <div
            data-testid="negotiator-emergence-overlay"
            onAnimationEnd={() => setEmergingFromLanding(false)}
            className="fixed inset-0 bg-[#242424] pointer-events-none z-[100]"
            style={{
              animation: 'synq-emergence-fade 400ms cubic-bezier(0, 0, 0.2, 1) forwards',
              willChange: 'opacity',
            }}
            aria-hidden="true"
          />
        </>
      )}
    </div>
  );
}

export default function NegotiatorPage() {
  return (
    <Suspense fallback={null}>
      <NegotiatorContent />
    </Suspense>
  );
}
