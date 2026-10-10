'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';
import { Press_Start_2P } from 'next/font/google';
import {
  Check,
  Copy,
  Loader2,
  Camera,
  Trash2,
  Briefcase,
  Pencil,
  Plus,
  Globe,
  Code,
  Sparkles,
  Layers,
  Clock,
  CircleCheck,
  Power,
  ExternalLink,
  CircleAlert,
  ArrowRight,
  Eye,
  X,
  Mail,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { useAccount, useReadContract } from 'wagmi';
import { formatUnits } from 'viem';
import { shortenAddress } from '@/lib/utils';
import { Avatar } from '@/components/shared/Avatar';
import ProfileEmail from '@/components/shared/ProfileEmail';
import NotificationSettingsSection from '@/components/shared/NotificationSettingsSection';
import { ChainGuard } from '@/components/shared/ChainGuard';
import { resizeImageToDataUrl } from '@/lib/image';
import { ProviderProfileModal } from '@/components/marketplace/ProviderProfileModal';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useRegistry } from '@/hooks/useRegistryContract';
import { useDirectoryContract } from '@/hooks/useDirectoryContract';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
import { validateUsdcPricing } from '@/lib/deals/pricing';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

const SELLER_CATEGORIES = ['Web Development', 'Design', 'Smart Contract', 'Content'];

