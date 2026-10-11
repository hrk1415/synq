/**
 * SYNQ — B.12.3.12 Dedicated Isolated PostgreSQL Integration Test Harness
 *
 * Implements 14 hardened integration test scenarios targeting real PostgreSQL 15/16 instances.
 * Exercises real Drizzle repositories, PostgreSQL SQL constraints, transactions, and concurrency.
 *
 * HARD ISOLATION ENFORCEMENT:
 * - Requires explicit RUN_POSTGRES_INTEGRATION=true and TEST_DATABASE_URL to connect.
 * - When running in offline verification mode (without disposable PostgreSQL), all tests
 *   skip gracefully without attempting network connections.
 * - Enforces database name whitelisting (must contain test/disposable).
 * - Restricts hostnames strictly to local loopback hosts (127.0.0.1, localhost, ::1).
 * - Remote host overrides are strictly forbidden.
 * - Disables SMTP, RPC, and cron.
 * - Masks credentials in all logs.
 * - Uses isolated PostgreSQL schemas (synq_test_clean, synq_test_upgrade) for migration tests.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPostgresIntegrationEnabled,
  configureTestDatabaseEnvironment,
  applyMigrationFiles,
} from './helpers/postgres-test-isolation';

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/db/schema';
import {
  dealNotifications,
  dealEventsOutbox,
  trackedDealContracts,
  chainSyncCursors,
  dealProposals,
  dealReplayJobs,
  notificationPreferences,
  otpRateLimits,
} from '../src/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { closeDb } from '../src/db';

import { DrizzleChainCursorRepository } from '../src/lib/deals/chain-sync-db';
import { DrizzleDealOutboxRepository } from '../src/lib/deals/outbox-db';
import { DrizzleNotificationsRepository } from '../src/lib/deals/notifications-db';
import { DrizzleTrackedContractsRepository } from '../src/lib/deals/tracked-contracts-db';
import { DrizzleDealProposalRepository } from '../src/lib/deals/proposals-db';
import { DrizzleDealReplayRepository } from '../src/lib/deals/deal-replay-db';
import { DrizzleNotificationPreferencesRepository } from '../src/lib/deals/notification-preferences-db';
import { DrizzleOtpRateLimitRepository } from '../src/lib/auth-rate-limit';
import {
  BlockchainScanner,
  SUPPORTED_SEPOLIA_FACTORIES,
  type IScannerRpcClient,
} from '../src/lib/deals/chain-scanner';
import { DealContractRegistry, type RawLog } from '../src/lib/deals/chain-event-ingestion';
import { SYNQ_V2_SEPOLIA_CONFIG, CONTRACT_ADDRESSES } from '../src/lib/contracts/addresses';
import sepoliaV2Deployment from '../deployments/sepolia-v2-standard.json';

class DummyRpcClient implements IScannerRpcClient {
  async getBlockNumber(): Promise<bigint> {
    return 1000n;
  }
  async getBlock(): Promise<{ hash: string; parentHash: string }> {
    return {
      hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };
  }
  async getLogs(): Promise<RawLog[]> {
    return [];
  }
}

describe('SYNQ — B.12.3.12 Hardened PostgreSQL Integration Test Suite', () => {
  const isEnabled = isPostgresIntegrationEnabled();
  let rawClient: postgres.Sql | null = null;
  let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
  let initialTableNames: string[] = [];

  before(async () => {
    if (!isEnabled) {
      console.log(
        '[PostgresIntegrationHarness] Offline mode: TEST_DATABASE_URL not set or RUN_POSTGRES_INTEGRATION !== true. Skipping live DB connections.',
      );
      return;
    }

    const config = await configureTestDatabaseEnvironment(undefined, 'synq_test_ops');
    console.log(
      `[PostgresIntegrationHarness] Initializing hardened PostgreSQL test run against ${config.sanitizedUrl} (schema: synq_test_ops)`,
    );

    rawClient = postgres(process.env.DATABASE_URL!, { max: 10, idle_timeout: 10 });
    db = drizzle(rawClient, { schema });

    // Ensure clean isolated schemas before running tests.
    // CRITICAL (B.12.3.15): NEVER DROP SCHEMA public CASCADE!
    // The public schema and all external data within it must be completely preserved.
    try {
      await rawClient.unsafe('DROP SCHEMA IF EXISTS "synq_test_clean" CASCADE;');
      await rawClient.unsafe('DROP SCHEMA IF EXISTS "synq_test_upgrade" CASCADE;');
      await rawClient.unsafe('DROP SCHEMA IF EXISTS "synq_test_ops" CASCADE;');
    } catch {
      // Ignore
    }

    // B.12.3.17: Non-mutating public schema isolation verification.
    // Snapshot all tables in the public schema before tests run.
    // We strictly avoid creating, inserting into, altering, or dropping ANY objects in public.
    const initialPublicTables = await rawClient.unsafe(`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
    `);
    initialTableNames = initialPublicTables.map((r: any) => r.table_name);

    // Create synq_test_ops schema and set search_path
    await rawClient.unsafe('CREATE SCHEMA IF NOT EXISTS "synq_test_ops";');
    await rawClient.unsafe('SET search_path TO "synq_test_ops", public;');

    // Apply baseline migrations strictly to dedicated schema synq_test_ops for operational repository tests (Scenarios 3-15, 25-26)
    await applyMigrationFiles(rawClient, 0, 23, 'synq_test_ops');
  });

  after(async () => {
    if (rawClient) {
      // Regression assertion: Prove that public schema was never modified, dropped, or polluted
      try {
        const postTestPublicTables = await rawClient.unsafe(`
          SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
        `);
        const postTableNames = postTestPublicTables.map((r: any) => r.table_name);
        assert.deepEqual(
          postTableNames,
          initialTableNames,
          '[B.12.3.17 Isolation Guard] Public schema was modified during test run! Public schema must remain untouched.',
        );
      } catch (err: any) {
        console.error('[PostgresIntegrationHarness] Public schema preservation check failed:', err?.message || err);
        throw err;
      }

      // Clean up isolated test-only schemas
      try {
        await rawClient.unsafe('DROP SCHEMA IF EXISTS "synq_test_clean" CASCADE;');
        await rawClient.unsafe('DROP SCHEMA IF EXISTS "synq_test_upgrade" CASCADE;');
        await rawClient.unsafe('DROP SCHEMA IF EXISTS "synq_test_ops" CASCADE;');
      } catch {
        // Ignore drop errors on cleanup
      }
      await rawClient.end();
    }
    await closeDb();
  });

  beforeEach(async () => {
    if (!isEnabled || !db) return;
    if (rawClient) {
      await rawClient.unsafe('SET search_path TO "synq_test_ops", public;');
    }
    // Clean up test tables in synq_test_ops schema between runs
    await db.delete(dealNotifications);
    await db.delete(dealEventsOutbox);
    await db.delete(trackedDealContracts);
    await db.delete(chainSyncCursors);
    await db.delete(dealProposals);
    await db.delete(dealReplayJobs);
    await db.delete(notificationPreferences);
    await db.delete(otpRateLimits);
  });

  // Scenario 1: Clean migration execution on isolated schema
  it('01. Clean migration execution creates all expected tables and constraints in isolated schema', async (t) => {
    if (!isEnabled || !rawClient) {
      t.skip('Skipped in offline mode: requires live disposable PostgreSQL instance');
      return;
    }
    const client = rawClient;

    // Run all migrations 0000..0023 strictly in dedicated isolated schema 'synq_test_clean'
    const result = await applyMigrationFiles(client, 0, 23, 'synq_test_clean');
    assert.equal(result.appliedCount, 24, 'Must apply exactly 24 migration files (0000 through 0023)');

    // Verify all core tables exist in synq_test_clean
    const tables = await client`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'synq_test_clean' 
        AND table_name IN (
          'deal_notifications', 'deal_events_outbox', 'tracked_deal_contracts',
          'chain_sync_cursors', 'deal_proposals', 'deal_replay_jobs',
          'notification_preferences', 'otp_rate_limits'
        )
    `;
    assert.equal(tables.length, 8, 'All 8 core tables must exist in synq_test_clean');

    // Verify is_bootstrap column exists on chain_sync_cursors with default false
    const cursorBootstrapCol = await client`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'synq_test_clean'
        AND table_name = 'chain_sync_cursors'
        AND column_name = 'is_bootstrap';
    `;
    assert.equal(cursorBootstrapCol.length, 1, 'chain_sync_cursors must have is_bootstrap column');
    assert.equal(cursorBootstrapCol[0].data_type, 'boolean');
    assert.match(cursorBootstrapCol[0].column_default, /false/i, 'is_bootstrap column default must be false');

    // Verify constraints in synq_test_clean
    // 1. Status constraint allows 'cancelled'
    await client`
      INSERT INTO "synq_test_clean"."deal_events_outbox" (
        id, chain_id, deal_id, event, recipient_wallet, payload, status, origin
      ) VALUES (
        'outbox:clean:cancelled', 11155111, '0xdeal1', 'deal_cancelled', '0xclient111122223333444455556666777788889999', '{}'::jsonb, 'cancelled', 'on_chain'
      );
    `;

    // 2. Status constraint rejects invalid status
    await assert.rejects(
      async () => {
        await client`
          INSERT INTO "synq_test_clean"."deal_events_outbox" (
            id, chain_id, deal_id, event, recipient_wallet, payload, status, origin
          ) VALUES (
            'outbox:clean:invalid', 11155111, '0xdeal1', 'deal_cancelled', '0xclient111122223333444455556666777788889999', '{}'::jsonb, 'INVALID_STATUS', 'on_chain'
          );
        `;
      },
      /chk_deal_events_outbox_status_valid|constraint/i,
      'Must reject invalid status',
    );

    // 3. Verify deal_replay_jobs table columns and defaults in synq_test_clean
    const replayCols = await client`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'synq_test_clean'
        AND table_name = 'deal_replay_jobs';
    `;
    const replayColNames = replayCols.map((c: any) => c.column_name);
    assert.ok(replayColNames.includes('id'), 'deal_replay_jobs must include id');
    assert.ok(replayColNames.includes('chain_id'), 'deal_replay_jobs must include chain_id');
    assert.ok(replayColNames.includes('contract_address'), 'deal_replay_jobs must include contract_address');
    assert.ok(replayColNames.includes('contract_type'), 'deal_replay_jobs must include contract_type');
    assert.ok(replayColNames.includes('generation'), 'deal_replay_jobs must include generation');
    assert.ok(replayColNames.includes('from_block'), 'deal_replay_jobs must include from_block');
    assert.ok(replayColNames.includes('to_block'), 'deal_replay_jobs must include to_block');
    assert.ok(replayColNames.includes('last_processed_block'), 'deal_replay_jobs must include last_processed_block');
    assert.ok(replayColNames.includes('status'), 'deal_replay_jobs must include status');
    assert.ok(replayColNames.includes('claim_token'), 'deal_replay_jobs must include claim_token');
    assert.ok(replayColNames.includes('claim_expires_at'), 'deal_replay_jobs must include claim_expires_at');
    assert.ok(replayColNames.includes('next_retry_at'), 'deal_replay_jobs must include next_retry_at');

    // 4. Verify deal_replay_jobs clean insert succeeds in synq_test_clean
    await client`
      INSERT INTO "synq_test_clean"."deal_replay_jobs" (
        id, chain_id, contract_address, contract_type, generation, from_block, to_block
      ) VALUES (
        '11155111:0x1111222233334444555566667777888899990001', 11155111,
        '0x1111222233334444555566667777888899990001', 'deal_v2', 'v2', 100, 200
      );
    `;
  });

  // Scenario 2: Representative upgrade from schema version 0013 through 0020 on isolated schema
  it('02. Upgrade from schema version 0013 preserves legacy records and executes 0014-0020 in order', async (t) => {
    if (!isEnabled || !rawClient) {
      t.skip('Skipped in offline mode');
      return;
    }
    const client = rawClient;

    // Step 1: Apply migrations 0000..0013 ONLY in dedicated isolated schema 'synq_test_upgrade'
    const step1 = await applyMigrationFiles(client, 0, 13, 'synq_test_upgrade');
    assert.equal(step1.appliedCount, 14, 'Must apply exactly 14 migrations (0000 through 0013)');

    // Step 2: Confirm pre-0014 schema state (deal_proposals exists, outbox/notifications do NOT exist)
    const preTables = await client`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'synq_test_upgrade' 
        AND table_name IN ('deal_notifications', 'deal_events_outbox', 'deal_proposals')
    `;
    const preTableNames = preTables.map((r: any) => r.table_name);
    assert.ok(preTableNames.includes('deal_proposals'), 'deal_proposals must exist in 0013');
    assert.ok(!preTableNames.includes('deal_notifications'), 'deal_notifications must NOT exist prior to 0014');
    assert.ok(!preTableNames.includes('deal_events_outbox'), 'deal_events_outbox must NOT exist prior to 0015');

    // Step 3: Insert representative legacy records into synq_test_upgrade.deal_proposals
    await client`
      INSERT INTO "synq_test_upgrade"."deal_proposals" (
        proposal_id, proposal_nonce, chain_id, factory_address, client_wallet, freelancer_wallet,
        canonical_usdc, deal_implementation, primary_resolver, emergency_resolver, milestones_hash,
        is_protected, protection_module, policy_id, expiry, client_signature, title, scope,
        total_amount, milestones, cached_status, deal_address, protection_selection
      ) VALUES (
        'prop-legacy-0013-1', 1, 11155111, '0x9b7c5b529a420d015a85fd77040ef63b0e6cbdb0',
        '0xaaaa111122223333444455556666777788889999', '0xbbbb111122223333444455556666777788889999',
        '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', '0x7e376b006db7798165a6b8e6b191e20e791e4419',
        '0xaaaa111122223333444455556666777788889999', '0xaaaa111122223333444455556666777788889999',
        '0x123', false, '0x0000000000000000000000000000000000000000', '0x0', 9999999999,
        '0xsignature', 'Pre-0014 Legacy Proposal', 'Scope', 5000000, '[]'::jsonb, 'ACCEPTED',
        '0x3333444455556666777788889999000011112222', 'STANDARD'
      );
    `;

    // Step 4: Apply migrations 0014 through 0018 in strict sequential order
    const step2 = await applyMigrationFiles(client, 14, 18, 'synq_test_upgrade');
    assert.equal(step2.appliedCount, 5, 'Must apply exactly 5 migrations (0014 through 0018)');
    assert.deepEqual(step2.appliedTags, [
      '0014_grey_aqueduct',
      '0015_sparkling_viper',
      '0016_lumpy_wolverine',
      '0017_talented_norman_osborn',
      '0018_dry_reptil',
    ]);

    // Step 5: Insert representative pre-0019 cursor row into synq_test_upgrade.chain_sync_cursors (without is_bootstrap column)
    await client`
      INSERT INTO "synq_test_upgrade"."chain_sync_cursors" (
        id, chain_id, scanner_id, last_block_number, last_block_hash
      ) VALUES (
        '11155111:upgrade-scanner-0018', 11155111, 'upgrade-scanner-0018', '11832900', '0x1111222233334444555566667777888899990000111122223333444455556666'
      );
    `;

    // Step 6: Apply migration 0019 in isolated upgrade schema
    const step3 = await applyMigrationFiles(client, 19, 19, 'synq_test_upgrade');
    assert.equal(step3.appliedCount, 1, 'Must apply exactly 1 migration (0019)');
    assert.deepEqual(step3.appliedTags, ['0019_scanner_cursor_bootstrap']);

    // Step 7: Verify post-migration state
    // Post-migration tables exist
    const postTables = await rawClient`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'synq_test_upgrade' 
        AND table_name IN ('deal_notifications', 'deal_events_outbox', 'tracked_deal_contracts', 'chain_sync_cursors')
    `;
    assert.equal(postTables.length, 4, 'All post-0013 tables must exist now');

    // Legacy proposal is intact with protection_selection = 'STANDARD'
    const legacyRow = await rawClient`
      SELECT proposal_id, cached_status, protection_selection, deal_address
      FROM "synq_test_upgrade"."deal_proposals"
      WHERE proposal_id = 'prop-legacy-0013-1'
    `;
    assert.equal(legacyRow.length, 1);
    assert.equal(legacyRow[0].cached_status, 'ACCEPTED');
    assert.equal(legacyRow[0].protection_selection, 'STANDARD');

    // Pre-0019 cursor preserves coordinates and retains historical meaning with is_bootstrap = false
    const cursorRow = await rawClient`
      SELECT id, chain_id, scanner_id, last_block_number, last_block_hash, is_bootstrap
      FROM "synq_test_upgrade"."chain_sync_cursors"
      WHERE id = '11155111:upgrade-scanner-0018'
    `;
    assert.equal(cursorRow.length, 1);
    assert.equal(cursorRow[0].id, '11155111:upgrade-scanner-0018');
    assert.equal(cursorRow[0].last_block_number, '11832900');
    assert.equal(cursorRow[0].last_block_hash, '0x1111222233334444555566667777888899990000111122223333444455556666');
    assert.equal(cursorRow[0].is_bootstrap, false, 'Pre-existing cursor must retain historical meaning with is_bootstrap=false');

    // Step 8: Apply migration 0020 in isolated upgrade schema
    const step4 = await applyMigrationFiles(client, 20, 20, 'synq_test_upgrade');
    assert.equal(step4.appliedCount, 1, 'Must apply exactly 1 migration (0020)');
    assert.deepEqual(step4.appliedTags, ['0020_historical_deal_replay']);

    // Verify deal_replay_jobs table exists post-0020
    const replayJobsTable = await rawClient`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'synq_test_upgrade' 
        AND table_name = 'deal_replay_jobs'
    `;
    assert.equal(replayJobsTable.length, 1, 'deal_replay_jobs must exist in synq_test_upgrade after 0020');

    // Step 9: Re-verify pre-existing proposal and cursor remain completely intact post-0020
    const legacyRowPost0020 = await rawClient`
      SELECT proposal_id, cached_status, protection_selection, deal_address
      FROM "synq_test_upgrade"."deal_proposals"
      WHERE proposal_id = 'prop-legacy-0013-1'
    `;
    assert.equal(legacyRowPost0020.length, 1);
    assert.equal(legacyRowPost0020[0].cached_status, 'ACCEPTED');
    assert.equal(legacyRowPost0020[0].protection_selection, 'STANDARD');

    const cursorRowPost0020 = await rawClient`
      SELECT id, is_bootstrap
      FROM "synq_test_upgrade"."chain_sync_cursors"
      WHERE id = '11155111:upgrade-scanner-0018'
    `;
    assert.equal(cursorRowPost0020.length, 1);
    assert.equal(cursorRowPost0020[0].is_bootstrap, false, 'Pre-existing cursor must retain is_bootstrap=false after 0020');

    // Step 10: Apply migration 0021 in isolated upgrade schema
    const step5 = await applyMigrationFiles(client, 21, 21, 'synq_test_upgrade');
    assert.equal(step5.appliedCount, 1, 'Must apply exactly 1 migration (0021)');
    assert.deepEqual(step5.appliedTags, ['0021_accepted_deal_deployment_block']);

    // Verify deployment_block column exists on deal_proposals post-0021
    const proposalDepBlockCol = await rawClient`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'synq_test_upgrade'
        AND table_name = 'deal_proposals'
        AND column_name = 'deployment_block';
    `;
    assert.equal(proposalDepBlockCol.length, 1, 'deal_proposals must include deployment_block column post-0021');
    assert.equal(proposalDepBlockCol[0].is_nullable, 'YES');

    // Legacy row continues to exist and deployment_block is null
    const legacyRowPost0021 = await rawClient`
      SELECT proposal_id, cached_status, deployment_block
      FROM "synq_test_upgrade"."deal_proposals"
      WHERE proposal_id = 'prop-legacy-0013-1'
    `;
    assert.equal(legacyRowPost0021.length, 1);
    assert.equal(legacyRowPost0021[0].cached_status, 'ACCEPTED');
    assert.equal(legacyRowPost0021[0].deployment_block, null);

    // Step 11: Apply migrations 0022 and 0023 in isolated upgrade schema
    const step6 = await applyMigrationFiles(client, 22, 23, 'synq_test_upgrade');
    assert.equal(step6.appliedCount, 2, 'Must apply exactly 2 migrations (0022 and 0023)');
    assert.deepEqual(step6.appliedTags, [
      '0022_notification_preferences',
      '0023_otp_rate_limits',
    ]);

    // Verify notification_preferences and otp_rate_limits tables exist post-0023
    const upgradeTablesPost0023 = await rawClient`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'synq_test_upgrade' 
        AND table_name IN ('notification_preferences', 'otp_rate_limits')
    `;
    assert.equal(upgradeTablesPost0023.length, 2, 'notification_preferences and otp_rate_limits must exist post-0023');

    // Legacy records remain completely preserved post-0023
    const legacyRowPost0023 = await rawClient`
      SELECT proposal_id, cached_status, deployment_block
      FROM "synq_test_upgrade"."deal_proposals"
      WHERE proposal_id = 'prop-legacy-0013-1'
    `;
    assert.equal(legacyRowPost0023.length, 1);
    assert.equal(legacyRowPost0023[0].cached_status, 'ACCEPTED');
  });

  // Scenario 3: Atomic notification claim concurrency
  it('03. Concurrent notification claims result in a single winner and zero double-claims', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const notifRepo = new DrizzleNotificationsRepository();
    const notifId = 'notif:11155111:0xdeal1:work_submitted:to:0xclient';
    const metadata = {
      dealId: '0xdeal1',
      event: 'work_submitted',
      recipientWallet: '0xclient111122223333444455556666777788889999',
    };

    // Run 10 parallel claims against real PostgreSQL unique constraint
    const claimPromises = Array.from({ length: 10 }, (_, i) =>
      notifRepo.claimPending(notifId, metadata, { fenced: true, claimToken: `token-${i}` } as any),
    );
    const results = await Promise.all(claimPromises);

    const claimedCount = results.filter((r) => typeof r === 'object' && r.status === 'claimed').length;
    const dupCount = results.filter(
      (r) => typeof r === 'object' && (r.status === 'duplicate_pending' || r.status === 'duplicate_delivered'),
    ).length;

    assert.equal(claimedCount, 1, 'Exactly one concurrent worker must win the notification claim');
    assert.equal(dupCount, 9, 'All other concurrent workers must receive duplicate status');
  });

  // Scenario 4: Stale notification claim-token fencing
  it('04. Stale notification lease is stolen by new worker and original holder is fenced out', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const notifRepo = new DrizzleNotificationsRepository();
    const notifId = 'notif:stale:lease:test';
    const metadata = {
      dealId: '0xdeal2',
      event: 'deal_confirmed',
      recipientWallet: '0xworker111122223333444455556666777788889999',
    };

    // 1. Initial claim with old token
    const firstClaim = await notifRepo.claimPending(notifId, metadata, {
      fenced: true,
      claimToken: 'stale-token-1',
    } as any);
    assert.equal((firstClaim as any).status, 'claimed');

    // 2. Artificially make the lease stale by rolling back updatedAt 15 minutes
    await db
      .update(dealNotifications)
      .set({ updatedAt: new Date(Date.now() - 15 * 60 * 1000) })
      .where(eq(dealNotifications.id, notifId));

    // 3. Worker 2 steals the stale lease
    const secondClaim = await notifRepo.claimPending(notifId, metadata, {
      fenced: true,
      claimToken: 'fresh-token-2',
    } as any);
    assert.equal((secondClaim as any).status, 'claimed');

    // 4. Original Worker 1 tries to finalize delivery with stale token -> fenced out!
    const finalized = await notifRepo.markDelivered(notifId, 'msg-1', 'client@test.com', 'stale-token-1');
    assert.equal(finalized, false, 'Original holder with stale token must be fenced out of finalization');
  });

  // Scenario 5: Atomic outbox claim concurrency
  it('05. Concurrent outbox workers claim distinct pending items with zero double-processing', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const outboxRepo = new DrizzleDealOutboxRepository();
    // Insert 5 pending outbox items
    for (let i = 0; i < 5; i++) {
      await outboxRepo.enqueue({
        id: `outbox:concurrent:${i}`,
        chainId: 11155111,
        dealId: `0xdeal_${i}`,
        event: 'work_submitted',
        recipientWallet: '0xclient111122223333444455556666777788889999',
        origin: 'off_chain',
        payload: { index: i },
      });
    }

    // 10 concurrent workers each attempt to claim item 0
    const item0Claims = await Promise.all(
      Array.from({ length: 10 }, (_, i) => outboxRepo.claim('outbox:concurrent:0', `worker-${i}`)),
    );
    const item0Winners = item0Claims.filter(Boolean).length;
    assert.equal(item0Winners, 1, 'Exactly 1 worker must claim item 0');

    // Worker claiming across items 1..4 in parallel
    const restClaims = await Promise.all([
      outboxRepo.claim('outbox:concurrent:1', 'worker-1'),
      outboxRepo.claim('outbox:concurrent:2', 'worker-2'),
      outboxRepo.claim('outbox:concurrent:3', 'worker-3'),
      outboxRepo.claim('outbox:concurrent:4', 'worker-4'),
    ]);
    assert.deepEqual(restClaims, [true, true, true, true], 'All distinct items must be claimed exactly once');

    // Second claim attempts on all items must return false
    const reclaims = await Promise.all([
      outboxRepo.claim('outbox:concurrent:0', 'worker-reclaim'),
      outboxRepo.claim('outbox:concurrent:1', 'worker-reclaim'),
      outboxRepo.claim('outbox:concurrent:2', 'worker-reclaim'),
      outboxRepo.claim('outbox:concurrent:3', 'worker-reclaim'),
      outboxRepo.claim('outbox:concurrent:4', 'worker-reclaim'),
    ]);
    assert.deepEqual(reclaims, [false, false, false, false, false], 'No already-processing item can be claimed');
  });

  // Scenario 6: Retry scheduling and exhaustion
  it('06. Outbox failures apply exponential backoff and transition to failed upon retry exhaustion', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const outboxRepo = new DrizzleDealOutboxRepository();
    const itemId = 'outbox:retry:exhaustion:test';
    await outboxRepo.enqueue({
      id: itemId,
      chainId: 11155111,
      dealId: '0xdeal_retry',
      event: 'work_submitted',
      recipientWallet: '0xclient111122223333444455556666777788889999',
      origin: 'off_chain',
      payload: {},
    });

    // First claim succeeds
    const claimed1 = await outboxRepo.claim(itemId, 'token-0');
    assert.ok(claimed1, 'Initial claim must succeed');
    await outboxRepo.markFailed(itemId, 'Failure attempt 1', 'token-0');

    // Immediate reclaim is rejected due to exponential backoff
    const immediateClaim = await outboxRepo.claim(itemId, 'token-immediate');
    assert.equal(immediateClaim, false, 'Immediate reclaim must be rejected by exponential backoff');

    // Fast-forward nextRetryAt to past to simulate backoff window elapsing for attempts 2 to 5
    for (let i = 1; i < 5; i++) {
      await db
        .update(dealEventsOutbox)
        .set({ nextRetryAt: new Date(Date.now() - 1000) })
        .where(eq(dealEventsOutbox.id, itemId));

      const claimed = await outboxRepo.claim(itemId, `token-${i}`);
      assert.ok(claimed, `Claim ${i + 1} must succeed after backoff elapsed`);
      await outboxRepo.markFailed(itemId, `Failure attempt ${i + 1}`, `token-${i}`);
    }

    const item = await outboxRepo.get(itemId);
    assert.equal(item?.retryCount, 5);
    assert.equal(item?.status, 'failed');

    // After 5 retries (MAX_OUTBOX_RETRIES), item is permanently exhausted even if nextRetryAt is in the past
    await db
      .update(dealEventsOutbox)
      .set({ nextRetryAt: new Date(Date.now() - 1000) })
      .where(eq(dealEventsOutbox.id, itemId));
    const claimedAfterMax = await outboxRepo.claim(itemId, 'worker-after-max');
    assert.equal(claimedAfterMax, false, 'Must not be claimable after retry exhaustion');
  });

  // Scenario 7: Proposal/outbox transaction rollback
  it('07. Proposal creation rolls back atomically if outbox staging fails', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const proposalRepo = new DrizzleDealProposalRepository();

    // Attempt creation with invalid outbox origin inside transaction
    await assert.rejects(
      async () => {
        await db!.transaction(async (tx) => {
          await tx.insert(dealProposals).values({
            proposalId: 'prop-rollback-test',
            proposalNonce: '99',
            chainId: 11155111,
            factoryAddress: SYNQ_V2_SEPOLIA_CONFIG.factory.toLowerCase(),
            clientWallet: '0xaaaa111122223333444455556666777788889999',
            freelancerWallet: '0xbbbb111122223333444455556666777788889999',
            canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
            dealImplementation: '0x7E376b006Db7798165a6b8E6B191E20e791E4419',
            primaryResolver: '0xaaaa111122223333444455556666777788889999',
            emergencyResolver: '0xaaaa111122223333444455556666777788889999',
            milestonesHash: '0x123',
            isProtected: false,
            protectionModule: '0x0000000000000000000000000000000000000000',
            policyId: '0x0',
            expiry: '9999999999',
            clientSignature: '0xsignature',
            title: 'Rollback Test',
            scope: 'Test',
            totalAmount: '1000',
            milestones: [],
            cachedStatus: 'PENDING',
          } as any);

          // Force outbox constraint failure with invalid origin
          await tx.insert(dealEventsOutbox).values({
            id: 'outbox:force:fail',
            chainId: 11155111,
            dealId: 'prop-rollback-test',
            event: 'proposal_received',
            recipientWallet: '0xbbbb111122223333444455556666777788889999',
            payload: {},
            origin: 'INVALID_ORIGIN' as any, // Violates chk_deal_events_outbox_origin_valid
          });
        });
      },
      /chk_deal_events_outbox_origin_valid|constraint/i,
    );

    // Verify proposal was rolled back
    const found = await proposalRepo.getById('prop-rollback-test');
    assert.equal(found, null, 'Proposal row must have rolled back completely');
  });

  // Scenario 8: Tracked-contract uniqueness
  it('08. Duplicate tracked contracts are rejected by database unique constraint', async (t) => {
    if (!isEnabled || !db || !rawClient) {
      t.skip('Skipped in offline mode');
      return;
    }
    const client = rawClient;

    const dealAddr = '0x1111222233334444555566667777888899990000';

    // First direct insert succeeds
    await client`
      INSERT INTO "tracked_deal_contracts" (
        id, chain_id, contract_address, contract_type, deployment_block
      ) VALUES (
        '11155111:0x1111222233334444555566667777888899990000', 11155111, ${dealAddr}, 'deal_v2', 100
      );
    `;

    // Second direct insert violates unique constraint uq_tracked_deal_contracts_chain_addr
    await assert.rejects(
      async () => {
        await client`
          INSERT INTO "tracked_deal_contracts" (
            id, chain_id, contract_address, contract_type, deployment_block
          ) VALUES (
            '11155111:0x1111222233334444555566667777888899990000_dup', 11155111, ${dealAddr}, 'deal_v2', 100
          );
        `;
      },
      /uq_tracked_deal_contracts_chain_addr|unique|duplicate/i,
      'Direct duplicate insert must fail on unique constraint',
    );

    // Drizzle repository upsert handles conflict gracefully
    const trackedRepo = new DrizzleTrackedContractsRepository();
    await trackedRepo.upsert({
      chainId: 11155111,
      contractAddress: dealAddr,
      contractType: 'deal_v2',
      deploymentBlock: 105n,
    });
    const item = await trackedRepo.get(11155111, dealAddr);
    assert.equal(item?.deploymentBlock, 105n);
  });

  // Scenario 9: Cursor compare-and-swap
  it('09. Stale cursor updates are rejected by atomic CAS check', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const cursorRepo = new DrizzleChainCursorRepository();
    const scannerId = 'synq-cas-test';

    await cursorRepo.initializeIfMissing({
      chainId: 11155111,
      scannerId,
      initialBlockNumber: 100n,
      initialBlockHash: '0xhash100',
    });

    // Advance cursor from 100n to 110n
    const firstAdv = await cursorRepo.advance({
      chainId: 11155111,
      scannerId,
      expectedLastBlockNumber: 100n,
      newBlockNumber: 110n,
      newBlockHash: '0xhash110',
    });
    assert.equal(firstAdv.status, 'advanced');

    // Stale worker expects 100n -> must return conflict_stale
    const staleAdv = await cursorRepo.advance({
      chainId: 11155111,
      scannerId,
      expectedLastBlockNumber: 100n,
      newBlockNumber: 120n,
      newBlockHash: '0xhash120',
    });
    assert.equal(staleAdv.status, 'conflict_stale');
  });

  // Scenario 10: On-chain event invalidation after reorg
  it('10. Chain reorganization invalidates orphaned on-chain outbox records to cancelled', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const outboxRepo = new DrizzleDealOutboxRepository();
    // Enqueue on-chain item at block 250
    await outboxRepo.enqueue({
      id: 'outbox:reorg:onchain',
      chainId: 11155111,
      dealId: '0xdeal_reorg',
      event: 'payment_released',
      recipientWallet: '0xclient111122223333444455556666777788889999',
      origin: 'on_chain',
      blockNumber: 250n,
      payload: {},
    });

    // Rewind past block 240
    const invalidated = await outboxRepo.invalidateOrphanedEvents(11155111, 240n);
    assert.equal(invalidated, 1);

    const fresh = await outboxRepo.get('outbox:reorg:onchain');
    assert.equal(fresh?.status, 'cancelled');
    assert.equal(fresh?.claimToken, null);
    assert.ok(fresh?.lastError?.includes('240'));
  });

  // Scenario 11: Preservation of off-chain proposal events
  it('11. Reorganization rewind leaves off-chain proposal outbox items untouched', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const outboxRepo = new DrizzleDealOutboxRepository();
    await outboxRepo.enqueue({
      id: 'outbox:reorg:offchain',
      chainId: 11155111,
      dealId: '0xdeal_offchain',
      event: 'proposal_received',
      recipientWallet: '0xclient111122223333444455556666777788889999',
      origin: 'off_chain',
      payload: {},
    });

    // Rewind
    const invalidated = await outboxRepo.invalidateOrphanedEvents(11155111, 100n);
    assert.equal(invalidated, 0, 'Zero off-chain events should be invalidated');

    const fresh = await outboxRepo.get('outbox:reorg:offchain');
    assert.equal(fresh?.status, 'pending', 'Off-chain proposal items must remain pending across reorgs');
  });

  // Scenario 12: Schema compatibility
  it('12. Database schema column definitions match TypeScript types and constraints', async (t) => {
    if (!isEnabled || !rawClient) {
      t.skip('Skipped in offline mode');
      return;
    }
    const client = rawClient;

    // Inspect columns of all critical tables in operational test schema
    const columns = await client`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'synq_test_ops'
        AND table_name IN ('deal_events_outbox', 'tracked_deal_contracts', 'chain_sync_cursors', 'deal_notifications')
      ORDER BY table_name, column_name
    `;

    const getCols = (tbl: string) => columns.filter((c: any) => c.table_name === tbl).map((c: any) => c.column_name);

    const outboxCols = getCols('deal_events_outbox');
    assert.ok(outboxCols.includes('origin'));
    assert.ok(outboxCols.includes('claim_token'));
    assert.ok(outboxCols.includes('next_retry_at'));
    assert.ok(outboxCols.includes('block_number'));
    assert.ok(outboxCols.includes('status'));

    const trackedCols = getCols('tracked_deal_contracts');
    assert.ok(trackedCols.includes('contract_type'));
    assert.ok(trackedCols.includes('deployment_block'));
    assert.ok(trackedCols.includes('factory_address'));
    assert.ok(trackedCols.includes('metadata'));

    const cursorCols = getCols('chain_sync_cursors');
    assert.ok(cursorCols.includes('last_block_number'));
    assert.ok(cursorCols.includes('last_block_hash'));
    assert.ok(cursorCols.includes('is_bootstrap'));

    const notifCols = getCols('deal_notifications');
    assert.ok(notifCols.includes('claim_token'));
    assert.ok(notifCols.includes('recipient_wallet'));
    assert.ok(notifCols.includes('status'));
  });

  // Scenario 13: Correct V1/V2/Nexotiq rehydration
  it('13. Scanner rehydration preserves distinct V2, V1, and Nexotiq contract types and generations', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const proposalRepo = new DrizzleDealProposalRepository();
    const trackedRepo = new DrizzleTrackedContractsRepository();
    const cursorRepo = new DrizzleChainCursorRepository();
    const outboxRepo = new DrizzleDealOutboxRepository();
    const notifRepo = new DrizzleNotificationsRepository();
    const registry = new DealContractRegistry();

    // 1. Seed V2 deal proposal
    await proposalRepo.create({
      proposalId: 'prop-v2',
      proposalNonce: '10',
      chainId: 11155111,
      factoryAddress: SYNQ_V2_SEPOLIA_CONFIG.factory.toLowerCase(),
      clientWallet: '0xaaaa111122223333444455556666777788889999',
      freelancerWallet: '0xbbbb111122223333444455556666777788889999',
      canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      dealImplementation: '0x7E376b006Db7798165a6b8E6B191E20e791E4419',
      primaryResolver: '0xaaaa111122223333444455556666777788889999',
      emergencyResolver: '0xaaaa111122223333444455556666777788889999',
      milestonesHash: '0x123',
      isProtected: false,
      protectionModule: '0x0000000000000000000000000000000000000000',
      policyId: '0x0',
      expiry: '9999999999',
      clientSignature: '0xsignature',
      title: 'V2 Deal',
      scope: 'Test',
      totalAmount: '1000',
      milestones: [],
      dealAddress: '0x1111000011110000111100001111000011110000',
      cachedStatus: 'ACCEPTED',
    } as any);

    // 2. Seed V1 deal proposal
    await proposalRepo.create({
      proposalId: 'prop-v1',
      proposalNonce: '11',
      chainId: 11155111,
      factoryAddress: sepoliaV2Deployment.contracts.supersededFactoryV1.toLowerCase(),
      clientWallet: '0xaaaa111122223333444455556666777788889999',
      freelancerWallet: '0xbbbb111122223333444455556666777788889999',
      canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      dealImplementation: '0x2a3C8A880398FF6DD8e6F9976c8BE6C8aBef2435',
      primaryResolver: '0xaaaa111122223333444455556666777788889999',
      emergencyResolver: '0xaaaa111122223333444455556666777788889999',
      milestonesHash: '0x123',
      isProtected: false,
      protectionModule: '0x0000000000000000000000000000000000000000',
      policyId: '0x0',
      expiry: '9999999999',
      clientSignature: '0xsignature',
      title: 'V1 Deal',
      scope: 'Test',
      totalAmount: '1000',
      milestones: [],
      dealAddress: '0x2222000022220000222200002222000022220000',
      cachedStatus: 'ACCEPTED',
    } as any);

    // 3. Seed Nexotiq deal proposal
    await proposalRepo.create({
      proposalId: 'prop-legacy',
      proposalNonce: '12',
      chainId: 11155111,
      factoryAddress: CONTRACT_ADDRESSES.sepolia.NexotiqFactory.toLowerCase(),
      clientWallet: '0xaaaa111122223333444455556666777788889999',
      freelancerWallet: '0xbbbb111122223333444455556666777788889999',
      canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      dealImplementation: '0x2a3C8A880398FF6DD8e6F9976c8BE6C8aBef2435',
      primaryResolver: '0xaaaa111122223333444455556666777788889999',
      emergencyResolver: '0xaaaa111122223333444455556666777788889999',
      milestonesHash: '0x123',
      isProtected: false,
      protectionModule: '0x0000000000000000000000000000000000000000',
      policyId: '0x0',
      expiry: '9999999999',
      clientSignature: '0xsignature',
      title: 'Nexotiq Deal',
      scope: 'Test',
      totalAmount: '1000',
      milestones: [],
      dealAddress: '0x3333000033330000333300003333000033330000',
      cachedStatus: 'ACCEPTED',
    } as any);

    const scanner = new BlockchainScanner(
      11155111,
      'test-scanner-pg',
      new DummyRpcClient(),
      cursorRepo,
      registry,
      outboxRepo,
      notifRepo,
      5n,
      100n,
      trackedRepo,
      0n,
      proposalRepo,
      SUPPORTED_SEPOLIA_FACTORIES,
    );

    const count = await scanner.rehydrateAcceptedDeals();
    assert.equal(count, 3);

    const v2Tracked = await trackedRepo.get(11155111, '0x1111000011110000111100001111000011110000');
    assert.equal(v2Tracked?.contractType, 'deal_v2');
    assert.equal(v2Tracked?.metadata?.generation, 'v2');

    const v1Tracked = await trackedRepo.get(11155111, '0x2222000022220000222200002222000022220000');
    assert.equal(v1Tracked?.contractType, 'deal_v1');
    assert.equal(v1Tracked?.metadata?.generation, 'v1');

    const legacyTracked = await trackedRepo.get(11155111, '0x3333000033330000333300003333000033330000');
    assert.equal(legacyTracked?.contractType, 'deal_v1');
    assert.equal(legacyTracked?.metadata?.generation, 'legacy');
  });

  // Scenario 14: Unknown-factory fail-closed behavior
  it('14. Unknown factory proposals are safely skipped without mutating proposal status', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const proposalRepo = new DrizzleDealProposalRepository();
    const trackedRepo = new DrizzleTrackedContractsRepository();
    const cursorRepo = new DrizzleChainCursorRepository();
    const outboxRepo = new DrizzleDealOutboxRepository();
    const notifRepo = new DrizzleNotificationsRepository();
    const registry = new DealContractRegistry();

    const unknownDealAddr = '0x9999888877776666555544443333222211110000';
    await proposalRepo.create({
      proposalId: 'prop-unknown-pg',
      proposalNonce: '99',
      chainId: 11155111,
      factoryAddress: '0x9999999999999999999999999999999999999999', // Unknown factory
      clientWallet: '0xaaaa111122223333444455556666777788889999',
      freelancerWallet: '0xbbbb111122223333444455556666777788889999',
      canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      dealImplementation: '0x7E376b006Db7798165a6b8E6B191E20e791E4419',
      primaryResolver: '0xaaaa111122223333444455556666777788889999',
      emergencyResolver: '0xaaaa111122223333444455556666777788889999',
      milestonesHash: '0x123',
      isProtected: false,
      protectionModule: '0x0000000000000000000000000000000000000000',
      policyId: '0x0',
      expiry: '9999999999',
      clientSignature: '0xsignature',
      title: 'Unknown Deal',
      scope: 'Test',
      totalAmount: '1000',
      milestones: [],
      dealAddress: unknownDealAddr,
      cachedStatus: 'ACCEPTED',
    } as any);

    const scanner = new BlockchainScanner(
      11155111,
      'test-scanner-unknown',
      new DummyRpcClient(),
      cursorRepo,
      registry,
      outboxRepo,
      notifRepo,
      5n,
      100n,
      trackedRepo,
      0n,
      proposalRepo,
      SUPPORTED_SEPOLIA_FACTORIES,
    );

    const count = await scanner.rehydrateAcceptedDeals();
    assert.equal(count, 0, 'Must skip unknown factory');

    const tracked = await trackedRepo.get(11155111, unknownDealAddr);
    assert.equal(tracked, null, 'Must not track contract with unknown factory');

    const prop = await proposalRepo.getById('prop-unknown-pg');
    assert.equal(prop?.cachedStatus, 'ACCEPTED', 'Proposal status must remain ACCEPTED');
  });

  // Scenario 15: Migration 0019 cursor bootstrap lifecycle, concurrent initialization, and CAS advancement
  it('15. Migration 0019 cursor lifecycle: concurrent initialization sets bootstrap=true, CAS advance flips to false', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const cursorRepo = new DrizzleChainCursorRepository();
    const chainId = 11155111;
    const scannerId = 'synq-concurrent-test-scanner';
    const initialBlock = 11832782n;
    const initialHash = '0x1111111111111111111111111111111111111111111111111111111111111111';

    // 1. Run 10 parallel initializations against real PostgreSQL
    const initPromises = Array.from({ length: 10 }, () =>
      cursorRepo.initializeIfMissing({
        chainId,
        scannerId,
        initialBlockNumber: initialBlock,
        initialBlockHash: initialHash,
        isBootstrap: true,
      }),
    );
    const initResults = await Promise.all(initPromises);
    for (const res of initResults) {
      assert.equal(res.lastBlockNumber, initialBlock);
      assert.equal(res.lastBlockHash, initialHash);
      assert.equal(res.isBootstrap, true);
    }

    // 2. Repeatability: re-running initializeIfMissing returns existing cursor without altering coordinates
    const repeat = await cursorRepo.initializeIfMissing({
      chainId,
      scannerId,
      initialBlockNumber: 99999999n,
      initialBlockHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
      isBootstrap: false,
    });
    assert.equal(repeat.lastBlockNumber, initialBlock);
    assert.equal(repeat.isBootstrap, true);

    // 3. Cursor CAS advancement transitions isBootstrap from true to false
    const advanceBlock = 11832800n;
    const advanceHash = '0x2222222222222222222222222222222222222222222222222222222222222222';
    const advanceResult = await cursorRepo.advance({
      chainId,
      scannerId,
      expectedLastBlockNumber: initialBlock,
      newBlockNumber: advanceBlock,
      newBlockHash: advanceHash,
    });
    assert.equal(advanceResult.status, 'advanced');
    assert.equal(advanceResult.cursor?.lastBlockNumber, advanceBlock);
    assert.equal(advanceResult.cursor?.isBootstrap, false, 'Advanced cursor must transition isBootstrap to false');

    // Verify in database
    const updated = await cursorRepo.get(chainId, scannerId);
    assert.equal(updated?.lastBlockNumber, advanceBlock);
    assert.equal(updated?.isBootstrap, false);

    // 4. Stale CAS advancement fails
    const staleResult = await cursorRepo.advance({
      chainId,
      scannerId,
      expectedLastBlockNumber: initialBlock, // Stale!
      newBlockNumber: 11832900n,
      newBlockHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
    });
    assert.equal(staleResult.status, 'conflict_stale');
  });

  // Scenario 16: Validation of all deal_replay_jobs constraints and indexes
  it('16. deal_replay_jobs constraints and indexes enforce integrity under real PostgreSQL', async (t) => {
    if (!isEnabled || !db || !rawClient) {
      t.skip('Skipped in offline mode');
      return;
    }
    const client = rawClient;

    // 1. Valid insert succeeds
    await client`
      INSERT INTO "deal_replay_jobs" (
        id, chain_id, contract_address, contract_type, generation, from_block, to_block, status
      ) VALUES (
        '11155111:0x1111222233334444555566667777888899990001', 11155111,
        '0x1111222233334444555566667777888899990001', 'deal_v2', 'v2', 100, 200, 'pending'
      );
    `;

    // 2. Reject uppercase contract_address (chk_deal_replay_jobs_addr_lower)
    await assert.rejects(
      async () => {
        await client`
          INSERT INTO "deal_replay_jobs" (
            id, chain_id, contract_address, contract_type, generation, from_block, to_block, status
          ) VALUES (
            '11155111:0xUPPER', 11155111,
            '0x111122223333444455556666777788889999000A', 'deal_v2', 'v2', 100, 200, 'pending'
          );
        `;
      },
      /chk_deal_replay_jobs_addr_lower|constraint/i,
      'Must reject uppercase contract address',
    );

    // 3. Reject invalid status (chk_deal_replay_jobs_status_valid)
    await assert.rejects(
      async () => {
        await client`
          INSERT INTO "deal_replay_jobs" (
            id, chain_id, contract_address, contract_type, generation, from_block, to_block, status
          ) VALUES (
            '11155111:0x1111222233334444555566667777888899990002', 11155111,
            '0x1111222233334444555566667777888899990002', 'deal_v2', 'v2', 100, 200, 'invalid_status'
          );
        `;
      },
      /chk_deal_replay_jobs_status_valid|constraint/i,
      'Must reject invalid status',
    );

    // 4. Reject invalid generation (chk_deal_replay_jobs_generation_valid)
    await assert.rejects(
      async () => {
        await client`
          INSERT INTO "deal_replay_jobs" (
            id, chain_id, contract_address, contract_type, generation, from_block, to_block, status
          ) VALUES (
            '11155111:0x1111222233334444555566667777888899990003', 11155111,
            '0x1111222233334444555566667777888899990003', 'deal_v2', 'v3', 100, 200, 'pending'
          );
        `;
      },
      /chk_deal_replay_jobs_generation_valid|constraint/i,
      'Must reject invalid generation',
    );

    // 5. Reject invalid contract_type (chk_deal_replay_jobs_type_valid)
    await assert.rejects(
      async () => {
        await client`
          INSERT INTO "deal_replay_jobs" (
            id, chain_id, contract_address, contract_type, generation, from_block, to_block, status
          ) VALUES (
            '11155111:0x1111222233334444555566667777888899990004', 11155111,
            '0x1111222233334444555566667777888899990004', 'factory', 'v2', 100, 200, 'pending'
          );
        `;
      },
      /chk_deal_replay_jobs_type_valid|constraint/i,
      'Must reject invalid contract_type',
    );

    // 6. Unique index uq_deal_replay_jobs_chain_contract rejects duplicate (chain_id, contract_address)
    await assert.rejects(
      async () => {
        await client`
          INSERT INTO "deal_replay_jobs" (
            id, chain_id, contract_address, contract_type, generation, from_block, to_block, status
          ) VALUES (
            'diff-id-same-contract', 11155111,
            '0x1111222233334444555566667777888899990001', 'deal_v2', 'v2', 100, 200, 'pending'
          );
        `;
      },
      /uq_deal_replay_jobs_chain_contract|unique|duplicate/i,
      'Must reject duplicate chain_id + contract_address via unique index',
    );

    // 7. Verify all indexes exist in PostgreSQL catalog
    const indexes = await client`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'synq_test_ops' AND tablename = 'deal_replay_jobs';
    `;
    const idxNames = indexes.map((r: any) => r.indexname);
    assert.ok(idxNames.includes('uq_deal_replay_jobs_chain_contract'), 'uq_deal_replay_jobs_chain_contract must exist');
    assert.ok(idxNames.includes('idx_deal_replay_jobs_status_retry'), 'idx_deal_replay_jobs_status_retry must exist');
    assert.ok(idxNames.includes('idx_deal_replay_jobs_contract'), 'idx_deal_replay_jobs_contract must exist');
  });

  // Scenario 17: Ten concurrent workers competing for replay jobs with zero duplicate claims
  it('17. Ten concurrent workers claim pending replay jobs with atomic FOR UPDATE SKIP LOCKED and zero duplicate claims', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const replayRepo = new DrizzleDealReplayRepository();

    // 1. Seed 10 distinct pending replay jobs
    for (let i = 0; i < 10; i++) {
      const hex = i.toString(16).padStart(4, '0');
      const addr = `0x777788889999000011112222333344445555${hex}`;
      await replayRepo.createJob({
        chainId: 11155111,
        contractAddress: addr,
        contractType: 'deal_v2',
        generation: 'v2',
        fromBlock: 100n + BigInt(i * 10),
        toBlock: 200n + BigInt(i * 10),
      });
    }

    // 2. Launch 10 concurrent workers competing for 1 job each
    const claimPromises = Array.from({ length: 10 }, (_, i) =>
      replayRepo.claimPendingJobs({
        chainId: 11155111,
        limit: 1,
        workerId: `worker-conc-${i}`,
      }),
    );
    const workerResults = await Promise.all(claimPromises);

    // 3. Verify exactly 10 jobs were claimed in total
    const allClaimed = workerResults.flat();
    assert.equal(allClaimed.length, 10, 'All 10 pending jobs must be claimed across the 10 concurrent workers');

    // 4. Verify each worker got a unique job (zero duplicate claims)
    const distinctJobIds = new Set(allClaimed.map((j) => j.id));
    assert.equal(distinctJobIds.size, 10, 'Every claimed job must be distinct with zero duplicate claims');

    // 5. Verify each job has a unique worker claim token
    const distinctTokens = new Set(allClaimed.map((j) => j.claimToken));
    assert.equal(distinctTokens.size, 10, 'Every worker must hold a distinct claim token');

    // 6. Verify an 11th worker finds zero available jobs
    const extraClaim = await replayRepo.claimPendingJobs({
      chainId: 11155111,
      limit: 1,
      workerId: 'worker-conc-11',
    });
    assert.equal(extraClaim.length, 0, 'No remaining pending jobs available for additional workers');
  });

  // Scenario 18: Expired lease reclamation and stale-worker fencing
  it('18. Expired replay lease reclamation and stale-worker fencing', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const replayRepo = new DrizzleDealReplayRepository();
    const testAddr = '0x8888999900001111222233334444555566660001';

    // 1. Create and claim job with Worker A
    const { job } = await replayRepo.createJob({
      chainId: 11155111,
      contractAddress: testAddr,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 100n,
      toBlock: 500n,
    });

    const claimedA = await replayRepo.claimPendingJobs({
      chainId: 11155111,
      limit: 1,
      workerId: 'worker-lease-a',
    });
    assert.equal(claimedA.length, 1);
    const tokenA = claimedA[0].claimToken!;

    // 2. Artificially expire the lease by rolling claimExpiresAt 10 minutes into the past
    await db
      .update(dealReplayJobs)
      .set({ claimExpiresAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(dealReplayJobs.id, job.id));

    // 3. Worker B reclaims the expired job with a fresh claim token
    const claimedB = await replayRepo.claimPendingJobs({
      chainId: 11155111,
      limit: 1,
      workerId: 'worker-lease-b',
    });
    assert.equal(claimedB.length, 1, 'Worker B must reclaim the expired job');
    assert.equal(claimedB[0].id, job.id);
    const tokenB = claimedB[0].claimToken!;
    assert.notEqual(tokenB, tokenA, 'Worker B must receive a fresh, distinct claim token');

    // 4. Stale Worker A attempts updateProgress -> fenced out
    const progressA = await replayRepo.updateProgress({
      id: job.id,
      claimToken: tokenA,
      lastProcessedBlock: 200n,
    });
    assert.equal(progressA.success, false, 'Stale worker updateProgress must be rejected');
    assert.match(progressA.error!, /fenced/i);

    // 5. Stale Worker A attempts markCompleted -> fenced out
    const completeA = await replayRepo.markCompleted({
      id: job.id,
      claimToken: tokenA,
      finalProcessedBlock: 500n,
    });
    assert.equal(completeA.success, false, 'Stale worker markCompleted must be rejected');
    assert.match(completeA.error!, /fenced/i);

    // 6. Stale Worker A attempts markFailed -> fenced out
    const failA = await replayRepo.markFailed({
      id: job.id,
      claimToken: tokenA,
      error: 'Stale worker failure attempt',
    });
    assert.equal(failA.success, false, 'Stale worker markFailed must be rejected');
    assert.match(failA.error!, /fenced/i);

    // 7. Legitimate Worker B successfully updates progress and completes the job
    const progressB = await replayRepo.updateProgress({
      id: job.id,
      claimToken: tokenB,
      lastProcessedBlock: 300n,
    });
    assert.equal(progressB.success, true, 'Worker B with active token must succeed');

    const completeB = await replayRepo.markCompleted({
      id: job.id,
      claimToken: tokenB,
      finalProcessedBlock: 500n,
    });
    assert.equal(completeB.success, true, 'Worker B with active token must mark completed');

    const finalizedJob = await replayRepo.getJobById(job.id);
    assert.equal(finalizedJob?.status, 'completed');
    assert.equal(finalizedJob?.lastProcessedBlock, 500n);
    assert.equal(finalizedJob?.claimToken, null);
  });

  // Scenario 19: Replay progress and retry state persistence under real PostgreSQL
  it('19. Replay progress watermark and retry backoff persistence under real PostgreSQL', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const replayRepo = new DrizzleDealReplayRepository();
    const testAddr = '0x8888999900001111222233334444555566660002';

    // 1. Create and claim job
    const { job } = await replayRepo.createJob({
      chainId: 11155111,
      contractAddress: testAddr,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 1000n,
      toBlock: 2000n,
      maxRetries: 3,
    });

    const claimed = await replayRepo.claimPendingJobs({
      chainId: 11155111,
      limit: 1,
      workerId: 'worker-progress-1',
    });
    assert.equal(claimed.length, 1);
    const token = claimed[0].claimToken!;

    // 2. Durably advance progress watermark
    const advance = await replayRepo.updateProgress({
      id: job.id,
      claimToken: token,
      lastProcessedBlock: 1250n,
    });
    assert.equal(advance.success, true);

    const progressedJob = await replayRepo.getJobById(job.id);
    assert.equal(progressedJob?.lastProcessedBlock, 1250n, 'Watermark must be durably stored in PostgreSQL');

    // 3. Fail with retryable backoff of 60 seconds
    const failRes = await replayRepo.markFailed({
      id: job.id,
      claimToken: token,
      error: 'Transient RPC failure: rate limit exceeded',
      retryable: true,
      backoffSeconds: 60,
    });
    assert.equal(failRes.success, true);

    // 4. Verify row state in PostgreSQL: pending, retryCount=1, claimToken cleared, nextRetryAt set in future
    const failedJob = await replayRepo.getJobById(job.id);
    assert.equal(failedJob?.status, 'pending');
    assert.equal(failedJob?.retryCount, 1);
    assert.equal(failedJob?.claimToken, null);
    assert.equal(failedJob?.claimExpiresAt, null);
    assert.equal(failedJob?.lastError, 'Transient RPC failure: rate limit exceeded');
    assert.ok(failedJob?.nextRetryAt.getTime()! > Date.now() + 30_000, 'nextRetryAt must be in future');

    // 5. Immediate claim attempt returns nothing (retry backoff honored by database)
    const prematureClaim = await replayRepo.claimPendingJobs({
      chainId: 11155111,
      limit: 1,
      workerId: 'worker-progress-2',
    });
    assert.equal(prematureClaim.length, 0, 'Must not claim job before nextRetryAt');

    // 6. Fast-forward retry boundary to past
    await db
      .update(dealReplayJobs)
      .set({ nextRetryAt: new Date(Date.now() - 1000) })
      .where(eq(dealReplayJobs.id, job.id));

    // 7. Exhaust remaining retries to reach terminal failed status
    const reclaim1 = await replayRepo.claimPendingJobs({ limit: 1, workerId: 'worker-ex-1' });
    assert.equal(reclaim1.length, 1);
    await replayRepo.markFailed({
      id: job.id,
      claimToken: reclaim1[0].claimToken!,
      error: 'Failure 2',
      retryable: true,
      backoffSeconds: 0,
    });

    await db.update(dealReplayJobs).set({ nextRetryAt: new Date(Date.now() - 1000) }).where(eq(dealReplayJobs.id, job.id));
    const reclaim2 = await replayRepo.claimPendingJobs({ limit: 1, workerId: 'worker-ex-2' });
    assert.equal(reclaim2.length, 1);
    await replayRepo.markFailed({
      id: job.id,
      claimToken: reclaim2[0].claimToken!,
      error: 'Terminal Failure 3',
      retryable: true,
      backoffSeconds: 0,
    });

    // 8. Terminal state verified: maxRetries=3 reached -> status='failed'
    const terminalJob = await replayRepo.getJobById(job.id);
    assert.equal(terminalJob?.status, 'failed', 'Job must reach terminal failed status upon exhausting retries');
    assert.equal(terminalJob?.retryCount, 3);

    // 9. Job cannot be claimed even after nextRetryAt in past
    await db.update(dealReplayJobs).set({ nextRetryAt: new Date(Date.now() - 1000) }).where(eq(dealReplayJobs.id, job.id));
    const postExhaustion = await replayRepo.claimPendingJobs({ limit: 1, workerId: 'worker-ex-3' });
    assert.equal(postExhaustion.length, 0, 'Terminal failed job must never be claimable');
  });

  // Scenario 20: Idempotent job creation and completed-job behavior
  it('20. Idempotent replay job creation and completed-job behavior', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const replayRepo = new DrizzleDealReplayRepository();
    const testAddr = '0x8888999900001111222233334444555566660003';

    // 1. Initial creation succeeds with status 'created'
    const res1 = await replayRepo.createJob({
      chainId: 11155111,
      contractAddress: testAddr,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 500n,
      toBlock: 800n,
    });
    assert.equal(res1.status, 'created');
    assert.equal(res1.job.contractAddress, testAddr);

    // 2. Duplicate creation returns status 'exists' with identical job
    const res2 = await replayRepo.createJob({
      chainId: 11155111,
      contractAddress: testAddr,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 500n,
      toBlock: 800n,
    });
    assert.equal(res2.status, 'exists');
    assert.equal(res2.job.id, res1.job.id);

    // 3. Verify exactly one row in PostgreSQL
    const rows = await db.select().from(dealReplayJobs).where(eq(dealReplayJobs.id, res1.job.id));
    assert.equal(rows.length, 1, 'Duplicate createJob calls must never duplicate PostgreSQL rows');

    // 4. Claim and complete the job
    const claimed = await replayRepo.claimPendingJobs({ limit: 1, workerId: 'worker-complete-1' });
    assert.equal(claimed.length, 1);
    const completeRes = await replayRepo.markCompleted({
      id: res1.job.id,
      claimToken: claimed[0].claimToken!,
      finalProcessedBlock: 800n,
    });
    assert.equal(completeRes.success, true);

    // 5. Subsequent createJob call still returns existing job, maintaining 'completed' status
    const res3 = await replayRepo.createJob({
      chainId: 11155111,
      contractAddress: testAddr,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 500n,
      toBlock: 800n,
    });
    assert.equal(res3.status, 'exists');
    assert.equal(res3.job.status, 'completed', 'Completed status must be preserved across idempotent createJob calls');

    // 6. Completed job is never claimed by pending workers
    const claimAfterComplete = await replayRepo.claimPendingJobs({ limit: 1, workerId: 'worker-complete-2' });
    assert.equal(claimAfterComplete.length, 0, 'Completed jobs must never be claimed by pending workers');
  });

  // Scenario 21: Real PostgreSQL deferred notification persistence, durability, and atomic re-claim
  it('21. Real PostgreSQL deferred notification persistence, durability, and atomic re-claim', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const notifRepo = new DrizzleNotificationsRepository();
    const notifKey = '11155111:0xpgdeal1:deal_confirmed:role:seller';

    // 1. Initial claim in PostgreSQL
    const claim1 = await notifRepo.claimPending(
      notifKey,
      { dealId: '0xpgdeal1', event: 'deal_confirmed', recipientWallet: '0xaaaa111122223333444455556666777788889999' },
      { fenced: true },
    );
    assert.equal(claim1.status, 'claimed');
    assert.ok(claim1.claimToken);

    // 2. Mark deferred (log-only mode) in PostgreSQL
    const deferredRes = await notifRepo.markDeferred(notifKey, 'SMTP transport disabled (log-only mode)', claim1.claimToken);
    assert.equal(deferredRes, true, 'markDeferred must succeed in PostgreSQL');

    // 3. Durability across separate query: verify row in PostgreSQL
    const persisted = await notifRepo.get(notifKey);
    assert.ok(persisted, 'Deferred record must exist in PostgreSQL');
    assert.equal(persisted.status, 'deferred', 'Status must be durably deferred in PostgreSQL');
    assert.equal(persisted.claimToken, null, 'claimToken must be cleared when deferred');
    assert.equal(persisted.messageId, null, 'messageId must remain null when deferred');
    assert.equal(persisted.error, 'SMTP transport disabled (log-only mode)');

    // 4. Immediate re-claim attempt without bypassCooldown is blocked by cooldown (duplicate_pending)
    const immediateClaim = await notifRepo.claimPending(
      notifKey,
      { dealId: '0xpgdeal1', event: 'deal_confirmed', recipientWallet: '0xaaaa111122223333444455556666777788889999' },
      { fenced: true },
    );
    assert.equal(immediateClaim.status, 'duplicate_pending', 'Immediate re-claim must be throttled by cooldown');

    // 5. Re-claiming deferred record with bypassCooldown atomically succeeds and transitions to pending
    const claim2 = await notifRepo.claimPending(
      notifKey,
      { dealId: '0xpgdeal1', event: 'deal_confirmed', recipientWallet: '0xaaaa111122223333444455556666777788889999' },
      { fenced: true, bypassCooldown: true },
    );
    assert.equal(claim2.status, 'claimed', 'Deferred record must be claimable for delivery retry');
    assert.ok(claim2.claimToken);
    assert.notEqual(claim2.claimToken, claim1.claimToken, 'Fresh claim must receive unique token');

    const pendingRow = await notifRepo.get(notifKey);
    assert.equal(pendingRow?.status, 'pending');
    assert.equal(pendingRow?.claimToken, claim2.claimToken);
  });

  // Scenario 22: Concurrent deferred notification claims in real PostgreSQL
  it('22. Concurrent deferred notification claims result in exactly one winner and zero duplicate dispatches', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const notifRepo = new DrizzleNotificationsRepository();
    const notifKey = '11155111:0xpgdeal2:deal_confirmed:role:seller';

    // 1. Seed deferred row in PostgreSQL
    const initial = await notifRepo.claimPending(
      notifKey,
      { dealId: '0xpgdeal2', event: 'deal_confirmed', recipientWallet: '0xaaaa111122223333444455556666777788889999' },
      { fenced: true },
    );
    await notifRepo.markDeferred(notifKey, 'Initial log-only deferral', initial.claimToken);

    // 2. Two concurrent workers attempt to claim the deferred notification (with bypassCooldown to simulate elapsed cooldown)
    const [resA, resB] = await Promise.all([
      notifRepo.claimPending(
        notifKey,
        { dealId: '0xpgdeal2', event: 'deal_confirmed', recipientWallet: '0xaaaa111122223333444455556666777788889999' },
        { fenced: true, bypassCooldown: true },
      ),
      notifRepo.claimPending(
        notifKey,
        { dealId: '0xpgdeal2', event: 'deal_confirmed', recipientWallet: '0xaaaa111122223333444455556666777788889999' },
        { fenced: true, bypassCooldown: true },
      ),
    ]);

    const statuses = [resA.status, resB.status];
    assert.equal(statuses.filter(s => s === 'claimed').length, 1, 'Exactly one concurrent claim must win');
    assert.equal(statuses.filter(s => s === 'duplicate_pending').length, 1, 'Losing claim must receive duplicate_pending');
  });

  // Scenario 23: Stale claim fencing and deferred-to-delivered transition under real PostgreSQL
  it('23. Stale claim-token fencing and deferred-to-delivered transition in real PostgreSQL', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const notifRepo = new DrizzleNotificationsRepository();
    const notifKey = '11155111:0xpgdeal3:deal_confirmed:role:seller';

    // 1. Initial claim & deferral
    const claim1 = await notifRepo.claimPending(
      notifKey,
      { dealId: '0xpgdeal3', event: 'deal_confirmed', recipientWallet: '0xaaaa111122223333444455556666777788889999' },
      { fenced: true },
    );
    await notifRepo.markDeferred(notifKey, 'Deferred', claim1.claimToken);

    // 2. Legitimate retry worker claims (with bypassCooldown)
    const claim2 = await notifRepo.claimPending(
      notifKey,
      { dealId: '0xpgdeal3', event: 'deal_confirmed', recipientWallet: '0xaaaa111122223333444455556666777788889999' },
      { fenced: true, bypassCooldown: true },
    );
    assert.equal(claim2.status, 'claimed');

    // 3. Stale worker 1 attempts to finalize with old claim token -> fenced out
    const staleDelivered = await notifRepo.markDelivered(notifKey, 'stale-msg-id', 'seller@example.com', claim1.claimToken);
    assert.equal(staleDelivered, false, 'Stale claim token must be rejected in markDelivered');

    const staleFailed = await notifRepo.markFailed(notifKey, 'stale error', claim1.claimToken);
    assert.equal(staleFailed, false, 'Stale claim token must be rejected in markFailed');

    // 4. Winner Worker 2 marks delivered with real messageId
    const delivered = await notifRepo.markDelivered(notifKey, 'smtp-real-msg-999', 'seller@example.com', claim2.claimToken);
    assert.equal(delivered, true, 'Active worker with valid token must succeed');

    // 5. Final state in PostgreSQL is delivered with cleared token
    const finalRow = await notifRepo.get(notifKey);
    assert.equal(finalRow?.status, 'delivered');
    assert.equal(finalRow?.messageId, 'smtp-real-msg-999');
    assert.equal(finalRow?.claimToken, null);

    // 6. Subsequent claim returns duplicate_delivered
    const postDeliveredClaim = await notifRepo.claimPending(
      notifKey,
      { dealId: '0xpgdeal3', event: 'deal_confirmed', recipientWallet: '0xaaaa111122223333444455556666777788889999' },
      { fenced: true },
    );
    assert.equal(postDeliveredClaim.status, 'duplicate_delivered');
  });

  // Scenario 24: Deployment block numeric round-tripping and proposal persistence under real PostgreSQL
  it('24. Deployment block numeric round-tripping and proposal persistence under real PostgreSQL', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode');
      return;
    }

    const proposalRepo = new DrizzleDealProposalRepository();
    const propId = '0x' + '7'.repeat(64);
    const dealAddr = '0x7777888899990000111122223333444455556666';
    const targetBlock = 11833500n;

    // 1. Create proposal in real PostgreSQL
    await proposalRepo.create({
      proposalId: propId,
      proposalNonce: '1',
      chainId: 11155111,
      factoryAddress: '0x32338ff9131a29b5771d22a559868725890ed6ec',
      clientWallet: '0xaaaa111122223333444455556666777788889999',
      freelancerWallet: '0xbbbb111122223333444455556666777788889999',
      canonicalUsdc: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
      dealImplementation: '0x7e376b006db7798165a6b8e6b191e20e791e4419',
      primaryResolver: '0xaaaa111122223333444455556666777788889999',
      emergencyResolver: '0xaaaa111122223333444455556666777788889999',
      milestonesHash: '0x' + '0'.repeat(64),
      isProtected: false,
      protectionModule: '0x0000000000000000000000000000000000000000',
      policyId: '0x' + '0'.repeat(64),
      expiry: '9999999999',
      clientSignature: '0x' + '7'.repeat(130),
      title: 'PostgreSQL Numeric Round-Trip Proposal',
      scope: 'Scope',
      totalAmount: '1000',
      milestones: [],
      protectionSelection: 'STANDARD',
      cachedStatus: 'PENDING',
    });

    // 2. Terminal update with verified deploymentBlock
    await proposalRepo.updateStatus(propId, 'ACCEPTED', {
      dealAddress: dealAddr,
      txHash: '0x' + 'a'.repeat(64),
      deploymentBlock: targetBlock,
    });

    // 3. Retrieve and verify exact numeric round-tripping
    const retrieved = await proposalRepo.getById(propId);
    assert.ok(retrieved);
    assert.equal(retrieved.cachedStatus, 'ACCEPTED');
    assert.equal(retrieved.dealAddress, dealAddr);
    assert.equal(retrieved.deploymentBlock, targetBlock.toString(), 'deploymentBlock string representation must match');
    assert.equal(BigInt(retrieved.deploymentBlock!), targetBlock, 'BigInt conversion must preserve exact value');

    // 4. Large uint64 block height (beyond Number.MAX_SAFE_INTEGER 2^53 - 1 = 9007199254740991)
    const largeBlock = 18446744073709551615n; // 2^64 - 1
    const propIdLarge = '0x' + '8'.repeat(64);
    await proposalRepo.create({
      proposalId: propIdLarge,
      proposalNonce: '2',
      chainId: 11155111,
      factoryAddress: '0x32338ff9131a29b5771d22a559868725890ed6ec',
      clientWallet: '0xaaaa111122223333444455556666777788889999',
      freelancerWallet: '0xbbbb111122223333444455556666777788889999',
      canonicalUsdc: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
      dealImplementation: '0x7e376b006db7798165a6b8e6b191e20e791e4419',
      primaryResolver: '0xaaaa111122223333444455556666777788889999',
      emergencyResolver: '0xaaaa111122223333444455556666777788889999',
      milestonesHash: '0x' + '0'.repeat(64),
      isProtected: false,
      protectionModule: '0x0000000000000000000000000000000000000000',
      policyId: '0x' + '0'.repeat(64),
      expiry: '9999999999',
      clientSignature: '0x' + '8'.repeat(130),
      title: 'Large Numeric Proposal',
      scope: 'Scope',
      totalAmount: '1000',
      milestones: [],
      protectionSelection: 'STANDARD',
      cachedStatus: 'PENDING',
    });

    await proposalRepo.updateStatus(propIdLarge, 'ACCEPTED', {
      dealAddress: '0x8888888888888888888888888888888888888888',
      deploymentBlock: largeBlock,
    });

    const retrievedLarge = await proposalRepo.getById(propIdLarge);
    assert.ok(retrievedLarge);
    assert.equal(BigInt(retrievedLarge.deploymentBlock!), largeBlock, 'Large uint64 numeric(78,0) must not lose precision');
  });

  // Scenario 25: Migrations 0022 and 0023 table creation, lowercase constraints, and preference semantics in real PostgreSQL
  it('25. Migrations 0022 and 0023 table creation, lowercase constraints, and preference semantics in real PostgreSQL', async (t) => {
    if (!isEnabled || !db) {
      t.skip('Skipped in offline mode: requires live disposable PostgreSQL instance');
      return;
    }

    const testWallet = '0x1234567890123456789012345678901234567890';
    const prefsRepo = new DrizzleNotificationPreferencesRepository();

    // 1. Returns defaults when no row exists
    const defaults = await prefsRepo.getPreferences(testWallet);
    assert.equal(defaults.dealProposalsAndConfirmations, true);
    assert.equal(defaults.disputesAndResolutions, true);

    // 2. Persists preference updates
    await prefsRepo.updatePreferences(testWallet, { disputesAndResolutions: false });
    const updated = await prefsRepo.getPreferences(testWallet);
    assert.equal(updated.disputesAndResolutions, false);
    assert.equal(updated.dealProposalsAndConfirmations, true);

    // 3. Lowercase constraint rejection
    await assert.rejects(
      async () => {
        await db!.insert(notificationPreferences).values({
          walletAddress: '0xUPPERCASE11112222333344445555666677778888',
        } as any);
      },
      /chk_notif_pref_wallet_lower/,
      'Uppercase walletAddress in notification_preferences must violate check constraint'
    );
  });

  // Scenario 26: Multi-client PostgreSQL concurrency: atomic OTP rate-limiting, row locking, and rollback
  it('26. Multi-client PostgreSQL concurrency: atomic OTP rate-limiting, row locking, and rollback', async (t) => {
    if (!isEnabled || !db || !rawClient) {
      t.skip('Skipped in offline mode: requires live disposable PostgreSQL instance');
      return;
    }

    // Spin up two independent PostgreSQL client connections simulating separate Node.js processes
    const clientA = postgres(process.env.DATABASE_URL!, { max: 2, idle_timeout: 5 });
    const clientB = postgres(process.env.DATABASE_URL!, { max: 2, idle_timeout: 5 });
    const dbA = drizzle(clientA, { schema });
    const dbB = drizzle(clientB, { schema });
    const repoA = new DrizzleOtpRateLimitRepository(dbA);
    const repoB = new DrizzleOtpRateLimitRepository(dbB);

    try {
      // 1. Lowercase check constraint
      const now = new Date();
      await assert.rejects(
        async () => {
          await db!.insert(otpRateLimits).values({
            key: 'EMAIL:UPPERCASE@EXAMPLE.COM',
            lastRequestedAt: now,
            requestCount: 1,
            windowStart: now,
          });
        },
        /chk_otp_rate_limits_key_lower/,
        'Uppercase key in otp_rate_limits must violate check constraint'
      );

      // 2. Concurrent requests sharing the same wallet across separate DB connections
      const walletKey = 'wallet:0x1111222233334444555566667777888899990001';
      const now1 = new Date();

      const [resW1, resW2] = await Promise.all([
        repoA.checkAndRecord([{ key: walletKey, target: 'wallet' }], now1),
        repoB.checkAndRecord([{ key: walletKey, target: 'wallet' }], now1),
      ]);

      const allowedW = [resW1, resW2].filter((r) => r.allowed).length;
      const rejectedW = [resW1, resW2].filter((r) => !r.allowed && r.reason === 'cooldown').length;
      assert.equal(allowedW, 1, 'Exactly one concurrent wallet request must be allowed');
      assert.equal(rejectedW, 1, 'Second concurrent wallet request must be rejected with cooldown');

      // 3. Concurrent requests sharing the same email across separate DB connections
      const emailKey = 'email:shared-boundary@example.com';
      const now2 = new Date();

      const [resE1, resE2] = await Promise.all([
        repoA.checkAndRecord([{ key: emailKey, target: 'email' }], now2),
        repoB.checkAndRecord([{ key: emailKey, target: 'email' }], now2),
      ]);

      const allowedE = [resE1, resE2].filter((r) => r.allowed).length;
      const rejectedE = [resE1, resE2].filter((r) => !r.allowed && r.reason === 'cooldown').length;
      assert.equal(allowedE, 1, 'Exactly one concurrent email request must be allowed');
      assert.equal(rejectedE, 1, 'Second concurrent email request must be rejected with cooldown');

      // 4. Cross-boundary concurrency: Wallet A + Shared Email vs Wallet B + Shared Email
      // Deterministic alphabetical sorting prevents deadlocks (40P01)
      const now3 = new Date(Date.now() + 65_000); // Past cooldown
      const [resCrossA, resCrossB] = await Promise.all([
        repoA.checkAndRecord([
          { key: 'wallet:0xaaaa000000000000000000000000000000000001', target: 'wallet' },
          { key: 'email:cross-boundary@example.com', target: 'email' },
        ], now3),
        repoB.checkAndRecord([
          { key: 'wallet:0xbbbb000000000000000000000000000000000002', target: 'wallet' },
          { key: 'email:cross-boundary@example.com', target: 'email' },
        ], now3),
      ]);

      const allowedCross = [resCrossA, resCrossB].filter((r) => r.allowed).length;
      const rejectedCross = [resCrossA, resCrossB].filter((r) => !r.allowed).length;
      assert.equal(allowedCross, 1, 'Exactly one cross-boundary request must succeed');
      assert.equal(rejectedCross, 1, 'Second cross-boundary request must fail because shared email was consumed');

      // 5. Failure and rollback behavior: verify rejected wallet was NOT consumed
      const unconsumedWallet = resCrossA.allowed
        ? 'wallet:0xbbbb000000000000000000000000000000000002'
        : 'wallet:0xaaaa000000000000000000000000000000000001';
      const unconsumedStatus = await repoA.get(unconsumedWallet);
      assert.equal(unconsumedStatus, null, 'Rejected transaction must roll back completely without persisting partial state');

      // 6. Hourly limit enforcement under concurrency
      const hourlyKey = 'email:hourly-burst@example.com';
      let burstNow = new Date(Date.now() + 150_000);

      // Perform 5 allowed requests spaced 61s apart to fill the hourly window
      for (let i = 0; i < 5; i++) {
        burstNow = new Date(burstNow.getTime() + 61_000);
        const burstRes = await repoA.checkAndRecord([{ key: hourlyKey, target: 'email' }], burstNow);
        assert.equal(burstRes.allowed, true, `Request #${i + 1} within window must succeed`);
      }

      // 6th request within the same hour must be rejected across both connections
      burstNow = new Date(burstNow.getTime() + 61_000);
      const res6A = await repoA.checkAndRecord([{ key: hourlyKey, target: 'email' }], burstNow);
      const res6B = await repoB.checkAndRecord([{ key: hourlyKey, target: 'email' }], burstNow);
      assert.equal(res6A.allowed, false);
      assert.equal(res6A.reason, 'hourly_limit');
      assert.equal(res6B.allowed, false);
      assert.equal(res6B.reason, 'hourly_limit');

      // 7. Persistence and visibility across independent connections
      const recordOnA = await repoA.get(hourlyKey);
      const recordOnB = await repoB.get(hourlyKey);
      assert.ok(recordOnA);
      assert.ok(recordOnB);
      assert.equal(recordOnA.requestCount, 5);
      assert.equal(recordOnB.requestCount, 5);

      // 8. Overlapping 3-way concurrent transactions: [K1, K2], [K2, K3], [K3, K1]
      // Deterministic sorted locking must prevent circular deadlocks (40P01)
      const now4 = new Date(Date.now() + 300_000);
      const k1 = 'email:overlap-alpha@example.com';
      const k2 = 'email:overlap-beta@example.com';
      const k3 = 'wallet:0xcccc000000000000000000000000000000000003';

      const [resOver1, resOver2, resOver3] = await Promise.all([
        repoA.checkAndRecord([{ key: k1, target: 'email' }, { key: k2, target: 'email' }], now4),
        repoB.checkAndRecord([{ key: k2, target: 'email' }, { key: k3, target: 'wallet' }], now4),
        repoA.checkAndRecord([{ key: k3, target: 'wallet' }, { key: k1, target: 'email' }], now4),
      ]);

      const allowedOverlap = [resOver1, resOver2, resOver3].filter((r) => r.allowed).length;
      assert.equal(allowedOverlap, 1, 'Exactly one overlapping transaction can win the contested keys');

      // 9. Database connection failure fails closed with OtpRateLimitPersistenceError
      const disconnectedRepo = new DrizzleOtpRateLimitRepository(null);
      await assert.rejects(
        async () => {
          await disconnectedRepo.checkAndRecord([{ key: 'email:failclosed@example.com', target: 'email' }], new Date());
        },
        /Database connection unavailable/,
        'Disconnected repository must fail closed'
      );

      // 10. Clean reset
      await repoA.reset(hourlyKey);
      const afterReset = await repoB.get(hourlyKey);
      assert.equal(afterReset, null);
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });
});
