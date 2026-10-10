// test/SynqStagingSmtpSafety.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getMailStatus } from '../src/lib/notify';
import { checkStagingServices } from '../scripts/staging-services-check';
import { runStagingDevPreflight } from '../scripts/staging-dev';
import { loadStagingEnv, APPROVED_STAGING_PROJECT_REF } from '../src/lib/staging-env';
import { isStagingOtpConsoleAllowed, logStagingOtpIfAllowed } from '../src/lib/staging-otp';
import { assertDatabaseAccessAllowed, DatabaseAccessViolationError } from '../src/db/guard';

describe('SYNQ — B.12.3.53 Staging SMTP Activation Safety Suite', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset process.env to clean staging baseline before each test
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    process.env.SYNQ_ENV = 'staging';
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_SECURE;
    delete process.env.SMTP_FROM;
    delete process.env.SYNQ_STAGING_ALLOW_SMTP;
    delete process.env.SYNQ_STAGING_OTP_CONSOLE;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  // =========================================================================
  // 1. Default Staging State: Disabled & Log-Only
  // =========================================================================
  describe('1. Default Staging State', () => {
    it('SMTP is disabled by default and reports SYNQ_STAGING_ALLOW_SMTP as missing in staging', () => {
      const status = getMailStatus();
      assert.equal(status.live, false);
      assert.equal(status.mode, 'log');
      assert.ok(status.missing.includes('SYNQ_STAGING_ALLOW_SMTP'));
      assert.ok(status.missing.includes('SMTP_USER'));
      assert.ok(status.missing.includes('SMTP_PASS'));
    });

    it('checkStagingServices confirms safe log-only mode and unauthorized SMTP by default', () => {
      const report = checkStagingServices({
        overrideEnv: {
          SYNQ_STAGING_ALLOW_SMTP: 'false',
          SMTP_USER: '',
          SMTP_PASS: '',
        },
      });
      assert.equal(report.database.status, 'READY');
      assert.equal(report.email.mode, 'log');
      assert.equal(report.email.live, false);
      assert.equal(report.email.isSafeLogOnly, true);
      assert.equal(report.email.stagingSmtpAllowed, false);
      assert.equal(report.backgroundWorkers.allDisabledByDefault, true);
    });

    it('runStagingDevPreflight passes cleanly in default log-only state', () => {
      const result = runStagingDevPreflight();
      assert.equal(result, true);
    });
  });

  // =========================================================================
  // 2. Fail-Closed: Credentials Present Without Authorization
  // =========================================================================
  describe('2. Fail-Closed: Credentials Without Staging Authorization', () => {
    it('getMailStatus refuses live SMTP when credentials exist but SYNQ_STAGING_ALLOW_SMTP is absent', () => {
      process.env.SMTP_USER = 'staging-test@gmail.com';
      process.env.SMTP_PASS = 'abcd efgh ijkl mnop';
      delete process.env.SYNQ_STAGING_ALLOW_SMTP;

      const status = getMailStatus();
      assert.equal(status.live, false, 'live must be false without explicit staging authorization');
      assert.equal(status.mode, 'log');
      assert.ok(status.missing.includes('SYNQ_STAGING_ALLOW_SMTP'));
    });

    it('getMailStatus refuses live SMTP when SYNQ_STAGING_ALLOW_SMTP is explicitly false', () => {
      process.env.SMTP_USER = 'staging-test@gmail.com';
      process.env.SMTP_PASS = 'abcd efgh ijkl mnop';
      process.env.SYNQ_STAGING_ALLOW_SMTP = 'false';

      const status = getMailStatus();
      assert.equal(status.live, false);
      assert.equal(status.mode, 'log');
      assert.ok(status.missing.includes('SYNQ_STAGING_ALLOW_SMTP'));
    });

    it('checkStagingServices throws fail-closed error if SMTP credentials are set without authorization', () => {
      assert.throws(
        () => checkStagingServices({
          overrideEnv: {
            SMTP_USER: 'staging-test@gmail.com',
            SMTP_PASS: 'abcd efgh ijkl mnop',
            SYNQ_STAGING_ALLOW_SMTP: 'false',
          },
        }),
        /SMTP credentials are present in staging, but SYNQ_STAGING_ALLOW_SMTP is not set to "true"/,
      );
    });

    it('runStagingDevPreflight throws fail-closed error if SMTP credentials are set without authorization', () => {
      assert.throws(
        () => runStagingDevPreflight({
          overrideEnv: {
            SMTP_USER: 'staging-test@gmail.com',
            SMTP_PASS: 'abcd efgh ijkl mnop',
            SYNQ_STAGING_ALLOW_SMTP: 'false',
          },
        }),
        /SMTP credentials are present in staging, but SYNQ_STAGING_ALLOW_SMTP is not set to "true"/,
      );
    });
  });

  // =========================================================================
  // 3. Authorized Staging Without Credentials
  // =========================================================================
  describe('3. Authorized Staging Without Credentials', () => {
    it('getMailStatus remains in log-only mode when authorized but missing user/pass', () => {
      process.env.SYNQ_STAGING_ALLOW_SMTP = 'true';
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;

      const status = getMailStatus();
      assert.equal(status.live, false);
      assert.equal(status.mode, 'log');
      assert.ok(!status.missing.includes('SYNQ_STAGING_ALLOW_SMTP'));
      assert.ok(status.missing.includes('SMTP_USER'));
      assert.ok(status.missing.includes('SMTP_PASS'));
    });

    it('checkStagingServices does not throw when authorized but credentials pending', () => {
      const report = checkStagingServices({
        overrideEnv: {
          SYNQ_STAGING_ALLOW_SMTP: 'true',
          SMTP_USER: '',
          SMTP_PASS: '',
        },
      });
      assert.equal(report.email.live, false);
      assert.equal(report.email.mode, 'log');
      assert.equal(report.email.stagingSmtpAllowed, true);
    });
  });

  // =========================================================================
  // 4. Authorized Staging With Valid Credentials
  // =========================================================================
  describe('4. Authorized Staging With Valid Credentials', () => {
    it('getMailStatus becomes live when both authorized and fully configured for Gmail', () => {
      process.env.SYNQ_STAGING_ALLOW_SMTP = 'true';
      process.env.SMTP_USER = 'synq-staging-test@gmail.com';
      process.env.SMTP_PASS = '16charapppasswrd';

      const status = getMailStatus();
      assert.equal(status.live, true, 'live must be true when authorized with valid credentials');
      assert.equal(status.mode, 'smtp');
      assert.equal(status.host, 'smtp.gmail.com');
      assert.equal(status.port, 587);
      assert.equal(status.secure, false);
      assert.equal(status.missing.length, 0);
    });

    it('checkStagingServices and runStagingDevPreflight succeed with authorized live SMTP', () => {
      const options = {
        overrideEnv: {
          SYNQ_STAGING_ALLOW_SMTP: 'true',
          SMTP_USER: 'synq-staging-test@gmail.com',
          SMTP_PASS: '16charapppasswrd',
        },
      };

      const report = checkStagingServices(options);
      assert.equal(report.email.live, true);
      assert.equal(report.email.mode, 'smtp');
      assert.equal(report.email.stagingSmtpAllowed, true);

      const preflightPassed = runStagingDevPreflight(options);
      assert.equal(preflightPassed, true);
    });
  });

  // =========================================================================
  // 5. Console OTP Safety Guarantee
  // =========================================================================
  describe('5. Console OTP Safety When SMTP is Active/Authorized', () => {
    it('isStagingOtpConsoleAllowed strictly returns false when SYNQ_STAGING_ALLOW_SMTP=true', () => {
      const allowed = isStagingOtpConsoleAllowed(
        {
          SYNQ_ENV: 'staging',
          NODE_ENV: 'development',
          SYNQ_STAGING_OTP_CONSOLE: 'true',
          SYNQ_STAGING_ALLOW_SMTP: 'true',
          SYNQ_APPROVED_STAGING_PROJECT_REF: APPROVED_STAGING_PROJECT_REF,
          DATABASE_URL: `postgres://user:pass@db.${APPROVED_STAGING_PROJECT_REF}.supabase.co:5432/postgres`,
        },
        false,
      );
      assert.equal(allowed, false, 'Console OTP must be prohibited when real SMTP is authorized');
    });

    it('logStagingOtpIfAllowed never logs when real SMTP is authorized', () => {
      let loggedMessage = '';
      const result = logStagingOtpIfAllowed(
        '123456',
        false,
        {
          SYNQ_ENV: 'staging',
          NODE_ENV: 'development',
          SYNQ_STAGING_OTP_CONSOLE: 'true',
          SYNQ_STAGING_ALLOW_SMTP: 'true',
          SYNQ_APPROVED_STAGING_PROJECT_REF: APPROVED_STAGING_PROJECT_REF,
          DATABASE_URL: `postgres://user:pass@db.${APPROVED_STAGING_PROJECT_REF}.supabase.co:5432/postgres`,
        },
        (msg) => { loggedMessage = msg; },
      );

      assert.equal(result, false);
      assert.equal(loggedMessage, '');
    });
  });

  // =========================================================================
  // 6. Isolation Invariants
  // =========================================================================
  describe('6. Isolation Invariants', () => {
    it('Background workers must remain latched to false regardless of SMTP authorization', () => {
      assert.throws(
        () => runStagingDevPreflight({
          overrideEnv: {
            SYNQ_STAGING_ALLOW_SMTP: 'true',
            SMTP_USER: 'synq-staging-test@gmail.com',
            SMTP_PASS: '16charapppasswrd',
            ENABLE_OUTBOX_PROCESSOR: 'true',
          },
        }),
        /Background workers must be disabled in staging/,
      );
    });

    it('Protected production database is strictly rejected regardless of SMTP state', () => {
      const protectedUrl = 'postgresql://postgres:secret@db.chzpqxgrkspmqwmqphpd.supabase.co:5432/postgres';

      assert.throws(
        () => assertDatabaseAccessAllowed(protectedUrl, {
          operation: 'application',
          overrideEnv: {
            SYNQ_STAGING_ALLOW_SMTP: 'true',
            SMTP_USER: 'synq-staging-test@gmail.com',
            SMTP_PASS: '16charapppasswrd',
          },
        }),
        DatabaseAccessViolationError,
      );
    });
  });
});
