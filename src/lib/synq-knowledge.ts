/**
 * SYNQ — CANONICAL STATIC PRODUCT KNOWLEDGE MODULE
 * 
 * Authoritative static product, architecture, workflow, and limitation facts
 * for the Synq platform on Ethereum Sepolia.
 * 
 * AUTHORITY MODEL:
 * - Deterministic Engine: Canonical Draft mutation & readiness authority
 * - Synq Knowledge Module (this file): Static product, contract, & platform truth
 * - LLM: Natural-language explanation, drafting advice, & analysis only (zero mutation authority)
 * - Future Live Adapters: Dynamic user, deal, balance, & freelancer state
 * 
 * IMPORTANT:
 * - Contains NO live user, wallet, deal, or freelancer values.
 * - Imports low-level technical configuration from @/lib/contracts/addresses.
 * - Does NOT import from @/lib/ai-negotiator-engine to prevent circular dependencies.
 */

import {
  SEPOLIA_CHAIN_ID,
  CHAINS,
  TOKENS,
  CONTRACT_ADDRESSES,
  SUPPORTED_CHAIN_IDS,
} from '@/lib/contracts/addresses';

export type SynqFeatureAvailability =
  | 'implemented'
  | 'partial'
  | 'coming_soon'
  | 'redirect'
  | 'unverified';

export type SynqAuthorityLevel =
  | 'contract'
  | 'implementation'
  | 'ui'
  | 'frontend_derived'
  | 'unverified_runtime';

export interface KnownLimitation {
  id: string;
  summary: string;
  userFacingMeaning: string;
}

