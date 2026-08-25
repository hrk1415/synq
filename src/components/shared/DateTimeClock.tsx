'use client';

import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';

export default function DateTimeClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!now) return null;

  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
      <CalendarClock size={16} className="text-blue-400 shrink-0" />
      <div className="text-right">
        <div className="text-sm font-semibold text-white tabular-nums">{timeStr}</div>
        <div className="text-[10px] text-zinc-500">{dateStr}</div>
      </div>
    </div>
  );
}