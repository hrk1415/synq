import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { checkCommitteeSignerStatus } from '@/lib/deals/v2-committee-signer';
import {
  DrizzleProtectionClaimDecisionRepository,
  ProtectionCommitteeAuthError,
  ProtectionCommitteeValidationError,
} from '@/lib/deals/protection-committee-db';
import {
  formatSubmitClaimDecisionTx,
  type ProtectionClaimDecisionAuthData,
} from '@/lib/deals/v2-protection-committee';
import { getAddress } from 'viem';

interface RouteContext {
  params: Promise<{
    decisionId: string;
  }>;
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json(
        { error: 'Unauthorized: valid wallet session required' },
        { status: 401 }
      );
    }

    const signerStatus = await checkCommitteeSignerStatus(authWallet);
    if (!signerStatus.isProtectionSigner) {
      return NextResponse.json(
        { error: 'Forbidden: wallet is not an active Protection Committee signer' },
        { status: 403 }
      );
    }

    const { decisionId } = await context.params;
    const repo = new DrizzleProtectionClaimDecisionRepository();

    const decision = await repo.getDecisionById(decisionId);
    if (!decision) {
      return NextResponse.json(
        { error: 'Protection claim decision not found' },
        { status: 404 }
      );
    }

    const signatures = await repo.getSignaturesByDecisionId(decisionId);
    const thresholdMet = signatures.length >= 2;

    let executionTx = null;
    if (thresholdMet) {
      const [s1, s2] = signatures;
      const authData: ProtectionClaimDecisionAuthData = {
        committee: getAddress(decision.committeeAddress),
        chainId: BigInt(decision.chainId),
        manager: getAddress(decision.managerAddress),
        deal: getAddress(decision.dealAddress),
        milestoneId: BigInt(decision.milestoneId),
        decision: decision.decision,
        decisionReportHash: decision.decisionReportHash as `0x${string}`,
        decisionNonce: BigInt(decision.decisionNonce),
        validUntil: BigInt(decision.validUntil),
      };

      executionTx = formatSubmitClaimDecisionTx({
        committeeAddress: getAddress(decision.committeeAddress),
        auth: authData,
        sig1: s1.signature as `0x${string}`,
        sig2: s2.signature as `0x${string}`,
      });
    }

    return NextResponse.json(
      {
        success: true,
        decision,
        signatures,
        thresholdMet,
        executionTx,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error('[GET /api/committee/protection/decisions/[decisionId]] Error:', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
