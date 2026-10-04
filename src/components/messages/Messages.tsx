'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import { motion } from 'framer-motion';
import { Send, Loader2, MessageSquare, Package, Calendar, DollarSign, SplitSquareHorizontal, CheckCircle, Plus, Search, X, Paperclip, FileText, ExternalLink, Banknote } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/shared/Avatar';
import { DealReceipt } from '@/components/deals/DealReceipt';
import { DealProposalReceipt } from '@/components/deals/DealProposalReceipt';
import { PaymentReceipt } from '@/components/messages/PaymentReceipt';
import { SendFundsModal } from '@/components/messages/SendFundsModal';
import { formatTimeAgo, shortenAddress, cn } from '@/lib/utils';
import { useSynqIdentities } from '@/hooks/useSynqIdentity';
import { useAuthSession } from '@/hooks/useAuthSession';
import { registryABI } from '@/hooks/useRegistryContract';
import { CONTRACT_ADDRESSES, getTokenInfo } from '@/lib/contracts/addresses';
import { sepoliaPublicClient } from '@/lib/chain';
import {
  validateDealProposalPayload,
  validateDealReceiptPayload,
  validateFileMessagePayload,
  validatePaymentReceiptPayload,
  type SynqDealProposalPayload,
  type SynqDealReceiptPayload,
  type SynqFileMessagePayload,
  type SynqMessageKind,
  type SynqMessagePayload,
  type SynqPaymentReceiptPayload,
} from '@/lib/synq-message';

interface Conversation {
  id: string;
  participantA: string;
  participantB: string;
  buyerWallet: string;
  sellerWallet: string;
  buyerName?: string;
  sellerName?: string;
  subject?: string;
  orderMeta?: {
    type?: string;
    requirements?: string;
    budget?: string;
    deadline?: string;
    paymentSplit?: '50/50' | 'full';
    confirmed?: boolean;
    confirmedAt?: string;
    confirmedBy?: string;
  };
  lastMessageAt?: string;
  lastMessagePreview?: string;
  lastMessageFrom?: string;
  createdAt?: string;
  unread?: number;
}

interface Message {
  id: string;
  conversationId: string;
  fromWallet: string;
  toWallet: string;
  fromName?: string;
  body: string;
  kind?: SynqMessageKind;
  payload?: SynqMessagePayload | null;
  orderMeta?: {
    type?: string;
    requirements?: string;
    budget?: string;
    deadline?: string;
    paymentSplit?: '50/50' | 'full';
    confirmed?: boolean;
  };
  createdAt: string;
  readAt?: string | null;
}

interface DraftTarget {
  wallet: string;
  name?: string;
  username?: string;
  avatar?: string | null;
  subject?: string;
  orderIntent?: boolean;
}

interface DiscoveryResult {
  wallet: string;
  username?: string;
  name?: string;
  avatar?: string | null;
}

const lc = (w?: string) => String(w || '').toLowerCase();
const isWallet = (w?: string | null): w is `0x${string}` => !!w && /^0x[0-9a-fA-F]{40}$/.test(w);
const counterpartyFor = (conversation: Conversation, me: string) => {
  const wallet = lc(conversation.participantA) === me
    ? conversation.participantB
    : conversation.participantA;
  const name = lc(conversation.buyerWallet) === lc(wallet)
    ? conversation.buyerName
    : lc(conversation.sellerWallet) === lc(wallet)
      ? conversation.sellerName
      : undefined;
  return { wallet, name };
};

interface OrderFormState {
  requirements: string;
  budget: string;
  deadline: string;
  paymentSplit: '50/50' | 'full';
}

type AuthenticatedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

