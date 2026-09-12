import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    if (!token) {
      return NextResponse.json(
        { error: { message: 'Missing Authorization header with Bearer token' } },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const model = body.model || 'gpt-4';
    const userMessage = body.messages?.[body.messages.length - 1]?.content || 'Hello!';

    // Simulated secure proxy AI response through Latch proxy
    return NextResponse.json({
      id: `chatcmpl-${Math.random().toString(36).substring(2, 11)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      proxy_authenticated: true,
      safe_token_verified: token.startsWith('lat_'),
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `[Latch Proxy Verified] Agent successfully received prompt: "${userMessage}". Your raw API key remained completely hidden.`,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 18,
        completion_tokens: 24,
        total_tokens: 42,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: { message: error?.message || 'Proxy simulation error' } },
      { status: 500 }
    );
  }
}
