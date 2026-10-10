/**
 * SYNQ — Final Environment Authorization & Database Safety Guard (B.12.3.33.2)
 *
 * Protects Synq's existing production/live Supabase project ('chzpqxgrkspmqwmqphpd')
 * from accidental local development writes, migrations, schema pushes, imports, and background workers.
 *
 * Architecture & Authorization Invariants:
 *
 * 1. Explicit Intentional Production Authorization (No Fingerprints):
 *    - Automatic production bypass based on Vercel environment variables, platform checks,
 *      directory traversal, or runtime fingerprints is REMOVED.
 *    - Production access to the protected project requires intentional, multi-variable deployment configuration:
 *        NODE_ENV === 'production'
 *        SYNQ_ENVIRONMENT === 'production'
 *        SYNQ_AUTHORIZED_PRODUCTION_PROJECT_REF === 'chzpqxgrkspmqwmqphpd'
 *    - Ordinary local development cannot accidentally enable production authorization merely by
 *      copying a .env.local file. (Note on environment variable trust: environment variables in a
 *      process cannot provide tamper-proof machine identity; any local shell process can set variables.
 *      However, requiring multi-variable intentional production confirmation ensures accidental runs,
 *      copied credentials, and default local runs fail closed by default.)
 *
 * 2. Exact Supabase Staging Authorization:
 *    - Staging Supabase databases must be authorized by exact project reference (SYNQ_APPROVED_STAGING_PROJECT_REF).
 *    - Shared Supabase pooler hostnames (*.pooler.supabase.com) CANNOT be treated as proof of an approved staging database,
 *      because the pooler hostname is shared across all tenants in the region.
 *
 * 3. Specific Non-Supabase Staging Authorization:
 *    - For non-Supabase PostgreSQL, authorization requires a sufficiently specific connection identity
 *      consisting of host, port, and database name (e.g. SYNQ_APPROVED_STAGING_TARGET="host:port/dbname").
 *    - Broad hostname-only authorization is disallowed to prevent unintended cross-database access on shared hosts.
 *
 * 4. Absolute Protection for Live Project:
 *    - The protected project ('chzpqxgrkspmqwmqphpd') can NEVER be configured or approved as a staging target.
 *    - Generic booleans (ALLOW_REMOTE_DEV_DATABASE=true / SYNQ_STAGING_DATABASE_APPROVED=true) without an exact target fail closed.
 *
 * 5. Supabase Storage & Credential Isolation:
 *    - Inspects both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY JWT payload ('ref' claim).
 *    - Blocks any local access targeting the protected project, as well as mismatched project credentials.
 *
 * 6. Credential Sanitization:
 *    - Passwords and query secrets are masked in all logs and error messages.
 */

export const PROTECTED_SUPABASE_PROJECT_REFS: readonly string[] = [
  'chzpqxgrkspmqwmqphpd',
];

export const APPROVED_LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

export interface DbGuardCheckOptions {
  operation?: 'application' | 'migration' | 'script' | 'worker' | 'storage';
  overrideEnv?: Record<string, string | undefined>;
}

export type DbGuardDecisionReason =
  | 'PRODUCTION_DEPLOYMENT_AUTHORIZED'
  | 'LOCAL_DATABASE_ALLOWED'
  | 'EXPLICIT_REMOTE_STAGING_ALLOWED'
  | 'PROTECTED_PROJECT_BLOCKED'
  | 'REMOTE_DATABASE_FAIL_CLOSED'
  | 'GENERIC_BOOLEAN_STAGING_DISALLOWED'
  | 'PROTECTED_STAGING_TARGET_FORBIDDEN'
  | 'POOLER_HOST_STAGING_DISALLOWED'
  | 'INSUFFICIENTLY_SPECIFIC_STAGING_TARGET'
  | 'DATABASE_IDENTITY_UNVERIFIABLE'
  | 'DATABASE_URL_MISSING'
  | 'DATABASE_URL_MALFORMED'
  | 'STORAGE_CREDENTIAL_MISMATCH';

