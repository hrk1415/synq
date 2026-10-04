'use client';

import { useParams } from 'next/navigation';
import { ProviderProfile } from '@/components/marketplace/ProviderProfile';

export default function DirectProviderProfilePage() {
  const params = useParams();
  const rawWallet = (params?.wallet as string) || '';

  return (
    <div className="container max-w-5xl py-8 md:py-12">
      <ProviderProfile wallet={rawWallet} showBreadcrumb />
    </div>
  );
}
