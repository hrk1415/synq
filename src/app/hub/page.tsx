import Link from 'next/link';
import { Press_Start_2P } from 'next/font/google';
import { Cpu, ArrowLeftRight, ArrowRight, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

export interface HubModule {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
  cta: string;
  badge?: string;
}

export const HUB_MODULES: HubModule[] = [
  {
    id: 'agent-controller',
    title: 'Agent Controller',
    description:
      'Explore the future of AI-assisted deal monitoring, agent permissions, and workflow automation.',
    href: '/agent-controller',
    icon: Cpu,
    cta: 'Open Agent Controller',
    badge: 'Coming Soon',
  },
  {
    id: 'swap',
    title: 'Swap',
    description:
      'Decentralized token exchange interface for swapping supported assets on the Sepolia testnet via automated market maker liquidity.',
    href: '/swap',
    icon: ArrowLeftRight,
    cta: 'Open Swap',
    badge: 'DeFi',
  },
];

export default function HubPage() {
  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center gap-2.5">
        <h1
          className={`${pressStart2P.className} text-xl md:text-2xl font-normal text-white tracking-tight`}
        >
          SynqHub
        </h1>
        <div className="relative group inline-block">
          <button
            type="button"
            tabIndex={0}
            aria-label="About SynqHub"
            className="w-5 h-5 rounded-full bg-[#252525] hover:bg-white/10 border border-white/20 text-[#A3A3A3] hover:text-white text-[11px] font-bold font-mono inline-flex items-center justify-center shrink-0 transition-colors focus:outline-none focus:ring-1 focus:ring-white/40"
          >
            ?
          </button>
          <div className="absolute left-0 top-full mt-2 w-72 sm:w-80 p-3 rounded-xl bg-[#1B1B1B] border border-white/75 text-white text-xs leading-relaxed shadow-2xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-all duration-150 z-30">
            Tools and utilities for managing more of your Synq workflow.
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {HUB_MODULES.map((module) => {
          const Icon = module.icon;
          return (
            <Link
              key={module.id}
              href={module.href}
              className="group block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              <Card className="h-full border border-white/75 bg-[#1B1B1B] hover:border-white shadow-xl transition-all duration-200 flex flex-col justify-between p-4 sm:p-5">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="w-10 h-10 rounded-lg bg-[#252525] border border-white/20 flex items-center justify-center text-white group-hover:bg-white/10 transition-colors">
                      <Icon size={20} />
                    </div>
                    {module.badge && (
                      <span className="text-[10px] font-medium font-mono px-2 py-0.5 rounded-full bg-[#252525] border border-white/20 text-[#A3A3A3]">
                        {module.badge}
                      </span>
                    )}
                  </div>

                  <div>
                    <h2 className="text-base font-semibold text-white group-hover:text-neutral-200 transition-colors">
                      {module.title}
                    </h2>
                    <p className="text-xs text-[#A3A3A3] mt-1 leading-relaxed">
                      {module.description}
                    </p>
                  </div>
                </div>

                <div className="pt-3.5 mt-3.5 border-t border-white/20 flex items-center justify-between text-xs font-semibold text-white group-hover:text-neutral-300 transition-colors">
                  <span>{module.cta}</span>
                  <ArrowRight
                    size={14}
                    className="transform group-hover:translate-x-1 transition-transform duration-200"
                  />
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
