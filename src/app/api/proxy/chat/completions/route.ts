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
    const model = body.model || 'gpt-4o';
    const provider = body.provider || 'openai';
    const targetApiUrl = body.targetApiUrl || 'https://api.openai.com/v1';
    const userMessage = body.messages?.[body.messages.length - 1]?.content || 'Hello!';

    const providerDisplay =
      provider === 'gemini' ? 'Google Gemini' :
      provider === 'groq' ? 'Groq Ultra-Fast' :
      provider === 'anthropic' ? 'Anthropic Claude' : 'OpenAI';

    // Simulated verified Latch proxy response across any provider
    return NextResponse.json({
      id: `chatcmpl-${Math.random().toString(36).substring(2, 11)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      provider: providerDisplay,
      upstream_url: targetApiUrl,
      proxy_authenticated: true,
      safe_token_verified: token.startsWith('lat_'),
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `[${providerDisplay} via Latch Proxy] Successfully verified model "${model}". Prompt received: "${userMessage}". Your raw API key was never exposed to the agent.`,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 18,
        completion_tokens: 28,
        total_tokens: 46,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: { message: error?.message || 'Proxy simulation error' } },
      { status: 500 }
    );
  }
}
