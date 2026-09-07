'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { BubbleText } from '@/components/ui/bubble-text';

export default function FrontPage() {
  const router = useRouter();
  const [entering, setEntering] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(t);
  }, []);

  const enter = () => {
    if (entering) return;
    setEntering(true);
    setTimeout(() => router.push('/dashboard'), 500);
  };

  return (
    <div className="fixed inset-0 z-50 group overflow-hidden bg-zinc-950">
      <style>{`
        @keyframes cinematic-pan {
          0%   { background-position: 0% 0%; }
          25%  { background-position: 100% 0%; }
          50%  { background-position: 100% 100%; }
          75%  { background-position: 0% 100%; }
          100% { background-position: 0% 0%; }
        }
        @keyframes light-sweep {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .cinematic-bg {
          animation: cinematic-pan 20s ease-in-out infinite alternate;
        }
        .light-sweep {
          position: absolute; inset: 0;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
          animation: light-sweep 8s ease-in-out infinite;
          pointer-events: none;
        }
      `}</style>
      <img src="/01.jpg" alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover transition-transform duration-[4000ms] ease-out group-hover:scale-125 cinematic-bg" />
      <div className="light-sweep" />

      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-zinc-950/40 to-zinc-950 pointer-events-none" />

      <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden>
        <div className="absolute top-[20%] left-[15%] w-[500px] h-[500px] bg-blue-600/20 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-[20%] right-[15%] w-[400px] h-[400px] bg-violet-600/15 rounded-full blur-[100px] animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      <AnimatePresence>
        {show && (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 1.02 }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 flex flex-col items-center justify-center text-center px-6"
          >
            <motion.div
              initial={{ scale: 0.7 }}
              animate={{ scale: 1 }}
              whileHover={{ scale: 1.1 }}
              transition={{ duration: 0.6, ease: 'backOut' }}
              className="w-32 h-32 rounded-full overflow-hidden mb-8 shadow-2xl shadow-blue-500/30 ring-4 ring-white/80 bg-white flex items-center justify-center hover:shadow-blue-500/60 hover:shadow-[0_0_60px_rgba(59,130,246,0.4)] hover:ring-blue-400/50 transition-all duration-500"
            >
              <img src="/logo.jpg" alt="Synq logo" className="w-full h-full object-cover" />
            </motion.div>

            <span className="text-xs tracking-[0.35em] uppercase text-white/80 mb-4 font-semibold">
              AI-Powered Deal OS
            </span>

            <BubbleText
              text="Welcome To Synq"
              className="text-5xl md:text-7xl font-extrabold text-white tracking-tight leading-tight drop-shadow-lg"
            />

            <BubbleText
              text="Tell what you need. Let it handle the deal."
              className="text-white/90 font-semibold mt-4 text-base md:text-lg drop-shadow"
            />

            <motion.button
              onClick={enter}
              whileHover={{ scale: 1.07 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 300 }}
              className="mt-10 group relative flex items-center gap-3 px-10 py-4 rounded-2xl bg-gradient-to-r from-blue-600 to-violet-600 text-white font-semibold text-lg shadow-xl shadow-blue-600/40 hover:shadow-[0_0_50px_rgba(59,130,246,0.6)] hover:shadow-blue-500/50 hover:brightness-110 hover:scale-[1.03] transition-all duration-300 overflow-hidden"
            >
              <span className="absolute inset-0 bg-gradient-to-r from-white/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              Enter
              <ArrowRight size={20} className="group-hover:translate-x-2 transition-transform duration-300 relative z-10" />
            </motion.button>

            {entering && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="absolute inset-0 bg-zinc-950 pointer-events-none flex items-center justify-center"
                transition={{ duration: 0.3 }}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}