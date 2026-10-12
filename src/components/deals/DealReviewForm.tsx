'use client';

import React, { useState, useEffect } from 'react';
import { Star, Loader2, CheckCircle2, Pencil, CircleAlert, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StarRating } from '@/components/shared/StarRating';
import { useAuthSession } from '@/hooks/useAuthSession';
import { cn } from '@/lib/utils';

export interface DealReviewFormProps {
  dealAddress: string;
  sellerAddress: string;
  buyerAddress: string;
  isBuyer: boolean;
  isSelf: boolean;
}

export function DealReviewForm({
  dealAddress,
  sellerAddress,
  buyerAddress,
  isBuyer,
  isSelf,
}: DealReviewFormProps) {
  const { ensureAuthenticated } = useAuthSession();

  const [rating, setRating] = useState<number>(5);
  const [comment, setComment] = useState<string>('');
  const [hoverRating, setHoverRating] = useState<number | null>(null);

  const [loadingInitial, setLoadingInitial] = useState<boolean>(true);
  const [existingReview, setExistingReview] = useState<any>(null);
  const [isEditing, setIsEditing] = useState<boolean>(false);

  const [statusState, setStatusState] = useState<'idle' | 'authenticating' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');

  const normalizedDeal = (dealAddress || '').toLowerCase();
  const MAX_CHARS = 1000;

  // 1. Fetch existing reviews for this seller to detect if this dealAddress already has a verified review
  useEffect(() => {
    if (!dealAddress || !sellerAddress || !buyerAddress) {
      setLoadingInitial(false);
      return;
    }

    let cancelled = false;
    setLoadingInitial(true);

    fetch(`/api/reviews?seller=${encodeURIComponent(sellerAddress)}&reviewer=${encodeURIComponent(buyerAddress)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.reviews && Array.isArray(data.reviews)) {
          const matched = data.reviews.find(
            (r: any) =>
              r &&
              r.dealAddress &&
              String(r.dealAddress).toLowerCase() === normalizedDeal &&
              r.verifiedDeal === true
          );
          if (matched) {
            setExistingReview(matched);
            setRating(matched.rating || 5);
            setComment(matched.comment || '');
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingInitial(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dealAddress, sellerAddress, buyerAddress, normalizedDeal]);

  // Eligibility gating
  if (!isBuyer || isSelf) {
    return null;
  }

  if (loadingInitial) {
    return (
      <Card className="border-zinc-800 bg-zinc-900/50">
        <CardContent className="py-6 flex justify-center items-center gap-2 text-xs text-zinc-400">
          <Loader2 size={16} className="animate-spin text-blue-400" />
          <span>Checking deal review status...</span>
        </CardContent>
      </Card>
    );
  }

  // Submitted Review State (Read-only view with Edit option)
  if (existingReview && !isEditing) {
    return (
      <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-950/10 via-zinc-900/60 to-zinc-900/40">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={18} className="text-emerald-400" />
              <CardTitle className="text-base font-bold text-white">Review Submitted</CardTitle>
              <Badge variant="outline" className="text-[10px] px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border-emerald-500/30 font-medium">
                Verified Deal
              </Badge>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs border-zinc-700 hover:bg-zinc-800 text-zinc-300"
              onClick={() => {
                setErrorMessage('');
                setIsEditing(true);
              }}
            >
              <Pencil size={13} /> Edit Review
            </Button>
          </div>
          <CardDescription className="text-xs text-zinc-400">
            Your review is officially linked to this completed Synq deal contract.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-1">
          <div className="flex items-center gap-2">
            <StarRating value={existingReview.rating} readOnly size={14} />
            <span className="text-xs font-semibold text-white">{existingReview.rating} out of 5 stars</span>
          </div>
          {existingReview.comment && (
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3.5">
              <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">{existingReview.comment}</p>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // Active Submission / Editing Form
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');

    if (!comment.trim()) {
      setErrorMessage('Please enter a review comment before submitting.');
      return;
    }

    if (comment.trim().length > MAX_CHARS) {
      setErrorMessage(`Review comment cannot exceed ${MAX_CHARS} characters.`);
      return;
    }

    try {
      // Step 1: Ensure wallet session is authenticated (SIWE / Bearer JWT)
      setStatusState('authenticating');
      const token = await ensureAuthenticated();

      // Step 2: Submit verified review to POST /api/reviews
      setStatusState('submitting');
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          dealAddress,
          rating,
          comment: comment.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to submit review');
      }

      // Success
      setExistingReview(data.review);
      setStatusState('success');
      setIsEditing(false);
    } catch (err: any) {
      setStatusState('error');
      setErrorMessage(err.message || 'An unexpected error occurred while saving your review.');
    } finally {
      if (statusState !== 'success') {
        setStatusState('idle');
      }
    }
  };

  const isSubmitting = statusState === 'authenticating' || statusState === 'submitting';

  return (
    <Card className="border-blue-500/30 bg-gradient-to-br from-blue-950/15 via-zinc-900/80 to-zinc-900 shadow-md">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Sparkles size={18} className="text-amber-400" />
          <CardTitle className="text-base font-bold text-white">
            {existingReview ? 'Edit Your Provider Review' : 'Review Your Experience with this Freelancer'}
          </CardTitle>
          <Badge variant="outline" className="text-[10px] bg-blue-500/10 text-blue-300 border-blue-500/30">
            Verified Deal Review
          </Badge>
        </div>
        <CardDescription className="text-xs text-zinc-400">
          As the client of this completed agreement, your feedback will be published with a verified deal badge.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Star Rating Selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-300 block">Rating</label>
            <div className="flex items-center gap-1.5">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onClick={() => setRating(star)}
                  onMouseEnter={() => setHoverRating(star)}
                  onMouseLeave={() => setHoverRating(null)}
                  className="p-1 text-zinc-600 hover:text-amber-400 transition-colors focus:outline-none"
                  aria-label={`Rate ${star} stars`}
                >
                  <Star
                    size={22}
                    className={cn(
                      'transition-transform hover:scale-110',
                      (hoverRating !== null ? star <= hoverRating : star <= rating)
                        ? 'fill-amber-400 text-amber-400'
                        : 'text-zinc-600'
                    )}
                  />
                </button>
              ))}
              <span className="text-xs font-bold text-amber-400 ml-2">{rating} / 5 Stars</span>
            </div>
          </div>

          {/* Comment Textarea */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <label className="font-semibold text-zinc-300">Review Comment</label>
              <span className={cn('font-mono text-[11px]', comment.length > MAX_CHARS ? 'text-red-400 font-bold' : 'text-zinc-500')}>
                {comment.length} / {MAX_CHARS}
              </span>
            </div>
            <textarea
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Share your experience with the deliverables, communication, and execution on this deal..."
              className="w-full rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 text-xs text-white placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Neutral Trust Disclaimer */}
          <p className="text-[11px] text-zinc-400 italic">
            This review will be linked to this completed Synq deal.
          </p>

          {/* Error display */}
          {errorMessage && (
            <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-950/30 p-3 text-xs text-red-300">
              <CircleAlert size={15} className="shrink-0 text-red-400 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            {existingReview && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs text-zinc-400 border-zinc-700"
                onClick={() => {
                  setRating(existingReview.rating || 5);
                  setComment(existingReview.comment || '');
                  setIsEditing(false);
                  setErrorMessage('');
                }}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              className="gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-semibold text-xs shadow-md"
              disabled={isSubmitting || !comment.trim()}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {statusState === 'authenticating' ? 'Authenticating...' : 'Submitting Review...'}
                </>
              ) : (
                <>
                  <CheckCircle2 size={14} />
                  {existingReview ? 'Update Verified Review' : 'Submit Verified Review'}
                </>
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
