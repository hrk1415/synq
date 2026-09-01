'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import PaymentAssistant from '@/components/chatpay/PaymentAssistant';
import { Loader2 } from 'lucide-react';

function ChatPayContent() {
  const searchParams = useSearchParams();
  const seller = searchParams.get('seller');
  const category = searchParams.get('type');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">ChatPay Workspace</h1>
        <p className="text-zinc-400 text-sm mt-1">
          {seller 
            ? 'State your project requirements directly to the seller. Discuss details and issue payments without leaving the chat.' 
            : 'Pay with a conversation — describe the payment and Synq builds the real on-chain transaction. Buyer↔seller chat happens right here.'}
        </p>
      </div>

      <PaymentAssistant sellerAddress={seller} category={category} />
    </div>
  );
}

export default function ChatPayPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-[400px]"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>}>
      <ChatPayContent />
    </Suspense>
  );
}
