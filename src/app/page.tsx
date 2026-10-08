'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Press_Start_2P } from 'next/font/google';
import InteractivePixelArtwork from '@/components/landing/InteractivePixelArtwork';
import { LiquidLensSurface } from '@/components/landing/LiquidLensSurface';
import { RainbowButton } from '@/components/ui/rainbow-button';
import WalletStatus from '@/components/layout/WalletStatus';

const pressStart2P = Press_Start_2P({
  weight: '400',
  subsets: ['latin'],
  display: 'swap',
});

export default function FrontPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Liquid Lens Position & State
  const [lensActive, setLensActive] = useState(false);
  const [lensPos, setLensPos] = useState({ x: -1000, y: -1000 });
  const [containerRect, setContainerRect] = useState({ width: 1200, height: 700 });
  const [walletDropdownOpen, setWalletDropdownOpen] = useState(false);

  const targetPosRef = useRef({ x: -1000, y: -1000, active: false });
  const currentPosRef = useRef({ x: -1000, y: -1000 });

  const lensSize = 180;
  const lensRadius = 14;

  // Update container dimensions on resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateRect = () => {
      const rect = el.getBoundingClientRect();
      setContainerRect({ width: rect.width, height: rect.height });
    };

    updateRect();
    const observer = new ResizeObserver(updateRect);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Perceptual lag smoothing for the liquid lens cursor tracking (~60-80ms lag, bypassed if prefers-reduced-motion)
  useEffect(() => {
    let animId: number;

    const updateLensLoop = () => {
      if (targetPosRef.current.active) {
        const prefersReduced =
          typeof window !== 'undefined' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        if (prefersReduced) {
          currentPosRef.current.x = targetPosRef.current.x;
          currentPosRef.current.y = targetPosRef.current.y;
        } else {
          // Perceptual organic lag (~60-80ms at 60fps with alpha ≈ 0.32)
          const dx = targetPosRef.current.x - currentPosRef.current.x;
          const dy = targetPosRef.current.y - currentPosRef.current.y;
          currentPosRef.current.x += dx * 0.32;
          currentPosRef.current.y += dy * 0.32;
        }

        setLensPos({
          x: currentPosRef.current.x,
          y: currentPosRef.current.y,
        });
      }

      animId = requestAnimationFrame(updateLensLoop);
    };

    animId = requestAnimationFrame(updateLensLoop);
    return () => cancelAnimationFrame(animId);
  }, []);

  // Suspend lens tracking and hide lens while wallet modal or dropdown is active
  useEffect(() => {
    if (walletDropdownOpen) {
      targetPosRef.current.active = false;
      setLensActive(false);
    }
  }, [walletDropdownOpen]);

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (walletDropdownOpen) return;
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    targetPosRef.current = { x, y, active: true };
    if (!lensActive) {
      currentPosRef.current = { x, y };
      setLensPos({ x, y });
      setLensActive(true);
    }
  };

  const handlePointerLeave = () => {
    targetPosRef.current.active = false;
    setLensActive(false);
  };

  // Shared typography parameters ensuring 100% exact registration between Layer 1, Layer 3, and Layer 4
  const typographyStyle: React.CSSProperties = {
    fontSize: 'clamp(108px, 18vw, 288px)',
    lineHeight: 1,
    whiteSpace: 'nowrap',
    letterSpacing: '-0.02em',
    userSelect: 'none',
  };

  const topClip = lensPos.y - lensSize / 2;
  const rightClip = containerRect.width - (lensPos.x + lensSize / 2);
  const bottomClip = containerRect.height - (lensPos.y + lensSize / 2);
  const leftClip = lensPos.x - lensSize / 2;

  return (
    <div
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className="fixed inset-0 overflow-hidden bg-[#242424] flex items-center justify-center cursor-crosshair select-none z-0"
    >
      {/* CSS Keyframes for Experiment B.8: Independent Pseudo-Random Square Timelines with Hold Ranges */}
      <style>{`
        @keyframes cta-square-spin-a {
          0% { transform: rotate(0deg); }
          22% { transform: rotate(90deg); }
          42% { transform: rotate(90deg); }
          72% { transform: rotate(270deg); }
          86% { transform: rotate(270deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes cta-square-spin-b {
          0% { transform: rotate(0deg); }
          26% { transform: rotate(0deg); }
          50% { transform: rotate(180deg); }
          78% { transform: rotate(180deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes cta-square-spin-c {
          0% { transform: rotate(0deg); }
          30% { transform: rotate(90deg); }
          46% { transform: rotate(90deg); }
          74% { transform: rotate(270deg); }
          88% { transform: rotate(270deg); }
          100% { transform: rotate(360deg); }
        }
        .cta-square-a {
          animation: cta-square-spin-a 4.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        .cta-square-b {
          animation: cta-square-spin-b 6.1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        .cta-square-c {
          animation: cta-square-spin-c 5.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        @keyframes wallet-square-spin-a {
          0% { transform: rotate(0deg); }
          20% { transform: rotate(90deg); }
          40% { transform: rotate(90deg); }
          70% { transform: rotate(270deg); }
          85% { transform: rotate(270deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes wallet-square-spin-b {
          0% { transform: rotate(0deg); }
          25% { transform: rotate(0deg); }
          52% { transform: rotate(180deg); }
          76% { transform: rotate(180deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes wallet-square-spin-c {
          0% { transform: rotate(0deg); }
          32% { transform: rotate(90deg); }
          48% { transform: rotate(90deg); }
          75% { transform: rotate(270deg); }
          88% { transform: rotate(270deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes wallet-square-spin-d {
          0% { transform: rotate(0deg); }
          18% { transform: rotate(180deg); }
          45% { transform: rotate(180deg); }
          68% { transform: rotate(270deg); }
          82% { transform: rotate(270deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes wallet-square-spin-e {
          0% { transform: rotate(0deg); }
          28% { transform: rotate(90deg); }
          50% { transform: rotate(90deg); }
          72% { transform: rotate(180deg); }
          86% { transform: rotate(180deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes wallet-square-spin-f {
          0% { transform: rotate(0deg); }
          15% { transform: rotate(0deg); }
          42% { transform: rotate(180deg); }
          64% { transform: rotate(180deg); }
          84% { transform: rotate(270deg); }
          100% { transform: rotate(360deg); }
        }
        .wallet-square-a {
          animation: wallet-square-spin-a 5.1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        .wallet-square-b {
          animation: wallet-square-spin-b 6.7s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        .wallet-square-c {
          animation: wallet-square-spin-c 4.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        .wallet-square-d {
          animation: wallet-square-spin-d 5.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        .wallet-square-e {
          animation: wallet-square-spin-e 6.3s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        .wallet-square-f {
          animation: wallet-square-spin-f 4.9s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .cta-square-a,
          .cta-square-b,
          .cta-square-c,
          .wallet-square-a,
          .wallet-square-b,
          .wallet-square-c,
          .wallet-square-d,
          .wallet-square-e,
          .wallet-square-f {
            animation: none !important;
            transform: none !important;
          }
        }
      `}</style>

      {/* Header UI: Top-right Public Indicator — Six Animated White Squares (□ □ □ □ □ □) */}
      {!walletDropdownOpen && (
        <div
          className="absolute top-6 right-6 md:top-8 md:right-10 z-20 pointer-events-none select-none h-10 px-4 flex items-center justify-center"
          aria-hidden="true"
        >
          <div className="flex items-center justify-center gap-2">
            <div
              className="wallet-square-a w-[10px] h-[10px] rounded-[3px] bg-white will-change-transform"
              title="Wallet indicator"
            />
            <div
              className="wallet-square-b w-[10px] h-[10px] rounded-[3px] bg-white will-change-transform"
              title="Wallet indicator"
            />
            <div
              className="wallet-square-c w-[10px] h-[10px] rounded-[3px] bg-white will-change-transform"
              title="Wallet indicator"
            />
            <div
              className="wallet-square-d w-[10px] h-[10px] rounded-[3px] bg-white will-change-transform"
              title="Wallet indicator"
            />
            <div
              className="wallet-square-e w-[10px] h-[10px] rounded-[3px] bg-white will-change-transform"
              title="Wallet indicator"
            />
            <div
              className="wallet-square-f w-[10px] h-[10px] rounded-[3px] bg-white will-change-transform"
              title="Wallet indicator"
            />
          </div>
        </div>
      )}

      {/* Header UI: Top-right Real Wallet Capsule (Secret Layer revealed through Liquid Lens, or fully suspended when dropdown open) */}
      <div
        className="absolute inset-0 pointer-events-none select-none z-50"
        style={{
          clipPath: walletDropdownOpen
            ? 'none'
            : lensActive
            ? `inset(${topClip}px ${rightClip}px ${bottomClip}px ${leftClip}px round ${lensRadius}px)`
            : 'inset(100%)',
        }}
        aria-hidden={!walletDropdownOpen && !lensActive}
      >
        <div className="absolute top-6 right-6 md:top-8 md:right-10 pointer-events-auto flex items-center gap-2">
          <WalletStatus onOpenChange={setWalletDropdownOpen} />
        </div>
      </div>

      {/* Layer 0: Subtle centered neutral backlight for background depth */}
      <div
        className="absolute inset-0 pointer-events-none flex items-center justify-center"
        aria-hidden="true"
      >
        <div className="w-[50vw] max-w-[700px] h-[260px] rounded-full bg-white/[0.03] blur-[90px]" />
      </div>

      {/* Shared Coordinate Shell for Exact Typography Alignment */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
        {/* Layer 1: Solid Glowing Synq Typography (Behind Hands) */}
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none select-none z-10"
          aria-hidden="true"
        >
          <span
            className={`${pressStart2P.className} font-normal`}
            style={{
              ...typographyStyle,
              color: '#ffffff',
              textShadow:
                '0 0 15px rgba(255, 255, 255, 0.95), 0 0 40px rgba(255, 255, 255, 0.6), 0 0 85px rgba(255, 255, 255, 0.35)',
            }}
          >
            Synq
          </span>
        </div>

        {/* Layer 2: Colored Three.js Pixel Hands (Sandwiched Between Back and Front Typography) */}
        <div className="absolute inset-0 z-20 pointer-events-none">
          <InteractivePixelArtwork
            className="w-full h-full"
            debug={false}
            artworkScale={1.60}
            preservePixelSize={true}
            transparentBackground={true}
            colorMode="original-color"
            disableLiquid={true}
            enableFlicker={true}
            lensActive={lensActive}
            lensX={lensPos.x}
            lensY={lensPos.y}
            lensSize={lensSize}
            lensRadius={lensRadius}
          />
        </div>

        {/* Layer 3: Crisp Outline Synq Typography (Over Hands) */}
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none select-none z-30"
          aria-hidden="true"
        >
          <span
            className={`${pressStart2P.className} font-normal`}
            style={{
              ...typographyStyle,
              color: 'transparent',
              WebkitTextStroke: '0.75px rgba(255, 255, 255, 0.82)',
              textShadow: 'none',
            }}
          >
            Synq
          </span>
        </div>

        {/* SVG Liquid Refraction Filter Definition */}
        <svg
          className="absolute w-0 h-0 pointer-events-none opacity-0 overflow-hidden"
          aria-hidden="true"
        >
          <defs>
            <filter id="synq-liquid-displacement" x="-20%" y="-20%" width="140%" height="140%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.013 0.016"
                numOctaves="2"
                seed="5"
                result="noise"
              >
                <animate
                  attributeName="baseFrequency"
                  dur="14s"
                  values="0.013 0.016; 0.016 0.012; 0.012 0.018; 0.013 0.016"
                  repeatCount="indefinite"
                />
              </feTurbulence>
              <feDisplacementMap
                in="SourceGraphic"
                in2="noise"
                scale="6.5"
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
        </svg>

        {/* Layer 4: Foreground Glowing Solid Synq Typography (Revealed Exclusively Inside the Liquid Lens Bounds with Refraction Displacement) */}
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none select-none z-35"
          style={{
            clipPath: lensActive
              ? `inset(${topClip}px ${rightClip}px ${bottomClip}px ${leftClip}px round ${lensRadius}px)`
              : 'inset(100%)',
            opacity: lensActive ? 1 : 0,
            transition: 'opacity 0.12s ease-out',
          }}
          aria-hidden="true"
        >
          <span
            className={`${pressStart2P.className} font-normal`}
            style={{
              ...typographyStyle,
              color: '#ffffff',
              textShadow:
                '0 0 15px rgba(255, 255, 255, 0.95), 0 0 40px rgba(255, 255, 255, 0.6), 0 0 85px rgba(255, 255, 255, 0.35)',
              filter: lensActive ? 'url(#synq-liquid-displacement)' : 'none',
            }}
          >
            Synq
          </span>
        </div>

        {/* Layer 5: Screen-Surface Liquid Membrane (Clean surface embedded into screen plane) */}
        {lensActive && (
          <div
            className="absolute pointer-events-none select-none z-40 rounded-[14px] overflow-hidden"
            style={{
              width: `${lensSize}px`,
              height: `${lensSize}px`,
              left: `${lensPos.x}px`,
              top: `${lensPos.y}px`,
              transform: 'translate(-50%, -50%)',
              backgroundColor: 'transparent',
              boxShadow:
                'inset 1px 1.5px 3.5px 0px rgba(255, 255, 255, 0.14), inset 0 0 2.5px 0px rgba(255, 255, 255, 0.09)',
            }}
          >
            <LiquidLensSurface
              size={lensSize}
              radius={lensRadius}
              active={lensActive}
            />
          </div>
        )}
      </div>

      {/* Layer 5.5: Normal Public CTA State — Three Small Rotating White Squares (□ □ □) */}
      <div
        className="absolute bottom-7 md:bottom-9 left-1/2 -translate-x-1/2 w-[160px] h-[44px] flex items-center justify-center pointer-events-none select-none z-20"
        aria-hidden="true"
      >
        <div className="flex items-center justify-center gap-2">
          <div
            className="cta-square-a w-[10px] h-[10px] rounded-[3px] bg-white will-change-transform"
            title="Interactive indicator"
          />
          <div
            className="cta-square-b w-[10px] h-[10px] rounded-[3px] bg-white will-change-transform"
            title="Interactive indicator"
          />
          <div
            className="cta-square-c w-[10px] h-[10px] rounded-[3px] bg-white will-change-transform"
            title="Interactive indicator"
          />
        </div>
      </div>

      {/* Layer 6: Secret Layer — Rainbow Enter Button Revealed Spatially Through Liquid Lens Window */}
      <div
        className="absolute inset-0 pointer-events-none select-none z-30"
        style={{
          clipPath: lensActive
            ? `inset(${topClip}px ${rightClip}px ${bottomClip}px ${leftClip}px round ${lensRadius}px)`
            : 'inset(100%)',
        }}
        aria-hidden={!lensActive}
      >
        <div className="absolute bottom-7 md:bottom-9 left-1/2 -translate-x-1/2 w-[160px] h-[44px] pointer-events-auto">
          <Link href="/negotiator?new=1" className="inline-block no-underline">
            <RainbowButton speed={4}>
              <span className={`${pressStart2P.className} text-[11px] leading-none tracking-wider text-[#242424]`}>
                Enter
              </span>
            </RainbowButton>
          </Link>
        </div>
      </div>
    </div>
  );
}
