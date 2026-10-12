'use client';

import React from 'react';
import {
  AlertCircle,
  Clock,
  CheckCircle2,
  Lock,
  ArrowRight,
  Plus,
  Wallet,
  Play,
  Send,
  ThumbsUp,
  Scale,
  LogIn,
  FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  DealNextAction as DealNextActionData,
  DealAttention,
  DealViewerRole,
  MilestoneStructInput,
  DealUXAnomaly,
} from '@/lib/deals/deriveDealUX';

interface DealNextActionProps {
  nextAction: DealNextActionData;
  attention: DealAttention;
  role: DealViewerRole;
  milestones?: MilestoneStructInput[] | null;
  anomalies?: DealUXAnomaly[];
  onTriggerPrimaryAction: (action: string, milestoneIndex: number | null) => void;
  isPending?: boolean;
}

export function DealNextAction({
  nextAction,
  attention,
  role,
  milestones,
  anomalies,
  onTriggerPrimaryAction,
  isPending = false,
}: DealNextActionProps) {
  const { headline, description, primaryAction, targetMilestoneIndex, actionOwner } = nextAction;

  const targetMilestone =
    targetMilestoneIndex !== null && milestones && milestones[targetMilestoneIndex]
      ? milestones[targetMilestoneIndex]
      : null;

  const getAttentionBadge = () => {
    switch (attention) {
      case 'action_required':
        return (
          <Badge variant="warning" className="gap-1 text-[11px] font-semibold tracking-wide">
            <AlertCircle size={12} /> Action Required By You
          </Badge>
        );
      case 'waiting_on_counterparty':
        return (
          <Badge variant="info" className="gap-1 text-[11px] font-medium">
            <Clock size={12} /> Waiting on {actionOwner === 'buyer' ? 'Client' : 'Freelancer'}
          </Badge>
        );
      case 'blocked':
        return (
          <Badge variant="destructive" className="gap-1 text-[11px] font-medium">
            <Lock size={12} /> Dispute Locked
          </Badge>
        );
      case 'resolved':
        return (
          <Badge variant="success" className="gap-1 text-[11px] font-medium">
            <CheckCircle2 size={12} /> Agreement Settled
          </Badge>
        );
      default:
        return (
          <Badge variant="secondary" className="gap-1 text-[11px] text-zinc-400">
            {role === 'disconnected' ? 'Unauthenticated' : 'Spectator Mode'}
          </Badge>
        );
    }
  };

  const getCTAConfig = () => {
    switch (primaryAction) {
      case 'ADD_MILESTONE':
        return {
          label: 'Add Milestone',
          icon: <Plus size={14} />,
          variant: 'default' as const,
        };
      case 'FUND_ESCROW':
        return {
          label: 'Fund Escrow',
          icon: <Wallet size={14} />,
          variant: 'default' as const,
        };
      case 'START_MILESTONE':
        return {
          label: 'Start Work',
          icon: <Play size={14} />,
          variant: 'default' as const,
        };
      case 'SUBMIT_MILESTONE':
        return {
          label: 'Submit Deliverable',
          icon: <Send size={14} />,
          variant: 'default' as const,
        };
      case 'APPROVE_MILESTONE':
        return {
          label: 'Review & Approve Payout',
          icon: <ThumbsUp size={14} />,
          variant: 'default' as const,
        };
      case 'DISPUTE_ACTION':
        return {
          label: 'Go to Dispute Resolution',
          icon: <Scale size={14} />,
          variant: 'outline' as const,
        };
      case 'CONNECT_WALLET':
        return {
          label: 'Connect Wallet',
          icon: <LogIn size={14} />,
          variant: 'default' as const,
        };
      default:
        return null;
    }
  };

  const ctaConfig = getCTAConfig();

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border p-5 transition-all',
        attention === 'action_required'
          ? 'border-blue-500/40 bg-gradient-to-r from-blue-950/30 via-zinc-900/60 to-zinc-900/40 shadow-lg shadow-blue-950/20'
          : attention === 'blocked'
            ? 'border-red-500/30 bg-red-950/20'
            : attention === 'resolved'
              ? 'border-green-500/20 bg-zinc-900/40'
              : 'border-zinc-800/80 bg-zinc-900/30'
      )}
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1.5 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {getAttentionBadge()}
            {targetMilestone && targetMilestoneIndex !== null && (
              <span className="flex items-center gap-1 text-xs text-zinc-400 font-mono">
                <FileText size={12} className="text-zinc-500" />
                Ms #{targetMilestoneIndex + 1}: {targetMilestone.title || `Milestone ${targetMilestoneIndex + 1}`}
              </span>
            )}
          </div>
          <h2 className="text-lg font-bold text-white tracking-tight">{headline}</h2>
          <p className="text-xs text-zinc-400 max-w-2xl leading-relaxed">{description}</p>
        </div>

        {ctaConfig && (
          <div className="shrink-0 pt-2 md:pt-0">
            <Button
              variant={ctaConfig.variant}
              size="default"
              className={cn(
                'gap-2 font-semibold shadow-md',
                attention === 'action_required' &&
                  'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/20'
              )}
              disabled={isPending}
              onClick={() => onTriggerPrimaryAction(primaryAction!, targetMilestoneIndex)}
            >
              {ctaConfig.icon}
              {ctaConfig.label}
              <ArrowRight size={14} className="opacity-70" />
            </Button>
          </div>
        )}
      </div>

      {/* Subtle anomaly notice if present */}
      {anomalies && anomalies.length > 0 && (
        <div className="mt-3 pt-3 border-t border-zinc-800/60 flex flex-col gap-1 text-[11px] text-amber-400/90">
          {anomalies.map((a, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertCircle size={12} className="mt-0.5 shrink-0 text-amber-400" />
              <span>{a.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