export const SYNQ_KNOWLEDGE = {
  // SECTION 1: PRODUCT DEFINITION
  product: {
    name: 'Synq',
    headline: 'On-Chain Deal Facilitation & Smart Escrow Operating System',
    description:
      'Synq is an Ethereum Sepolia-based collaboration and milestone escrow platform. It integrates conversational AI deal drafting, freelancer discovery, on-chain smart contract escrows with milestone payouts and dispute resolution, and Web3 utility surfaces.',
    status: 'testnet_mvp',
    mainnetAvailable: false,
    architectureOverview: [
      'Conversational deal formulation via AI Negotiator with deterministic draft state management',
      'Factory-deployed individual smart-contract escrows (NexotiqDeal via NexotiqFactory)',
      'Decentralized directory (NexotiqDirectory) and username registry (NexotiqRegistry)',
      'Off-chain enrichment for portfolios, verified client reviews, and notification settings',
      'Product areas also include Agent Controller, whose live deployment and proxy backend is temporarily unavailable while the feature is improved, and the Uniswap V2 testnet swap.',
    ],
  },

  // SECTION 2: NETWORK & ASSETS
  network: {
    name: CHAINS.sepolia?.name ?? 'Ethereum Sepolia',
    chainId: SEPOLIA_CHAIN_ID,
    supportedChainIds: SUPPORTED_CHAIN_IDS,
    isTestnet: true,
    supportedAssets: [
      {
        symbol: TOKENS.sepolia['0x0000000000000000000000000000000000000000'].symbol,
        address: '0x0000000000000000000000000000000000000000',
        decimals: TOKENS.sepolia['0x0000000000000000000000000000000000000000'].decimals,
        isNative: true,
      },
      {
        symbol: TOKENS.sepolia['0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'].symbol,
        address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        decimals: TOKENS.sepolia['0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'].decimals,
        isNative: false,
      },
    ],
    wrongNetworkHandling:
      'Frontend guards (ChainGuard and network hooks) block contract-writing actions if the user wallet is not connected to Ethereum Sepolia (Chain ID 11155111).',
  },

  // SECTION 3: NAVIGATION & FEATURE LOCATIONS
  navigation: {
    primarySidebar: [
      {
        id: 'negotiator',
        name: 'AI Negotiator',
        route: '/negotiator',
        availability: 'implemented' as SynqFeatureAvailability,
        purpose: 'Conversational deal formulation, draft management, and intelligent deal consultation/analysis.',
      },
      {
        id: 'marketplace',
        name: 'Deal Port',
        route: '/marketplace',
        availability: 'implemented' as SynqFeatureAvailability,
        purpose: 'Freelancer directory for discovering registered service providers, skills, rates, and portfolios.',
      },
      {
        id: 'deals',
        name: 'My Deals',
        route: '/deals',
        availability: 'implemented' as SynqFeatureAvailability,
        purpose: 'Overview of all user deals (as buyer or seller) filtered by on-chain status.',
      },
      {
        id: 'chatpay',
        name: 'ChatPay',
        route: '/chatpay',
        availability: 'unverified' as SynqFeatureAvailability,
        purpose: 'Conversational peer-to-peer wallet transfer assistant (separate from escrow deals; runtime unverified).',
      },
      {
        id: 'agentController',
        name: 'Agent Controller',
        route: '/agent-controller',
        availability: 'unverified' as SynqFeatureAvailability,
        purpose: 'Planned AI-provider configuration with credential protection, rate limits, and spending controls; its backend is temporarily unavailable while the feature is improved.',
      },
      {
        id: 'swap',
        name: 'Swap',
        route: '/swap',
        availability: 'implemented' as SynqFeatureAvailability,
        purpose: 'Sepolia testnet token exchange for ETH and testnet USDC using Uniswap V2 router.',
      },
    ],
    secondaryNav: [
      {
        id: 'settings',
        name: 'Profile / Settings',
        route: '/settings',
        availability: 'implemented' as SynqFeatureAvailability,
        accessNote: 'Accessible by clicking the user avatar/identity card at the bottom of the sidebar.',
        purpose: 'Manage personal profile, email notifications, Synq Registry handle, and directory seller profile.',
      },
      {
        id: 'help',
        name: 'Help Center',
        route: '/help',
        availability: 'implemented' as SynqFeatureAvailability,
        accessNote: 'Accessible via the popup menu on the bottom identity card.',
        purpose: 'Interactive buyer/seller guides and FAQs.',
      },
    ],
    routableNotPrimaryNav: [
      {
        id: 'messages',
        name: 'Direct Messages',
        route: '/messages',
        availability: 'implemented' as SynqFeatureAvailability,
        purpose: 'Off-chain buyer-seller communication and deal proposals (no direct sidebar link).',
      },
      {
        id: 'activity',
        name: 'Activity Feed',
        route: '/activity',
        availability: 'implemented' as SynqFeatureAvailability,
        purpose: 'Aggregated timeline of recent deal and transaction events (no direct sidebar link).',
      },
      {
        id: 'dealWorkspace',
        name: 'Deal Workspace',
        route: '/deals/[id]',
        availability: 'implemented' as SynqFeatureAvailability,
        purpose: 'On-chain management terminal for a specific deal (funding, milestones, payouts, revisions, disputes).',
      },
      {
        id: 'createDeal',
        name: 'Create Deal Wizard',
        route: '/deal/new',
        availability: 'implemented' as SynqFeatureAvailability,
        purpose: 'Multi-step wizard to deploy a new escrow deal via NexotiqFactory.',
      },
    ],
    specialRoutes: [
      {
        id: 'protection',
        name: 'Protection Dashboard',
        route: '/protection',
        availability: 'coming_soon' as SynqFeatureAvailability,
        note: 'Living Protection page exists, but Adaptive Protection for new deals is disabled / Coming Soon.',
      },
      {
        id: 'dashboard',
        name: 'Dashboard (Legacy)',
        route: '/dashboard',
        availability: 'redirect' as SynqFeatureAvailability,
        target: '/negotiator',
      },
      {
        id: 'escrow',
        name: 'Escrow (Legacy)',
        route: '/escrow',
        availability: 'redirect' as SynqFeatureAvailability,
        target: '/deals',
      },
    ],
  },

  // SECTION 4: CREATE DEAL WIZARD
  createDeal: {
    route: '/deal/new',
    stages: [
      { step: 0, name: 'Type', description: 'Deal title or category of work.' },
      { step: 1, name: 'Counterparty', description: 'Seller wallet address or selected freelancer.' },
      { step: 2, name: 'Budget', description: 'Total deal budget and payment token asset (ETH or Sepolia USDC).' },
      { step: 3, name: 'Deliverables', description: 'Detailed scope of work text description.' },
      { step: 4, name: 'Deadline', description: 'Delivery deadline date and time converting to a Unix timestamp.' },
      { step: 5, name: 'Payment', description: 'Selection of intended payment structure preset (50/50, Single, Custom).' },
      { step: 6, name: 'Protection', description: 'Option 1: No Protection (standard). Option 2: Adaptive Protection (disabled / Coming Soon).' },
      { step: 7, name: 'Review', description: 'Review summary terms and execute factory.createDeal(...) transaction.' },
    ],
    entryBehaviors: {
      open: 'User starts at Step 0 with empty fields.',
      freelancerPrefilled:
        'Navigated with ?seller=0x... from Deal Port or Negotiator. Skips Step 0 and preselects the counterparty at Step 1.',
      negotiatorHandoff:
        'Navigated with ?negotiatorConversationId=... Prefills title, counterparty, budget, deliverables, deadline, and payment structure from canonical draft.',
    },
    onChainDeployment:
      'Calling factory.createDeal(...) deploys a new NexotiqDeal instance with the agreed buyer, seller, total value, deadline, deliverables, and payment token. The newly deployed deal starts with ZERO milestones.',
  },

  // SECTION 5: PAYMENT STRUCTURES & PRESETS (INTENT VS EXECUTION)
  paymentStructures: {
    sharedExecutionReality:
      'CRITICAL: Selecting a payment structure preset in the Create Deal wizard or Negotiator draft sets UI and conversational intent ONLY. The factory.createDeal transaction does not accept milestone parameters. Every new deal deploys on-chain with zero milestones. All milestones must subsequently be configured and added in the Deal Workspace (/deals/[id]).',
    presets: {
      '50-50': {
        id: '50-50',
        label: '50/50 Milestones',
        visibleIntent: 'Two equal releases (50% each), paid sequentially after its deliverable is approved.',
        currentExecution:
          'Selection stores draft intent only. It does NOT automatically generate two milestones on-chain. Milestones must be added manually in the Deal Workspace.',
      },
      single: {
        id: 'single',
        label: 'Single Release',
        visibleIntent: '100% of the deal budget released in one payout after the final deliverable is approved.',
        currentExecution:
          'Selection stores draft intent only. It does NOT automatically generate a single milestone on-chain. A milestone must be added manually in the Deal Workspace.',
      },
      custom: {
        id: 'custom',
        label: 'Custom Milestones',
        visibleIntent: 'Custom payout stages and milestone amounts defined directly between the parties.',
        currentExecution:
          'Selection stores draft intent only. Milestones are added individually by the buyer in the Deal Workspace.',
      },
    },
  },

  // SECTION 6: DEAL LIFECYCLE
  dealLifecycle: {
    dealStatuses: [
      { id: 0, name: 'Draft', meaning: 'Enum entry only; factory-created deals immediately start in Active status.' },
      { id: 1, name: 'Active', meaning: 'Operational deal state. Milestones can be added, funded, worked on, and approved.' },
      { id: 2, name: 'Completed', meaning: 'Terminal settled state. Triggered when the final-index milestone is approved or dispute settles in full.' },
      { id: 3, name: 'Disputed', meaning: 'Frozen state. Normal actions are blocked until dispute is resolved or force-resolved.' },
      { id: 4, name: 'Cancelled', meaning: 'Terminal cancelled state. Escrow balance is refunded to buyer.' },
    ],
    idealUserWorkflow: [
      '1. Create Deal: Buyer deploys escrow deal container specifying seller, budget, deliverables, and deadline.',
      '2. Configure Milestones: Buyer adds milestones allocating amounts up to the total deal budget.',
      '3. Fund Escrow: Buyer deposits the full deal value (ETH or USDC) into the contract escrow.',
      '4. Work in Progress: Seller starts work on the active milestone.',
      '5. Submit Evidence: Seller completes milestone deliverables and submits proof (links, hash).',
      '6. Review: Buyer verifies the submitted deliverables.',
      '7. Revision or Approval: Buyer requests changes (returns to InProgress) or approves the deliverable.',
      '8. Payout Release: On approval, milestone funds are released directly to the seller on-chain.',
      '9. Deal Completion: Approving all deliverables completes the deal.',
    ],
    contractPermissivenessCaveat:
      'CONTRACT REALITY: In NexotiqDeal.sol, startMilestone and submitMilestone only require status == Active and msg.sender == seller. The contract does NOT verify escrowBalance >= totalValue before work starts or deliverables are submitted. However, the frontend UX (deriveDealUX.ts) hides start/submit actions until escrow is funded to protect the seller from unfunded work.',
  },

  // SECTION 7: MILESTONES
  milestones: {
    activeMilestoneStatuses: [
      { id: 0, name: 'Pending', meaning: 'Milestone created and awaiting start.' },
      { id: 1, name: 'InProgress', meaning: 'Work is currently being performed by seller, or revision was requested.' },
      { id: 2, name: 'Completed', meaning: 'Work deliverable submitted by seller with evidence; awaiting buyer review.' },
      { id: 3, name: 'Approved', meaning: 'Buyer approved the work; milestone funds have been released to the seller.' },
    ],
    unusedStatus: {
      id: 4,
      name: 'Rejected',
      meaning: 'Defined in MilestoneStatus enum on-chain, but UNUSED. No contract function sets a milestone to Rejected.',
    },
    authorities: {
      addMilestone: 'Buyer (or factory) while deal is Active and not disputed. Sum of milestones cannot exceed totalValue.',
      startMilestone: 'Seller only. Transitions milestone from Pending to InProgress.',
      submitMilestone: 'Seller only. Submits deliverable evidence hash/URI; transitions milestone from InProgress to Completed.',
      requestRevision: 'Buyer only. Returns milestone from Completed to InProgress without losing funds. Evidence remains stored.',
      approveMilestone: 'Buyer only. Transitions milestone from Completed to Approved and triggers on-chain payout release to seller.',
    },
    finalMilestoneCompletionGap:
      'CONTRACT BEHAVIOR: Approving a milestone releases that milestone\'s configured amount. In NexotiqDeal.sol, approving the milestone at the last array index (id == milestones.length - 1) sets the overall deal status to Completed. The contract does not verify that all earlier milestones are Approved before performing that completion transition. Normal product workflow (reviewing and approving milestones appropriately) must not be described as proof that this is contract-enforced. Never claim that all milestones being Approved is a contract-enforced prerequisite for deal completion.',
  },

  // SECTION 8: ESCROW & FINANCIAL TRUTH
  escrow: {
    funding: {
      mechanism: 'Buyer calls depositEscrow() locking totalValue in the deal contract.',
      assets: 'ETH (native via msg.value) or ERC20 (USDC via transferFrom).',
    },
    payoutRelease: {
      mechanism: 'Executing approveMilestone releases that specific milestone amount to the seller.',
      releasedAmountDefinition: 'Sum of all milestones currently in Approved status.',
      remainingEscrowDefinition: 'Current balance of ETH or USDC held in the deal escrow contract.',
    },
    cancellationRefunds: {
      mechanism: 'Calling cancelDeal() returns all remaining contract escrow balance directly to the buyer.',
      payoutProtection: 'Previously approved and released milestone payouts remain with the seller and cannot be clawed back.',
    },
    protocolFeeTruth: {
      configuredBps: 50,
      feeCollectorRole: 'Factory admin address capable of updating parameters and force-resolving disputes.',
      currentExecution:
        'Current milestone payout execution does not deduct a protocol fee. The Factory contains a configured 0.5% (50 bps) fee parameter, but NexotiqDeal._release transfers 100% of approved milestone amounts directly to the seller with zero deductions.',
    },
    underAllocationStrandingRisk:
      'CONTRACT LIMITATION: If total milestone allocations are less than totalValue, approving the final milestone completes the deal. Once completed (status != Active), remaining unallocated escrow cannot be withdrawn via normal cancel or release functions. Milestone amounts should sum exactly to total deal budget.',
  },

  // SECTION 9: DISPUTES
  disputes: {
    opening: 'Either buyer or seller can call openDispute(reason) while the deal is Active.',
    effectOnEscrow: 'Deal status changes to Disputed. All normal milestone additions, work submissions, payouts, and cancellations are frozen.',
    unaffectedFunds: 'Past approved milestone payouts were already released on-chain and cannot be clawed back.',
    storedFields: [
      'initiator (address)',
      'reason (string)',
      'createdAt (timestamp)',
      'resolved (bool)',
      'resolution (string)',
      'buyerApproved (bool)',
      'sellerApproved (bool)',
      'resolvedBy (address)',
    ],
    approvalSemantics:
      'buyerApproved and sellerApproved are generic mutual-consent flags. They indicate that both parties agree to finalize dispute settlement; they are NOT directional voting ballots.',
    resolutionOptions: [
      {
        value: 'release_to_seller',
        meaning: 'Transfers the entire remaining escrow balance to the seller and marks deal Completed.',
      },
      {
        value: 'refund_buyer',
        meaning: 'Transfers the entire remaining escrow balance back to the buyer and marks deal Cancelled.',
      },
    ],
    limitations: [
      'No split settlement (e.g. 50/50 split) exists in the contract; resolution is all-or-nothing to one party.',
      'No automatic timeout resolution.',
    ],
    adminAuthority:
      'The factory feeCollector (admin) can invoke forceResolveDeal to bypass party consent and settle dispute funds.',
    aiRole:
      'AI dispute analysis shown in the UI is purely advisory. AI has ZERO cryptographic keys, zero contract authority, and zero control over escrow funds.',
  },

  // SECTION 10: DEAL PORT (FREELANCER DIRECTORY)
  dealPort: {
    route: '/marketplace',
    purpose: 'Directory of registered service providers, skills, rates, on-chain handles, and client reviews.',
    availableFields: {
      onChainDirectory: [
        'wallet (address)',
        'name (string)',
        'category (string)',
        'skills (string[])',
        'rate (uint256 in wei)',
        'bio (string)',
        'available (bool)',
        'createdAt / lastUpdated (timestamps)',
        'completedDeals (uint256, non-authoritative)',
      ],
      onChainRegistry: ['Synq handle (unique username registered on NexotiqRegistry)'],
      offChainEnrichment: [
        'avatar URL',
        'headline',
        'secondary categories',
        'social links (GitHub, Twitter, LinkedIn, Website)',
        'portfolio project cards (title, description, image, link, tags)',
        'client reviews and star ratings',
      ],
    },
    authoritativeCompletedDealsRule:
      'Directory.completedDeals is NOT authoritative because Deal settlement does not call incrementCompletedDeals. The frontend independently derives completed deals by querying NexotiqFactory.getUserDeals and counting verified non-self completed deals (seller == freelancer && buyer != seller && status == 2).',
  },

  // SECTION 11: IDENTITY LAYERS
  identity: {
    layers: [
      {
        layer: 'Personal Off-Chain Profile',
        storage: 'PostgreSQL database (profiles table via /api/profile)',
        fields: ['name (display name)', 'avatar (base64 image)', 'email (private)'],
        auth: 'Wallet signature / JWT bearer token required to edit.',
        emailPrivacy: 'Email is private and used for notification events; it is NOT encrypted communication.',
      },
      {
        layer: 'Synq Handle (Registry)',
        storage: 'Ethereum Sepolia smart contract (NexotiqRegistry.sol)',
        mapping: 'Strict 1:1 bidirectional mapping between wallet address and username.',
        rules: [
          '3 to 32 bytes in length.',
          'Unique across all users.',
          'One active username per wallet.',
          'Case-sensitive in keccak256 hash.',
          'Contract has no character filtering or lowercase normalization (frontend enforces alphanumeric/underscore input validation).',
          'Cannot be transferred to another wallet (only renamed by owning wallet via updateUsername).',
        ],
      },
      {
        layer: 'Freelancer Directory Profile',
        storage: 'Ethereum Sepolia smart contract (NexotiqDirectory.sol)',
        functions: ['registerProfile', 'updateProfile', 'setAvailable'],
        fields: ['name', 'category', 'skills', 'rate', 'bio', 'available'],
      },
      {
        layer: 'Rich Market Metadata',
        storage: 'PostgreSQL database (market_profiles table via /api/profile/market)',
        fields: ['headline', 'secondary_categories', 'social links', 'portfolio projects'],
      },
    ],
  },

  // SECTION 12: REVIEWS
  reviews: {
    storage: 'Off-chain PostgreSQL database (reviews table via /api/reviews)',
    requirements: [
      'Authenticated via wallet session.',
      'Verified deal required: Reviewer must be the buyer of a confirmed Completed on-chain deal.',
      'Seller wallet is locked to the seller of that verified deal.',
      'One review allowed per completed deal.',
    ],
    effect: 'Reviews calculate public star ratings and review counts; they do not alter on-chain smart contract state.',
  },

  // SECTION 13: REPUTATION
  reputation: {
    contractDesign: 'NexotiqReputation.sol exists in repository contracts.',
    frontendTruth:
      'The frontend dynamically derives trust and reputation scores from real on-chain deal history (NexotiqFactory.getUserDeals) by evaluating settled deals, dispute counts, and completion rates.',
    supportRepresentation:
      'Reputation scores reflect verified on-chain deal completion performance on Ethereum Sepolia.',
  },

  // SECTION 14: AI NEGOTIATOR CAPABILITIES & AUTHORITY
  negotiator: {
    route: '/negotiator',
    capabilities: [
      'Conversational deal drafting and parameter updates.',
      'Deterministic canonical term mutation (title, deliverables, budget, asset, deadline, payment structure, seller).',
      'Read-only Deal Consultant (advice on budget, deadlines, and deal structures).',
      'Read-only Deal Analyzer (evaluates completeness and identifies missing terms).',
      'Interactive Draft Panel reflecting real-time draft state.',
      'Seamless handoff button to prefill the Create Deal wizard (/deal/new).',
      'Freelancer search and match recommendation.',
    ],
    canonicalTerms: [
      'seller / freelancer (wallet, handle, or display name)',
      'title (deal name)',
      'scope / deliverables (work description and individual deliverable items)',
      'budget amount & asset (ETH or Sepolia USDC)',
      'deadline (timestamp or relative duration)',
      'paymentStructure (custom, 50-50, or single)',
    ],
    categoryStatus: 'Category is NOT an independent canonical term key in the deterministic draft engine.',
    authorityRules: [
      'The LLM has ZERO mutation authority over canonical draft state.',
      'All draft mutations are extracted deterministically by the engine.',
      'Missing term analysis and draft readiness are computed deterministically.',
      'Consultant and Analyzer modes provide read-only intelligence only.',
    ],
    chatLimit: 10,
  },

  // SECTION 15: CHATPAY
  chatPay: {
    route: '/chatpay',
    purpose: 'Conversational peer-to-peer wallet transfer assistant.',
    execution:
      'Parses natural language payment requests (e.g. "Pay 0.05 ETH to Alice") into a direct transfer or ERC20 transaction confirmation.',
    relationshipToEscrow: 'Direct wallet-to-wallet transfer only; NO escrow or milestone protection.',
    reliabilityStatus:
      'Unverified / on-hold. Do NOT advertise ChatPay as a guaranteed platform feature for mission-critical payments.',
  },

  // SECTION 16: AGENT CONTROLLER
  agentController: {
    route: '/agent-controller',
    purpose: 'Synq product area intended to provide controlled external AI-provider access with rate and spending boundaries.',
    features: [
      'Intended provider configuration and credential-protection workflow.',
      'Intended request-rate and spending controls.',
      'Live backend deployment and proxy functionality is temporarily unavailable while the feature is being improved.',
    ],
    relationshipToSynq: 'Agent Controller is planned for further development; users should not rely on it for live provider-key deployment today.',
  },

  // SECTION 17: SWAP
  swap: {
    route: '/swap',
    network: 'Ethereum Sepolia only',
    protocol: 'Uniswap V2 Router on Sepolia',
    supportedPairs: 'Native ETH <-> Sepolia USDC',
    features: [
      'On-chain quote calculation via Uniswap V2 getAmountsOut.',
      'CoinGecko live market reference price reference.',
      '0.5% default slippage tolerance.',
    ],
    limitations: 'Subject to testnet Uniswap liquidity on Sepolia.',
  },

  // SECTION 18: ADAPTIVE PROTECTION
  adaptiveProtection: {
    route: '/protection',
    status: 'coming_soon' as SynqFeatureAvailability,
    newDealCreationStatus: 'Disabled with a "Coming Soon" badge in Step 6 of Create Deal wizard.',
    supportGuidance:
      'Adaptive Protection is currently disabled for new deals. All new deals operate under standard smart-contract escrow ("No Protection"). Do not claim active automated AI risk underwriting is live.',
  },

  // SECTION 19: KNOWN LIMITATIONS INVENTORY
  knownLimitations: [
    {
      id: 'sepolia_only',
      summary: 'Ethereum Sepolia Testnet Only',
      userFacingMeaning: 'Synq operates exclusively on Ethereum Sepolia testnet. Real mainnet funds cannot be used.',
    },
    {
      id: 'presets_do_not_create_milestones',
      summary: 'Payment Presets Are UI-Only at Creation',
      userFacingMeaning:
        'Selecting 50/50 or Single Release does not automatically generate milestones on-chain. Deals deploy with zero milestones and must be configured post-creation in the Deal Workspace.',
    },
    {
      id: 'zero_milestones_at_deploy',
      summary: 'New Deals Deploy With Zero Milestones',
      userFacingMeaning:
        'The factory deploys the escrow container only. Milestone titles, amounts, and dates are added by the buyer after creation.',
    },
    {
      id: 'unfunded_work_contract_gap',
      summary: 'Contract Permissiveness on Milestone Start',
      userFacingMeaning:
        'Contractually, a seller could start or submit a milestone before escrow is deposited. The frontend hides these actions until funded to keep work safe.',
    },
    {
      id: 'final_milestone_completion_gap',
      summary: 'Final Milestone Auto-Completes Deal',
      userFacingMeaning:
        'Approving the last milestone index completes the deal even if earlier milestones were unapproved. Milestones should be processed in order.',
    },
    {
      id: 'under_allocation_stranding',
      summary: 'Under-Allocated Escrow Can Become Stranded',
      userFacingMeaning:
        'If milestones sum to less than the total deal budget and the final deliverable is approved, the remaining escrow balance cannot be withdrawn through normal actions.',
    },
    {
      id: 'protocol_fee_inactive',
      summary: 'Protocol Fees Currently Not Deducted',
      userFacingMeaning:
        'Milestone releases currently transfer 100% of approved amounts to the seller. An inactive 0.5% parameter exists in the Factory contract.',
    },
    {
      id: 'adaptive_protection_disabled',
      summary: 'Adaptive Protection Disabled for New Deals',
      userFacingMeaning: 'Adaptive Protection is labeled Coming Soon and cannot be enabled during deal creation.',
    },
    {
      id: 'directory_completed_deals_non_authoritative',
      summary: 'Directory Completed Deals Non-Authoritative',
      userFacingMeaning:
        'On-chain Directory completedDeals counter is not incremented on deal completion. Completed deals are derived from factory deal history.',
    },
    {
      id: 'milestone_rejected_unused',
      summary: 'Milestone Rejected Enum Unused',
      userFacingMeaning:
        'Deliverables are never set to Rejected in active workflows. Dissatisfied buyers request revisions instead, which returns work to InProgress.',
    },
    {
      id: 'frontend_derived_reputation',
      summary: 'Reputation Scores Are Frontend-Derived',
      userFacingMeaning:
        'Displayed reputation is computed dynamically from past completed deals, volume, and disputes, rather than on-chain reputation contract calls.',
    },
    {
      id: 'chatpay_unverified_runtime',
      summary: 'ChatPay Runtime Reliability Unverified',
      userFacingMeaning:
        'ChatPay is an experimental peer-to-peer payment assistant; development is on hold and it is not guaranteed for production payments.',
    },
  ] as const satisfies readonly KnownLimitation[],

  // DYNAMIC DATA BOUNDARY
  dynamicDataBoundary: {
    description:
      'The following categories represent live, stateful, or wallet-specific data that must NOT be hardcoded in static knowledge. They require live queries from RPC, database, or API endpoints:',
    categories: [
      'Connected wallet address and chain connection status',
      'User deals list and deal statuses',
      'Individual deal escrow balance and deposited funds',
      'Milestone statuses, evidence hashes, and review states',
      'Freelancer catalog, profiles, skills, rates, and availability',
      'Specific freelancer Synq handles and portfolio projects',
      'Freelancer review counts, ratings, and testimonials',
      'Calculated freelancer completed deal counts',
      'Live token balances (ETH and USDC)',
      'Live Uniswap V2 swap quotes and exchange rates',
    ],
  },
} as const;