function FileMessage({
  messageId,
  payload,
  authenticatedFetch,
}: {
  messageId: string;
  payload: SynqFileMessagePayload;
  authenticatedFetch: AuthenticatedFetch;
}) {
  const [signedUrl, setSignedUrl] = useState('');
  const [accessError, setAccessError] = useState('');
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  const isImage = payload.mimeType.startsWith('image/');

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const requestAccess = useCallback(async () => {
    setLoading(true);
    setAccessError('');
    try {
      const response = await authenticatedFetch(`/api/messages/file/${encodeURIComponent(messageId)}`);
      const data = await response.json();
      if (!response.ok || typeof data?.url !== 'string') throw new Error(data?.error || 'Could not open attachment.');
      if (mounted.current) setSignedUrl(data.url);
      return data.url as string;
    } catch (error: any) {
      if (mounted.current) setAccessError(error?.message || 'Could not open attachment.');
      return '';
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [authenticatedFetch, messageId]);

  useEffect(() => {
    if (!isImage) return;
    void requestAccess();
  }, [isImage, requestAccess]);

  const openFile = async () => {
    const url = await requestAccess();
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="w-full min-w-0">
      {isImage && signedUrl ? (
        <button type="button" onClick={openFile} className="block w-full overflow-hidden rounded-xl focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-400/70">
          {/* Private, short-lived object URL; Next Image cannot statically authorize this source. */}
          <img
            src={signedUrl}
            alt={payload.fileName}
            onError={() => {
              setSignedUrl('');
              setAccessError('Preview expired. Open the attachment to refresh it.');
            }}
            className="max-h-72 w-full object-contain bg-black/20"
          />
        </button>
      ) : isImage && loading ? (
        <div className="h-32 flex items-center justify-center rounded-xl bg-black/20"><Loader2 size={18} className="animate-spin text-zinc-400" /></div>
      ) : null}
      <div className={cn('flex items-center gap-3', isImage && signedUrl && 'pt-2')}>
        <div className="h-9 w-9 shrink-0 rounded-lg border border-zinc-600/60 bg-zinc-900/40 flex items-center justify-center">
          <FileText size={17} className="text-blue-300" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{payload.fileName}</p>
          <p className="text-[11px] text-zinc-400">{payload.fileName.split('.').pop()?.toUpperCase()} · {formatFileSize(payload.size)}</p>
        </div>
        <button
          type="button"
          onClick={openFile}
          disabled={loading}
          title="Open attachment"
          aria-label={`Open ${payload.fileName}`}
          className="p-2 rounded-lg border border-zinc-600/60 text-zinc-300 hover:border-blue-400/60 hover:text-white disabled:opacity-50 transition-colors"
        >
          {loading ? <Loader2 size={15} className="animate-spin" /> : <ExternalLink size={15} />}
        </button>
      </div>
      {accessError && <p className="pt-1 text-[11px] text-red-300">{accessError}</p>}
    </div>
  );
}

export default function Messages() {
  const router = useRouter();
  const params = useSearchParams();
  const { address, isConnected } = useAccount();
  const { ensureAuthenticated, clearSession } = useAuthSession();
  const me = address ? lc(address) : '';

  const toParam = params.get('to');
  const nameParam = params.get('name');
  const typeParam = params.get('type');
  const intentParam = params.get('intent');

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftTarget | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [otherAvatar, setOtherAvatar] = useState<string | null>(null);
  const [orderForm, setOrderForm] = useState<OrderFormState>({ requirements: '', budget: '', deadline: '', paymentSplit: 'full' });
  const [confirming, setConfirming] = useState(false);
  const [quickDeadline, setQuickDeadline] = useState('');
  const [quickSending, setQuickSending] = useState(false);
  const [walletStateOwner, setWalletStateOwner] = useState(me);
  const [hasMounted, setHasMounted] = useState(false);
  const [discoveryInput, setDiscoveryInput] = useState('');
  const [discoveryResult, setDiscoveryResult] = useState<DiscoveryResult | null>(null);
  const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [counterpartyProfiles, setCounterpartyProfiles] = useState<Record<string, { name?: string; avatar?: string | null }>>({});
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [attachmentSending, setAttachmentSending] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [sendFundsOpen, setSendFundsOpen] = useState(false);

  const appliedParam = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);
  const walletGeneration = useRef(0);
  const discoveryGeneration = useRef(0);
  const attachmentGeneration = useRef(0);
  const currentWallet = useRef(me);
  const fileInputRef = useRef<HTMLInputElement>(null);
  currentWallet.current = me;

  const clearPrivateState = useCallback((message = '') => {
    setConversations([]);
    setListLoaded(false);
    setActiveId(null);
    setDraft(null);
    setMessages([]);
    setInput('');
    setSending(false);
    setError(message);
    setOtherAvatar(null);
    setOrderForm({ requirements: '', budget: '', deadline: '', paymentSplit: 'full' });
    setConfirming(false);
    setQuickDeadline('');
    setQuickSending(false);
    discoveryGeneration.current += 1;
    attachmentGeneration.current += 1;
    setDiscoveryInput('');
    setDiscoveryResult(null);
    setDiscoveryError('');
    setDiscoveryLoading(false);
    setCounterpartyProfiles({});
    setAttachmentMenuOpen(false);
    setSelectedFile(null);
    setAttachmentSending(false);
    setAttachmentError('');
    setSendFundsOpen(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    appliedParam.current = false;
    prevCount.current = 0;
  }, []);

  // Wagmi may restore a connected account from browser storage on the first
  // client render, while SSR always sees no browser wallet. Keep the initial
  // markup deterministic, then reveal the wallet-scoped branch after hydration.
  useEffect(() => {
    setHasMounted(true);
  }, []);

  const authenticatedFetch = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    const wallet = me;
    const generation = walletGeneration.current;
    if (!wallet) throw new Error('Connect your wallet to access messages.');
    const token = await ensureAuthenticated();
    if (currentWallet.current !== wallet || walletGeneration.current !== generation) {
      throw new Error('Wallet changed while authenticating.');
    }
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(input, { ...init, headers });
    if (currentWallet.current !== wallet || walletGeneration.current !== generation) {
      throw new Error('Wallet changed while loading messages.');
    }
    if (response.status === 401) {
      clearSession();
      clearPrivateState('Your messaging session expired. Sign again to continue.');
    }
    return response;
  }, [clearPrivateState, clearSession, ensureAuthenticated, me]);

  // Private messaging state is wallet-scoped. Invalidate outstanding work and
  // clear the previous wallet's data before any request for the new wallet.
  useEffect(() => {
    walletGeneration.current += 1;
    clearPrivateState();
    setWalletStateOwner(me);
  }, [me, clearPrivateState]);

  useEffect(() => {
    setSendFundsOpen(false);
  }, [activeId, draft?.wallet, me]);

  const myName = useMemo(() => {
    if (typeof window === 'undefined' || !me) return '';
    try {
      const key = `settings:username:${me.toLowerCase()}`;
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as string) : '';
    } catch { return ''; }
  }, [me]);

  const loadList = useCallback(async () => {
    if (!me) return;
    const generation = walletGeneration.current;
    try {
      const res = await authenticatedFetch(`/api/conversations?wallet=${me}`);
      const data = await res.json();
      if (walletGeneration.current !== generation || currentWallet.current !== me) return;
      if (!res.ok) throw new Error(data?.error || 'Could not load conversations.');
      if (Array.isArray(data.conversations)) setConversations(data.conversations);
      setError('');
    } catch (e: any) {
      if (walletGeneration.current === generation && currentWallet.current === me) {
        setConversations([]);
        setError(e?.message || 'Could not load conversations.');
      }
    } finally {
      if (walletGeneration.current === generation && currentWallet.current === me) setListLoaded(true);
    }
  }, [authenticatedFetch, me]);

  const loadThread = useCallback(async (id: string) => {
    if (!me || !id) return;
    const generation = walletGeneration.current;
    try {
      const res = await authenticatedFetch(`/api/messages?conversationId=${id}&wallet=${me}`);
      const data = await res.json();
      if (walletGeneration.current !== generation || currentWallet.current !== me) return;
      if (!res.ok) throw new Error(data?.error || 'Could not load messages.');
      if (Array.isArray(data.messages)) setMessages(data.messages);
    } catch (e: any) {
      if (walletGeneration.current === generation && currentWallet.current === me) {
        setMessages([]);
        setError(e?.message || 'Could not load messages.');
      }
    }
  }, [authenticatedFetch, me]);

  // Initial + polled conversation list.
  useEffect(() => {
    if (!me || walletStateOwner !== me) return;
    loadList();
    const t = setInterval(loadList, 10_000);
    return () => clearInterval(t);
  }, [me, walletStateOwner, loadList]);

  // Active thread: load on open, then poll every 3s (no WebSocket on Vercel).
  useEffect(() => {
    if (walletStateOwner !== me || !activeId) { setMessages([]); return; }
    loadThread(activeId);
    const t = setInterval(() => loadThread(activeId), 3_000);
    return () => clearInterval(t);
  }, [activeId, loadThread, me, walletStateOwner]);

  // Apply the ?to / ?intent deep-link once the list is known.
  useEffect(() => {
    if (appliedParam.current || !me || walletStateOwner !== me || !listLoaded) return;
    if (!isWallet(toParam)) { appliedParam.current = true; return; }
    if (lc(toParam) === me) { appliedParam.current = true; return; }
    appliedParam.current = true;
    const existing = conversations.find(
      (c) =>
        (lc(c.participantA) === me && lc(c.participantB) === lc(toParam)) ||
        (lc(c.participantB) === me && lc(c.participantA) === lc(toParam)),
    );
    if (existing) {
      setActiveId(existing.id);
    } else {
      setDraft({
        wallet: lc(toParam),
        name: nameParam || undefined,
        subject: typeParam || undefined,
        orderIntent: intentParam === 'order',
      });
      setActiveId(null);
      if (intentParam === 'order') {
        setOrderForm({ requirements: '', budget: '', deadline: '', paymentSplit: 'full' });
        setInput('');
      }
    }
  }, [me, walletStateOwner, listLoaded, conversations, toParam, nameParam, typeParam, intentParam]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) || null,
    [conversations, activeId],
  );

  // The person on the other side of the active thread (existing or draft).
  const other = useMemo<DraftTarget | null>(() => {
    if (activeConversation) {
      return counterpartyFor(activeConversation, me);
    }
    if (draft) return { wallet: draft.wallet, name: draft.name, username: draft.username, avatar: draft.avatar };
    return null;
  }, [activeConversation, draft, me]);

  const counterpartyWallets = useMemo(() => {
    const set = new Set<string>();
    if (me) {
      set.add(me);
      for (const c of conversations) {
        const cp = counterpartyFor(c, me).wallet;
        if (cp && isWallet(cp)) set.add(cp);
      }
    }
    if (draft?.wallet && isWallet(draft.wallet)) set.add(draft.wallet);
    if (discoveryResult?.wallet && isWallet(discoveryResult.wallet)) set.add(discoveryResult.wallet);
    return Array.from(set);
  }, [conversations, draft?.wallet, discoveryResult?.wallet, me]);

  const { identitiesMap: counterpartyIdentities } = useSynqIdentities(counterpartyWallets);

  // Chat History and the active header share the same public avatar/name source.
  useEffect(() => {
    if (!me || walletStateOwner !== me || counterpartyWallets.length === 0) {
      setCounterpartyProfiles({});
      return;
    }
    const generation = walletGeneration.current;
    let cancelled = false;
    fetch('/api/profile/public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallets: counterpartyWallets.slice(0, 100) }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled || walletGeneration.current !== generation || currentWallet.current !== me) return;
        const next: Record<string, { name?: string; avatar?: string | null }> = {};
        for (const profile of Array.isArray(data?.profiles) ? data.profiles : []) {
          if (!isWallet(profile?.wallet)) continue;
          next[lc(profile.wallet)] = {
            name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : undefined,
            avatar: typeof profile.avatar === 'string' && profile.avatar ? profile.avatar : null,
          };
        }
        setCounterpartyProfiles(next);
      })
      .catch(() => {
        if (!cancelled && walletGeneration.current === generation && currentWallet.current === me) {
          setCounterpartyProfiles({});
        }
      });
    return () => { cancelled = true; };
  }, [counterpartyWallets, me, walletStateOwner]);

  const subject = activeConversation?.subject || draft?.subject || '';

  // Order state for the active thread: is the current user the seller, and has
  // the order been confirmed yet?
  const activeOrderMeta = activeConversation?.orderMeta;
  const isSellerOfOrder = !!activeConversation && !!me && lc(String(activeConversation.sellerWallet)) === me;
  const isBuyerOfOrder = !!activeConversation && !!me && lc(String(activeConversation.buyerWallet)) === me;
  const orderConfirmed = !!activeOrderMeta?.confirmed;
  const hasOrder = !!activeConversation && (!!activeOrderMeta || messages.some((m) => m.kind === 'order' || m.kind === 'confirm'));

  // Fetch the other party's photo for the header.
  useEffect(() => {
    setOtherAvatar(draft && other?.wallet && draft.wallet === other.wallet ? draft.avatar || null : null);
    if (!other?.wallet) return;
    let cancelled = false;
    fetch('/api/profile/public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallets: [other.wallet] }),
    })
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d?.profiles?.[0]?.avatar) setOtherAvatar(d.profiles[0].avatar); })
      .catch(() => { /* initials fallback */ });
    return () => { cancelled = true; };
  }, [draft?.avatar, draft?.wallet, other?.wallet]);

  // Auto-scroll to the newest message when the count grows.
  useEffect(() => {
    if (messages.length > prevCount.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
    prevCount.current = messages.length;
  }, [messages]);

  const openConversation = (c: Conversation) => {
    attachmentGeneration.current += 1;
    setAttachmentMenuOpen(false);
    setSelectedFile(null);
    setAttachmentSending(false);
    setAttachmentError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    setDraft(null);
    setDiscoveryResult(null);
    setDiscoveryError('');
    setError('');
    setInput('');
    setActiveId(c.id);
  };

  const resetDiscovery = useCallback(() => {
    discoveryGeneration.current += 1;
    setDiscoveryInput('');
    setDiscoveryResult(null);
    setDiscoveryError('');
    setDiscoveryLoading(false);
  }, []);

  const searchForUser = useCallback(async (
    raw: string,
    generation: number,
    ownerGeneration: number,
    ownerWallet: string,
  ) => {
    const isCurrentSearch = () => (
      discoveryGeneration.current === generation
      && walletGeneration.current === ownerGeneration
      && currentWallet.current === ownerWallet
    );

    try {
      await ensureAuthenticated();
      if (!isCurrentSearch()) return;

      let targetWallet = '';
      let resolvedUsername: string | undefined;

      if (isWallet(raw)) {
        targetWallet = lc(raw);
        try {
          const registryUsername = await sepoliaPublicClient.readContract({
            address: CONTRACT_ADDRESSES.sepolia.NexotiqRegistry as `0x${string}`,
            abi: registryABI,
            functionName: 'getUsername',
            args: [targetWallet as `0x${string}`],
          });
          const clean = String(registryUsername || '').trim().replace(/^@/, '');
          if (clean) resolvedUsername = clean;
        } catch {
          // A valid wallet remains messageable when it has no readable Registry identity.
        }
      } else {
        const username = raw.replace(/^@/, '').trim();
        if (!username) {
          setDiscoveryError('Enter a Synq username or complete wallet address.');
          return;
        }
        let registryAddress: unknown;
        try {
          registryAddress = await sepoliaPublicClient.readContract({
            address: CONTRACT_ADDRESSES.sepolia.NexotiqRegistry as `0x${string}`,
            abi: registryABI,
            functionName: 'getAddress',
            args: [username],
          });
        } catch {
          if (isCurrentSearch()) setDiscoveryError('Could not search Synq Registry. Try again.');
          return;
        }
        if (!isWallet(String(registryAddress)) || /^0x0{40}$/i.test(String(registryAddress))) {
          if (isCurrentSearch()) setDiscoveryError('No exact Synq user found.');
          return;
        }
        targetWallet = lc(String(registryAddress));
        resolvedUsername = username;
      }

      if (!isCurrentSearch()) return;
      if (targetWallet === ownerWallet) {
        setDiscoveryError("You can't start a chat with your own wallet.");
        return;
      }

      let publicName: string | undefined;
      let publicAvatar: string | null = null;
      try {
        const profileResponse = await fetch('/api/profile/public', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallets: [targetWallet] }),
        });
        const profileData = await profileResponse.json();
        const profile = profileResponse.ok ? profileData?.profiles?.[0] : null;
        if (typeof profile?.name === 'string' && profile.name.trim()) publicName = profile.name.trim();
        if (typeof profile?.avatar === 'string' && profile.avatar) publicAvatar = profile.avatar;
      } catch {
        // Registry/wallet resolution is sufficient; profile decoration is optional.
      }

      if (!isCurrentSearch()) return;
      setDiscoveryResult({
        wallet: targetWallet,
        username: resolvedUsername,
        name: publicName,
        avatar: publicAvatar,
      });
    } catch {
      if (isCurrentSearch()) setDiscoveryError('Authenticate your wallet to start a new chat.');
    } finally {
      if (isCurrentSearch()) setDiscoveryLoading(false);
    }
  }, [ensureAuthenticated]);

  useEffect(() => {
    const raw = discoveryInput.trim();
    const generation = ++discoveryGeneration.current;
    const ownerGeneration = walletGeneration.current;
    const ownerWallet = me;

    setDiscoveryResult(null);
    setDiscoveryError('');

    if (!raw || (raw.toLowerCase().startsWith('0x') && !isWallet(raw))) {
      setDiscoveryLoading(false);
      return;
    }

    setDiscoveryLoading(true);
    const timer = window.setTimeout(() => {
      void searchForUser(raw, generation, ownerGeneration, ownerWallet);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [discoveryInput, me, searchForUser]);

  const openDiscoveryResult = () => {
    if (!discoveryResult || !me) return;
    const target = lc(discoveryResult.wallet);
    if (target === me) {
      setDiscoveryError("You can't start a chat with your own wallet.");
      return;
    }
    const existing = conversations.find(
      (c) =>
        (lc(c.participantA) === me && lc(c.participantB) === target) ||
        (lc(c.participantB) === me && lc(c.participantA) === target),
    );
    if (existing) {
      openConversation(existing);
      resetDiscovery();
      return;
    }

    setDraft({
      wallet: target,
      name: discoveryResult.name,
      username: discoveryResult.username,
      avatar: discoveryResult.avatar,
    });
    setActiveId(null);
    attachmentGeneration.current += 1;
    setAttachmentMenuOpen(false);
    setSelectedFile(null);
    setAttachmentSending(false);
    setAttachmentError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    setMessages([]);
    setInput('');
    setError('');
    resetDiscovery();
  };

  const send = async () => {
    const text = input.trim();
    if (!me || sending) return;
    if (!isWallet(other?.wallet)) { setError('No recipient selected.'); return; }
    const firstOrder = !!draft?.orderIntent && !activeId && messages.length === 0;
    setSending(true);
    setError('');
    const generation = walletGeneration.current;

    // Build the message body and orderMeta from the structured form.
    let body = text;
    let meta: Record<string, any> | undefined;
    if (firstOrder) {
      const reqs = orderForm.requirements.trim();
      const budget = orderForm.budget.trim();
      const deadline = orderForm.deadline.trim();
      if (!reqs) {
        setError('Write your basic requirement to place the order.');
        setSending(false);
        return;
      }
      meta = {
        type: draft?.subject || undefined,
        requirements: reqs,
        budget: budget || undefined,
        deadline: deadline || undefined,
        paymentSplit: orderForm.paymentSplit,
      };
      body = [
        'Hi! I\'d like to order your service.',
        '',
        `Requirements:\n${reqs}`,
        budget ? `Budget: ${budget}` : '',
        deadline ? `Deadline: ${deadline}` : '',
        `Payment: ${orderForm.paymentSplit === '50/50' ? '50% upfront, 50% on approval' : 'Full amount in escrow'}`,
      ].filter(Boolean).join('\n');
    }
    try {
      const res = await authenticatedFetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromWallet: me,
          toWallet: other!.wallet,
          body,
          kind: firstOrder ? 'order' : 'text',
          orderMeta: firstOrder ? meta : undefined,
          fromName: myName || undefined,
        }),
      });
      const data = await res.json();
      if (walletGeneration.current !== generation || currentWallet.current !== me) return;
      if (!res.ok) { setError(data?.error || 'Could not send message.'); return; }
      setInput('');
      setDraft(null);
      setOrderForm({ requirements: '', budget: '', deadline: '', paymentSplit: 'full' });
      setActiveId(data.conversation.id);
      await Promise.all([loadThread(data.conversation.id), loadList()]);
    } catch {
      setError('Could not send message. Check your connection and try again.');
    } finally {
      if (walletGeneration.current === generation && currentWallet.current === me) setSending(false);
    }
  };

  const sendAttachment = async (file: File) => {
    if (!me || attachmentSending) return;
    if (!isWallet(other?.wallet)) { setAttachmentError('No recipient selected.'); return; }
    setAttachmentSending(true);
    setAttachmentError('');
    setAttachmentMenuOpen(false);
    const generation = walletGeneration.current;
    const requestGeneration = ++attachmentGeneration.current;
    try {
      const headers = new Headers({
        'Content-Type': file.type,
        'X-Synq-File-Name': encodeURIComponent(file.name),
      });
      if (activeId) headers.set('X-Synq-Conversation-Id', activeId);
      else headers.set('X-Synq-To-Wallet', other.wallet);
      const response = await authenticatedFetch('/api/messages/file', {
        method: 'POST',
        headers,
        body: file,
      });
      const responseType = response.headers.get('content-type') || '';
      let data: any = null;
      if (responseType.toLowerCase().includes('application/json')) {
        try {
          data = await response.json();
        } catch {
          data = null;
        }
      } else {
        // Consume framework/plain-text errors without exposing their contents in chat.
        await response.text().catch(() => '');
      }
      if (
        walletGeneration.current !== generation
        || currentWallet.current !== me
        || attachmentGeneration.current !== requestGeneration
      ) return;
      if (!response.ok) throw new Error(data?.error || 'Could not send attachment.');
      if (!data?.conversation?.id) throw new Error('Could not send attachment.');
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setDraft(null);
      setActiveId(data.conversation.id);
      await Promise.all([loadThread(data.conversation.id), loadList()]);
    } catch (error: any) {
      if (
        walletGeneration.current === generation
        && currentWallet.current === me
        && attachmentGeneration.current === requestGeneration
      ) {
        setAttachmentError(error?.message || 'Could not send attachment. Try again.');
      }
    } finally {
      if (
        walletGeneration.current === generation
        && currentWallet.current === me
        && attachmentGeneration.current === requestGeneration
      ) setAttachmentSending(false);
    }
  };

  const confirmOrder = async () => {
    if (!me || !isWallet(other?.wallet) || !activeId || confirming) return;
    setConfirming(true);
    setError('');
    const generation = walletGeneration.current;
    try {
      const res = await authenticatedFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: activeId, sellerWallet: me }),
      });
      const data = await res.json();
      if (walletGeneration.current !== generation || currentWallet.current !== me) return;
      if (!res.ok) { setError(data?.error || 'Could not confirm order.'); return; }
      await Promise.all([loadThread(activeId), loadList()]);
    } catch {
      setError('Could not confirm order. Check your connection and try again.');
    } finally {
      if (walletGeneration.current === generation && currentWallet.current === me) setConfirming(false);
    }
  };

  const sendQuick = async (msg: string) => {
    if (!me || !isWallet(other?.wallet) || !activeId || quickSending || !msg.trim()) return;
    setQuickSending(true);
    const generation = walletGeneration.current;
    try {
      const res = await authenticatedFetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromWallet: me,
          toWallet: other!.wallet,
          body: msg.trim(),
          kind: 'text',
          fromName: myName || undefined,
        }),
      });
      const data = await res.json();
      if (walletGeneration.current !== generation || currentWallet.current !== me) return;
      if (!res.ok) { setError(data?.error || 'Could not send.'); return; }
      await Promise.all([loadThread(activeId), loadList()]);
    } catch {
      setError('Could not send. Check your connection.');
    } finally {
      if (walletGeneration.current === generation && currentWallet.current === me) setQuickSending(false);
    }
  };

  const createDeal = () => {
    if (!isWallet(other?.wallet)) return;
    const q = new URLSearchParams({ seller: other!.wallet });
    if (subject) q.set('type', subject);
    const om = activeConversation?.orderMeta;
    if (om?.budget) q.set('budget', om.budget);
    if (om?.deadline) q.set('deadline', om.deadline);
    if (om?.paymentSplit) q.set('payment', om.paymentSplit);
    // Carry the conversation id so the newly created on-chain deal can be linked
    // back to this thread (and so roles can be reconciled to the on-chain truth).
    if (activeId) q.set('conversationId', activeId);
    router.push(`/deal/new?${q.toString()}`);
  };

  if (!hasMounted) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <Loader2 size={28} className="mx-auto text-zinc-600 mb-3 animate-spin" />
          <p className="text-sm text-zinc-400">Securing your messaging session…</p>
        </CardContent>
      </Card>
    );
  }

  if (!isConnected || !me) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <MessageSquare size={28} className="mx-auto text-zinc-600 mb-3" />
          <p className="text-sm text-zinc-400">Connect your wallet to access SynqChat.</p>
        </CardContent>
      </Card>
    );
  }

  if (walletStateOwner !== me) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <Loader2 size={28} className="mx-auto text-zinc-600 mb-3 animate-spin" />
          <p className="text-sm text-zinc-400">Securing your messaging session…</p>
        </CardContent>
      </Card>
    );
  }

  const showThread = !!activeConversation || !!draft;
  const activeCounterpartyWallet = String(other?.wallet || '');
  const activeCounterpartyIdentity = counterpartyIdentities[lc(activeCounterpartyWallet)];
  const activeCounterpartyProfile = counterpartyProfiles[lc(activeCounterpartyWallet)];
  const activeCounterpartyHandle = activeCounterpartyIdentity?.displayHandle || (draft?.username ? `@${draft.username}` : null);
  const activeCounterpartyLabel = activeCounterpartyHandle
    || activeCounterpartyProfile?.name
    || other?.name
    || (activeCounterpartyWallet ? shortenAddress(activeCounterpartyWallet) : 'New message');
  let latestSeenOutgoingId: string | null = null;
  if (activeId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message.conversationId === activeId
        && lc(message.fromWallet) === me
        && message.readAt
      ) {
        latestSeenOutgoingId = message.id;
        break;
      }
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] gap-4 lg:grid-cols-3 lg:grid-rows-1">
      {/* Conversation discovery and history */}
      <Card className="min-h-0 lg:col-span-1 lg:order-2 overflow-hidden flex flex-col">
        <div className="shrink-0 border-b border-zinc-800/60 bg-zinc-900/30 p-3">
          <div className="relative">
            <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              value={discoveryInput}
              onChange={(e) => setDiscoveryInput(e.target.value)}
              placeholder="@username or full wallet"
              aria-label="Synq username or wallet address"
              className="w-full rounded-lg border border-zinc-700/60 bg-zinc-800/60 py-2 pl-9 pr-9 text-sm text-white placeholder:text-zinc-500 outline-none transition-colors focus:border-blue-500/60"
            />
            {(discoveryLoading || (!discoveryInput.trim() && !listLoaded)) && (
              <Loader2 size={15} aria-label="Loading" className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-zinc-500" />
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {discoveryInput.trim() ? (
            <div className="space-y-3 p-3">
              {discoveryInput.trim().toLowerCase().startsWith('0x') && !isWallet(discoveryInput.trim()) && (
                <p className="text-xs text-zinc-500">Enter the complete wallet address to search.</p>
              )}
              {discoveryError && (
                <p className={cn('text-xs', discoveryError === 'No exact Synq user found.' ? 'text-zinc-500' : 'text-red-400')}>
                  {discoveryError}
                </p>
              )}
              {discoveryResult && (() => {
              const resultIdentity = counterpartyIdentities[lc(discoveryResult.wallet)];
              const resultHandle = resultIdentity?.displayHandle || (discoveryResult.username ? `@${discoveryResult.username}` : null);
              const resultLabel = resultHandle || discoveryResult.name || shortenAddress(discoveryResult.wallet);
              return (
                <button
                  type="button"
                  onClick={openDiscoveryResult}
                  className="w-full rounded-xl border border-zinc-700/60 bg-zinc-800/50 p-3 text-left flex items-center gap-3 hover:border-blue-500/50 hover:bg-blue-500/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-400/60 transition-all"
                >
                  <Avatar name={resultLabel} src={discoveryResult.avatar} size={38} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white truncate">{resultLabel}</p>
                    <p className="text-xs text-zinc-400 truncate">{shortenAddress(discoveryResult.wallet)}</p>
                  </div>
                  <span className="text-xs font-medium text-blue-400 shrink-0">Message</span>
                </button>
              );
            })()}
            </div>
          ) : (
            <>
              {conversations.length === 0 && listLoaded && (
                <div className="px-4 py-10 text-center">
                  <MessageSquare size={22} className="mx-auto mb-3 text-zinc-600" />
                  <p className="text-sm text-zinc-400">No chats yet. Search for someone above.</p>
                </div>
              )}
              {conversations.map((c) => {
            const o = counterpartyFor(c, me);
            const active = c.id === activeId;
            const cpWallet = String(o.wallet || '');
            const cpIdentity = counterpartyIdentities[lc(cpWallet)];
            const cpProfile = counterpartyProfiles[lc(cpWallet)];
            const cpHandle = cpIdentity?.displayHandle;
            const cpLabel = cpHandle || cpProfile?.name || o.name || (cpWallet ? shortenAddress(cpWallet) : 'Unknown wallet');
            return (
              <button
                key={c.id}
                onClick={() => openConversation(c)}
                className={cn(
                  'w-full text-left px-4 py-3 border-b border-zinc-800/40 flex items-center gap-3 hover:bg-zinc-800/40 transition-colors',
                  active && 'bg-blue-600/10',
                )}
              >
                <Avatar name={cpLabel} src={cpProfile?.avatar} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-white truncate">{cpLabel}</p>
                    {c.lastMessageAt && <span className="text-[10px] text-zinc-500 shrink-0">{formatTimeAgo(c.lastMessageAt)}</span>}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-zinc-500 truncate">{c.lastMessagePreview || c.subject || 'No messages yet'}</p>
                    {!!c.unread && <Badge variant="info" className="text-[10px] shrink-0">{c.unread}</Badge>}
                  </div>
                </div>
              </button>
            );
              })}
            </>
          )}
        </div>
      </Card>

      {/* Active thread */}
      <Card className="min-h-0 lg:col-span-2 lg:order-1 overflow-hidden flex flex-col">
        {!showThread ? (
          <CardContent className="flex-1 flex flex-col items-center justify-center text-center">
            <MessageSquare size={28} className="text-zinc-600 mb-3" />
            <p className="text-sm text-zinc-400">Select a chat or start a new conversation.</p>
          </CardContent>
        ) : (
          <>
            <div className="shrink-0 px-4 py-3 border-b border-zinc-800/60 flex items-center gap-3">
              <Avatar
                name={activeCounterpartyLabel}
                src={otherAvatar || activeCounterpartyProfile?.avatar}
                size={40}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white truncate">{activeCounterpartyLabel}</p>
                {other?.wallet && <p className="text-xs text-zinc-500 truncate">{shortenAddress(other.wallet)}</p>}
              </div>
            </div>

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 && (
                <div className="h-full flex items-center justify-center text-center">
                  <p className="text-sm text-zinc-500 max-w-xs">
                    {draft?.orderIntent
                      ? 'Fill in the order form below: requirements, budget, deadline and payment split. The seller gets an email right away.'
                      : 'No messages yet. Say hello.'}
                  </p>
                </div>
              )}
              {messages.map((m) => {
                const mine = lc(m.fromWallet) === me;
                const isOrder = m.kind === 'order';
                const isFile = m.kind === 'file';
                const isDealReceipt = m.kind === 'deal_receipt';
                const isDealProposal = m.kind === 'deal_proposal';
                const isPaymentReceipt = m.kind === 'payment_receipt';
                let filePayload: SynqFileMessagePayload | null = null;
                let dealReceiptPayload: SynqDealReceiptPayload | null = null;
                let dealProposalPayload: SynqDealProposalPayload | null = null;
                let paymentReceiptPayload: SynqPaymentReceiptPayload | null = null;
                if (isFile) {
                  try { filePayload = validateFileMessagePayload(m.payload); } catch { filePayload = null; }
                }
                if (isDealReceipt) {
                  try { dealReceiptPayload = validateDealReceiptPayload(m.payload); } catch { dealReceiptPayload = null; }
                }
                if (isDealProposal) {
                  try { dealProposalPayload = validateDealProposalPayload(m.payload); } catch { dealProposalPayload = null; }
                }
                if (isPaymentReceipt) {
                  try { paymentReceiptPayload = validatePaymentReceiptPayload(m.payload); } catch { paymentReceiptPayload = null; }
                }
                const om = m.orderMeta || {};
                const dealToken = dealReceiptPayload
                  ? getTokenInfo('sepolia', dealReceiptPayload.assetAddress)
                  : undefined;
                const dealBudget = dealReceiptPayload
                  ? dealToken
                    ? formatUnits(BigInt(dealReceiptPayload.totalValue), dealToken.decimals)
                    : dealReceiptPayload.totalValue
                  : '';
                const party = (wallet: string) => {
                  const normalized = lc(wallet);
                  const identity = counterpartyIdentities[normalized];
                  const profile = counterpartyProfiles[normalized];
                  return {
                    wallet,
                    name: profile?.name || (normalized === me ? myName : undefined),
                    handle: identity?.handle,
                    displayHandle: identity?.displayHandle,
                    avatar: profile?.avatar || null,
                  };
                };
                return (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}
                  >
                    <div
                      className={cn(
                        'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm break-words',
                        isDealProposal
                          ? 'bg-transparent p-0 w-full sm:max-w-[440px]'
                          : isDealReceipt
                          ? 'bg-transparent p-0 w-full sm:max-w-[440px]'
                          : isPaymentReceipt
                          ? 'bg-transparent p-0 w-full sm:max-w-[430px]'
                          : isFile
                          ? 'border border-zinc-700/60 bg-zinc-800/70 text-zinc-100 w-full sm:max-w-[430px]'
                          : isOrder
                          ? 'border border-blue-500/40 bg-blue-600/10 text-blue-50 rounded-tl-md w-full sm:max-w-[420px]'
                          : m.kind === 'confirm'
                            ? 'border border-emerald-500/40 bg-emerald-600/10 text-emerald-50 rounded-tl-md'
                            : mine
                              ? 'bg-blue-600 text-white rounded-tr-md'
                              : 'bg-zinc-800/60 border border-zinc-700/50 text-zinc-200 rounded-tl-md',
                      )}
                    >
                      {isOrder && (
                        <div className="space-y-2">
                          <div className="flex items-center gap-1.5 text-xs font-medium text-blue-300">
                            <Package size={12} /> Order Request{om.type ? ` · ${om.type}` : ''}
                            {orderConfirmed && (
                              <Badge variant="success" className="text-[10px] gap-1"><CheckCircle size={10} /> Confirmed</Badge>
                            )}
                          </div>
                          {om.requirements && (
                            <div className="text-sm text-blue-50 whitespace-pre-wrap">
                              <span className="block text-[10px] uppercase tracking-wide text-blue-300/80 mb-0.5">Requirements</span>
                              {om.requirements}
                            </div>
                          )}
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-blue-100/90">
                            {om.budget && (
                              <span className="flex items-center gap-1"><DollarSign size={12} /> {om.budget}</span>
                            )}
                            {om.deadline && (
                              <span className="flex items-center gap-1"><Calendar size={12} /> {new Date(om.deadline).toLocaleDateString()}</span>
                            )}
                            {om.paymentSplit && (
                              <span className="flex items-center gap-1">
                                <SplitSquareHorizontal size={12} />
                                {om.paymentSplit === '50/50' ? '50% now · 50% on approval' : 'Full in escrow'}
                              </span>
                            )}
                          </div>
                          {!om.requirements && m.body && (
                            <p className="text-sm text-blue-50 whitespace-pre-wrap">{m.body}</p>
                          )}
                        </div>
                      )}
                      {!isOrder && !isFile && !isDealReceipt && !isDealProposal && !isPaymentReceipt && m.kind !== 'confirm' && (
                        <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>
                      )}
                      {isDealReceipt && dealReceiptPayload && (
                        <DealReceipt
                          variant="chat"
                          title={dealReceiptPayload.title}
                          client={party(m.fromWallet)}
                          freelancer={party(m.toWallet)}
                          budget={dealBudget}
                          asset={{
                            symbol: dealToken?.symbol || 'Asset',
                            isErc20: !/^0x0{40}$/i.test(dealReceiptPayload.assetAddress),
                          }}
                          scope={dealReceiptPayload.scope}
                          deadline={dealReceiptPayload.deadline}
                          paymentStructure={dealReceiptPayload.paymentStructure}
                          protectionEnabled={dealReceiptPayload.protectionEnabled}
                          statusBadge="Created"
                          actions={(
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => router.push(`/deals/${dealReceiptPayload.dealAddress}`)}
                              className="w-full h-8 text-xs"
                            >
                              View Deal
                            </Button>
                          )}
                        />
                      )}
                      {isDealReceipt && !dealReceiptPayload && (
                        <span className="text-zinc-400">Deal receipt unavailable</span>
                      )}
                      {isDealProposal && dealProposalPayload && (
                        <DealProposalReceipt
                          payload={dealProposalPayload}
                          isSender={mine}
                          client={party(m.fromWallet)}
                          freelancer={party(m.toWallet)}
                        />
                      )}
                      {isDealProposal && !dealProposalPayload && (
                        <span className="text-zinc-400">Deal proposal receipt unavailable</span>
                      )}
                      {isPaymentReceipt && paymentReceiptPayload && (
                        <PaymentReceipt
                          payload={paymentReceiptPayload}
                          sent={mine}
                          timestamp={formatTimeAgo(m.createdAt)}
                        />
                      )}
                      {isPaymentReceipt && !paymentReceiptPayload && (
                        <span className="text-zinc-400">Payment receipt unavailable</span>
                      )}
                      {isFile && filePayload && (
                        <FileMessage messageId={m.id} payload={filePayload} authenticatedFetch={authenticatedFetch} />
                      )}
                      {isFile && !filePayload && (
                        <span className="text-zinc-400">Attachment unavailable</span>
                      )}
                      {m.kind === 'confirm' && (
                        <div className="flex items-center gap-1.5 text-sm text-emerald-200">
                          <CheckCircle size={14} /> {m.body}
                        </div>
                      )}
                      {(!isPaymentReceipt || !paymentReceiptPayload) && (
                        <div className={cn('text-[10px] mt-1', mine && !isOrder && !isFile && !isDealReceipt && !isDealProposal ? 'text-blue-200/70' : 'text-zinc-500')}>
                          {formatTimeAgo(m.createdAt)}
                        </div>
                      )}
                    </div>
                    {mine && m.id === latestSeenOutgoingId && (
                      <span className="mt-1 mr-1 text-[10px] text-zinc-500">Seen</span>
                    )}
                  </motion.div>
                );
              })}
            </div>

            {error && <p className="px-4 text-xs text-red-400">{error}</p>}

            <div className="shrink-0 p-3 border-t border-zinc-800/50">
              {draft?.orderIntent && !activeId ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-xs text-zinc-400 font-medium">
                    <Package size={14} className="text-blue-400" /> Place your order
                  </div>
                  <textarea
                    value={orderForm.requirements}
                    onChange={(e) => setOrderForm({ ...orderForm, requirements: e.target.value })}
                    rows={3}
                    placeholder="Describe your requirements and conditions…"
                    className="w-full bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-3 py-2 text-sm text-white placeholder:text-zinc-500 outline-none resize-none focus:border-blue-500/50 transition-all"
                  />
                  <div className="flex gap-3 flex-wrap">
                    <div className="flex-1 min-w-[140px]">
                      <label className="text-[10px] text-zinc-500 block mb-1">Budget</label>
                      <input
                        value={orderForm.budget}
                        onChange={(e) => setOrderForm({ ...orderForm, budget: e.target.value })}
                        placeholder="e.g. 0.5 ETH"
                        className="w-full bg-zinc-800/50 border border-zinc-700/50 rounded-lg px-3 py-1.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-blue-500/50 transition-all"
                      />
                    </div>
                    <div className="flex-1 min-w-[140px]">
                      <label className="text-[10px] text-zinc-500 block mb-1">Deadline</label>
                      <input
                        type="date"
                        value={orderForm.deadline}
                        onChange={(e) => setOrderForm({ ...orderForm, deadline: e.target.value })}
                        className="w-full bg-zinc-800/50 border border-zinc-700/50 rounded-lg px-3 py-1.5 text-sm text-white outline-none focus:border-blue-500/50 transition-all [color-scheme:dark]"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-500 block mb-1">Escrow payment</label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setOrderForm({ ...orderForm, paymentSplit: 'full' })}
                        className={cn(
                          'flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
                          orderForm.paymentSplit === 'full'
                            ? 'border-blue-500/50 bg-blue-600/20 text-blue-300'
                            : 'border-zinc-700/50 bg-zinc-800/50 text-zinc-400 hover:text-white hover:border-zinc-600',
                        )}
                      >
                        <SplitSquareHorizontal size={12} className="inline mr-1" /> Full in escrow
                      </button>
                      <button
                        onClick={() => setOrderForm({ ...orderForm, paymentSplit: '50/50' })}
                        className={cn(
                          'flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
                          orderForm.paymentSplit === '50/50'
                            ? 'border-blue-500/50 bg-blue-600/20 text-blue-300'
                            : 'border-zinc-700/50 bg-zinc-800/50 text-zinc-400 hover:text-white hover:border-zinc-600',
                        )}
                      >
                        <SplitSquareHorizontal size={12} className="inline mr-1" /> 50/50 Split
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      onClick={send}
                      disabled={sending || !orderForm.requirements.trim()}
                      className="gap-1.5"
                    >
                      {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                      {sending ? 'Placing…' : 'Place Order'}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {(selectedFile || attachmentError) && (
                    <div className="mb-2 flex items-center gap-2 rounded-lg border border-zinc-700/60 bg-zinc-900/40 px-3 py-2 text-xs">
                      <Paperclip size={14} className="shrink-0 text-blue-300" />
                      <div className="min-w-0 flex-1">
                        {selectedFile && <p className="truncate text-zinc-200">{selectedFile.name}</p>}
                        <p className={attachmentError ? 'text-red-300' : 'text-zinc-400'}>
                          {attachmentSending ? 'Sending…' : attachmentError || 'Ready to send'}
                        </p>
                      </div>
                      {attachmentError && selectedFile && (
                        <button type="button" onClick={() => sendAttachment(selectedFile)} className="text-blue-300 hover:text-blue-200">Retry</button>
                      )}
                      {!attachmentSending && (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedFile(null);
                            setAttachmentError('');
                            if (fileInputRef.current) fileInputRef.current.value = '';
                          }}
                          aria-label="Clear selected attachment"
                          className="text-zinc-400 hover:text-white"
                        ><X size={14} /></button>
                      )}
                    </div>
                  )}
                  <div className="relative flex items-end gap-2 bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-3 py-2 focus-within:border-blue-500/50 transition-all">
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        onClick={() => setAttachmentMenuOpen((open) => !open)}
                        disabled={attachmentSending}
                        title="More actions"
                        aria-label="More actions"
                        aria-expanded={attachmentMenuOpen}
                        className="p-2 rounded-lg border border-zinc-700/60 text-zinc-300 bg-zinc-900/30 hover:border-blue-500/50 hover:text-white disabled:opacity-50 transition-colors"
                      >
                        <Plus size={16} />
                      </button>
                      {attachmentMenuOpen && (
                        <div className="absolute bottom-full left-0 mb-2 w-40 rounded-xl border border-zinc-700/70 bg-zinc-900 p-1.5 shadow-xl z-20">
                          <button
                            type="button"
                            onClick={() => { setAttachmentMenuOpen(false); fileInputRef.current?.click(); }}
                            className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-400/60"
                          >
                            <Paperclip size={15} /> Attach file
                          </button>
                          <button
                            type="button"
                            onClick={() => { setAttachmentMenuOpen(false); setSendFundsOpen(true); }}
                            className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-400/60"
                          >
                            <Banknote size={15} /> Send funds
                          </button>
                        </div>
                      )}
                      <input
                        ref={fileInputRef}
                        type="file"
                        className="hidden"
                        accept=".jpg,.jpeg,.png,.webp,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,image/jpeg,image/png,image/webp,application/pdf,text/plain,text/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (!file) return;
                          setSelectedFile(file);
                          setAttachmentError('');
                          sendAttachment(file);
                        }}
                      />
                    </div>
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                      }}
                      rows={1}
                      placeholder={hasOrder && isBuyerOfOrder ? 'Type optional requirement… (Enter to send)' : 'Write a message… (Enter to send, Shift+Enter for a new line)'}
                      className="flex-1 bg-transparent text-sm text-white placeholder:text-zinc-500 outline-none resize-none max-h-32 py-1"
                    />
                    <button
                      onClick={send}
                      disabled={!input.trim() || sending || attachmentSending}
                      className="p-2 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all shrink-0"
                    >
                      {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    </button>
                  </div>
                </>
              )}
            </div>
            {isWallet(other?.wallet) && (
              <SendFundsModal
                key={`${me}:${activeId || `draft:${other.wallet}`}`}
                open={sendFundsOpen}
                onClose={() => setSendFundsOpen(false)}
                fromWallet={me}
                toWallet={other.wallet}
                recipientLabel={activeCounterpartyLabel}
                target={activeId ? { conversationId: activeId } : { toWallet: other.wallet }}
                authenticatedFetch={authenticatedFetch}
                onSynced={async (data) => {
                  const conversationId = data?.conversation?.id;
                  if (!conversationId || currentWallet.current !== me) return;
                  setDraft(null);
                  setActiveId(conversationId);
                  await Promise.all([loadThread(conversationId), loadList()]);
                }}
              />
            )}
          </>
        )}
      </Card>
    </div>
  );
}
