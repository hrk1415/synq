import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { OutboxProcessor } from '@/lib/deals/outbox-processor';
import { getDealOutboxRepository } from '@/lib/deals/outbox-db';
import { getNotificationsRepository } from '@/lib/deals/notifications-db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Retained as an explicit tombstone; cron trigger is POST-only. */
export async function GET() {
  return Response.json(
    { error: 'Outbox cron endpoint is POST-only' },
    { status: 405 },
  );
}

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim() === '') {
    return false;
  }

  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return false;
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest();
  const secretHash = crypto.createHash('sha256').update(secret.trim()).digest();
  return crypto.timingSafeEqual(tokenHash, secretHash);
}

export async function POST(req: NextRequest) {
  // 1. Authenticate with CRON_SECRET using constant-time comparison
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret || configuredSecret.trim() === '') {
    return Response.json(
      { error: 'CRON_SECRET is not configured on the server' },
      { status: 503 },
    );
  }

  if (!verifyCronSecret(req)) {
    return Response.json(
      { error: 'Unauthorized: Invalid or missing authorization token' },
      { status: 401 },
    );
  }

  // 2. Check disabled-by-default environment flag
  const isEnabled = process.env.ENABLE_OUTBOX_PROCESSOR === 'true';
  if (!isEnabled) {
    return Response.json(
      {
        status: 'disabled',
        message: 'Outbox processor worker is disabled by default. Set ENABLE_OUTBOX_PROCESSOR=true to enable.',
      },
      { status: 403 },
    );
  }

  // 3. Parse bounded batch limits
  let limit = 25;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.limit === 'number' && Number.isInteger(body.limit)) {
      limit = Math.max(1, Math.min(body.limit, 50));
    }
  } catch {
    // Default limit applies
  }

  // 4. Execute bounded outbox batch with existing database-backed leases and CAS
  try {
    const processor = new OutboxProcessor(
      getDealOutboxRepository(),
      getNotificationsRepository(),
    );
    const summary = await processor.processBatch(limit);

    return Response.json({
      status: 'success',
      limit,
      summary: {
        claimed: summary.claimedCount,
        processed: summary.processedCount,
        skipped: summary.skippedCount,
        failed: summary.failedCount,
        duplicates: summary.duplicatesCount,
        deferred: summary.deferredCount,
      },
    });
  } catch (err: any) {
    console.error('[CronOutbox] Worker execution error:', err?.message || err);
    return Response.json(
      {
        status: 'error',
        error: 'Outbox worker execution failed',
      },
      { status: 500 },
    );
  }
}
