export const CONTRACT_ADDRESSES = {
  hardhat: {
    NexotiqDeal: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    NexotiqReputation: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    NexotiqFactory: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
    NexotiqProtection: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
    NexotiqRegistry: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
    NexotiqDirectory: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
  },
  sepolia: {
    NexotiqDeal: '0x08026EF62081dF259aF23c3B114D589FE4E281c0',
    NexotiqReputation: '0x4171DFdC5515473F993B45cEe1946bd6D7555300',
    NexotiqFactory: '0x569146151D79B30087B27B6D3Df1FD16a846ae23',
    NexotiqProtection: '0x96a09E859b893934B955169d888BeE1510cC4F8F',
    NexotiqRegistry: '0xc0b0F6b0e09CaA6739d77B1Bab46312A570c3182',
    NexotiqDirectory: '0x37544bDB49dc9029e993bf3C5e317AAc36a5AF0c',
  },
};

// Faucet tokens per testnet (address(0) = native ETH)
export const TOKENS: Record<string, Record<string, { symbol: string; decimals: number }>> = {
  sepolia: {
    '0x0000000000000000000000000000000000000000': { symbol: 'ETH', decimals: 18 },
    '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238': { symbol: 'USDC', decimals: 6 },
  },
  hardhat: {
    '0x0000000000000000000000000000000000000000': { symbol: 'ETH', decimals: 18 },
  },
};

export const CHAINS: Record<string, { id: number; name: string }> = {
  hardhat: { id: 31337, name: 'Hardhat (Local)' },
  sepolia: { id: 11155111, name: 'Ethereum Sepolia' },
};

/** Chains Synq contracts are actually deployed on. Anything else has no addresses. */
export const SUPPORTED_CHAIN_IDS: readonly number[] = [11155111, 31337];

/** The chain we read from when the user is disconnected or on an unsupported network. */
export const DEFAULT_CHAIN_ID = 11155111;

export function isSupportedChain(chainId: number | undefined): boolean {
  return typeof chainId === 'number' && SUPPORTED_CHAIN_IDS.includes(chainId);
}

/** Human-readable network name for error messages — never guesses. */
export function chainLabel(chainId: number | undefined): string {
  switch (chainId) {
    case 11155111: return 'Ethereum Sepolia';
    case 31337: return 'Hardhat (localhost:8545)';
    case 1: return 'Ethereum Mainnet';
    case 8453: return 'Base';
    case undefined: return 'no network';
    default: return `chain ${chainId}`;
  }
}

export function getTokenInfo(chainKey: string, assetAddress: string) {
  const key = (assetAddress || '0x0000000000000000000000000000000000000000').toLowerCase();
  const map = TOKENS[chainKey] || TOKENS.hardhat;
  // TOKENS keys are mixed-case checksummed addresses, so the lookup must be
  // case-insensitive — otherwise every non-native token silently falls back
  // to the native-ETH entry (wrong logo, wrong decimals).
  const entry = Object.entries(map).find(([addr]) => addr.toLowerCase() === key)?.[1]
    || map['0x0000000000000000000000000000000000000000'];
  if (!entry) return { symbol: 'ETH', decimals: 18 };
  return entry;
}

export function chainKeyForId(chainId: number): string {
  switch (chainId) {
    case 11155111: return 'sepolia';
    default: return 'hardhat';
  }
}

export type SupportedChain = keyof typeof CONTRACT_ADDRESSES;