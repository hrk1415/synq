'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UserPlus, Wallet, PlayCircle, Send, ThumbsUp, HandCoins, Scale, Gavel, CheckCircle2, ArrowRight, HelpCircle, RotateCcw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const VIEWS = ['Buyer', 'Seller', 'Full Flow'] as const;

type Step = { icon: typeof Wallet; title: string; desc: string };

const buyerSteps: Step[] = [
  { icon: UserPlus, title: 'Create a Deal', desc: 'Pick the seller and describe the deliverables. Funds stay 100% in your control — nothing is sent to the seller yet.' },
  { icon: Wallet, title: 'Fund the Escrow', desc: 'Lock the full amount into the smart contract. Now the seller knows the money is real and secured.' },
  { icon: CheckCircle2, title: 'Approve Milestones', desc: 'When the seller submits work, review it. Approve only what you accept — that portion is released to the seller, the rest stays locked.' },
  { icon: RotateCcw, title: 'Request Revision', desc: 'Not satisfied? Request changes without losing a cent. The money only moves when you approve.' },
  { icon: Scale, title: 'Open Dispute (if needed)', desc: 'Something went wrong? Open a dispute — escrow freezes. Both sides agree on an outcome, or an admin can force-resolve it.' },
] as const;

const sellerSteps: Step[] = [
  { icon: UserPlus, title: 'Accept the Deal', desc: 'A buyer creates a deal with you as the seller. Accept the terms — the agreed value is now locked in escrow.' },
  { icon: PlayCircle, title: 'Start Work', desc: 'Begin the milestone once it is in progress. Work with the peace of mind that payment is guaranteed by the contract.' },
  { icon: Send, title: 'Submit Evidence', desc: 'Deliver the work and attach proof (hash/links). The buyer gets notified to review.' },
  { icon: ThumbsUp, title: 'Get Paid on Approval', desc: 'When the buyer approves, the milestone amount is released to you instantly — no invoices, no chasing payments.' },
  { icon: HandCoins, title: 'Escrow Balance Paid', desc: 'After the final milestone is approved, the deal completes and your full payment is received on-chain.' },
] as const;

const flowStages = [
  { label: 'Create Deal', side: 'Buyer proposes terms with a seller' },
  { label: 'Fund Escrow', side: 'Buyer locks the full amount' },
  { label: 'Work in Milestones', side: 'Seller delivers step by step' },
  { label: 'Submit + Approve', side: 'Seller submits, buyer verifies' },
  { label: 'Release Payment', side: 'Approved portion → seller' },
  { label: 'Complete / Dispute', side: 'Deal completes, or dispute is resolved' },
] as const;

function StepList({ steps }: { steps: Step[] }) {
  return (
    <div className="space-y-3">
      {steps.map((s, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.08 }}
          className="flex gap-3 p-3 rounded-xl bg-zinc-800/30 border border-zinc-800/50"
        >
          <div className="shrink-0 w-9 h-9 rounded-full bg-blue-600/15 border border-blue-500/30 flex items-center justify-center">
            <s.icon size={16} className="text-blue-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500 font-mono">STEP {i + 1}</span>
              <span className="text-sm font-semibold text-white">{s.title}</span>
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">{s.desc}</p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

export function BuyerSellerGuide() {
  const [view, setView] = useState<(typeof VIEWS)[number]>('Buyer');

  return (
    <Card className="border-blue-500/20 bg-gradient-to-b from-blue-600/5 to-transparent">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HelpCircle size={18} className="text-blue-400" />
            <CardTitle className="text-lg">How Buyer &amp; Seller Work</CardTitle>
          </div>
          <div className="flex gap-1 bg-zinc-800/60 border border-zinc-700/50 rounded-lg p-1">
            {VIEWS.map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  'px-3 py-1 text-xs font-medium rounded-md transition-all',
                  view === v ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-white'
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <CardDescription>
          The two sides of every deal — what each one does, and how the money flows.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AnimatePresence mode="wait">
          {view === 'Buyer' && (
            <motion.div key="buyer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="flex items-center gap-2 mb-3 text-blue-400 text-sm font-semibold">
                <Wallet size={15} /> The Buyer&apos;s Journey — pays, protects, verifies
              </div>
              <StepList steps={buyerSteps} />
            </motion.div>
          )}
          {view === 'Seller' && (
            <motion.div key="seller" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="flex items-center gap-2 mb-3 text-emerald-400 text-sm font-semibold">
                <HandCoins size={15} /> The Seller&apos;s Journey — works, submits, gets paid
              </div>
              <StepList steps={sellerSteps} />
            </motion.div>
          )}
          {view === 'Full Flow' && (
            <motion.div key="flow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="flex items-center gap-2 mb-3 text-violet-400 text-sm font-semibold">
                <Gavel size={15} /> The Escrow Pipeline
              </div>
              <div className="space-y-2">
                {flowStages.map((f, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.08 }}
                    className="flex items-center gap-3"
                  >
                    <div className="shrink-0 w-8 h-8 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-400">
                      {i + 1}
                    </div>
                    <div className="flex-1 p-3 rounded-lg bg-zinc-800/30 border border-zinc-800/50">
                      <div className="text-sm font-semibold text-white">{f.label}</div>
                      <div className="text-xs text-zinc-400">{f.side}</div>
                    </div>
                    {i < flowStages.length - 1 && <ArrowRight size={14} className="text-zinc-600 shrink-0" />}
                  </motion.div>
                ))}
              </div>
              <div className="mt-4 p-3 rounded-lg bg-amber-600/10 border border-amber-500/20 text-xs text-amber-300 flex items-center gap-2">
                <Scale size={13} className="shrink-0" />
                Dispute? Escrow freezes instantly — neither side moves the money alone. Both must agree, or an admin force-resolves.
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}