import { NextRequest } from 'next/server';
import {
  getAuthenticatedWallet,
  getAiConversationWithMessages,
  deleteAiConversation,
} from '@/lib/ai-negotiator-db';

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const wallet = getAuthenticatedWallet(req);
    if (!wallet) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const params = await props.params;
    const conversationId = params?.id;
    if (!conversationId) {
      return Response.json({ error: 'Conversation ID required' }, { status: 400 });
    }

    const conversation = await getAiConversationWithMessages(wallet, conversationId);
    if (!conversation) {
      return Response.json({ error: 'Conversation not found' }, { status: 404 });
    }

    return Response.json(conversation);
  } catch (e: any) {
    return Response.json({ error: 'Failed to retrieve conversation' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const wallet = getAuthenticatedWallet(req);
    if (!wallet) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const params = await props.params;
    const conversationId = params?.id;
    if (!conversationId) {
      return Response.json({ error: 'Conversation ID required' }, { status: 400 });
    }

    const deleted = await deleteAiConversation(wallet, conversationId);
    if (!deleted) {
      return Response.json({ error: 'Conversation not found' }, { status: 404 });
    }

    return Response.json({ ok: true, deletedId: conversationId });
  } catch (e: any) {
    return Response.json({ error: 'Failed to delete conversation' }, { status: 500 });
  }
}

