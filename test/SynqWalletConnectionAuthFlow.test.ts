import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('SYNQ — B.12.3.74 Unified Wallet Connection & Authentication Flow Suite', () => {
  const walletStatusPath = path.resolve(process.cwd(), 'src/components/layout/WalletStatus.tsx');
  const walletStatusContent = fs.readFileSync(walletStatusPath, 'utf8');

  it('1. State 1: Disconnected shows original Connect Wallet button without active signed-in session', () => {
    // Shows Connect Wallet text
    assert.match(walletStatusContent, /<span className="text-\[#242424\] font-medium">Connect Wallet<\/span>/);
    // Uses Wallet icon
    assert.match(walletStatusContent, /<Wallet size=\{16\}/);
    // Opens connection modal
    assert.match(walletStatusContent, /onClick=\{handleOpenModal\}/);
    // Does not present sign-in prefix or handle in disconnected button
    assert.doesNotMatch(walletStatusContent, /Connect Wallet[\s\S]*?Sign In/);
  });

  it('2. State 2: First-time connection unifies wallet connect and authentication signature in one flow', () => {
    // handleConnect awaits connectAsync and immediately triggers ensureAuthenticated if no existing session
    assert.match(walletStatusContent, /const handleConnect = async \(targetConnector: Connector\) =>/);
    assert.match(walletStatusContent, /const res = await connectAsync\(\{ connector: targetConnector \}\);/);
    assert.match(walletStatusContent, /const existing = getStoredSession\(connectedAddr\);/);
    assert.match(walletStatusContent, /if \(!existing\) \{[\s\S]*?setIsVerifying\(true\);[\s\S]*?await ensureAuthenticated\(connectedAddr\);[\s\S]*?setIsAuthenticated\(true\);/);
    // User is informed of signature prompt in the modal footer
    assert.match(walletStatusContent, /isVerifying\s*\?\s*['"]Approve signature in your wallet to continue\.\.\.['"]/);
  });

  it('3. State 3: Connected & Authenticated restores canonical capsule and clean dropdown without redundant Sign In UI', () => {
    // Capsule shows ETH balance and handle / address
    assert.match(walletStatusContent, /balance \? formatBalance\(balance\) : '\.\.\.'/);
    assert.match(walletStatusContent, /identity\.displayHandle \|\| \(address \? truncateAddress\(address\) : ''\)/);

    // Dropdown header displays networkReady ? 'Sepolia' : 'Wrong Net' (no 'Unsigned' status)
    assert.match(walletStatusContent, /networkReady\s*\?\s*'bg-green-400'\s*:\s*'bg-amber-400'/);
    assert.match(walletStatusContent, /networkReady\s*\?\s*'Sepolia'\s*:\s*'Wrong Net'/);
    assert.doesNotMatch(walletStatusContent, /'Unsigned'/);

    // Balances and Swap action displayed when authenticated
    assert.match(walletStatusContent, /\{isAuthenticated && \([\s\S]*?BalanceRow[\s\S]*?USDC[\s\S]*?ETH/);
    assert.match(walletStatusContent, /href="\/swap"/);

    // No "Sign In" prefix or separate "Sign-In Required" banner in normal authenticated state
    assert.doesNotMatch(walletStatusContent, /Sign-In Required/);
    assert.doesNotMatch(walletStatusContent, /Sign In with Wallet/);
  });

  it('4. State 4: Connected Wallet with missing or expired session shows minimal Verify Wallet recovery', () => {
    // Capsule displays minimal Verify Wallet state when connected but unauthenticated
    assert.match(walletStatusContent, /!isAuthenticated \? \([\s\S]*?Verify Wallet/);

    // Dropdown presents minimal recovery banner with Verify Wallet action
    assert.match(walletStatusContent, /networkReady && !isAuthenticated && \([\s\S]*?Wallet Verification Needed/);
    assert.match(walletStatusContent, /handleVerifyWallet/);
    assert.match(walletStatusContent, /Verify Wallet/);

    // Normal balances are gated on isAuthenticated to avoid displaying unauthenticated state as fully active
    assert.match(walletStatusContent, /\{isAuthenticated && \([\s\S]*?<BalanceRow/);

    // Does not auto-trigger signature on mount or auto-reconnect
    // checkAuth only inspects stored session synchronously without invoking ensureAuthenticated
    assert.match(walletStatusContent, /const checkAuth = useCallback\(\(\) => \{[\s\S]*?setIsAuthenticated\(Boolean\(getStoredSession\(address\)\)\);/);
  });

  it('5. Disconnect: Clears stored session and resets verification states', () => {
    // Dropdown disconnect clears auth session
    assert.match(walletStatusContent, /if \(address\) clearAuthSession\(address\);[\s\S]*?disconnect\(\);[\s\S]*?handleClose\(\);/);

    // Wagmi onDisconnect hook also clears session and resets auth/verify state
    assert.match(walletStatusContent, /onDisconnect\(\) \{[\s\S]*?if \(address\) clearAuthSession\(address\);[\s\S]*?setIsAuthenticated\(false\);[\s\S]*?setIsVerifying\(false\);/);
  });
});
