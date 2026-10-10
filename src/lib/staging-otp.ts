/**
 * SYNQ — Staging Console OTP Verification Guard (B.12.3.43)
 *
 * Allows developers and operators to test the end-to-end email OTP
 * verification flow in staging without enabling SMTP or sending real emails.
 *
 * Strict Safety Rules:
 * 1. SYNQ_ENV must strictly be 'staging'.
 * 2. NODE_ENV must NOT be 'production'.
 * 3. SYNQ_STAGING_OTP_CONSOLE must explicitly be 'true' (disabled by default).
 * 4. Email delivery must be in log-only mode (live SMTP must be false).
 * 5. Approved staging project ('dwmgizmwoqifdlokbozb') must be verified;
 *    protected production project ('chzpqxgrkspmqwmqphpd') is strictly prohibited.
 * 6. Never exposes OTP in API responses, browser JS, or persistent log files.
 * 7. Prints only the OTP and a staging label — never emails, wallets, or tokens.
 */

import { APPROVED_STAGING_PROJECT_REF } from './staging-env';
import { PROTECTED_SUPABASE_PROJECT_REFS } from '../db/guard';

export function isStagingOtpConsoleAllowed(
  env: Record<string, string | undefined> = process.env,
  isMailLive: boolean = false,
): boolean {
  // Condition 1: Must be in staging environment
  if (env.SYNQ_ENV !== 'staging') return false;

  // Condition 2: Prohibited in production
  if (env.NODE_ENV === 'production') return false;

  // Condition 3: Explicit opt-in flag required (disabled by default)
  if (env.SYNQ_STAGING_OTP_CONSOLE !== 'true') return false;

  // Condition 4: Prohibited if real SMTP is active or authorized
  if (isMailLive || env.SYNQ_STAGING_ALLOW_SMTP === 'true') return false;

  // Condition 5: Staging project identity verification
  if (env.SYNQ_APPROVED_STAGING_PROJECT_REF !== APPROVED_STAGING_PROJECT_REF) return false;

  const dbUrl = env.DATABASE_URL || '';
  for (const protectedRef of PROTECTED_SUPABASE_PROJECT_REFS) {
    if (dbUrl.includes(protectedRef)) {
      return false;
    }
  }

  return true;
}

export function logStagingOtpIfAllowed(
  plainCode: string,
  isMailLive: boolean = false,
  env: Record<string, string | undefined> = process.env,
  logger: (msg: string) => void = console.log,
): boolean {
  if (!isStagingOtpConsoleAllowed(env, isMailLive)) {
    return false;
  }

  // Print only the OTP and a short staging label.
  // Never log emails, wallet addresses, JWTs, or secrets.
  logger(`[SYNQ STAGING OTP] Code: ${plainCode}`);
  return true;
}