export interface DatabaseIdentity {
  protocol: string;
  hostname: string;
  port: number;
  databaseName: string;
  username: string;
  projectRef: string | null;
  isSupabasePooler: boolean;
  isLoopback: boolean;
  sanitizedHost: string;
}

export interface DbGuardResult {
  allowed: boolean;
  reason: DbGuardDecisionReason;
  sanitizedHost?: string;
  detectedProjectRef?: string | null;
  isLocal: boolean;
  isProtectedProject: boolean;
  isProductionAuthorized: boolean;
}

/**
 * Sanitizes a connection string for safe error reporting without passwords or tokens.
 */
export function sanitizeDatabaseUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '[MISSING]';
  try {
    const url = new URL(rawUrl.trim());
    const user = url.username ? `${url.username.split(':')[0]}:***@` : '';
    const port = url.port ? `:${url.port}` : '';
    return `${url.protocol}//${user}${url.hostname}${port}${url.pathname}`;
  } catch {
    return '[MALFORMED_URL]';
  }
}

/**
 * Decodes a Supabase service role key or anon key JWT payload to extract its project reference.
 * Returns null if not a valid JWT or if 'ref' is not present in the payload.
 * Never logs or reveals the token.
 */
export function extractJwtProjectRef(token?: string): string | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    if (payload && typeof payload.ref === 'string' && payload.ref.trim()) {
      return payload.ref.trim().toLowerCase();
    }
  } catch {
    // Malformed token payload
  }
  return null;
}

/**
 * Validates whether the environment has intentional production deployment authorization.
 * Requires explicit, multi-variable deployment configuration rather than runtime fingerprints.
 */
export function isIntentionalProductionAuthorized(
  env: Record<string, string | undefined>,
  targetProjectRef?: string | null,
): boolean {
  if (env.SYNQ_FORCE_LOCAL_GUARD === 'true') {
    return false;
  }

  const isProductionNodeEnv = env.NODE_ENV === 'production';
  const isProductionEnvironment = env.SYNQ_ENVIRONMENT === 'production';
  const authorizedProductionRef = env.SYNQ_AUTHORIZED_PRODUCTION_PROJECT_REF?.trim().toLowerCase();

  if (!isProductionNodeEnv || !isProductionEnvironment || !authorizedProductionRef) {
    return false;
  }

  // If a specific project ref is targeted, it must match the authorized production project ref
  if (targetProjectRef && authorizedProductionRef !== targetProjectRef) {
    return false;
  }

  return true;
}

/**
 * Extracts and structurally validates database identity from a PostgreSQL connection string.
 * Fails closed if the URL is malformed or database identity cannot be reliably established.
 */
export function extractDatabaseIdentity(rawUrl: string): DatabaseIdentity | { error: 'MALFORMED' | 'UNVERIFIABLE' } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { error: 'MALFORMED' };
  }

  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    !parsed.hostname ||
    parsed.hostname.trim() === ''
  ) {
    return { error: 'MALFORMED' };
  }

  let decodedUsername = '';
  try {
    decodedUsername = decodeURIComponent(parsed.username || '').toLowerCase();
  } catch {
    return { error: 'MALFORMED' };
  }

  let decodedDatabaseName = '';
  try {
    decodedDatabaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '') || '').toLowerCase();
  } catch {
    return { error: 'MALFORMED' };
  }

  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port ? parseInt(parsed.port, 10) : 5432;
  const sanitizedHost = `${hostname}${parsed.port ? `:${parsed.port}` : ''}`;

  let projectRef: string | null = null;
  const isSupabasePooler = hostname.includes('.pooler.supabase.com') || hostname.includes('.pooler.supabase.co');

  // 1. Direct Supabase hostname: db.<project-ref>.supabase.co or <project-ref>.supabase.co
  const directMatch = hostname.match(/^(?:db\.)?([a-z0-9_-]+)\.supabase\.(?:co|net|com)$/i);
  if (directMatch && directMatch[1]) {
    projectRef = directMatch[1].toLowerCase();
  }

  // 2. Pooled Supabase connection: <user>.<project-ref>@<region>.pooler.supabase.com
  if (isSupabasePooler) {
    const dotIndex = decodedUsername.indexOf('.');
    if (dotIndex !== -1 && dotIndex < decodedUsername.length - 1) {
      projectRef = decodedUsername.slice(dotIndex + 1).toLowerCase();
    } else {
      // Supabase pooler connection without a project reference in username cannot be reliably verified
      return { error: 'UNVERIFIABLE' };
    }
  }

  // 3. Explicit project query parameter if present
  if (!projectRef) {
    const paramRef = parsed.searchParams.get('project') || parsed.searchParams.get('ref');
    if (paramRef && typeof paramRef === 'string') {
      projectRef = paramRef.trim().toLowerCase();
    }
  }

  const isLoopback =
    APPROVED_LOCAL_HOSTS.has(hostname) ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal');

  return {
    protocol: parsed.protocol,
    hostname,
    port,
    databaseName: decodedDatabaseName,
    username: decodedUsername,
    projectRef,
    isSupabasePooler,
    isLoopback,
    sanitizedHost,
  };
}

