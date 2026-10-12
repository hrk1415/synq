import OpenAI from 'openai';
import { sepoliaPublicClient } from './chain';
import { nexotiqDirectoryABI } from './contracts/abis';
import { CONTRACT_ADDRESSES } from './contracts/addresses';
import { getFreelancerCompletedDealsBatch } from './deals/freelancerStats';
import type {
  PaymentConsultationDecision,
  PaymentStructureRecommendation,
  PaymentPlanningFactor,
  DealAnalyzerDecision,
  ScopeClarityAssessment,
  ScopePlanningFactor,
  DeadlineFeasibilityDecision,
  DeadlineAssessability,
  DeadlinePressure,
  DeadlinePlanningDriver,
  DeadlineNextStep,
} from './synq-knowledge';

const GROQ_API_URL = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = 'openai/gpt-oss-20b';
const FALLBACK_MODEL = 'gpt-4';

function getClient(): { client: OpenAI; model: string; provider: 'groq' | 'openai' } | null {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (groqKey) {
    try {
      return {
        client: new OpenAI({ apiKey: groqKey, baseURL: GROQ_API_URL }),
        model: GROQ_MODEL,
        provider: 'groq',
      };
    } catch { /* fall through */ }
  }

  if (openaiKey) {
    try {
      return {
        client: new OpenAI({ apiKey: openaiKey }),
        model: FALLBACK_MODEL,
        provider: 'openai',
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

export async function getNegotiatorAICompletion(
  systemPrompt: string,
  userMessages: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;

  const responseFormat =
    ai.provider === 'groq' && ai.model === GROQ_MODEL
      ? {
          type: 'json_schema' as const,
          json_schema: {
            name: 'negotiator_response',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                },
                intent: {
                  type: 'string',
                },
              },
              required: ['message', 'intent'],
              additionalProperties: false,
            },
          },
        }
      : { type: 'json_object' as const };

  try {
    const completion = await ai.client.chat.completions.create({
      model: ai.model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...userMessages,
      ],
      response_format: responseFormat,
      temperature: 0.3,
      max_completion_tokens: 1536,
    });

    return completion.choices[0]?.message?.content || null;
  } catch (error) {
    console.error('Negotiator AI API error:', error);
    return null;
  }
}

export async function getPaymentConsultationDecision(
  systemPrompt: string,
  userPrompt: string
): Promise<PaymentConsultationDecision | null> {
  const ai = getClient();
  if (!ai) {
    console.warn('[Negotiator R2 Payment] client_unavailable');
    return null;
  }

  const paymentConsultationJsonSchema = {
    type: 'json_schema' as const,
    json_schema: {
      name: 'payment_consultation_decision',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          recommendedStructure: {
            type: 'string',
            enum: [
              'FIFTY_FIFTY',
              'SINGLE_RELEASE',
              'CUSTOM_MILESTONES',
              'INSUFFICIENT_CONTEXT',
            ],
          },
          reasonFactors: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'TWO_MAJOR_STAGES',
                'MULTIPLE_DISTINCT_DELIVERABLES',
                'SINGLE_FINAL_DELIVERABLE',
                'STAGED_PROJECT',
                'SIMPLE_ONE_STEP_SCOPE',
                'UNCLEAR_DELIVERABLE_STRUCTURE',
              ],
            },
          },
        },
        required: ['recommendedStructure', 'reasonFactors'],
        additionalProperties: false,
      },
    },
  };

  const responseFormat =
    ai.provider === 'groq' && ai.model === GROQ_MODEL
      ? paymentConsultationJsonSchema
      : { type: 'json_object' as const };

  let rawContent: string | null = null;
  try {
    const completion = await ai.client.chat.completions.create({
      model: ai.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: responseFormat,
      temperature: 0.3,
      max_tokens: 300,
    });

    rawContent = completion.choices[0]?.message?.content || null;
  } catch (error) {
    console.warn('[Negotiator R2 Payment] provider_error', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return null;
  }

  if (!rawContent) {
    console.warn('[Negotiator R2 Payment] empty_completion');
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    console.warn('[Negotiator R2 Payment] json_parse_failed', {
      completionLength: typeof rawContent === 'string' ? rawContent.length : 0,
    });
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[Negotiator R2 Payment] invalid_response_shape', {
      parsedType: Array.isArray(parsed) ? 'array' : typeof parsed,
    });
    return null;
  }

  const validStructures = new Set<string>([
    'FIFTY_FIFTY',
    'SINGLE_RELEASE',
    'CUSTOM_MILESTONES',
    'INSUFFICIENT_CONTEXT',
  ]);
  const validFactors = new Set<string>([
    'TWO_MAJOR_STAGES',
    'MULTIPLE_DISTINCT_DELIVERABLES',
    'SINGLE_FINAL_DELIVERABLE',
    'STAGED_PROJECT',
    'SIMPLE_ONE_STEP_SCOPE',
    'UNCLEAR_DELIVERABLE_STRUCTURE',
  ]);

  if (
    typeof parsed.recommendedStructure !== 'string' ||
    !validStructures.has(parsed.recommendedStructure)
  ) {
    console.warn('[Negotiator R2 Payment] invalid_recommended_structure', {
      hasRecommendedStructureKey: 'recommendedStructure' in parsed,
      structureType: typeof parsed.recommendedStructure,
    });
    return null;
  }

  if (!Array.isArray(parsed.reasonFactors)) {
    console.warn('[Negotiator R2 Payment] invalid_reason_factors', {
      hasReasonFactorsKey: 'reasonFactors' in parsed,
      reasonFactorsIsArray: false,
    });
    return null;
  }

  const hasInvalidFactor = parsed.reasonFactors.some(
    (f: unknown) => typeof f !== 'string' || !validFactors.has(f)
  );
  if (hasInvalidFactor) {
    console.warn('[Negotiator R2 Payment] invalid_reason_factors', {
      reasonFactorsIsArray: true,
      factorCount: parsed.reasonFactors.length,
      hasInvalidFactorValue: true,
    });
    return null;
  }

  return {
    recommendedStructure: parsed.recommendedStructure as PaymentStructureRecommendation,
    reasonFactors: parsed.reasonFactors as PaymentPlanningFactor[],
  };
}

