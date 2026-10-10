import { NextRequest } from 'next/server';
import { getAuthenticatedWallet, unauthorized } from '@/lib/auth';
import { normalizeWallet } from '@/lib/utils';
import {
  getNotificationPreferencesRepository,
  type NotificationPreferences,
} from '@/lib/deals/notification-preferences-db';

export async function GET(req: NextRequest) {
  const authWallet = getAuthenticatedWallet(req);
  if (!authWallet) return unauthorized();

  const url = new URL(req.url);
  const targetWallet = url.searchParams.get('wallet');

  if (targetWallet) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(targetWallet)) {
      return Response.json({ error: 'Invalid wallet address' }, { status: 400 });
    }
    const normalizedTarget = normalizeWallet(targetWallet);
    if (normalizedTarget !== authWallet) {
      return Response.json(
        { error: 'Forbidden: Cannot inspect notification preferences of another wallet' },
        { status: 403 },
      );
    }
  }

  try {
    const repo = getNotificationPreferencesRepository();
    const preferences = await repo.getPreferences(authWallet);
    return Response.json({
      wallet: authWallet,
      preferences,
    });
  } catch (err: any) {
    return Response.json(
      { error: err?.message || 'Failed to retrieve notification preferences' },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest) {
  const authWallet = getAuthenticatedWallet(req);
  if (!authWallet) return unauthorized();

  try {
    const body = await req.json();
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'Request body required' }, { status: 400 });
    }

    if (body.walletAddress) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(body.walletAddress)) {
        return Response.json({ error: 'Invalid wallet address' }, { status: 400 });
      }
      const normalizedTarget = normalizeWallet(body.walletAddress);
      if (normalizedTarget !== authWallet) {
        return Response.json(
          { error: 'Forbidden: Cannot modify notification preferences of another wallet' },
          { status: 403 },
        );
      }
    }

    const patch: Partial<NotificationPreferences> = {};
    const rawPrefs = body.preferences || body;

    if (rawPrefs.dealProposalsAndConfirmations !== undefined) {
      if (typeof rawPrefs.dealProposalsAndConfirmations !== 'boolean') {
        return Response.json(
          { error: 'dealProposalsAndConfirmations must be a boolean' },
          { status: 400 },
        );
      }
      patch.dealProposalsAndConfirmations = rawPrefs.dealProposalsAndConfirmations;
    }

    if (rawPrefs.milestoneSubmissionsAndRevisions !== undefined) {
      if (typeof rawPrefs.milestoneSubmissionsAndRevisions !== 'boolean') {
        return Response.json(
          { error: 'milestoneSubmissionsAndRevisions must be a boolean' },
          { status: 400 },
        );
      }
      patch.milestoneSubmissionsAndRevisions = rawPrefs.milestoneSubmissionsAndRevisions;
    }

    if (rawPrefs.paymentsAndCompletions !== undefined) {
      if (typeof rawPrefs.paymentsAndCompletions !== 'boolean') {
        return Response.json(
          { error: 'paymentsAndCompletions must be a boolean' },
          { status: 400 },
        );
      }
      patch.paymentsAndCompletions = rawPrefs.paymentsAndCompletions;
    }

    if (rawPrefs.disputesAndResolutions !== undefined) {
      if (typeof rawPrefs.disputesAndResolutions !== 'boolean') {
        return Response.json(
          { error: 'disputesAndResolutions must be a boolean' },
          { status: 400 },
        );
      }
      patch.disputesAndResolutions = rawPrefs.disputesAndResolutions;
    }

    const repo = getNotificationPreferencesRepository();
    const updated = await repo.updatePreferences(authWallet, patch);

    return Response.json({
      ok: true,
      wallet: authWallet,
      preferences: updated,
    });
  } catch (err: any) {
    return Response.json(
      { error: err?.message || 'Failed to update notification preferences' },
      { status: 500 },
    );
  }
}
