import { NextRequest } from 'next/server';
import { analyzeRisk, parsePayment } from '@/lib/ai';
import { getAuthenticatedWallet } from '@/lib/ai-negotiator-db';
import { unauthorized } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const wallet = getAuthenticatedWallet(req);
    if (!wallet) {
      return unauthorized();
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Invalid request body. Expected JSON object.' }, { status: 400 });
    }

    const { type, prompt, dealData } = body;
    if (!type || typeof type !== 'string') {
      return Response.json({ error: 'Field "type" is required' }, { status: 400 });
    }

    if (type === 'chatpay') {
      const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
      if (!cleanPrompt) {
        return Response.json({ error: 'Field "prompt" is required for chatpay' }, { status: 400 });
      }
      if (cleanPrompt.length > 10_000) {
        return Response.json({ error: 'Prompt exceeds maximum length' }, { status: 400 });
      }
      const parsed = await parsePayment(cleanPrompt);
      return Response.json({ result: parsed });
    }

    if (type === 'risk') {
      if (!dealData || typeof dealData !== 'object' || Array.isArray(dealData)) {
        return Response.json({ error: 'Field "dealData" must be an object for risk analysis' }, { status: 400 });
      }
      const risk = await analyzeRisk(dealData);
      return Response.json({ risk });
    }

    return Response.json({ error: 'Invalid AI type' }, { status: 400 });
  } catch (e: any) {
    return Response.json({ error: 'Failed to process AI request' }, { status: 500 });
  }
}
