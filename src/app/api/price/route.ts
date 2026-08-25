import { NextRequest } from 'next/server';

let cache: { key: string; price: number; ts: number } | null = null;
const CACHE_TTL = 60_000;

const COINGECKO_MAP: Record<string, string> = {
  ETH: 'ethereum',
  USDC: 'usd-coin',
};

export async function GET(req: NextRequest) {
  try {
    const token = (req.nextUrl.searchParams.get('token') || 'ETH').toUpperCase();
    const id = COINGECKO_MAP[token];
    if (!id) return Response.json({ error: 'Unsupported token' }, { status: 400 });

    if (cache && cache.key === token && Date.now() - cache.ts < CACHE_TTL) {
      return Response.json({ token, price: cache.price, cached: true });
    }

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
    const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json();
    const price = Number(data[id]?.usd);
    if (!price || price <= 0) throw new Error('No price');

    cache = { key: token, price, ts: Date.now() };
    return Response.json({ token, price, cached: false });
  } catch (e: any) {
    if (cache) return Response.json({ token: cache.key, price: cache.price, cached: true });
    return Response.json({ error: e.message }, { status: 502 });
  }
}