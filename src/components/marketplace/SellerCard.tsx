'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Briefcase, Users, ArrowRight, MessageSquare, X, Loader2, CheckCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatUnits } from 'viem';
import { StarRating } from '@/components/shared/StarRating';
import { shortenAddress, formatTimeAgo, cn } from '@/lib/utils';

interface Review {
  id: string;
  reviewerWallet: string;
  reviewerName?: string;
  rating: number;
  comment: string;
  createdAt: string;
  updatedAt?: string;
}

interface Summary {
  average: number;
  count: number;
  breakdown: Record<string, number>;
}

const EMPTY_SUMMARY: Summary = { average: 0, count: 0, breakdown: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } };

function Avatar({ name }: { name: string }) {
  const initials = (name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const hues = ['from-blue-500 to-violet-600', 'from-emerald-500 to-teal-600', 'from-orange-500 to-red-600', 'from-pink-500 to-rose-600'];
  const hue = hues[(name.length + name.charCodeAt(0)) % hues.length];
  return (
    <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${hue} flex items-center justify-center text-white font-bold text-sm shrink-0`}>
      {initials || '?'}
    </div>
  );
}

function myDisplayName(): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = window.localStorage.getItem('settings:username');
    return raw ? String(JSON.parse(raw)) : '';
  } catch { return ''; }
}

export function SellerCard({
  profile,
  me,
  isConnected,
  onOrder,
}: {
  profile: any;
  me?: string;
  isConnected: boolean;
  onOrder: (p: any) => void;
}) {
  const wallet = String(profile.wallet);
  const isMe = !!me && wallet.toLowerCase() === me.toLowerCase();

  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [mine, setMine] = useState<Review | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ seller: wallet });
      if (me) q.set('reviewer', me);
      const res = await fetch(`/api/reviews?${q.toString()}`);
      const data = await res.json();
      if (data?.summary) setSummary(data.summary);
      if (Array.isArray(data?.reviews)) setReviews(data.reviews);
      setMine(data?.mine || null);
    } catch { /* keep last */ }
    finally { setLoaded(true); }
  }, [wallet, me]);

  useEffect(() => { load(); }, [load]);

  // Reflect the saved review in the form (also resets when switching wallet).
  useEffect(() => {
    setRating(mine?.rating || 0);
    setComment(mine?.comment || '');
  }, [mine]);

  const submit = async () => {
    if (!me) { setError('Connect your wallet first'); return; }
    if (rating < 1) { setError('Pick a star rating'); return; }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sellerWallet: wallet,
          reviewerWallet: me,
          rating,
          comment,
          reviewerName: myDisplayName() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error || 'Could not save review'); return; }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      await load();
    } catch {
      setError('Could not save review. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const rate = Number(formatUnits(BigInt(profile.rate || 0), 18));

  return (
    <>
      <Card className="group hover:border-blue-500/30 transition-all h-full">
        <CardContent className="p-5 flex flex-col h-full">
          <div className="flex items-start gap-3 mb-3">
            <Avatar name={String(profile.name || '')} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-white truncate">{String(profile.name || 'Anonymous')}</h3>
                {isMe && <Badge variant="info" className="text-[10px]">You</Badge>}
                {!profile.available && <Badge variant="secondary" className="text-[10px]">Busy</Badge>}
              </div>
              <div className="flex items-center gap-2 text-xs text-zinc-400 mt-0.5">
                <Briefcase size={12} /> {String(profile.category || '-')}
              </div>
              <div className="font-mono text-[10px] text-zinc-400 mt-0.5">{shortenAddress(wallet)}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-sm font-bold text-white">{rate} <span className="text-xs text-zinc-400">ETH</span></div>
              <div className="text-[10px] text-zinc-400">rate/project</div>
            </div>
          </div>

          <p className="text-sm text-zinc-300 mb-3 line-clamp-2">{String(profile.bio || '')}</p>

          <div className="flex flex-wrap gap-1.5 mb-4">
            {(profile.skills || []).slice(0, 4).map((s: string) => (
              <span key={s} className="px-2 py-0.5 rounded-md bg-zinc-800/60 text-[10px] text-zinc-300">{s}</span>
            ))}
          </div>

          <div className="flex items-center gap-4 text-xs text-zinc-300 mt-auto mb-4">
            <button type="button" onClick={() => setOpen(true)} className="hover:opacity-80 transition-opacity" aria-label="See reviews">
              <StarRating value={summary.average} readOnly count={summary.count} />
            </button>
            <span className="flex items-center gap-1">
              <Users size={12} className="text-blue-400" /> {Number(profile.completedDeals)} deals
            </span>
          </div>

          <Button onClick={() => onOrder(profile)} disabled={isMe} className="w-full gap-2">
            <ArrowRight size={16} />
            {isMe ? 'This is you' : 'Order This Freelancer'}
          </Button>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="w-full mt-2 text-xs text-zinc-300 hover:text-white transition-colors flex items-center justify-center gap-1.5"
          >
            <MessageSquare size={12} /> {summary.count > 0 ? `Reviews (${summary.count})` : (isMe ? 'No reviews yet' : 'Write the first review')}
          </button>
        </CardContent>
      </Card>

      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-md rounded-2xl border border-zinc-700/50 bg-zinc-900 shadow-2xl flex flex-col max-h-[85vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 p-5 border-b border-zinc-800/60">
              <Avatar name={String(profile.name || '')} />
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-white truncate">{String(profile.name || 'Anonymous')}</h3>
                <div className="mt-1"><StarRating value={summary.average} readOnly count={summary.count} /></div>
              </div>
              <button onClick={() => setOpen(false)} className="text-zinc-400 hover:text-white transition-colors shrink-0" aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {!loaded ? (
                <div className="flex justify-center py-6"><Loader2 size={20} className="animate-spin text-zinc-400" /></div>
              ) : reviews.length === 0 ? (
                <p className="text-sm text-zinc-400 text-center py-6">No reviews yet.{!isMe && ' Be the first to leave one.'}</p>
              ) : (
                reviews.map((r) => {
                  const own = !!me && String(r.reviewerWallet).toLowerCase() === me.toLowerCase();
                  return (
                    <div key={r.id} className="rounded-xl border border-zinc-800/60 bg-zinc-800/30 p-3">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-sm text-white truncate">
                          {r.reviewerName || shortenAddress(String(r.reviewerWallet))}
                          {own && <span className="text-[10px] text-blue-400 ml-1.5">(you)</span>}
                        </span>
                        <StarRating value={r.rating} readOnly size={12} />
                      </div>
                      {r.comment && <p className="text-sm text-zinc-300 whitespace-pre-wrap break-words">{r.comment}</p>}
                      <p className="text-[10px] text-zinc-600 mt-1">{formatTimeAgo(r.updatedAt || r.createdAt)}</p>
                    </div>
                  );
                })
              )}
            </div>

            <div className="border-t border-zinc-800/60 p-5">
              {!isConnected ? (
                <p className="text-sm text-zinc-300 text-center">Connect your wallet to leave a review.</p>
              ) : isMe ? (
                <p className="text-sm text-zinc-400 text-center">This is your profile — you can't review yourself.</p>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-zinc-200">{mine ? 'Update your rating' : 'Your rating'}</span>
                    <StarRating value={rating} onChange={setRating} size={22} />
                  </div>
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={3}
                    maxLength={600}
                    placeholder="Share your experience with this freelancer (optional)"
                    className="w-full bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-3 py-2 text-sm text-white placeholder:text-zinc-400 outline-none resize-none focus:border-blue-500/50 transition-all"
                  />
                  {error && <p className="text-xs text-red-400">{error}</p>}
                  {saved && (
                    <p className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle size={12} /> Review saved</p>
                  )}
                  <Button onClick={submit} disabled={submitting || rating < 1} className="w-full gap-2">
                    {submitting ? <Loader2 size={16} className="animate-spin" /> : null}
                    {mine ? 'Update review' : 'Submit review'}
                  </Button>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </>
  );
}
