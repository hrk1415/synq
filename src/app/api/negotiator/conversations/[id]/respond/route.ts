import { NextRequest } from 'next/server';
import {
  getAuthenticatedWallet,
  getAiConversationWithMessages,
  appendAiResponseIfPending,
  validatePayload,
} from '@/lib/ai-negotiator-db';
import { generateAiNegotiation, reconstructAuthoritativeNegotiationState } from '@/lib/ai-negotiator-engine';
import type { NegotiationStateData } from '@/db/schema';

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

    // Phase A: Load conversation tail & capture expected user message ID
    const conversation = await getAiConversationWithMessages(wallet, conversationId);
    if (!conversation) {
      return Response.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const messages = conversation.messages || [];
    if (messages.length === 0) {
      return Response.json({ error: 'No messages found in conversation' }, { status: 400 });
    }

    const tail = messages[messages.length - 1];

    // Strict Tail Invariant: Only proceed if actual conversation tail is a user message
    if (tail.role !== 'user') {
      return Response.json(
        { error: 'Conversation is not currently awaiting an AI response', code: 'CONVERSATION_NOT_AWAITING_AI' },
        { status: 400 }
      );
    }

    const expectedUserMessageId = tail.id;
    const prompt = tail.content;

    if (!prompt.trim()) {
      return Response.json({ error: 'No valid user prompt found to negotiate' }, { status: 400 });
    }

    // Extract authoritative negotiationState from FULL message history up to previous turn
    const previousMessages = messages.length > 1 ? messages.slice(0, -1) : [];
    const previousNegotiationState = previousMessages.length > 0
      ? await reconstructAuthoritativeNegotiationState(previousMessages)
      : undefined;

    // Build context with hard cap (last 10 messages)
    // Preserves newest turns and always includes the current user message (tail).
    const contextCapMessages = messages.slice(-10);
    const contextMessages = contextCapMessages.map((m) => ({
      role: (m.role === 'user' ? 'user' : 'ai') as 'user' | 'ai',
      content: m.content,
      payload: (m.suggestions || m.sellers || m.attachment || m.negotiationState || m.pendingClarification || m.resolvedActions)
        ? {
            suggestions: m.suggestions,
            sellers: m.sellers,
            attachment: m.attachment,
            negotiationState: m.negotiationState,
            pendingClarification: m.pendingClarification,
            resolvedActions: m.resolvedActions,
          }
        : undefined,
    }));

    // Phase A: Generate AI response OUTSIDE a DB transaction (external Groq/OpenAI/RPC calls)
    const engineRes = await generateAiNegotiation({
      currentPrompt: prompt,
      messages: contextMessages,
      previousNegotiationState,
    });

    const rawPayload = {
      suggestions: engineRes.suggestions,
      sellers: engineRes.sellers,
      intent: engineRes.intent,
      negotiationState: engineRes.negotiationState,
      attachment: engineRes.attachment,
      pendingClarification: engineRes.pendingClarification,
      resolvedActions: engineRes.resolvedActions,
    };

    const payloadValidation = validatePayload(rawPayload);
    if (!payloadValidation.valid) {
      return Response.json({ error: payloadValidation.error || 'Invalid payload structure' }, { status: 400 });
    }

    // Phase B: Short atomic persistence transaction under conversation-scoped advisory lock
    const result = await appendAiResponseIfPending(
      wallet,
      conversationId,
      expectedUserMessageId,
      engineRes.message,
      payloadValidation.cleaned
    );

    if (!result.success) {
      if (result.reason === 'AI_RESPONSE_ALREADY_EXISTS' && result.existingMessage) {
        // Return existing AI response with 200 OK so client syncs without scary error
        return Response.json(result.existingMessage, { status: 200 });
      }

      if (result.reason === 'CONVERSATION_TAIL_CHANGED') {
        return Response.json(
          { error: 'Conversation state changed while generating AI response', code: 'CONVERSATION_TAIL_CHANGED' },
          { status: 409 }
        );
      }

      return Response.json({ error: 'Failed to persist AI response' }, { status: 500 });
    }

    return Response.json(result.message, { status: 201 });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to generate AI response' }, { status: 500 });
  }
}