function isValidHttpUrl(str: string): boolean {
  if (!str.trim()) return true;
  try {
    const url = new URL(str.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function genLocalProjId(): string {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface PortfolioProject {
  id: string;
  title: string;
  description: string;
  image: string;
  link: string;
  tags: string[];
}

function getScopedUsername(walletAddress?: string): string {
  if (typeof window === 'undefined' || !walletAddress) return '';
  try {
    const raw = window.localStorage.getItem(`settings:username:${walletAddress.toLowerCase()}`);
    return raw !== null && raw !== undefined ? (JSON.parse(raw) as string) : '';
  } catch {
    return '';
  }
}

function setScopedUsername(walletAddress: string, val: string) {
  if (typeof window === 'undefined' || !walletAddress) return;
  try {
    window.localStorage.setItem(`settings:username:${walletAddress.toLowerCase()}`, JSON.stringify(val));
  } catch {
    /* ignore */
  }
}

export default function SettingsPage() {
  const { address, isConnected } = useAccount();
  const { ensureAuthenticated, clearSession } = useAuthSession();
  const { networkReady } = useSepoliaNetwork();
  const registry = useRegistry(address);
  const directory = useDirectoryContract(address);

  // Identity & Personal Data state
  const [username, setUsername] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [linkedEmail, setLinkedEmail] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Professional & Rich Profile Data state
  const [profName, setProfName] = useState('');
  const [profHeadline, setProfHeadline] = useState('');
  const [profCategory, setProfCategory] = useState('Web Development');
  const [profSkills, setProfSkills] = useState('');
  const [profRate, setProfRate] = useState('');
  const [profUsdcRate, setProfUsdcRate] = useState('');
  const [profRateType, setProfRateType] = useState<'PER_PROJECT' | 'PER_HOUR'>('PER_PROJECT');
  const [profDelivery, setProfDelivery] = useState('');
  const [profQuote, setProfQuote] = useState('');
  const [profAbout, setProfAbout] = useState('');

  // Secondary Categories & Links
  const [secCategories, setSecCategories] = useState<string[]>([]);
  const [newSecCat, setNewSecCat] = useState('');
  const [links, setLinks] = useState({
    website: '',
    github: '',
    twitter: '',
    linkedin: '',
  });

  // Portfolio state
  const [portfolio, setPortfolio] = useState<PortfolioProject[]>([]);
  const [activeProjIdx, setActiveProjIdx] = useState<number>(-1);

  // UI / Action states
  const [savingAll, setSavingAll] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [registerError, setRegisterError] = useState('');
  const [directoryTxSubmitted, setDirectoryTxSubmitted] = useState(false);
  const [availBusy, setAvailBusy] = useState(false);

  const [copied, setCopied] = useState(false);
  const [publicProfileModalWallet, setPublicProfileModalWallet] = useState<string | null>(null);

  // Baseline Off-Chain Data for Dirty Tracking
  interface OffChainBaseline {
    nameDraft: string;
    avatar: string | null;
    profHeadline: string;
    secCategories: string[];
    profAbout: string;
    profDelivery: string;
    links: { website: string; github: string; twitter: string; linkedin: string };
    portfolio: PortfolioProject[];
    profName: string;
    profCategory: string;
    profSkills: string;
    profRate: string;
    profUsdcRate: string;
    profRateType: string;
    profQuote: string;
  }
  const [savedBaseline, setSavedBaseline] = useState<OffChainBaseline | null>(null);

  // Compact Hero Edit Modal State
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [popupName, setPopupName] = useState('');
  const [popupHandle, setPopupHandle] = useState('');
  const [popupAvatar, setPopupAvatar] = useState<string | null>(null);
  const [popupError, setPopupError] = useState('');
  const [popupBusy, setPopupBusy] = useState(false);
  const [popupStepMsg, setPopupStepMsg] = useState('');
  const [popupCopied, setPopupCopied] = useState(false);
  const [modalTxSubmitted, setModalTxSubmitted] = useState(false);

  const popupFileRef = useRef<HTMLInputElement>(null);

  // Handle availability logic for Edit Popup
  const cleanCandidateHandle = popupHandle.trim();
  const currentRegistryHandle = registry.username || '';
  const handleHasChanged = cleanCandidateHandle.toLowerCase() !== currentRegistryHandle.toLowerCase();
  const isHandleSyntaxValid =
    cleanCandidateHandle.length >= 3 &&
    cleanCandidateHandle.length <= 32 &&
    /^[a-zA-Z0-9_]+$/.test(cleanCandidateHandle);

  const { data: isHandleTaken, isLoading: isCheckingHandle } = useReadContract({
    ...registry.config,
    functionName: 'isUsernameTaken',
    args: [cleanCandidateHandle],
    query: {
      enabled: editModalOpen && handleHasChanged && isHandleSyntaxValid,
    },
  });

  const openEditModal = () => {
    setPopupName(nameDraft || username || '');
    setPopupHandle(registry.username || '');
    setPopupAvatar(avatar);
    setPopupError('');
    setPopupStepMsg('');
    setModalTxSubmitted(false);
    setEditModalOpen(true);
  };

  const closeEditModal = () => {
    if (popupBusy) return;
    setEditModalOpen(false);
    setPopupError('');
    setPopupStepMsg('');
    setModalTxSubmitted(false);
  };

  // Body scroll lock & Escape key listener for Edit Popup
  useEffect(() => {
    if (!editModalOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !popupBusy) {
        closeEditModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [editModalOpen, popupBusy]);

  // Handle modal transaction receipt completion
  useEffect(() => {
    if (modalTxSubmitted && registry.txReceipt.isSuccess) {
      registry.refetchUsername();
      setModalTxSubmitted(false);
      setPopupBusy(false);
      setPopupStepMsg('');
      closeEditModal();
    } else if (modalTxSubmitted && registry.txReceipt.isError) {
      setPopupError('On-chain handle transaction failed or reverted.');
      setModalTxSubmitted(false);
      setPopupBusy(false);
      setPopupStepMsg('');
    }
  }, [modalTxSubmitted, registry.txReceipt.isSuccess, registry.txReceipt.isError, registry]);

  const onPickPopupPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (popupFileRef.current) popupFileRef.current.value = '';
    if (!file) return;
    setPopupError('');
    try {
      const dataUrl = await resizeImageToDataUrl(file, 256, 0.8);
      // Keep local in popup state until Save
      setPopupAvatar(dataUrl);
    } catch (err: any) {
      setPopupError(err?.message || 'Could not process image.');
    }
  };

  const removePopupPhoto = () => {
    setPopupAvatar(null);
  };

  const savePopupIdentity = async () => {
    if (!address) {
      setPopupError('Connect your wallet first');
      return;
    }

    const cleanName = popupName.trim();
    if (cleanName.length > 60) {
      setPopupError('Display Name cannot exceed 60 characters');
      return;
    }

    if (handleHasChanged) {
      if (!isHandleSyntaxValid) {
        setPopupError('Handle must be 3–32 characters (letters, numbers & underscore only)');
        return;
      }
      if (isCheckingHandle) {
        setPopupError('Please wait for handle availability check');
        return;
      }
      if (isHandleTaken) {
        setPopupError('This handle is already taken');
        return;
      }
      if (!networkReady) {
        setPopupError('Please switch to Sepolia network to change your handle');
        return;
      }
    }

    setPopupError('');
    setPopupBusy(true);

    try {
      // 1. Save Off-Chain PFP & Display Name first
      setPopupStepMsg('Saving off-chain profile...');
      const token = await ensureAuthenticated();
      const personalRes = await fetch('/api/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          walletAddress: address,
          name: cleanName,
          avatar: popupAvatar || '',
        }),
      });

      if (personalRes.status === 401) {
        clearSession();
        setPopupError('Authorization expired. Please click Save again.');
        setPopupBusy(false);
        setPopupStepMsg('');
        return;
      }

      if (!personalRes.ok) {
        const d = await personalRes.json().catch(() => ({}));
        setPopupError(d.error || 'Could not save personal profile');
        setPopupBusy(false);
        setPopupStepMsg('');
        return;
      }

      // Update local hero identity state
      setAvatar(popupAvatar || null);
      setNameDraft(cleanName);
      setUsername(cleanName);
      setScopedUsername(address, cleanName);

      // Dispatch display name update event for sidebar/header
      window.dispatchEvent(
        new CustomEvent('synq:displayname', {
          detail: { wallet: address.toLowerCase(), name: cleanName },
        }),
      );

      // CASE A: Handle UNCHANGED -> done!
      if (!handleHasChanged) {
        setPopupBusy(false);
        setPopupStepMsg('');
        closeEditModal();
        return;
      }

      // CASE B: Handle CHANGED -> On-chain Registry transaction
      setPopupStepMsg('Confirm in wallet...');
      setModalTxSubmitted(true);

      const txResult = currentRegistryHandle
        ? await registry.updateUsername(cleanCandidateHandle)
        : await registry.register(cleanCandidateHandle);

      if (!txResult) {
        setPopupError('Transaction request rejected or failed to send');
        setModalTxSubmitted(false);
        setPopupBusy(false);
        setPopupStepMsg('');
        return;
      }

      setPopupStepMsg('Confirming handle on-chain...');
    } catch (err: any) {
      setPopupError(String(err?.message || err).slice(0, 120));
      setModalTxSubmitted(false);
      setPopupBusy(false);
      setPopupStepMsg('');
    }
  };

  const isPrefilled = useRef(false);

  // Reset prefill flag on address change
  useEffect(() => {
    isPrefilled.current = false;
  }, [address]);

  const [submittedDirectoryTxHash, setSubmittedDirectoryTxHash] = useState<string | null>(null);

  // Refetch directory profile when on-chain transaction succeeds or fails
  useEffect(() => {
    if (directoryTxSubmitted && directory.txReceipt.isSuccess) {
      directory.refetchAll();
      setDirectoryTxSubmitted(false);
      setSubmittedDirectoryTxHash(null);
      setSavingAll(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 4000);
    } else if (directoryTxSubmitted && directory.txReceipt.isError) {
      setDirectoryTxSubmitted(false);
      setSubmittedDirectoryTxHash(null);
      setSavingAll(false);
      setSaveError('Profile details saved off-chain, but freelancer listing update failed on-chain.');
    }
  }, [directory.txReceipt.isSuccess, directory.txReceipt.isError, directoryTxSubmitted, directory]);

  // Load off-chain personal & market profile data
  useEffect(() => {
    if (!address) {
      setAvatar(null);
      setUsername('');
      setNameDraft('');
      setLinkedEmail(null);
      setProfName('');
      setProfHeadline('');
      setProfCategory('Web Development');
      setProfSkills('');
      setProfRate('');
      setProfDelivery('');
      setProfQuote('');
      setProfAbout('');
      setSecCategories([]);
      setLinks({ website: '', github: '', twitter: '', linkedin: '' });
      setPortfolio([]);
      return;
    }

    let cancelled = false;
    const initialScoped = getScopedUsername(address);
    setUsername(initialScoped);
    setNameDraft(initialScoped);

    // 1 & 2. Fetch the owner-only personal profile and public market profile.
    void (async () => {
      let personalData: any = {};
      try {
        const token = await ensureAuthenticated();
        const response = await fetch(`/api/profile?wallet=${address}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) personalData = await response.json();
      } catch {
        // Leave owner-only fields empty when authentication or loading fails.
      }
      const marketData = await fetch(`/api/profile/market/${address}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      if (cancelled) return;

      const nameVal = personalData?.name || initialScoped;
      const avatarVal = personalData?.avatar !== undefined ? (personalData.avatar || null) : null;
      if (personalData?.avatar !== undefined) setAvatar(avatarVal);
      if (personalData?.email !== undefined) setLinkedEmail(personalData.email || null);
      if (personalData?.name) {
        setNameDraft(personalData.name);
        setUsername(personalData.name);
        setScopedUsername(address, personalData.name);
      }

      const headlineVal = typeof marketData?.headline === 'string' ? marketData.headline : '';
      const secCatVal = Array.isArray(marketData?.secondaryCategories) ? marketData.secondaryCategories : [];
      const aboutVal = typeof marketData?.about === 'string' ? marketData.about : '';
      const deliveryVal = typeof marketData?.typicalDelivery === 'string' ? marketData.typicalDelivery : '';
      const linksVal = {
        website: typeof marketData?.links?.website === 'string' ? marketData.links.website : '',
        github: typeof marketData?.links?.github === 'string' ? marketData.links.github : '',
        twitter: typeof marketData?.links?.twitter === 'string' ? marketData.links.twitter : '',
        linkedin: typeof marketData?.links?.linkedin === 'string' ? marketData.links.linkedin : '',
      };
      const portfolioVal = Array.isArray(marketData?.portfolio) ? marketData.portfolio : [];
      const usdcRateVal = marketData?.startingRateAmount ? String(marketData.startingRateAmount) : '';
      const rateTypeVal = marketData?.startingRateType === 'PER_HOUR' ? 'PER_HOUR' : 'PER_PROJECT';

      setProfHeadline(headlineVal);
      setSecCategories(secCatVal);
      setProfAbout(aboutVal);
      setProfDelivery(deliveryVal);
      setLinks(linksVal);
      setPortfolio(portfolioVal);
      setProfUsdcRate(usdcRateVal);
      setProfRateType(rateTypeVal);

      let draftNameVal = '';
      let draftCatVal = 'Web Development';
      let draftSkillsVal = '';
      let draftRateVal = '';
      let draftBioVal = '';

      if (!directory.myRegistered && marketData) {
        if (typeof marketData.draftName === 'string' && marketData.draftName) {
          draftNameVal = marketData.draftName;
          setProfName(draftNameVal);
        }
        if (typeof marketData.draftCategory === 'string' && marketData.draftCategory) {
          draftCatVal = marketData.draftCategory;
          setProfCategory(draftCatVal);
        }
        if (Array.isArray(marketData.draftSkills) && marketData.draftSkills.length > 0) {
          draftSkillsVal = marketData.draftSkills.join(', ');
          setProfSkills(draftSkillsVal);
        }
        if (typeof marketData.draftRate === 'string' && marketData.draftRate) {
          draftRateVal = marketData.draftRate;
          setProfRate(draftRateVal);
        }
        if (typeof marketData.draftBio === 'string' && marketData.draftBio) {
          draftBioVal = marketData.draftBio;
          setProfQuote(draftBioVal);
        }
      }

      setSavedBaseline({
        nameDraft: nameVal,
        avatar: avatarVal,
        profHeadline: headlineVal,
        secCategories: secCatVal,
        profAbout: aboutVal,
        profDelivery: deliveryVal,
        links: linksVal,
        portfolio: portfolioVal,
        profName: draftNameVal,
        profCategory: draftCatVal,
        profSkills: draftSkillsVal,
        profRate: draftRateVal,
        profUsdcRate: usdcRateVal,
        profRateType: rateTypeVal,
        profQuote: draftBioVal,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [address, directory.myRegistered, ensureAuthenticated]);

  // Synchronize canonical Directory profile when registered
  useEffect(() => {
    if (!address || !directory.myRegistered || !directory.myProfile || isPrefilled.current) return;
    let rateVal = '';
    try {
      rateVal = String(Number(formatUnits(BigInt(directory.myProfile.rate || 0), 18)));
    } catch {
      rateVal = '';
    }
    setProfName(String(directory.myProfile.name || ''));
    setProfCategory(String(directory.myProfile.category || 'Web Development'));
    setProfSkills((directory.myProfile.skills || []).join(', '));
    setProfRate(rateVal);
    setProfQuote(String(directory.myProfile.bio || ''));
    isPrefilled.current = true;
  }, [address, directory.myRegistered, directory.myProfile]);

  // Fallback for Professional Name: prefill from Display Name if empty & unregistered
  useEffect(() => {
    if (!directory.myRegistered && !profName.trim() && nameDraft.trim()) {
      setProfName(nameDraft.trim());
    }
  }, [nameDraft, directory.myRegistered, profName]);

  // Dirty state logic
  const isOffChainDirty = useMemo(() => {
    if (!address || !savedBaseline) return false;

    if (nameDraft !== savedBaseline.nameDraft) return true;
    if ((avatar || null) !== (savedBaseline.avatar || null)) return true;
    if (profHeadline !== savedBaseline.profHeadline) return true;
    if (profAbout !== savedBaseline.profAbout) return true;
    if (profDelivery !== savedBaseline.profDelivery) return true;
    if (JSON.stringify(secCategories) !== JSON.stringify(savedBaseline.secCategories)) return true;
    if (JSON.stringify(links) !== JSON.stringify(savedBaseline.links)) return true;
    if (profUsdcRate !== savedBaseline.profUsdcRate) return true;
    if (profRateType !== savedBaseline.profRateType) return true;

    if (!directory.myRegistered) {
      if (profName !== savedBaseline.profName) return true;
      if (profCategory !== savedBaseline.profCategory) return true;
      if (profSkills !== savedBaseline.profSkills) return true;
      if (profRate !== savedBaseline.profRate) return true;
      if (profQuote !== savedBaseline.profQuote) return true;
    }

    return false;
  }, [
    address,
    savedBaseline,
    nameDraft,
    avatar,
    profHeadline,
    profAbout,
    profDelivery,
    secCategories,
    links,
    portfolio,
    profUsdcRate,
    profRateType,
    profName,
    profCategory,
    profSkills,
    profRate,
    profQuote,
    directory.myRegistered,
  ]);

  const isDirectoryDirty = useMemo(() => {
    if (!directory.myRegistered || !directory.myProfile) return false;

    const nameDirty = profName.trim() !== String(directory.myProfile.name || '').trim();
    const catDirty = profCategory.trim() !== String(directory.myProfile.category || '').trim();

    const currentSkills = profSkills
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8);
    const canonicalSkills = (directory.myProfile.skills || []).map((s: unknown) => String(s).trim()).filter(Boolean);
    const skillsDirty = currentSkills.join(',') !== canonicalSkills.join(',');

    const currentRateNum = Number(profRate);
    let canonicalRateNum = 0;
    try {
      canonicalRateNum = Number(formatUnits(BigInt(directory.myProfile.rate || 0), 18));
    } catch {
      canonicalRateNum = 0;
    }
    const rateDirty = !isNaN(currentRateNum) && Math.abs(currentRateNum - canonicalRateNum) > 1e-8;

    const bioDirty = profQuote.trim() !== String(directory.myProfile.bio || '').trim();

    return nameDirty || catDirty || skillsDirty || rateDirty || bioDirty;
  }, [directory.myRegistered, directory.myProfile, profName, profCategory, profSkills, profRate, profQuote]);

  const isPageDirty = isOffChainDirty || isDirectoryDirty;

  // Persist all off-chain profile changes (0 gas / 0 wallet transactions)
  const saveFullOffChainProfile = async (keepBusy = false): Promise<boolean> => {
    if (!address) {
      setSaveError('Connect your wallet first');
      return false;
    }

    setSavingAll(true);
    setSaveError('');
    setSaveSuccess(false);

    try {
      const token = await ensureAuthenticated();

      // 1. Save Personal Profile
      const personalRes = await fetch('/api/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          walletAddress: address,
          name: nameDraft,
          ...(avatar !== undefined ? { avatar: avatar || '' } : {}),
        }),
      });

      if (personalRes.status === 401) {
        clearSession();
        setSaveError('Authorization expired. Please click Save Profile again to authenticate.');
        setSavingAll(false);
        return false;
      }

      if (!personalRes.ok) {
        const d = await personalRes.json().catch(() => ({}));
        setSaveError(d.error || 'Could not save personal profile');
        setSavingAll(false);
        return false;
      }

      // Update local display name state & dispatch refresh event for Sidebar
      setScopedUsername(address, nameDraft);
      setUsername(nameDraft);
      window.dispatchEvent(
        new CustomEvent('synq:displayname', {
          detail: { wallet: address.toLowerCase(), name: nameDraft },
        }),
      );

      // 2. Validate Link Formats
      const linkKeys = ['website', 'github', 'twitter', 'linkedin'] as const;
      for (const k of linkKeys) {
        const val = links[k];
        if (val.trim()) {
          if (val.trim().length > 300) {
            setSaveError(`Link '${k}' exceeds 300 characters limit`);
            setSavingAll(false);
            return false;
          }
          if (!isValidHttpUrl(val)) {
            setSaveError(`Link '${k}' must start with http:// or https://`);
            setSavingAll(false);
            return false;
          }
        }
      }

      // 3. Validate Portfolio Projects
      for (let i = 0; i < portfolio.length; i++) {
        const p = portfolio[i];
        if (!p.title.trim()) {
          setSaveError(`Portfolio project #${i + 1} requires a title`);
          setSavingAll(false);
          return false;
        }
        if (p.title.length > 100) {
          setSaveError(`Portfolio project #${i + 1} title exceeds 100 characters limit`);
          setSavingAll(false);
          return false;
        }
        if (p.description.length > 600) {
          setSaveError(`Portfolio project #${i + 1} description exceeds 600 characters limit`);
          setSavingAll(false);
          return false;
        }
        if (p.image.trim() && !isValidHttpUrl(p.image)) {
          setSaveError(`Portfolio project #${i + 1} image URL must start with http:// or https://`);
          setSavingAll(false);
          return false;
        }
        if (p.link.trim() && !isValidHttpUrl(p.link)) {
          setSaveError(`Portfolio project #${i + 1} link URL must start with http:// or https://`);
          setSavingAll(false);
          return false;
        }
      }

      // 4. Validate and prepare modern USDC Starting Rate if provided
      let cleanStartingRateAmount: string | null = null;
      let cleanStartingRateType: 'PER_PROJECT' | 'PER_HOUR' | null = null;
      if (profUsdcRate.trim()) {
        const pricingRes = validateUsdcPricing(profUsdcRate, profRateType);
        if (!pricingRes.valid) {
          setSaveError(pricingRes.error || 'Invalid USDC starting rate');
          setSavingAll(false);
          return false;
        }
        cleanStartingRateAmount = pricingRes.cleanAmount!;
        cleanStartingRateType = pricingRes.cleanType!;
      }

      // 5. Save Rich Market Metadata & Drafts
      const skillsArray = profSkills
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8);

      const marketRes = await fetch(`/api/profile/market/${address}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          wallet: address,
          headline: profHeadline,
          secondaryCategories: secCategories,
          about: profAbout,
          typicalDelivery: profDelivery,
          links,
          portfolio,
          startingRateAmount: cleanStartingRateAmount,
          startingRateCurrency: cleanStartingRateAmount ? 'USDC' : null,
          startingRateType: cleanStartingRateType,
          draftName: profName,
          draftCategory: profCategory,
          draftSkills: skillsArray,
          draftRate: profRate,
          draftBio: profQuote,
        }),
      });

      if (!marketRes.ok) {
        const d = await marketRes.json().catch(() => ({}));
        setSaveError(d.error || 'Could not save professional details');
        setSavingAll(false);
        return false;
      }

      // Update baseline saved off-chain object
      setSavedBaseline({
        nameDraft,
        avatar: avatar || null,
        profHeadline,
        secCategories: [...secCategories],
        profAbout,
        profDelivery,
        links: { ...links },
        portfolio: JSON.parse(JSON.stringify(portfolio)),
        profName,
        profCategory,
        profSkills,
        profRate,
        profUsdcRate: cleanStartingRateAmount || '',
        profRateType: cleanStartingRateType || 'PER_PROJECT',
        profQuote,
      });

      if (!keepBusy) {
        setSavingAll(false);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
      }
      return true;
    } catch (err: any) {
      setSavingAll(false);
      setSaveError(err?.message || 'Network error while saving profile');
      return false;
    }
  };

  // Photo handlers
  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    setPhotoError('');
    if (!address) {
      setPhotoError('Connect your wallet to save a photo.');
      return;
    }
    setPhotoBusy(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file, 256, 0.8);
      const token = await ensureAuthenticated();
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ walletAddress: address, avatar: dataUrl }),
      });
      if (!res.ok) {
        setPhotoError('Could not save photo.');
      } else {
        setAvatar(dataUrl);
      }
    } catch (err: any) {
      setPhotoError(err?.message || 'Could not process image.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    if (!address) return;
    setPhotoError('');
    setPhotoBusy(true);
    try {
      const token = await ensureAuthenticated();
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ walletAddress: address, avatar: '' }),
      });
      if (res.ok) setAvatar(null);
      else setPhotoError('Could not remove photo.');
    } catch (err: any) {
      setPhotoError(err?.message || 'Could not remove photo.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  // Secondary Category Helpers
  const addSecondaryCategory = () => {
    const trimmed = newSecCat.trim();
    if (!trimmed) return;
    if (trimmed.length > 40) return;
    if (secCategories.length >= 4) return;
    if (
      secCategories.some((c) => c.toLowerCase() === trimmed.toLowerCase()) ||
      trimmed.toLowerCase() === profCategory.toLowerCase()
    ) {
      setNewSecCat('');
      return;
    }
    setSecCategories([...secCategories, trimmed]);
    setNewSecCat('');
  };

  const removeSecondaryCategory = (catToRemove: string) => {
    setSecCategories(secCategories.filter((c) => c !== catToRemove));
  };

  // Portfolio Helpers
  const addPortfolioProject = () => {
    if (portfolio.length >= 6) return;
    const newProj: PortfolioProject = {
      id: genLocalProjId(),
      title: 'New Project',
      description: '',
      image: '',
      link: '',
      tags: [],
    };
    setPortfolio([...portfolio, newProj]);
    setActiveProjIdx(portfolio.length);
  };

  const updatePortfolioProject = (idx: number, patch: Partial<PortfolioProject>) => {
    setPortfolio((prev) => {
      const updated = [...prev];
      if (updated[idx]) {
        updated[idx] = { ...updated[idx], ...patch };
      }
      return updated;
    });
  };

  const removePortfolioProject = (idx: number) => {
    setPortfolio((prev) => prev.filter((_, i) => i !== idx));
    if (activeProjIdx === idx) setActiveProjIdx(-1);
    else if (activeProjIdx > idx) setActiveProjIdx(activeProjIdx - 1);
  };

  // On-Chain Registration Trigger
  const submitRegisterFreelancer = async () => {
    if (!address) {
      setRegisterError('Connect your wallet first');
      return;
    }
    const cleanName = profName.trim() || nameDraft.trim() || username.trim();
    if (cleanName.length < 2) {
      setRegisterError('Enter a valid Professional / Studio Name (2-40 chars)');
      return;
    }
    const pricingRes = validateUsdcPricing(profUsdcRate, profRateType);
    if (!pricingRes.valid) {
      setRegisterError(pricingRes.error || 'Enter a valid starting rate in USDC (> 0)');
      return;
    }
    const rateNum = Number(profRate);
    if (!rateNum || rateNum <= 0 || !isFinite(rateNum)) {
      setRegisterError('Enter a valid starting rate in ETH (> 0)');
      return;
    }
    const skillsArray = profSkills
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8);
    if (skillsArray.length === 0) {
      setRegisterError('Add at least one core skill');
      return;
    }
    setRegisterError('');

    try {
      // 1. Save off-chain profile first
      const saved = await saveFullOffChainProfile();
      if (!saved) return;

      // 2. Submit on-chain registration transaction
      const rateWei = BigInt(Math.round(rateNum * 1e18));
      const args = [cleanName, profCategory, skillsArray, rateWei, profQuote.trim()] as const;

      setDirectoryTxSubmitted(true);
      await directory.registerProfile(...args);
    } catch (err: any) {
      setDirectoryTxSubmitted(false);
      setRegisterError(`Registration failed: ${String(err?.message || err).slice(0, 120)}`);
    }
  };

  // Unified Save Profile Handler (Off-Chain + On-Chain Directory)
  const handleUnifiedSaveProfile = async () => {
    if (!address) {
      setSaveError('Connect your wallet first');
      return;
    }

    setSaveError('');
    setRegisterError('');
    setSaveSuccess(false);

    // If Directory fields changed for registered freelancer, validate them first
    if (isDirectoryDirty) {
      const cleanName = profName.trim();
      if (cleanName.length < 2) {
        setSaveError('Professional / Studio Name must be at least 2 characters');
        return;
      }
      const rateNum = Number(profRate);
      if (!rateNum || rateNum <= 0 || !isFinite(rateNum)) {
        setSaveError('Enter a valid starting rate in ETH (> 0)');
        return;
      }
      const skillsArray = profSkills
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8);
      if (skillsArray.length === 0) {
        setSaveError('Add at least one core skill');
        return;
      }
      if (!networkReady) {
        setSaveError('Please switch to Sepolia network to update your freelancer listing');
        return;
      }
    }

    setSavingAll(true);

    try {
      // 1. Save Off-Chain Profile & Market Data first
      const savedOk = await saveFullOffChainProfile(isDirectoryDirty);
      if (!savedOk) {
        return;
      }

      // If directory fields did NOT change, off-chain save complete!
      if (!isDirectoryDirty) {
        return;
      }

      // 2. Directory fields changed -> Request on-chain updateProfile transaction
      const cleanName = profName.trim();
      const rateNum = Number(profRate);
      const rateWei = BigInt(Math.round(rateNum * 1e18));
      const skillsArray = profSkills
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8);

      const args = [cleanName, profCategory, skillsArray, rateWei, profQuote.trim()] as const;

      setDirectoryTxSubmitted(true);
      const txHash = await directory.updateProfile(...args);

      if (!txHash) {
        setDirectoryTxSubmitted(false);
        setSubmittedDirectoryTxHash(null);
        setSavingAll(false);
        setSaveError('Profile details saved off-chain, but freelancer listing update was rejected or failed.');
        return;
      }
      setSubmittedDirectoryTxHash(txHash as string);
    } catch (err: any) {
      setDirectoryTxSubmitted(false);
      setSubmittedDirectoryTxHash(null);
      setSavingAll(false);
      setSaveError(`Profile details saved off-chain, but freelancer update failed: ${String(err?.message || err).slice(0, 100)}`);
    }
  };

  // Availability Toggle Trigger
  const handleSetAvailable = async (newVal: boolean) => {
    if (!address) return;
    setAvailBusy(true);
    try {
      await directory.setAvailable(newVal);
    } catch {
      /* handled by directory.writeError */
    } finally {
      setAvailBusy(false);
    }
  };

  return (
    <div className="space-y-6 pt-0 max-w-5xl mx-auto">
      {/* 1. TITLE ROW WITH TOOLTIP */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <h1 className={`${pressStart2P.className} text-xl md:text-2xl font-normal text-white tracking-tight`}>
            Profile
          </h1>
          <div className="relative group inline-block">
            <button
              type="button"
              tabIndex={0}
              aria-label="About Profile"
              className="w-5 h-5 rounded-full bg-zinc-800/80 hover:bg-zinc-800 border border-zinc-700/60 text-zinc-400 hover:text-white text-[11px] font-bold font-mono inline-flex items-center justify-center shrink-0 transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            >
              ?
            </button>
            <div className="absolute left-0 top-full mt-2 w-72 sm:w-80 p-3 rounded-xl bg-zinc-900 border border-zinc-700/80 text-zinc-200 text-xs leading-relaxed shadow-2xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-all duration-150 z-30">
              Manage your Synq identity and professional profile. Freelancer listing fields can be prepared anytime and published to Deal Port when you choose.
            </div>
          </div>
        </div>
      </div>

      <ChainGuard what="your profile settings are" />

      {/* 2. UNIFIED SINGLE-PAGE PROFILE SURFACE */}
      <div className="p-6 md:p-8 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-8">
        {/* ==================================================
            HERO IDENTITY HEADER
        ================================================== */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 pb-6 border-b border-zinc-800/80">
          <div className="flex items-center gap-5 min-w-0 flex-1">
            <Avatar
              name={username || registry.username || 'User'}
              src={avatar}
              size={96}
              className="w-24 h-24 rounded-2xl border border-zinc-700/60 shrink-0"
            />
            <div className="space-y-1.5 min-w-0 flex-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2 className="text-2xl md:text-3xl font-bold text-white truncate">
                  {username || (address ? (registry.username ? `@${registry.username}` : shortenAddress(address)) : 'Guest User')}
                </h2>
                {registry.username && (
                  <Badge variant="info" className="text-[10px] px-1.5 py-0 font-medium shrink-0">
                    On-chain ✓
                  </Badge>
                )}
                {directory.myRegistered && (
                  <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px] px-1.5 py-0 font-medium shrink-0">
                    Freelancer Active
                  </Badge>
                )}
              </div>
              {registry.username ? (
                <div className="text-sm md:text-base font-mono text-blue-400 font-semibold truncate">
                  @{registry.username}
                </div>
              ) : (
                <div className="text-sm text-zinc-500 font-mono truncate">
                  No Synq handle claimed
                </div>
              )}
              <div className="text-xs text-zinc-400 flex items-center gap-4 sm:gap-5 flex-wrap pt-0.5 min-w-0">
                <div className="font-mono flex items-center gap-1.5 shrink-0">
                  <span>{address ? shortenAddress(address) : 'Wallet disconnected'}</span>
                  {address && (
                    <button
                      type="button"
                      onClick={copyAddress}
                      className="text-zinc-400 hover:text-white transition-colors"
                      title="Copy wallet address"
                    >
                      {copied ? <Check size={12} className="text-emerald-400 inline" /> : <Copy size={12} className="inline" />}
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (typeof window !== 'undefined') {
                      window.dispatchEvent(new CustomEvent('synq:open-email-bind'));
                    }
                  }}
                  className="flex items-center gap-1.5 min-w-0 max-w-[220px] sm:max-w-[280px] text-left hover:opacity-80 transition-opacity group"
                  title={linkedEmail ? 'Manage notification email' : 'Connect email for deal notifications'}
                >
                  <Mail size={13} className={`shrink-0 ${linkedEmail ? 'text-emerald-400' : 'text-blue-400'}`} />
                  {linkedEmail ? (
                    <span className="text-zinc-300 truncate font-mono group-hover:text-white transition-colors">{linkedEmail}</span>
                  ) : (
                    <span className="text-blue-400 truncate text-xs font-medium hover:underline underline-offset-2">Link notification email</span>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Clean Edit Button on right side of Hero */}
          <div className="flex items-center gap-2 shrink-0 self-start sm:self-center">
            <input ref={fileRef} type="file" accept="image/*" onChange={onPickPhoto} className="hidden" />
            <Button
              type="button"
              variant="outline"
              onClick={openEditModal}
              className="gap-2 border-zinc-700 text-zinc-200 hover:text-white hover:bg-zinc-800 text-xs font-semibold h-9 px-4 shrink-0"
            >
              <Pencil size={14} /> Edit
            </Button>
          </div>
        </div>
        {photoError && <p className="text-xs text-red-400">{photoError}</p>}

        {/* ==================================================
            DEAL PORT FREELANCER PROFILE STATUS
        ================================================== */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
              <Layers size={14} className="text-blue-400" /> Deal Port Freelancer Profile Status
            </h2>
            <span className="text-[10px] font-mono text-zinc-500 bg-zinc-800/60 rounded px-1.5 py-0.5">
              On-chain status
            </span>
          </div>

          {!directory.myRegistered ? (
            /* UNREGISTERED FREELANCER STATE */
            <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <CircleAlert size={15} className="text-blue-400 shrink-0" />
                Offer your services on Deal Port
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Registering publishes your professional listing on-chain to <span className="font-mono text-zinc-300">NexotiqDirectory</span> on Sepolia, making you discoverable to clients across Deal Port.
              </p>

              {registerError && <p className="text-xs text-red-400 font-medium">{registerError}</p>}
              {directory.writeError && (
                <p className="text-xs text-red-400">
                  Transaction error:{' '}
                  {String(
                    (directory.writeError as any).shortMessage ||
                      (directory.writeError as any).message ||
                      directory.writeError
                  ).slice(0, 120)}
                </p>
              )}

              <div className="flex items-center gap-3 pt-1 flex-wrap">
                <Button
                  type="button"
                  onClick={submitRegisterFreelancer}
                  disabled={directory.isPending || !isConnected || !networkReady}
                  className="gap-2 bg-blue-600 hover:bg-blue-500 text-white text-xs h-9 px-4 font-semibold shrink-0"
                >
                  {directory.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {directory.isPending ? 'Signing Transaction...' : 'Register as Freelancer'}
                </Button>
                <span className="text-[11px] text-zinc-500">Requires wallet signature • Sepolia</span>
              </div>
            </div>
          ) : (
            /* REGISTERED FREELANCER STATE */
            <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                  <CircleCheck size={16} /> Freelancer Listing Active on Deal Port
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => address && setPublicProfileModalWallet(address)}
                  className="gap-1.5 border-zinc-700 text-zinc-300 hover:text-white text-xs h-8 px-3"
                >
                  <Eye size={13} /> View Public Profile
                </Button>
              </div>

              {/* Availability Control */}
              <div className="p-3 rounded-lg bg-zinc-900/80 border border-zinc-800 flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-2">
                  <Power size={14} className={directory.myProfile?.available ? 'text-emerald-400' : 'text-zinc-500'} />
                  <div>
                    <p className="text-xs font-medium text-white">Availability Status</p>
                    <p className="text-[11px] text-zinc-400">
                      {directory.myProfile?.available ? 'Available for new client work' : 'Busy / Currently unavailable'}
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={directory.myProfile?.available ? 'outline' : 'default'}
                  disabled={availBusy || directory.isPending}
                  onClick={() => handleSetAvailable(!directory.myProfile?.available)}
                  className="h-8 text-xs gap-1.5 shrink-0"
                >
                  {availBusy ? <Loader2 size={12} className="animate-spin" /> : null}
                  {directory.myProfile?.available ? 'Set Busy' : 'Set Available'}
                </Button>
              </div>

              {registerError && <p className="text-xs text-red-400 font-medium">{registerError}</p>}
              {directory.writeError && (
                <p className="text-xs text-red-400">
                  Transaction error:{' '}
                  {String(
                    (directory.writeError as any).shortMessage ||
                      (directory.writeError as any).message ||
                      directory.writeError
                  ).slice(0, 120)}
                </p>
              )}
            </div>
          )}
        </div>

        <Separator className="bg-zinc-800/80" />

        {/* ==================================================
            EMAIL & NOTIFICATION PREFERENCES (B.12.3.26)
        ================================================== */}
        <NotificationSettingsSection address={address} onEmailChange={setLinkedEmail} />

        <Separator className="bg-zinc-800/80" />

        {/* ==================================================
            SECTION 1: PROFESSIONAL (ALWAYS VISIBLE)
        ================================================== */}
        <div className="space-y-4">
          <div>
            <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
              <Briefcase size={14} className="text-blue-400" /> Professional Listing
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Professional fields can be prepared anytime. Fields marked with <span className="text-amber-400 font-semibold">*</span> are required to list on Deal Port.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-zinc-300 mb-1 block font-medium">
                Professional / Studio Name <span className="text-amber-400">*</span>
              </label>
              <Input
                value={profName}
                onChange={(e) => setProfName(e.target.value)}
                placeholder="e.g. Alex Morgan Web3 Studio"
                maxLength={40}
              />
            </div>

            <div>
              <label className="text-xs text-zinc-300 mb-1 block font-medium">Professional Headline</label>
              <Input
                value={profHeadline}
                onChange={(e) => setProfHeadline(e.target.value)}
                placeholder="e.g. Senior Smart Contract Auditor &amp; Full-Stack Engineer"
                maxLength={100}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-zinc-300 mb-1 block font-medium">
                Primary Category <span className="text-amber-400">*</span>
              </label>
              <select
                value={profCategory}
                onChange={(e) => setProfCategory(e.target.value)}
                className="w-full h-10 rounded-xl border border-zinc-700 bg-zinc-800/50 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              >
                {SELLER_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-zinc-300 mb-1 block font-medium">
                Core Skills (Max 8, comma separated) <span className="text-amber-400">*</span>
              </label>
              <Input
                value={profSkills}
                onChange={(e) => setProfSkills(e.target.value)}
                placeholder="React, Next.js, Solidity, UI Design"
              />
            </div>
          </div>

          {/* Starting Rate Section — Modern USDC + Directory ETH */}
          <div className="space-y-3 p-4 rounded-xl bg-zinc-950/40 border border-zinc-800">
            <div>
              <span className="text-xs text-zinc-200 font-semibold block uppercase tracking-wider">
                Starting Rate <span className="text-amber-400">*</span>
              </span>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Configure your public marketplace rate in USDC. The on-chain ETH rate is an immutable directory anchor required for registration.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-zinc-300 mb-1 flex items-center justify-between font-medium">
                  <span>In USDC <span className="text-amber-400">*</span></span>
                  <span className="text-[10px] text-blue-400 font-normal">Publicly displayed</span>
                </label>
                <Input
                  type="text"
                  value={profUsdcRate}
                  onChange={(e) => setProfUsdcRate(e.target.value)}
                  placeholder="50.00"
                  className="font-mono text-sm"
                />
              </div>

              <div>
                <label className="text-xs text-zinc-300 mb-1 flex items-center justify-between font-medium">
                  <span>In ETH <span className="text-amber-400">*</span></span>
                  <span className="text-[10px] text-zinc-500 font-normal">On-chain directory rate</span>
                </label>
                <Input
                  type="number"
                  value={profRate}
                  onChange={(e) => setProfRate(e.target.value)}
                  placeholder="0.02"
                  min="0.0001"
                  step="0.01"
                  className="font-mono text-sm"
                />
              </div>
            </div>

            <div className="max-w-xs">
              <label className="text-xs text-zinc-300 mb-1 block font-medium">
                Rate Type <span className="text-amber-400">*</span>
              </label>
              <select
                value={profRateType}
                onChange={(e) => setProfRateType(e.target.value as 'PER_PROJECT' | 'PER_HOUR')}
                className="w-full h-10 rounded-xl border border-zinc-700 bg-zinc-800/50 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              >
                <option value="PER_PROJECT">Per Project</option>
                <option value="PER_HOUR">Per Hour</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs text-zinc-300 mb-1 block font-medium">Typical Delivery Time</label>
            <Input
              value={profDelivery}
              onChange={(e) => setProfDelivery(e.target.value)}
              placeholder="e.g. 2–4 days per milestone"
              maxLength={60}
            />
          </div>

          <div>
            <label className="text-xs text-zinc-300 mb-1 flex items-center justify-between font-medium">
              <span>Personal Quote</span>
              <span className="text-[10px] text-zinc-500">{profQuote.length} / 300</span>
            </label>
            <textarea
              value={profQuote}
              onChange={(e) => setProfQuote(e.target.value)}
              placeholder="A short line that represents you or how you work..."
              maxLength={300}
              className="w-full h-16 rounded-xl border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
            />
          </div>

          {/* Secondary Professional Areas */}
          <div>
            <label className="text-xs text-zinc-300 mb-1 block font-medium">Secondary Professional Areas (Max 4)</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {secCategories.map((cat) => (
                <span
                  key={cat}
                  className="text-xs font-medium text-blue-300 bg-blue-500/10 border border-blue-500/20 rounded-md px-2.5 py-1 flex items-center gap-1.5"
                >
                  {cat}
                  <button
                    type="button"
                    onClick={() => removeSecondaryCategory(cat)}
                    className="text-zinc-400 hover:text-red-400"
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>

            {secCategories.length < 4 && (
              <div className="flex items-center gap-2 max-w-xs">
                <Input
                  value={newSecCat}
                  onChange={(e) => setNewSecCat(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addSecondaryCategory();
                    }
                  }}
                  placeholder="Add area (e.g. Audit, DevOps)"
                  maxLength={40}
                  className="h-9 text-xs"
                />
                <Button type="button" size="sm" variant="outline" onClick={addSecondaryCategory} className="h-9 px-3 text-xs shrink-0">
                  Add
                </Button>
              </div>
            )}
          </div>
        </div>

        <Separator className="bg-zinc-800/80" />

        {/* ==================================================
            SECTION 3: ABOUT & LINKS
        ================================================== */}
        <div className="space-y-4">
          <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
            <Globe size={14} className="text-blue-400" /> About &amp; Links
          </h2>

          <div>
            <label className="text-xs text-zinc-300 mb-1 flex items-center justify-between font-medium">
              <span>Full About Narrative</span>
              <span className="text-[10px] text-zinc-500">{profAbout.length} / 2000</span>
            </label>
            <textarea
              value={profAbout}
              onChange={(e) => setProfAbout(e.target.value)}
              placeholder="Detail your background, workflow, tech stack, and achievements..."
              maxLength={2000}
              className="w-full h-24 rounded-xl border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-zinc-400 mb-1 flex items-center gap-1.5 font-medium">
                <Globe size={13} className="text-blue-400" /> Website URL
              </label>
              <Input
                value={links.website}
                onChange={(e) => setLinks({ ...links, website: e.target.value })}
                placeholder="https://yourwebsite.io"
                maxLength={300}
              />
            </div>

            <div>
              <label className="text-xs text-zinc-400 mb-1 flex items-center gap-1.5 font-medium">
                <Code size={13} className="text-zinc-300" /> GitHub URL
              </label>
              <Input
                value={links.github}
                onChange={(e) => setLinks({ ...links, github: e.target.value })}
                placeholder="https://github.com/username"
                maxLength={300}
              />
            </div>

            <div>
              <label className="text-xs text-zinc-400 mb-1 flex items-center gap-1.5 font-medium">
                <Globe size={13} className="text-sky-400" /> X / Twitter URL
              </label>
              <Input
                value={links.twitter}
                onChange={(e) => setLinks({ ...links, twitter: e.target.value })}
                placeholder="https://x.com/username"
                maxLength={300}
              />
            </div>

            <div>
              <label className="text-xs text-zinc-400 mb-1 flex items-center gap-1.5 font-medium">
                <Briefcase size={13} className="text-blue-500" /> LinkedIn URL
              </label>
              <Input
                value={links.linkedin}
                onChange={(e) => setLinks({ ...links, linkedin: e.target.value })}
                placeholder="https://linkedin.com/in/username"
                maxLength={300}
              />
            </div>
          </div>
        </div>

        <Separator className="bg-zinc-800/80" />

        {/* ==================================================
            SECTION 4: PORTFOLIO
        ================================================== */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                <Sparkles size={14} className="text-blue-400" /> Portfolio
              </h2>
              <span className="text-[10px] font-mono text-zinc-400 bg-zinc-800 rounded px-1.5 py-0.5">
                {portfolio.length} / 6
              </span>
            </div>
            {portfolio.length < 6 && (
              <Button type="button" size="sm" variant="outline" onClick={addPortfolioProject} className="gap-1 text-xs h-8 px-3">
                <Plus size={13} /> Add Project
              </Button>
            )}
          </div>

          {portfolio.length === 0 ? (
            <p className="text-xs text-zinc-500 py-3 px-4 text-center bg-zinc-950/40 border border-dashed border-zinc-800 rounded-xl">
              No portfolio projects added yet. Click &quot;Add Project&quot; above to showcase past work.
            </p>
          ) : (
            <div className="space-y-3">
              {portfolio.map((proj, idx) => (
                <div key={proj.id || idx} className="p-3.5 rounded-xl bg-zinc-800/40 border border-zinc-700/60 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-blue-400">#{idx + 1}</span>
                      <span className="text-xs font-semibold text-white">{proj.title || 'Untitled Project'}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveProjIdx(activeProjIdx === idx ? -1 : idx)}
                        className="text-xs text-blue-400 hover:text-blue-300 font-medium"
                      >
                        {activeProjIdx === idx ? 'Collapse' : 'Edit Details'}
                      </button>
                      <button
                        type="button"
                        onClick={() => removePortfolioProject(idx)}
                        className="text-zinc-400 hover:text-red-400 p-0.5"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {activeProjIdx === idx ? (
                    <div className="space-y-3 pt-2 border-t border-zinc-700/40">
                      <div>
                        <label className="text-[11px] text-zinc-400 mb-1 block">Project Title</label>
                        <Input
                          value={proj.title}
                          onChange={(e) => updatePortfolioProject(idx, { title: e.target.value })}
                          placeholder="e.g. DeFi Lending Protocol Frontend"
                          maxLength={100}
                        />
                      </div>

                      <div>
                        <label className="text-[11px] text-zinc-400 mb-1 flex items-center justify-between">
                          <span>Description</span>
                          <span className="text-[10px] text-zinc-500">{proj.description.length} / 600</span>
                        </label>
                        <textarea
                          value={proj.description}
                          onChange={(e) => updatePortfolioProject(idx, { description: e.target.value })}
                          placeholder="Describe your role, stack, and deliverables..."
                          maxLength={600}
                          className="w-full h-16 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-1.5 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="text-[11px] text-zinc-400 mb-1 block">Image URL (Optional)</label>
                          <Input
                            value={proj.image}
                            onChange={(e) => updatePortfolioProject(idx, { image: e.target.value })}
                            placeholder="https://example.com/image.jpg"
                            maxLength={500}
                          />
                        </div>

                        <div>
                          <label className="text-[11px] text-zinc-400 mb-1 block">Live Link URL (Optional)</label>
                          <Input
                            value={proj.link}
                            onChange={(e) => updatePortfolioProject(idx, { link: e.target.value })}
                            placeholder="https://example.com"
                            maxLength={500}
                          />
                        </div>
                      </div>

                      <div>
                        <label className="text-[11px] text-zinc-400 mb-1 block">Project Tags (Comma separated)</label>
                        <Input
                          value={proj.tags.join(', ')}
                          onChange={(e) =>
                            updatePortfolioProject(idx, {
                              tags: e.target.value
                                .split(',')
                                .map((t) => t.trim())
                                .filter(Boolean)
                                .slice(0, 8),
                            })
                          }
                          placeholder="React, Ethers.js, Tailwind"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-zinc-400 flex items-center justify-between">
                      <span className="truncate max-w-md">{proj.description || 'No description added yet.'}</span>
                      {proj.link && (
                        <a
                          href={proj.link}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-400 flex items-center gap-1 shrink-0 text-[11px]"
                        >
                          <ExternalLink size={11} /> Link
                        </a>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>



        {/* SAVE PROFILE FOOTER BAR */}
        <div className="pt-4 border-t border-zinc-800/80 flex items-center justify-between flex-wrap gap-4">
          <div>
            {saveError && <p className="text-xs text-red-400 font-medium">{saveError}</p>}
            {saveSuccess && (
              <p className="text-xs text-emerald-400 flex items-center gap-1.5 font-medium">
                <Check size={14} /> Profile saved successfully!
              </p>
            )}
            {!saveError && !saveSuccess && (
              <>
                {directoryTxSubmitted || directory.isPending ? (
                  <p className="text-[11px] text-blue-400 font-mono flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" /> On-chain transaction pending... confirm in wallet
                  </p>
                ) : isDirectoryDirty ? (
                  <p className="text-[11px] text-blue-400">
                    Includes on-chain freelancer listing changes • wallet confirmation required
                  </p>
                ) : isOffChainDirty ? (
                  <p className="text-[11px] text-zinc-400">
                    Profile updates save instantly • no wallet transaction
                  </p>
                ) : (
                  <p className="text-[11px] text-zinc-500">All changes saved</p>
                )}
              </>
            )}
          </div>

          <Button
            type="button"
            onClick={handleUnifiedSaveProfile}
            disabled={!isPageDirty || savingAll || directoryTxSubmitted || directory.isPending || !address}
            className="gap-2 bg-blue-600 hover:bg-blue-500 text-white text-xs h-9 px-5 font-semibold shrink-0 disabled:opacity-50"
          >
            {savingAll || directoryTxSubmitted || directory.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {directoryTxSubmitted ? (
              directory.txReceipt.isLoading ? 'Confirming on-chain...' : 'Confirm in wallet...'
            ) : savingAll ? (
              'Saving...'
            ) : (
              'Save Profile'
            )}
          </Button>
        </div>
      </div>

      {/* PUBLIC PROFILE PREVIEW MODAL */}
      {publicProfileModalWallet && (
        <ProviderProfileModal
          wallet={publicProfileModalWallet}
          onClose={() => setPublicProfileModalWallet(null)}
        />
      )}

      {/* COMPACT PROFILE EDIT POPUP MODAL */}
      <AnimatePresence>
        {editModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={closeEditModal}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.15 }}
              className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl p-6 relative text-white space-y-5"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header with Title and Close X */}
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80">
                <h3 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
                  <Pencil size={15} className="text-blue-400" /> Edit Profile
                </h3>
                <button
                  type="button"
                  onClick={closeEditModal}
                  disabled={popupBusy}
                  className="w-7 h-7 rounded-lg bg-zinc-800/60 hover:bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center transition-colors disabled:opacity-50"
                  aria-label="Close modal"
                >
                  <X size={15} />
                </button>
              </div>

              {/* Hidden File Input for Popup Avatar */}
              <input
                ref={popupFileRef}
                type="file"
                accept="image/*"
                onChange={onPickPopupPhoto}
                className="hidden"
              />

              {/* PFP Section (Click photo to change) */}
              <div className="flex flex-col items-center justify-center py-1 space-y-2">
                <div
                  onClick={() => !popupBusy && popupFileRef.current?.click()}
                  className="relative group cursor-pointer"
                >
                  <Avatar
                    name={popupName || popupHandle || 'User'}
                    src={popupAvatar}
                    size={96}
                    className="w-24 h-24 rounded-2xl border-2 border-zinc-700/80 object-cover shadow-md group-hover:border-blue-500/80 transition-colors shrink-0"
                  />
                  <div className="absolute inset-0 bg-black/60 rounded-2xl opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center text-white transition-opacity gap-1">
                    <Camera size={20} />
                    <span className="text-[10px] font-semibold uppercase tracking-wider">Change</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => !popupBusy && popupFileRef.current?.click()}
                    disabled={popupBusy}
                    className="text-xs text-zinc-400 hover:text-blue-400 font-medium transition-colors"
                  >
                    Click photo to change
                  </button>
                  {popupAvatar && (
                    <button
                      type="button"
                      onClick={removePopupPhoto}
                      disabled={popupBusy}
                      className="text-xs text-zinc-500 hover:text-red-400 transition-colors flex items-center gap-1"
                      title="Remove photo"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>

              {/* Inputs & Form Area */}
              <div className="space-y-4">
                {/* Display Name Input */}
                <div>
                  <label className="text-xs font-semibold text-zinc-300 block mb-1">
                    Display Name
                  </label>
                  <Input
                    value={popupName}
                    onChange={(e) => setPopupName(e.target.value)}
                    placeholder="e.g. Alex"
                    maxLength={60}
                    disabled={popupBusy}
                    className="bg-zinc-950/80 border-zinc-800 focus:border-blue-500 text-sm"
                  />
                </div>

                {/* Synq Handle Input */}
                <div>
                  <label className="text-xs font-semibold text-zinc-300 block mb-1">
                    Synq Handle
                  </label>
                  <div className="relative flex items-center">
                    <span className="absolute left-3 text-zinc-500 text-sm font-mono select-none">
                      @
                    </span>
                    <Input
                      value={popupHandle}
                      onChange={(e) => setPopupHandle(e.target.value.replace(/^@/, ''))}
                      placeholder="username"
                      maxLength={32}
                      disabled={popupBusy}
                      className="pl-7 bg-zinc-950/80 border-zinc-800 focus:border-blue-500 font-mono text-sm"
                    />
                  </div>

                  {/* Availability Status Feedback */}
                  <div className="mt-1.5 min-h-[20px] flex items-center justify-between">
                    {handleHasChanged ? (
                      cleanCandidateHandle.length === 0 ? (
                        <span className="text-zinc-500 text-xs">Enter handle (3–32 chars)</span>
                      ) : !isHandleSyntaxValid ? (
                        <span className="text-amber-400 text-xs font-medium">3–32 chars, letters, numbers &amp; _ only</span>
                      ) : isCheckingHandle ? (
                        <span className="text-zinc-400 text-xs flex items-center gap-1.5 font-mono">
                          <Loader2 size={12} className="animate-spin text-blue-400" /> Checking availability...
                        </span>
                      ) : isHandleTaken === true ? (
                        <span className="text-red-400 text-xs font-medium flex items-center gap-1">
                          <X size={12} /> Already taken
                        </span>
                      ) : isHandleTaken === false ? (
                        <span className="text-emerald-400 text-xs font-medium flex items-center gap-1">
                          <Check size={12} /> Available
                        </span>
                      ) : null
                    ) : (
                      <span className="text-zinc-500 text-xs font-mono">Current Synq handle</span>
                    )}
                  </div>
                </div>

                {/* Email (Private Notification Account) */}
                <div className="pt-2 border-t border-zinc-800/60">
                  <ProfileEmail address={address} onEmailChange={setLinkedEmail} />
                </div>

                {/* Read-Only Wallet */}
                <div>
                  <label className="text-xs font-semibold text-zinc-300 block mb-1">
                    Wallet
                  </label>
                  <div className="h-9 rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 flex items-center justify-between font-mono text-xs text-zinc-400">
                    <span>{address ? shortenAddress(address) : 'Not connected'}</span>
                    {address && (
                      <button
                        type="button"
                        onClick={() => {
                          if (address) {
                            navigator.clipboard.writeText(address);
                            setPopupCopied(true);
                            setTimeout(() => setPopupCopied(false), 1500);
                          }
                        }}
                        className="text-zinc-400 hover:text-white transition-colors"
                      >
                        {popupCopied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* On-Chain Transaction Notice when Handle Changed */}
              {handleHasChanged && isHandleSyntaxValid && !isHandleTaken && (
                <div className="p-2.5 rounded-xl bg-blue-950/40 border border-blue-800/40 text-blue-300 text-xs flex items-center gap-2">
                  <CircleAlert size={14} className="shrink-0 text-blue-400" />
                  <span>Changing your Synq handle requires an on-chain transaction.</span>
                </div>
              )}

              {/* Inline Error Message */}
              {popupError && (
                <div className="p-2.5 rounded-xl bg-red-950/40 border border-red-800/40 text-red-300 text-xs flex items-center gap-2">
                  <CircleAlert size={14} className="shrink-0 text-red-400" />
                  <span>{popupError}</span>
                </div>
              )}

              {/* Action Buttons Footer */}
              <div className="flex items-center justify-between pt-2 border-t border-zinc-800/80 gap-3">
                <div className="text-xs font-mono text-zinc-400 truncate">
                  {popupStepMsg && (
                    <span className="flex items-center gap-1.5 text-blue-400">
                      <Loader2 size={12} className="animate-spin" /> {popupStepMsg}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={closeEditModal}
                    disabled={popupBusy}
                    className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-xs h-9 px-3.5"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={savePopupIdentity}
                    disabled={
                      popupBusy ||
                      (handleHasChanged && (!isHandleSyntaxValid || isCheckingHandle || isHandleTaken === true))
                    }
                    className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold h-9 px-4 gap-1.5"
                  >
                    {popupBusy ? (
                      <>
                        <Loader2 size={13} className="animate-spin" />
                        <span>Saving...</span>
                      </>
                    ) : (
                      <span>Save</span>
                    )}
                  </Button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
