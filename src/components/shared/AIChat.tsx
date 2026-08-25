'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Bot, User, Sparkles, Loader2, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

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

interface ChatMessage {
  id: string;
  role: 'user' | 'ai' | 'system';
  content: string;
  timestamp: string;
  sellers?: SellerResult[];
}

interface AIChatProps {
  placeholder?: string;
  onSend?: (message: string) => void;
  messages?: ChatMessage[];
  className?: string;
  height?: string;
}

const SELLER_INTENT = /\b(find|suggest|suggest me|recommend|marketplace|freelancer|freelance|seller|hire|someone|someone who|khoj|khuje|darkar|dorkar|lagbe|chai|need|looking for|buy|order|contractor|developer|designer|expert|help me find)\b|\b(deal|freelancer|seller)\s+(find|khoj|khuje|needed|dorkar|darkar|lagbe|dekh)\b|\bfind\s+(me|someone|a|an|the)?\s*(deal|seller|freelancer|developer|designer|expert)\b/i;

const thinkingPhrases = [
  'Analyzing your request...',
  'Checking deal conditions...',
  'Consulting AI agents...',
  'Evaluating risk factors...',
  'Preparing response...',
];

export default function AIChat({ placeholder = 'Ask Synq to negotiate, protect, or pay...', onSend, messages: externalMessages, className, height }: AIChatProps) {
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingText, setThinkingText] = useState(thinkingPhrases[0]);
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const messages = externalMessages || localMessages;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking]);

  useEffect(() => {
    if (isThinking) {
      const interval = setInterval(() => {
        setThinkingText(prev => {
          const idx = thinkingPhrases.indexOf(prev);
          return thinkingPhrases[(idx + 1) % thinkingPhrases.length];
        });
      }, 2000);
      return () => clearInterval(interval);
    }
  }, [isThinking]);

  const handleSend = async () => {
    if (!input.trim() || isThinking) return;
    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: input, timestamp: new Date().toISOString() };
    setLocalMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsThinking(true);

    if (onSend) {
      onSend(input);
      setTimeout(() => setIsThinking(false), 1500);
    } else {
      try {
        const isSellerSearch = SELLER_INTENT.test(input);
        const res = await fetch('/api/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isSellerSearch ? { type: 'find', prompt: input } : { type: 'negotiate', prompt: input }),
        });
        const data = await res.json();
        const result = data?.result || {};
        const aiMsg: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: 'ai',
          content: Array.isArray(result.sellers)
            ? (result.message || (result.sellers.length > 0 ? `Found ${result.sellers.length} matching seller(s).` : 'No sellers found.'))
            : (result.message || 'Here are some options. Try describing a budget and timeline for better suggestions.'),
          timestamp: new Date().toISOString(),
          sellers: Array.isArray(result.sellers) ? result.sellers : undefined,
        };
        setLocalMessages(prev => [...prev, aiMsg]);
      } catch {
        setLocalMessages(prev => [...prev, {
          id: (Date.now() + 1).toString(),
          role: 'system',
          content: 'Sorry, the AI service is unavailable right now. Please try again.',
          timestamp: new Date().toISOString(),
        }]);
      }
      setIsThinking(false);
    }
  };

  return (
    <div className={cn('flex flex-col rounded-xl bg-zinc-950/60 backdrop-blur-md', className)} style={{ height }}>
      <div className="flex-1 overflow-y-auto space-y-4 p-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center mb-4">
              <Sparkles size={24} className="text-white" />
            </div>
            <p className="text-zinc-400 text-sm max-w-md">
              {placeholder}
            </p>
          </div>
        )}
        <AnimatePresence>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn('flex gap-3', msg.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              {msg.role === 'ai' && (
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shrink-0">
                  <Bot size={16} className="text-white" />
                </div>
              )}
              <div className={cn(
                'max-w-[80%] rounded-2xl px-4 py-3 text-sm',
                msg.role === 'user'
                  ? 'bg-blue-600 text-white rounded-tr-md'
                  : msg.role === 'ai'
                  ? 'bg-zinc-800/50 border border-zinc-700/50 text-zinc-200 rounded-tl-md'
                  : 'bg-zinc-800/30 text-zinc-400 text-center'
              )}>
                {msg.content}
                {msg.sellers && msg.sellers.length > 0 && (
                  <div className="space-y-2 mt-3">
                    {msg.sellers.map((s, i) => (
                      <div key={s.wallet} className="p-3 rounded-xl border border-zinc-700/50 bg-zinc-900/60">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-white truncate">
                              {i === 0 && <span className="text-amber-400 mr-1">★</span>}
                              {s.name}
                              {!s.available && <span className="ml-1.5 text-[10px] text-zinc-500">(busy)</span>}
                            </div>
                            <div className="text-[11px] text-zinc-400">
                              {s.category} · {(s.skills || []).join(', ')}
                            </div>
                            <div className="font-mono text-[10px] text-zinc-500">
                              {s.wallet.slice(0, 10)}...{s.wallet.slice(-6)}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-xs font-bold text-emerald-400">{s.match}% match</div>
                            <div className="text-[10px] text-zinc-500">{Number(s.rate) / 1e18 || 0} ETH</div>
                          </div>
                        </div>
                        {s.bio && <p className="text-[11px] text-zinc-400 line-clamp-2">{s.bio}</p>}
                        <Link
                          href={`/deal/new?seller=${s.wallet}&type=${encodeURIComponent(s.category)}`}
                          className="mt-2 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-all"
                        >
                          Order {s.name} <ArrowRight size={12} />
                        </Link>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {msg.role === 'user' && (
                <div className="w-8 h-8 rounded-lg bg-zinc-700 flex items-center justify-center shrink-0">
                  <User size={16} className="text-zinc-300" />
                </div>
              )}
            </motion.div>
          ))}
          {isThinking && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shrink-0">
                <Bot size={16} className="text-white" />
              </div>
              <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-2xl rounded-tl-md px-4 py-3">
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <Loader2 size={14} className="animate-spin text-blue-400" />
                  {thinkingText}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 border-t border-zinc-800/50 bg-zinc-950/60">
        <div className="flex items-center gap-2 bg-zinc-800/70 border border-zinc-700/50 rounded-xl px-4 py-2 focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/20 transition-all">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-sm text-white placeholder:text-zinc-500 outline-none"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isThinking}
            className="p-2 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
