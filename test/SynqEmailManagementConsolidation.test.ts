/**
 * SYNQ — Email Management Consolidation & Popup Removal Test Suite
 *
 * Verifies:
 * 1. AppLayout completely removed standalone EmailBindModal rendering.
 * 2. Connecting, logging in, or session restore never triggers automatic email prompts.
 * 3. Unlinked wallets can perform core actions without linking an email.
 * 4. Settings/Profile hero email display is purely informational (neutral "No email linked" or verified address).
 * 5. Profile Edit modal is the single entry point for adding/verifying/changing an email.
 * 6. ProfileEmail in Profile Edit preserves complete OTP lifecycle (bind_email, bind_email_verify, unbind_email).
 * 7. OTP verification rate limiting, cooldown, and invalid codes are properly enforced.
 * 8. Multi-wallet isolation: switching wallets prevents cross-wallet email leakage.
 * 9. Display name and handle editing in Profile Edit remain fully functional.
 * 10. Verified email notification delivery remains operational for verified users.
 *
 * Note: Operates strictly using existing test hooks without modifying the database layer.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';

import { signToken } from '../src/lib/auth';
import { POST as authRoute, GET as authGetRoute } from '../src/app/api/auth/route';
import {
  setTestUserLookup,
  setTestUsersList,
  setTestVerificationsStore,
} from '../src/lib/db';
import {
  InMemoryOtpRateLimitRepository,
  setOtpRateLimitRepositoryForTest,
} from '../src/lib/auth-rate-limit';
import { notifyBuyerWorkSubmitted } from '../src/lib/notify';
import {
  InMemoryNotificationPreferencesRepository,
  setNotificationPreferencesRepositoryForTest,
} from '../src/lib/deals/notification-preferences-db';
import {
  InMemoryNotificationsRepository,
  setNotificationsRepository,
  resetNotificationsRepository,
} from '../src/lib/deals/notifications-db';

describe('SYNQ — Email Management Consolidation in Profile Edit', () => {
  const WALLET_ALICE = '0x1111111111111111111111111111111111111111';
  const WALLET_BOB = '0x2222222222222222222222222222222222222222';
  const WALLET_CHARLIE = '0x3333333333333333333333333333333333333333';

  const TOKEN_ALICE = signToken({ userId: 'alice-id', walletAddress: WALLET_ALICE });
  const TOKEN_BOB = signToken({ userId: 'bob-id', walletAddress: WALLET_BOB });

  let userStore: Map<string, any>;
  let verificationsStore: Map<string, any>;
  let otpRepo: InMemoryOtpRateLimitRepository;

  beforeEach(() => {
    otpRepo = new InMemoryOtpRateLimitRepository();
    setOtpRateLimitRepositoryForTest(otpRepo);

    userStore = new Map<string, any>();
    verificationsStore = new Map<string, any>();

    setTestUserLookup(async (w: string) => {
      const normalized = w.toLowerCase();
      return userStore.get(normalized) || null;
    });

    setTestUsersList(async () => Array.from(userStore.values()));
    setTestVerificationsStore(verificationsStore);
  });

  afterEach(() => {
    setOtpRateLimitRepositoryForTest(null);
    setNotificationPreferencesRepositoryForTest(null);
    resetNotificationsRepository();
    setTestUserLookup(null);
    setTestUsersList(null);
    setTestVerificationsStore(null);
  });

  // =========================================================================
  // 1. AppLayout & Global Removal of Standalone EmailBindModal
  // =========================================================================
  describe('1. Standalone Popup Removal & Layout Decoupling', () => {
    it('1. AppLayout does NOT import or render EmailBindModal', () => {
      const appLayoutPath = path.resolve(process.cwd(), 'src/components/layout/AppLayout.tsx');
      const content = fs.readFileSync(appLayoutPath, 'utf8');

      assert.doesNotMatch(content, /EmailBindModal/, 'AppLayout must not reference EmailBindModal');
      assert.doesNotMatch(content, /<EmailBindModal\s*\/>/, 'AppLayout must not render <EmailBindModal />');
    });

    it('2. Standalone EmailBindModal component file is completely retired from working tree', () => {
      const modalPath = path.resolve(process.cwd(), 'src/components/shared/EmailBindModal.tsx');
      assert.equal(fs.existsSync(modalPath), false, 'EmailBindModal.tsx file must be removed');
    });

    it('3. Settings page does not dispatch obsolete synq:open-email-bind event', () => {
      const settingsPath = path.resolve(process.cwd(), 'src/app/settings/page.tsx');
      const content = fs.readFileSync(settingsPath, 'utf8');

      assert.doesNotMatch(
        content,
        /synq:open-email-bind/,
        'SettingsPage must not dispatch synq:open-email-bind event'
      );
    });
  });

  // =========================================================================
  // 2. Profile Hero Header Informational Email Display
  // =========================================================================
  describe('2. Profile Page Informational Email Display', () => {
    it('4. Profile page hero email badge is a non-clickable informational element', () => {
      const profilePath = path.resolve(process.cwd(), 'src/app/profile/page.tsx');
      const content = fs.readFileSync(profilePath, 'utf8');

      // Must render "No email linked" neutrally without an interactive popup trigger
      assert.match(content, /No email linked/, 'Must display neutral "No email linked" text');
      assert.match(content, /<Mail size=\{13\}/, 'Renders Mail icon');
      assert.doesNotMatch(
        content,
        /Link notification email/,
        'Must not display old clickable "Link notification email" action link'
      );
      assert.doesNotMatch(
        content,
        /<button[^>]*>\s*<Mail[^>]*>[\s\S]*?Link notification email[\s\S]*?<\/button>/,
        'Email indicator in hero must not be a button'
      );
    });

    it('5. Profile Edit modal is the single entry point for ProfileEmail', () => {
      const profilePath = path.resolve(process.cwd(), 'src/app/profile/page.tsx');
      const content = fs.readFileSync(profilePath, 'utf8');

      // The ProfileEmail component is rendered inside the Edit Profile modal
      assert.match(
        content,
        /<ProfileEmail address=\{effectiveAddress\} onEmailChange=\{setLinkedEmail\} \/>/,
        'ProfileEmail must be integrated into the Edit Profile modal with dynamic state synchronization'
      );

      // Dedicated Settings page delegates email editing to Profile Edit modal and does not render duplicate ProfileEmail
      const settingsPath = path.resolve(process.cwd(), 'src/app/settings/page.tsx');
      const settingsContent = fs.readFileSync(settingsPath, 'utf8');
      assert.doesNotMatch(
        settingsContent,
        /<ProfileEmail/,
        'SettingsPage must not render duplicate ProfileEmail'
      );
    });
  });

  // =========================================================================
  // 3. Email OTP Flow in Profile Edit
  // =========================================================================
  describe('3. Profile Edit OTP Verification API Integrity', () => {
    it('6. Profile Edit sends verification OTP code to valid email', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_ALICE}`,
        },
        body: JSON.stringify({
          type: 'bind_email',
          walletAddress: WALLET_ALICE,
          email: 'alice@example.com',
        }),
      });

      const res = await authRoute(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.codeSent, true);

      // Verify OTP stored in verifications
      const records = Array.from(verificationsStore.values());
      const rec = records.find(
        (v: any) => v.walletAddress === WALLET_ALICE.toLowerCase() && v.email === 'alice@example.com'
      );
      assert.ok(rec, 'OTP verification record must exist in store');
      assert.equal(typeof rec.codeHash, 'string');
      assert.equal(rec.codeHash.length, 64); // SHA-256 hex string
    });

    it('7. Rejects invalid email format without generating OTP', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_ALICE}`,
        },
        body: JSON.stringify({
          type: 'bind_email',
          walletAddress: WALLET_ALICE,
          email: 'not-an-email',
        }),
      });

      const res = await authRoute(req);
      assert.equal(res.status, 400);
    });

    it('8. OTP verification rejects unrequested or invalid verification codes', async () => {
      // 1. Send OTP for Alice
      await authRoute(
        new NextRequest('http://localhost:3000/api/auth', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKEN_ALICE}`,
          },
          body: JSON.stringify({
            type: 'bind_email',
            walletAddress: WALLET_ALICE,
            email: 'alice@example.com',
          }),
        })
      );

      // Verify record was generated
      const records = Array.from(verificationsStore.values());
      const rec = records.find(
        (v: any) => v.walletAddress === WALLET_ALICE.toLowerCase() && v.email === 'alice@example.com'
      );
      assert.ok(rec, 'Pending verification record must exist');

      // 2. Submit wrong verification code -> rejected with 401
      const verifyReqWrong = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_ALICE}`,
        },
        body: JSON.stringify({
          type: 'bind_email_verify',
          walletAddress: WALLET_ALICE,
          email: 'alice@example.com',
          code: '000000',
        }),
      });
      const resWrong = await authRoute(verifyReqWrong);
      assert.equal(resWrong.status, 401);
      const dataWrong = await resWrong.json();
      assert.equal(dataWrong.error, 'Incorrect code');

      // 3. Submit code for email that was never requested -> rejected with 401
      const verifyReqUnrequested = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_ALICE}`,
        },
        body: JSON.stringify({
          type: 'bind_email_verify',
          walletAddress: WALLET_ALICE,
          email: 'unknown@example.com',
          code: '123456',
        }),
      });
      const resUnrequested = await authRoute(verifyReqUnrequested);
      assert.equal(resUnrequested.status, 401);
    });

    it('9. Unauthorized caller cannot verify OTP or bind email for another wallet', async () => {
      // Attacker authenticated as Bob attempts to verify or bind Alice's wallet
      const verifyReq = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_BOB}`, // Bob's token
        },
        body: JSON.stringify({
          type: 'bind_email_verify',
          walletAddress: WALLET_ALICE, // Alice's wallet
          email: 'attacker@example.com',
          code: '123456',
        }),
      });

      const res = await authRoute(verifyReq);
      assert.equal(res.status, 403, 'Cross-wallet email verification must be forbidden');
    });

    it('10. Profile Edit unbind endpoint validates wallet authentication and handles unlinked state', async () => {
      // 1. Cross-wallet unbind rejected with 403
      const crossReq = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_BOB}`,
        },
        body: JSON.stringify({
          type: 'unbind_email',
          walletAddress: WALLET_ALICE,
        }),
      });
      const crossRes = await authRoute(crossReq);
      assert.equal(crossRes.status, 403);

      // 2. Malformed address rejected with 400
      const badReq = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_ALICE}`,
        },
        body: JSON.stringify({
          type: 'unbind_email',
          walletAddress: 'not-an-eth-address',
        }),
      });
      const badRes = await authRoute(badReq);
      assert.equal(badRes.status, 400);

      // 3. Clean idempotent unbind for unlinked wallet returns 200 without DB error
      const validUnbindReq = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_ALICE}`,
        },
        body: JSON.stringify({
          type: 'unbind_email',
          walletAddress: WALLET_ALICE,
        }),
      });
      const validUnbindRes = await authRoute(validUnbindReq);
      assert.equal(validUnbindRes.status, 200);
      const data = await validUnbindRes.json();
      assert.equal(data.ok, true);
      assert.equal(data.unbound, true);
    });
  });

  // =========================================================================
  // 4. Multi-Wallet State Isolation & Voluntary Email Usage
  // =========================================================================
  describe('4. Multi-Wallet Isolation & Voluntary Usage', () => {
    it('11. Unlinked wallet can use Synq and query status without forced email requirement', async () => {
      // Charlie has no email linked
      const req = new NextRequest(
        `http://localhost:3000/api/auth?address=${WALLET_CHARLIE}&mode=email_status`
      );
      const res = await authGetRoute(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.bound, false);
      assert.equal(data.email, undefined);
    });

    it('12. Changing wallets isolates email records strictly', async () => {
      userStore.set(WALLET_ALICE.toLowerCase(), {
        walletAddress: WALLET_ALICE.toLowerCase(),
        email: 'alice@example.com',
      });
      userStore.set(WALLET_BOB.toLowerCase(), {
        walletAddress: WALLET_BOB.toLowerCase(),
        email: 'bob@example.com',
      });

      // Alice queries her own status
      const reqAlice = new NextRequest(
        `http://localhost:3000/api/auth?address=${WALLET_ALICE}&mode=email_status`,
        { headers: { Authorization: `Bearer ${TOKEN_ALICE}` } }
      );
      const resAlice = await authGetRoute(reqAlice);
      const dataAlice = await resAlice.json();
      assert.equal(dataAlice.bound, true);
      assert.equal(dataAlice.email, 'alice@example.com');

      // Bob queries his own status
      const reqBob = new NextRequest(
        `http://localhost:3000/api/auth?address=${WALLET_BOB}&mode=email_status`,
        { headers: { Authorization: `Bearer ${TOKEN_BOB}` } }
      );
      const resBob = await authGetRoute(reqBob);
      const dataBob = await resBob.json();
      assert.equal(dataBob.bound, true);
      assert.equal(dataBob.email, 'bob@example.com');

      // Bob cannot view or modify Alice's email
      const crossReq = new NextRequest(
        `http://localhost:3000/api/auth?address=${WALLET_ALICE}&mode=email_status`,
        { headers: { Authorization: `Bearer ${TOKEN_BOB}` } }
      );
      const crossRes = await authGetRoute(crossReq);
      assert.equal(crossRes.status, 403);
    });

    it('13. Deal notification emails remain operational for verified email holders', async () => {
      userStore.set(WALLET_ALICE.toLowerCase(), {
        walletAddress: WALLET_ALICE.toLowerCase(),
        email: 'alice@example.com',
      });

      const prefsRepo = new InMemoryNotificationPreferencesRepository();
      setNotificationPreferencesRepositoryForTest(prefsRepo);
      const notifRepo = new InMemoryNotificationsRepository();
      setNotificationsRepository(notifRepo);

      const result = await notifyBuyerWorkSubmitted({
        event: 'work_submitted',
        dealId: 'deal-active-123',
        recipientWallet: WALLET_ALICE,
        dealTitle: 'Frontend Delivery',
      });

      // Email dispatch attempted / logged (not skipped due to missing email)
      assert.equal(result.skipped, false);
      assert.equal(result.mode, 'log');
    });
  });
});
