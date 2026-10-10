/**
 * SYNQ — Staging Environment Loader & Safety Gate (B.12.3.34)
 *
 * Ensures staging commands explicitly load .env.staging.local and strictly prohibits
 * silent fallback to .env.local.
 *
 * Enforces:
 * 1. .env.staging.local MUST exist; if missing, throws an immediate error refusing fallback to .env.local.
 * 2. DATABASE_URL must be present and must target the approved staging project reference.
 * 3. The protected live Supabase project ('chzpqxgrkspmqwmqphpd') is strictly forbidden.
 * 4. Distinguishes direct session connections (port 5432, required for DDL migrations) from transaction poolers (port 6543).
 * 5. Masks credentials in all logs and errors.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  extractDatabaseIdentity,
  assertDatabaseAccessAllowed,
  sanitizeDatabaseUrl,
  PROTECTED_SUPABASE_PROJECT_REFS,
} from '../db/guard';

export const APPROVED_STAGING_PROJECT_REF = 'dwmgizmwoqifdlokbozb';

export interface StagingEnvConfig {
  DATABASE_URL: string;
  SYNQ_APPROVED_STAGING_PROJECT_REF: string;
  MIGRATION_DATABASE_URL?: string;
  [key: string]: string | undefined;
}

export interface StagingValidationResult {
  valid: boolean;
  projectRef: string;
  isPooler: boolean;
  port: number;
  sanitizedUrl: string;
  migrationReady: boolean;
}

/**
 * Parses an environment file content into a key-value dictionary without loading other files.
 */
export function parseEnvFileContent(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      parsed[key] = val;
    }
  }
  return parsed;
}

/**
 * Loads .env.staging.local explicitly.
 * Throws immediately if .env.staging.local does not exist, explicitly prohibiting fallback to .env.local.
 */
export function loadStagingEnv(
  projectRoot: string = process.cwd(),
  overrideEnv?: Record<string, string>,
): StagingEnvConfig {
  const stagingPath = path.join(projectRoot, '.env.staging.local');

  if (!fs.existsSync(stagingPath)) {
    throw new Error(
      `[StagingEnv] Refusing to proceed: .env.staging.local not found at ${stagingPath}. Silent fallback to .env.local is strictly forbidden for staging operations.`,
    );
  }

  const content = fs.readFileSync(stagingPath, 'utf8');
  const env = parseEnvFileContent(content);

  if (overrideEnv) {
    Object.assign(env, overrideEnv);
  }

  if (!env.DATABASE_URL || env.DATABASE_URL.trim() === '') {
    throw new Error(
      `[StagingEnv] .env.staging.local is missing the required DATABASE_URL configuration.`,
    );
  }

  // Ensure staging environment marker is active
  process.env.SYNQ_ENV = 'staging';

  // Sensitive keys that must NEVER be silently inherited from the parent process or .env.local
  const sensitiveCredentialKeys = [
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_FROM',
    'SYNQ_STAGING_ALLOW_SMTP',
    'NOTIFY_FALLBACK_EMAIL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'JWT_SECRET',
    'CRON_SECRET',
    'SYNQCHAT_ATTACHMENTS_BUCKET',
    'DATABASE_URL',
  ];

  for (const key of sensitiveCredentialKeys) {
    if (env[key] !== undefined) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }

  // Synchronize with @next/env cache if initialized
  try {
    const nextEnv = require('@next/env');
    if (nextEnv && typeof nextEnv.updateInitialEnv === 'function') {
      nextEnv.updateInitialEnv(process.env);
    }
  } catch {
    // Non-fatal outside Next.js runtime
  }

  // Background worker flags must be explicitly disabled unless configured 'true' in staging
  const workerFlagKeys = [
    'ENABLE_OUTBOX_PROCESSOR',
    'ENABLE_CHAIN_SCANNER',
    'ENABLE_DEAL_REPLAY_WORKER',
  ];

  for (const key of workerFlagKeys) {
    if (env[key] === 'true') {
      process.env[key] = 'true';
    } else {
      process.env[key] = 'false';
    }
  }

  // Staging SMTP opt-in flag must be explicitly disabled unless configured 'true' in staging
  if (env.SYNQ_STAGING_ALLOW_SMTP === 'true') {
    process.env.SYNQ_STAGING_ALLOW_SMTP = 'true';
  } else {
    process.env.SYNQ_STAGING_ALLOW_SMTP = 'false';
  }

  // Staging console OTP flag must be explicitly disabled unless configured 'true' in staging,
  // and must strictly be 'false' whenever real SMTP is authorized/enabled.
  if (process.env.SYNQ_STAGING_ALLOW_SMTP === 'true') {
    process.env.SYNQ_STAGING_OTP_CONSOLE = 'false';
  } else if (env.SYNQ_STAGING_OTP_CONSOLE === 'true') {
    process.env.SYNQ_STAGING_OTP_CONSOLE = 'true';
  } else {
    process.env.SYNQ_STAGING_OTP_CONSOLE = 'false';
  }

  // Populate remaining staging values
  for (const [key, val] of Object.entries(env)) {
    if (val !== undefined) {
      process.env[key] = val;
    }
  }

  // Enforce approved staging project reference
  if (!process.env.SYNQ_APPROVED_STAGING_PROJECT_REF) {
    process.env.SYNQ_APPROVED_STAGING_PROJECT_REF = APPROVED_STAGING_PROJECT_REF;
  }

  return env as StagingEnvConfig;
}

/**
 * Validates the staging database configuration against safety requirements.
 */
export function validateStagingConfiguration(env: StagingEnvConfig): StagingValidationResult {
  const rawUrl = env.DATABASE_URL;

  // Run safety guard assertion
  assertDatabaseAccessAllowed(rawUrl, {
    overrideEnv: env,
    operation: 'migration',
  });

  const identity = extractDatabaseIdentity(rawUrl);
  if ('error' in identity) {
    throw new Error(`[StagingEnv] Could not establish database identity for staging DATABASE_URL.`);
  }

  if (identity.projectRef !== APPROVED_STAGING_PROJECT_REF) {
    throw new Error(
      `[StagingEnv] Staging DATABASE_URL targets project '${identity.projectRef}', but expected approved staging project '${APPROVED_STAGING_PROJECT_REF}'.`,
    );
  }

  if (PROTECTED_SUPABASE_PROJECT_REFS.includes(identity.projectRef)) {
    throw new Error(
      `[StagingEnv] CRITICAL: Staging configuration attempted to target protected production project.`,
    );
  }

  // Check connection mode: port 5432 (direct/session) vs port 6543 (transaction pooler)
  const isDirectOrSession = identity.port === 5432;

  return {
    valid: true,
    projectRef: identity.projectRef,
    isPooler: identity.isSupabasePooler,
    port: identity.port,
    sanitizedUrl: sanitizeDatabaseUrl(rawUrl),
    migrationReady: isDirectOrSession,
  };
}