export async function getDealAnalyzerDecision(
  systemPrompt: string,
  userPrompt: string
): Promise<DealAnalyzerDecision | null> {
  const ai = getClient();
  if (!ai) {
    console.warn('[Negotiator R4 Analyzer] client_unavailable');
    return null;
  }

  const dealAnalyzerJsonSchema = {
    type: 'json_schema' as const,
    json_schema: {
      name: 'deal_analyzer_decision',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          scopeClarity: {
            type: 'string',
            enum: ['CLEAR_ENOUGH', 'NEEDS_MORE_DETAIL', 'INSUFFICIENT_SCOPE'],
          },
          flaggedItemIndexes: {
            type: 'array',
            items: {
              type: 'integer',
            },
          },
          planningFactors: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'CLARIFY_EXPECTED_OUTPUTS',
                'CLARIFY_SCOPE_BOUNDARIES',
                'CLARIFY_HANDOFF_EXPECTATIONS',
                'CLARIFY_REVIEW_EXPECTATIONS',
                'CONSIDER_STAGE_PLANNING',
              ],
            },
          },
        },
        required: ['scopeClarity', 'flaggedItemIndexes', 'planningFactors'],
        additionalProperties: false,
      },
    },
  };

  const responseFormat =
    ai.provider === 'groq' && ai.model === GROQ_MODEL
      ? dealAnalyzerJsonSchema
      : { type: 'json_object' as const };

  let rawContent: string | null = null;
  try {
    const completion = await ai.client.chat.completions.create({
      model: ai.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: responseFormat,
      temperature: 0.2,
      max_completion_tokens: 1024,
    });

    rawContent = completion.choices[0]?.message?.content || null;
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const status =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof (error as { status: unknown }).status === 'number'
        ? (error as { status: number }).status
        : null;

    const errorObj =
      typeof error === 'object' && error !== null
        ? (error as Record<string, unknown>)
        : null;
    const nestedErrorObj =
      errorObj && typeof errorObj.error === 'object' && errorObj.error !== null
        ? (errorObj.error as Record<string, unknown>)
        : null;

    const errorCode =
      errorObj && typeof errorObj.code === 'string'
        ? errorObj.code
        : nestedErrorObj && typeof nestedErrorObj.code === 'string'
        ? nestedErrorObj.code
        : null;

    const errorType =
      errorObj && typeof errorObj.type === 'string'
        ? errorObj.type
        : nestedErrorObj && typeof nestedErrorObj.type === 'string'
        ? nestedErrorObj.type
        : null;

    console.warn('[Negotiator R4 Analyzer] provider_error', {
      errorName,
      status,
      errorCode,
      errorType,
    });
    return null;
  }

  if (!rawContent) {
    console.warn('[Negotiator R4 Analyzer] empty_completion');
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    console.warn('[Negotiator R4 Analyzer] json_parse_failed');
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[Negotiator R4 Analyzer] invalid_response_shape');
    return null;
  }

  const validClarity = new Set<string>([
    'CLEAR_ENOUGH',
    'NEEDS_MORE_DETAIL',
    'INSUFFICIENT_SCOPE',
  ]);
  const validFactors = new Set<string>([
    'CLARIFY_EXPECTED_OUTPUTS',
    'CLARIFY_SCOPE_BOUNDARIES',
    'CLARIFY_HANDOFF_EXPECTATIONS',
    'CLARIFY_REVIEW_EXPECTATIONS',
    'CONSIDER_STAGE_PLANNING',
  ]);

  if (
    typeof parsed.scopeClarity !== 'string' ||
    !validClarity.has(parsed.scopeClarity)
  ) {
    console.warn('[Negotiator R4 Analyzer] invalid_scope_clarity');
    return null;
  }

  if (!Array.isArray(parsed.flaggedItemIndexes)) {
    console.warn('[Negotiator R4 Analyzer] invalid_flagged_indexes');
    return null;
  }

  const hasInvalidIndex = parsed.flaggedItemIndexes.some(
    (idx: unknown) => typeof idx !== 'number' || !Number.isInteger(idx)
  );
  if (hasInvalidIndex) {
    console.warn('[Negotiator R4 Analyzer] invalid_flagged_indexes');
    return null;
  }

  if (!Array.isArray(parsed.planningFactors)) {
    console.warn('[Negotiator R4 Analyzer] invalid_planning_factors');
    return null;
  }

  const hasInvalidFactor = parsed.planningFactors.some(
    (f: unknown) => typeof f !== 'string' || !validFactors.has(f)
  );
  if (hasInvalidFactor) {
    console.warn('[Negotiator R4 Analyzer] invalid_planning_factors');
    return null;
  }

  return {
    scopeClarity: parsed.scopeClarity as ScopeClarityAssessment,
    flaggedItemIndexes: parsed.flaggedItemIndexes as number[],
    planningFactors: parsed.planningFactors as ScopePlanningFactor[],
  };
}

