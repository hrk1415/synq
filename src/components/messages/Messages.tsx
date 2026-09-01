'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAccount } from 'wagmi';
import { motion } from 'framer-motion';
import { Send, Loader2, ShieldCheck, MessageSquare, Package, Store } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/shared/Avatar';
import { formatTimeAgo, cn } from '@/lib/utils';

interface Conversation {
  id: string;
  buyerWallet: string;
  sellerWallet: string;
  buyerName?: string;
  sellerName?: string;
  subject?: string;
  orderMeta?: { type?: string };
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
  kind?: 'text' | 'order';
  orderMeta?: { type?: string };
  createdAt: string;
  readAt?: string;
}

interface DraftTarget {
  wallet: string;
  name?: string;
  subject?: string;
  orderIntent?: boolean;
}

const lc = (w?: string) => String(w || '').toLowerCase();
const isWallet = (w?: string | null): w is string => !!w && /^0x[0-9a-fA-F]{40}$/.test(w);

function orderTemplate(type?: string | null) {
  const svc = type ? `${type} ` : '';
  return `Hi! I'd like to order your ${svc}service.\n\nMy requirements / conditions:\n- \n\nBudget: \nDeadline: `;
}

export default function Messages() {
  const router = useRouter();
  const params = useSearchParams();
  const { address, isConnected } = useAccount();
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

  const appliedParam = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);

  const myName = useMemo(() => {
    if (typeof window === 'undefined') return '';
    try {
      const raw = window.localStorage.getItem('settings:username');
      return raw ? (JSON.parse(raw) as string) : '';
    } catch { return ''; }
  }, []);

  const loadList = useCallback(async () => {
    if (!me) return;
    try {
      const res = await fetch(`/api/conversations?wallet=${me}`);
      const data = await res.json();
      if (Array.isArray(data.conversations)) setConversations(data.conversations);
    } catch { /* keep last list */ }
    finally { setListLoaded(true); }
  }, [me]);

  const loadThread = useCallback(async (id: string) => {
    if (!me || !id) return;
    try {
      const res = await fetch(`/api/messages?conversationId=${id}&wallet=${me}`);
      const data = await res.json();
      if (Array.isArray(data.messages)) setMessages(data.messages);
    } catch { /* keep last thread */ }
  }, [me]);

  // Initial + polled conversation list.
  useEffect(() => {
    if (!me) return;
    loadList();
    const t = setInterval(loadList, 10_000);
    return () => clearInterval(t);
  }, [me, loadList]);

  // Active thread: load on open, then poll every 3s (no WebSocket on Vercel).
  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    loadThread(activeId);
    const t = setInterval(() => loadThread(activeId), 3_000);
    return () => clearInterval(t);
  }, [activeId, loadThread]);

  // Apply the ?to / ?intent deep-link once the list is known.
  useEffect(() => {
    if (appliedParam.current || !me || !listLoaded) return;
    if (!isWallet(toParam)) { appliedParam.current = true; return; }
    if (lc(toParam) === me) { appliedParam.current = true; return; }
    appliedParam.current = true;
    const existing = conversations.find(
      (c) =>
        (lc(c.buyerWallet) === me && lc(c.sellerWallet) === lc(toParam)) ||
        (lc(c.sellerWallet) === me && lc(c.buyerWallet) === lc(toParam)),
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
      if (intentParam === 'order') setInput(orderTemplate(typeParam));
    }
  }, [me, listLoaded, conversations, toParam, nameParam, typeParam, intentParam]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) || null,
    [conversations, activeId],
  );

  // The person on the other side of the active thread (existing or draft).
  const other = useMemo(() => {
    if (activeConversation) {
      return lc(activeConversation.buyerWallet) === me
        ? { wallet: activeConversation.sellerWallet, name: activeConversation.sellerName }
        : { wallet: activeConversation.buyerWallet, name: activeConversation.buyerName };
    }
    if (draft) return { wallet: draft.wallet, name: draft.name };
    return null;
  }, [activeConversation, draft, me]);

  const subject = activeConversation?.subject || draft?.subject || '';

  // Fetch the other party's photo for the header.
  useEffect(() => {
    setOtherAvatar(null);
    if (!other?.wallet) return;
    let cancelled = false;
    fetch(`/api/profile?wallet=${other.wallet}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d?.avatar) setOtherAvatar(d.avatar); })
      .catch(() => { /* initials fallback */ });
    return () => { cancelled = true; };
  }, [other?.wallet]);

  // Auto-scroll to the newest message when the count grows.
  useEffect(() => {
    if (messages.length > prevCount.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
    prevCount.current = messages.length;
  }, [messages]);

  const openConversation = (c: Conversation) => {
    setDraft(null);
    setError('');
    setInput('');
    setActiveId(c.id);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !me || sending) return;
    if (!isWallet(other?.wallet)) { setError('No recipient selected.'); return; }
    const firstOrder = !!draft?.orderIntent && !activeId && messages.length === 0;
    setSending(true);
    setError('');
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromWallet: me,
          toWallet: other!.wallet,
          body: text,
          kind: firstOrder ? 'order' : 'text',
          orderMeta: firstOrder ? { type: draft?.subject } : undefined,
          fromName: myName || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error || 'Could not send message.'); return; }
      setInput('');
      setDraft(null);
      setActiveId(data.conversation.id);
      await Promise.all([loadThread(data.conversation.id), loadList()]);
    } catch {
      setError('Could not send message. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  };

  const createDeal = () => {
    if (!isWallet(other?.wallet)) return;
    const q = new URLSearchParams({ seller: other!.wallet });
    if (subject) q.set('type', subject);
    router.push(`/deal/new?${q.toString()}`);
  };

  if (!isConnected || !me) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <MessageSquare size={28} className="mx-auto text-zinc-600 mb-3" />
          <p className="text-sm text-zinc-400">Connect your wallet to see your messages and chat with buyers and sellers.</p>
        </CardContent>
      </Card>
    );
  }

  const showThread = !!activeConversation || !!draft;

  return (
    <div className="grid lg:grid-cols-3 gap-4 h-[520px]">
      {/* Conversation list */}
      <Card className="lg:col-span-1 overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-zinc-800/60 flex items-center justify-between">
          <span className="text-sm font-semibold text-white">Conversations</span>
          {!listLoaded && <Loader2 size={14} className="animate-spin text-zinc-500" />}
        </div>
        <div className="flex-1 overflow-y-auto">
          {draft && !conversations.some((c) => c.id === activeId && lc(other?.wallet) === lc(c.sellerWallet)) && (
            <button
              onClick={() => { /* already the active draft */ }}
              className={cn('w-full text-left px-4 py-3 border-b border-zinc-800/40 flex items-center gap-3', !activeId && 'bg-blue-600/10')}
            >
              <Avatar name={draft.name} src={otherAvatar} size={40} />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white truncate">{draft.name || `${draft.wallet.slice(0, 6)}…${draft.wallet.slice(-4)}`}</p>
                <p className="text-xs text-zinc-500 truncate">New order · draft</p>
              </div>
            </button>
          )}
          {conversations.length === 0 && !draft && listLoaded && (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-zinc-400 mb-3">No conversations yet.</p>
              <Button size="sm" variant="outline" onClick={() => router.push('/marketplace')} className="gap-1.5">
                <Store size={14} /> Browse the Deal Port
              </Button>
            </div>
          )}
          {conversations.map((c) => {
            const o = lc(c.buyerWallet) === me
              ? { wallet: c.sellerWallet, name: c.sellerName }
              : { wallet: c.buyerWallet, name: c.buyerName };
            const active = c.id === activeId;
            return (
              <button
                key={c.id}
                onClick={() => openConversation(c)}
                className={cn(
                  'w-full text-left px-4 py-3 border-b border-zinc-800/40 flex items-center gap-3 hover:bg-zinc-800/40 transition-colors',
                  active && 'bg-blue-600/10',
                )}
              >
                <Avatar name={o.name} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-white truncate">{o.name || `${o.wallet.slice(0, 6)}…${o.wallet.slice(-4)}`}</p>
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
        </div>
      </Card>

      {/* Active thread */}
      <Card className="lg:col-span-2 overflow-hidden flex flex-col">
        {!showThread ? (
          <CardContent className="flex-1 flex flex-col items-center justify-center text-center">
            <MessageSquare size={28} className="text-zinc-600 mb-3" />
            <p className="text-sm text-zinc-400">Select a conversation, or order a freelancer from the Deal Port to start one.</p>
          </CardContent>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-zinc-800/60 flex items-center gap-3">
              <Avatar name={other?.name} src={otherAvatar} size={40} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white truncate">
                  {other?.name || (other?.wallet ? `${other.wallet.slice(0, 6)}…${other.wallet.slice(-4)}` : 'New message')}
                </p>
                {subject && <p className="text-xs text-zinc-500 truncate">Re: {subject}</p>}
              </div>
              <Button size="sm" variant="outline" onClick={createDeal} className="gap-1.5 shrink-0">
                <ShieldCheck size={14} /> Create escrow deal
              </Button>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 && (
                <div className="h-full flex items-center justify-center text-center">
                  <p className="text-sm text-zinc-500 max-w-xs">
                    {draft?.orderIntent
                      ? 'Describe your order and conditions below, then send. The seller gets an email right away.'
                      : 'No messages yet. Say hello 👋'}
                  </p>
                </div>
              )}
              {messages.map((m) => {
                const mine = lc(m.fromWallet) === me;
                const isOrder = m.kind === 'order';
                return (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn('flex', mine ? 'justify-end' : 'justify-start')}
                  >
                    <div
                      className={cn(
                        'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words',
                        isOrder
                          ? 'border border-blue-500/40 bg-blue-600/10 text-blue-50 rounded-tl-md'
                          : mine
                            ? 'bg-blue-600 text-white rounded-tr-md'
                            : 'bg-zinc-800/60 border border-zinc-700/50 text-zinc-200 rounded-tl-md',
                      )}
                    >
                      {isOrder && (
                        <div className="flex items-center gap-1.5 mb-1 text-xs font-medium text-blue-300">
                          <Package size={12} /> Order{m.orderMeta?.type ? ` · ${m.orderMeta.type}` : ''}
                        </div>
                      )}
                      {m.body}
                      <div className={cn('text-[10px] mt-1', mine && !isOrder ? 'text-blue-200/70' : 'text-zinc-500')}>
                        {formatTimeAgo(m.createdAt)}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {error && <p className="px-4 text-xs text-red-400">{error}</p>}

            <div className="p-3 border-t border-zinc-800/50">
              <div className="flex items-end gap-2 bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-3 py-2 focus-within:border-blue-500/50 transition-all">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                  }}
                  rows={1}
                  placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
                  className="flex-1 bg-transparent text-sm text-white placeholder:text-zinc-500 outline-none resize-none max-h-32 py-1"
                />
                <button
                  onClick={send}
                  disabled={!input.trim() || sending}
                  className="p-2 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all shrink-0"
                >
                  {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                </button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