/**
 * Deterministic helper that formats a compact, highly grounded summary
 * of the authoritative Synq product knowledge for injection into LLM prompts.
 * 
 * - Pure function (zero side effects, zero DB/RPC/network calls)
 * - Concise and prompt-optimized
 * - Accurately conveys platform rules, routes, and critical limitations
 */
export function getSynqKnowledgeContext(): string {
  return `=== SYNQ PRODUCT KNOWLEDGE — VERIFIED CORE ===

ABOUT SYNQ
Synq is a Web3 deal platform currently running on Ethereum Sepolia.
It is designed to help clients and freelancers move through a deal from discussion to payment in one workflow.
The core flow is:
find or select a freelancer
→ discuss and prepare deal terms
→ create the deal
→ add milestones
→ fund escrow
→ complete and submit work
→ review the work
→ approve or request revision
→ release milestone payments
→ complete the deal

Synq also supports disputes when the two parties cannot resolve a problem normally.
Synq is currently a testnet product. Do not describe it as a mainnet or production financial platform.

CORE PRODUCT AREAS
Synq currently has 7 core product areas covered by this knowledge:
1. AI Negotiator
2. Deal Port
3. Create Deal
4. My Deals
5. Deal Workspace / Escrow
6. Profile & Identity
7. Reviews & Reputation

Swap is available as a separate utility.
Do not invent functionality for Synq features that are not described in this knowledge.

1. AI NEGOTIATOR
AI Negotiator helps a user prepare and understand a deal through conversation.
It can help work with these deal terms:
- freelancer / seller
- deal title
- scope and deliverables
- budget amount
- budget asset: ETH or USDC
- deadline
- payment structure

The user can naturally ask Synq to change supported deal terms (e.g. "set budget to 1 ETH", "change deadline to 7 days", "add responsive design to scope").
The system applies supported changes through Synq's deterministic deal draft engine.
The AI language model itself does not directly edit the canonical draft.

AI Negotiator can also act as a Deal Consultant to discuss:
- whether the scope is clear
- possible deal risks
- milestone structure
- payment structure
- deadline considerations
- negotiation considerations

It can also analyze the current draft using the deal information that is actually present.
It must not invent missing project requirements, market prices, freelancer statistics, or deal information.
When the draft is ready, the user can continue from the Negotiator into Create Deal.

2. DEAL PORT
Deal Port is Synq's freelancer discovery marketplace. It is NOT the user's deal-management dashboard.
Users go to Deal Port to discover and inspect freelancers before starting a deal.
Freelancer profiles can contain information such as name, Synq handle, category, skills, rate, bio/about, availability, portfolio, client reviews, and completed-deal information.
Specific freelancer information is live data. Do not invent a freelancer's completed-deal count, reviews, rating, availability, portfolio, rate, handle, or profile information unless provided by a live Synq data source.

3. CREATE DEAL
Create Deal is where a user turns agreed terms into a Synq deal.
The current flow covers deal type, counterparty, budget and asset, scope / deliverables, deadline, payment structure, Adaptive Protection selection, and final review and creation.
ETH and Sepolia USDC are supported deal assets. A user can also arrive here from AI Negotiator with prepared deal information.

PAYMENT STRUCTURES:
- 50/50: Intended to divide deal value into two equal payout stages when work has two meaningful delivery stages.
  IMPORTANT CURRENT BEHAVIOR: Selecting 50/50 does NOT automatically create two on-chain milestones, does NOT release 50% upon creation, and does NOT automatically pay either party. The selection represents intended payment structure; milestones still need to be added after deal creation.
- Single Release: Intended as one payout stage for the full deal value after agreed work is completed and approved.
  IMPORTANT CURRENT BEHAVIOR: Selecting Single Release does NOT automatically create a milestone or configure an on-chain payout. The milestone still needs to be configured after deal creation.
- Custom Milestones: Intended for parties using their own payout stages for projects with several meaningful phases or deliverables. Milestones are configured afterward in the Deal Workspace.
GENERAL PAYMENT PRESET RULE: 50/50, Single Release, and Custom Milestones represent payment intent during deal preparation. They do not automatically create on-chain milestones during Create Deal. A newly created deal begins without configured milestones. Milestones are added afterward through the Deal Workspace. Never tell a user that selecting a payment preset automatically releases money or automatically creates the corresponding milestones.

ADAPTIVE PROTECTION:
Adaptive Protection is not currently available for new deals. It is disabled / Coming Soon. Do not tell users they can enable or activate it on a current new deal.

4. MY DEALS
My Deals is the user's deal-management dashboard (different from Deal Port).
- Deal Port: discover freelancers.
- My Deals: view deals the connected user is already involved in (as buyer or seller) and their current deal status. From My Deals, a user can open the individual Deal Workspace.

5. DEAL WORKSPACE / ESCROW
The Deal Workspace is where an individual created deal is managed: deal information, milestones, escrow, submissions, approvals, revisions, deal status, disputes, and cancellation where allowed.

NORMAL DEAL FLOW:
create deal → add milestones → fund escrow → seller starts work → seller submits work/evidence → buyer reviews → buyer approves or requests revision → approved milestone payment is released → approval of the last configured milestone (the milestone at the last array index) marks the deal Completed.

ESCROW & FUNDING:
The buyer funds the deal escrow. In the smart contract, fundEscrow() deposits the full deal total into escrow in one transaction. Funding is a separate lifecycle action from deal creation and milestone approval; it is not milestone-by-milestone funding.
The normal Synq interface and workflow expect escrow funding before normal work begins. Users should not be casually encouraged to work on an unfunded deal. However, current on-chain contract execution does NOT enforce escrow funding as a hard technical prerequisite before the seller can start or submit work. Therefore, never describe "funded upfront" as a contract-enforced requirement.
Approving a milestone releases that milestone's configured amount to the seller. Previously released milestone payments are no longer part of remaining escrow. Cancelling a deal returns remaining unreleased escrow to the buyer according to current deal behavior. Do not describe creating a deal itself as paying the freelancer.

PROTOCOL FEES:
- Current milestone payout execution does not deduct a protocol fee.
- Factory contains a configured 0.5% (50 bps) fee parameter.
- Current Deal milestone release execution does not use that configured fee.
- Approved milestone amounts are currently released to the seller without that fee deduction.
- Negative grounding rule: Never convert this into the permanent product claim that "Synq has 0% fees" or "Synq charges no fees", and never claim that "Synq deducts 0.5% from every milestone payout". When asked about current execution, distinguish the configured fee parameter in the Factory from actual current payout execution where no protocol fee is deducted.

MILESTONES & APPROVAL:
A normal milestone moves through: Pending → In Progress → Submitted / Awaiting Review → Approved.
In underlying deal state, "Completed" represents a submitted milestone waiting for buyer review. It does NOT mean the milestone payment has already been approved. When the buyer approves the milestone, its payment is released. If the buyer requests a revision, the milestone returns to work/revision state so the seller can update and submit it again.
- In the normal intended workflow, milestones are worked, submitted, reviewed, and approved in sequence, with each approval releasing that milestone's configured payout on-chain.
- Current contract invariant: Under NexotiqDeal.sol, approval of the last configured milestone (the milestone at the last array index: id == milestones.length - 1) is the completion trigger that marks the overall deal Completed. That completion transition does not verify or require that every earlier milestone is already Approved.
- Negative completion-phrasing rule: For current Synq contract mechanics, NEVER say "When all milestones are approved, the deal is marked complete" or "All milestones must be approved before the deal completes", and do not imply that the contract checks all milestone statuses before transitioning the deal to Completed. In lifecycle explanations, use the accurate trigger: approval of the last configured milestone (the milestone at the last array index) triggers overall deal completion. Do not turn this into an alarmist warning unless the user's inquiry specifically asks about the limitation, and do not present this contract behavior as an intended shortcut or advise approving out of order.

ACCEPTANCE CRITERIA:
Clear acceptance criteria can be useful planning guidance between parties. However, current Synq milestone approval does NOT depend on a separately configured acceptance-criteria field. Do not claim the buyer is technically unable to formally approve submitted work merely because acceptance criteria were not configured in the deal.

MILESTONE EDITABILITY:
- Milestones are configured when they are added in Deal Workspace (title, description, amount, due date).
- After a milestone is added on-chain, its title, description, amount, and due date cannot currently be edited through Synq. This applies to all milestone statuses: Pending, In Progress, Submitted, and Approved milestones cannot be edited.
- Synq currently has no individual milestone delete/remove/cancel operation (cancelDeal is a deal-level lifecycle action only; never advise a user to "cancel that milestone").
- Request Revision is for submitted work: it returns a submitted milestone to In Progress so the freelancer can revise and resubmit work; it does not modify the milestone's configured terms. Current verified Synq behavior has no separately configured, tracked, or enforced revision-round limit. Parties may discuss revision expectations as planning guidance, but do not present a revision-round policy as an enforced Synq platform feature.
- Adding another milestone does not replace an existing milestone; milestone creation is additive. Never advise creating a new milestone as a replacement for an existing incorrect milestone. If asked what to do after creating a milestone with incorrect terms, explain the current limitation rather than inventing an edit, deletion, or replacement workflow.

DEADLINES:
Deal and milestone deadline information is informational in the current verified execution model. Current smart contracts do not automatically trigger milestone transitions, releases, penalties, cancellation, or other lifecycle actions merely because a deadline is reached. Deadlines remain valuable for planning, communication, and mutual expectation setting, but never imply automated scheduling or contract-enforced expiration.

DISPUTES:
A buyer or seller can open a dispute on an active deal. When a deal is disputed, normal deal activity is paused and remaining escrow stays in the deal while unresolved.
Current normal resolution outcomes: release remaining disputed funds to the seller, or refund remaining disputed funds to the buyer. Buyer and seller can provide mutual approval for resolution. AI may help analyze a dispute, but AI does not control escrow and does not decide who receives money. Do not describe AI as an arbitrator with fund authority.

6. PROFILE & IDENTITY
Synq has several identity layers:
- Personal profile: display name, avatar, private email (used for account/deal-related notifications; not encrypted communication; do not treat private email as public freelancer info).
- Synq Handle: on-chain username associated with the wallet (NexotiqRegistry).
- Directory profile: professional info (name, category, skills, rate, bio, availability). Portfolio and social details can be stored separately.

7. REVIEWS & REPUTATION
Freelancer reviews are connected to real completed Synq deals.
A verified review requires reviewer to have been the buyer of the completed deal; applies to the seller from that deal. Stored off-chain. One deal corresponds to one review record; submitting again updates that deal's review rather than creating duplicate reviews.
A freelancer's displayed reputation should be understood from verified deal history rather than invented statistics. Specific reviews, ratings, or completed-deal counts are live data and must not be guessed.

8. SWAP
Swap is a separate Synq utility for exchanging ETH and Sepolia USDC on Sepolia testnet. It is separate from deal escrow (a swap is not the same as funding a deal). Live swap quotes and wallet balances are dynamic information and must not be invented.

NETWORK
Synq currently operates on Ethereum Sepolia testnet. Do not describe Synq as currently operating on Ethereum mainnet. Supported deal assets: ETH, Sepolia USDC.

STATIC VS LIVE INFORMATION
This product guide explains how Synq works. It does NOT contain current user-specific or blockchain-state information.
The following require live Synq data: connected wallet, wallet balances, current user profile, current user's deals, specific deal status, current escrow balance, current milestone state, specific freelancer profile, freelancer availability, completed-deal count, reviews, rating, portfolio, current Synq handle ownership, live swap quote.
If live data has not been supplied, never invent a value. Say naturally that current Synq data is required.

UNKNOWN / NOT INCLUDED YET
Do not explain features not covered by this product guide as if their behavior is known.
For now, do not provide detailed operational claims about: ChatPay, Agent Controller, Messages, Activity, Protection internals, or other unfinished/unverified Synq functionality.
If asked, say that the currently verified product information available to you does not establish the feature's current behavior.
(Adaptive Protection is the exception: it is known to be unavailable for new deals / Coming Soon).

ANSWERING RULE
Answer the user's actual question from this guide.
Do not dump unrelated Synq features.
Do not volunteer implementation bugs or internal contract details unless necessary to answer the question.
Do not transform intended product behavior into a claim about functionality that has not been verified.
Never invent Synq functionality simply because a similar Web3 platform might have it.
==============================================`;
}

