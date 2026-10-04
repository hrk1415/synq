import { ShieldCheck } from 'lucide-react';

export default function ProtectionPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <section className="w-full max-w-xl rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-8 text-center shadow-xl">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-blue-500/25 bg-blue-500/10">
          <ShieldCheck className="h-6 w-6 text-blue-400" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-semibold text-white">Deal Protection</h1>
        <p className="mt-2 text-sm font-medium uppercase tracking-[0.18em] text-blue-400">
          Coming Soon
        </p>
        <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-zinc-400">
          We are preparing a new Deal Protection experience. The previous protection pool and its transaction controls are no longer available through Synq.
        </p>
      </section>
    </div>
  );
}
