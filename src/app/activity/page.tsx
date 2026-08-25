'use client';

import { motion } from 'framer-motion';
import { Activity, CheckCircle, AlertTriangle, Bot, Shield, Wallet, FileCheck, TrendingUp, Loader2, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAccount, useChainId } from 'wagmi';
import { useActivity, ActivityItem } from '@/hooks/useActivity';
import { formatTimeAgo, cn } from '@/lib/utils';
import { getExplorerUrl } from '@/lib/chain';

const activityIcons: Record<string, { icon: any; color: string }> = {
  deal_created: { icon: FileCheck, color: 'text-blue-400 bg-blue-400/10' },
  milestone_completed: { icon: CheckCircle, color: 'text-green-400 bg-green-400/10' },
  payment_sent: { icon: Wallet, color: 'text-emerald-400 bg-emerald-400/10' },
  payment_released: { icon: Wallet, color: 'text-emerald-400 bg-emerald-400/10' },
  payment_received: { icon: Wallet, color: 'text-green-400 bg-green-400/10' },
  dispute_opened: { icon: AlertTriangle, color: 'text-red-400 bg-red-400/10' },
  dispute_resolved: { icon: CheckCircle, color: 'text-green-400 bg-green-400/10' },
  deal_completed: { icon: TrendingUp, color: 'text-green-400 bg-green-400/10' },
  deal_cancelled: { icon: XCircle, color: 'text-zinc-400 bg-zinc-400/10' },
  protection_activated: { icon: Shield, color: 'text-violet-400 bg-violet-400/10' },
  risk_alert: { icon: AlertTriangle, color: 'text-amber-400 bg-amber-400/10' },
  agent_action: { icon: Bot, color: 'text-blue-400 bg-blue-400/10' },
};

export default function ActivityPage() {
  const { address } = useAccount();
  const chainId = useChainId();
  const { items, loading } = useActivity(30);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Activity</h1>
        <p className="text-zinc-400 text-sm mt-1">All your on-chain deal and agent activity in one place.</p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Track what's happening with your deals</CardDescription>
          </div>
          <Badge variant="info" className="text-[10px]">Live on-chain</Badge>
        </CardHeader>
        <CardContent>
          {!address ? (
            <div className="text-center py-12">
              <p className="text-zinc-500 text-sm">Connect your wallet to see your on-chain activity.</p>
            </div>
          ) : loading ? (
            <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-blue-400" /></div>
          ) : items.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-zinc-500 text-sm">No on-chain activity yet. Create a deal to get started.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {items.map((act: ActivityItem, i: number) => {
                const meta = activityIcons[act.type] || { icon: Activity, color: 'text-zinc-400 bg-zinc-400/10' };
                const Icon = meta.icon;
                const explorerUrl = act.txHash ? getExplorerUrl(chainId, 'tx', act.txHash) : null;
                return (
                  <motion.div
                    key={act.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="flex items-start gap-4 p-3 rounded-lg hover:bg-zinc-800/30 transition-colors"
                  >
                    <div className={cn('p-2 rounded-xl', meta.color)}>
                      <Icon size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white font-medium">{act.title}</p>
                      <p className="text-xs text-zinc-400">{act.description}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="text-xs text-zinc-500">{formatTimeAgo(act.timestamp)}</span>
                      {act.amount !== undefined && <span className="text-xs font-medium text-white">{act.amount.toFixed(4)} ETH</span>}
                      {explorerUrl && (
                        <a href={explorerUrl} target="_blank" rel="noreferrer" className="text-[10px] text-blue-400 hover:text-blue-300">View tx ↗</a>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
