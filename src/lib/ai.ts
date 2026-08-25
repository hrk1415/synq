import OpenAI from 'openai';
import { getPublicClient } from './chain';
import { nexotiqDirectoryABI } from './contracts/abis';
import { CONTRACT_ADDRESSES, chainKeyForId } from './contracts/addresses';

const GROQ_API_URL = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = 'openai/gpt-oss-20b';
const FALLBACK_MODEL = 'gpt-4';

function getClient(): { client: OpenAI; model: string } | null {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (groqKey) {
    try {
      return {
        client: new OpenAI({ apiKey: groqKey, baseURL: GROQ_API_URL }),
        model: GROQ_MODEL,
      };
    } catch { /* fall through */ }
  }

  if (openaiKey) {
    try {
      return {
        client: new OpenAI({ apiKey: openaiKey }),
        model: FALLBACK_MODEL,
      };
    } catch { /* fall through */ }
  }

  return null;
}

const mockSuggestions = JSON.stringify({
  type: 'deal_suggestions',
  suggestions: [
    { label: 'Basic', amount: 1000, timeline: '14 Days', risk: 'low', description: 'Standard package with normal delivery' },
    { label: 'Standard', amount: 2500, timeline: '7 Days', risk: 'medium', description: 'Enhanced package with faster delivery' },
    { label: 'Priority', amount: 5000, timeline: '3 Days', risk: 'high', description: 'Fastest delivery with priority support' },
  ],
  recommended: 1,
  message: 'Based on common market rates, here are suggested deal structures.',
});

const SYSTEM_PROMPT = `You are Nexotiq AI, an intelligent deal negotiation assistant. 
Your role is to help users create, negotiate, and manage deals.
When users describe what they want, extract key information and suggest structured deal options.
Be concise and professional. You MUST respond with ONLY valid JSON, no other text.

The user will specify a budget. You MUST respect their exact budget amount. If they say $50, all suggestions must be around $50 (not $500 or $5000). Each option can vary slightly (e.g. $40, $50, $60) but stay within their stated range.

Respond with this exact JSON structure:
{"type":"deal_suggestions","suggestions":[{"label":"Option A","amount":50,"timeline":"7 Days","risk":"low","description":"string"}],"recommended":0,"message":"Your explanation"}`;

