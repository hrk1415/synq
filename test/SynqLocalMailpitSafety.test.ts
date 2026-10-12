// test/SynqLocalMailpitSafety.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getMailStatus, getTransporterOptions } from '../src/lib/notify';

describe('SYNQ — B.12.4.09 Local Mailpit Safety & SMTP Isolation Suite', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset process.env to a clean baseline before each test
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    delete process.env.SYNQ_LOCAL_MAILPIT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_SECURE;
    delete process.env.SMTP_FROM;
    delete process.env.SYNQ_ENV;
    delete process.env.SYNQ_STAGING_ALLOW_SMTP;
    delete (process.env as any).NODE_ENV;
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
  // 1. Local Mailpit Valid Activation
  // =========================================================================
  describe('1. Local Mailpit Valid Activation', () => {
    it('activates live SMTP mode with 127.0.0.1:1025 without requiring SMTP_USER or SMTP_PASS', () => {
      process.env.SYNQ_LOCAL_MAILPIT = 'true';
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = '1025';
      process.env.SMTP_SECURE = 'false';

      const status = getMailStatus();
      assert.equal(status.live, true);
      assert.equal(status.mode, 'smtp');
      assert.equal(status.localMailpit, true);
      assert.equal(status.host, '127.0.0.1');
      assert.equal(status.port, 1025);
      assert.equal(status.secure, false);
      assert.equal(status.missing.length, 0);
      assert.equal(status.user, undefined);
    });

    it('getTransporterOptions produces clean unauthenticated transport options on loopback', () => {
      process.env.SYNQ_LOCAL_MAILPIT = 'true';
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = '1025';

      const status = getMailStatus();
      const opts = getTransporterOptions(status);

      assert.equal(opts.host, '127.0.0.1');
      assert.equal(opts.port, 1025);
      assert.equal(opts.auth, undefined, 'auth must strictly be undefined in local Mailpit mode');
    });
  });

  // =========================================================================
  // 2. Credential Isolation (Zero Leakage of Production Credentials)
  // =========================================================================
  describe('2. Credential Isolation & Masking', () => {
    it('never passes SMTP_USER or SMTP_PASS to transport even if present in environment', () => {
      process.env.SYNQ_LOCAL_MAILPIT = 'true';
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = '1025';
      process.env.SMTP_USER = 'production_gmail_user@gmail.com';
      process.env.SMTP_PASS = 'super_secret_gmail_pass';

      const status = getMailStatus();
      assert.equal(status.live, true);
      assert.equal(status.user, undefined, 'status.user must not expose production username in local Mailpit mode');

      const opts = getTransporterOptions(status);
      assert.equal(opts.auth, undefined, 'transport auth must remain strictly undefined despite env credentials');
    });

    it('does not fall back to production user address for default from address', () => {
      process.env.SYNQ_LOCAL_MAILPIT = 'true';
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = '1025';
      process.env.SMTP_USER = 'production_gmail_user@gmail.com';

      const status = getMailStatus();
      assert.notEqual(status.from, 'production_gmail_user@gmail.com');
      assert.equal(status.from, 'no-reply@synq.app');
    });
  });

  // =========================================================================
  // 3. Strict Host and Port Enforcement (Rejection of Unsafe Configurations)
  // =========================================================================
  describe('3. Strict Rejection of Unsafe Host/Port Combinations', () => {
    it('rejects external host (e.g. smtp.gmail.com) under SYNQ_LOCAL_MAILPIT flag', () => {
      process.env.SYNQ_LOCAL_MAILPIT = 'true';
      process.env.SMTP_HOST = 'smtp.gmail.com';
      process.env.SMTP_PORT = '1025';

      const status = getMailStatus();
      assert.equal(status.live, false);
      assert.equal(status.mode, 'log');
      assert.ok(status.missing.includes('SMTP_HOST_MUST_BE_127.0.0.1'));
    });

    it('rejects localhost string (requires strict 127.0.0.1) under SYNQ_LOCAL_MAILPIT flag', () => {
      process.env.SYNQ_LOCAL_MAILPIT = 'true';
      process.env.SMTP_HOST = 'localhost';
      process.env.SMTP_PORT = '1025';

      const status = getMailStatus();
      assert.equal(status.live, false);
      assert.ok(status.missing.includes('SMTP_HOST_MUST_BE_127.0.0.1'));
    });

    it('rejects LAN/private IP addresses (e.g. 192.168.1.100)', () => {
      process.env.SYNQ_LOCAL_MAILPIT = 'true';
      process.env.SMTP_HOST = '192.168.1.100';
      process.env.SMTP_PORT = '1025';

      const status = getMailStatus();
      assert.equal(status.live, false);
      assert.ok(status.missing.includes('SMTP_HOST_MUST_BE_127.0.0.1'));
    });

    it('rejects standard submission port 587 under SYNQ_LOCAL_MAILPIT flag', () => {
      process.env.SYNQ_LOCAL_MAILPIT = 'true';
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = '587';

      const status = getMailStatus();
      assert.equal(status.live, false);
      assert.ok(status.missing.includes('SMTP_PORT_MUST_BE_1025'));
    });

    it('rejects standard SMTP port 25 under SYNQ_LOCAL_MAILPIT flag', () => {
      process.env.SYNQ_LOCAL_MAILPIT = 'true';
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = '25';

      const status = getMailStatus();
      assert.equal(status.live, false);
      assert.ok(status.missing.includes('SMTP_PORT_MUST_BE_1025'));
    });

    it('getTransporterOptions throws if called with non-loopback status under SYNQ_LOCAL_MAILPIT', () => {
      process.env.SYNQ_LOCAL_MAILPIT = 'true';
      const fakeStatus = {
        live: true,
        mode: 'smtp' as const,
        host: 'smtp.gmail.com',
        port: 587,
        missing: [],
        hint: '',
      };
      assert.throws(() => getTransporterOptions(fakeStatus), /Local Mailpit mode requires SMTP_HOST=127\.0\.0\.1 and SMTP_PORT=1025/);
    });
  });

  // =========================================================================
  // 4. Environment Guardrails (Production and Staging Prohibitions)
  // =========================================================================
  describe('4. Environment Guardrails', () => {
    it('strictly prohibits SYNQ_LOCAL_MAILPIT in production NODE_ENV', () => {
      process.env.SYNQ_LOCAL_MAILPIT = 'true';
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = '1025';
      (process.env as any).NODE_ENV = 'production';

      const status = getMailStatus();
      assert.equal(status.live, false);
      assert.ok(status.missing.includes('SYNQ_LOCAL_MAILPIT_NOT_ALLOWED_IN_PRODUCTION'));
    });

    it('strictly prohibits SYNQ_LOCAL_MAILPIT in staging SYNQ_ENV', () => {
      process.env.SYNQ_LOCAL_MAILPIT = 'true';
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = '1025';
      process.env.SYNQ_ENV = 'staging';

      const status = getMailStatus();
      assert.equal(status.live, false);
      assert.ok(status.missing.includes('SYNQ_LOCAL_MAILPIT_NOT_ALLOWED_IN_STAGING'));
    });
  });

  // =========================================================================
  // 5. Preservation of Standard / Production SMTP Behavior
  // =========================================================================
  describe('5. Preservation of Standard / Production SMTP Behavior', () => {
    it('requires SMTP_USER and SMTP_PASS when SYNQ_LOCAL_MAILPIT is false or unset', () => {
      process.env.SYNQ_LOCAL_MAILPIT = 'false';
      process.env.SMTP_HOST = 'smtp.gmail.com';
      process.env.SMTP_PORT = '587';

      const status = getMailStatus();
      assert.equal(status.live, false);
      assert.equal(status.localMailpit, false);
      assert.ok(status.missing.includes('SMTP_USER'));
      assert.ok(status.missing.includes('SMTP_PASS'));
    });

    it('correctly loads and configures authenticated transport when valid credentials exist', () => {
      delete process.env.SYNQ_LOCAL_MAILPIT;
      process.env.SMTP_USER = 'testuser@gmail.com';
      process.env.SMTP_PASS = 'app_password';
      process.env.SMTP_HOST = 'smtp.gmail.com';
      process.env.SMTP_PORT = '587';

      const status = getMailStatus();
      assert.equal(status.live, true);
      assert.equal(status.mode, 'smtp');
      assert.equal(status.localMailpit, false);
      assert.equal(status.user, 'te***@gmail.com');

      const opts = getTransporterOptions(status);
      assert.deepEqual(opts.auth, {
        user: 'testuser@gmail.com',
        pass: 'app_password',
      });
      assert.equal(opts.host, 'smtp.gmail.com');
      assert.equal(opts.port, 587);
    });
  });
});
