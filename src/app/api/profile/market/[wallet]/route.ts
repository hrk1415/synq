import { NextRequest } from 'next/server';
import { getAll, create, update, query } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth';
import { validateUsdcPricing } from '@/lib/deals/pricing';

const isWallet = (w: unknown): w is string => typeof w === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w);

function isValidHttpUrl(urlString: unknown): boolean {
  if (typeof urlString !== 'string') return false;
  const trimmed = urlString.trim();
  if (trimmed === '') return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function genProjectId(): string {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildDefaultMarketProfile(walletLower: string) {
  return {
    wallet: walletLower,
    headline: '',
    secondaryCategories: [],
    about: '',
    typicalDelivery: '',
    links: {
      website: '',
      github: '',
      twitter: '',
      linkedin: '',
    },
    portfolio: [],
    startingRateAmount: null,
    startingRateCurrency: null,
    startingRateType: null,
    draftName: '',
    draftCategory: '',
    draftSkills: [],
    draftRate: '',
    draftBio: '',
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ wallet: string }> }) {
  try {
    const { wallet } = await params;
    if (!isWallet(wallet)) {
      return Response.json({ error: 'Valid 42-character EVM wallet address required' }, { status: 400 });
    }

    const walletLower = wallet.toLowerCase();

    // Check if requester is authenticated owner of this wallet
    const authUser = getUserFromRequest(req);
    const isOwner = !!authUser?.walletAddress && authUser.walletAddress.toLowerCase() === walletLower;

    const existingRecords = await query('marketProfiles', (item: any) =>
      item.walletAddress && String(item.walletAddress).toLowerCase() === walletLower
    );

    if (!existingRecords || existingRecords.length === 0) {
      return Response.json(buildDefaultMarketProfile(walletLower));
    }

    const record = existingRecords[0];
    return Response.json({
      wallet: walletLower,
      headline: typeof record.headline === 'string' ? record.headline : '',
      secondaryCategories: Array.isArray(record.secondaryCategories) ? record.secondaryCategories : [],
      about: typeof record.about === 'string' ? record.about : '',
      typicalDelivery: typeof record.typicalDelivery === 'string' ? record.typicalDelivery : '',
      links: {
        website: typeof record.links?.website === 'string' ? record.links.website : '',
        github: typeof record.links?.github === 'string' ? record.links.github : '',
        twitter: typeof record.links?.twitter === 'string' ? record.links.twitter : '',
        linkedin: typeof record.links?.linkedin === 'string' ? record.links.linkedin : '',
      },
      portfolio: Array.isArray(record.portfolio) ? record.portfolio : [],
      startingRateAmount: record.startingRateAmount ? String(record.startingRateAmount) : null,
      startingRateCurrency: (record.startingRateCurrency as string) || null,
      startingRateType: (record.startingRateType as string) || null,

      // Draft Directory fields — exposed ONLY to authenticated wallet owner
      draftName: isOwner && typeof record.draftName === 'string' ? record.draftName : '',
      draftCategory: isOwner && typeof record.draftCategory === 'string' ? record.draftCategory : '',
      draftSkills: isOwner && Array.isArray(record.draftSkills) ? record.draftSkills : [],
      draftRate: isOwner && typeof record.draftRate === 'string' ? record.draftRate : '',
      draftBio: isOwner && typeof record.draftBio === 'string' ? record.draftBio : '',
    });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to fetch rich market profile' }, { status: 500 });
  }
}

async function handleUpdate(req: NextRequest, { params }: { params: Promise<{ wallet: string }> }) {
  try {
    const { wallet } = await params;
    if (!isWallet(wallet)) {
      return Response.json({ error: 'Valid 42-character EVM wallet address required' }, { status: 400 });
    }

    const walletLower = wallet.toLowerCase();

    // Mandatory Bearer token authentication
    const authUser = getUserFromRequest(req);
    if (!authUser) {
      return Response.json({ error: 'Authentication required to update market profile' }, { status: 401 });
    }

    if (!authUser.walletAddress || authUser.walletAddress.toLowerCase() !== walletLower) {
      return Response.json({ error: 'Unauthorized: Bearer token wallet does not match route wallet' }, { status: 403 });
    }

    const body = await req.json();
    const bodyWallet = body.wallet || body.walletAddress;
    if (bodyWallet) {
      if (!isWallet(bodyWallet)) {
        return Response.json({ error: 'Invalid wallet address format in request body' }, { status: 400 });
      }
      if (bodyWallet.toLowerCase() !== walletLower) {
        return Response.json({ error: 'Body wallet address does not match route wallet parameter' }, { status: 400 });
      }
    }

    const {
      headline,
      secondaryCategories,
      about,
      typicalDelivery,
      links,
      portfolio,
      startingRateAmount,
      startingRateCurrency,
      startingRateType,
      draftName,
      draftCategory,
      draftSkills,
      draftRate,
      draftBio,
    } = body || {};

    // 1. Headline validation (max 100 chars)
    const trimmedHeadline = typeof headline === 'string' ? headline.trim() : '';
    if (trimmedHeadline.length > 100) {
      return Response.json({ error: 'Headline exceeds 100 characters limit' }, { status: 400 });
    }

    // 2. Secondary categories validation (max 4, max 40 chars each, deduplicate preserving casing)
    const cleanSecondary: string[] = [];
    if (Array.isArray(secondaryCategories)) {
      const seenCats = new Set<string>();
      for (const cat of secondaryCategories) {
        if (typeof cat !== 'string') continue;
        const trimmedCat = cat.trim();
        if (!trimmedCat) continue;
        if (trimmedCat.length > 40) {
          return Response.json({ error: 'Secondary category item exceeds 40 characters limit' }, { status: 400 });
        }
        const lowerCat = trimmedCat.toLowerCase();
        if (!seenCats.has(lowerCat)) {
          seenCats.add(lowerCat);
          cleanSecondary.push(trimmedCat);
        }
      }
    }
    if (cleanSecondary.length > 4) {
      return Response.json({ error: 'Maximum 4 secondary categories allowed' }, { status: 400 });
    }

    // 3. About validation (max 2000 chars)
    const trimmedAbout = typeof about === 'string' ? about.trim() : '';
    if (trimmedAbout.length > 2000) {
      return Response.json({ error: 'About section exceeds 2000 characters limit' }, { status: 400 });
    }

    // 4. Typical delivery validation (max 60 chars)
    const trimmedDelivery = typeof typicalDelivery === 'string' ? typicalDelivery.trim() : '';
    if (trimmedDelivery.length > 60) {
      return Response.json({ error: 'Typical delivery exceeds 60 characters limit' }, { status: 400 });
    }

    // 5. Links validation (website, github, twitter, linkedin max 300 chars, HTTP/HTTPS only)
    const cleanLinks = {
      website: '',
      github: '',
      twitter: '',
      linkedin: '',
    };
    if (links && typeof links === 'object') {
      const linkKeys = ['website', 'github', 'twitter', 'linkedin'] as const;
      for (const key of linkKeys) {
        const val = links[key];
        if (typeof val === 'string') {
          const trimmedVal = val.trim();
          if (trimmedVal.length > 300) {
            return Response.json({ error: `Link '${key}' exceeds 300 characters limit` }, { status: 400 });
          }
          if (trimmedVal !== '' && !isValidHttpUrl(trimmedVal)) {
            return Response.json({ error: `Link '${key}' must be a safe HTTP or HTTPS URL` }, { status: 400 });
          }
          cleanLinks[key] = trimmedVal;
        }
      }
    }

    // 6. Portfolio validation (max 6 projects)
    const cleanPortfolio: Array<{
      id: string;
      title: string;
      description: string;
      image: string;
      link: string;
      tags: string[];
    }> = [];

    if (Array.isArray(portfolio)) {
      if (portfolio.length > 6) {
        return Response.json({ error: 'Maximum 6 portfolio projects allowed' }, { status: 400 });
      }

      for (const proj of portfolio) {
        if (!proj || typeof proj !== 'object') {
          return Response.json({ error: 'Invalid portfolio project item' }, { status: 400 });
        }

        // Title: required when project exists, max 100 chars
        if (typeof proj.title !== 'string' || !proj.title.trim()) {
          return Response.json({ error: 'Portfolio project title is required' }, { status: 400 });
        }
        const projTitle = proj.title.trim();
        if (projTitle.length > 100) {
          return Response.json({ error: 'Portfolio project title exceeds 100 characters limit' }, { status: 400 });
        }

        // Description: max 600 chars
        const projDesc = typeof proj.description === 'string' ? proj.description.trim() : '';
        if (projDesc.length > 600) {
          return Response.json({ error: 'Portfolio project description exceeds 600 characters limit' }, { status: 400 });
        }

        // Image URL: max 500 chars, HTTP/HTTPS only
        const projImg = typeof proj.image === 'string' ? proj.image.trim() : '';
        if (projImg.length > 500) {
          return Response.json({ error: 'Portfolio project image URL exceeds 500 characters limit' }, { status: 400 });
        }
        if (projImg !== '' && !isValidHttpUrl(projImg)) {
          return Response.json({ error: 'Portfolio project image URL must be a safe HTTP or HTTPS URL' }, { status: 400 });
        }

        // Link URL: max 500 chars, HTTP/HTTPS only
        const projLink = typeof proj.link === 'string' ? proj.link.trim() : '';
        if (projLink.length > 500) {
          return Response.json({ error: 'Portfolio project link URL exceeds 500 characters limit' }, { status: 400 });
        }
        if (projLink !== '' && !isValidHttpUrl(projLink)) {
          return Response.json({ error: 'Portfolio project link URL must be a safe HTTP or HTTPS URL' }, { status: 400 });
        }

        // Tags: max 8, max 40 chars each, deduplicate
        const cleanTags: string[] = [];
        if (Array.isArray(proj.tags)) {
          const seenTags = new Set<string>();
          for (const tag of proj.tags) {
            if (typeof tag !== 'string') continue;
            const trimmedTag = tag.trim();
            if (!trimmedTag) continue;
            if (trimmedTag.length > 40) {
              return Response.json({ error: 'Portfolio project tag exceeds 40 characters limit' }, { status: 400 });
            }
            const lowerTag = trimmedTag.toLowerCase();
            if (!seenTags.has(lowerTag)) {
              seenTags.add(lowerTag);
              cleanTags.push(trimmedTag);
            }
          }
        }
        if (cleanTags.length > 8) {
          return Response.json({ error: 'Maximum 8 tags allowed per portfolio project' }, { status: 400 });
        }

        // Stable ID strategy
        const projId = typeof proj.id === 'string' && proj.id.trim() ? proj.id.trim() : genProjectId();

        cleanPortfolio.push({
          id: projId,
          title: projTitle,
          description: projDesc,
          image: projImg,
          link: projLink,
          tags: cleanTags,
        });
      }
    }

    // 7. Modern USDC Starting Rate Validation
    let cleanStartingRateAmount: string | null | undefined = undefined;
    let cleanStartingRateCurrency: string | null | undefined = undefined;
    let cleanStartingRateType: string | null | undefined = undefined;

    if (startingRateAmount !== undefined) {
      if (startingRateAmount !== null && String(startingRateAmount).trim() !== '') {
        const pricingValidation = validateUsdcPricing(
          String(startingRateAmount),
          startingRateType,
          startingRateCurrency || 'USDC'
        );
        if (!pricingValidation.valid) {
          return Response.json({ error: pricingValidation.error || 'Invalid USDC pricing' }, { status: 400 });
        }
        cleanStartingRateAmount = pricingValidation.cleanAmount!;
        cleanStartingRateCurrency = 'USDC';
        cleanStartingRateType = pricingValidation.cleanType!;
      } else {
        cleanStartingRateAmount = null;
        cleanStartingRateCurrency = null;
        cleanStartingRateType = null;
      }
    }

    // 8. Draft fields validation (max limits, trim, deduplicate)
    const trimmedDraftName = typeof draftName === 'string' ? draftName.trim() : '';
    if (trimmedDraftName.length > 40) {
      return Response.json({ error: 'Draft name exceeds 40 characters limit' }, { status: 400 });
    }

    const trimmedDraftCategory = typeof draftCategory === 'string' ? draftCategory.trim() : '';
    if (trimmedDraftCategory.length > 30) {
      return Response.json({ error: 'Draft category exceeds 30 characters limit' }, { status: 400 });
    }

    const cleanDraftSkills: string[] = [];
    if (Array.isArray(draftSkills)) {
      const seenSkills = new Set<string>();
      for (const skill of draftSkills) {
        if (typeof skill !== 'string') continue;
        const trimmedSkill = skill.trim();
        if (!trimmedSkill) continue;
        if (trimmedSkill.length > 40) {
          return Response.json({ error: 'Draft skill item exceeds 40 characters limit' }, { status: 400 });
        }
        const lowerSkill = trimmedSkill.toLowerCase();
        if (!seenSkills.has(lowerSkill)) {
          seenSkills.add(lowerSkill);
          cleanDraftSkills.push(trimmedSkill);
        }
      }
    }
    if (cleanDraftSkills.length > 8) {
      return Response.json({ error: 'Maximum 8 draft skills allowed' }, { status: 400 });
    }

    const trimmedDraftRate = typeof draftRate === 'string' ? draftRate.trim() : '';
    if (trimmedDraftRate.length > 30) {
      return Response.json({ error: 'Draft rate exceeds 30 characters limit' }, { status: 400 });
    }
    if (trimmedDraftRate !== '') {
      const num = Number(trimmedDraftRate);
      if (isNaN(num) || num < 0) {
        return Response.json({ error: 'Draft rate must be a valid non-negative number' }, { status: 400 });
      }
    }

    const trimmedDraftBio = typeof draftBio === 'string' ? draftBio.trim() : '';
    if (trimmedDraftBio.length > 300) {
      return Response.json({ error: 'Draft bio exceeds 300 characters limit' }, { status: 400 });
    }

    // Save to DB
    const existingRecords = await query('marketProfiles', (item: any) =>
      item.walletAddress && String(item.walletAddress).toLowerCase() === walletLower
    );

    const profileData = {
      walletAddress: walletLower,
      headline: trimmedHeadline,
      secondaryCategories: cleanSecondary,
      about: trimmedAbout,
      typicalDelivery: trimmedDelivery,
      links: cleanLinks,
      portfolio: cleanPortfolio,
      ...(cleanStartingRateAmount !== undefined ? {
        startingRateAmount: cleanStartingRateAmount,
        startingRateCurrency: cleanStartingRateCurrency,
        startingRateType: cleanStartingRateType,
      } : {}),
      draftName: trimmedDraftName,
      draftCategory: trimmedDraftCategory,
      draftSkills: cleanDraftSkills,
      draftRate: trimmedDraftRate,
      draftBio: trimmedDraftBio,
    };

    let record: any;
    if (existingRecords && existingRecords.length > 0) {
      record = await update('marketProfiles', existingRecords[0].id, profileData);
    } else {
      record = await create('marketProfiles', {
        ...profileData,
        createdAt: new Date().toISOString(),
      });
    }

    const responseProfile = {
      wallet: walletLower,
      headline: record?.headline || '',
      secondaryCategories: Array.isArray(record?.secondaryCategories) ? record.secondaryCategories : [],
      about: record?.about || '',
      typicalDelivery: record?.typicalDelivery || '',
      links: {
        website: record?.links?.website || '',
        github: record?.links?.github || '',
        twitter: record?.links?.twitter || '',
        linkedin: record?.links?.linkedin || '',
      },
      portfolio: Array.isArray(record?.portfolio) ? record.portfolio : [],
      startingRateAmount: record?.startingRateAmount ? String(record.startingRateAmount) : null,
      startingRateCurrency: record?.startingRateCurrency || null,
      startingRateType: record?.startingRateType || null,
      draftName: record?.draftName || '',
      draftCategory: record?.draftCategory || '',
      draftSkills: Array.isArray(record?.draftSkills) ? record.draftSkills : [],
      draftRate: record?.draftRate || '',
      draftBio: record?.draftBio || '',
    };

    return Response.json({
      ok: true,
      profile: responseProfile,
    });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to update rich market profile' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, context: { params: Promise<{ wallet: string }> }) {
  return handleUpdate(req, context);
}

export async function POST(req: NextRequest, context: { params: Promise<{ wallet: string }> }) {
  return handleUpdate(req, context);
}

