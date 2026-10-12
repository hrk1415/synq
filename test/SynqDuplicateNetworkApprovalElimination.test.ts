// test/SynqDuplicateNetworkApprovalElimination.test.ts
/**
 * SYNQ — B.12.3.77: Duplicate Sepolia Approval Elimination Test Suite
 *
 * Verifies the elimination of redundant Sepolia network switch approvals
 * across wallet connection, network switching, and authentication flows:
 * 1. Wallet already on Sepolia (zero redundant network switch).
 * 2. Wallet connected on another network (switches once sequentially before auth).
 * 3. Concurrent switch requests (module-scoped deduplication).
 * 4. Chain state changing during connection (provider verification before switch).
 * 5. Switching between wallet accounts (account isolation and session tracking).
 * 6. Reusing an existing valid authentication session (zero duplicate signature).
 * 7. User rejecting a network switch (clean failure handling, zero retry loop).
 * 8. No duplicate switch after authentication (coordinated session handling).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isRejected,
  SepoliaNetworkError,
  hasRejectedSwitchSession,
  clearRejectedSwitchSession,
  getConnectorChainId,
  parseChainId,
} from '../src/hooks/useSepoliaNetwork';
import {
  getStoredSession,
  setStoredSession,
  clearAuthSession,
} from '../src/hooks/useAuthSession';
import { signToken } from '../src/lib/auth';
import { SEPOLIA_CHAIN_ID } from '../src/lib/contracts/addresses';

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
}

describe('SYNQ — B.12.3.77: Eliminate Duplicate Sepolia Network Approvals', () => {
  let originalWindow: any;
  let mockLocalStorage: MockStorage;
  let mockSessionStorage: MockStorage;

  const WALLET_ALICE = '0x1111111111111111111111111111111111111111';
  const WALLET_BOB = '0x2222222222222222222222222222222222222222';
  const CONNECTOR_UID = 'io.metamask';

  const walletStatusPath = path.resolve(process.cwd(), 'src/components/layout/WalletStatus.tsx');
  const walletStatusContent = fs.readFileSync(walletStatusPath, 'utf8');

  const sepoliaHookPath = path.resolve(process.cwd(), 'src/hooks/useSepoliaNetwork.ts');
  const sepoliaHookContent = fs.readFileSync(sepoliaHookPath, 'utf8');

  beforeEach(() => {
    originalWindow = (globalThis as any).window;
    mockLocalStorage = new MockStorage();
    mockSessionStorage = new MockStorage();
    (globalThis as any).window = {
      localStorage: mockLocalStorage,
      sessionStorage: mockSessionStorage,
    };
    clearRejectedSwitchSession();
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    clearRejectedSwitchSession();
  });

  // 1. Wallet already on Sepolia
  it('1. Wallet already on Sepolia: skips network switch entirely and avoids duplicate prompt', async () => {
    // Code verification: WalletStatus checks provider chain before requesting switch
    assert.match(
      walletStatusContent,
      /currentChain\s*=\s*await\s+(?:targetConnector\.getChainId|getConnectorChainId)\(/,
      'handleConnect must check actual provider chain before prompting switch'
    );
    assert.match(
      walletStatusContent,
      /if\s*\(\s*currentChain\s*!==\s*SEPOLIA_CHAIN_ID\s*\)\s*\{[\s\S]*?await\s+requestSepolia\(targetConnector\);/,
      'handleConnect must skip requestSepolia when already on SEPOLIA_CHAIN_ID'
    );

    // useSepoliaNetwork also checks actual chain directly from connector before switchChainAsync
    assert.match(
      sepoliaHookContent,
      /actualBefore\s*=\s*await\s+(?:connector\.getChainId|getConnectorChainId)\(/,
      'requestSepolia must query provider chain before invoking switchChainAsync'
    );
    assert.match(
      sepoliaHookContent,
      /if\s*\(\s*actualBefore\s*===\s*SEPOLIA_CHAIN_ID\s*\)\s*\{[\s\S]*?return;/,
      'requestSepolia must return early without switch prompt when already on Sepolia'
    );
  });

  // 2. Wallet connected on another network
  it('2. Wallet connected on another network: sequences switch first, then signature (never concurrent)', () => {
    // In handleConnect, requestSepolia is awaited before ensureAuthenticated is invoked
    const switchPos = walletStatusContent.indexOf('await requestSepolia(targetConnector)');
    const authPos = walletStatusContent.indexOf('await ensureAuthenticated(connectedAddr)');

    assert.ok(switchPos > 0, 'requestSepolia must be present in handleConnect');
    assert.ok(authPos > 0, 'ensureAuthenticated must be present in handleConnect');
    assert.ok(
      switchPos < authPos,
      'requestSepolia must strictly precede ensureAuthenticated to prevent overlapping wallet prompts'
    );
  });

  // 3. Concurrent switch requests deduplication
  it('3. Concurrent switch requests: module-scoped deduplication shares single in-flight Promise', () => {
    // Verifies module-level Map exists in useSepoliaNetwork
    assert.match(
      sepoliaHookContent,
      /const\s+globalInFlightSwitchPromises\s*=\s*new\s+Map<string,\s*Promise<void>>\(\)/,
      'globalInFlightSwitchPromises must be declared at module scope for cross-component deduplication'
    );
    assert.match(
      sepoliaHookContent,
      /const\s+existing\s*=\s*globalInFlightSwitchPromises\.get\(connKey\);[\s\S]*?if\s*\(existing\)\s*return\s+existing;/,
      'requestSepolia must return existing in-flight switch Promise when concurrent calls occur'
    );
    assert.match(
      sepoliaHookContent,
      /globalInFlightSwitchPromises\.delete\(connKey\)/,
      'globalInFlightSwitchPromises must cleanup after resolution'
    );
  });

  // 4. Chain state changing during connection
  it('4. Chain state changing during connection: reconciles actual chain and avoids stale state reliance', () => {
    assert.match(
      sepoliaHookContent,
      /reconciledChainId\s*=\s*await\s+(?:connector\.getChainId|getConnectorChainId)\(/,
      'useSepoliaNetwork must query connector directly or via getConnectorChainId to reconcile chain state'
    );
    assert.match(
      sepoliaHookContent,
      /if\s*\(\s*reconciledChainId\s*===\s*SEPOLIA_CHAIN_ID\s*\)\s*\{[\s\S]*?setVerifiedWalletChain/,
      'Must reconcile successfully if chain changed to Sepolia even if an intermediary error occurred'
    );
  });

  // 5. Switching between wallet accounts
  it('5. Switching between wallet accounts: respects account isolation and session keys', () => {
    // Session key in WalletStatus incorporates both connector UID and lowercase account address
    assert.match(
      walletStatusContent,
      /const\s+sessionKey\s*=\s*`\$\{connector\.uid\}:\$\{address\.toLowerCase\(\)\}`;/,
      'autoSwitchSessionRef must incorporate both connector UID and address'
    );

    // Auth sessions remain isolated per wallet address
    const tokenAlice = signToken({ userId: 'alice', walletAddress: WALLET_ALICE });
    setStoredSession(tokenAlice, WALLET_ALICE);

    assert.equal(getStoredSession(WALLET_ALICE), tokenAlice);
    assert.equal(getStoredSession(WALLET_BOB), null, 'Wallet Bob must not inherit Wallet Alice session');
  });

  // 6. Reusing an existing valid authentication session
  it('6. Reusing an existing valid authentication session: skips signature prompt entirely', () => {
    // Pre-populate Alice's session
    const tokenAlice = signToken({ userId: 'alice', walletAddress: WALLET_ALICE });
    setStoredSession(tokenAlice, WALLET_ALICE);

    // Verify handleConnect checks existing before setting isVerifying or requesting signature
    assert.match(
      walletStatusContent,
      /const\s+existing\s*=\s*getStoredSession\(connectedAddr\);[\s\S]*?if\s*\(!existing\)\s*\{[\s\S]*?setIsVerifying\(true\);[\s\S]*?await\s+ensureAuthenticated\(connectedAddr\);[\s\S]*?\}\s*else\s*\{[\s\S]*?setIsAuthenticated\(true\);/,
      'handleConnect must bypass ensureAuthenticated when valid session already exists in storage'
    );

    assert.equal(getStoredSession(WALLET_ALICE), tokenAlice);
  });

  // 7. User rejecting a network switch
  it('7. User rejecting a network switch: tracks rejection and prevents automatic retry loops', () => {
    // 7a. Error identification
    const userRejectedErr = { code: 4001, message: 'User rejected the request.' };
    assert.equal(isRejected(userRejectedErr), true, '4001 error must be identified as rejected');

    const rejectNameErr = { name: 'UserRejectedRequestError', message: 'User rejected' };
    assert.equal(isRejected(rejectNameErr), true, 'UserRejectedRequestError must be identified as rejected');

    // 7b. Rejection tracking in useSepoliaNetwork
    assert.match(
      sepoliaHookContent,
      /rejectedSwitchSessions\.add\(`\$\{connKey\}:\$\{SEPOLIA_CHAIN_ID\}`\)/,
      'Must record rejected session key to prevent automated retry spam'
    );

    // 7c. Background auto-switch respects rejection tracking
    assert.match(
      walletStatusContent,
      /if\s*\(\s*hasRejectedSwitchSession\(connKey\)\s*\)\s*\{[\s\S]*?autoSwitchSessionRef\.current\s*=\s*sessionKey;\s*return;\s*\}/,
      'auto-switch effect must abort immediately without prompting if session was previously rejected'
    );

    // 7d. Manual retry resets rejected status
    assert.match(
      walletStatusContent,
      /handleSwitchToSepolia[\s\S]*?clearRejectedSwitchSession\(connector\.uid\)/,
      'Explicit user switch action must clear rejected session to allow user-initiated retry'
    );
  });

  // 8. No duplicate switch after authentication
  it('8. No duplicate switch after authentication: sessionKey is claimed immediately upon connect', () => {
    // When connectAsync resolves, sessionKey is set to autoSwitchSessionRef.current BEFORE any async switch or auth
    assert.match(
      walletStatusContent,
      /const\s+sessionKey\s*=\s*`\$\{targetConnector\.uid\}:\$\{connectedAddr\.toLowerCase\(\)\}`;[\s\S]*?autoSwitchSessionRef\.current\s*=\s*sessionKey;[\s\S]*?currentChain\s*=\s*await\s+(?:targetConnector\.getChainId|getConnectorChainId)\(/,
      'autoSwitchSessionRef must be set prior to chain check and auth so background effect is suppressed'
    );

    // Background effect checks autoSwitchSessionRef.current === sessionKey and returns early
    assert.match(
      walletStatusContent,
      /if\s*\(\s*autoSwitchSessionRef\.current\s*===\s*sessionKey\s*\)\s*return;/,
      'Background auto-switch must return early when sessionKey is already claimed'
    );
  });

  // 9. Regression: Connectors without getChainId() resolve chain safely without throwing TypeError
  it('9. Connectors without getChainId(): safely resolves via getProvider(), properties, or fallback', async () => {
    // 9a. Standard connector with native getChainId()
    const standardConnector: any = {
      id: 'standard',
      getChainId: async () => SEPOLIA_CHAIN_ID,
    };
    const chain1 = await getConnectorChainId(standardConnector);
    assert.equal(chain1, SEPOLIA_CHAIN_ID, 'Standard connector with getChainId must return chainId');

    // 9b. Connector missing getChainId() but has getProvider() returning hex string (EIP-1193)
    const providerConnector: any = {
      id: 'eip1193-mock',
      getProvider: async () => ({
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_chainId') return '0xaa36a7'; // Sepolia (11155111)
          throw new Error('Unsupported method');
        },
      }),
    };
    const chain2 = await getConnectorChainId(providerConnector);
    assert.equal(chain2, SEPOLIA_CHAIN_ID, 'Connector missing getChainId must resolve hex chain ID from getProvider()');

    // 9c. Connector missing getChainId() but with decimal string or number from provider
    const decimalProviderConnector: any = {
      id: 'decimal-mock',
      getProvider: async () => ({
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_chainId') return 1; // Mainnet
          return null;
        },
      }),
    };
    const chain3 = await getConnectorChainId(decimalProviderConnector);
    assert.equal(chain3, 1, 'Connector must resolve numeric chain ID from getProvider()');

    // 9d. Connector missing getChainId() and getProvider(), but having static chainId property (bare mock)
    const staticPropConnector: any = {
      id: 'static-mock',
      chainId: SEPOLIA_CHAIN_ID,
    };
    const chain4 = await getConnectorChainId(staticPropConnector);
    assert.equal(chain4, SEPOLIA_CHAIN_ID, 'Bare connector must resolve from static chainId property');

    // 9e. Connector missing getChainId(), getProvider(), and chainId property, resolves via fallback
    const bareConnector: any = {
      id: 'bare-mock',
    };
    const chain5 = await getConnectorChainId(bareConnector, SEPOLIA_CHAIN_ID);
    assert.equal(chain5, SEPOLIA_CHAIN_ID, 'Bare connector must resolve from fallbackChainId argument');

    // 9f. If getChainId throws but getProvider is available and succeeds, resolves from getProvider
    const dualMethodConnector: any = {
      id: 'dual-method',
      getChainId: async () => { throw new Error('Not implemented in injected wrapper'); },
      getProvider: async () => ({
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_chainId') return '0xaa36a7';
          return null;
        },
      }),
    };
    const chain6 = await getConnectorChainId(dualMethodConnector);
    assert.equal(chain6, SEPOLIA_CHAIN_ID, 'Must fallback to getProvider when getChainId is unsupported');
  });

  // 10. Disconnected and null states do not throw TypeError
  it('10. Disconnected states: null and undefined connectors safely return fallback without throwing', async () => {
    // 10a. Null connector
    const nullResult = await getConnectorChainId(null);
    assert.equal(nullResult, undefined, 'Null connector must resolve undefined without throwing');

    const nullWithFallback = await getConnectorChainId(null, 1);
    assert.equal(nullWithFallback, 1, 'Null connector must return fallback chain ID');

    // 10b. Undefined connector
    const undefResult = await getConnectorChainId(undefined);
    assert.equal(undefResult, undefined, 'Undefined connector must resolve undefined without throwing');

    const undefWithFallback = await getConnectorChainId(undefined, SEPOLIA_CHAIN_ID);
    assert.equal(undefWithFallback, SEPOLIA_CHAIN_ID, 'Undefined connector must return fallback chain ID');
  });

  // 11. WalletStatus auto-switch effect uses safe getConnectorChainId
  it('11. WalletStatus auto-switch effect: calls safe getConnectorChainId, eliminating TypeError', () => {
    // Ensure the runtime error pattern is completely eradicated
    assert.doesNotMatch(
      walletStatusContent,
      /void\s+connector\.getChainId\(\)\.then/,
      'WalletStatus must not call unprotected void connector.getChainId().then'
    );

    // Verify safe helper is used with connector and chainId
    assert.match(
      walletStatusContent,
      /void\s+getConnectorChainId\(connector,\s*chainId\)\.then/,
      'WalletStatus must invoke getConnectorChainId(connector, chainId) inside auto-switch effect'
    );
  });

  // 12. Safety Review: Provider failure safety and accurate EIP-1193 parsing
  it('12. Safety Review: Accurate EIP-1193 parsing and provider failure isolation', async () => {
    // 12a. EIP-1193 hexadecimal parsing (lowercase, uppercase, leading zeros)
    assert.equal(parseChainId('0xaa36a7'), 11155111, '0xaa36a7 must parse to 11155111 (Sepolia)');
    assert.equal(parseChainId('0XAA36A7'), 11155111, '0XAA36A7 uppercase must parse to 11155111 (Sepolia)');
    assert.equal(parseChainId('0x1'), 1, '0x1 must parse to 1 (Mainnet)');
    assert.equal(parseChainId('0x5'), 5, '0x5 must parse to 5 (Goerli)');
    assert.equal(parseChainId('0x89'), 137, '0x89 must parse to 137 (Polygon)');

    // 12b. Decimal string parsing (strictly base 10, NOT base 16)
    assert.equal(parseChainId('11155111'), 11155111, '11155111 decimal string must parse to 11155111 (not base 16)');
    assert.equal(parseChainId('1'), 1, '1 decimal string must parse to 1');
    assert.equal(parseChainId('137'), 137, '137 decimal string must parse to 137');

    // 12c. Numbers and BigInts
    assert.equal(parseChainId(11155111), 11155111, 'numeric 11155111 must be preserved');
    assert.equal(parseChainId(11155111n), 11155111, 'BigInt 11155111n must convert to number');

    // 12d. Rejection of invalid, negative, and zero inputs
    assert.equal(parseChainId(''), undefined, 'Empty string must return undefined');
    assert.equal(parseChainId('   '), undefined, 'Whitespace string must return undefined');
    assert.equal(parseChainId('0x'), undefined, 'Bare 0x prefix must return undefined');
    assert.equal(parseChainId('invalid'), undefined, 'Malformed string must return undefined');
    assert.equal(parseChainId(0), undefined, 'Zero chain ID must return undefined');
    assert.equal(parseChainId(-1), undefined, 'Negative chain ID must return undefined');
    assert.equal(parseChainId(NaN), undefined, 'NaN must return undefined');
    assert.equal(parseChainId(Infinity), undefined, 'Infinity must return undefined');
    assert.equal(parseChainId(null), undefined, 'Null must return undefined');
    assert.equal(parseChainId(undefined), undefined, 'Undefined must return undefined');

    // 12e. Provider failure safety: When provider methods fail, returns undefined and does NOT assume Sepolia
    const failingRpcConnector: any = {
      id: 'failing-rpc',
      getProvider: async () => ({
        request: async () => { throw new Error('RPC server unreachable'); },
      }),
      chainId: SEPOLIA_CHAIN_ID, // Stale property must NOT be trusted
    };
    const failedChain = await getConnectorChainId(failingRpcConnector, SEPOLIA_CHAIN_ID);
    assert.equal(
      failedChain,
      undefined,
      'When provider methods fail, getConnectorChainId must return undefined to prevent unsafe Sepolia assumptions'
    );
  });
});
