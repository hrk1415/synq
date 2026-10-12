import { ShieldCheck } from 'lucide-react';
import { Press_Start_2P } from 'next/font/google';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

export default function ProtectionPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <section className="w-full max-w-xl rounded-2xl border border-white/75 bg-[#1B1B1B] p-8 text-center shadow-2xl">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-white/20 bg-[#252525]">
          <ShieldCheck className="h-6 w-6 text-white" aria-hidden="true" />
        </div>
        <h1 className={`${pressStart2P.className} text-xl md:text-2xl font-normal text-white tracking-tight`}>Deal Protection</h1>
        <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-[#A3A3A3]">
          Coming Soon
        </p>
        <p className="mx-auto mt-4 max-w-md text-xs leading-6 text-[#A3A3A3]">
          We are preparing a new Deal Protection experience. The previous protection pool and its transaction controls are no longer available through Synq.
        </p>
      </section>
    </div>
  );
}
