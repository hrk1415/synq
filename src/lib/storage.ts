import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { assertStorageAccessAllowed } from '../db/guard';

let storageClient: SupabaseClient | null = null;

function storageConfig() {
  const rawUrl = process.env.SUPABASE_URL;
  const rawServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const rawBucket = process.env.SYNQCHAT_ATTACHMENTS_BUCKET;
  const url = rawUrl?.trim();
  const serviceRoleKey = rawServiceRoleKey?.trim();
  const bucket = rawBucket?.trim();
  if (!url || !serviceRoleKey || !bucket) {
    throw new Error('SynqChat attachment storage is not configured');
  }

  assertStorageAccessAllowed(url, serviceRoleKey, { operation: 'storage' });

  let parsedUrl: URL | null = null;
  try { parsedUrl = new URL(url); } catch { /* reported structurally below */ }
  const urlHasQuotes = /^['"]|['"]$/.test(url);
  const urlHasWhitespace = /\s/.test(url);
  const urlHasExtraPath = !!parsedUrl && parsedUrl.pathname !== '/' && parsedUrl.pathname !== '';
  const validUrl = !!parsedUrl
    && (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:')
    && !parsedUrl.username
    && !parsedUrl.password
    && !parsedUrl.search
    && !parsedUrl.hash
    && !urlHasQuotes
    && !urlHasWhitespace
    && !urlHasExtraPath;

  const bucketHasWhitespace = /\s/.test(bucket);
  const bucketHasSlash = bucket.includes('/') || bucket.includes('\\');
  const bucketHasQuotes = /^['"]|['"]$/.test(bucket);
  const validBucket = /^[a-z0-9][a-z0-9._-]*$/.test(bucket)
    && !bucketHasWhitespace
    && !bucketHasSlash
    && !bucketHasQuotes;

  if (!validUrl || !validBucket) {
    if (!validUrl) throw new Error('SUPABASE_URL must be the Supabase project base URL with no extra path');
    throw new Error('SYNQCHAT_ATTACHMENTS_BUCKET has an invalid bucket name');
  }

  // `origin` normalizes an optional trailing slash without accepting endpoint paths.
  return { url: parsedUrl!.origin, serviceRoleKey, bucket };
}

export function getSynqChatStorage() {
  const config = storageConfig();
  if (!storageClient) {
    storageClient = createClient(config.url, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return { client: storageClient, bucket: config.bucket };
}

export async function uploadSynqChatAttachment(path: string, bytes: ArrayBuffer, contentType: string) {
  const { client, bucket } = getSynqChatStorage();
  const objectPathPatternValid = /^attachments\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/i.test(path);
  if (!objectPathPatternValid) {
    throw new Error('Could not store attachment');
  }
  const { error } = await client.storage.from(bucket).upload(path, bytes, {
    contentType,
    upsert: false,
  });
  if (error) {
    const safeError = error as unknown as { name?: unknown; code?: unknown; statusCode?: unknown; message?: unknown };
    console.error('[synqchat-storage] upload failed', {
      name: typeof safeError.name === 'string' ? safeError.name : undefined,
      code: typeof safeError.code === 'string' ? safeError.code : undefined,
      statusCode: typeof safeError.statusCode === 'string' || typeof safeError.statusCode === 'number'
        ? safeError.statusCode
        : undefined,
      message: typeof safeError.message === 'string' ? safeError.message : 'Unknown storage error',
    });
    throw new Error('Could not store attachment');
  }
}

export async function removeSynqChatAttachment(path: string) {
  const { client, bucket } = getSynqChatStorage();
  const { error } = await client.storage.from(bucket).remove([path]);
  if (error) throw new Error('Could not remove attachment');
}

export async function createSynqChatAttachmentUrl(path: string, expiresInSeconds: number) {
  const { client, bucket } = getSynqChatStorage();
  const { data, error } = await client.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
  if (error || !data?.signedUrl) throw new Error('Could not create attachment access URL');
  return data.signedUrl;
}
