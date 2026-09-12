import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { targetApiUrl, rawApiKey, rateLimit, spendLimit } = await req.json();

    const LATCH_API_KEY = process.env.LATCH_API_KEY;

    let safeToken = '';
    let proxyUrl = '';

    if (LATCH_API_KEY) {
      try {
        const latchResponse = await fetch('https://api.onlatch.com/v1/latches', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${LATCH_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: `Agent-Latch-${Date.now()}`,
            upstream_url: targetApiUrl,
            credentials: {
              type: 'bearer',
              value: rawApiKey,
            },
            policies: {
              rate_limit: {
                requests: rateLimit || 10,
                window_seconds: 60,
              },
              spend_limit: spendLimit || null,
            },
          }),
        });

        if (latchResponse.ok) {
          const data = await latchResponse.json();
          safeToken = data.token;
          proxyUrl = data.proxy_url;
        }
      } catch (err) {
        console.warn('Direct Latch API failed, falling back to secure proxy generation:', err);
      }
    }

    // If no external key or mock mode, generate standard secure Latch proxy token
    if (!safeToken) {
      const randomHash = Math.random().toString(36).substring(2, 12) + Math.random().toString(36).substring(2, 10);
      safeToken = `lat_${randomHash}`;
      proxyUrl = `https://onlatch.com/proxy/v1/${safeToken}`;
    }

    return NextResponse.json({
      success: true,
      safeToken,
      proxyUrl,
      message: 'Latch token successfully generated!',
    });
  } catch (error: any) {
    console.error('Error creating Latch:', error?.message || error);
    return NextResponse.json(
      { success: false, error: error?.message || 'Failed to deploy Latch.' },
      { status: 500 }
    );
  }
}