// ============================================================================
// SECTION 15: TYPED R1 CAPABILITY REGISTRY & DETERMINISTIC RESOLVER
// ============================================================================

export interface SynqCapabilityRemedy {
  id: string;
  description: string;
}

export interface SynqProductCapability {
  id: string;
  domain: 'milestones' | 'escrow' | 'payment_presets' | 'protection';
  status: 'AVAILABLE' | 'UNAVAILABLE' | 'CONDITIONAL';
  statement: string;
  verifiedRemedies: readonly SynqCapabilityRemedy[];
  matching: {
    requiredAny: readonly string[];
    actionAny: readonly string[];
    excludeIfAny?: readonly string[];
  };
}

export const SYNQ_R1_CAPABILITIES: readonly SynqProductCapability[] = [
  {
    id: 'milestone_term_edit',
    domain: 'milestones',
    status: 'UNAVAILABLE',
    statement:
      'Once a milestone has been added to a deal, its title, description, amount, and due date cannot be edited through Synq. This limitation applies whether the milestone is Pending, In Progress, submitted for buyer review, or Approved.',
    verifiedRemedies: [],
    matching: {
      requiredAny: ['milestone', 'milestones'],
      actionAny: [
        'edit',
        'change',
        'modify',
        'update',
        'editing',
        'changing',
        'modifying',
        'updating',
        'different term',
        'different terms',
        'new terms',
        'different title',
        'different amount',
        'different deadline',
        'different due date',
      ],
      excludeIfAny: [
        'which',
        'compare',
        'tradeoff',
        'trade-off',
        'recommend',
        'would you recommend',
        'do you recommend',
        'better',
        'makes sense',
        'make sense',
        'structure a',
        'should i',
        'should we',
        'should my',
        'is it a good idea',
        'good idea',
        'worth it',
        'what would you suggest',
        'what do you suggest',
      ],
    },
  },
  {
    id: 'milestone_individual_cancel',
    domain: 'milestones',
    status: 'UNAVAILABLE',
    statement:
      'Synq does not support deleting, removing, or cancelling individual milestones once they have been added. Deal cancellation (cancelDeal) is a deal-level lifecycle action that terminates the entire deal and refunds remaining unreleased escrow; it cannot cancel a single milestone.',
    verifiedRemedies: [],
    matching: {
      requiredAny: ['milestone', 'milestones'],
      actionAny: [
        'delete',
        'remove',
        'cancel',
        'deleting',
        'removing',
        'cancelling',
        'cancellation',
        'drop',
      ],
      excludeIfAny: [
        'which',
        'compare',
        'tradeoff',
        'trade-off',
        'recommend',
        'would you recommend',
        'do you recommend',
        'better',
        'makes sense',
        'make sense',
        'structure a',
        'should i',
        'should we',
        'should my',
        'is it a good idea',
        'good idea',
        'worth it',
        'what would you suggest',
        'what do you suggest',
      ],
    },
  },
  {
    id: 'milestone_request_revision',
    domain: 'milestones',
    status: 'AVAILABLE',
    statement:
      "Request Revision applies to milestone work that has been submitted for buyer review. It returns that milestone from the contract's Completed state (submitted awaiting review) to In Progress so the freelancer can revise and resubmit the work. It does not change the milestone's title, description, amount, or due date.",
    verifiedRemedies: [],
    matching: {
      requiredAny: [
        'request revision',
        'request revisions',
        'requesting revision',
        'requesting revisions',
        'revision request',
        'revision',
      ],
      actionAny: [
        'what is',
        'what does',
        'how does',
        'how do',
        'meaning',
        'purpose',
        'do',
        'does',
        'work',
        'works',
        'explain',
        'tell me about',
      ],
      excludeIfAny: [
        'which',
        'compare',
        'tradeoff',
        'trade-off',
        'recommend',
        'would you recommend',
        'do you recommend',
        'better',
        'makes sense',
        'make sense',
        'structure a',
        'should i',
        'should we',
        'should my',
        'is it a good idea',
        'good idea',
        'worth it',
        'what would you suggest',
        'what do you suggest',
      ],
    },
  },
  {
    id: 'adaptive_protection_new_deals',
    domain: 'protection',
    status: 'UNAVAILABLE',
    statement:
      'Adaptive Protection is currently disabled and labeled Coming Soon for new deals. New deals are created with Adaptive Protection disabled, and there is currently no supported option to activate or configure it.',
    verifiedRemedies: [],
    matching: {
      requiredAny: ['adaptive protection', 'protection dashboard'],
      actionAny: [
        'available',
        'use',
        'enable',
        'turn on',
        'activate',
        'now',
        'current',
        'supported',
        'work',
        'status',
        'can i',
        'how to',
      ],
      excludeIfAny: [
        'which',
        'compare',
        'tradeoff',
        'trade-off',
        'recommend',
        'would you recommend',
        'do you recommend',
        'better',
        'makes sense',
        'make sense',
        'structure a',
        'should i',
        'should we',
        'should my',
        'is it a good idea',
        'good idea',
        'worth it',
        'what would you suggest',
        'what do you suggest',
      ],
    },
  },
  {
    id: 'payment_preset_auto_milestones',
    domain: 'payment_presets',
    status: 'UNAVAILABLE',
    statement:
      'Payment structure presets (50/50, Single Release, and Custom Milestones) represent deal-creation intent only. Selecting a preset does not automatically create on-chain milestones or automatically release escrow. New deals start with zero milestones, and the buyer configures milestones later in the Deal Workspace.',
    verifiedRemedies: [],
    matching: {
      requiredAny: [
        '50/50',
        '50-50',
        'single release',
        'custom milestones',
        'payment preset',
        'payment presets',
        'payment structure',
      ],
      actionAny: [
        'automatic',
        'automatically',
        'auto create',
        'auto-create',
        'auto deploy',
        'creates milestones',
        'create milestones',
        'created milestones',
        'deploy milestones',
        'creates two milestones',
        'create two milestones',
        'creates a milestone',
        'create a milestone',
        'releases money',
        'release money',
        'release payout',
        'releases funds',
        'release funds',
        'release escrow',
        'pays immediately',
        'pay immediately',
        'pay out immediately',
        'does 50/50 create',
        'does single release create',
      ],
      excludeIfAny: [
        'which',
        'compare',
        'difference',
        'tradeoff',
        'trade-off',
        'recommend',
        'recommendation',
        'would you recommend',
        'do you recommend',
        'better',
        'makes sense',
        'make sense',
        'for my project',
        'for this project',
        'website project',
        'three deliverables',
        'structure a',
        'should i',
        'should we',
        'should my',
        'is it a good idea',
        'good idea',
        'worth it',
        'what would you suggest',
        'what do you suggest',
      ],
    },
  },
] as const;

/**
 * Generic data-driven capability resolver.
 * Conservative, high-confidence matching against closed-world product capabilities.
 * If query contains consultative or comparative language, returns empty to preserve LLM consultation.
 */
export function resolveProductCapabilities(query: string): SynqProductCapability[] {
  if (!query || typeof query !== 'string') return [];
  const normalized = query.toLowerCase().trim();
  if (!normalized) return [];

  const matched: SynqProductCapability[] = [];

  for (const cap of SYNQ_R1_CAPABILITIES) {
    // 1. Check exclusion terms (e.g. consultative, comparison, or exploratory words)
    if (
      cap.matching.excludeIfAny &&
      cap.matching.excludeIfAny.some((term) => {
        if (term.includes(' ') || term.includes('-')) {
          return normalized.includes(term);
        }
        return new RegExp(`\\b${term}\\b`, 'i').test(normalized);
      })
    ) {
      continue;
    }

    // 2. Check required topic terms
    const hasTopic = cap.matching.requiredAny.some((term) => {
      if (term.includes(' ') || term.includes('/')) {
        return normalized.includes(term);
      }
      return new RegExp(`\\b${term}\\b`, 'i').test(normalized);
    });
    if (!hasTopic) continue;

    // 3. Check action / intent terms
    const hasAction = cap.matching.actionAny.some((term) => {
      if (term.includes(' ') || term.includes('/')) {
        return normalized.includes(term);
      }
      return new RegExp(`\\b${term}\\b`, 'i').test(normalized);
    });
    if (!hasAction) continue;

    matched.push(cap);
  }

  return matched;
}

/**
 * Deterministically composes a response from verified product capabilities.
 * Includes only verified canonical statements and explicitly linked remedies.
 * Never manufactures or infers unverified workarounds.
 */
export function composeProductFactResponse(capabilities: readonly SynqProductCapability[]): string {
  if (!capabilities || capabilities.length === 0) return '';

  const statements = capabilities.map((c) => c.statement);
  let message = statements.join('\n\n');

  const remedies: string[] = [];
  for (const cap of capabilities) {
    if (cap.verifiedRemedies && cap.verifiedRemedies.length > 0) {
      for (const r of cap.verifiedRemedies) {
        if (!remedies.includes(r.description)) {
          remedies.push(r.description);
        }
      }
    }
  }

  if (remedies.length > 0) {
    message += `\n\n${remedies.join('\n\n')}`;
  }

  return message;
}

// ============================================================================
// SECTION 13: R2 GROUNDED BOUNDED CONSULTATION (PAYMENT STRUCTURE SELECTION)
// ============================================================================

export type PaymentStructureRecommendation =
  | 'FIFTY_FIFTY'
  | 'SINGLE_RELEASE'
  | 'CUSTOM_MILESTONES'
  | 'INSUFFICIENT_CONTEXT';

export type PaymentPlanningFactor =
  | 'TWO_MAJOR_STAGES'
  | 'MULTIPLE_DISTINCT_DELIVERABLES'
  | 'SINGLE_FINAL_DELIVERABLE'
  | 'STAGED_PROJECT'
  | 'SIMPLE_ONE_STEP_SCOPE'
  | 'UNCLEAR_DELIVERABLE_STRUCTURE';

export interface PaymentConsultationDecision {
  recommendedStructure: PaymentStructureRecommendation;
  reasonFactors: PaymentPlanningFactor[];
}

export const SYNQ_PAYMENT_CONSULTATION_DEF = {
  id: 'payment_structure_selection' as const,
  name: 'Payment Structure Selection Consultation',
  description:
    'Grounded consultative guidance on selecting between 50/50, Single Release, and Custom Milestones based on project deliverable scope.',
  matching: {
    // Explicit compound terms or specific preset names that directly establish payment-structure domain
    explicitTopics: [
      'payment structure',
      'payment structures',
      'payout structure',
      'payout structures',
      'payment preset',
      'payment presets',
      'payment option',
      'payment options',
      '50/50',
      '50-50',
      'single release',
      'custom milestones',
    ],
    // Terms that establish payment context and structure context when co-occurring
    paymentTerms: ['payment', 'payments', 'payout', 'payouts', 'pay'],
    structureTerms: ['structure', 'structures', 'preset', 'presets'],
    // Consultative selection phrases
    consultativeAny: [
      'which payment structure',
      'what payment structure',
      'which structure',
      'what structure',
      'which option',
      'which one',
      'which should i',
      'which should we',
      'which would you',
      'what would you recommend',
      'what do you recommend',
      'recommend a payment',
      'recommend payment',
      'recommend a structure',
      'makes sense',
      'make sense',
      'fits best',
      'fits better',
      'fits my',
      'fits this',
      'fits for',
      'structure fits',
      'structure should',
      'structure would',
      'structure is best',
      'structure is better',
      'should i choose',
      'should i pick',
      'should i use',
      'suggest a structure',
      'suggest a payment',
    ],
    excludeIfAny: [
      'automatic',
      'automatically',
      'auto-create',
      'auto create',
      'deploy milestones',
      'creates milestones',
      'creates two milestones',
      'creates a milestone',
    ],
  },
} as const;

/**
 * Deterministically checks if a query is a consultative payment structure question.
 * Conservative, high-confidence matching.
 * Must NOT intercept pure factual questions handled by R1.
 * Requires genuine payment-structure context (bare generic words like "structure" do not qualify).
 */
