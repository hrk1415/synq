'use client';

import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ProviderProfile } from './ProviderProfile';

export interface ProviderProfileModalProps {
  wallet: string | null;
  onClose: () => void;
  onSelectFreelancer?: (wallet: string) => void;
  selectButtonLabel?: string;
}

export function ProviderProfileModal({
  wallet,
  onClose,
  onSelectFreelancer,
  selectButtonLabel,
}: ProviderProfileModalProps) {
  // Lock body scroll while modal is open
  useEffect(() => {
    if (!wallet) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [wallet]);

  // Handle Escape key to close modal
  useEffect(() => {
    if (!wallet) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [wallet, onClose]);

  return (
    <AnimatePresence>
      {wallet && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-5 md:p-8"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-[1180px] max-h-[90vh] bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl overflow-y-auto p-5 sm:p-6 md:p-8 relative text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <ProviderProfile
              wallet={wallet}
              showCloseButton
              onClose={onClose}
              onSelectFreelancer={onSelectFreelancer}
              selectButtonLabel={selectButtonLabel}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
