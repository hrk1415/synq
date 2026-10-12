import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateDatabaseAccess,
  assertDatabaseAccessAllowed,
  assertStorageAccessAllowed,
  sanitizeDatabaseUrl,
  extractDatabaseIdentity,
  extractJwtProjectRef,
  isIntentionalProductionAuthorized,
  isIntentionalDevAuthorized,
  PROTECTED_SUPABASE_PROJECT_REFS,
  APPROVED_LOCAL_HOSTS,
} from '../src/db/guard';
import { getDb, closeDb } from '../src/db';

/**
 * Creates a synthetic mock JWT for offline testing without real credentials.
 */
function createMockJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from('mock_signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

describe('SYNQ — B.12.3.33.2 Final Environment Authorization Guard Test Suite', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    await closeDb();
    process.env = { ...originalEnv };
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    delete process.env.SYNQ_ENVIRONMENT;
    delete process.env.SYNQ_AUTHORIZED_PRODUCTION_PROJECT_REF;
    delete process.env.SYNQ_AUTHORIZED_DEV_PROJECT_REF;
    delete process.env.SYNQ_APPROVED_STAGING_PROJECT_REF;
    delete process.env.SYNQ_APPROVED_STAGING_TARGET;
    delete process.env.SYNQ_APPROVED_STAGING_HOST;
    delete process.env.SYNQ_APPROVED_STAGING_DB_NAME;
    delete process.env.ALLOW_REMOTE_DEV_DATABASE;
    delete process.env.SYNQ_STAGING_DATABASE_APPROVED;
    delete process.env.SYNQ_FORCE_LOCAL_GUARD;
  });

  afterEach(async () => {
    await closeDb();
    process.env = { ...originalEnv };
  });

  // =========================================================================
  // Section 1: Protection of Existing Supabase Project in Local Dev
  // =========================================================================
  describe('1. Protection of Existing Supabase Project (chzpqxgrkspmqwmqphpd)', () => {
    const protectedUrls = [
      'postgresql://postgres.chzpqxgrkspmqwmqphpd:secret_pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres',
      'postgresql://postgres.chzpqxgrkspmqwmqphpd:secret_pw@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
      'postgres://postgres:secret_pw@db.chzpqxgrkspmqwmqphpd.supabase.co:5432/postgres',
      'postgresql://postgres:secret_pw@db.chzpqxgrkspmqwmqphpd.supabase.co:5432/postgres',
      'postgresql://postgres:secret_pw@CHZPQXGRKSPMQWMQPHPD.supabase.co:5432/postgres',
    ];

    for (const url of protectedUrls) {
      it(`Blocks access to protected project: ${sanitizeDatabaseUrl(url)}`, () => {
        const evalResult = evaluateDatabaseAccess(url);
        assert.equal(evalResult.allowed, false);
        assert.equal(evalResult.reason, 'PROTECTED_PROJECT_BLOCKED');
        assert.equal(evalResult.isProtectedProject, true);

        assert.throws(
          () => assertDatabaseAccessAllowed(url),
          /BLOCKED: DATABASE_URL targets protected live Alpha Supabase project \(chzpqxgrkspmqwmqphpd\)/,
        );
      });
    }

    it('Blocks protected project even if ALLOW_REMOTE_DEV_DATABASE is true', () => {
      process.env.ALLOW_REMOTE_DEV_DATABASE = 'true';
      const url = 'postgresql://postgres.chzpqxgrkspmqwmqphpd:secret_pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres';

      const evalResult = evaluateDatabaseAccess(url);
      assert.equal(evalResult.allowed, false);
      assert.equal(evalResult.reason, 'PROTECTED_PROJECT_BLOCKED');

      assert.throws(
        () => assertDatabaseAccessAllowed(url),
        /BLOCKED: DATABASE_URL targets protected live Alpha Supabase project/,
      );
    });

    it('Blocks protected project even if SYNQ_STAGING_DATABASE_APPROVED is true', () => {
      process.env.SYNQ_STAGING_DATABASE_APPROVED = 'true';
      const url = 'postgres://postgres:secret_pw@db.chzpqxgrkspmqwmqphpd.supabase.co:5432/postgres';

      const evalResult = evaluateDatabaseAccess(url);
      assert.equal(evalResult.allowed, false);
      assert.equal(evalResult.reason, 'PROTECTED_PROJECT_BLOCKED');

      assert.throws(
        () => assertDatabaseAccessAllowed(url),
        /BLOCKED: DATABASE_URL targets protected live Alpha Supabase project/,
      );
    });
  });

  // =========================================================================
  // Section 2: Intentional Production Authorization (No Fingerprints)
  // =========================================================================
  describe('2. Intentional Production Authorization Model', () => {
    const liveUrl = 'postgresql://postgres.chzpqxgrkspmqwmqphpd:secret_pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres';

    it('Blocks access when Vercel environment variables are present without intentional deployment config', () => {
      const vercelOnlyEnv = {
        VERCEL: '1',
        VERCEL_ENV: 'production',
        VERCEL_REGION: 'iad1',
        VERCEL_URL: 'synq-alpha.vercel.app',
      };

      const result = evaluateDatabaseAccess(liveUrl, { overrideEnv: vercelOnlyEnv });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'PROTECTED_PROJECT_BLOCKED');
      assert.equal(result.isProductionAuthorized, false);

      assert.throws(
        () => assertDatabaseAccessAllowed(liveUrl, { overrideEnv: vercelOnlyEnv }),
        /BLOCKED: DATABASE_URL targets protected live Alpha Supabase project/,
      );
    });

    it('Blocks local development copying a .env.local file (NODE_ENV=development or missing prod flags)', () => {
      // Ordinary local dev running next dev or scripts with copied .env.local
      const localDevEnv = {
        NODE_ENV: 'development',
        DATABASE_URL: liveUrl,
      };

      const result = evaluateDatabaseAccess(liveUrl, { overrideEnv: localDevEnv });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'PROTECTED_PROJECT_BLOCKED');
      assert.equal(result.isProductionAuthorized, false);
    });

    it('Blocks if SYNQ_ENVIRONMENT=production but SYNQ_AUTHORIZED_PRODUCTION_PROJECT_REF is missing', () => {
      const partialEnv = {
        NODE_ENV: 'production',
        SYNQ_ENVIRONMENT: 'production',
      };

      const result = evaluateDatabaseAccess(liveUrl, { overrideEnv: partialEnv });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'PROTECTED_PROJECT_BLOCKED');
    });

    it('Blocks if SYNQ_AUTHORIZED_PRODUCTION_PROJECT_REF does not match the target project', () => {
      const mismatchedProdEnv = {
        NODE_ENV: 'production',
        SYNQ_ENVIRONMENT: 'production',
        SYNQ_AUTHORIZED_PRODUCTION_PROJECT_REF: 'some_other_project',
      };

      const result = evaluateDatabaseAccess(liveUrl, { overrideEnv: mismatchedProdEnv });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'PROTECTED_PROJECT_BLOCKED');
    });

    it('Blocks if SYNQ_FORCE_LOCAL_GUARD=true even with all production flags set', () => {
      const forceGuardEnv = {
        NODE_ENV: 'production',
        SYNQ_ENVIRONMENT: 'production',
        SYNQ_AUTHORIZED_PRODUCTION_PROJECT_REF: 'chzpqxgrkspmqwmqphpd',
        SYNQ_FORCE_LOCAL_GUARD: 'true',
      };

      const result = evaluateDatabaseAccess(liveUrl, { overrideEnv: forceGuardEnv });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'PROTECTED_PROJECT_BLOCKED');
    });

    it('Allows production access when all intentional deployment configuration flags are present', () => {
      const authorizedProdEnv = {
        NODE_ENV: 'production',
        SYNQ_ENVIRONMENT: 'production',
        SYNQ_AUTHORIZED_PRODUCTION_PROJECT_REF: 'chzpqxgrkspmqwmqphpd',
      };

      const result = evaluateDatabaseAccess(liveUrl, { overrideEnv: authorizedProdEnv });
      assert.equal(result.allowed, true);
      assert.equal(result.reason, 'PRODUCTION_DEPLOYMENT_AUTHORIZED');
      assert.equal(result.isProductionAuthorized, true);

      assert.doesNotThrow(() => assertDatabaseAccessAllowed(liveUrl, { overrideEnv: authorizedProdEnv }));
    });
  });

  // =========================================================================
  // Section 3: Supabase Staging Authorization (Exact Project Ref)
  // =========================================================================
  describe('3. Supabase Staging Authorization Rules', () => {
    it('Authorizes exact staging project via SYNQ_APPROVED_STAGING_PROJECT_REF', () => {
      const stagingEnv = {
        SYNQ_APPROVED_STAGING_PROJECT_REF: 'xyz123staging',
      };

      const stagingPoolerUrl = 'postgresql://postgres.xyz123staging:pass@aws-0-staging.pooler.supabase.com:5432/postgres';
      const evalResult = evaluateDatabaseAccess(stagingPoolerUrl, { overrideEnv: stagingEnv });

      assert.equal(evalResult.allowed, true);
      assert.equal(evalResult.reason, 'EXPLICIT_REMOTE_STAGING_ALLOWED');
      assert.doesNotThrow(() => assertDatabaseAccessAllowed(stagingPoolerUrl, { overrideEnv: stagingEnv }));
    });

    it('Rejects treating a shared Supabase pooler hostname alone as proof of an approved database', () => {
      const invalidStagingEnv = {
        SYNQ_APPROVED_STAGING_HOST: 'aws-0-ap-northeast-1.pooler.supabase.com',
      };

      const poolerUrl = 'postgresql://postgres.stagingtest:pass@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres';
      const evalResult = evaluateDatabaseAccess(poolerUrl, { overrideEnv: invalidStagingEnv });

      assert.equal(evalResult.allowed, false);
      assert.equal(evalResult.reason, 'POOLER_HOST_STAGING_DISALLOWED');

      assert.throws(
        () => assertDatabaseAccessAllowed(poolerUrl, { overrideEnv: invalidStagingEnv }),
        /Shared Supabase pooler hostnames cannot be authorized via host-only configuration/,
      );
    });

    it('Rejects configuring the protected live project ref as an approved staging target', () => {
      const maliciousStagingEnv = {
        SYNQ_APPROVED_STAGING_PROJECT_REF: 'chzpqxgrkspmqwmqphpd',
      };

      const poolerUrl = 'postgresql://postgres.chzpqxgrkspmqwmqphpd:pass@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres';
      const evalResult = evaluateDatabaseAccess(poolerUrl, { overrideEnv: maliciousStagingEnv });

      assert.equal(evalResult.allowed, false);
      assert.equal(evalResult.reason, 'PROTECTED_STAGING_TARGET_FORBIDDEN');

      assert.throws(
        () => assertDatabaseAccessAllowed(poolerUrl, { overrideEnv: maliciousStagingEnv }),
        /The approved staging target cannot be configured as the protected live Alpha project/,
      );
    });

    it('Fails closed when remote Supabase project does not match the approved staging project ref', () => {
      const stagingEnv = {
        SYNQ_APPROVED_STAGING_PROJECT_REF: 'xyz123staging',
      };

      const mismatchUrl = 'postgresql://postgres.unapprovedproject:pass@aws-0-staging.pooler.supabase.com:5432/postgres';
      const evalResult = evaluateDatabaseAccess(mismatchUrl, { overrideEnv: stagingEnv });

      assert.equal(evalResult.allowed, false);
      assert.equal(evalResult.reason, 'REMOTE_DATABASE_FAIL_CLOSED');

      assert.throws(
        () => assertDatabaseAccessAllowed(mismatchUrl, { overrideEnv: stagingEnv }),
        /BLOCKED: DATABASE_URL targets an unapproved remote database/,
      );
    });

    it('Fails closed when Supabase pooler connection omits project reference in username', () => {
      const poolerUrlWithoutRef = 'postgresql://postgres:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres';
      const evalResult = evaluateDatabaseAccess(poolerUrlWithoutRef);

      assert.equal(evalResult.allowed, false);
      assert.equal(evalResult.reason, 'DATABASE_IDENTITY_UNVERIFIABLE');

      assert.throws(
        () => assertDatabaseAccessAllowed(poolerUrlWithoutRef),
        /DATABASE_URL identity cannot be reliably established/,
      );
    });
  });

  // =========================================================================
  // Section 4: Non-Supabase PostgreSQL Staging Authorization
  // =========================================================================
  describe('4. Non-Supabase PostgreSQL Staging Authorization Rules', () => {
    it('Disallows broad hostname-only authorization without database name', () => {
      const broadHostEnv = {
        SYNQ_APPROVED_STAGING_HOST: 'staging-rds.synq.xyz',
      };

      const remoteUrl = 'postgresql://dbuser:pass@staging-rds.synq.xyz:5432/synq_staging';
      const evalResult = evaluateDatabaseAccess(remoteUrl, { overrideEnv: broadHostEnv });

      assert.equal(evalResult.allowed, false);
      assert.equal(evalResult.reason, 'INSUFFICIENTLY_SPECIFIC_STAGING_TARGET');

      assert.throws(
        () => assertDatabaseAccessAllowed(remoteUrl, { overrideEnv: broadHostEnv }),
        /Non-Supabase staging targets must be sufficiently specific and include both the host and database name/,
      );
    });

    it('Authorizes sufficiently specific staging target via SYNQ_APPROVED_STAGING_TARGET (host:port/dbname)', () => {
      const specificEnv = {
        SYNQ_APPROVED_STAGING_TARGET: 'staging-rds.synq.xyz:5432/synq_staging',
      };

      const remoteUrl = 'postgresql://dbuser:pass@staging-rds.synq.xyz:5432/synq_staging';
      const evalResult = evaluateDatabaseAccess(remoteUrl, { overrideEnv: specificEnv });

      assert.equal(evalResult.allowed, true);
      assert.equal(evalResult.reason, 'EXPLICIT_REMOTE_STAGING_ALLOWED');
      assert.doesNotThrow(() => assertDatabaseAccessAllowed(remoteUrl, { overrideEnv: specificEnv }));
    });

    it('Authorizes sufficiently specific staging target via SYNQ_APPROVED_STAGING_HOST and SYNQ_APPROVED_STAGING_DB_NAME', () => {
      const specificEnv = {
        SYNQ_APPROVED_STAGING_HOST: 'staging-rds.synq.xyz',
        SYNQ_APPROVED_STAGING_DB_NAME: 'synq_staging',
      };

      const remoteUrl = 'postgresql://dbuser:pass@staging-rds.synq.xyz:5432/synq_staging';
      const evalResult = evaluateDatabaseAccess(remoteUrl, { overrideEnv: specificEnv });

      assert.equal(evalResult.allowed, true);
      assert.equal(evalResult.reason, 'EXPLICIT_REMOTE_STAGING_ALLOWED');
      assert.doesNotThrow(() => assertDatabaseAccessAllowed(remoteUrl, { overrideEnv: specificEnv }));
    });

    it('Fails closed if database name on approved host does not match', () => {
      const specificEnv = {
        SYNQ_APPROVED_STAGING_HOST: 'staging-rds.synq.xyz',
        SYNQ_APPROVED_STAGING_DB_NAME: 'synq_staging',
      };

      const wrongDbUrl = 'postgresql://dbuser:pass@staging-rds.synq.xyz:5432/synq_production';
      const evalResult = evaluateDatabaseAccess(wrongDbUrl, { overrideEnv: specificEnv });

      assert.equal(evalResult.allowed, false);
      assert.equal(evalResult.reason, 'REMOTE_DATABASE_FAIL_CLOSED');
    });
  });

  // =========================================================================
  // Section 5: Unknown Remote Database Targets Fail Closed
  // =========================================================================
  describe('5. Unknown Remote Database Targets Fail Closed', () => {
    const unknownRemoteUrls = [
      'postgresql://postgres:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres',
      'postgres://other_user:pass@ep-cool-cloud.us-east-2.aws.neon.tech/neondb',
      'postgres://admin:pass@remote-rds.amazonaws.com:5432/synq',
      'postgresql://db_user:secret@192.168.1.100:5432/synq',
      'postgresql://user:pass@db.example.org:5432/somedb',
    ];

    for (const url of unknownRemoteUrls) {
      it(`Fails closed for unapproved remote database: ${sanitizeDatabaseUrl(url)}`, () => {
        const evalResult = evaluateDatabaseAccess(url);
        assert.equal(evalResult.allowed, false);
        assert.equal(evalResult.isLocal, false);

        assert.throws(
          () => assertDatabaseAccessAllowed(url),
          /BLOCKED: DATABASE_URL targets an unapproved remote database|DATABASE_URL identity cannot be reliably established/,
        );
      });
    }

    it('Disallows generic boolean flags alone without an exact staging target', () => {
      const genericEnv = { ALLOW_REMOTE_DEV_DATABASE: 'true' };
      const remoteUrl = 'postgresql://staging_user:pass@staging-db.synq.xyz:5432/synq_staging';

      const evalResult = evaluateDatabaseAccess(remoteUrl, { overrideEnv: genericEnv });
      assert.equal(evalResult.allowed, false);
      assert.equal(evalResult.reason, 'GENERIC_BOOLEAN_STAGING_DISALLOWED');

      assert.throws(
        () => assertDatabaseAccessAllowed(remoteUrl, { overrideEnv: genericEnv }),
        /Generic boolean remote database flags .* are disabled/,
      );
    });
  });

  // =========================================================================
  // Section 6: Approved Local Disposable Databases Continue Working
  // =========================================================================
  describe('6. Approved Local Disposable Databases Continue Working', () => {
    const localUrls = [
      'postgresql://postgres:postgres@127.0.0.1:5432/synq_dev',
      'postgresql://postgres:postgres@127.0.0.1:5433/synq_test_disposable',
      'postgres://postgres:postgres@localhost:5432/synq_local',
      'postgresql://postgres:postgres@localhost:5433/synq_test',
      'postgres://user:pass@[::1]:5432/synq_dev',
      'postgres://postgres:postgres@0.0.0.0:5432/synq_dev',
      'postgres://postgres:postgres@host.docker.internal:5432/synq_dev',
    ];

    for (const url of localUrls) {
      it(`Allows local connection: ${sanitizeDatabaseUrl(url)}`, () => {
        const evalResult = evaluateDatabaseAccess(url);
        assert.equal(evalResult.allowed, true);
        assert.equal(evalResult.reason, 'LOCAL_DATABASE_ALLOWED');
        assert.equal(evalResult.isLocal, true);
        assert.doesNotThrow(() => assertDatabaseAccessAllowed(url));
      });
    }
  });

  // =========================================================================
  // Section 7: Missing or Malformed Database Configuration Fails Closed
  // =========================================================================
  describe('7. Missing or Malformed Database Configuration Fails Closed', () => {
    it('Fails closed on missing or undefined DATABASE_URL', () => {
      const evalResult = evaluateDatabaseAccess(undefined);
      assert.equal(evalResult.allowed, false);
      assert.equal(evalResult.reason, 'DATABASE_URL_MISSING');

      assert.throws(
        () => assertDatabaseAccessAllowed(undefined),
        /DATABASE_URL environment variable is missing or empty/,
      );
    });

    it('Fails closed on empty string DATABASE_URL', () => {
      const evalResult = evaluateDatabaseAccess('   ');
      assert.equal(evalResult.allowed, false);
      assert.equal(evalResult.reason, 'DATABASE_URL_MISSING');

      assert.throws(
        () => assertDatabaseAccessAllowed('   '),
        /DATABASE_URL environment variable is missing or empty/,
      );
    });

    it('Fails closed on malformed non-PostgreSQL protocols', () => {
      const nonPgUrls = [
        'not-a-url',
        'http://db.chzpqxgrkspmqwmqphpd.supabase.co',
        'mysql://root:secret@127.0.0.1:3306/db',
        'sqlite:///path/to/db.sqlite',
      ];

      for (const bad of nonPgUrls) {
        const evalResult = evaluateDatabaseAccess(bad);
        assert.equal(evalResult.allowed, false);
        assert.equal(evalResult.reason, 'DATABASE_URL_MALFORMED');

        assert.throws(
          () => assertDatabaseAccessAllowed(bad),
          /DATABASE_URL format is malformed or invalid/,
        );
      }
    });

    it('Detects and blocks URL-encoded project references in username or URL', () => {
      const encodedUrl = 'postgresql://postgres%2Echzpqxgrkspmqwmqphpd:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres';

      assert.throws(
        () => assertDatabaseAccessAllowed(encodedUrl),
        /BLOCKED: DATABASE_URL targets protected live Alpha Supabase project/,
      );
    });
  });

  // =========================================================================
  // Section 8: Credential Sanitization
  // =========================================================================
  describe('8. Credential Sanitization (Passwords Never Logged)', () => {
    it('Strips passwords and tokens in sanitizeDatabaseUrl', () => {
      const sensitive = 'postgresql://postgres.chzpqxgrkspmqwmqphpd:TOP_SECRET_PW_999@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?apikey=SECRET_KEY';
      const sanitized = sanitizeDatabaseUrl(sensitive);

      assert.ok(!sanitized.includes('TOP_SECRET_PW_999'), 'Must not contain plaintext password');
      assert.ok(!sanitized.includes('SECRET_KEY'), 'Must not contain apikey query param');
      assert.ok(sanitized.includes('***@'), 'Must mask user password with ***@');
    });

    it('extractJwtProjectRef returns null safely on garbage without throwing or logging', () => {
      assert.equal(extractJwtProjectRef(undefined), null);
      assert.equal(extractJwtProjectRef(''), null);
      assert.equal(extractJwtProjectRef('not.a.jwt'), null);
      assert.equal(extractJwtProjectRef('bad'), null);
    });
  });

  // =========================================================================
  // Section 9: Supabase Storage & Credential Isolation
  // =========================================================================
  describe('9. Supabase Storage & Credential Isolation', () => {
    it('Blocks local access when SUPABASE_URL targets protected project', () => {
      const protectedUrl = 'https://chzpqxgrkspmqwmqphpd.supabase.co';
      assert.throws(
        () => assertStorageAccessAllowed(protectedUrl),
        /BLOCKED: SUPABASE_URL or service key targets protected live Alpha Supabase storage \(chzpqxgrkspmqwmqphpd\)/,
      );
    });

    it('Blocks local access when service role key JWT belongs to protected project', () => {
      const mockProtectedKey = createMockJwt({ ref: 'chzpqxgrkspmqwmqphpd', role: 'service_role' });
      const stagingUrl = 'https://some-isolated-staging.supabase.co';

      assert.throws(
        () => assertStorageAccessAllowed(stagingUrl, mockProtectedKey),
        /BLOCKED: SUPABASE_URL or service key targets protected live Alpha Supabase storage/,
      );
    });

    it('Blocks storage operation when project URL and key credential project mismatch', () => {
      const stagingKey = createMockJwt({ ref: 'project_alpha', role: 'service_role' });
      const stagingUrl = 'https://project_beta.supabase.co';

      assert.throws(
        () => assertStorageAccessAllowed(stagingUrl, stagingKey),
        /BLOCKED: Mismatch between SUPABASE_URL project \(project_beta\) and service role key credential project \(project_alpha\)/,
      );
    });

    it('Allows local loopback storage (emulator)', () => {
      const localEmulatorUrl = 'http://127.0.0.1:54321';
      assert.doesNotThrow(() => assertStorageAccessAllowed(localEmulatorUrl));
    });

    it('Fails closed on unapproved remote storage URL', () => {
      const unapprovedRemote = 'https://unapproved-project.supabase.co';
      assert.throws(
        () => assertStorageAccessAllowed(unapprovedRemote),
        /BLOCKED: SUPABASE_URL targets an unapproved remote storage project/,
      );
    });

    it('Allows approved staging storage when matching SYNQ_APPROVED_STAGING_PROJECT_REF', () => {
      const stagingEnv = {
        SYNQ_APPROVED_STAGING_PROJECT_REF: 'staging123',
      };
      const stagingKey = createMockJwt({ ref: 'staging123', role: 'service_role' });
      const stagingUrl = 'https://staging123.supabase.co';

      assert.doesNotThrow(() =>
        assertStorageAccessAllowed(stagingUrl, stagingKey, { overrideEnv: stagingEnv }),
      );
    });

    it('Allows storage in production when intentional deployment flags are configured', () => {
      const prodEnv = {
        NODE_ENV: 'production',
        SYNQ_ENVIRONMENT: 'production',
        SYNQ_AUTHORIZED_PRODUCTION_PROJECT_REF: 'chzpqxgrkspmqwmqphpd',
      };
      const protectedUrl = 'https://chzpqxgrkspmqwmqphpd.supabase.co';
      const liveKey = createMockJwt({ ref: 'chzpqxgrkspmqwmqphpd', role: 'service_role' });

      assert.doesNotThrow(() =>
        assertStorageAccessAllowed(protectedUrl, liveKey, { overrideEnv: prodEnv }),
      );
    });
  });

  // =========================================================================
  // Section 10: Application Database Client Integration (getDb)
  // =========================================================================
  describe('10. Application Database Client Integration (getDb)', () => {
    it('Throws when getDb() is called with DATABASE_URL targeting protected Supabase project in local dev', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres.chzpqxgrkspmqwmqphpd:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres';

      assert.throws(
        () => getDb(),
        /BLOCKED: DATABASE_URL targets protected live Alpha Supabase project \(chzpqxgrkspmqwmqphpd\)/,
      );
    });

    it('Throws when getDb() is called with unapproved remote DATABASE_URL', async () => {
      process.env.DATABASE_URL = 'postgresql://postgres:secret@unapproved-remote-db.org:5432/synq';

      assert.throws(
        () => getDb(),
        /BLOCKED: DATABASE_URL targets an unapproved remote database/,
      );
    });

    it('Throws when getDb() is called with missing DATABASE_URL', async () => {
      delete process.env.DATABASE_URL;

      assert.throws(
        () => getDb(),
        /DATABASE_URL environment variable is missing or empty/,
      );
    });
  });

  // =========================================================================
  // Section 11: Local Development Authorization (SYNQ_AUTHORIZED_DEV_PROJECT_REF)
  // =========================================================================
  describe('11. Local Development Authorization for Original Supabase', () => {
    const livePoolerUrl = 'postgresql://postgres.chzpqxgrkspmqwmqphpd:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres';
    const liveStorageUrl = 'https://chzpqxgrkspmqwmqphpd.supabase.co';
    const liveKey = createMockJwt({ ref: 'chzpqxgrkspmqwmqphpd', role: 'service_role' });

    it('Allows application database operations when SYNQ_AUTHORIZED_DEV_PROJECT_REF matches chzpqxgrkspmqwmqphpd', () => {
      const devEnv = {
        SYNQ_AUTHORIZED_DEV_PROJECT_REF: 'chzpqxgrkspmqwmqphpd',
      };

      const result = evaluateDatabaseAccess(livePoolerUrl, {
        operation: 'application',
        overrideEnv: devEnv,
      });

      assert.equal(result.allowed, true);
      assert.equal(result.reason, 'EXPLICIT_DEV_APPLICATION_ALLOWED');
      assert.equal(result.detectedProjectRef, 'chzpqxgrkspmqwmqphpd');
      assert.doesNotThrow(() =>
        assertDatabaseAccessAllowed(livePoolerUrl, {
          operation: 'application',
          overrideEnv: devEnv,
        }),
      );
    });

    it('Blocks database operations when SYNQ_AUTHORIZED_DEV_PROJECT_REF mismatches target project', () => {
      const devEnv = {
        SYNQ_AUTHORIZED_DEV_PROJECT_REF: 'some_other_project',
      };

      const result = evaluateDatabaseAccess(livePoolerUrl, {
        operation: 'application',
        overrideEnv: devEnv,
      });

      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'PROTECTED_PROJECT_BLOCKED');
      assert.throws(
        () =>
          assertDatabaseAccessAllowed(livePoolerUrl, {
            operation: 'application',
            overrideEnv: devEnv,
          }),
        /BLOCKED: DATABASE_URL targets protected live Alpha Supabase project/,
      );
    });

    it('Rejects configuring an unapproved arbitrary project in SYNQ_AUTHORIZED_DEV_PROJECT_REF', () => {
      const devEnv = {
        SYNQ_AUTHORIZED_DEV_PROJECT_REF: 'unapproved_remote_project',
      };
      const unapprovedUrl = 'postgresql://postgres.unapproved_remote_project:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres';

      const result = evaluateDatabaseAccess(unapprovedUrl, {
        operation: 'application',
        overrideEnv: devEnv,
      });

      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'REMOTE_DATABASE_FAIL_CLOSED');
      assert.throws(
        () =>
          assertDatabaseAccessAllowed(unapprovedUrl, {
            operation: 'application',
            overrideEnv: devEnv,
          }),
        /BLOCKED: DATABASE_URL targets an unapproved remote database/,
      );
    });

    it('Strictly blocks migrations (operation: migration) even when SYNQ_AUTHORIZED_DEV_PROJECT_REF matches', () => {
      const devEnv = {
        SYNQ_AUTHORIZED_DEV_PROJECT_REF: 'chzpqxgrkspmqwmqphpd',
      };

      const result = evaluateDatabaseAccess(livePoolerUrl, {
        operation: 'migration',
        overrideEnv: devEnv,
      });

      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'PROTECTED_PROJECT_MIGRATION_BLOCKED');
      assert.throws(
        () =>
          assertDatabaseAccessAllowed(livePoolerUrl, {
            operation: 'migration',
            overrideEnv: devEnv,
          }),
        /BLOCKED: Migrations and DDL schema modifications against the original Supabase project/,
      );
    });

    it('Blocks maintenance scripts and workers even when SYNQ_AUTHORIZED_DEV_PROJECT_REF matches', () => {
      const devEnv = {
        SYNQ_AUTHORIZED_DEV_PROJECT_REF: 'chzpqxgrkspmqwmqphpd',
      };

      const scriptResult = evaluateDatabaseAccess(livePoolerUrl, {
        operation: 'script',
        overrideEnv: devEnv,
      });
      assert.equal(scriptResult.allowed, false);
      assert.equal(scriptResult.reason, 'PROTECTED_PROJECT_BLOCKED');

      const workerResult = evaluateDatabaseAccess(livePoolerUrl, {
        operation: 'worker',
        overrideEnv: devEnv,
      });
      assert.equal(workerResult.allowed, false);
      assert.equal(workerResult.reason, 'PROTECTED_PROJECT_BLOCKED');

      const unspecifiedResult = evaluateDatabaseAccess(livePoolerUrl, {
        overrideEnv: devEnv,
      });
      assert.equal(unspecifiedResult.allowed, false);
      assert.equal(unspecifiedResult.reason, 'PROTECTED_PROJECT_BLOCKED');
    });

    it('Blocks dev authorization when SYNQ_FORCE_LOCAL_GUARD=true', () => {
      const forceGuardEnv = {
        SYNQ_AUTHORIZED_DEV_PROJECT_REF: 'chzpqxgrkspmqwmqphpd',
        SYNQ_FORCE_LOCAL_GUARD: 'true',
      };

      const result = evaluateDatabaseAccess(livePoolerUrl, {
        operation: 'application',
        overrideEnv: forceGuardEnv,
      });

      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'PROTECTED_PROJECT_BLOCKED');
    });

    it('Allows Supabase Storage when SYNQ_AUTHORIZED_DEV_PROJECT_REF matches chzpqxgrkspmqwmqphpd with valid key', () => {
      const devEnv = {
        SYNQ_AUTHORIZED_DEV_PROJECT_REF: 'chzpqxgrkspmqwmqphpd',
      };

      assert.doesNotThrow(() =>
        assertStorageAccessAllowed(liveStorageUrl, liveKey, {
          operation: 'storage',
          overrideEnv: devEnv,
        }),
      );
    });

    it('Blocks Supabase Storage when key credential project ref mismatches URL project ref in dev mode', () => {
      const devEnv = {
        SYNQ_AUTHORIZED_DEV_PROJECT_REF: 'chzpqxgrkspmqwmqphpd',
      };
      const mismatchedKey = createMockJwt({ ref: 'some_other_project', role: 'service_role' });

      assert.throws(
        () =>
          assertStorageAccessAllowed(liveStorageUrl, mismatchedKey, {
            operation: 'storage',
            overrideEnv: devEnv,
          }),
        /BLOCKED: Mismatch between SUPABASE_URL project \(chzpqxgrkspmqwmqphpd\) and service role key credential project \(some_other_project\)/,
      );
    });

    it('Blocks Supabase Storage when SYNQ_AUTHORIZED_DEV_PROJECT_REF does not match target project', () => {
      const devEnv = {
        SYNQ_AUTHORIZED_DEV_PROJECT_REF: 'wrong_project',
      };

      assert.throws(
        () =>
          assertStorageAccessAllowed(liveStorageUrl, liveKey, {
            operation: 'storage',
            overrideEnv: devEnv,
          }),
        /BLOCKED: SUPABASE_URL or service key targets protected live Alpha Supabase storage/,
      );
    });
  });
});
