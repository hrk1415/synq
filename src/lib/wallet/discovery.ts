import type { Connector } from 'wagmi';

export interface CuratedWalletMeta {
  src: string;
  color: string;
  bg: string;
  textColor: string;
  description: string;
}

export const KNOWN_WALLETS_BY_RDNS: Record<string, CuratedWalletMeta> = {
  'io.metamask': {
    src: '/wallets/metamask.png',
    color: '#f6851b',
    bg: 'bg-orange-500/10 border-orange-500/20',
    textColor: 'text-orange-400',
    description: 'Popular browser extension wallet',
  },
  'io.rabby': {
    src: '/wallets/rabby.jpg',
    color: '#7c3aed',
    bg: 'bg-violet-500/10 border-violet-500/20',
    textColor: 'text-violet-400',
    description: 'Smart contract wallet for power users',
  },
  'app.phantom': {
    src: '/wallets/phantom.png',
    color: '#ab9ff2',
    bg: 'bg-purple-500/10 border-purple-500/20',
    textColor: 'text-purple-400',
    description: 'Multi-chain wallet (EVM + Solana)',
  },
  'com.coinbase.wallet': {
    src: '/wallets/coinbase.png',
    color: '#0052ff',
    bg: 'bg-blue-500/10 border-blue-500/20',
    textColor: 'text-blue-400',
    description: 'Coinbase self-custody extension',
  },
};

/**
 * Validates untrusted EIP-6963 icon URIs.
 * Only allows safe data:image URIs or clean https URLs.
 * Rejects javascript:, vbscript:, data:text/html, and strings with unescaped markup.
 */
