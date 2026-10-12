import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import {
  DefaultNotificationDispatcher,
  OutboxProcessor,
  type INotificationDispatcher,
  type DispatchResult,
} from '../src/lib/deals/outbox-processor';
import {
  InMemoryDealOutboxRepository,
  type IDealOutboxRepository,
} from '../src/lib/deals/outbox-db';
import {
  InMemoryNotificationsRepository,
  type INotificationsRepository,
  generateCanonicalDealEventKey,
} from '../src/lib/deals/notifications-db';
import {
  InMemoryMilestoneRevisionRepository,
  setMilestoneRevisionRepository,
  resetMilestoneRevisionRepository,
} from '../src/lib/deals/revisions-db';
import { POST as outboxCronHandler, GET as outboxCronGetHandler } from '../src/app/api/cron/outbox/route';
import { POST as scannerCronHandler, GET as scannerCronGetHandler } from '../src/app/api/cron/scanner/route';
import { POST as notifyHandler } from '../src/app/api/notify/route';
import { getMailStatus, type MailResult } from '../src/lib/notify';

describe('SYNQ — B.12.3.15 Safety Repairs & Dormant Worker Wiring Test Suite', () => {
  // =========================================================================
  // Section B: SMTP Delivery Classification & Log-Only Guard
  // =========================================================================
  describe('B. SMTP Delivery Classification & Outbox Log-Only Deferral', () => {
    it('1. Missing SMTP config reports live=false and mode=log', () => {
      const origUser = process.env.SMTP_USER;
      const origPass = process.env.SMTP_PASS;
      try {
        delete process.env.SMTP_USER;
        delete process.env.SMTP_PASS;
        const status = getMailStatus();
        assert.equal(status.live, false);
        assert.equal(status.mode, 'log');
        assert.ok(status.missing.includes('SMTP_USER'));
      } finally {
        if (origUser !== undefined) process.env.SMTP_USER = origUser;
        if (origPass !== undefined) process.env.SMTP_PASS = origPass;
      }
    });

    it('2. OutboxProcessor does NOT treat log-only delivery as successful delivery', async () => {
      const outboxRepo = new InMemoryDealOutboxRepository();
      const notifRepo = new InMemoryNotificationsRepository();

      // Dispatcher returns log_only
      const mockDispatcher: INotificationDispatcher = {
        async dispatch(): Promise<DispatchResult> {
          return {
            success: false,
            deliveryStatus: 'log_only',
            error: 'SMTP transport not configured (log-only mode)',
          };
        },
      };

      await outboxRepo.enqueue({
        id: 'outbox-log-only-test',
        chainId: 11155111,
        dealId: '0xdeal1',
        event: 'deal_confirmed',
        recipientWallet: '0xseller111122223333444455556666777788889999',
        payload: { title: 'Test Deal' },
      });

      const processor = new OutboxProcessor(outboxRepo, notifRepo, mockDispatcher);
      const batchResult = await processor.processBatch(10);

      // Must be deferred, NOT processed
      assert.equal(batchResult.deferredCount, 1);
      assert.equal(batchResult.processedCount, 0);
      assert.equal(batchResult.failedCount, 0);

      // Verify item in outbox was deferred with nextRetryAt and not marked processed
      const item = await outboxRepo.get('outbox-log-only-test');
      assert.ok(item);
      assert.notEqual(item.status, 'processed');
      assert.ok(item.nextRetryAt !== undefined);
    });

    it('3. Successful SMTP delivery marks outbox item processed', async () => {
      const outboxRepo = new InMemoryDealOutboxRepository();
      const notifRepo = new InMemoryNotificationsRepository();

      const mockDispatcher: INotificationDispatcher = {
        async dispatch(): Promise<DispatchResult> {
          return {
            success: true,
            deliveryStatus: 'delivered',
            messageId: 'msg-smtp-12345',
          };
        },
      };

      await outboxRepo.enqueue({
        id: 'outbox-delivered-test',
        chainId: 11155111,
        dealId: '0xdeal1',
        event: 'deal_confirmed',
        recipientWallet: '0xseller111122223333444455556666777788889999',
        payload: { title: 'Test Deal' },
      });

      const processor = new OutboxProcessor(outboxRepo, notifRepo, mockDispatcher);
      const batchResult = await processor.processBatch(10);

      assert.equal(batchResult.processedCount, 1);
      assert.equal(batchResult.deferredCount, 0);

      const item = await outboxRepo.get('outbox-delivered-test');
      assert.equal(item?.status, 'processed');
    });

    it('4. Retryable delivery failure records failure without marking processed', async () => {
      const outboxRepo = new InMemoryDealOutboxRepository();
      const notifRepo = new InMemoryNotificationsRepository();

      const mockDispatcher: INotificationDispatcher = {
        async dispatch(): Promise<DispatchResult> {
          return {
            success: false,
            deliveryStatus: 'retryable_fail',
            error: 'Connection timeout',
          };
        },
      };

      await outboxRepo.enqueue({
        id: 'outbox-retryable-test',
        chainId: 11155111,
        dealId: '0xdeal1',
        event: 'deal_confirmed',
        recipientWallet: '0xseller111122223333444455556666777788889999',
        payload: { title: 'Test Deal' },
      });

      const processor = new OutboxProcessor(outboxRepo, notifRepo, mockDispatcher);
      const batchResult = await processor.processBatch(10);

      assert.equal(batchResult.failedCount, 1);
      assert.equal(batchResult.processedCount, 0);

      const item = await outboxRepo.get('outbox-retryable-test');
      assert.equal(item?.status, 'failed');
      assert.equal(item?.lastError, 'Connection timeout');
    });

    it('5. Permanent non-delivery (skipped) marks item skipped', async () => {
      const outboxRepo = new InMemoryDealOutboxRepository();
      const notifRepo = new InMemoryNotificationsRepository();

      const mockDispatcher: INotificationDispatcher = {
        async dispatch(): Promise<DispatchResult> {
          return {
            success: false,
            deliveryStatus: 'skipped',
            skipped: true,
            reason: 'No verified email linked to recipient wallet',
          };
        },
      };

      await outboxRepo.enqueue({
        id: 'outbox-skipped-test',
        chainId: 11155111,
        dealId: '0xdeal1',
        event: 'deal_confirmed',
        recipientWallet: '0xseller111122223333444455556666777788889999',
        payload: { title: 'Test Deal' },
      });

      const processor = new OutboxProcessor(outboxRepo, notifRepo, mockDispatcher);
      const batchResult = await processor.processBatch(10);

      assert.equal(batchResult.skippedCount, 1);
      assert.equal(batchResult.processedCount, 0);

      const item = await outboxRepo.get('outbox-skipped-test');
      assert.equal(item?.status, 'skipped');
    });
  });

  // =========================================================================
  // Section C: work_submitted Deduplication Across Client and Scanner
  // =========================================================================
  describe('C. work_submitted Deduplication Canonical Key Alignment', () => {
    it('1. Generates identical canonical key when version and milestone match', () => {
      const clientKey = generateCanonicalDealEventKey({
        chainId: 11155111,
        dealId: '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807',
        event: 'work_submitted',
        milestoneIndex: 0,
        submissionVersion: 1,
        recipientRole: 'buyer',
      });

      const scannerKey = generateCanonicalDealEventKey({
        chainId: 11155111,
        dealId: '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807',
        event: 'work_submitted',
        milestoneIndex: 0,
        submissionVersion: 1,
        recipientRole: 'buyer',
      });

      assert.equal(clientKey, scannerKey);
      assert.equal(
        clientKey,
        '11155111:0x142ee9d2b5b6758f4d00439f3583fdcb89309807:work_submitted:ms:0:v:1:role:buyer',
      );
    });

    it('2. Distinguishes new submission versions for the same milestone', () => {
      const v1Key = generateCanonicalDealEventKey({
        chainId: 11155111,
        dealId: '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807',
        event: 'work_submitted',
        milestoneIndex: 0,
        submissionVersion: 1,
        recipientRole: 'buyer',
      });

      const v2Key = generateCanonicalDealEventKey({
        chainId: 11155111,
        dealId: '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807',
        event: 'work_submitted',
        milestoneIndex: 0,
        submissionVersion: 2,
        recipientRole: 'buyer',
      });

      assert.notEqual(v1Key, v2Key);
      assert.ok(v1Key.includes(':v:1:'));
      assert.ok(v2Key.includes(':v:2:'));
    });

    it('3. Suppresses duplicate notification claim between client and outbox', async () => {
      const notifRepo = new InMemoryNotificationsRepository();
      const canonicalKey = '11155111:0xdeal1:work_submitted:ms:0:v:1:role:buyer';

      // 1. Client claims and marks delivered
      const clientClaim = await notifRepo.claimPending(
        canonicalKey,
        {
          dealId: '0xdeal1',
          event: 'work_submitted',
          recipientWallet: '0xbuyer111122223333444455556666777788889999',
        },
        { fenced: true },
      );
      assert.equal(clientClaim.status, 'claimed');
      await notifRepo.markDelivered(canonicalKey, 'msg-client-123', 'buyer@test.com', clientClaim.claimToken);

      // 2. Scanner / outbox processor attempts claim on same canonicalKey
      const scannerClaim = await notifRepo.claimPending(
        canonicalKey,
        {
          dealId: '0xdeal1',
          event: 'work_submitted',
          recipientWallet: '0xbuyer111122223333444455556666777788889999',
        },
        { fenced: true },
      );
      assert.equal(scannerClaim.status, 'duplicate_delivered');
    });
  });

  // =========================================================================
  // Section D: revision_requested Support & Idempotency
  // =========================================================================
  describe('D. revision_requested Event Support', () => {
    it('1. Generates correct canonical key for revision_requested', () => {
      const revKey = generateCanonicalDealEventKey({
        chainId: 11155111,
        dealId: '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807',
        event: 'revision_requested',
        milestoneIndex: 1,
        submissionVersion: 1,
        recipientRole: 'seller',
      });

      assert.equal(
        revKey,
        '11155111:0x142ee9d2b5b6758f4d00439f3583fdcb89309807:revision_requested:ms:1:v:1:role:seller',
      );
    });

    it('2. OutboxProcessor dispatches revision_requested to freelancer', async () => {
      const outboxRepo = new InMemoryDealOutboxRepository();
      const notifRepo = new InMemoryNotificationsRepository();

      let dispatchedEvent = '';
      let dispatchedRecipient = '';
      const mockDispatcher: INotificationDispatcher = {
        async dispatch(event, p): Promise<DispatchResult> {
          dispatchedEvent = event;
          dispatchedRecipient = p.recipientWallet;
          return {
            success: true,
            deliveryStatus: 'delivered',
            messageId: 'msg-rev-123',
          };
        },
      };

      await outboxRepo.enqueue({
        id: 'outbox-rev-test',
        chainId: 11155111,
        dealId: '0xdeal1',
        event: 'revision_requested',
        recipientWallet: '0xfreelancer111122223333444455556666777788889999',
        payload: {
          title: 'Design Project',
          milestoneIndex: 0,
          submissionVersion: 1,
          evidence: 'Please revise color scheme',
        },
      });

      const processor = new OutboxProcessor(outboxRepo, notifRepo, mockDispatcher);
      const batchResult = await processor.processBatch(10);

      assert.equal(batchResult.processedCount, 1);
      assert.equal(dispatchedEvent, 'revision_requested');
      assert.equal(dispatchedRecipient, '0xfreelancer111122223333444455556666777788889999');
    });
  });

  // =========================================================================
  // Section E: Dormant Worker Entry Points Security & Guards
  // =========================================================================
  describe('E. Dormant Worker Entry Points Security & Bounds', () => {
    it('1. GET method is rejected as 405 (POST-only requirement)', async () => {
      const getResOutbox = await outboxCronGetHandler();
      assert.equal(getResOutbox.status, 405);

      const getResScanner = await scannerCronGetHandler();
      assert.equal(getResScanner.status, 405);
    });

    it('2. Outbox cron returns 503 if CRON_SECRET is missing', async () => {
      const origSecret = process.env.CRON_SECRET;
      try {
        process.env.CRON_SECRET = '';
        const req = new NextRequest('http://localhost:3000/api/cron/outbox', {
          method: 'POST',
        });
        const res = await outboxCronHandler(req);
        assert.equal(res.status, 503);
      } finally {
        process.env.CRON_SECRET = origSecret;
      }
    });

    it('3. Outbox cron returns 401 on invalid authorization token', async () => {
      const origSecret = process.env.CRON_SECRET;
      try {
        process.env.CRON_SECRET = 'valid-test-secret-12345';
        const req = new NextRequest('http://localhost:3000/api/cron/outbox', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer wrong-secret',
          },
        });
        const res = await outboxCronHandler(req);
        assert.equal(res.status, 401);
      } finally {
        process.env.CRON_SECRET = origSecret;
      }
    });

    it('4. Outbox cron returns 403 disabled-by-default when ENABLE_OUTBOX_PROCESSOR !== true', async () => {
      const origSecret = process.env.CRON_SECRET;
      const origFlag = process.env.ENABLE_OUTBOX_PROCESSOR;
      try {
        process.env.CRON_SECRET = 'test-secret';
        process.env.ENABLE_OUTBOX_PROCESSOR = 'false';
        const req = new NextRequest('http://localhost:3000/api/cron/outbox', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-secret',
          },
        });
        const res = await outboxCronHandler(req);
        assert.equal(res.status, 403);
        const data = await res.json();
        assert.equal(data.status, 'disabled');
      } finally {
        process.env.CRON_SECRET = origSecret;
        process.env.ENABLE_OUTBOX_PROCESSOR = origFlag;
      }
    });

    it('5. Scanner cron returns 503 if CRON_SECRET is missing', async () => {
      const origSecret = process.env.CRON_SECRET;
      try {
        process.env.CRON_SECRET = '';
        const req = new NextRequest('http://localhost:3000/api/cron/scanner', {
          method: 'POST',
        });
        const res = await scannerCronHandler(req);
        assert.equal(res.status, 503);
      } finally {
        process.env.CRON_SECRET = origSecret;
      }
    });

    it('6. Scanner cron returns 403 disabled-by-default when ENABLE_CHAIN_SCANNER !== true', async () => {
      const origSecret = process.env.CRON_SECRET;
      const origFlag = process.env.ENABLE_CHAIN_SCANNER;
      try {
        process.env.CRON_SECRET = 'test-secret';
        process.env.ENABLE_CHAIN_SCANNER = 'false';
        const req = new NextRequest('http://localhost:3000/api/cron/scanner', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-secret',
          },
        });
        const res = await scannerCronHandler(req);
        assert.equal(res.status, 403);
        const data = await res.json();
        assert.equal(data.status, 'disabled');
      } finally {
        process.env.CRON_SECRET = origSecret;
        process.env.ENABLE_CHAIN_SCANNER = origFlag;
      }
    });

    it('7. Constant-time secret comparison rejects length mismatches securely', () => {
      const secret = 'super-secret-token-123';
      const candidateShort = 'super';
      const secretHash = crypto.createHash('sha256').update(secret).digest();
      const candidateHash = crypto.createHash('sha256').update(candidateShort).digest();
      // Hashes are always 32 bytes, timingSafeEqual safely returns false
      assert.equal(crypto.timingSafeEqual(secretHash, candidateHash), false);
    });

    it('8. Scanner cron rejects execution when deployment coordinates and cursor are unverified (412)', async () => {
      const origSecret = process.env.CRON_SECRET;
      const origFlag = process.env.ENABLE_CHAIN_SCANNER;
      const origStartBlock = process.env.SCANNER_START_BLOCK;
      const { setChainCursorRepository, resetChainCursorRepository, InMemoryChainCursorRepository } =
        await import('../src/lib/deals/chain-sync-db');

      try {
        process.env.CRON_SECRET = 'test-secret';
        process.env.ENABLE_CHAIN_SCANNER = 'true';
        delete process.env.SCANNER_START_BLOCK;
        // Inject in-memory cursor repository with no existing cursor
        setChainCursorRepository(new InMemoryChainCursorRepository());

        const req = new NextRequest('http://localhost:3000/api/cron/scanner', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-secret',
          },
        });
        const res = await scannerCronHandler(req);
        // Returns 412 Precondition Failed because no cursor exists in database and SCANNER_START_BLOCK is unset
        assert.equal(res.status, 412);
        const data = await res.json();
        assert.match(data.error, /Deployment coordinates unverified/i);
      } finally {
        resetChainCursorRepository();
        process.env.CRON_SECRET = origSecret;
        process.env.ENABLE_CHAIN_SCANNER = origFlag;
        if (origStartBlock !== undefined) process.env.SCANNER_START_BLOCK = origStartBlock;
      }
    });

    it('9. Concurrent scanner cursor updates enforce CAS and prevent cursor regression', async () => {
      const { InMemoryChainCursorRepository } = await import('../src/lib/deals/chain-sync-db');
      const cursorRepo = new InMemoryChainCursorRepository();

      await cursorRepo.initializeIfMissing({
        chainId: 11155111,
        scannerId: 'test-scanner-cas',
        initialBlockNumber: 100n,
        initialBlockHash: '0xblock100',
      });

      // Worker 1 advances from 100 to 110
      const adv1 = await cursorRepo.advance({
        chainId: 11155111,
        scannerId: 'test-scanner-cas',
        expectedLastBlockNumber: 100n,
        newBlockNumber: 110n,
        newBlockHash: '0xblock110',
      });
      assert.equal(adv1.status, 'advanced');

      // Worker 2 attempts stale advance from 100 to 105 -> rejected with conflict_stale
      const adv2 = await cursorRepo.advance({
        chainId: 11155111,
        scannerId: 'test-scanner-cas',
        expectedLastBlockNumber: 100n,
        newBlockNumber: 105n,
        newBlockHash: '0xblock105',
      });
      assert.equal(adv2.status, 'conflict_stale');

      // Verify current cursor remains 110
      const current = await cursorRepo.get(11155111, 'test-scanner-cas');
      assert.equal(current?.lastBlockNumber, 110n);
    });

    it('10. Concurrent outbox item claims fence out conflicting workers', async () => {
      const outboxRepo = new InMemoryDealOutboxRepository();
      await outboxRepo.enqueue({
        id: 'outbox-fence-test',
        chainId: 11155111,
        dealId: '0xdeal1',
        event: 'work_submitted',
        recipientWallet: '0xbuyer111122223333444455556666777788889999',
        payload: { title: 'Test' },
      });

      const token1 = 'worker-1-uuid';
      const token2 = 'worker-2-uuid';

      const claim1 = await outboxRepo.claim('outbox-fence-test', token1);
      assert.equal(claim1, true, 'Worker 1 must claim item');

      const claim2 = await outboxRepo.claim('outbox-fence-test', token2);
      assert.equal(claim2, false, 'Worker 2 must be fenced out of already-claimed item');
    });
  });

  // =========================================================================
  // Section F: Revision Request Authorization & Idempotency
  // =========================================================================
  describe('F. Revision Request Record Authentication & Non-Overlapping Keys', () => {
    it('1. Distinct milestones produce distinct revision notification keys', () => {
      const keyMs0 = generateCanonicalDealEventKey({
        chainId: 11155111,
        dealId: '0xdeal1',
        event: 'revision_requested',
        milestoneIndex: 0,
        submissionVersion: 1,
        recipientRole: 'seller',
      });

      const keyMs1 = generateCanonicalDealEventKey({
        chainId: 11155111,
        dealId: '0xdeal1',
        event: 'revision_requested',
        milestoneIndex: 1,
        submissionVersion: 1,
        recipientRole: 'seller',
      });

      assert.notEqual(keyMs0, keyMs1);
      assert.ok(keyMs0.includes(':ms:0:'));
      assert.ok(keyMs1.includes(':ms:1:'));
    });

    it('2. Distinct deals produce distinct revision notification keys', () => {
      const keyDealA = generateCanonicalDealEventKey({
        chainId: 11155111,
        dealId: '0xdealAAAA11112222333344445555666677778888',
        event: 'revision_requested',
        milestoneIndex: 0,
        submissionVersion: 1,
        recipientRole: 'seller',
      });

      const keyDealB = generateCanonicalDealEventKey({
        chainId: 11155111,
        dealId: '0xdealBBBB11112222333344445555666677778888',
        event: 'revision_requested',
        milestoneIndex: 0,
        submissionVersion: 1,
        recipientRole: 'seller',
      });

      assert.notEqual(keyDealA, keyDealB);
    });
  });
});