export function detectPaymentConsultation(query: string): boolean {
  if (!query || typeof query !== 'string') return false;
  const normalized = query.toLowerCase().trim();
  if (!normalized) return false;

  // 1. Check exclusions (e.g. pure automatic creation questions handled by R1)
  if (
    SYNQ_PAYMENT_CONSULTATION_DEF.matching.excludeIfAny.some((term) => {
      if (term.includes(' ') || term.includes('-')) {
        return normalized.includes(term);
      }
      return new RegExp(`\\b${term}\\b`, 'i').test(normalized);
    })
  ) {
    return false;
  }

  // 2. Must have explicit consultative selection phrasing
  const hasConsultativeIntent = SYNQ_PAYMENT_CONSULTATION_DEF.matching.consultativeAny.some((phrase) => {
    if (phrase.includes(' ')) {
      return normalized.includes(phrase);
    }
    return new RegExp(`\\b${phrase}\\b`, 'i').test(normalized);
  });
  if (!hasConsultativeIntent) return false;

  // 3. Must establish genuine PAYMENT-STRUCTURE domain context:
  // (a) either contains an explicit preset name or compound payment-structure phrase
  const hasExplicitTopic = SYNQ_PAYMENT_CONSULTATION_DEF.matching.explicitTopics.some((term) => {
    if (term.includes(' ') || term.includes('/')) {
      return normalized.includes(term);
    }
    return new RegExp(`\\b${term}\\b`, 'i').test(normalized);
  });

  if (hasExplicitTopic) return true;

  // (b) OR contains BOTH a payment term AND a structure term
  const hasPaymentTerm = SYNQ_PAYMENT_CONSULTATION_DEF.matching.paymentTerms.some((term) =>
    new RegExp(`\\b${term}\\b`, 'i').test(normalized)
  );
  const hasStructureTerm = SYNQ_PAYMENT_CONSULTATION_DEF.matching.structureTerms.some((term) =>
    new RegExp(`\\b${term}\\b`, 'i').test(normalized)
  );

  return hasPaymentTerm && hasStructureTerm;
}

/**
 * Central map of semantically compatible qualitative planning factors for each payment structure recommendation.
 */
export const PAYMENT_STRUCTURE_COMPATIBLE_FACTORS: Record<
  PaymentStructureRecommendation,
  readonly PaymentPlanningFactor[]
> = {
  FIFTY_FIFTY: ['TWO_MAJOR_STAGES', 'STAGED_PROJECT'],
  SINGLE_RELEASE: ['SINGLE_FINAL_DELIVERABLE', 'SIMPLE_ONE_STEP_SCOPE'],
  CUSTOM_MILESTONES: ['MULTIPLE_DISTINCT_DELIVERABLES', 'STAGED_PROJECT'],
  INSUFFICIENT_CONTEXT: ['UNCLEAR_DELIVERABLE_STRUCTURE'],
} as const;

/**
 * Deterministically validates and normalizes an R2 payment consultation decision.
 * 1. Retains only factors semantically compatible with the recommendation.
 * 2. Deduplicates valid factors.
 * 3. If a concrete recommendation has no valid supporting factors remaining,
 *    normalizes to INSUFFICIENT_CONTEXT with UNCLEAR_DELIVERABLE_STRUCTURE.
 * 4. Never exposes raw enum values or produces contradictory reasoning.
 */
export function normalizePaymentConsultationDecision(
  decision: PaymentConsultationDecision
): PaymentConsultationDecision {
  const structure = decision.recommendedStructure;
  const allowedFactors = PAYMENT_STRUCTURE_COMPATIBLE_FACTORS[structure] || [];

  const seen = new Set<PaymentPlanningFactor>();
  const validFactors: PaymentPlanningFactor[] = [];

  for (const factor of decision.reasonFactors) {
    if (allowedFactors.includes(factor) && !seen.has(factor)) {
      seen.add(factor);
      validFactors.push(factor);
    }
  }

  if (structure !== 'INSUFFICIENT_CONTEXT' && validFactors.length === 0) {
    return {
      recommendedStructure: 'INSUFFICIENT_CONTEXT',
      reasonFactors: ['UNCLEAR_DELIVERABLE_STRUCTURE'],
    };
  }

  if (structure === 'INSUFFICIENT_CONTEXT') {
    return {
      recommendedStructure: 'INSUFFICIENT_CONTEXT',
      reasonFactors: validFactors.length > 0 ? validFactors : ['UNCLEAR_DELIVERABLE_STRUCTURE'],
    };
  }

  return {
    recommendedStructure: structure,
    reasonFactors: validFactors,
  };
}

/**
 * Builds the system prompt for R2 payment structure consultation decision.
 * Instructs model to return strictly structured JSON with enum classifications only.
 * Model NEVER writes user-facing prose.
 */
export function buildPaymentConsultationPrompt(dealContext?: {
  scope?: string;
  scopeItems?: string[];
}): string {
  const scopeDesc =
    dealContext?.scopeItems && dealContext.scopeItems.length > 0
      ? dealContext.scopeItems.map((item, idx) => `[${idx + 1}] "${item}"`).join('; ')
      : dealContext?.scope || 'None specified';

  return `You are a project planning evaluator for Synq deal formulation.
Your task is to classify which Synq payment structure is the best planning fit for the described project deliverables, and select the relevant qualitative project planning factors.

PAYMENT STRUCTURE OPTIONS:
- FIFTY_FIFTY: Best for projects structured around two major delivery stages, an initial phase and final completion, or two equal deliverables.
- SINGLE_RELEASE: Best for projects with a single final deliverable, straightforward one-step scope, or payment desired only after complete final delivery and approval.
- CUSTOM_MILESTONES: Best for projects with several distinct deliverables, staged/phased delivery, or three or more separate checkpoints.
- INSUFFICIENT_CONTEXT: The project description and deal context lack enough deliverable detail or stage breakdown to determine a fit.

QUALITATIVE PLANNING FACTORS (select all applicable project characteristics):
- TWO_MAJOR_STAGES: Project has two primary delivery phases.
- MULTIPLE_DISTINCT_DELIVERABLES: Project has several distinct deliverables.
- SINGLE_FINAL_DELIVERABLE: Project has a single deliverable.
- STAGED_PROJECT: Phased or progressive delivery.
- SIMPLE_ONE_STEP_SCOPE: Straightforward one-step task.
- UNCLEAR_DELIVERABLE_STRUCTURE: Deliverable breakdown is not yet clear.

CURRENT DEAL SCOPE IN CONTEXT:
${scopeDesc}

STRICT INSTRUCTION:
Return ONLY the structured JSON with recommendedStructure and reasonFactors.
Do NOT include any free-form explanations, messages, or markdown.`;
}

/**
 * Deterministically renders the final user-facing response for an R2 payment consultation.
 * Combines the qualitative recommendation lead with authoritative Synq platform execution mechanics.
 * Contains ZERO model-generated prose.
 */
export function renderPaymentConsultationResponse(
  decision: PaymentConsultationDecision
): string {
  const normalized = normalizePaymentConsultationDecision(decision);

  if (normalized.recommendedStructure === 'INSUFFICIENT_CONTEXT') {
    return 'How many distinct deliverables or approval stages does the project have? Clarifying the delivery breakdown will help determine whether Single Release, 50/50, or Custom Milestones is the best fit.';
  }

  let qualitativeLead = '';

  if (normalized.recommendedStructure === 'CUSTOM_MILESTONES') {
    if (
      normalized.reasonFactors.includes('MULTIPLE_DISTINCT_DELIVERABLES') ||
      normalized.reasonFactors.includes('STAGED_PROJECT')
    ) {
      qualitativeLead =
        'For a project with several distinct deliverables or phased stages, Custom Milestones is a natural fit because the planned payout structure can reflect those separate checkpoints.';
    } else {
      qualitativeLead =
        'For a project with multiple delivery stages, Custom Milestones is a natural fit so the planned payout structure can reflect your specific stages.';
    }
  } else if (normalized.recommendedStructure === 'FIFTY_FIFTY') {
    if (normalized.reasonFactors.includes('TWO_MAJOR_STAGES')) {
      qualitativeLead =
        'For a project with two major delivery stages, 50/50 is a natural fit to divide payment into an initial phase and final completion.';
    } else {
      qualitativeLead =
        'For a two-stage project scope, 50/50 is a natural fit to plan two equal payout stages.';
    }
  } else if (normalized.recommendedStructure === 'SINGLE_RELEASE') {
    if (
      normalized.reasonFactors.includes('SINGLE_FINAL_DELIVERABLE') ||
      normalized.reasonFactors.includes('SIMPLE_ONE_STEP_SCOPE')
    ) {
      qualitativeLead =
        'For a project with a single final deliverable or straightforward scope, Single Release is a natural fit so the full payment is planned for release upon final completion and approval.';
    } else {
      qualitativeLead =
        'For a project with a single final handover, Single Release is a natural fit so payment is planned for release after final delivery is approved.';
    }
  }

  const executionTruth =
    'In Synq, the preset itself represents planning intent only and does not automatically create milestones. Every new deal begins with zero milestones, and the buyer configures milestones later in Deal Workspace. Escrow funding deposits the full deal total in one transaction; it is not funded milestone by milestone. Approving a milestone releases that milestone\'s configured amount from the contract\'s escrow.';

  return qualitativeLead ? `${qualitativeLead}\n\n${executionTruth}` : executionTruth;
}

// ============================================================================
// SECTION 14: R4 BOUNDED DEAL ANALYZER (CURRENT-DRAFT SCOPE & RISK ANALYSIS)
// ============================================================================

export type ScopeClarityAssessment =
  | 'CLEAR_ENOUGH'
  | 'NEEDS_MORE_DETAIL'
  | 'INSUFFICIENT_SCOPE';

export type ScopePlanningFactor =
  | 'CLARIFY_EXPECTED_OUTPUTS'
  | 'CLARIFY_SCOPE_BOUNDARIES'
  | 'CLARIFY_HANDOFF_EXPECTATIONS'
  | 'CLARIFY_REVIEW_EXPECTATIONS'
  | 'CONSIDER_STAGE_PLANNING';

export interface DealAnalyzerDecision {
  scopeClarity: ScopeClarityAssessment;
  flaggedItemIndexes: number[];
  planningFactors: ScopePlanningFactor[];
}

/**
 * Deterministically checks if a query is an explicit request to analyze or review
 * the current deal draft, its scope, or its risks.
 * 
 * - Self-contained (does NOT invoke R1 or R2 detectors).
 * - Matches explicit current-draft analysis intents.
 * - Rejects generic support questions (e.g. "risks of escrow", "how disputes work").
 */
export function detectDealAnalyzer(query: string): boolean {
  if (!query || typeof query !== 'string') return false;
  const normalized = query.toLowerCase().trim();
  if (!normalized) return false;

  // 1. Explicit generic platform / support exclusions
  if (
    /\b(risks?\s+of\s+escrow|is\s+using\s+escrow\s+risky|smart\s+contract\s+risks?|milestone\s+system|how\s+(?:synq\s+)?disputes?\s+work|how\s+does\s+escrow\s+work)\b/i.test(
      normalized
    )
  ) {
    return false;
  }

  // If asking about a general platform concept without referencing this/my/current draft:
  if (
    /\b(?:about|of|how)\s+(?:escrow|dispute|disputes|factory|registry|directory|protection|swap|latch)\b/i.test(
      normalized
    ) &&
    !/\b(?:my|this|current)\s+(?:draft|deal|scope|deliverables)\b/i.test(normalized)
  ) {
    return false;
  }

  // 2. Explicit pre-creation planning referring to the deal
  if (
    /\bwhat\s+should\s+i\s+(?:think\s+about|consider|watch\s+out\s+for|know)\s+(?:before|prior\s+to)\s+(?:creating|launching|finalizing)\s+(?:this\s+|the\s+|my\s+)?deal\b/i.test(
      normalized
    )
  ) {
    return true;
  }

  // 3. Current-draft target phrases
  const hasCurrentTarget =
    /\b(?:my\s+current|the\s+current|this|my)\s+(?:deal\s+draft|draft|deal|scope|deliverables|setup)\b/i.test(
      normalized
    ) ||
    /\b(?:deal\s+draft|current\s+draft)\b/i.test(normalized) ||
    /\bthese\s+deliverables\b/i.test(normalized);

  // 4. Action verbs / analysis queries
  const hasAnalyzerVerb =
    /\b(?:analyze|analyse|review|assess|evaluate|audit|critique|examine)\b/i.test(
      normalized
    );
  const hasRiskQuery =
    /\b(?:analyze|analyse|review|assess|what\s+are)\s+(?:the\s+)?risks?\b/i.test(
      normalized
    );

  if (hasCurrentTarget && (hasAnalyzerVerb || hasRiskQuery)) {
    return true;
  }

  // 5. Mixed turn case: e.g. "The deliverables are X, Y, and Z. Analyze the risks."
  const hasDeclarativeDeliverables =
    /\b(?:deliverables|scope)\s+(?:are|is|should\s+be)\b/i.test(normalized);
  if (hasDeclarativeDeliverables && (hasAnalyzerVerb || hasRiskQuery)) {
    return true;
  }

  return false;
}

/**
 * Builds the system prompt for R4 semantic scope classification.
 * Strictly limits model output to semantic enums and flagged item indexes.
 * Model NEVER writes user-facing prose or Synq mechanics.
 */