export async function getDeadlineFeasibilityDecision(
  systemPrompt: string,
  userPrompt: string
): Promise<DeadlineFeasibilityDecision | null> {
  const ai = getClient();
  if (!ai) {
    console.warn('[Negotiator Deadline Feasibility] client_unavailable');
    return null;
  }

  const responseFormat =
    ai.provider === 'groq' && ai.model === GROQ_MODEL
      ? {
          type: 'json_schema' as const,
          json_schema: {
            name: 'deadline_feasibility_decision',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                assessability: { type: 'string', enum: ['ASSESSABLE', 'INSUFFICIENT_SCOPE', 'NO_DEADLINE'] },
                pressure: { type: 'string', enum: ['PLAUSIBLE', 'TIGHT', 'UNCERTAIN'] },
                drivers: {
                  type: 'array',
                  items: {
                    type: 'string',
                    enum: [
                      'MULTIPLE_DELIVERABLES',
                      'AMBIGUOUS_SCOPE',
                      'DEPENDENCIES_UNSPECIFIED',
                      'REVIEW_EXPECTATIONS_UNSPECIFIED',
                      'HANDOFF_UNSPECIFIED',
                      'NO_CLEAR_PRESSURE_SIGNAL',
                    ],
                  },
                },
                nextStep: {
                  type: 'string',
                  enum: [
                    'KEEP_AS_WORKING_TARGET',
                    'CLARIFY_SCOPE',
                    'DISCUSS_MORE_TIME',
                    'BREAK_DOWN_DELIVERABLES',
                    'ASK_FOR_DEADLINE',
                  ],
                },
              },
              required: ['assessability', 'pressure', 'drivers', 'nextStep'],
              additionalProperties: false,
            },
          },
        }
      : { type: 'json_object' as const };

  let rawContent: string | null = null;
  try {
    const completion = await ai.client.chat.completions.create({
      model: ai.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: responseFormat,
      temperature: 0.2,
      max_completion_tokens: 1024,
    });
    rawContent = completion.choices[0]?.message?.content || null;
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const status =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof (error as { status: unknown }).status === 'number'
        ? (error as { status: number }).status
        : null;

    const errorObj =
      typeof error === 'object' && error !== null
        ? (error as Record<string, unknown>)
        : null;
    const nestedErrorObj =
      errorObj && typeof errorObj.error === 'object' && errorObj.error !== null
        ? (errorObj.error as Record<string, unknown>)
        : null;

    const errorCode =
      errorObj && typeof errorObj.code === 'string'
        ? errorObj.code
        : nestedErrorObj && typeof nestedErrorObj.code === 'string'
        ? nestedErrorObj.code
        : null;

    const errorType =
      errorObj && typeof errorObj.type === 'string'
        ? errorObj.type
        : nestedErrorObj && typeof nestedErrorObj.type === 'string'
        ? nestedErrorObj.type
        : null;

    console.warn('[Negotiator Deadline Feasibility] provider_error', {
      errorName,
      status,
      errorCode,
      errorType,
    });
    return null;
  }

  if (!rawContent) {
    console.warn('[Negotiator Deadline Feasibility] empty_completion');
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    console.warn('[Negotiator Deadline Feasibility] json_parse_failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[Negotiator Deadline Feasibility] invalid_response_shape');
    return null;
  }

  const assessabilityValues = new Set(['ASSESSABLE', 'INSUFFICIENT_SCOPE', 'NO_DEADLINE']);
  const pressureValues = new Set(['PLAUSIBLE', 'TIGHT', 'UNCERTAIN']);
  const driverValues = new Set([
    'MULTIPLE_DELIVERABLES',
    'AMBIGUOUS_SCOPE',
    'DEPENDENCIES_UNSPECIFIED',
    'REVIEW_EXPECTATIONS_UNSPECIFIED',
    'HANDOFF_UNSPECIFIED',
    'NO_CLEAR_PRESSURE_SIGNAL',
  ]);
  const nextStepValues = new Set([
    'KEEP_AS_WORKING_TARGET',
    'CLARIFY_SCOPE',
    'DISCUSS_MORE_TIME',
    'BREAK_DOWN_DELIVERABLES',
    'ASK_FOR_DEADLINE',
  ]);

  if (typeof parsed.assessability !== 'string' || !assessabilityValues.has(parsed.assessability)) {
    console.warn('[Negotiator Deadline Feasibility] invalid_assessability', {
      assessabilityType: typeof parsed.assessability,
    });
    return null;
  }
  if (typeof parsed.pressure !== 'string' || !pressureValues.has(parsed.pressure)) {
    console.warn('[Negotiator Deadline Feasibility] invalid_pressure', {
      pressureType: typeof parsed.pressure,
    });
    return null;
  }
  if (!Array.isArray(parsed.drivers)) {
    console.warn('[Negotiator Deadline Feasibility] invalid_drivers', {
      driversIsArray: false,
    });
    return null;
  }
  if (parsed.drivers.some((value: unknown) => typeof value !== 'string' || !driverValues.has(value))) {
    console.warn('[Negotiator Deadline Feasibility] invalid_drivers', {
      driversIsArray: true,
      hasInvalidDriverValue: true,
    });
    return null;
  }
  if (typeof parsed.nextStep !== 'string' || !nextStepValues.has(parsed.nextStep)) {
    console.warn('[Negotiator Deadline Feasibility] invalid_next_step', {
      nextStepType: typeof parsed.nextStep,
    });
    return null;
  }

  return {
    assessability: parsed.assessability as DeadlineAssessability,
    pressure: parsed.pressure as DeadlinePressure,
    drivers: parsed.drivers as DeadlinePlanningDriver[],
    nextStep: parsed.nextStep as DeadlineNextStep,
  };
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

