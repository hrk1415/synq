'use client';

import React from 'react';
import { HandleMention } from './HandleMention';
import { SafeMarkdown } from './SafeMarkdown';
import type { AiNegotiatorSellerResult } from '@/db/schema';

interface FreelancerSearchMessageProps {
  content: string;
  sellers?: AiNegotiatorSellerResult[];
  identitiesMap?: Record<string, { handle?: string | null; displayHandle?: string | null }>;
  namesMap?: Record<string, string>;
  avatarsMap?: Record<string, string>;
  completedCountsMap?: Record<string, number | undefined>;
  reviewCountsMap?: Record<string, number | undefined>;
  onSelectSeller?: (seller: AiNegotiatorSellerResult) => void;
}

export function FreelancerSearchMessage({
  content,
  sellers,
  identitiesMap = {},
  namesMap = {},
  avatarsMap = {},
  completedCountsMap = {},
  reviewCountsMap = {},
  onSelectSeller,
}: FreelancerSearchMessageProps) {
  if (!sellers || !Array.isArray(sellers) || sellers.length === 0) {
    return <SafeMarkdown content={content} />;
  }

  // Extract any prefix sentence before search acknowledgment
  let prefix = '';
  const searchPattern = /^(.*?)(?:I found|Found)\s+(?:\d+|a)\s+matching\s+freelancers?/i;
  const match = content.match(searchPattern);

  if (match && match[1]) {
    prefix = match[1].trim();
  } else if (!/I found|matching freelancer/i.test(content)) {
    // If text doesn't contain standard search phrasing at all, keep full content as prefix
    prefix = content.trim();
  }

  const count = sellers.length;
  const leadText = count === 1 ? 'I found a matching freelancer:' : `I found ${count} matching freelancers:`;

  return (
    <div className="leading-relaxed">
      {prefix && (
        <span className="whitespace-pre-wrap">
          {prefix}{' '}
        </span>
      )}
      <span>{leadText} </span>
      {sellers.map((s, idx) => {
        const key = (s.wallet || '').toLowerCase();
        const identity = identitiesMap[key];
        const synqHandle = identity?.handle || identity?.displayHandle;
        const avatar = avatarsMap[key];
        const completedDeals = completedCountsMap[key];
        const reviewCount = reviewCountsMap[key];

        const isLast = idx === count - 1;
        const isSecondToLast = idx === count - 2;

        let separator = '';
        if (count === 2) {
          if (idx === 0) separator = ' and ';
        } else if (count > 2) {
          if (isSecondToLast) separator = ', and ';
          else if (!isLast) separator = ', ';
        }

        return (
          <React.Fragment key={s.wallet || idx}>
            <HandleMention
              seller={s}
              synqHandle={synqHandle || undefined}
              avatar={avatar}
              completedDeals={completedDeals}
              reviewCount={reviewCount}
              onSelectSeller={onSelectSeller}
            />
            {separator}
          </React.Fragment>
        );
      })}
      <span>.</span>
    </div>
  );
}
