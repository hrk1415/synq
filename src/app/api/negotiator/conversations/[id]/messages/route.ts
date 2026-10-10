import { NextRequest } from 'next/server';
import {
  getAuthenticatedWallet,
  appendUserMessageIfReady,
  validatePayload,
} from '@/lib/ai-negotiator-db';

export async function POST(
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

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Invalid request body. Expected JSON object.' }, { status: 400 });
    }

    // Reject client requests attempting authority-bearing non-user roles
    if (body.role !== undefined && body.role !== 'user') {
      return Response.json(
        { error: 'Client cannot specify role. Only user messages can be persisted through this endpoint.' },
        { status: 400 }
      );
    }

    const rawContent = body.content;
    if (typeof rawContent !== 'string') {
      return Response.json({ error: 'Message content must be a string' }, { status: 400 });
    }

    const content = rawContent.trim();
    if (!content) {
      return Response.json({ error: 'Message content is required' }, { status: 400 });
    }

    if (content.length > 10_000) {
      return Response.json({ error: 'Message content exceeds maximum length (10,000 characters)' }, { status: 400 });
    }

    const payloadValidation = validatePayload(body.payload);
    if (!payloadValidation.valid) {
      return Response.json({ error: payloadValidation.error || 'Invalid payload structure' }, { status: 400 });
    }

    // Atomic insert enforcing user/AI turn order
    const result = await appendUserMessageIfReady(
      wallet,
      conversationId,
      content,
      payloadValidation.cleaned
    );

    if (!result.success) {
      if (result.reason === 'CONVERSATION_AWAITING_AI') {
        return Response.json(
          { error: 'Conversation is awaiting an AI response before submitting another user message', code: 'CONVERSATION_AWAITING_AI' },
          { status: 409 }
        );
      }
      return Response.json({ error: 'Conversation not found' }, { status: 404 });
    }

    return Response.json(result.message, { status: 201 });
  } catch (e: any) {
    return Response.json({ error: 'Failed to append message' }, { status: 500 });
  }
}
