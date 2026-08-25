import { NextRequest } from 'next/server';
import { getAISuggestions, analyzeRisk, parsePayment, findSellers } from '@/lib/ai';

const LOOKS_LIKE_SELLER_SEARCH = /find|suggest|recommend|marketplace|freelancer|freelance|seller|hire|someone|khoj|khuje|darkar|dorkar|lagbe|chai|looking for|developer|designer|expert|koto\s+(pai|chete|chai)/i;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    let { type, prompt, dealData, chainId } = body;
    prompt = String(prompt || '');
    if (type !== 'chatpay' && (type === 'find' || LOOKS_LIKE_SELLER_SEARCH.test(prompt))) {
      type = 'find';
    }

    if (type === 'chatpay') {
      const parsed = await parsePayment(prompt || '');
      return Response.json({ result: parsed });
    }

    if (type === 'find') {
      const found = await findSellers(prompt || '', Number(chainId) || 11155111);
      return Response.json({ result: found });
    }

    if (type === 'negotiate') {
      const raw = await getAISuggestions(prompt || '');
      let parsed: any = raw;
      if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw); } catch {
          const start = raw.indexOf('{');
          const end = raw.lastIndexOf('}');
          if (start !== -1 && end > start) {
            try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { parsed = { type: 'deal_suggestions', suggestions: [], recommended: 0, message: raw }; }
          } else {
            parsed = { type: 'deal_suggestions', suggestions: [], recommended: 0, message: raw };
          }
        }
      }
      return Response.json({ result: parsed });
    }

    if (type === 'risk') {
      const risk = await analyzeRisk(dealData);
      return Response.json({ risk });
    }

    return Response.json({ error: 'Invalid AI type' }, { status: 400 });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
