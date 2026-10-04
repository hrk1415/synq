'use client';

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { shortenAddress } from '@/lib/utils';
import { formatUsdcAmount } from '@/lib/deals/v2';
import type { CommitteeQueueItem } from '@/lib/deals/v2-committee-signer';
import { Scale, ArrowRight, Clock, ShieldAlert } from 'lucide-react';

interface CommitteeQueueProps {
  items: CommitteeQueueItem[];
  activeTab: 'initial' | 'final';
  onSelectMilestone: (item: CommitteeQueueItem) => void;
  isLoading?: boolean;
}

export function CommitteeQueue({
  items,
  activeTab,
  onSelectMilestone,
  isLoading,
}: CommitteeQueueProps) {
  const filtered = items.filter((item) =>
    activeTab === 'initial' ? item.phase === 'INITIAL_RESOLUTION' : item.phase === 'FINAL_RESOLUTION'
  );

  if (isLoading) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-8 text-center text-sm text-zinc-400">
        Loading committee queue items…
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-8 text-center space-y-2">
        <Scale className="mx-auto h-8 w-8 text-zinc-500" />
        <h4 className="text-sm font-semibold text-zinc-300">No Actionable Milestones</h4>
        <p className="text-xs text-zinc-500">
          {activeTab === 'initial'
            ? 'There are currently no disputed milestones requiring initial committee resolution.'
            : 'There are currently no milestones in final review requiring reconsideration.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {filtered.map((item) => {
        const isFinal = item.phase === 'FINAL_RESOLUTION';
        return (
          <Card
            key={`${item.dealAddress}-${item.milestoneId}-${item.phase}`}
            className="border-zinc-800 bg-zinc-950/60 hover:border-zinc-700 transition-colors"
          >
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={
                      isFinal
                        ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300 text-[10px]'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px]'
                    }
                  >
                    {isFinal ? 'FINAL REVIEW' : 'DISPUTED'}
                  </Badge>
                  <span className="text-xs font-mono text-zinc-400">
                    Milestone #{item.milestoneId + 1}
                  </span>
                </div>
                <div className="text-sm font-mono font-bold text-white">
                  {formatUsdcAmount(item.milestoneAmount)} USDC
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div>
                  <div className="text-[10px] text-zinc-500 uppercase">Deal Address</div>
                  <div className="font-mono text-zinc-300" title={item.dealAddress}>
                    {shortenAddress(item.dealAddress)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500 uppercase">Client</div>
                  <div className="font-mono text-zinc-300" title={item.client}>
                    {shortenAddress(item.client)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500 uppercase">Freelancer</div>
                  <div className="font-mono text-zinc-300" title={item.freelancer}>
                    {shortenAddress(item.freelancer)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500 uppercase">Committee</div>
                  <div className="font-mono text-zinc-300" title={item.authorizedCommittee}>
                    {shortenAddress(item.authorizedCommittee)}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end pt-2 border-t border-zinc-800/60">
                <Button
                  size="sm"
                  onClick={() => onSelectMilestone(item)}
                  className="h-7 text-xs bg-zinc-800 hover:bg-zinc-700 text-white flex items-center gap-1.5"
                >
                  <span>Review & Resolve</span>
                  <ArrowRight className="h-3 w-3" />
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
