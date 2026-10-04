'use client';

import React, { useState, useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { SellerPreviewCard } from './SellerPreviewCard';
import type { AiNegotiatorSellerResult } from '@/db/schema';

interface HandleMentionProps {
  seller: AiNegotiatorSellerResult;
  synqHandle?: string;
  avatar?: string | null;
  completedDeals?: number;
  reviewCount?: number;
  onSelectSeller?: (seller: AiNegotiatorSellerResult) => void;
}

export function HandleMention({
  seller,
  synqHandle,
  avatar,
  completedDeals,
  reviewCount = 0,
  onSelectSeller,
}: HandleMentionProps) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnter = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setOpen(true);
  };

  const handleMouseLeave = () => {
    if (pinned) return;
    hoverTimerRef.current = setTimeout(() => {
      setOpen(false);
    }, 200);
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pinned) {
      setPinned(false);
      setOpen(false);
    } else {
      setPinned(true);
      setOpen(true);
    }
  };

  const wallet = seller.wallet || '';
  const displayLabel = synqHandle
    ? `@${synqHandle}`
    : wallet.length >= 10
    ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}`
    : wallet || seller.name || 'freelancer';

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setOpen(false);
          setPinned(false);
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
          className="inline-flex items-center text-blue-400 hover:text-blue-300 font-semibold underline underline-offset-2 decoration-blue-500/50 hover:decoration-blue-400 cursor-pointer transition-colors px-0.5 rounded focus:outline-none focus:ring-1 focus:ring-blue-500/40"
        >
          {displayLabel}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="top"
          align="center"
          sideOffset={6}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className="z-50 outline-none focus:outline-none"
        >
          <SellerPreviewCard
            seller={seller}
            synqHandle={synqHandle}
            avatar={avatar}
            completedDeals={completedDeals}
            reviewCount={reviewCount}
            onSelect={
              onSelectSeller
                ? (sel) => {
                    setOpen(false);
                    setPinned(false);
                    onSelectSeller(sel);
                  }
                : undefined
            }
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
