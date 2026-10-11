/**
 * SYNQ — Hard Isolation Safeguards for PostgreSQL Integration Tests (B.12.3.12)
 *
 * Enforces strict environment boundaries to prevent any accidental connection
 * to staging or production PostgreSQL databases, remote database hosts,
 * real SMTP servers, or live RPC nodes.
 */

import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { closeDb } from '../../src/db';

export interface TestIsolationConfig {
  sanitizedUrl: string;
  dbName: string;
  host: string;
  port: number;
}

// Strictly loopback hosts — remote or wildcard hosts are forbidden
const APPROVED_LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

const FORBIDDEN_DB_NAMES = new Set([
  'synq',
  'synq_prod',
  'synq_production',
  'production',
  'prod',
  'main',
  'master',
  'synq_staging',
  'staging',
  'defaultdb',
  'postgres', // Standard default postgres database is rejected to force a dedicated disposable database
]);

const FORBIDDEN_HOST_PATTERNS = [
  /supabase/i,
  /neon\.tech/i,
  /amazonaws\.com/i,
  /rds/i,
  /azure/i,
  /render\.com/i,
  /railway\.app/i,
  /cloud/i,
  /pooler/i,
];

/**
 * Sanitizes a PostgreSQL connection URL by masking password credentials.
 */
export function sanitizeConnectionString(rawUrl?: string): string {
  if (!rawUrl) return '[MISSING]';
  try {
    const url = new URL(rawUrl);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '[INVALID_URL_FORMAT]';
  }
}

/**
 * Validates and enforces hard isolation safeguards for test database access.
 * Throws an explicit, descriptive error if any safeguard is violated.
 */
export function assertTestDatabaseIsolation(rawUrl?: string): TestIsolationConfig {
  // 1. Reject production mode unconditionally
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[TestIsolation] NODE_ENV is set to "production". Integration tests are strictly forbidden in production mode.',
    );
  }

  // 2. Require explicit RUN_POSTGRES_INTEGRATION=true
  if (process.env.RUN_POSTGRES_INTEGRATION !== 'true') {
    throw new Error(
      '[TestIsolation] RUN_POSTGRES_INTEGRATION is not "true". Integration tests will not execute without explicit user activation.',
    );
  }

  // 3. Reject missing test database URL
  const testUrl = rawUrl || process.env.TEST_DATABASE_URL;
  if (!testUrl || testUrl.trim() === '') {
    throw new Error(
      '[TestIsolation] TEST_DATABASE_URL is missing. Integration tests require an explicit disposable database URL (e.g. postgresql://postgres:postgres@127.0.0.1:5433/synq_test_disposable).',
    );
  }

  // 4. Never fall back to or match normal production DATABASE_URL
  const appDbUrl = process.env.DATABASE_URL;
  if (appDbUrl && testUrl === appDbUrl) {
    if (!testUrl.includes('test') && !testUrl.includes('disposable')) {
      throw new Error(
        '[TestIsolation] TEST_DATABASE_URL matches DATABASE_URL which is not an explicit disposable test database. Fallback to production DATABASE_URL is strictly forbidden.',
      );
    }
  }

  // 5. Parse connection URL
  let parsed: URL;
  try {
    parsed = new URL(testUrl);
  } catch (err: any) {
    throw new Error(
      `[TestIsolation] Failed to parse TEST_DATABASE_URL format: ${err?.message || 'Invalid URL'}`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? parseInt(parsed.port, 10) : 5432;
  const dbName = parsed.pathname.replace(/^\//, '').toLowerCase();

  // 6. Host check: strictly loopback only. Zero remote host allowance.
  for (const pattern of FORBIDDEN_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new Error(
        `[TestIsolation] Database host "${host}" matches remote cloud pattern ${pattern}. Remote cloud databases are strictly forbidden.`,
      );
    }
  }

  if (!APPROVED_LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `[TestIsolation] Database host "${host}" is not loopback. Integration tests are strictly restricted to local loopback hosts (${Array.from(APPROVED_LOOPBACK_HOSTS).join(', ')}). Remote hosts and overrides are strictly prohibited.`,
    );
  }

  // 7. Database name check: must indicate disposable test and never production/staging/default
  if (FORBIDDEN_DB_NAMES.has(dbName)) {
    throw new Error(
      `[TestIsolation] Database name "${dbName}" is a forbidden production, staging, or default database name. A dedicated disposable database must be used.`,
    );
  }

  const isTestDbName =
    dbName.includes('test') || dbName.includes('disposable') || dbName.includes('tmp');
  if (!isTestDbName) {
    throw new Error(
      `[TestIsolation] Database name "${dbName}" must contain "test", "disposable", or "tmp" to ensure it is disposable.`,
    );
  }

  // 8. Enforce mock mode for external services in test environment
  process.env.SMTP_MOCK = 'true';
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = '9999';
  process.env.ENABLE_CHAIN_SCANNER = 'false';
  process.env.CRON_SECRET = '';
  process.env.ETH_RPC_URL = 'http://127.0.0.1:8545/mock';
  process.env.SYNQ_OFFLINE_TEST = 'true';

  return {
    sanitizedUrl: sanitizeConnectionString(testUrl),
    dbName,
    host,
    port,
  };
}

