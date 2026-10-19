import Link from 'next/link';
import { Press_Start_2P } from 'next/font/google';
import {
  ArrowLeft,
  Eye,
  Lock,
  Zap,
  History,
  Bot,
  Info,
  Sparkles,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

interface CapabilityPreview {
  title: string;
  description: string;
  icon: typeof Eye;
}

const PLANNED_CAPABILITIES: CapabilityPreview[] = [
  {
    title: 'Deal Monitoring',
    description: 'Stay informed about deal activity and milestone progress.',
    icon: Eye,
  },
  {
    title: 'Agent Permissions',
    description: 'Configure what your agents can access and what actions require approval.',
    icon: Lock,
  },
  {
    title: 'Task Automation',
    description: 'Prepare repetitive workflow tasks with human oversight.',
    icon: Zap,
  },
  {
    title: 'Activity History',
    description: 'Review agent activity, recommendations, and suggested actions.',
    icon: History,
  },
];

export default function AgentControllerPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* BREADCRUMB / BACK NAVIGATION TO HUB */}
      <div>
        <Link
          href="/hub"
          className="inline-flex items-center gap-1.5 text-xs text-[#A3A3A3] hover:text-white transition-colors outline-none focus-visible:ring-1 focus-visible:ring-white/40 rounded"
        >
          <ArrowLeft size={14} />
          <span>Back to Hub</span>
        </Link>
      </div>

      {/* HEADER SECTION */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <h1
          className={`${pressStart2P.className} text-xl md:text-2xl font-normal text-white tracking-tight`}
        >
          Agent Controller
        </h1>
        <Badge
          variant="outline"
          className="border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px] font-mono px-2 py-0.5"
        >
          Coming Soon
        </Badge>
        <div className="relative group inline-block">
          <button
            type="button"
            tabIndex={0}
            aria-label="About Agent Controller"
            className="w-5 h-5 rounded-full bg-[#252525] hover:bg-white/10 border border-white/20 text-[#A3A3A3] hover:text-white text-[11px] font-bold font-mono inline-flex items-center justify-center shrink-0 transition-colors focus:outline-none focus:ring-1 focus:ring-white/40"
          >
            ?
          </button>
          <div className="absolute left-0 top-full mt-2 w-72 sm:w-80 p-3 rounded-xl bg-[#1B1B1B] border border-white/75 text-white text-xs leading-relaxed shadow-2xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-all duration-150 z-30">
            Your workspace for intelligent deal automation.
          </div>
        </div>
      </div>

      {/* FEATURE INTRODUCTION */}
      <Card className="border border-white/75 bg-[#1B1B1B] shadow-xl">
        <CardContent className="p-5 sm:p-6 space-y-2">
          <div className="flex items-center gap-2 text-white font-semibold text-sm sm:text-base">
            <Sparkles size={16} className="text-amber-400 shrink-0" />
            <span>AI agents, under your control.</span>
          </div>
          <p className="text-xs sm:text-sm text-[#A3A3A3] leading-relaxed">
            A future workspace for managing assistants that help monitor deals, track milestones,
            and prepare actions across SYNQ. All capabilities described on this page are planned
            concepts in active design and are not yet available for execution.
          </p>
        </CardContent>
      </Card>

      {/* PLANNED CAPABILITIES */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
            Planned Capabilities
          </h2>
          <span className="text-[10px] text-zinc-500 font-mono">Conceptual Preview</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {PLANNED_CAPABILITIES.map((cap) => {
            const Icon = cap.icon;
            return (
              <Card
                key={cap.title}
                className="border border-white/75 bg-[#1B1B1B] hover:border-white transition-colors duration-150 p-4 sm:p-5 flex flex-col justify-between"
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="w-8 h-8 rounded-lg bg-[#252525] border border-white/20 flex items-center justify-center text-white">
                      <Icon size={16} />
                    </div>
                    <Badge
                      variant="outline"
                      className="border-white/20 bg-white/5 text-[#A3A3A3] text-[9px] font-mono px-2 py-0.2"
                    >
                      Planned
                    </Badge>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">{cap.title}</h3>
                    <p className="text-xs text-[#A3A3A3] mt-1 leading-relaxed">
                      {cap.description}
                    </p>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      {/* AGENT WORKSPACE PREVIEW */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[#A3A3A3]">
              Agent Workspace
            </h2>
            <Badge
              variant="outline"
              className="border-blue-500/40 bg-blue-500/10 text-blue-300 text-[9px] font-mono px-1.5 py-0.2"
            >
              Preview
            </Badge>
          </div>
        </div>

        <Card className="border border-white/75 bg-[#1B1B1B] shadow-xl">
          <CardContent className="p-8 sm:p-12 text-center space-y-4 max-w-md mx-auto">
            <div className="w-12 h-12 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mx-auto text-[#A3A3A3]">
              <Bot size={22} />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-sm sm:text-base font-semibold text-white">
                No agents configured
              </h3>
              <p className="text-xs text-[#A3A3A3] leading-relaxed">
                Agent creation and management will become available in a future release. When
                active, you will be able to register assistants and define granular policy boundaries.
              </p>
            </div>
            <div className="pt-2">
              <Button
                type="button"
                disabled
                aria-disabled="true"
                tabIndex={-1}
                className="cursor-not-allowed bg-white/10 text-zinc-400 border border-white/10 hover:bg-white/10 text-xs px-4 py-2 rounded-xl"
              >
                Create Agent — Coming Soon
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* LATCH EXPLORATORY REFERENCE */}
      <Card className="border border-white/20 bg-[#161616] text-[#A3A3A3]">
        <CardContent className="p-4 sm:p-5 flex items-start gap-3">
          <Info size={16} className="text-zinc-400 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-zinc-200">
                Exploratory: Latch Protocol Integration
              </span>
              <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-white/5 border border-white/10 text-zinc-400">
                Research
              </span>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Future versions of Agent Controller may explore integration with proxy protocols such as
              Latch for external API rate-limiting and spending caps. This reference is conceptual:
              Latch is not currently active, connected, or supported, and no credentials are accepted
              or stored.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