/**
 * Evaluates whether a database connection string is safe to use in the current environment.
 */
export function evaluateDatabaseAccess(
  rawUrl: string | undefined,
  options?: DbGuardCheckOptions,
): DbGuardResult {
  const env = options?.overrideEnv ?? process.env;

  // 1. Validate URL presence
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return {
      allowed: false,
      reason: 'DATABASE_URL_MISSING',
      isLocal: false,
      isProtectedProject: false,
      isProductionAuthorized: false,
    };
  }

  // 2. Extract and structurally validate database identity
  const identityResult = extractDatabaseIdentity(rawUrl);
  if ('error' in identityResult) {
    if (identityResult.error === 'UNVERIFIABLE') {
      return {
        allowed: false,
        reason: 'DATABASE_IDENTITY_UNVERIFIABLE',
        sanitizedHost: sanitizeDatabaseUrl(rawUrl),
        isLocal: false,
        isProtectedProject: false,
        isProductionAuthorized: false,
      };
    }
    return {
      allowed: false,
      reason: 'DATABASE_URL_MALFORMED',
      isLocal: false,
      isProtectedProject: false,
      isProductionAuthorized: false,
    };
  }

  const identity = identityResult;
  const sanitizedHost = identity.sanitizedHost;

  // 3. Determine if the target is the protected live Supabase project
  let decodedFullUrl = '';
  try {
    decodedFullUrl = decodeURIComponent(rawUrl).toLowerCase();
  } catch {
    decodedFullUrl = rawUrl.toLowerCase();
  }

  const lowerRawUrl = rawUrl.toLowerCase();
  const isProtectedProject = PROTECTED_SUPABASE_PROJECT_REFS.some((ref) => {
    const lowerRef = ref.toLowerCase();
    return (
      identity.projectRef === lowerRef ||
      identity.hostname.includes(lowerRef) ||
      identity.username.includes(lowerRef) ||
      decodedFullUrl.includes(lowerRef) ||
      lowerRawUrl.includes(lowerRef)
    );
  });

  // 4. Intentional Production Authorization Check
  if (isIntentionalProductionAuthorized(env, identity.projectRef)) {
    return {
      allowed: true,
      reason: 'PRODUCTION_DEPLOYMENT_AUTHORIZED',
      sanitizedHost,
      detectedProjectRef: identity.projectRef,
      isLocal: false,
      isProtectedProject,
      isProductionAuthorized: true,
    };
  }

  // 5. Rule: The protected live project can NEVER be configured as an approved staging target
  const approvedProjectRef = env.SYNQ_APPROVED_STAGING_PROJECT_REF?.trim().toLowerCase();
  const approvedTarget = env.SYNQ_APPROVED_STAGING_TARGET?.trim().toLowerCase();
  const approvedHost = env.SYNQ_APPROVED_STAGING_HOST?.trim().toLowerCase();
  const approvedDbName = env.SYNQ_APPROVED_STAGING_DB_NAME?.trim().toLowerCase();

  if (
    (approvedProjectRef && PROTECTED_SUPABASE_PROJECT_REFS.includes(approvedProjectRef)) ||
    (approvedTarget && PROTECTED_SUPABASE_PROJECT_REFS.some((ref) => approvedTarget.includes(ref))) ||
    (approvedHost && PROTECTED_SUPABASE_PROJECT_REFS.some((ref) => approvedHost.includes(ref)))
  ) {
    return {
      allowed: false,
      reason: 'PROTECTED_STAGING_TARGET_FORBIDDEN',
      sanitizedHost,
      isLocal: false,
      isProtectedProject: true,
      isProductionAuthorized: false,
    };
  }

  // 6. If the target is the protected live project and not intentionally authorized for production: HARD BLOCK!
  if (isProtectedProject) {
    return {
      allowed: false,
      reason: 'PROTECTED_PROJECT_BLOCKED',
      sanitizedHost,
      detectedProjectRef: identity.projectRef || 'chzpqxgrkspmqwmqphpd',
      isLocal: false,
      isProtectedProject: true,
      isProductionAuthorized: false,
    };
  }

  // 7. Check if targeting a local loopback database (allowed for local dev/testing)
  if (identity.isLoopback) {
    return {
      allowed: true,
      reason: 'LOCAL_DATABASE_ALLOWED',
      sanitizedHost,
      detectedProjectRef: identity.projectRef,
      isLocal: true,
      isProtectedProject: false,
      isProductionAuthorized: false,
    };
  }

  // 8. Staging Authorization: validate against explicit approved staging targets

  // Rule 7B: Disallow generic boolean flags alone without an exact staging target
  const hasGenericBoolean =
    env.ALLOW_REMOTE_DEV_DATABASE === 'true' ||
    env.SYNQ_STAGING_DATABASE_APPROVED === 'true';

  if (hasGenericBoolean && !approvedProjectRef && !approvedTarget && !approvedHost) {
    return {
      allowed: false,
      reason: 'GENERIC_BOOLEAN_STAGING_DISALLOWED',
      sanitizedHost,
      isLocal: false,
      isProtectedProject: false,
      isProductionAuthorized: false,
    };
  }

  // Rule 7C: Disallow authorizing a shared Supabase pooler hostname via host-only configuration
  if (approvedHost && (approvedHost.includes('.pooler.supabase.com') || approvedHost.includes('.pooler.supabase.co'))) {
    return {
      allowed: false,
      reason: 'POOLER_HOST_STAGING_DISALLOWED',
      sanitizedHost,
      isLocal: false,
      isProtectedProject: false,
      isProductionAuthorized: false,
    };
  }

  // Rule 7D: Staging Supabase databases must be authorized by exact project reference
  if (identity.isSupabasePooler || identity.hostname.includes('.supabase.co')) {
    if (approvedProjectRef && identity.projectRef === approvedProjectRef) {
      return {
        allowed: true,
        reason: 'EXPLICIT_REMOTE_STAGING_ALLOWED',
        sanitizedHost,
        detectedProjectRef: identity.projectRef,
        isLocal: false,
        isProtectedProject: false,
        isProductionAuthorized: false,
      };
    }

    return {
      allowed: false,
      reason: 'REMOTE_DATABASE_FAIL_CLOSED',
      sanitizedHost,
      detectedProjectRef: identity.projectRef,
      isLocal: false,
      isProtectedProject: false,
      isProductionAuthorized: false,
    };
  }

  // Rule 7E: Non-Supabase PostgreSQL must have a sufficiently specific connection identity (host + port/database)
  // Check if a broad hostname was provided without a database name
  if (approvedHost && !approvedDbName && !approvedTarget) {
    return {
      allowed: false,
      reason: 'INSUFFICIENTLY_SPECIFIC_STAGING_TARGET',
      sanitizedHost,
      isLocal: false,
      isProtectedProject: false,
      isProductionAuthorized: false,
    };
  }

  // Match sufficiently specific non-Supabase target
  const connectionTargetA = `${identity.hostname}:${identity.port}/${identity.databaseName}`.toLowerCase();
  const connectionTargetB = `${identity.hostname}/${identity.databaseName}`.toLowerCase();

  const matchesApprovedTarget = Boolean(
    approvedTarget && (connectionTargetA === approvedTarget || connectionTargetB === approvedTarget),
  );

  const matchesApprovedHostAndDb = Boolean(
    approvedHost && approvedDbName && identity.hostname === approvedHost && identity.databaseName === approvedDbName,
  );

  if (matchesApprovedTarget || matchesApprovedHostAndDb) {
    return {
      allowed: true,
      reason: 'EXPLICIT_REMOTE_STAGING_ALLOWED',
      sanitizedHost,
      detectedProjectRef: identity.projectRef,
      isLocal: false,
      isProtectedProject: false,
      isProductionAuthorized: false,
    };
  }

  // Default fail-closed for unapproved remote database targets
  return {
    allowed: false,
    reason: 'REMOTE_DATABASE_FAIL_CLOSED',
    sanitizedHost,
    detectedProjectRef: identity.projectRef,
    isLocal: false,
    isProtectedProject: false,
    isProductionAuthorized: false,
  };
}

