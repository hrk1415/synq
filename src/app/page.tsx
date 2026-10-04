'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Press_Start_2P } from 'next/font/google';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import InteractiveGlassGrid from '@/components/ui/interactive-glass-grid';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

const SYNQ_FLICKER_STYLES = [
  { stroke: 'rgba(255, 255, 255, 1)', fill: 'rgba(255, 255, 255, 1)', shadow: 'none' },
  { stroke: 'rgba(255, 255, 255, 1)', fill: 'rgba(255, 255, 255, 1)', shadow: '0 0 6px rgba(255, 255, 255, 0.18)' },
  { stroke: 'rgba(255, 255, 255, 1)', fill: 'rgba(255, 255, 255, 0.92)', shadow: '0 0 9px rgba(255, 255, 255, 0.24)' },
  { stroke: 'rgba(255, 255, 255, 0.45)', fill: 'rgba(255, 255, 255, 0.45)', shadow: 'none' },
  { stroke: 'rgba(255, 255, 255, 0.12)', fill: 'rgba(255, 255, 255, 0.12)', shadow: 'none' },
] as const;

export default function FrontPage() {
  const router = useRouter();
  const landingRef = useRef<HTMLDivElement | null>(null);
  const backgroundRef = useRef<HTMLImageElement | null>(null);
  const synqWordRef = useRef<HTMLSpanElement | null>(null);
  const headlineEntranceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const synqFlickerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [entering, setEntering] = useState(false);
  const [show, setShow] = useState(false);
  const [headlineReconstructing, setHeadlineReconstructing] = useState(true);
  const [synqFlickerState, setSynqFlickerState] = useState(0);
  const [synqGlassMetrics, setSynqGlassMetrics] = useState<{
    left: number;
    width: number;
    centerY: number;
    pitch: number;
    viewportHeight: number;
    fontSize: number;
  } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!show) return;

    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let mounted = true;
    let rapidStepsRemaining = 0;

    const randomElectricalState = () => {
      const roll = Math.random();
      return roll < 0.36 ? 3 : roll < 0.5 ? 4 : roll < 0.78 ? 1 : 2;
    };

    const scheduleSynqFlicker = () => {
      if (!mounted || reducedMotionQuery.matches || synqFlickerTimeoutRef.current !== null) return;
      const rapid = rapidStepsRemaining > 0;
      const delay = rapid
        ? 35 + Math.random() * 85
        : 250 + Math.random() * 650;
      synqFlickerTimeoutRef.current = setTimeout(() => {
        synqFlickerTimeoutRef.current = null;
        if (!mounted || reducedMotionQuery.matches) return;

        if (rapidStepsRemaining > 0) {
          rapidStepsRemaining--;
          setSynqFlickerState(rapidStepsRemaining === 0 ? 0 : randomElectricalState());
        } else if (Math.random() < 0.45) {
          rapidStepsRemaining = 2 + Math.floor(Math.random() * 3);
          setSynqFlickerState(randomElectricalState());
        } else {
          setSynqFlickerState(Math.random() < 0.15 ? 1 : 0);
        }

        scheduleSynqFlicker();
      }, delay);
    };

    const updateReducedMotion = () => {
      if (headlineEntranceTimeoutRef.current !== null) clearTimeout(headlineEntranceTimeoutRef.current);
      headlineEntranceTimeoutRef.current = null;
      if (synqFlickerTimeoutRef.current !== null) clearTimeout(synqFlickerTimeoutRef.current);
      synqFlickerTimeoutRef.current = null;
      rapidStepsRemaining = 0;
      setSynqFlickerState(0);
      if (reducedMotionQuery.matches) {
        setHeadlineReconstructing(false);
        return;
      }

      setHeadlineReconstructing(true);
      headlineEntranceTimeoutRef.current = setTimeout(() => {
        headlineEntranceTimeoutRef.current = null;
        if (!mounted || reducedMotionQuery.matches) return;
        setHeadlineReconstructing(false);
        setSynqFlickerState(0);
        scheduleSynqFlicker();
      }, 860);
    };
    updateReducedMotion();
    reducedMotionQuery.addEventListener('change', updateReducedMotion);
    return () => {
      mounted = false;
      reducedMotionQuery.removeEventListener('change', updateReducedMotion);
      if (headlineEntranceTimeoutRef.current !== null) clearTimeout(headlineEntranceTimeoutRef.current);
      headlineEntranceTimeoutRef.current = null;
      if (synqFlickerTimeoutRef.current !== null) clearTimeout(synqFlickerTimeoutRef.current);
      synqFlickerTimeoutRef.current = null;
    };
  }, [show]);

  useEffect(() => {
    if (!show || !synqWordRef.current) return;
    let mounted = true;

    const updateGlassMetrics = () => {
      const word = synqWordRef.current;
      if (!mounted || !word) return;
      const bounds = word.getBoundingClientRect();
      const fontSize = Number.parseFloat(window.getComputedStyle(word).fontSize);
      const next = {
        left: bounds.left + bounds.width / 2,
        width: bounds.width + 12,
        centerY: bounds.top + bounds.height / 2,
        pitch: bounds.height * 0.75,
        viewportHeight: landingRef.current?.getBoundingClientRect().height ?? window.innerHeight,
        fontSize,
      };
      setSynqGlassMetrics((current) => (
        current
          && Math.abs(current.left - next.left) < 0.25
          && Math.abs(current.width - next.width) < 0.25
          && Math.abs(current.centerY - next.centerY) < 0.25
          && Math.abs(current.pitch - next.pitch) < 0.25
          && Math.abs(current.viewportHeight - next.viewportHeight) < 0.25
          && Math.abs(current.fontSize - next.fontSize) < 0.25
          ? current
          : next
      ));
    };

    const resizeObserver = new ResizeObserver(updateGlassMetrics);
    resizeObserver.observe(synqWordRef.current);
    window.addEventListener('resize', updateGlassMetrics);
    updateGlassMetrics();
    void document.fonts.ready.then(updateGlassMetrics);

    return () => {
      mounted = false;
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateGlassMetrics);
    };
  }, [show]);

  useEffect(() => {
    const landing = landingRef.current;
    const background = backgroundRef.current;
    if (!landing || !background) return;

    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
    const target = { scale: 1, x: 0, y: 0 };
    const current = { scale: 1, x: 0, y: 0 };
    let animationFrame: number | null = null;
    let previousTimestamp = 0;

    const applyTransform = () => {
      background.style.transform = `translate3d(${current.x}px, ${current.y}px, 0) scale(${current.scale})`;
    };

    const animate = (timestamp: number) => {
      animationFrame = null;
      const elapsed = previousTimestamp ? Math.min(timestamp - previousTimestamp, 50) : 16.67;
      const frameScale = elapsed / 16.67;
      const panEasing = 1 - Math.pow(1 - 0.09, frameScale);
      const scaleEasing = 1 - Math.pow(1 - 0.07, frameScale);

      current.x += (target.x - current.x) * panEasing;
      current.y += (target.y - current.y) * panEasing;
      current.scale += (target.scale - current.scale) * scaleEasing;
      applyTransform();
      previousTimestamp = timestamp;

      const unsettled = Math.abs(target.x - current.x) > 0.02
        || Math.abs(target.y - current.y) > 0.02
        || Math.abs(target.scale - current.scale) > 0.0001;
      if (unsettled) {
        animationFrame = requestAnimationFrame(animate);
      } else {
        current.x = target.x;
        current.y = target.y;
        current.scale = target.scale;
        applyTransform();
        previousTimestamp = 0;
      }
    };

    const requestAnimation = () => {
      if (animationFrame === null) animationFrame = requestAnimationFrame(animate);
    };

    const resetTarget = () => {
      target.scale = 1;
      target.x = 0;
      target.y = 0;
      if (reducedMotionQuery.matches || !finePointerQuery.matches) {
        current.scale = 1;
        current.x = 0;
        current.y = 0;
        applyTransform();
        return;
      }
      requestAnimation();
    };

    const handlePointer = (event: PointerEvent) => {
      if (reducedMotionQuery.matches || !finePointerQuery.matches || event.pointerType === 'touch') return;
      const bounds = landing.getBoundingClientRect();
      const normalizedX = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1));
      const normalizedY = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1));
      target.scale = 1.065;
      target.x = normalizedX * 16;
      target.y = normalizedY * 12;
      requestAnimation();
    };

    const updateCapability = () => {
      if (!reducedMotionQuery.matches && finePointerQuery.matches) return;
      target.scale = 1;
      target.x = 0;
      target.y = 0;
      current.scale = 1;
      current.x = 0;
      current.y = 0;
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = null;
      previousTimestamp = 0;
      applyTransform();
    };

    applyTransform();
    landing.addEventListener('pointerenter', handlePointer, { passive: true });
    landing.addEventListener('pointermove', handlePointer, { passive: true });
    landing.addEventListener('pointerleave', resetTarget);
    window.addEventListener('blur', resetTarget);
    reducedMotionQuery.addEventListener('change', updateCapability);
    finePointerQuery.addEventListener('change', updateCapability);

    return () => {
      landing.removeEventListener('pointerenter', handlePointer);
      landing.removeEventListener('pointermove', handlePointer);
      landing.removeEventListener('pointerleave', resetTarget);
      window.removeEventListener('blur', resetTarget);
      reducedMotionQuery.removeEventListener('change', updateCapability);
      finePointerQuery.removeEventListener('change', updateCapability);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      background.style.transform = '';
    };
  }, []);

  const enter = () => {
    if (entering) return;
    setEntering(true);
    setTimeout(() => router.push('/negotiator?new=1'), 500);
  };

  const synqCutoutRows = synqGlassMetrics
    ? (() => {
        const above = Math.ceil(synqGlassMetrics.centerY / synqGlassMetrics.pitch);
        const below = Math.ceil((synqGlassMetrics.viewportHeight - synqGlassMetrics.centerY) / synqGlassMetrics.pitch);
        return Array.from({ length: above + below }, (_, index) => (
          index < above ? index - above : index - above + 1
        ));
      })()
    : [];

  return (
    <div ref={landingRef} className="fixed inset-0 z-50 overflow-hidden bg-zinc-950">
      <style>{`
        @keyframes light-sweep {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes headline-word-reconstruct {
          0%   { opacity: 0; clip-path: inset(44% 0 44% 0); transform: translateX(var(--slice-offset)); }
          18%  { opacity: 0.72; clip-path: inset(8% 0 58% 0); transform: translateX(var(--slice-offset)); }
          38%  { opacity: 0.38; clip-path: inset(52% 0 12% 0); transform: translateX(-3px); }
          58%  { opacity: 1; clip-path: inset(20% 0 18% 0); transform: translateX(2px); }
          78%  { opacity: 0.82; clip-path: inset(0 0 0 0); transform: translateX(-1px); }
          100% { opacity: 1; clip-path: inset(0 0 0 0); transform: translateX(0); }
        }
        @keyframes headline-slice-top {
          0%, 8% { opacity: 0; transform: translateX(0); }
          20%    { opacity: 0.72; transform: translateX(var(--slice-offset)); }
          48%    { opacity: 0.42; transform: translateX(-3px); }
          72%    { opacity: 0.22; transform: translateX(1px); }
          100%   { opacity: 0; transform: translateX(0); }
        }
        @keyframes headline-slice-bottom {
          0%, 14% { opacity: 0; transform: translateX(0); }
          28%     { opacity: 0.58; transform: translateX(-4px); }
          55%     { opacity: 0.34; transform: translateX(var(--slice-offset)); }
          76%     { opacity: 0.16; transform: translateX(-1px); }
          100%    { opacity: 0; transform: translateX(0); }
        }
        @keyframes synq-electrical-ignition {
          0%   { opacity: 0.38; text-shadow: none; }
          24%  { opacity: 1; text-shadow: 0 0 7px rgba(255,255,255,0.2); }
          42%  { opacity: 0.16; text-shadow: none; }
          62%  { opacity: 1; text-shadow: 0 0 10px rgba(255,255,255,0.3); }
          78%  { opacity: 0.55; text-shadow: none; }
          100% { opacity: 1; text-shadow: none; }
        }
        .headline-word {
          --word-delay: 0ms;
          --slice-offset: 6px;
        }
        .headline-word:nth-child(2) { --word-delay: 45ms; --slice-offset: -5px; }
        .headline-word:nth-child(3) { --word-delay: 90ms; --slice-offset: 4px; }
        .headline-word:nth-child(4) { --word-delay: 135ms; --slice-offset: -6px; }
        .headline-word:nth-child(5) { --word-delay: 180ms; --slice-offset: 5px; }
        .headline-word-piece {
          position: relative;
          display: block;
        }
        .synq-glass {
          position: absolute;
          top: 0;
          bottom: 0;
          z-index: 0;
          overflow: hidden;
          transform: translateX(-50%);
          pointer-events: none;
        }
        .synq-glass-surface {
          height: 100%;
          width: 100%;
          border-left: 1px solid rgba(255, 255, 255, 0.13);
          border-right: 1px solid rgba(255, 255, 255, 0.13);
          background:
            radial-gradient(ellipse 100% 70% at 0% 0%, rgba(7, 14, 25, 0.025) 0%, rgba(7, 14, 25, 0.012) 42%, transparent 76%),
            radial-gradient(ellipse 100% 70% at 100% 0%, rgba(18, 10, 28, 0.025) 0%, rgba(18, 10, 28, 0.012) 42%, transparent 76%),
            linear-gradient(180deg, rgba(17, 13, 24, 0.22) 0%, rgba(17, 13, 24, 0.18) 25%, rgba(17, 13, 24, 0.10) 50%, rgba(17, 13, 24, 0.025) 75%, transparent 95%),
            linear-gradient(90deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0.025));
          backdrop-filter: blur(20px) saturate(1.08);
          -webkit-backdrop-filter: blur(20px) saturate(1.08);
          box-shadow: 0 10px 32px rgba(0, 0, 0, 0.12), inset 1px 0 0 rgba(255, 255, 255, 0.08), inset -1px 0 0 rgba(255, 255, 255, 0.025);
        }
        .synq-electric {
          position: relative;
          z-index: 2;
        }
        .headline-word-piece::before,
        .headline-word-piece::after {
          content: attr(data-text);
          position: absolute;
          inset: 0;
          opacity: 0;
          pointer-events: none;
        }
        .headline-word-piece::before { clip-path: inset(0 0 66% 0); }
        .headline-word-piece::after { clip-path: inset(66% 0 0 0); }
        .headline-reconstructing .headline-word-piece {
          animation: headline-word-reconstruct 560ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
          animation-delay: var(--word-delay);
        }
        .headline-reconstructing .headline-word-piece::before {
          animation: headline-slice-top 560ms steps(2, end) both;
          animation-delay: var(--word-delay);
        }
        .headline-reconstructing .headline-word-piece::after {
          animation: headline-slice-bottom 560ms steps(2, end) both;
          animation-delay: var(--word-delay);
        }
        .headline-reconstructing .synq-electric {
          animation: synq-electrical-ignition 240ms steps(1, end) 620ms forwards;
        }
        .light-sweep {
          position: absolute; inset: 0;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
          animation: light-sweep 8s ease-in-out infinite;
          pointer-events: none;
        }
        @media (prefers-reduced-motion: reduce) {
          .headline-reconstructing .headline-word-piece,
          .headline-reconstructing .headline-word-piece::before,
          .headline-reconstructing .headline-word-piece::after,
          .headline-reconstructing .synq-electric {
            animation: none !important;
          }
        }
      `}</style>
      <img ref={backgroundRef} src="/01.jpg" alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover [will-change:transform]" />
      <div className="light-sweep" />

      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-zinc-950/40 to-zinc-950 pointer-events-none" />

      <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden>
        <div className="absolute top-[20%] left-[15%] w-[500px] h-[500px] bg-blue-600/20 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-[20%] right-[15%] w-[400px] h-[400px] bg-violet-600/15 rounded-full blur-[100px] animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      <InteractiveGlassGrid />

      <AnimatePresence>
        {show && (
          <motion.div
            key="landing-brand"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="absolute top-6 left-6 md:top-8 md:left-10 z-10"
          >
            <div className="w-[46px] h-[46px] md:w-[52px] md:h-[52px] rounded-full overflow-hidden shadow-xl ring-2 ring-white/70 bg-white">
              <img src="/logo.jpg" alt="Synq logo" className="w-full h-full object-cover" />
            </div>
          </motion.div>
        )}

        {show && (
          <div
            key="landing-hero"
            className="absolute inset-0 text-center"
          >
            {synqGlassMetrics && (
              <>
                <svg
                  aria-hidden="true"
                  className="absolute h-0 w-0 pointer-events-none"
                  width="0"
                  height="0"
                >
                  <defs>
                    <mask
                      id="synq-glass-cutout-mask"
                      maskUnits="userSpaceOnUse"
                      maskContentUnits="userSpaceOnUse"
                      x="0"
                      y="0"
                      width={synqGlassMetrics.width}
                      height={synqGlassMetrics.viewportHeight}
                    >
                      <rect
                        width={synqGlassMetrics.width}
                        height={synqGlassMetrics.viewportHeight}
                        fill="white"
                      />
                      <g
                        className={pressStart2P.className}
                        fill="black"
                        fontSize={synqGlassMetrics.fontSize}
                        fontWeight="400"
                        textAnchor="middle"
                        dominantBaseline="central"
                      >
                        {synqCutoutRows.map((row) => (
                          <text
                            key={row}
                            x={synqGlassMetrics.width / 2}
                            y={synqGlassMetrics.centerY + row * synqGlassMetrics.pitch}
                          >
                            Synq
                          </text>
                        ))}
                      </g>
                    </mask>
                  </defs>
                </svg>
                <div
                  aria-hidden="true"
                  className="synq-glass synq-glass-surface"
                  style={{
                    left: synqGlassMetrics.left,
                    width: synqGlassMetrics.width,
                    mask: 'url(#synq-glass-cutout-mask)',
                    WebkitMask: 'url(#synq-glass-cutout-mask)',
                  }}
                />
              </>
            )}
            <h1
              className={`${pressStart2P.className} ${headlineReconstructing ? 'headline-reconstructing' : ''} absolute left-1/2 top-1/2 z-[1] flex w-fit max-w-[calc(100%_-_3rem)] flex-wrap items-baseline justify-center gap-[16px] -translate-x-1/2 -translate-y-1/2 text-[clamp(30px,4vw,56px)] font-normal leading-relaxed text-white md:max-w-[94vw] md:flex-nowrap md:whitespace-nowrap`}
            >
              <span className="headline-word">
                <span className="headline-word-piece" data-text="let" style={{ color: 'transparent', WebkitTextStroke: '2px rgba(255, 255, 255, 0.88)' }}>let</span>
              </span>
              <span ref={synqWordRef} className="headline-word">
                <span className="headline-word-piece" data-text="Synq">
                  <span
                    className="synq-electric"
                    style={{
                      color: SYNQ_FLICKER_STYLES[synqFlickerState].fill,
                      WebkitTextStroke: `0.5px ${SYNQ_FLICKER_STYLES[synqFlickerState].stroke}`,
                      textShadow: SYNQ_FLICKER_STYLES[synqFlickerState].shadow,
                    }}
                  >
                    Synq
                  </span>
                </span>
              </span>
              <span className="headline-word">
                <span className="headline-word-piece" data-text="handle" style={{ color: 'transparent', WebkitTextStroke: '2px rgba(255, 255, 255, 0.88)' }}>handle</span>
              </span>
              <span className="headline-word" style={{ transform: 'translateX(-4px)' }}>
                <span className="headline-word-piece" data-text="the" style={{ color: 'transparent', WebkitTextStroke: '2px rgba(255, 255, 255, 0.88)' }}>the</span>
              </span>
              <span className="headline-word">
                <span className="headline-word-piece" data-text="deal" style={{ color: 'transparent', WebkitTextStroke: '2px rgba(255, 255, 255, 0.88)' }}>deal</span>
              </span>
            </h1>

            <div className="absolute left-1/2 top-3/4 -translate-x-1/2 -translate-y-1/2">
              <motion.button
                onClick={enter}
                whileHover={{ scale: 1.07 }}
                whileTap={{ scale: 0.95 }}
                transition={{ type: 'spring', stiffness: 300 }}
                className="group relative flex items-center gap-3 px-10 py-4 rounded-2xl bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-xl shadow-blue-600/40 hover:shadow-[0_0_50px_rgba(59,130,246,0.6)] hover:shadow-blue-500/50 hover:brightness-110 hover:scale-[1.03] transition-all duration-300 overflow-hidden"
              >
                <span className="absolute inset-0 bg-gradient-to-r from-white/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                <span className={`${pressStart2P.className} text-[15px] font-normal leading-7`}>Enter</span>
                <ArrowRight size={20} className="group-hover:translate-x-2 transition-transform duration-300 relative z-10" />
              </motion.button>
            </div>

          </div>
        )}
      </AnimatePresence>

      {entering && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 z-[9999] bg-black pointer-events-none"
          transition={{ duration: 0.3 }}
        />
      )}
    </div>
  );
}
