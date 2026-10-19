import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import {
  getCommitteeResolutionHistory,
  ResolutionReportAuthError,
  ResolutionReportValidationError,
} from '@/lib/deals/resolution-reports-db';
import { checkCommitteeSignerStatus } from '@/lib/deals/committee-queue';
import type { ResolutionReportPhase } from '@/db/schema';

function parsePaginationParams(searchParams: URLSearchParams): {
  limit: number;
  offset: number;
  error?: string;
} {
  const rawLimit = searchParams.get('limit');
  const rawOffset = searchParams.get('offset');

  let limit = 20;
  if (rawLimit !== null && rawLimit.trim() !== '') {
    const trimmed = rawLimit.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { limit: 20, offset: 0, error: 'Invalid limit parameter: must be a positive integer' };
    }
    const num = Number(trimmed);
    if (!Number.isSafeInteger(num) || num < 1) {
      return { limit: 20, offset: 0, error: 'Invalid limit parameter: must be a positive integer' };
    }
    limit = Math.min(num, 50);
  }

  let offset = 0;
  if (rawOffset !== null && rawOffset.trim() !== '') {
    const trimmed = rawOffset.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { limit: 20, offset: 0, error: 'Invalid offset parameter: must be a non-negative integer' };
    }
    const num = Number(trimmed);
    if (!Number.isSafeInteger(num) || num < 0) {
      return { limit: 20, offset: 0, error: 'Invalid offset parameter: must be a non-negative integer' };
    }
    offset = num;
  }

  return { limit, offset };
}

export async function GET(req: NextRequest) {
  try {
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json({ error: 'Unauthorized: valid wallet session required' }, { status: 401 });
    }

    const signerStatus = await checkCommitteeSignerStatus(authWallet);
    if (!signerStatus.isAnySigner) {
      return NextResponse.json(
        { error: 'Forbidden: wallet is not an active signer on any resolution committee' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(req.url);
    const pagination = parsePaginationParams(searchParams);
    if (pagination.error) {
      return NextResponse.json({ error: pagination.error }, { status: 400 });
    }
    const { limit, offset } = pagination;

    const rawPhase = searchParams.get('phase') as ResolutionReportPhase | null;
    const phase =
      rawPhase === 'INITIAL_RESOLUTION' || rawPhase === 'FINAL_RESOLUTION'
        ? rawPhase
        : undefined;

    const result = await getCommitteeResolutionHistory({
      callerWallet: authWallet,
      signerStatus,
      limit,
      offset,
      phase,
    });

    return NextResponse.json(
      {
        success: true,
        callerWallet: authWallet,
        items: result.items,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.offset + result.items.length < result.total,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err instanceof ResolutionReportAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ResolutionReportValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[GET /api/committee/history] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