export class DatabaseAccessViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseAccessViolationError';
  }
}

/**
 * Asserts that database access is allowed. Throws a sanitized, descriptive error if blocked.
 */
export function assertDatabaseAccessAllowed(
  rawUrl: string | undefined,
  options?: DbGuardCheckOptions,
): void {
  const result = evaluateDatabaseAccess(rawUrl, options);
  if (result.allowed) return;

  switch (result.reason) {
    case 'PROTECTED_PROJECT_BLOCKED':
      throw new DatabaseAccessViolationError(
        `[DbGuard] BLOCKED: DATABASE_URL targets protected live Alpha Supabase project (chzpqxgrkspmqwmqphpd). Local operations are prohibited from connecting to this database. To authorize production access in a genuine deployment, explicit intentional configuration is required (SYNQ_ENVIRONMENT=production, SYNQ_AUTHORIZED_PRODUCTION_PROJECT_REF=chzpqxgrkspmqwmqphpd, and NODE_ENV=production).`,
      );

    case 'GENERIC_BOOLEAN_STAGING_DISALLOWED':
      throw new Error(
        `[DbGuard] BLOCKED: Generic boolean remote database flags (ALLOW_REMOTE_DEV_DATABASE / SYNQ_STAGING_DATABASE_APPROVED) are disabled. An exact staging target must be configured using SYNQ_APPROVED_STAGING_PROJECT_REF for Supabase or SYNQ_APPROVED_STAGING_TARGET for non-Supabase databases.`,
      );

    case 'PROTECTED_STAGING_TARGET_FORBIDDEN':
      throw new Error(
        `[DbGuard] BLOCKED: The approved staging target cannot be configured as the protected live Alpha project (chzpqxgrkspmqwmqphpd).`,
      );

    case 'POOLER_HOST_STAGING_DISALLOWED':
      throw new Error(
        `[DbGuard] BLOCKED: Shared Supabase pooler hostnames cannot be authorized via host-only configuration. Staging Supabase databases must be authorized by exact project reference using SYNQ_APPROVED_STAGING_PROJECT_REF.`,
      );

    case 'INSUFFICIENTLY_SPECIFIC_STAGING_TARGET':
      throw new Error(
        `[DbGuard] BLOCKED: Non-Supabase staging targets must be sufficiently specific and include both the host and database name (e.g. SYNQ_APPROVED_STAGING_TARGET="<host>:<port>/<dbname>"). Broad hostname-only authorization is disallowed.`,
      );

    case 'DATABASE_IDENTITY_UNVERIFIABLE':
      throw new Error(
        `[DbGuard] BLOCKED: DATABASE_URL identity cannot be reliably established (${result.sanitizedHost || 'unknown'}). Supabase pooler connections must include a valid project reference in the username (e.g. postgres.<project_ref>).`,
      );

    case 'REMOTE_DATABASE_FAIL_CLOSED':
      throw new Error(
        `[DbGuard] BLOCKED: DATABASE_URL targets an unapproved remote database (${result.sanitizedHost || 'unknown'}). Local development fails closed on remote databases by default. To connect to an approved staging database, configure SYNQ_APPROVED_STAGING_PROJECT_REF for Supabase or SYNQ_APPROVED_STAGING_TARGET for PostgreSQL.`,
      );

    case 'DATABASE_URL_MISSING':
      throw new Error(
        `[DbGuard] DATABASE_URL environment variable is missing or empty. Database connection blocked.`,
      );

    case 'DATABASE_URL_MALFORMED':
      throw new Error(
        `[DbGuard] DATABASE_URL format is malformed or invalid. Database connection blocked.`,
      );

    default:
      throw new Error(`[DbGuard] Database access blocked by local safety guard.`);
  }
}

