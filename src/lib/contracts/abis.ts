import NexotiqDeal from './artifacts/contracts/NexotiqDeal.sol/NexotiqDeal.json';
import NexotiqFactory from './artifacts/contracts/NexotiqFactory.sol/NexotiqFactory.json';
import NexotiqReputation from './artifacts/contracts/NexotiqReputation.sol/NexotiqReputation.json';
import NexotiqProtection from './artifacts/contracts/NexotiqProtection.sol/NexotiqProtection.json';
import NexotiqDirectory from './artifacts/contracts/NexotiqDirectory.sol/NexotiqDirectory.json';

export const nexotiqDealABI = NexotiqDeal.abi;
export const nexotiqFactoryABI = NexotiqFactory.abi;
export const nexotiqReputationABI = NexotiqReputation.abi;
export const nexotiqProtectionABI = NexotiqProtection.abi;
export const nexotiqDirectoryABI = NexotiqDirectory.abi;

export const erc20ABI = [
  { inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], name: 'allowance', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'approve', outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'transfer', outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
] as const;
