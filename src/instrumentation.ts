/**
 * Next.js Instrumentation Hook (B.12.3.38)
 *
 * Runs on server startup before any HTTP requests are served.
 * Guarantees that staging runs enforce .env.staging.local isolation
 * across all server instances and worker runtimes.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.SYNQ_ENV === 'staging') {
    const { loadStagingEnv } = await import('./lib/staging-env');
    loadStagingEnv();
  }
}