/**
 * Evaluates whether Supabase Storage access is safe to use in the current environment.
 * Validates both the storage URL and the service role key JWT payload.
 */
export function assertStorageAccessAllowed(
  rawUrl: string | undefined,
  rawKey?: string | undefined,
  options?: DbGuardCheckOptions,
): void {
  const env = options?.overrideEnv ?? process.env;

  // 1. Validate URL presence
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new Error(`[DbGuard] SUPABASE_URL environment variable is missing.`);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl.trim());
  } catch {
    throw new Error(`[DbGuard] SUPABASE_URL format is malformed.`);
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  let urlProjectRef: string | null = null;
  const match = hostname.match(/^(?:([a-z0-9_-]+)\.supabase\.(?:co|net|com))/i);
  if (match && match[1]) {
    urlProjectRef = match[1].toLowerCase();
  }

  // 2. Allow if intentionally authorized for production deployment
  if (isIntentionalProductionAuthorized(env, urlProjectRef)) {
    return;
  }

  // 3. Inspect service role key JWT payload (if provided)
  const keyProjectRef = extractJwtProjectRef(rawKey);

  // 4. Check for protected project references
  const lowerUrl = rawUrl.toLowerCase();
  const isProtectedUrl = PROTECTED_SUPABASE_PROJECT_REFS.some((ref) => {
    const lowerRef = ref.toLowerCase();
    return urlProjectRef === lowerRef || lowerUrl.includes(lowerRef);
  });

  const isProtectedKey = Boolean(
    keyProjectRef && PROTECTED_SUPABASE_PROJECT_REFS.includes(keyProjectRef),
  );

  if (isProtectedUrl || isProtectedKey) {
    throw new Error(
      `[DbGuard] BLOCKED: SUPABASE_URL or service key targets protected live Alpha Supabase storage (chzpqxgrkspmqwmqphpd). Local operations cannot access live Alpha storage.`,
    );
  }

  // 5. Check for mismatched project URLs and credentials
  if (urlProjectRef && keyProjectRef && urlProjectRef !== keyProjectRef) {
    throw new Error(
      `[DbGuard] BLOCKED: Mismatch between SUPABASE_URL project (${urlProjectRef}) and service role key credential project (${keyProjectRef}). Possible credential confusion.`,
    );
  }

  // 6. Check if local loopback (e.g. local Supabase emulator)
  const isLoopback =
    APPROVED_LOCAL_HOSTS.has(hostname) ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal');

  if (isLoopback) return;

  // 7. Remote storage: must match approved staging project reference
  const approvedProjectRef = env.SYNQ_APPROVED_STAGING_PROJECT_REF?.trim().toLowerCase();

  if (approvedProjectRef && urlProjectRef === approvedProjectRef) {
    return;
  }

  throw new Error(
    `[DbGuard] BLOCKED: SUPABASE_URL targets an unapproved remote storage project (${hostname}). Configure SYNQ_APPROVED_STAGING_PROJECT_REF to authorize staging storage.`,
  );
}