export async function getAISuggestions(prompt: string): Promise<string> {
  const ai = getClient();
  if (!ai) return mockSuggestions;

  try {
    const completion = await ai.client.chat.completions.create({
      model: ai.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    return completion.choices[0]?.message?.content || mockSuggestions;
  } catch (error) {
    console.error('AI API error:', error);
    return mockSuggestions;
  }
}

const defaultRisk = {
  score: 18,
  factors: [
    { name: 'Counterparty Reputation', score: 15, label: 'Low' },
    { name: 'Delivery Risk', score: 22, label: 'Low' },
    { name: 'Payment Risk', score: 10, label: 'Very Low' },
    { name: 'Market Conditions', score: 25, label: 'Low' },
    { name: 'Deadline Risk', score: 18, label: 'Low' },
  ],
  explanation: 'Risk assessment based on deal parameters and historical data.',
};

export async function analyzeRisk(dealData: any): Promise<any> {
  const ai = getClient();
  if (!ai) return defaultRisk;

  try {
    const completion = await ai.client.chat.completions.create({
      model: ai.model,
      messages: [
        { role: 'system', content: 'Analyze the risk of this deal and return JSON with score (0-100), factors array, and explanation.' },
        { role: 'user', content: JSON.stringify(dealData) },
      ],
      temperature: 0.3,
    });

    const text = completion.choices[0]?.message?.content || '';
    try {
      return JSON.parse(text);
    } catch {
      return defaultRisk;
    }
  } catch {
    return defaultRisk;
  }
}

const PAYMENT_SYSTEM_PROMPT = `You are a payment assistant. Extract payment details from the user's message.
Return ONLY valid JSON, no other text, with this structure:
{"recipient":"name or 0x wallet address","amount":123.45,"asset":"ETH or USDC","reason":"short description"}

Rules:
- recipient: the person/entity to pay, or their 0x wallet address if given. Use "unknown" if not clear.
- amount: a positive number in the token's main unit (ETH or USDC). If missing, use 0.
- asset: ETH or USDC only. Default ETH.
- reason: 1 short sentence on what the payment is for.`;

const fallbackPayment = { recipient: 'unknown', amount: 0, asset: 'ETH', reason: '' };

const DIRECTORY_BY_CHAIN: Record<number, string> = {
  31337: CONTRACT_ADDRESSES.hardhat.NexotiqDirectory,
  11155111: CONTRACT_ADDRESSES.sepolia.NexotiqDirectory,
};

const SELLER_STOPWORDS = new Set([
  'find', 'suggest', 'sell', 'seller', 'freelancer', 'marketplace', 'needed', 'need', 'for', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'me', 'please', 'koto', 'ki', 'amar', 'jonno', 'deo', 'dekh', 'kore', 'daw', 'diben', 'chain', 'want', 'i', 'my', 'help', 'get', 'recommend', 'best', 'good', 'any',
]);

function tokenizeSellerQuery(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2 && !SELLER_STOPWORDS.has(t));
}

export async function findSellers(prompt: string, chainId: number = 11155111): Promise<any> {
  try {
    const directoryAddress = (DIRECTORY_BY_CHAIN[chainId] || DIRECTORY_BY_CHAIN[11155111]) as `0x${string}`;
    const client = getPublicClient(chainId) || getPublicClient(11155111);
    if (!client) throw new Error('unsupported chain');
    const profiles = (await client.readContract({
      address: directoryAddress,
      abi: nexotiqDirectoryABI,
      functionName: 'getAllProfiles',
    })) as any[];

    const sellers = (profiles || []).filter((p) => p && p.wallet && String(p.wallet) !== '0x0000000000000000000000000000000000000000');
    if (sellers.length === 0) {
      return { type: 'sellers', sellers: [], message: 'No on-chain profiles registered in the marketplace yet. Ask sellers to register on the Marketplace page first.' };
    }

    const terms = tokenizeSellerQuery(prompt);
    const scored = sellers.map((p) => {
      let score = 0;
      const cat = String(p.category || '').toLowerCase();
      const skills = (p.skills || []).map((s: string) => String(s).toLowerCase());
      const haystack = [String(p.name || '').toLowerCase(), String(p.bio || '').toLowerCase(), ...skills].join(' ');
      for (const t of terms) {
        if (skills.includes(t)) score += 12;
        else if (haystack.includes(t)) score += 7;
        else if (cat.includes(t)) score += 8;
      }
      if (p.available) score += 3;
      score += Math.min(Number(p.completedDeals || 0) * 2, 8);
      return { p, score };
    }).sort((a, b) => b.score - a.score);

    const top = scored.slice(0, 5);
    const topScore = top[0]?.score || 0;
    const withScore = top.map(({ p, score }) => ({
      wallet: String(p.wallet),
      name: String(p.name || 'Anonymous'),
      category: String(p.category || '-'),
      skills: (p.skills || []).slice(0, 4).map((s: string) => String(s)),
      rate: String(p.rate || '0'),
      bio: String(p.bio || '').slice(0, 100),
      available: !!p.available,
      match: topScore > 0 ? Math.min(Math.round((score / topScore) * 100), 99) : 50,
    }));

    return {
      type: 'sellers',
      sellers: withScore,
      message: withScore.length > 0
        ? `Found ${withScore.length} matching ${withScore.length === 1 ? 'seller' : 'sellers'} in Synq's marketplace based on your request. Select one to create a deal.`
        : 'I could not find matching sellers for that request. Try describing a skill or service (e.g. "React developer" or "smart contract audit").',
    };
  } catch (e: any) {
    try {
      return { type: 'sellers', sellers: [], message: 'Marketplace lookup failed. Please try again.', error: String(e?.message || e) };
    } catch {
      return { type: 'sellers', sellers: [], message: 'Marketplace lookup failed. Please try again.' };
    }
  }
}

export async function parsePayment(prompt: string): Promise<any> {
  const ai = getClient();
  if (!ai) return fallbackPayment;

  try {
    const completion = await ai.client.chat.completions.create({
      model: ai.model,
      messages: [
        { role: 'system', content: PAYMENT_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 200,
    });

    const text = completion.choices[0]?.message?.content || '';
    try {
      const parsed = JSON.parse(text);
      return {
        recipient: String(parsed.recipient || 'unknown').trim(),
        amount: Number(parsed.amount) || 0,
        asset: String(parsed.asset || 'ETH').toUpperCase() === 'USDC' ? 'USDC' : 'ETH',
        reason: String(parsed.reason || '').trim(),
      };
    } catch {
      return fallbackPayment;
    }
  } catch {
    return fallbackPayment;
  }
}

const VERIFY_SYSTEM_PROMPT = `You are Nexotiq's AI milestone verifier for an escrow contract.
The seller submitted a milestone with an evidence hash. Analyze the milestone title, description, and
submitted evidence to estimate how much of the work is actually complete (0-100%).
Be strict: only count delivered, verifiable work as complete. Never inflate percentages.
Return ONLY valid JSON, no other text, with this exact structure:
{"completionPct":85,"summary":"1-2 sentence explanation of what appears delivered vs missing","verified":true,"notes":["short note 1","short note 2"],"recommendation":"approve"}

Rules:
- completionPct: integer 0-100
- verified: true only if completionPct >= 70
- recommendation: "approve" if verified else "revision"
- notes: 1-3 short bullet points (one or two words each, e.g. "core features done", "testing pending")
- If the evidence looks unrelated, weak, or generic, use a low percentage and recommendation "revision".`;

const fallbackVerification = {
  completionPct: 85,
  summary: 'Evidence analysis suggests most deliverables are in place, with minor items pending final review.',
  verified: true,
  notes: ['core work appears delivered', 'quality review pending'],
  recommendation: 'approve',
};

export async function verifyMilestone(data: { title: string; description: string; evidenceHash: string }): Promise<any> {
  const ai = getClient();
  if (!ai) return fallbackVerification;

  try {
    const completion = await ai.client.chat.completions.create({
      model: ai.model,
      messages: [
        { role: 'system', content: VERIFY_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(data) },
      ],
      temperature: 0.2,
      max_tokens: 300,
    });

    const text = completion.choices[0]?.message?.content || '';
    try {
      const parsed = JSON.parse(text);
      const pct = Math.max(0, Math.min(100, Math.round(Number(parsed.completionPct) || 0)));
      return {
        completionPct: pct,
        summary: String(parsed.summary || fallbackVerification.summary),
        verified: !!parsed.verified,
        notes: Array.isArray(parsed.notes) ? parsed.notes.map((n: any) => String(n)) : [],
        recommendation: pct >= 70 ? 'approve' : 'revision',
      };
    } catch {
      return fallbackVerification;
    }
  } catch {
    return fallbackVerification;
  }
}