export function buildDealAnalyzerPrompt(dealContext?: {
  scope?: string | null;
  scopeItems?: string[];
}): string {
  const scopeDesc =
    dealContext?.scopeItems && dealContext.scopeItems.length > 0
      ? dealContext.scopeItems.map((item, idx) => `[${idx + 1}] "${item}"`).join('; ')
      : dealContext?.scope || 'None specified';

  return `You are a project scope evaluator for Synq deal formulation.
Your task is to classify the qualitative clarity of the described project deliverables, identify which specific items are broad or ambiguous, and select applicable qualitative planning factors.

STRICT AUTHORITY BOUNDARIES:
- You are ONLY a semantic scope classifier.
- Do NOT write user-facing prose or explanations.
- Do NOT explain Synq platform mechanics or smart contract behavior.
- Do NOT determine deal readiness or whether the deal can be created.
- Do NOT recommend payment structures or presets (50/50, Single Release, Custom Milestones).
- Do NOT invent missing project requirements, technical stacks, or deliverables.
- Do NOT rewrite scope items.

SCOPE CLARITY CLASSIFICATIONS:
- CLEAR_ENOUGH: Deliverables are concrete and specific enough to distinguish as separate units of work.
- NEEDS_MORE_DETAIL: One or more deliverables are broad, vague, or lack clear completion boundaries.
- INSUFFICIENT_SCOPE: Scope text is too minimal, empty, or generic to evaluate meaningfully.

FLAGGED ITEM INDEXES:
- flaggedItemIndexes: 1-based integer indexes of existing items from CURRENT SCOPE ITEMS that are broad or ambiguous (e.g. [3] if item 3 is vague). Return [] if none are ambiguous or if clarity is CLEAR_ENOUGH.

PLANNING FACTORS (select all applicable qualitative factors):
- CLARIFY_EXPECTED_OUTPUTS: Work would benefit from agreeing on specific tangible outputs.
- CLARIFY_SCOPE_BOUNDARIES: Work would benefit from clarifying what is included vs excluded.
- CLARIFY_HANDOFF_EXPECTATIONS: Work would benefit from aligning on how deliverables are handed over.
- CLARIFY_REVIEW_EXPECTATIONS: Work would benefit from aligning on how submitted work is evaluated.
- CONSIDER_STAGE_PLANNING: Multiple deliverables exist that could benefit from phased planning or checkpoints. (Does NOT recommend a payment preset).

CURRENT SCOPE ITEMS IN CONTEXT:
${scopeDesc}

STRICT INSTRUCTION:
Return ONLY structured JSON with scopeClarity, flaggedItemIndexes, and planningFactors.
Do NOT include any free-form explanations, notes, or markdown.`;
}

/**
 * Deterministically validates and normalizes an R4 Deal Analyzer decision.
 * - Deduplicates flagged indexes.
 * - Removes invalid indexes (< 1 or > scopeItems.length).
 * - Deduplicates planning factors.
 * - Normalizes flaggedItemIndexes to [] if scopeClarity is CLEAR_ENOUGH.
 */
export function normalizeDealAnalyzerDecision(
  decision: DealAnalyzerDecision,
  scopeItems?: string[]
): DealAnalyzerDecision {
  const allowedClarity: ScopeClarityAssessment[] = [
    'CLEAR_ENOUGH',
    'NEEDS_MORE_DETAIL',
    'INSUFFICIENT_SCOPE',
  ];
  const allowedFactors: ScopePlanningFactor[] = [
    'CLARIFY_EXPECTED_OUTPUTS',
    'CLARIFY_SCOPE_BOUNDARIES',
    'CLARIFY_HANDOFF_EXPECTATIONS',
    'CLARIFY_REVIEW_EXPECTATIONS',
    'CONSIDER_STAGE_PLANNING',
  ];

  const clarity: ScopeClarityAssessment = allowedClarity.includes(decision.scopeClarity)
    ? decision.scopeClarity
    : 'NEEDS_MORE_DETAIL';

  const maxIndex = scopeItems ? scopeItems.length : 0;
  const validIndexes: number[] = [];
  const seenIndexes = new Set<number>();

  if (clarity !== 'CLEAR_ENOUGH' && Array.isArray(decision.flaggedItemIndexes)) {
    for (const idx of decision.flaggedItemIndexes) {
      if (
        typeof idx === 'number' &&
        Number.isInteger(idx) &&
        idx >= 1 &&
        idx <= maxIndex &&
        !seenIndexes.has(idx)
      ) {
        seenIndexes.add(idx);
        validIndexes.push(idx);
      }
    }
  }

  const validFactors: ScopePlanningFactor[] = [];
  const seenFactors = new Set<ScopePlanningFactor>();

  if (Array.isArray(decision.planningFactors)) {
    for (const f of decision.planningFactors) {
      if (allowedFactors.includes(f) && !seenFactors.has(f)) {
        seenFactors.add(f);
        validFactors.push(f);
      }
    }
  }

  return {
    scopeClarity: clarity,
    flaggedItemIndexes: validIndexes,
    planningFactors: validFactors,
  };
}

/**
 * Deterministically renders the final user-facing response for an R4 Deal Analyzer turn.
 * Completely owns all user-facing prose and verified Synq platform mechanics.
 * Contains ZERO model-generated prose.
 */
export function renderDealAnalyzerResponse(
  decision: DealAnalyzerDecision,
  draftContext: {
    title?: string | null;
    seller?: string | null;
    sellerName?: string | null;
    amount?: { amount: string; asset: 'ETH' | 'USDC' } | null;
    deadline?: { raw?: string; timestamp?: number } | null;
    paymentStructure?: 'custom' | '50-50' | 'single' | null;
    scope?: string | null;
    scopeItems?: string[];
  }
): string {
  const normalized = normalizeDealAnalyzerDecision(decision, draftContext.scopeItems);
  const scopeItems = draftContext.scopeItems || [];
  const scopeCount = scopeItems.length;

  const sections: string[] = [];

  // 1. Opening: acknowledge set canonical facts naturally
  const facts: string[] = [];
  if (draftContext.amount?.amount) {
    facts.push(`a ${draftContext.amount.amount} ${draftContext.amount.asset || 'ETH'} budget`);
  }
  if (scopeCount > 0) {
    const deliverablesList =
      scopeCount <= 3
        ? scopeItems.join(', ')
        : `${scopeItems.slice(0, 3).join(', ')}, and ${scopeCount - 3} more`;
    facts.push(`${scopeCount} deliverable${scopeCount === 1 ? '' : 's'} (${deliverablesList})`);
  } else if (draftContext.scope) {
    facts.push('recorded scope details');
  }
  if (draftContext.title) {
    facts.push(`title "${draftContext.title}"`);
  }
  if (draftContext.sellerName || draftContext.seller) {
    facts.push(`freelancer ${draftContext.sellerName || draftContext.seller}`);
  }

  const openingSummary =
    facts.length > 0
      ? `Your current draft has ${facts.join(' and ')}.`
      : 'I reviewed your current deal draft.';
  sections.push(openingSummary);

  // 2. Scope Clarity & Flagged Items
  if (normalized.scopeClarity === 'NEEDS_MORE_DETAIL') {
    if (normalized.flaggedItemIndexes.length > 0) {
      const quotedItems = normalized.flaggedItemIndexes
        .map((idx) => {
          const itemText = scopeItems[idx - 1];
          return itemText ? `\`${itemText}\`` : null;
        })
        .filter(Boolean);

      if (quotedItems.length > 0) {
        sections.push(
          `Deliverables such as ${quotedItems.join(', ')} are fairly broad, so agreeing on what counts as complete can reduce ambiguity.`
        );
      } else {
        sections.push(
          'Some deliverables could benefit from clearer expected outputs or boundaries so both parties are aligned on what counts as complete.'
        );
      }
    } else {
      sections.push(
        'Some deliverables could benefit from clearer expected outputs or boundaries so both parties are aligned on what counts as complete.'
      );
    }
  } else if (normalized.scopeClarity === 'CLEAR_ENOUGH') {
    sections.push(
      'The deliverables are specific enough to discuss as separate pieces of work, though the parties can still clarify boundaries or review expectations where useful.'
    );
  } else if (normalized.scopeClarity === 'INSUFFICIENT_SCOPE') {
    sections.push(
      'The current scope is too high-level for a detailed qualitative review. Adding specific deliverables or detail will help you evaluate the deal more effectively.'
    );
  }

  // 3. Qualitative Planning Considerations
  const planningNotes: string[] = [];
  for (const factor of normalized.planningFactors) {
    if (factor === 'CLARIFY_EXPECTED_OUTPUTS') {
      planningNotes.push('Agreeing in advance on the specific outputs expected for each task helps prevent misunderstandings.');
    } else if (factor === 'CLARIFY_SCOPE_BOUNDARIES') {
      planningNotes.push('Clarifying what is included versus excluded helps prevent scope creep.');
    } else if (factor === 'CLARIFY_HANDOFF_EXPECTATIONS') {
      planningNotes.push('Aligning on what will be handed over at completion ensures smooth delivery.');
    } else if (factor === 'CLARIFY_REVIEW_EXPECTATIONS') {
      planningNotes.push('Clear review expectations can reduce ambiguity, but current Synq milestone approval does not depend on a separately configured acceptance-criteria field.');
    } else if (factor === 'CONSIDER_STAGE_PLANNING') {
      planningNotes.push('With multiple deliverables, thinking through the sequence or checkpoints can help project organization. In Synq, specific on-chain milestones and payouts are configured after deal creation in the Deal Workspace.');
    }
  }

  if (planningNotes.length > 0) {
    sections.push(planningNotes.join(' '));
  }

  // 4. Grounded Context: Deadline, Payment Structure, Counterparty, Escrow
  const contextNotes: string[] = [];

  if (draftContext.deadline?.raw) {
    contextNotes.push(`Deadline is currently set to ${draftContext.deadline.raw}. Synq deadlines are informational planning targets and do not automatically trigger contract transitions, payouts, penalties, or cancellation.`);
  } else {
    contextNotes.push('No deadline is currently specified. If timing matters for this project, agreeing on a target can help planning. Synq deadlines are informational and do not automatically trigger contract actions.');
  }

  if (draftContext.paymentStructure) {
    const pLabel =
      draftContext.paymentStructure === '50-50'
        ? '50/50 Milestones'
        : draftContext.paymentStructure === 'single'
        ? 'Single Release'
        : 'Custom Milestones';
    contextNotes.push(`Payment structure is set to ${pLabel}. In Synq, selecting a preset records planning intent only and does not automatically create milestones or release funds. All new deals deploy with zero milestones, which are configured after creation in the Deal Workspace.`);
  } else {
    contextNotes.push('No payment structure is currently selected. If you want a specific recommendation on payment presets, you can ask which Synq preset fits this draft.');
  }

  if (!draftContext.seller && !draftContext.sellerName) {
    contextNotes.push('No freelancer is currently specified, so this analysis does not make counterparty-specific assumptions.');
  }

  contextNotes.push('When escrow is funded, the buyer deposits the full deal total in one transaction. Funding is a separate action; the current contract does not technically block the seller from starting or submitting work before funding.');

  sections.push(contextNotes.join(' '));

  return sections.join('\n\n');
}

// ============================================================================
// SECTION 15: BOUNDED DEADLINE FEASIBILITY ADVISOR
// ============================================================================

export type DeadlineAssessability =
  | 'ASSESSABLE'
  | 'INSUFFICIENT_SCOPE'
  | 'NO_DEADLINE';

export type DeadlinePressure =
  | 'PLAUSIBLE'
  | 'TIGHT'
  | 'UNCERTAIN';

export type DeadlinePlanningDriver =
  | 'MULTIPLE_DELIVERABLES'
  | 'AMBIGUOUS_SCOPE'
  | 'DEPENDENCIES_UNSPECIFIED'
  | 'REVIEW_EXPECTATIONS_UNSPECIFIED'
  | 'HANDOFF_UNSPECIFIED'
  | 'NO_CLEAR_PRESSURE_SIGNAL';

export type DeadlineNextStep =
  | 'KEEP_AS_WORKING_TARGET'
  | 'CLARIFY_SCOPE'
  | 'DISCUSS_MORE_TIME'
  | 'BREAK_DOWN_DELIVERABLES'
  | 'ASK_FOR_DEADLINE';

export interface DeadlineFeasibilityDecision {
  assessability: DeadlineAssessability;
  pressure: DeadlinePressure;
  drivers: DeadlinePlanningDriver[];
  nextStep: DeadlineNextStep;
}

