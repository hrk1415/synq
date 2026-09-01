'use client';

import React from 'react';
import { Calendar, Code, FileText, User, Clock } from 'lucide-react';
import RadialOrbitalTimeline from '@/components/ui/radial-orbital-timeline';

const timelineData = [
  {
    id: 1,
    title: 'My Deals',
    date: 'Jan 2024',
    content: 'Track all your active, completed and pending deals in one place.',
    category: 'My Deals',
    icon: Calendar,
    iconImage: '/my-deals-logo.png',
    relatedIds: [2],
    status: 'completed' as const,
    energy: 100,
    href: '/deals',
  },
  {
    id: 2,
    title: 'Escrow',
    date: 'Feb 2024',
    content: 'Your money stays safe until the work is done and both sides are happy.',
    category: 'Escrow',
    icon: FileText,
    iconImage: '/escrow-logo.png',
    relatedIds: [1, 3],
    status: 'completed' as const,
    energy: 90,
    href: '/escrow',
  },
  {
    id: 3,
    title: 'AI Negotiator',
    date: 'Mar 2024',
    content: 'AI that finds the right deal for both sides.',
    category: 'AI Negotiator',
    icon: Code,
    iconImage: '/negotiator-logo.png',
    relatedIds: [2, 4],
    status: 'in-progress' as const,
    energy: 60,
    href: '/negotiator',
  },
  {
    id: 4,
    title: 'Chatpay',
    date: 'Apr 2024',
    content: 'Pay, send and get paid without leaving the chat.',
    category: 'Chatpay',
    icon: User,
    iconImage: '/chatpay-logo.png',
    relatedIds: [3, 5],
    status: 'pending' as const,
    energy: 30,
    href: '/chatpay',
  },
  {
    id: 5,
    title: 'Deal Port',
    date: 'May 2024',
    content: 'Final deployment and release.',
    category: 'Deal Port',
    icon: Clock,
    iconImage: '/marketplace-logo.png',
    relatedIds: [4],
    status: 'pending' as const,
    energy: 10,
    href: '/marketplace',
  },
];

export function RadialOrbitalTimelineDemo() {
  return (
    <>
      <RadialOrbitalTimeline timelineData={timelineData} />
    </>
  );
}

export default function Dashboard() {
  return (
    <div className="w-full h-full flex items-center justify-center overflow-hidden relative">
      <RadialOrbitalTimeline
        timelineData={timelineData}
        className="w-full h-full border-none rounded-none bg-transparent shadow-none"
      />
    </div>
  );
}
