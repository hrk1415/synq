import { NextRequest } from 'next/server';
import {
  getAuthenticatedWallet,
  listAiConversations,
  createAiConversationWithFirstMessage,
  MAX_NEGOTIATOR_CHATS,
} from '@/lib/ai-negotiator-db';

export async function GET(req: NextRequest) {
  try {
    const wallet = getAuthenticatedWallet(req);
    if (!wallet) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const conversations = await listAiConversations(wallet);
    const count = conversations.length;

    return Response.json({
      conversations,
      count,
      limit: MAX_NEGOTIATOR_CHATS,
      limitReached: count >= MAX_NEGOTIATOR_CHATS,
    });
  } catch (e: any) {
    return Response.json({ error: 'Failed to retrieve conversations' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const wallet = getAuthenticatedWallet(req);
    if (!wallet) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Invalid request body. Expected JSON object.' }, { status: 400 });
    }

    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'message') {
      return Response.json(
        { error: 'Invalid body shape. Request must contain only a "message" object: { "message": { "content": "..." } }' },
        { status: 400 }
      );
    }

    const messageObj = body.message;
    if (!messageObj || typeof messageObj !== 'object' || Array.isArray(messageObj)) {
      return Response.json({ error: 'Field "message" must be an object: { "content": "..." }' }, { status: 400 });
    }

    const messageKeys = Object.keys(messageObj);
    if (messageKeys.length !== 1 || messageKeys[0] !== 'content') {
      return Response.json({ error: 'Object "message" must contain only "content": { "message": { "content": "..." } }' }, { status: 400 });
    }

    if (typeof messageObj.content !== 'string') {
      return Response.json({ error: 'Message content must be a string' }, { status: 400 });
    }

    const content = messageObj.content.trim();
    if (!content) {
      return Response.json({ error: 'Message content is required' }, { status: 400 });
    }

    if (content.length > 10_000) {
      return Response.json({ error: 'Message content exceeds maximum length (10,000 characters)' }, { status: 400 });
    }

    const result = await createAiConversationWithFirstMessage(wallet, content);

    if (!result.success) {
      return Response.json(
        {
          error: 'Chat limit reached. Delete a conversation to start a new one.',
          code: 'NEGOTIATOR_CHAT_LIMIT_REACHED',
          count: result.count,
          limit: result.limit,
        },
        { status: 409 }
      );
    }

    return Response.json(
      {
        id: result.conversation.id,
        title: result.conversation.title,
        createdAt: result.conversation.createdAt,
        updatedAt: result.conversation.updatedAt,
        messages: [result.firstMessage],
      },
      { status: 201 }
    );
  } catch (e: any) {
    return Response.json({ error: 'Failed to create conversation' }, { status: 500 });
  }
}