/** Conservatively detects qualitative deadline-feasibility or deadline-planning advice. */
export function detectDeadlineFeasibility(query: string): boolean {
  if (!query || typeof query !== 'string') return false;
  const normalized = query.toLowerCase().trim();
  if (!normalized) return false;

  const hasDeadlineContext =
    /\b(?:deadline|timeline|timeframe|time frame|delivery target|due date)\b/i.test(normalized) ||
    /\b\d+\s*(?:calendar\s+)?(?:days?|weeks?|months?)\b/i.test(normalized) ||
    /\b(?:enough|more)\s+time\b/i.test(normalized);
  if (!hasDeadlineContext) return false;

  // Product explanations, deployed/live timing, and external benchmark requests belong elsewhere.
  if (/\bhow\s+(?:do|does)\s+(?:synq\s+)?deadlines?\s+work\b/i.test(normalized)) return false;
  if (/\b(?:deployed|on-chain|current\s+deal)\b.*\b(?:finish|complete|completion|deadline|timeline)\b/i.test(normalized)) return false;
  if (/\b(?:typical|typically|average|industry|market)\b.*\b(?:time|long|days?|weeks?|months?)\b/i.test(normalized)) return false;

  const hasFeasibilityIntent =
    /\b(?:realistic|feasible|achievable|reasonable|plausible)\b/i.test(normalized) ||
    /\b(?:enough\s+time|too\s+(?:tight|short)|allow\s+more\s+time)\b/i.test(normalized) ||
    /\b(?:days?|weeks?|months?)\s+enough\b/i.test(normalized) ||
    /\bguarantee\b[^?.!]*\b(?:days?|weeks?|months?|deadline|timeline|timeframe)\b/i.test(normalized) ||
    /\b(?:can|could|will|would)\b[^?.!]*\b(?:scope|deliverables?|work)\b[^?.!]*\bfit\b[^?.!]*\b(?:deadline|timeline|timeframe|time)\b/i.test(normalized) ||
    /\b(?:what|which|how\s+much)\s+(?:deadline|timeline|timeframe|time)\b[^?.!]*\b(?:should|would|allow|need|set)\b/i.test(normalized) ||
    /\bshould\s+i\b[^?.!]*\b(?:allow\s+more\s+time|set\s+(?:the\s+)?deadline)\b/i.test(normalized) ||
    /\b(?:assess|evaluate|review)\b[^?.!]*\b(?:deadline|timeline|timeframe)\b/i.test(normalized) ||
    /\b(?:tell\s+me|say)\b[^?.!]*\bwhether\b[^?.!]*\b(?:realistic|feasible|achievable|reasonable)\b/i.test(normalized);

  return hasFeasibilityIntent;
}

export function buildDeadlineFeasibilityPrompt(dealContext: {
  title?: string | null;
  scope?: string | null;
  scopeItems?: string[];
  deadline?: string | null;
  budget?: { amount: string; asset: 'ETH' | 'USDC' } | null;
  paymentStructure?: 'custom' | '50-50' | 'single' | null;
}): string {
  const scopeDesc =
    dealContext.scopeItems && dealContext.scopeItems.length > 0
      ? dealContext.scopeItems.map((item, idx) => `[${idx + 1}] "${item}"`).join('; ')
      : dealContext.scope || 'None specified';

  return `You are a bounded qualitative deadline-feasibility classifier for a Synq deal draft.
Return semantic classification only. Do not write user-facing prose.

AUTHORITY AND GROUNDING:
- Use ONLY the canonical facts below.
- Synq deadlines are informational planning targets. They do not enforce completion, payouts, penalties, or cancellation.
- Missing dependencies, review expectations, handoff details, or other planning details are NOT automatically Synq-required fields.
- Do NOT invent technical stacks, revisions, dependencies, acceptance criteria, handoff requirements, freelancer speed or availability, estimated hours, required days, market averages, industry benchmarks, or external project estimates.
- Do NOT guarantee completion and do NOT propose a replacement deadline.
- Do NOT provide payment advice, mutation instructions, or live deployed-deal analysis.

ASSESSABILITY:
- ASSESSABLE: one or more real deliverables or components are identifiable and a canonical deadline exists, so the target can be discussed qualitatively even if confidence is limited.
- INSUFFICIENT_SCOPE: reserve this for effectively absent scope or non-deliverable placeholders such as "something", "stuff", "a feature", "TBD", or equivalent text that does not identify actual work.
- NO_DEADLINE: no canonical deadline is supplied.
- Named deliverables are meaningful scope even when brief or high-level. Examples include "Landing Page", "Landing page and dashboard", "Dashboard with wallet connection", "Mobile responsive landing page", "API integration", and "Admin dashboard and profile page". These examples illustrate the general distinction; do not apply project-type assumptions to them.
- SHORT LENGTH ALONE MUST NEVER CAUSE INSUFFICIENT_SCOPE.
- When real deliverables are identifiable but their boundaries or planning details are limited, the normal conservative result is ASSESSABLE + UNCERTAIN + CLARIFY_SCOPE with only truthful supported drivers. This is distinct from INSUFFICIENT_SCOPE.

PRESSURE:
- PLAUSIBLE: no obvious pressure signal is present in the supplied scope, without implying a guarantee.
- TIGHT: the supplied canonical facts contain supported qualitative pressure signals.
- UNCERTAIN: missing or ambiguous planning context prevents a confident assessment.

DRIVERS (select only those supported by canonical facts):
- MULTIPLE_DELIVERABLES: use only when canonical scope contains multiple identifiable deliverables or components. For example, "Landing page and dashboard" supports this driver.
- AMBIGUOUS_SCOPE: deliverables are named, but their boundaries or expected behavior remain high-level. This does NOT mean scope is absent.
- DEPENDENCIES_UNSPECIFIED: dependency information is not supplied. This does NOT imply dependencies definitely exist.
- REVIEW_EXPECTATIONS_UNSPECIFIED: review or approval expectations are not supplied. This does NOT imply a particular review process is required.
- HANDOFF_UNSPECIFIED: handoff expectations are not supplied. This does NOT imply handoff work is definitely required.
- NO_CLEAR_PRESSURE_SIGNAL: use only when available canonical scope provides no supported reason to classify the deadline as tight.

CONSERVATIVE PRESSURE RULE:
- Do NOT force PLAUSIBLE because a deadline appears generous or because of external intuition about how long a named project type normally takes.
- PLAUSIBLE means only that supplied canonical facts expose no obvious pressure signal. It never means guaranteed, definitely enough, industry-standard, or an estimated completion time.

NEXT STEP:
- KEEP_AS_WORKING_TARGET
- CLARIFY_SCOPE
- DISCUSS_MORE_TIME
- BREAK_DOWN_DELIVERABLES
- ASK_FOR_DEADLINE

CANONICAL DRAFT FACTS:
- Title: ${dealContext.title || 'Not specified'}
- Scope: ${scopeDesc}
- Deadline: ${dealContext.deadline || 'Not specified'}
- Budget: ${dealContext.budget ? `${dealContext.budget.amount} ${dealContext.budget.asset}` : 'Not specified'}
- Payment structure: ${dealContext.paymentStructure || 'Not specified'}

Return ONLY JSON with assessability, pressure, drivers, and nextStep. No markdown or extra fields.`;
}

export function normalizeDeadlineFeasibilityDecision(
  decision: DeadlineFeasibilityDecision
): DeadlineFeasibilityDecision {
  const allowedDrivers: DeadlinePlanningDriver[] = [
    'MULTIPLE_DELIVERABLES',
    'AMBIGUOUS_SCOPE',
    'DEPENDENCIES_UNSPECIFIED',
    'REVIEW_EXPECTATIONS_UNSPECIFIED',
    'HANDOFF_UNSPECIFIED',
    'NO_CLEAR_PRESSURE_SIGNAL',
  ];
  const drivers = Array.from(new Set(
    (Array.isArray(decision.drivers) ? decision.drivers : []).filter((driver) =>
      allowedDrivers.includes(driver)
    )
  ));

  if (decision.assessability === 'NO_DEADLINE') {
    return { assessability: 'NO_DEADLINE', pressure: 'UNCERTAIN', drivers: [], nextStep: 'ASK_FOR_DEADLINE' };
  }
  if (decision.assessability === 'INSUFFICIENT_SCOPE') {
    return { assessability: 'INSUFFICIENT_SCOPE', pressure: 'UNCERTAIN', drivers, nextStep: 'CLARIFY_SCOPE' };
  }

  const pressureDrivers = drivers.filter((driver) => driver !== 'NO_CLEAR_PRESSURE_SIGNAL');
  if (decision.pressure === 'TIGHT') {
    if (pressureDrivers.length === 0) {
      return { assessability: 'ASSESSABLE', pressure: 'UNCERTAIN', drivers, nextStep: 'CLARIFY_SCOPE' };
    }
    return {
      assessability: 'ASSESSABLE',
      pressure: 'TIGHT',
      drivers: pressureDrivers,
      nextStep:
        decision.nextStep === 'DISCUSS_MORE_TIME' || decision.nextStep === 'BREAK_DOWN_DELIVERABLES'
          ? decision.nextStep
          : 'DISCUSS_MORE_TIME',
    };
  }

  if (decision.pressure === 'PLAUSIBLE') {
    const hasConflictingDriver = pressureDrivers.length > 0;
    if (
      !drivers.includes('NO_CLEAR_PRESSURE_SIGNAL') ||
      hasConflictingDriver ||
      decision.nextStep !== 'KEEP_AS_WORKING_TARGET'
    ) {
      return { assessability: 'ASSESSABLE', pressure: 'UNCERTAIN', drivers, nextStep: 'CLARIFY_SCOPE' };
    }
    return {
      assessability: 'ASSESSABLE',
      pressure: 'PLAUSIBLE',
      drivers,
      nextStep: 'KEEP_AS_WORKING_TARGET',
    };
  }

  return {
    assessability: 'ASSESSABLE',
    pressure: 'UNCERTAIN',
    drivers,
    nextStep:
      decision.nextStep === 'ASK_FOR_DEADLINE' || decision.nextStep === 'KEEP_AS_WORKING_TARGET'
        ? 'CLARIFY_SCOPE'
        : decision.nextStep,
  };
}

export function renderDeadlineFeasibilityResponse(
  decision: DeadlineFeasibilityDecision,
  context: { deadline?: string | null; scope?: string | null; scopeItems?: string[] }
): string {
  const normalized = normalizeDeadlineFeasibilityDecision(decision);
  const deadline = context.deadline || 'the proposed timeframe';

  if (normalized.assessability === 'NO_DEADLINE') {
    return 'There is no deadline set to assess yet. What timeframe are you considering?';
  }
  if (normalized.assessability === 'INSUFFICIENT_SCOPE') {
    return `I can't assess ${deadline} against the current scope yet because the work is not specific enough. What concrete deliverables should be completed?`;
  }

  if (normalized.pressure === 'PLAUSIBLE') {
    return `${deadline} can remain a reasonable working target based on the scope currently listed; there is no obvious pressure signal in the available details. This is a qualitative planning assessment, not a guarantee of completion. Synq deadlines are informational targets.`;
  }

  if (normalized.pressure === 'TIGHT') {
    const reasons: string[] = [];
    if (normalized.drivers.includes('MULTIPLE_DELIVERABLES')) reasons.push('the scope contains multiple deliverables');
    if (normalized.drivers.includes('AMBIGUOUS_SCOPE')) reasons.push('some scope boundaries are ambiguous');
    if (normalized.drivers.includes('DEPENDENCIES_UNSPECIFIED')) reasons.push('dependencies are not specified');
    if (normalized.drivers.includes('REVIEW_EXPECTATIONS_UNSPECIFIED')) reasons.push('review expectations are not specified');
    if (normalized.drivers.includes('HANDOFF_UNSPECIFIED')) reasons.push('handoff expectations are not specified');
    const reasonText = reasons.length > 0 ? ` because ${reasons.join(', ')}` : '';
    const nextStep = normalized.nextStep === 'BREAK_DOWN_DELIVERABLES'
      ? 'Breaking the deliverables into clearer stages would make the target easier to evaluate.'
      : 'Discussing whether more time is appropriate would reduce planning pressure.';
    return `${deadline} may be tight${reasonText}. ${nextStep} This is a qualitative planning assessment, not a guarantee, and Synq deadlines are informational targets.`;
  }

  const namedScopeItems = (context.scopeItems || []).filter((item) => item.trim().length > 0);
  const scopeSummary = namedScopeItems.length > 0
    ? namedScopeItems.length <= 3
      ? namedScopeItems.join(', ')
      : `${namedScopeItems.slice(0, 3).join(', ')}, and ${namedScopeItems.length - 3} more`
    : context.scope?.trim() || 'the listed deliverables';
  const missingContext: string[] = [];
  if (normalized.drivers.includes('AMBIGUOUS_SCOPE')) missingContext.push('clear scope boundaries');
  if (normalized.drivers.includes('DEPENDENCIES_UNSPECIFIED')) missingContext.push('dependency details');
  if (normalized.drivers.includes('REVIEW_EXPECTATIONS_UNSPECIFIED')) missingContext.push('review expectations');
  if (normalized.drivers.includes('HANDOFF_UNSPECIFIED')) missingContext.push('handoff expectations');
  const detail = missingContext.length > 0
    ? ` More clarity on ${missingContext.join(', ')} would support a stronger assessment.`
    : ' More concrete planning detail would support a stronger assessment.';
  const clarification = normalized.nextStep === 'CLARIFY_SCOPE'
    ? ' What are the main requirements within those deliverables?'
    : '';
  return `${deadline} can be treated as a working target for ${scopeSummary}, but the available scope or planning context is still too high-level for a confident timeline judgment.${detail}${clarification} Synq deadlines are informational planning targets, not guaranteed completion dates.`;
}

// ============================================================================
// SECTION 17: DETERMINISTIC LIVE-DATA BOUNDARY
// Pure synchronous detection and response for questions requiring live
// wallet, deal, freelancer, or quote state that is not available to the
// Negotiator's static product knowledge.
// NO live data retrieval. NO async. NO network calls.
// ============================================================================

