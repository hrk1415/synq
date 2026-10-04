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

/** The sole application chain. Local deployment metadata is retained above for tooling only. */
export const SEPOLIA_CHAIN_ID = 11155111 as const;
export const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7' as const;
export const SUPPORTED_CHAIN_IDS: readonly number[] = [SEPOLIA_CHAIN_ID];

/** The chain we read from when the user is disconnected or on an unsupported network. */
export const DEFAULT_CHAIN_ID = SEPOLIA_CHAIN_ID;

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

export type ApplicationChainKey = 'sepolia';
export type TokenInfo = { symbol: string; decimals: number };

export function getTokenInfo(chainKey: string | undefined, assetAddress: string): TokenInfo | undefined {
  if (!chainKey) return undefined;
  const key = (assetAddress || '0x0000000000000000000000000000000000000000').toLowerCase();
  const map = TOKENS[chainKey] || TOKENS.sepolia;
  if (!map) return undefined;
  // TOKENS keys are mixed-case checksummed addresses, so the lookup must be
  // case-insensitive — otherwise every non-native token silently falls back
  // to the native-ETH entry (wrong logo, wrong decimals).
  return Object.entries(map).find(([addr]) => addr.toLowerCase() === key)?.[1]
    || map['0x0000000000000000000000000000000000000000'];
}

export function chainKeyForId(chainId: number | undefined): string {
  switch (chainId) {
    case 11155111: return 'sepolia';
    default: return 'hardhat';
  }
}

export type SupportedChain = keyof typeof CONTRACT_ADDRESSES;

import sepoliaV2Deployment from '../../../deployments/sepolia-v2-standard.json';

/**
 * Canonical Synq Standard V2 Protocol Deployment Configuration (Ethereum Sepolia).
 * Sourced directly from deployments/sepolia-v2-standard.json.
 */
export const SYNQ_V2_SEPOLIA_CONFIG = {
  chainId: sepoliaV2Deployment.chainId as 11155111,
  factory: sepoliaV2Deployment.contracts.factory as `0x${string}`,
  dealImplementation: sepoliaV2Deployment.contracts.dealImplementation as `0x${string}`,
  primaryResolver: sepoliaV2Deployment.contracts.primaryResolver as `0x${string}`,
  emergencyResolver: sepoliaV2Deployment.contracts.emergencyResolver as `0x${string}`,
  canonicalUsdc: sepoliaV2Deployment.assets.canonicalUsdc as `0x${string}`,
  usdcDecimals: sepoliaV2Deployment.assets.usdcDecimals as 6,
  isProtected: sepoliaV2Deployment.protection.enabled as false,
  protectionModule: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  policyId: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
  eip712DomainName: sepoliaV2Deployment.consent.eip712DomainName,
  eip712DomainVersion: sepoliaV2Deployment.consent.eip712DomainVersion,
} as const;

export const SUPERSEDED_DEAL_IMPLEMENTATION = (sepoliaV2Deployment.contracts as any).supersededDealImplementation as `0x${string}`;

export type SynqV2SepoliaConfig = typeof SYNQ_V2_SEPOLIA_CONFIG;
