'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Play,
  Pause,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Zap,
  CheckCircle2,
  Clock,
  Activity,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TimelineItem {
  id: number | string;
  title: string;
  date?: string;
  content: string;
  category?: string;
  icon?: any;
  iconImage?: string;
  relatedIds?: (number | string)[];
  status?: 'completed' | 'in-progress' | 'pending' | 'active' | string;
  energy?: number;
  href?: string;
}

interface RadialOrbitalTimelineProps {
  timelineData: TimelineItem[];
  className?: string;
  onNodeClick?: (item: TimelineItem) => void;
}

const statusConfig: Record<
  string,
  {
    color: string;
    bg: string;
    border: string;
    glow: string;
    badge: string;
    label: string;
    icon: any;
  }
> = {
  completed: {
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/40',
    glow: 'rgba(16, 185, 129, 0.45)',
    badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    label: 'Completed',
    icon: CheckCircle2,
  },
  'in-progress': {
    color: 'text-blue-400',
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/40',
    glow: 'rgba(59, 130, 246, 0.45)',
    badge: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    label: 'In Progress',
    icon: Activity,
  },
  pending: {
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/40',
    glow: 'rgba(245, 158, 11, 0.45)',
    badge: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    label: 'Pending',
    icon: Clock,
  },
  active: {
    color: 'text-violet-400',
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/40',
    glow: 'rgba(139, 92, 246, 0.45)',
    badge: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
    label: 'Active',
    icon: Zap,
  },
};

