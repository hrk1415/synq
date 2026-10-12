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
            initial={{ opacity: 0, scale: 0.98, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 6 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="w-full max-w-[1080px] lg:h-[720px] max-h-[90vh] flex flex-col bg-[#101010] border border-[#2F2F2F] rounded-2xl shadow-[0_24px_64px_-12px_rgba(0,0,0,0.8)] p-3.5 sm:p-4.5 relative text-white overflow-y-auto lg:overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <ProviderProfile
              wallet={wallet}
              showCloseButton
              onClose={onClose}
              onSelectFreelancer={onSelectFreelancer}
              selectButtonLabel={selectButtonLabel}
              isModal
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