export function isSafeIconUri(uri?: unknown): boolean {
  if (typeof uri !== 'string') return false;
  const trimmed = uri.trim();
  if (!trimmed) return false;

  // Safe HTTPS URL
  if (trimmed.startsWith('https://')) {
    return !/[\s<>"'`\\]/.test(trimmed);
  }

  // Safe base64 image data URIs
  if (
    trimmed.startsWith('data:image/png;base64,') ||
    trimmed.startsWith('data:image/jpeg;base64,') ||
    trimmed.startsWith('data:image/webp;base64,') ||
    trimmed.startsWith('data:image/svg+xml;base64,')
  ) {
    const dataPart = trimmed.slice(trimmed.indexOf(',') + 1).trim();
    // Validate strict base64 character set
    return /^[A-Za-z0-9+/=]+$/.test(dataPart);
  }

  return false;
}

/**
 * Sanitizes untrusted wallet names provided by EIP-6963 announcements.
 * Trims whitespace, bounds length to 40 chars, and provides a safe fallback.
 */
export function getWalletDisplayName(rawName?: unknown): string {
  if (typeof rawName !== 'string') return 'Browser Wallet';
  const cleaned = rawName.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
  if (!cleaned) return 'Browser Wallet';
  return cleaned.slice(0, 40);
}

/**
 * Shortens a wallet display name to its first word for compact grid display.
 * E.g.: "Bitget Wallet" -> "Bitget", "Coinbase Wallet" -> "Coinbase", "Trust Wallet" -> "Trust".
 * Single-word names ("MetaMask", "Phantom", "WalletConnect") remain unchanged.
 * Preserves metadata sanitization and safely handles empty or non-string inputs.
 */
export function getCompactWalletName(fullName?: unknown): string {
  const sanitized = getWalletDisplayName(fullName);
  const parts = sanitized.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Browser';
  return parts[0];
}

export interface ClassifiedConnectors {
  detectedWallets: Connector[];
  coinbaseSdk?: Connector;
  walletConnect?: Connector;
  genericInjected?: Connector;
}

/**
 * Classifies connectors from Wagmi's useConnectors() into:
 * - detectedWallets: EIP-6963 announced browser extensions (deduplicated by connector ID/RDNS)
 * - coinbaseSdk: Coinbase SDK fallback (QR/Smart Wallet)
 * - walletConnect: WalletConnect mobile/desktop bridge (if configured)
 * - genericInjected: Standard window.ethereum fallback (used only when no EIP-6963 wallets are present)
 */
export function classifyConnectors(connectors: readonly Connector[]): ClassifiedConnectors {
  const detectedWallets: Connector[] = [];
  const seenIds = new Set<string>();

  let coinbaseSdk: Connector | undefined;
  let walletConnect: Connector | undefined;
  let genericInjected: Connector | undefined;

  for (const c of connectors) {
    if (!c || !c.id) continue;

    if (c.id === 'coinbaseWalletSDK' || c.type === 'coinbaseWallet') {
      if (!coinbaseSdk) coinbaseSdk = c;
      continue;
    }

    if (c.id === 'walletConnect' || c.type === 'walletConnect') {
      if (!walletConnect) walletConnect = c;
      continue;
    }

    if (c.id === 'injected') {
      if (!genericInjected) genericInjected = c;
      continue;
    }

    // EIP-6963 Injected connector: type === 'injected' and id is provider RDNS
    if (c.type === 'injected' && c.id !== 'injected') {
      const normalizedId = c.id.toLowerCase();
      if (!seenIds.has(normalizedId)) {
        seenIds.add(normalizedId);
        detectedWallets.push(c);
      }
    }
  }

  return {
    detectedWallets,
    coinbaseSdk,
    walletConnect,
    genericInjected,
  };
}

export interface GridWalletItem {
  key: string;
  name: string;
  compactName: string;
  iconSrc?: string;
  connector: Connector;
  isInstalled: boolean;
  rdns?: string;
}

/**
 * Builds the compact icon grid items for the B.10.4 wallet connection modal.
 * Preserves all distinct EIP-6963 detected wallets and supported fallbacks.
 * WalletConnect is included whenever configured.
 * Generic injected fallback is included when no EIP-6963 wallets are detected.
 * Coinbase SDK is included as fallback if no Coinbase extension was detected.
 */
export function buildGridWalletItems(connectors: readonly Connector[]): GridWalletItem[] {
  const { detectedWallets, coinbaseSdk, walletConnect, genericInjected } = classifyConnectors(connectors);
  const items: GridWalletItem[] = [];

  let hasCoinbaseDetected = false;

  for (const wallet of detectedWallets) {
    const key = wallet.uid || wallet.id;
    const rdns = typeof wallet.rdns === 'string'
      ? wallet.rdns.toLowerCase()
      : (Array.isArray(wallet.rdns) ? wallet.rdns[0]?.toLowerCase() : '') || wallet.id.toLowerCase();

    if (rdns === 'com.coinbase.wallet') {
      hasCoinbaseDetected = true;
    }

    const curated = KNOWN_WALLETS_BY_RDNS[rdns];
    const iconSrc = curated?.src || (isSafeIconUri(wallet.icon) ? wallet.icon : undefined);

    let fullName = getWalletDisplayName(wallet.name);
    if (curated) {
      if (rdns === 'io.metamask') fullName = 'MetaMask';
      else if (rdns === 'io.rabby') fullName = 'Rabby Wallet';
      else if (rdns === 'app.phantom') fullName = 'Phantom';
      else if (rdns === 'com.coinbase.wallet') fullName = 'Coinbase Wallet';
    }

    const compactName = getCompactWalletName(fullName);

    items.push({
      key,
      name: fullName,
      compactName,
      iconSrc,
      connector: wallet,
      isInstalled: true,
      rdns,
    });
  }

  // Coinbase SDK fallback (if Coinbase extension was not detected)
  if (coinbaseSdk && !hasCoinbaseDetected) {
    items.push({
      key: coinbaseSdk.uid || coinbaseSdk.id,
      name: 'Coinbase Wallet',
      compactName: 'Coinbase',
      iconSrc: '/wallets/coinbase.png',
      connector: coinbaseSdk,
      isInstalled: false,
    });
  }

  // WalletConnect bridge (always included when configured)
  if (walletConnect) {
    items.push({
      key: walletConnect.uid || walletConnect.id,
      name: 'WalletConnect',
      compactName: 'WalletConnect',
      iconSrc: '/wallets/walletconnect.png',
      connector: walletConnect,
      isInstalled: false,
    });
  }

  // Generic injected fallback (only if no EIP-6963 browser extensions were detected)
  if (genericInjected && detectedWallets.length === 0) {
    items.push({
      key: genericInjected.uid || genericInjected.id,
      name: 'Browser Wallet',
      compactName: 'Browser',
      iconSrc: undefined,
      connector: genericInjected,
      isInstalled: false,
    });
  }

  return items;
}
