'use client';

import { HelpCircle, Bot, ShieldCheck, Wallet, FileCheck, Scale, MessageCircle, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BuyerSellerGuide } from '@/components/shared/BuyerSellerGuide';

const faqs = [
  { q: 'What is Synq?', a: 'Synq is an AI-powered on-chain Deal Operating System. It combines AI negotiation, smart escrow, adaptive protection, and conversational payments into one unified experience.' },
  { q: 'How do I create a deal?', a: 'Simply tell Synq what you want to achieve in natural language. The AI will guide you through the process, negotiate terms, create escrow, and set up protection automatically.' },
  { q: 'How does the escrow work?', a: 'When a deal is created, funds are locked in a smart escrow contract. Funds are released in milestones as each deliverable is approved by both parties.' },
  { q: 'What is Adaptive Protection?', a: 'Adaptive Protection is Synq\'s risk monitoring system. It continuously analyzes your deal\'s risk factors and provides coverage against potential losses.' },
  { q: 'How do AI agents work?', a: 'Synq has 6 specialized AI agents (Negotiation, Escrow, Risk, Protection, Payment, Dispute) that work together through a unified orchestration layer. Each can be configured with different permission levels.' },
  { q: 'Is my money safe?', a: 'Yes. All transactions require your explicit approval. AI agents cannot execute irreversible high-value actions without your authorization. Escrow funds are secured by smart contracts.' },
];

export default function HelpPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Help Center</h1>
        <p className="text-zinc-400 text-sm mt-1">Learn how to use Synq effectively.</p>
      </div>

      <BuyerSellerGuide showFaq />

      <Card>
        <CardHeader>
          <CardTitle>Frequently Asked Questions</CardTitle>
          <CardDescription>Quick answers to common questions</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {faqs.map((faq, i) => (
            <div key={i} className="p-4 rounded-lg bg-zinc-800/30 border border-zinc-800/50">
              <h3 className="text-sm font-medium text-white mb-1">{faq.q}</h3>
              <p className="text-sm text-zinc-300">{faq.a}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
