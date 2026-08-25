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
      <img src="/01.jpg" alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover transition-transform duration-[4000ms] ease-out group-hover:scale-105" />

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
              transition={{ duration: 0.6, ease: 'backOut' }}
              className="w-32 h-32 rounded-full overflow-hidden mb-8 shadow-2xl shadow-blue-500/30 ring-4 ring-white/80 bg-white flex items-center justify-center p-3"
            >
              <img src="/logo.jpg" alt="Synq logo" className="w-full h-full object-contain" />
            </motion.div>

            <span className="text-xs tracking-[0.35em] uppercase text-black/80 mb-4 font-semibold">
              AI-Powered Deal OS
            </span>

            <BubbleText
              text="Welcome To Synq"
              className="text-5xl md:text-7xl font-extrabold text-black tracking-tight leading-tight"
            />

            <BubbleText
              text="Tell what you need. Let it handle the deal."
              className="text-black font-semibold mt-4 text-base md:text-lg"
            />

            <motion.button
              onClick={enter}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.97 }}
              className="mt-10 group flex items-center gap-3 px-10 py-4 rounded-2xl bg-gradient-to-r from-blue-600 to-violet-600 text-white font-semibold text-lg shadow-xl shadow-blue-600/30 hover:shadow-blue-500/40 transition-all"
            >
              Enter
              <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
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