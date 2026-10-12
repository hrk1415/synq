'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Shield } from 'lucide-react';

export interface TransactionOverlayProps {
  open: boolean;
  title: string;
  description?: string;
}

export function TransactionOverlay({
  open,
  title,
  description = 'Waiting for confirmation on Sepolia',
}: TransactionOverlayProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4 pointer-events-auto select-none"
          role="dialog"
          aria-modal="true"
          aria-live="polite"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-sm rounded-2xl border border-zinc-700/60 bg-zinc-900/90 p-6 shadow-2xl backdrop-blur-xl text-center space-y-4"
          >
            <div className="relative mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-blue-600/10 border border-blue-500/30">
              <Loader2 size={28} className="animate-spin text-blue-400" />
            </div>

            <div className="space-y-1.5">
              <h3 className="text-base font-bold text-white tracking-tight">
                {title || 'Transaction Pending...'}
              </h3>
              <p className="text-xs text-zinc-400 font-medium leading-relaxed">
                {description}
              </p>
            </div>

            <div className="flex items-center justify-center gap-1.5 pt-1 text-[11px] text-zinc-500 font-mono">
              <Shield size={12} className="text-blue-400" />
              <span>Synq On-Chain Security</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
