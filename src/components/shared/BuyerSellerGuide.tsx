'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UserPlus, Wallet, PlayCircle, Send, ThumbsUp, HandCoins, Scale, Gavel, CheckCircle2, ArrowRight, HelpCircle, RotateCcw, ChevronDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const VIEWS = ['Buyer', 'Seller', 'Full Flow', 'FAQ'] as const;

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

// Answers are grounded strictly in the escrow behaviour described in the steps
// above (funds lock on funding, release only on approval, revisions, dispute
// freeze + admin resolve, per-milestone payment, on-chain proof) — no invented
// fees, tokens, or timelines.
const faqs: { q: string; a: string }[] = [
  {
    q: 'Is my money safe before the work is delivered?',
    a: 'Yes. When you fund a deal the full amount is locked inside the smart contract — nothing reaches the seller until you approve. Until then the funds stay under your control.',
  },
  {
    q: 'When does the seller actually get paid?',
    a: 'Only when you approve a milestone. That approved portion is released to the seller instantly on-chain; everything you have not approved stays locked in escrow.',
  },
  {
    q: 'What if I am not happy with the work?',
    a: 'Request a revision — you can ask for changes without losing a cent, because the money only moves when you approve. Nothing is released for work you have not accepted.',
  },
  {
    q: 'What happens if the buyer and seller cannot agree?',
    a: 'Either side can open a dispute. The escrow freezes instantly — neither party can move the money alone. Both sides agree on an outcome, or an admin force-resolves it.',
  },
  {
    q: 'How does the seller know the money is real?',
    a: 'Once the buyer funds the escrow, the agreed value is locked in the contract. The seller can start work knowing payment is guaranteed by the contract, not just a promise.',
  },
  {
    q: 'What are milestones?',
    a: 'Work can be delivered step by step. Each milestone is submitted, reviewed, and paid on its own — so the buyer pays for what they accept and the seller gets paid as they deliver.',
  },
  {
    q: 'How does the seller prove the work is done?',
    a: 'The seller submits the deliverable with proof attached (a hash or links), and the buyer is notified to review it before approving.',
  },
  {
    q: 'Do the buyer and seller have to trust each other?',
    a: 'No — the smart contract holds the funds and enforces the rules. The buyer cannot lose funds to non-delivery, and the seller cannot be denied payment for work that is approved.',
  },
];

function FaqList() {
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  return (
    <div className="space-y-2">
      {faqs.map((f, i) => {
        const isOpen = openFaq === i;
        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.05 }}
            className="rounded-xl bg-zinc-800/30 border border-zinc-800/50 overflow-hidden"
          >
            <button
              onClick={() => setOpenFaq(isOpen ? null : i)}
              className="w-full flex items-center gap-3 p-3 text-left"
            >
              <div className="shrink-0 w-7 h-7 rounded-full bg-blue-600/15 border border-blue-500/30 flex items-center justify-center">
                <HelpCircle size={13} className="text-blue-400" />
              </div>
              <span className="flex-1 text-sm font-semibold text-white">{f.q}</span>
              <ChevronDown size={16} className={cn('shrink-0 text-zinc-500 transition-transform', isOpen && 'rotate-180')} />
            </button>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  key="a"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <p className="text-xs text-zinc-300 px-3 pb-3 pl-[52px]">{f.a}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}
    </div>
  );
}

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
              <span className="text-[10px] text-zinc-400 font-mono">STEP {i + 1}</span>
              <span className="text-sm font-semibold text-white">{s.title}</span>
            </div>
            <p className="text-xs text-zinc-300 mt-0.5">{s.desc}</p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

export function BuyerSellerGuide({ showFaq = false }: { showFaq?: boolean }) {
  const [view, setView] = useState<(typeof VIEWS)[number]>('Buyer');
  // FAQ is only surfaced where it belongs (the Help page). On the escrow page
  // the guide stays a lean Buyer / Seller / Full Flow explainer — no FAQ tab.
  const views = showFaq ? VIEWS : VIEWS.filter((v) => v !== 'FAQ');

  return (
    <Card className="border-blue-500/20 bg-gradient-to-b from-blue-600/5 to-transparent">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HelpCircle size={18} className="text-blue-400" />
            <CardTitle className="text-lg">How Buyer &amp; Seller Work</CardTitle>
          </div>
          <div className="flex gap-1 bg-zinc-800/60 border border-zinc-700/50 rounded-lg p-1">
            {views.map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  'px-3 py-1 text-xs font-medium rounded-md transition-all',
                  view === v ? 'bg-blue-600 text-white' : 'text-zinc-300 hover:text-white'
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
                      <div className="text-xs text-zinc-300">{f.side}</div>
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
          {showFaq && view === 'FAQ' && (
            <motion.div key="faq" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="flex items-center gap-2 mb-3 text-amber-400 text-sm font-semibold">
                <HelpCircle size={15} /> Frequently Asked Questions
              </div>
              <FaqList />
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}