export default function RadialOrbitalTimeline({
  timelineData = [],
  className,
  onNodeClick,
}: RadialOrbitalTimelineProps) {
  const router = useRouter();
  const [isRotating, setIsRotating] = useState(true);
  const [rotationAngle, setRotationAngle] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [hoveredId, setHoveredId] = useState<number | string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);

  // Smooth Orbit Animation Loop
  useEffect(() => {
    const animate = (time: number) => {
      if (lastTimeRef.current !== null && isRotating) {
        const delta = (time - lastTimeRef.current) / 1000;
        setRotationAngle((prev) => (prev + delta * 9 * speed) % 360);
      }
      lastTimeRef.current = time;
      requestRef.current = requestAnimationFrame(animate);
    };

    requestRef.current = requestAnimationFrame(animate);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isRotating, speed]);

  // Resolve target link based on item
  const getDestination = (item: TimelineItem) => {
    if (item.href) return item.href;
    const titleLower = item.title.toLowerCase();
    if (titleLower.includes('deal')) return '/deals';
    if (titleLower.includes('escrow')) return '/escrow';
    if (titleLower.includes('negotiator') || titleLower.includes('ai')) return '/negotiator';
    if (titleLower.includes('chatpay') || titleLower.includes('pay')) return '/chatpay';
    if (titleLower.includes('release')) return '/marketplace';
    return '/dashboard';
  };

  const handleNodeClick = (item: TimelineItem, e: React.MouseEvent) => {
    if (onNodeClick) {
      onNodeClick(item);
    }
    const dest = getDestination(item);
    router.push(dest);
  };

  // Dimensions
  const size = 760;
  const center = size / 2;
  const baseRadius = 265;

  // Calculate Node Coordinates
  const nodePositions = useMemo(() => {
    const total = timelineData.length;
    if (total === 0) return [];

    return timelineData.map((item, index) => {
      const baseAngle = (360 / total) * index;
      const currentAngleDeg = (baseAngle + rotationAngle) % 360;
      const angleRad = (currentAngleDeg * Math.PI) / 180;

      const energyOffset = item.energy ? ((item.energy - 50) / 100) * 22 : 0;
      const r = baseRadius + energyOffset;

      const x = center + r * Math.cos(angleRad);
      const y = center + r * Math.sin(angleRad);

      return {
        ...item,
        x,
        y,
        angleDeg: currentAngleDeg,
        radius: r,
      };
    });
  }, [timelineData, rotationAngle, center, baseRadius]);

  const posMap = useMemo(() => {
    const map = new Map<number | string, (typeof nodePositions)[0]>();
    nodePositions.forEach((pos) => map.set(pos.id, pos));
    return map;
  }, [nodePositions]);

  return (
    <div
      className={cn(
        'relative w-full h-full min-h-screen flex flex-col items-center justify-center p-4 md:p-8 overflow-hidden select-none',
        className
      )}
      ref={containerRef}
    >
      {/* Background Decorative Star Grid & Ambient Glow */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(99,102,241,0.14),rgba(0,0,0,0)_75%)] pointer-events-none" />
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage:
            'radial-gradient(rgba(255, 255, 255, 0.8) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />

      {/* Orbit Controls Bar (Bottom Right) */}
      <div className="absolute bottom-6 right-6 z-30 flex items-center gap-1.5 bg-zinc-900/90 backdrop-blur-md border border-white/10 p-1.5 rounded-2xl shadow-2xl">
        <button
          onClick={() => setIsRotating(!isRotating)}
          className={cn(
            'p-2 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer',
            isRotating
              ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40'
              : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
          )}
          title={isRotating ? 'Pause Orbit' : 'Resume Orbit'}
        >
          {isRotating ? <Pause size={14} /> : <Play size={14} />}
          <span className="text-[11px] font-semibold hidden sm:inline">
            {isRotating ? 'Orbiting' : 'Paused'}
          </span>
        </button>

        <button
          onClick={() =>
            setSpeed((s) => (s === 0.5 ? 1 : s === 1 ? 2 : 0.5))
          }
          className="px-2.5 py-1.5 rounded-xl text-[11px] font-mono font-bold text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
          title="Change rotation speed"
        >
          {speed}x
        </button>

        <div className="h-4 w-px bg-white/10 mx-0.5" />

        <button
          onClick={() => setZoom((z) => Math.min(z + 0.15, 1.4))}
          className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
          title="Zoom In"
        >
          <ZoomIn size={14} />
        </button>
        <button
          onClick={() => setZoom((z) => Math.max(z - 0.15, 0.65))}
          className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
          title="Zoom Out"
        >
          <ZoomOut size={14} />
        </button>
        <button
          onClick={() => {
            setZoom(1);
            setRotationAngle(0);
          }}
          className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
          title="Reset Orbit View"
        >
          <RotateCcw size={14} />
        </button>
      </div>

      {/* Main Centered Orbital Sphere Viewport */}
      <div
        className="w-full max-w-[740px] aspect-square flex items-center justify-center relative transition-transform duration-300 select-none my-auto"
        style={{ transform: `scale(${zoom})` }}
      >
        {/* SVG Viewport (Lines Removed) */}

        {/* Central Core Hub */}
        <div
          className="absolute z-10 w-32 h-32 md:w-40 md:h-40 rounded-full flex flex-col items-center justify-center text-center p-2 cursor-pointer transition-all duration-300 group"
          style={{
            background:
              'radial-gradient(circle, rgba(37, 99, 235, 0.25) 0%, rgba(15, 23, 42, 0.95) 75%)',
            boxShadow:
              '0 0 45px rgba(59, 130, 246, 0.45), inset 0 0 15px rgba(255, 255, 255, 0.1)',
            border: '1px solid rgba(59, 130, 246, 0.4)',
          }}
          onClick={() => router.push('/dashboard')}
        >
          <div className="absolute inset-0 rounded-full border border-blue-400/20 animate-ping opacity-25 pointer-events-none" />
          <div className="w-24 h-24 md:w-32 md:h-32 rounded-full flex items-center justify-center shadow-lg shadow-blue-500/30 group-hover:scale-110 transition-transform overflow-hidden">
            <img src="/synq-logo.png" alt="Synq" className="w-full h-full object-cover mix-blend-lighten" />
          </div>
        </div>

        {/* Orbiting Interactive Nodes - Clicking redirects directly to option */}
        {nodePositions.map((item) => {
          const IconComp = item.icon || Activity;
          const isHovered = hoveredId === item.id;
          const statusCfg =
            statusConfig[item.status || 'pending'] || statusConfig.pending;
          const destHref = getDestination(item);

          const leftPercent = (item.x / size) * 100;
          const topPercent = (item.y / size) * 100;

          return (
            <Link
              key={item.id}
              href={destHref}
              className="absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer z-20 focus:outline-none"
              style={{
                left: `${leftPercent}%`,
                top: `${topPercent}%`,
              }}
              onMouseEnter={() => setHoveredId(item.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={(e) => {
                if (onNodeClick) onNodeClick(item);
              }}
            >
              <motion.div
                whileHover={{ scale: 1.2 }}
                whileTap={{ scale: 0.95 }}
                className="relative flex flex-col items-center group"
              >
                {/* Pulsing Aura on Hover */}
                {isHovered && (
                  <div
                    className="absolute -inset-3.5 rounded-full blur-md transition-all duration-300 pointer-events-none"
                    style={{ backgroundColor: statusCfg.glow }}
                  />
                )}

                {/* Node Icon Box */}
                <div
                  className={cn(
                    'w-13 h-13 md:w-15 md:h-15 rounded-2xl flex items-center justify-center transition-all duration-300 shadow-xl border',
                    isHovered
                      ? 'bg-zinc-900 border-white text-white shadow-blue-500/50 ring-2 ring-blue-500'
                      : cn(
                          'bg-zinc-950/90 text-zinc-300 group-hover:text-white',
                          statusCfg.border
                        )
                  )}
                  style={{
                    boxShadow: isHovered
                      ? `0 0 25px ${statusCfg.glow}`
                      : undefined,
                  }}
                >
                  {item.iconImage ? (
                    <img src={item.iconImage} alt={item.title} className="w-9 h-9 object-contain" />
                  ) : (
                    <IconComp size={22} className={statusCfg.color} />
                  )}

                  {/* Energy tag */}
                  {item.energy !== undefined && (
                    <span className="absolute -top-1.5 -right-1.5 px-1.5 py-0.5 text-[9px] font-mono font-bold rounded-full bg-zinc-900 border border-white/20 text-zinc-300">
                      {item.energy}%
                    </span>
                  )}
                </div>

                {/* Title badge below node */}
                <div
                  className={cn(
                    'mt-2 px-2.5 py-0.5 rounded-lg text-[11px] md:text-xs font-semibold whitespace-nowrap tracking-tight backdrop-blur-md transition-all border',
                    isHovered
                      ? 'bg-white text-zinc-950 border-white font-bold shadow-lg scale-105'
                      : 'bg-zinc-900/90 text-zinc-300 border-white/10 group-hover:border-white/30 group-hover:text-white'
                  )}
                >
                  {item.title}
                </div>
              </motion.div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