/**
 * Checks whether PostgreSQL integration testing is explicitly enabled by the user.
 * During offline audit/regression runs, this returns false so the suite skips real DB calls.
 */
export function isPostgresIntegrationEnabled(): boolean {
  if (process.env.RUN_POSTGRES_INTEGRATION !== 'true') {
    return false;
  }
  return Boolean(process.env.TEST_DATABASE_URL);
}

export async function configureTestDatabaseEnvironment(
  rawUrl?: string,
  targetSchema?: string,
): Promise<TestIsolationConfig> {
  const config = assertTestDatabaseIsolation(rawUrl);
  let testUrl = rawUrl || process.env.TEST_DATABASE_URL!;

  // If a dedicated isolated schema is requested, inject search_path into the connection URL
  // so that all pooled connections in Drizzle and raw clients default to that schema.
  if (targetSchema) {
    const urlObj = new URL(testUrl);
    urlObj.searchParams.set('search_path', `${targetSchema},public`);
    testUrl = urlObj.toString();
  }

  // Close any existing database client cache
  await closeDb();

  // Explicitly point application Drizzle repositories to the validated test database
  process.env.DATABASE_URL = testUrl;

  return config;
}

/**
 * Applies a contiguous slice of SQL migrations from _journal.json sequentially.
 * Used for isolated schema migration testing (Scenario 1 clean install and Scenario 2 upgrade).
 */
export async function applyMigrationFiles(
  sqlClient: postgres.Sql,
  fromIdx: number,
  toIdx: number,
  targetSchema?: string,
): Promise<{ appliedCount: number; appliedTags: string[] }> {
  const migrationsDir = path.resolve(__dirname, '../../src/db/migrations');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');

  if (!fs.existsSync(journalPath)) {
    throw new Error(`[TestIsolation] Migration journal not found at ${journalPath}`);
  }

  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  const entries: { idx: number; tag: string }[] = journal.entries;

  const runner = await sqlClient.reserve();
  try {
    const schemaPrefix = targetSchema ? `"${targetSchema}".` : '';
    if (targetSchema) {
      await runner.unsafe(`CREATE SCHEMA IF NOT EXISTS "${targetSchema}";`);
      await runner.unsafe(`SET search_path TO "${targetSchema}", public;`);
    }

    await runner.unsafe(`
      CREATE TABLE IF NOT EXISTS ${schemaPrefix}"__synq_test_migrations" (
        idx integer PRIMARY KEY,
        tag text NOT NULL,
        applied_at timestamp with time zone DEFAULT now() NOT NULL
      );
    `);

    const appliedRows = await runner.unsafe(`SELECT idx FROM ${schemaPrefix}"__synq_test_migrations";`);
    const alreadyApplied = new Set<number>(appliedRows.map((r: any) => r.idx));

    const appliedTags: string[] = [];

    for (const entry of entries) {
      if (entry.idx < fromIdx || entry.idx > toIdx) continue;
      if (alreadyApplied.has(entry.idx)) continue;

      const sqlFilePath = path.join(migrationsDir, `${entry.tag}.sql`);
      if (!fs.existsSync(sqlFilePath)) {
        throw new Error(`[TestIsolation] Migration file missing: ${sqlFilePath}`);
      }

      const sqlContent = fs.readFileSync(sqlFilePath, 'utf8');
      // Split by Drizzle statement-breakpoint delimiter
      const statements = sqlContent
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        // Remap any legacy hardcoded "public". schema qualifiers to targetSchema so isolated schemas remain self-contained
        const stmt = targetSchema ? statement.replaceAll('"public".', `"${targetSchema}".`) : statement;
        try {
          await runner.unsafe(stmt);
        } catch (err: any) {
          console.error(`[applyMigrationFiles ERROR in ${entry.tag}]:`, err?.message, '\nStatement:', stmt.slice(0, 150));
          throw err;
        }
      }

      await runner.unsafe(`
        INSERT INTO ${schemaPrefix}"__synq_test_migrations" (idx, tag)
        VALUES (${entry.idx}, '${entry.tag}')
        ON CONFLICT (idx) DO NOTHING;
      `);

      appliedTags.push(entry.tag);
    }

    return {
      appliedCount: appliedTags.length,
      appliedTags,
    };
  } finally {
    try {
      await runner.unsafe('DISCARD ALL;');
    } catch {
      // Ignore discard error
    }
    runner.release();
  }
}