/**
 * Closed-world live-data categories matching the Verified Core "STATIC VS LIVE INFORMATION" section.
 */
export type SynqLiveDataCategory =
  | 'WALLET_BALANCE'
  | 'USER_DEALS'
  | 'DEAL_STATUS'
  | 'ESCROW_BALANCE'
  | 'MILESTONE_STATE'
  | 'FREELANCER_PROFILE'
  | 'REVIEWS_RATING'
  | 'HANDLE_OWNERSHIP'
  | 'SWAP_QUOTE'
  | 'FUNDING_CAPACITY';

/**
 * Pure synchronous detector for questions requiring live data.
 * Returns zero or more live-data categories.
 *
 * DISTINGUISHING PRINCIPLE:
 * - "How does escrow work?" → static product explanation → returns []
 * - "What is the escrow balance of my deal?" → specific current state → returns ['ESCROW_BALANCE']
 *
 * Live-state intent is established by possessive/indexical anchors (my, this deal,
 * specific address, do I have, has my deal) combined with live-data nouns.
 * Generic explanatory/procedural questions about features are NOT intercepted.
 */
export function detectLiveDataRequirements(query: string): SynqLiveDataCategory[] {
  if (!query || typeof query !== 'string') return [];
  const q = query.toLowerCase().trim();
  if (!q) return [];

  // Guard: purely procedural / explanatory questions are never live-data.
  // "How does X work?", "What happens when...", "What is X?" (product definition)
  // These should pass through to R2/R4/Branch 4.
  // BUT: compound queries may start procedural and include a live-data clause later
  // (e.g. "How does escrow funding work, and has my deal been funded?").
  // The guard only fires for PURELY procedural queries with NO possessive/live anchors.
  const hasAnyLiveAnchor =
    /\b(?:my|do\s+i\s+have|i\s+currently|has\s+my|is\s+my|this\s+deal|latest\s+deal|current\s+deal|this\s+freelancer|that\s+freelancer|deal\s+0x[0-9a-fA-F])\b/i.test(q);

  if (!hasAnyLiveAnchor) {
    const isProceduralExplanation =
      /^(?:how\s+do(?:es)?\s+\w+\s+work|what\s+happens?\s+(?:when|if|after)|explain\s+(?:how|what)|tell\s+me\s+(?:how|about\s+how))\b/i.test(q);

    // "Does Synq support X?", "What is Deal Port?", "What is a swap quote?"
    const isProductDefinition =
      /^(?:does\s+synq\s+support|what\s+is\s+(?:a\s+|the\s+)?(?:deal\s+port|synq|swap\s+quote|escrow|funding|milestone|reputation|review|deadline)|what\s+does\s+(?:funded|escrow|milestone)\s+mean|are\s+deadlines?\s+enforced)/i.test(q);

    // "How do reviews work?", "How do milestones work?"
    const isFeatureExplanation =
      /^how\s+do\s+(?:reviews?|milestones?|escrow|funding|disputes?|deadlines?|swaps?|handles?|reputation)\s+work/i.test(q);

    if (isProceduralExplanation || isProductDefinition || isFeatureExplanation) return [];
  }

  const categories: SynqLiveDataCategory[] = [];

  // --- Possessive / indexical anchors ---
  const hasMy = /\bmy\b/i.test(q);
  const hasThisDeal = /\b(?:this|the|latest|current|my)\s+deal\b/i.test(q);
  const hasThisFreelancer = /\b(?:this|the|that)\s+(?:freelancer|seller|contractor|developer|designer)\b/i.test(q);
  const hasDoIHave = /\bdo\s+i\s+have\b/i.test(q);
  const hasSpecificDealAddress = /\bdeal\s+0x[0-9a-fA-F]{4,}/i.test(q);
  const hasMyDeal = /\b(?:my|this|the|latest|current)\s+(?:deal|deals)\b/i.test(q);
  const hasICurrently = /\bi\s+currently\b/i.test(q);

  // Compound personal anchor: "my", "do I have", "I currently", or specific address
  const hasPersonalAnchor = hasMy || hasDoIHave || hasICurrently || hasSpecificDealAddress;
  const hasDealAnchor = hasThisDeal || hasMyDeal || hasSpecificDealAddress;

  // --- WALLET_BALANCE ---
  if (
    hasPersonalAnchor &&
    /\b(?:wallet\s+balance|eth\s+balance|usdc\s+balance|token\s+balance|balance)\b/i.test(q)
  ) {
    categories.push('WALLET_BALANCE');
  }
  // "How much ETH/USDC do I have?"
  if (
    hasDoIHave &&
    /\bhow\s+much\s+(?:eth|usdc|tokens?)\b/i.test(q)
  ) {
    if (!categories.includes('WALLET_BALANCE')) categories.push('WALLET_BALANCE');
  }

  // --- FUNDING_CAPACITY ---
  // "Do I have enough ETH/USDC to fund..." or "Can I fund this deal?"
  if (
    /\b(?:do\s+i\s+have\s+enough|enough\s+(?:eth|usdc|funds?|balance)\s+to\s+fund|can\s+i\s+fund)\b/i.test(q)
  ) {
    if (!categories.includes('FUNDING_CAPACITY')) categories.push('FUNDING_CAPACITY');
  }

  // --- USER_DEALS ---
  // "How many deals do I have?", "my deals", "my current deals"
  if (
    hasPersonalAnchor &&
    /\b(?:deals?|deal\s+count|deal\s+list|how\s+many\s+deals)\b/i.test(q) &&
    !hasDealAnchor // "my deals" (list/count) vs "my deal" (specific deal state)
  ) {
    if (!categories.includes('USER_DEALS')) categories.push('USER_DEALS');
  }
  if (/\bhow\s+many\s+deals\s+(?:do\s+)?i\b/i.test(q)) {
    if (!categories.includes('USER_DEALS')) categories.push('USER_DEALS');
  }

  // --- DEAL_STATUS ---
  // "Has my deal been funded?", "Is deal 0x... funded?", "What is the status of my deal?"
  if (
    hasDealAnchor &&
    /\b(?:status|funded|completed|active|cancelled|disputed|state)\b/i.test(q)
  ) {
    if (!categories.includes('DEAL_STATUS')) categories.push('DEAL_STATUS');
  }
  if (
    /\b(?:has|is)\s+(?:my|this|the|deal\s+0x)\S*\s*(?:deal\s+)?(?:been\s+)?funded\b/i.test(q)
  ) {
    if (!categories.includes('DEAL_STATUS')) categories.push('DEAL_STATUS');
  }

  // --- ESCROW_BALANCE ---
  if (
    hasDealAnchor &&
    /\b(?:escrow\s+balance|escrow\s+amount|in\s+escrow|escrow\s+state)\b/i.test(q)
  ) {
    if (!categories.includes('ESCROW_BALANCE')) categories.push('ESCROW_BALANCE');
  }

  // --- MILESTONE_STATE ---
  if (
    hasDealAnchor &&
    /\b(?:milestones?|milestone\s+status|milestone\s+state|milestone\s+progress)\b/i.test(q)
  ) {
    if (!categories.includes('MILESTONE_STATE')) categories.push('MILESTONE_STATE');
  }

  // --- FREELANCER_PROFILE ---
  if (
    hasThisFreelancer &&
    /\b(?:available|availability|profile|skills?|rate|bio|portfolio|category)\b/i.test(q)
  ) {
    if (!categories.includes('FREELANCER_PROFILE')) categories.push('FREELANCER_PROFILE');
  }

  // --- REVIEWS_RATING ---
  if (
    hasThisFreelancer &&
    /\b(?:reviews?|ratings?|reputation|completed.deal|deal\s+count)\b/i.test(q)
  ) {
    if (!categories.includes('REVIEWS_RATING')) categories.push('REVIEWS_RATING');
  }

  // --- HANDLE_OWNERSHIP ---
  if (
    /\bwho\s+(?:owns?|has|is)\s+@\w+/i.test(q) ||
    /\b(?:my|this)\s+(?:synq\s+)?handle\b/i.test(q)
  ) {
    if (!categories.includes('HANDLE_OWNERSHIP')) categories.push('HANDLE_OWNERSHIP');
  }

  // --- SWAP_QUOTE ---
  if (
    /\b(?:current|live|latest|now)\b/i.test(q) &&
    /\bswap\s+(?:quote|rate|price)\b/i.test(q)
  ) {
    if (!categories.includes('SWAP_QUOTE')) categories.push('SWAP_QUOTE');
  }

  return categories;
}

// --- Human-readable labels for live-data categories ---
const LIVE_DATA_CATEGORY_LABELS: Record<SynqLiveDataCategory, string> = {
  WALLET_BALANCE: 'wallet balance',
  USER_DEALS: 'current deal list or deal count',
  DEAL_STATUS: 'current deal status',
  ESCROW_BALANCE: 'current escrow balance',
  MILESTONE_STATE: 'current milestone state',
  FREELANCER_PROFILE: 'current freelancer profile or availability',
  REVIEWS_RATING: 'current reviews or rating',
  HANDLE_OWNERSHIP: 'current Synq handle ownership',
  SWAP_QUOTE: 'live swap quote',
  FUNDING_CAPACITY: 'funding capacity verification',
};

/**
 * Pure deterministic response composer for live-data boundary.
 * Produces concise natural Synq-facing prose without claiming the feature
 * is permanently unsupported — the Negotiator simply cannot verify those
 * values from the data currently available to it.
 *
 * Special handling for FUNDING_CAPACITY questions includes verified product
 * facts about escrow funding mechanics (full deal total, gas for ETH,
 * allowance for ERC20).
 */
export function composeLiveDataBoundaryResponse(
  categories: readonly SynqLiveDataCategory[],
  query: string
): string {
  if (!categories || categories.length === 0) return '';

  const hasFundingCapacity = categories.includes('FUNDING_CAPACITY');
  const q = (query || '').toLowerCase();

  // --- FUNDING_CAPACITY special path ---
  if (hasFundingCapacity) {
    const isUSDC = /\busdc\b/i.test(q);
    const isETH = /\beth\b/i.test(q) || (!isUSDC && !/\busdc\b/i.test(q));

    if (isUSDC) {
      return (
        "I can't verify the connected wallet's current USDC balance from the live data available to this Negotiator yet, " +
        "so I can't confirm whether you currently have enough to fund this deal. " +
        "Synq escrow funding deposits the full deal total in one transaction. " +
        "For USDC deals, the wallet also needs a sufficient ERC20 token approval (allowance) for the escrow contract before the funding transaction can execute, " +
        "and ETH for gas."
      );
    }

    return (
      "I can't verify the connected wallet's current ETH balance from the live data available to this Negotiator yet, " +
      "so I can't confirm whether you currently have enough to fund this deal. " +
      "Synq escrow funding deposits the full deal total in one transaction, " +
      "and for native ETH deals the wallet also needs ETH for the transaction gas on top of the deal total."
    );
  }

  // --- Mixed STATIC + LIVE: Escrow funding explanation + deal status boundary ---
  // Preserves verified static escrow funding mechanics (depositing full deal total in one transaction)
  // while refusing only the live part that requires on-chain / wallet deal data.
  const asksStaticFunding =
    /\b(?:how\s+(?:does\s+)?(?:escrow\s+)?funding\s+work|how\s+escrow\s+funding\s+works?|explain\s+(?:escrow\s+)?funding|what\s+happens\s+when\s+(?:escrow\s+(?:is\s+)?funded|funding\s+escrow|(?:you|i)\s+fund\s+escrow))\b/i.test(q) ||
    (/\b(?:how|explain|what\s+happens|tell\s+me)\b/i.test(q) && /\b(?:escrow\s+funding|funding\s+escrow|funding\s+work)\b/i.test(q));

  if (categories.includes('DEAL_STATUS') && asksStaticFunding) {
    const isSpecificFundedQuery =
      /\b(?:deal\b.*\b(?:been\s+)?funded|funded\b.*\bdeal)\b/i.test(q) ||
      /\b(?:has|is|whether)\s+(?:my|this|the)\s+deal\b/i.test(q);

    if (isSpecificFundedQuery) {
      return (
        "Synq escrow funding deposits the full deal total into the deal contract in one transaction. " +
        "I can't verify whether your specific deal has been funded from the live deal or on-chain data available to this Negotiator yet, " +
        "so I won't guess its current funding status."
      );
    }

    return (
      "Synq escrow funding deposits the full deal total into the deal contract in one transaction. " +
      "I can't verify your current deal status from the live data available to this Negotiator yet, " +
      "so I won't guess it."
    );
  }

  // --- General live-data boundary ---
  const uniqueLabels = categories.map((c) => LIVE_DATA_CATEGORY_LABELS[c]).filter(Boolean);
  const deduped = [...new Set(uniqueLabels)];

  if (deduped.length === 0) return '';

  const listText =
    deduped.length === 1
      ? deduped[0]
      : deduped.length === 2
      ? `${deduped[0]} and ${deduped[1]}`
      : `${deduped.slice(0, -1).join(', ')}, and ${deduped[deduped.length - 1]}`;

  return (
    `I can explain how those parts of Synq work, but I can't verify your ${listText} ` +
    "from the live data available to this Negotiator yet. " +
    "Those values require current wallet or on-chain data, so I won't guess them."
  );
}