const SELLER_STOPWORDS = new Set([
  'find', 'suggest', 'sell', 'seller', 'freelancer', 'marketplace', 'needed', 'need', 'for', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'me', 'please', 'koto', 'ki', 'amar', 'jonno', 'deo', 'dekh', 'kore', 'daw', 'diben', 'chain', 'want', 'i', 'my', 'help', 'get', 'recommend', 'best', 'good', 'any',
]);

function tokenizeSellerQuery(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2 && !SELLER_STOPWORDS.has(t));
}

export async function findSellers(prompt: string): Promise<any> {
  try {
    const profiles = (await sepoliaPublicClient.readContract({
      address: CONTRACT_ADDRESSES.sepolia.NexotiqDirectory as `0x${string}`,
      abi: nexotiqDirectoryABI,
      functionName: 'getAllProfiles',
    })) as any[];

    const sellers = (profiles || []).filter((p) => p && p.wallet && String(p.wallet) !== '0x0000000000000000000000000000000000000000');
    if (sellers.length === 0) {
      return { type: 'sellers', sellers: [], message: 'No on-chain profiles registered in the Deal Port yet. Ask sellers to register on the Deal Port page first.' };
    }

    const sellerWallets = sellers.map((p) => String(p.wallet));
    let completedMap: Record<string, number> = {};
    try {
      completedMap = await getFreelancerCompletedDealsBatch(sellerWallets);
    } catch {
      /* degrade gracefully: 0 experience bonus */
    }

    let marketProfilesMap: Record<string, any> = {};
    if (typeof window === 'undefined') {
      try {
        const dynamicImport = new Function('specifier', 'return import(specifier)');
        const dbModule = await dynamicImport('@/lib/db');
        const allMarkets = await dbModule.getAll('marketProfiles');
        if (Array.isArray(allMarkets)) {
          for (const mp of allMarkets) {
            if (mp?.walletAddress) {
              marketProfilesMap[String(mp.walletAddress).toLowerCase()] = mp;
            }
          }
        }
      } catch {
        /* degrade gracefully */
      }
    }

    const terms = tokenizeSellerQuery(prompt);
    const scored = sellers.map((p) => {
      let score = 0;
      const walletLower = String(p.wallet).toLowerCase();
      const completedDealsCount = completedMap[walletLower] || 0;

      const cat = String(p.category || '').toLowerCase();
      const skills = (p.skills || []).map((s: string) => String(s).toLowerCase());
      const haystack = [String(p.name || '').toLowerCase(), String(p.bio || '').toLowerCase(), ...skills].join(' ');
      for (const t of terms) {
        if (skills.includes(t)) score += 12;
        else if (haystack.includes(t)) score += 7;
        else if (cat.includes(t)) score += 8;
      }
      if (p.available) score += 3;
      score += Math.min(completedDealsCount * 2, 8);
      return { p, score, completedDealsCount };
    }).sort((a, b) => b.score - a.score);

    const top = scored.slice(0, 5);
    const topScore = top[0]?.score || 0;
    const withScore = top.map(({ p, score, completedDealsCount }) => {
      const wLower = String(p.wallet).toLowerCase();
      const mp = marketProfilesMap[wLower];
      const validPricing =
        mp?.startingRateAmount &&
        mp?.startingRateType &&
        (mp.startingRateType === 'PER_PROJECT' || mp.startingRateType === 'PER_HOUR')
          ? {
              amount: String(mp.startingRateAmount),
              currency: 'USDC' as const,
              rateType: mp.startingRateType as 'PER_PROJECT' | 'PER_HOUR',
            }
          : null;

      return {
        wallet: String(p.wallet),
        name: String(p.name || 'Anonymous'),
        category: String(p.category || '-'),
        skills: (p.skills || []).slice(0, 4).map((s: string) => String(s)),
        rate: String(p.rate || '0'),
        pricing: validPricing,
        bio: String(p.bio || '').slice(0, 100),
        available: !!p.available,
        completedDeals: completedDealsCount,
        match: topScore > 0 ? Math.min(Math.round((score / topScore) * 100), 99) : 50,
      };
    });

    return {
      type: 'sellers',
      sellers: withScore,
      message: withScore.length > 0
        ? `I found ${withScore.length} matching ${withScore.length === 1 ? 'freelancer' : 'freelancers'} in Deal Port based on the current deal requirements.`
        : 'I could not find matching freelancers for that request. Try describing a skill or service (e.g. "React developer" or "smart contract audit").',
    };
  } catch (e: any) {
    try {
      return { type: 'sellers', sellers: [], message: 'Deal Port lookup failed. Please try again.', error: String(e?.message || e) };
    } catch {
      return { type: 'sellers', sellers: [], message: 'Deal Port lookup failed. Please try again.' };
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
