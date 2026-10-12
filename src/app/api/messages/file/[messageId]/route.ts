import { NextRequest } from 'next/server';
import { getAuthenticatedWallet, unauthorized } from '@/lib/auth';
import { getById } from '@/lib/db';
import { isConversationParticipant } from '@/lib/conversation-pair';
import { validateFileMessagePayload } from '@/lib/synq-message';
import { createSynqChatAttachmentUrl } from '@/lib/storage';

export const runtime = 'nodejs';
const SIGNED_URL_LIFETIME_SECONDS = 5 * 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ messageId: string }> }) {
  const authenticatedWallet = getAuthenticatedWallet(req);
  if (!authenticatedWallet) return unauthorized();

  try {
    const { messageId } = await params;
    const message = await getById('messages', messageId);
    if (!message) return Response.json({ error: 'Attachment not found' }, { status: 404 });
    if (message.kind !== 'file') return Response.json({ error: 'Message is not a file attachment' }, { status: 400 });

    const payload = validateFileMessagePayload(message.payload);
    const conversation = await getById('conversations', message.conversationId);
    if (!conversation) return Response.json({ error: 'Conversation not found' }, { status: 404 });
    if (!isConversationParticipant(conversation, authenticatedWallet)) {
      return Response.json({ error: 'Not a participant in this conversation' }, { status: 403 });
    }

    const url = await createSynqChatAttachmentUrl(payload.storagePath, SIGNED_URL_LIFETIME_SECONDS);
    return Response.json(
      {
        url,
        expiresIn: SIGNED_URL_LIFETIME_SECONDS,
        file: { fileName: payload.fileName, mimeType: payload.mimeType, size: payload.size },
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error: any) {
    return Response.json({ error: error?.message || 'Could not access attachment' }, { status: 400 });
  }
}
