// test/SynqDealsV2Listing.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  fetchUserDealAddressesFromFactory,
  mergeAndDeduplicateDealAddresses,
  fetchV2DealsSummary,
  enrichDealsWithMetadata,
  determineCounterparty,
  V2_DEAL_STATE_LABELS,
  DEFAULT_V2_DEAL_TITLE,
  type DealContractState,
  type DealProposalMetadata,
} from '@/lib/deals/v2-deals-discovery';
import { SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import {
  InMemoryDealProposalRepository,
  type NewDealProposalRow,
} from '@/lib/deals/proposals-db';

describe('SYNQ Standard V2 /deals Listing Architecture Suite', () => {
  const FACTORY_V2 = SYNQ_V2_SEPOLIA_CONFIG.factory;
  const CLIENT_WALLET = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';
  const FREELANCER_WALLET = '0x2483e02233bd992ac1B8Ec5006320C726B6377fA';
  const OTHER_WALLET = '0xd646585Fb453be3698F6D959d796C1D86B832c04';

  const DEAL_A = '0x8334cBA9F1f9A12A8A46881910eE609EaC23D8C8';
  const DEAL_B = '0x03DFc116bb5484BEE0c8505B75DfA4E0bE50C8c2';
  const DEAL_C = '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807';

  // Requirement A & B: Source code inspection of src/app/deals/page.tsx
  describe('A & B. Source Verification (/deals page)', () => {
    const dealsPagePath = path.join(process.cwd(), 'src', 'app', 'deals', 'page.tsx');
    const content = fs.readFileSync(dealsPagePath, 'utf8');

    it('A: /deals does NOT use legacy NexotiqFactory.getUserDeals', () => {
      assert.strictEqual(content.includes('NexotiqFactory'), false, 'Must not reference NexotiqFactory');
      assert.strictEqual(content.includes('getUserDeals'), false, 'Must not call getUserDeals');
    });

    it('B: /deals uses canonical SynqFactoryV2 configuration', () => {
      assert.strictEqual(content.includes('SYNQ_V2_SEPOLIA_CONFIG.factory'), true, 'Must use V2 Factory');
      assert.strictEqual(content.includes('fetchUserDealAddressesFromFactory'), true, 'Must use V2 discovery function');
    });
  });

  // Requirement C & D: Client and Freelancer deals discovery
  describe('C & D. Factory Deal Discovery', () => {
    it('C: Client deals are discovered correctly from Factory V2', async () => {
      const mockClient = {
        readContract: async ({ functionName, args }: any) => {
          if (functionName === 'getDealsCountByClient') return 2n;
          if (functionName === 'getDealsCountByFreelancer') return 0n;
          if (functionName === 'getDealsByClient') {
            assert.strictEqual(args[1], 0n);
            assert.strictEqual(args[2], 2n);
            return [DEAL_A, DEAL_B];
          }
          return [];
        },
      };

      const { clientDeals, freelancerDeals } = await fetchUserDealAddressesFromFactory(
        mockClient,
        FACTORY_V2,
        CLIENT_WALLET,
      );

      assert.strictEqual(clientDeals.length, 2);
      assert.deepStrictEqual(clientDeals, [DEAL_A, DEAL_B]);
      assert.strictEqual(freelancerDeals.length, 0);
    });

    it('D: Freelancer deals are discovered correctly from Factory V2', async () => {
      const mockClient = {
        readContract: async ({ functionName, args }: any) => {
          if (functionName === 'getDealsCountByClient') return 0n;
          if (functionName === 'getDealsCountByFreelancer') return 1n;
          if (functionName === 'getDealsByFreelancer') {
            assert.strictEqual(args[1], 0n);
            assert.strictEqual(args[2], 1n);
            return [DEAL_B];
          }
          return [];
        },
      };

      const { clientDeals, freelancerDeals } = await fetchUserDealAddressesFromFactory(
        mockClient,
        FACTORY_V2,
        FREELANCER_WALLET,
      );

      assert.strictEqual(clientDeals.length, 0);
      assert.strictEqual(freelancerDeals.length, 1);
      assert.deepStrictEqual(freelancerDeals, [DEAL_B]);
    });
  });

  // Requirement E, F, G: Deduplication & address sanitization
  describe('E, F, G. Address Deduplication & Filtering', () => {
    it('E: Duplicate address returned in both lists is rendered exactly once', () => {
      const unique = mergeAndDeduplicateDealAddresses([DEAL_A, DEAL_B], [DEAL_B, DEAL_C]);
      assert.strictEqual(unique.length, 3);
      assert.strictEqual(unique.filter((a) => a.toLowerCase() === DEAL_B.toLowerCase()).length, 1);
    });

    it('F: Address deduplication is case-insensitive', () => {
      const unique = mergeAndDeduplicateDealAddresses([DEAL_A.toLowerCase()], [DEAL_A.toUpperCase()]);
      assert.strictEqual(unique.length, 1);
      assert.strictEqual(unique[0].toLowerCase(), DEAL_A.toLowerCase());
    });

    it('G: Invalid, empty, or zero address fails safely and is excluded', () => {
      const unique = mergeAndDeduplicateDealAddresses(
        ['', 'not-an-address', '0x0000000000000000000000000000000000000000', DEAL_A],
        ['0x123', '   ', DEAL_B],
      );
      assert.strictEqual(unique.length, 2);
      assert.strictEqual(unique.includes(DEAL_A as any), true);
      assert.strictEqual(unique.includes(DEAL_B as any), true);
    });
  });

  // Requirement H, I, J, K, L: Canonical V2 DealState mapping
  describe('H, I, J, K, L. V2 DealState Mapping', () => {
    it('H: V2 DealState 0 maps to Draft', () => {
      assert.strictEqual(V2_DEAL_STATE_LABELS['0'], 'Draft');
    });

    it('I: V2 DealState 1 maps to Active', () => {
      assert.strictEqual(V2_DEAL_STATE_LABELS['1'], 'Active');
    });

    it('J: V2 DealState 2 maps to Completed', () => {
      assert.strictEqual(V2_DEAL_STATE_LABELS['2'], 'Completed');
    });

    it('K: V2 DealState 3 maps to Terminated', () => {
      assert.strictEqual(V2_DEAL_STATE_LABELS['3'], 'Terminated');
    });

    it('L: V2 DealState 4 maps to Cancelled', () => {
      assert.strictEqual(V2_DEAL_STATE_LABELS['4'], 'Cancelled');
    });
  });

  // Requirement M, N, O: Metadata enrichment & authority rules
  describe('M, N, O. Metadata Enrichment & Authority Rules', () => {
    const statesMap = new Map<string, DealContractState>([
      [
        DEAL_A.toLowerCase(),
        {
          state: 1,
          client: CLIENT_WALLET as `0x${string}`,
          freelancer: FREELANCER_WALLET as `0x${string}`,
          totalEscrow: 5000000n,
        },
      ],
      [
        DEAL_B.toLowerCase(),
        {
          state: 2,
          client: CLIENT_WALLET as `0x${string}`,
          freelancer: FREELANCER_WALLET as `0x${string}`,
          totalEscrow: 10000000n,
        },
      ],
    ]);

    it('M: Metadata enriches a valid Factory deal with title, proposalId, createdAt', () => {
      const metadataMap: Record<string, DealProposalMetadata> = {
        [DEAL_A.toLowerCase()]: {
          title: 'Fullstack dApp Build',
          proposalId: '0xabc123',
          createdAt: '2026-10-06T04:33:51.314Z',
          protectionSelection: 'PREMIUM',
        },
      };

      const enriched = enrichDealsWithMetadata(
        [DEAL_A as `0x${string}`, DEAL_B as `0x${string}`],
        statesMap,
        metadataMap,
      );

      assert.strictEqual(enriched.length, 2);
      const dealA = enriched.find((d) => d.dealAddress === DEAL_A);
      assert.ok(dealA);
      assert.strictEqual(dealA?.title, 'Fullstack dApp Build');
      assert.strictEqual(dealA?.proposalId, '0xabc123');
      assert.strictEqual(dealA?.protectionSelection, 'PREMIUM');
      assert.strictEqual(dealA?.state, 1);
      assert.strictEqual(dealA?.totalEscrow, 5000000n);
    });

    it('N: Missing metadata does NOT hide a valid Factory deal (falls back safely)', () => {
      const metadataMap: Record<string, DealProposalMetadata> = {}; // empty metadata
      const enriched = enrichDealsWithMetadata(
        [DEAL_A as `0x${string}`],
        statesMap,
        metadataMap,
      );

      assert.strictEqual(enriched.length, 1);
      assert.strictEqual(enriched[0].dealAddress, DEAL_A);
      assert.strictEqual(enriched[0].title, DEFAULT_V2_DEAL_TITLE);
      assert.strictEqual(enriched[0].state, 1);
      assert.strictEqual(enriched[0].totalEscrow, 5000000n);
    });

    it('O: DB-only / non-Factory row CANNOT create a card', () => {
      // Suppose DB has a proposal pointing to DEAL_C, but Factory only returned DEAL_A
      const metadataMap: Record<string, DealProposalMetadata> = {
        [DEAL_C.toLowerCase()]: {
          title: 'Unmaterialized Fake Deal',
          proposalId: '0xfake',
          createdAt: '2026-10-06T00:00:00.000Z',
          protectionSelection: 'STANDARD',
        },
      };

      const enriched = enrichDealsWithMetadata(
        [DEAL_A as `0x${string}`], // Only DEAL_A was discovered on-chain!
        statesMap,
        metadataMap,
      );

      assert.strictEqual(enriched.length, 1);
      assert.strictEqual(enriched[0].dealAddress, DEAL_A);
      assert.strictEqual(enriched.some((d) => d.dealAddress === DEAL_C), false);
    });
  });

  // Requirement P, Q, R: UI link & role derivation
  describe('P, Q, R. Link and Participant Role Derivation', () => {
    it('P: Deals page links to /deals/[dealAddress]', () => {
      const dealsPagePath = path.join(process.cwd(), 'src', 'app', 'deals', 'page.tsx');
      const content = fs.readFileSync(dealsPagePath, 'utf8');
      assert.strictEqual(content.includes('href={`/deals/${deal.dealAddress}`}'), true);
    });

    it('Q: Wallet role Client is derived correctly when user is client', () => {
      const roleInfo = determineCounterparty(CLIENT_WALLET, CLIENT_WALLET, FREELANCER_WALLET);
      assert.strictEqual(roleInfo.role, 'Client');
      assert.strictEqual(roleInfo.counterpartyWallet, FREELANCER_WALLET);
    });

    it('R: Wallet role Freelancer is derived correctly when user is freelancer', () => {
      const roleInfo = determineCounterparty(FREELANCER_WALLET, CLIENT_WALLET, FREELANCER_WALLET);
      assert.strictEqual(roleInfo.role, 'Freelancer');
      assert.strictEqual(roleInfo.counterpartyWallet, CLIENT_WALLET);
    });
  });

  // Requirement S: Fault isolation / safe failure
  describe('S. Fault Isolation', () => {
    it('S: One failed contract read does NOT crash all deals', async () => {
      const mockClient = {
        readContract: async () => null,
        multicall: async ({ contracts }: any) => {
          // DEAL_A succeeds (4 results), DEAL_B fails (reverts)
          return [
            { status: 'success', result: 1 }, // DEAL_A state
            { status: 'success', result: CLIENT_WALLET }, // DEAL_A client
            { status: 'success', result: FREELANCER_WALLET }, // DEAL_A freelancer
            { status: 'success', result: 5000000n }, // DEAL_A escrow
            { status: 'failure', error: new Error('Reverted') }, // DEAL_B state
            { status: 'failure', error: new Error('Reverted') },
            { status: 'failure', error: new Error('Reverted') },
            { status: 'failure', error: new Error('Reverted') },
          ];
        },
      };

      const summaries = await fetchV2DealsSummary(mockClient, [
        DEAL_A as `0x${string}`,
        DEAL_B as `0x${string}`,
      ]);

      assert.strictEqual(summaries.size, 1);
      assert.strictEqual(summaries.has(DEAL_A.toLowerCase()), true);
      assert.strictEqual(summaries.has(DEAL_B.toLowerCase()), false);
      assert.strictEqual(summaries.get(DEAL_A.toLowerCase())?.state, 1);
    });
  });

  // Requirement T: Pagination bounds & continuation safety
  describe('T. Pagination Safety (>50 deals)', () => {
    it('T: Enumeration does not silently truncate >50 deals (fetches across pages)', async () => {
      const totalDeals = 120;
      const pagesRequested: { offset: bigint; limit: bigint }[] = [];

      const mockClient = {
        readContract: async ({ functionName, args }: any) => {
          if (functionName === 'getDealsCountByClient') return BigInt(totalDeals);
          if (functionName === 'getDealsCountByFreelancer') return 0n;
          if (functionName === 'getDealsByClient') {
            pagesRequested.push({ offset: args[1], limit: args[2] });
            const pageDeals = [];
            for (let i = 0; i < Number(args[2]); i++) {
              pageDeals.push(`0x${(Number(args[1]) + i + 1).toString(16).padStart(40, '0')}`);
            }
            return pageDeals;
          }
          return [];
        },
      };

      const { clientDeals } = await fetchUserDealAddressesFromFactory(
        mockClient,
        FACTORY_V2,
        CLIENT_WALLET,
        50, // page size 50
      );

      assert.strictEqual(clientDeals.length, 120);
      assert.strictEqual(pagesRequested.length, 3);
      assert.deepStrictEqual(pagesRequested[0], { offset: 0n, limit: 50n });
      assert.deepStrictEqual(pagesRequested[1], { offset: 50n, limit: 50n });
      assert.deepStrictEqual(pagesRequested[2], { offset: 100n, limit: 20n });
    });
  });

  // Database helper & metadata participant authorization
  describe('U, V, W. Database Metadata Repository Isolation', () => {
    const repo = new InMemoryDealProposalRepository();

    const sampleRow: NewDealProposalRow = {
      proposalId: '0x1111111111111111111111111111111111111111111111111111111111111111',
      proposalNonce: '1',
      chainId: 11155111,
      factoryAddress: FACTORY_V2,
      clientWallet: CLIENT_WALLET,
      freelancerWallet: FREELANCER_WALLET,
      canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      dealImplementation: '0x7E376b006Db7798165a6b8E6B191E20e791E4419',
      primaryResolver: OTHER_WALLET,
      emergencyResolver: OTHER_WALLET,
      milestonesHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
      isProtected: false,
      protectionModule: '0x0000000000000000000000000000000000000000',
      policyId: '0x0000000000000000000000000000000000000000000000000000000000000000',
      expiry: '2000000000',
      clientSignature: '0x' + '00'.repeat(65),
      title: 'Audited Escrow Deal',
      scope: 'Full stack audit',
      totalAmount: '5000000',
      milestones: [],
      protectionSelection: 'STANDARD',
    };

    it('U: Persists dealAddress and retrieves by dealAddress for participant', async () => {
      await repo.create(sampleRow);
      await repo.updateStatus(sampleRow.proposalId, 'ACCEPTED', {
        dealAddress: DEAL_A,
        terminalType: 'ACCEPTED',
      });

      // Participant client queries
      const asClient = await repo.getByDealAddressesForParticipant([DEAL_A], CLIENT_WALLET);
      assert.strictEqual(asClient.length, 1);
      assert.strictEqual(asClient[0].title, 'Audited Escrow Deal');

      // Participant freelancer queries
      const asFreelancer = await repo.getByDealAddressesForParticipant([DEAL_A], FREELANCER_WALLET);
      assert.strictEqual(asFreelancer.length, 1);
      assert.strictEqual(asFreelancer[0].title, 'Audited Escrow Deal');
    });

    it('W: Unauthorized third-party cannot read proposal metadata by dealAddress', async () => {
      const asThirdParty = await repo.getByDealAddressesForParticipant([DEAL_A], OTHER_WALLET);
      assert.strictEqual(asThirdParty.length, 0);
    });
  });

  // API Route /api/deals/metadata Authorization and Input Validation Tests
  describe('X. Metadata API Route Contract & Auth Guard', () => {
    it('Rejects unauthenticated requests with 401', async () => {
      const { POST } = await import('@/app/api/deals/metadata/route');
      const req = new (await import('next/server')).NextRequest('http://localhost/api/deals/metadata', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dealAddresses: [DEAL_A] }),
      });

      const res = await POST(req);
      assert.strictEqual(res.status, 401);
    });

    it('Rejects non-array dealAddresses with 400', async () => {
      const { signToken } = await import('@/lib/auth');
      const token = signToken({ userId: 'u1', walletAddress: CLIENT_WALLET });

      const { POST } = await import('@/app/api/deals/metadata/route');
      const req = new (await import('next/server')).NextRequest('http://localhost/api/deals/metadata', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ dealAddresses: 'not-an-array' }),
      });

      const res = await POST(req);
      assert.strictEqual(res.status, 400);
      const json = await res.json();
      assert.strictEqual(json.error, 'dealAddresses must be an array');
    });

    it('Rejects request with >100 addresses with 400', async () => {
      const { signToken } = await import('@/lib/auth');
      const token = signToken({ userId: 'u1', walletAddress: CLIENT_WALLET });

      const { POST } = await import('@/app/api/deals/metadata/route');
      const bigList = Array.from({ length: 101 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
      const req = new (await import('next/server')).NextRequest('http://localhost/api/deals/metadata', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ dealAddresses: bigList }),
      });

      const res = await POST(req);
      assert.strictEqual(res.status, 400);
      const json = await res.json();
      assert.strictEqual(json.error.includes('Too many deal addresses'), true);
    });

    it('Accepts empty array and returns empty metadata object', async () => {
      const { signToken } = await import('@/lib/auth');
      const token = signToken({ userId: 'u1', walletAddress: CLIENT_WALLET });

      const { POST } = await import('@/app/api/deals/metadata/route');
      const req = new (await import('next/server')).NextRequest('http://localhost/api/deals/metadata', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ dealAddresses: [] }),
      });

      const res = await POST(req);
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.deepStrictEqual(json, { metadata: {} });
    });
  });

  // Requirement Y: Public RPC Rate Limit & Batching Resilience
  describe('Y. Public RPC Rate Limit & Batching Resilience', () => {
    it('Y1: fetchUserDealAddressesFromFactory batches count queries via multicall', async () => {
      let multicallCalled = false;
      const mockClient = {
        readContract: async () => 0n,
        multicall: async ({ contracts }: any) => {
          multicallCalled = true;
          assert.strictEqual(contracts.length, 2);
          assert.strictEqual(contracts[0].functionName, 'getDealsCountByClient');
          assert.strictEqual(contracts[1].functionName, 'getDealsCountByFreelancer');
          return [
            { status: 'success', result: 1n },
            { status: 'success', result: 0n },
          ];
        },
      };

      const res = await fetchUserDealAddressesFromFactory(mockClient, FACTORY_V2, CLIENT_WALLET);
      assert.strictEqual(multicallCalled, true);
    });

    it('Y2: fetchUserDealAddressesFromFactory falls back safely if multicall throws', async () => {
      let readContractCalls = 0;
      const mockClient = {
        readContract: async ({ functionName }: any) => {
          readContractCalls++;
          if (functionName === 'getDealsCountByClient') return 1n;
          if (functionName === 'getDealsCountByFreelancer') return 0n;
          if (functionName === 'getDealsByClient') return [DEAL_A];
          return [];
        },
        multicall: async () => {
          throw new Error('Public RPC 429 Too Many Requests');
        },
      };

      const res = await fetchUserDealAddressesFromFactory(mockClient, FACTORY_V2, CLIENT_WALLET);
      assert.strictEqual(res.clientDeals.length, 1);
      assert.strictEqual(res.clientDeals[0], DEAL_A);
      assert.strictEqual(readContractCalls >= 2, true);
    });

    it('Y3: fetchV2DealsSummary chunks fallback reads to prevent connection pool exhaustion', async () => {
      let readCount = 0;
      const mockClient = {
        readContract: async ({ functionName }: any) => {
          readCount++;
          if (functionName === 'state') return 1;
          if (functionName === 'client') return CLIENT_WALLET;
          if (functionName === 'freelancer') return FREELANCER_WALLET;
          if (functionName === 'totalEscrow') return 5000000n;
          return null;
        },
        multicall: async () => {
          throw new Error('Rate limit exceeded');
        },
      };

      const summaries = await fetchV2DealsSummary(mockClient, [
        DEAL_A as `0x${string}`,
        DEAL_B as `0x${string}`,
      ]);

      assert.strictEqual(summaries.size, 2);
      assert.strictEqual(readCount, 8); // 4 functions * 2 deals
    });

    it('Y4: sepoliaPublicClient is configured with fallback transport', async () => {
      const { sepoliaPublicClient } = await import('@/lib/chain');
      assert.ok(sepoliaPublicClient);
      assert.strictEqual(sepoliaPublicClient.chain.id, 11155111);
      assert.strictEqual(sepoliaPublicClient.transport.type, 'fallback');
    });
  });
});
