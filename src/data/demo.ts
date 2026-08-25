import { Deal, Escrow, Protection, Agent, Message, Offer, Reputation, Activity, Payment, Dispute } from '@/types';

export const demoUser = {
  name: 'Alex Morgan',
  email: 'alex@nexotiq.io',
  walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
  trustScore: 94,
  totalProtected: 12450,
  activeEscrow: 8200,
  pendingPayments: 1250,
};

export const demoDeals: Deal[] = [
  {
    id: 'NX-1024',
    title: 'DeFi Dashboard Development',
    buyer: 'Alex Morgan',
    seller: 'Nova Labs',
    value: 5000,
    deadline: '30 Days',
    status: 'in_progress',
    description: 'Build a comprehensive DeFi dashboard with real-time analytics, portfolio tracking, and transaction monitoring.',
    milestones: [
      { id: 'm1', title: 'Discovery', description: 'Requirements gathering and architecture design', amount: 1000, status: 'approved', dueDate: '2026-08-01', completedAt: '2026-07-28', evidence: 'Requirements document submitted' },
      { id: 'm2', title: 'Development', description: 'Core dashboard development and API integration', amount: 2500, status: 'in_progress', dueDate: '2026-08-15' },
      { id: 'm3', title: 'Final Delivery', description: 'Testing, deployment, and handover', amount: 1500, status: 'pending', dueDate: '2026-08-30' },
    ],
    protection: 'enhanced',
    risk: 'low',
    escrowId: 'ESC-1024',
    createdAt: '2026-07-20T10:30:00Z',
    updatedAt: '2026-07-28T14:22:00Z',
  },
  {
    id: 'NX-1023',
    title: 'Smart Contract Audit',
    buyer: 'Alex Morgan',
    seller: 'SecureChain Labs',
    value: 3200,
    deadline: '14 Days',
    status: 'negotiating',
    description: 'Comprehensive security audit for ERC-20 token contract.',
    milestones: [
      { id: 'm1', title: 'Initial Review', description: 'Code review and vulnerability assessment', amount: 1200, status: 'pending', dueDate: '2026-08-05' },
      { id: 'm2', title: 'Final Report', description: 'Detailed audit report with recommendations', amount: 2000, status: 'pending', dueDate: '2026-08-12' },
    ],
    protection: 'standard',
    risk: 'medium',
    escrowId: 'ESC-1023',
    createdAt: '2026-07-22T09:15:00Z',
    updatedAt: '2026-07-25T11:00:00Z',
  },
  {
    id: 'NX-1022',
    title: 'NFT Collection Design',
    buyer: 'Alex Morgan',
    seller: 'PixelForge Studio',
    value: 1800,
    deadline: '10 Days',
    status: 'completed',
    description: 'Design and generate a 10,000-piece NFT collection with metadata.',
    milestones: [
      { id: 'm1', title: 'Concept Art', description: 'Character and style design', amount: 600, status: 'approved', dueDate: '2026-07-10', completedAt: '2026-07-08' },
      { id: 'm2', title: 'Generation', description: 'Bulk generation and metadata creation', amount: 800, status: 'approved', dueDate: '2026-07-15', completedAt: '2026-07-14' },
      { id: 'm3', title: 'Delivery', description: 'Final artwork delivery and contract deployment', amount: 400, status: 'approved', dueDate: '2026-07-20', completedAt: '2026-07-19' },
    ],
    protection: 'standard',
    risk: 'low',
    escrowId: 'ESC-1022',
    createdAt: '2026-07-05T08:00:00Z',
    updatedAt: '2026-07-19T16:45:00Z',
  },
];

export const demoEscrows: Escrow[] = [
  {
    id: 'ESC-1024',
    dealId: 'NX-1024',
    buyer: 'Alex Morgan',
    seller: 'Nova Labs',
    totalValue: 5000,
    lockedAmount: 5000,
    status: 'locked',
    currentMilestone: 1,
    milestones: demoDeals[0].milestones,
    createdAt: '2026-07-20T10:30:00Z',
    transactionHash: '0x8f3b6c2a1d4e5f7a8b9c0d1e2f3a4b5c6d7e8f9',
    network: 'Ethereum',
  },
  {
    id: 'ESC-1023',
    dealId: 'NX-1023',
    buyer: 'Alex Morgan',
    seller: 'SecureChain Labs',
    totalValue: 3200,
    lockedAmount: 1200,
    status: 'funding',
    currentMilestone: 0,
    milestones: demoDeals[1].milestones,
    createdAt: '2026-07-22T09:15:00Z',
  },
];

export const demoProtection: Protection = {
  id: 'PROT-1024',
  dealId: 'NX-1024',
  status: 'active',
  coverage: 5000,
  premium: 175,
  riskScore: 18,
  riskFactors: [
    { name: 'Counterparty Reputation', score: 15, label: 'Low' },
    { name: 'Delivery Risk', score: 22, label: 'Low' },
    { name: 'Payment Risk', score: 10, label: 'Very Low' },
    { name: 'Market Conditions', score: 25, label: 'Low' },
    { name: 'Deadline Risk', score: 18, label: 'Low' },
  ],
  timeline: [
    { date: '2026-07-20', risk: 28, label: 'Deal Started' },
    { date: '2026-07-24', risk: 35, label: 'Midpoint' },
    { date: '2026-07-28', risk: 18, label: 'New Evidence' },
  ],
  aiExplanation: 'Risk decreased because the seller completed 2 verified milestones and has maintained a 98% successful deal rate.',
};

export const demoAgents: Agent[] = [
  { id: 'ag-1', name: 'Negotiation Agent', role: 'negotiation', status: 'idle', permissions: ['Analyze deal terms', 'Generate proposals', 'Suggest counteroffers'], restrictedPermissions: ['Accept final terms', 'Edit deal amounts'], dailyLimit: 10000, singleTransactionLimit: 5000, lastAction: 'Generated proposal for NX-1023', mode: 'semi_autonomous' },
  { id: 'ag-2', name: 'Escrow Agent', role: 'escrow', status: 'active', permissions: ['Monitor escrow conditions', 'Verify milestone evidence', 'Release approved payments'], restrictedPermissions: ['Release escrow without approval', 'Modify escrow terms'], dailyLimit: 15000, singleTransactionLimit: 5000, lastAction: 'Verifying milestone 1 for NX-1024', mode: 'manual' },
  { id: 'ag-3', name: 'Risk Agent', role: 'risk', status: 'active', permissions: ['Monitor transaction risk', 'Analyze counterparty reputation', 'Generate risk alerts'], restrictedPermissions: ['Block transactions', 'Freeze escrow'], dailyLimit: 0, singleTransactionLimit: 0, lastAction: 'Risk score updated for NX-1024: 18/100', mode: 'semi_autonomous' },
  { id: 'ag-4', name: 'Protection Agent', role: 'protection', status: 'active', permissions: ['Monitor protection coverage', 'Adjust risk parameters', 'Generate protection reports'], restrictedPermissions: ['Claim payouts', 'Modify coverage limits'], dailyLimit: 5000, singleTransactionLimit: 5000, lastAction: 'Protection active for NX-1024', mode: 'semi_autonomous' },
  { id: 'ag-5', name: 'Payment Agent', role: 'payment', status: 'idle', permissions: ['Pay approved invoices', 'Release approved escrow', 'Create payment requests'], restrictedPermissions: ['Withdraw all funds', 'Change contract ownership'], dailyLimit: 2000, singleTransactionLimit: 500, lastAction: 'Payment of $1,000 approved for milestone 1', mode: 'manual' },
  { id: 'ag-6', name: 'Dispute Agent', role: 'dispute', status: 'idle', permissions: ['Analyze dispute evidence', 'Generate recommendations', 'Mediate between parties'], restrictedPermissions: ['Make final dispute decisions', 'Release funds without consent'], dailyLimit: 0, singleTransactionLimit: 0, lastAction: 'No active disputes', mode: 'manual' },
];

export const demoMessages: Message[] = [
  { id: 'msg-1', role: 'user', content: 'I want to hire a designer for a landing page.', timestamp: '2026-07-20T10:00:00Z' },
  { id: 'msg-2', role: 'ai', content: 'I found 3 potential deal structures based on your requirements.', timestamp: '2026-07-20T10:00:05Z', type: 'offer' },
  { id: 'msg-3', role: 'ai', content: 'Based on the seller\'s reputation and project scope, I recommend Option B.', timestamp: '2026-07-20T10:00:10Z' },
  { id: 'msg-4', role: 'user', content: 'Let\'s go with Option B, but I\'d like to counter at $1,200.', timestamp: '2026-07-20T10:01:00Z' },
  { id: 'msg-5', role: 'ai', content: 'Good choice. I\'ve sent a counter offer of $1,200 with 2 milestones. Negotiation Agent is standing by.', timestamp: '2026-07-20T10:01:05Z' },
];

export const demoOffers: Offer[] = [
  { id: 'off-1', label: 'Option A', amount: 800, timeline: '7 Days', risk: 'low', description: 'Standard design package with 3 revisions', isRecommended: false },
  { id: 'off-2', label: 'Option B', amount: 1200, timeline: '5 Days', risk: 'medium', description: 'Premium design with unlimited revisions and source files', isRecommended: true },
  { id: 'off-3', label: 'Option C', amount: 1500, timeline: '3 Days', risk: 'high', description: 'Priority delivery with dedicated designer', isRecommended: false },
];

export const demoReputation: Reputation = {
  score: 94,
  totalDeals: 47,
  totalVolume: 128500,
  successfulDeals: 46,
  failedDeals: 1,
  successRate: 98,
  paymentReliability: 100,
  deliveryRate: 96,
  disputeRate: 2,
  averageResponseTime: '2.4 hours',
  timeline: [
    { date: '2026-07-19', type: 'deal_completed', label: 'NFT Collection Design completed', impact: 2 },
    { date: '2026-07-15', type: 'payment_received', label: 'Payment of $1,200 received', impact: 1 },
    { date: '2026-07-10', type: 'milestone_approved', label: 'Concept Art milestone approved', impact: 1 },
    { date: '2026-07-05', type: 'deal_completed', label: 'Smart Contract Audit completed', impact: 2 },
    { date: '2026-06-28', type: 'payment_received', label: 'Payment of $3,200 received', impact: 1 },
    { date: '2026-06-20', type: 'dispute_resolved', label: 'Dispute resolved in your favor', impact: 3 },
  ],
};

export const demoActivity: Activity[] = [
  { id: 'act-1', type: 'milestone_completed', title: 'Milestone Approved', description: 'Discovery milestone for NX-1024 was approved', timestamp: '2026-07-28T14:22:00Z', dealId: 'NX-1024', amount: 1000 },
  { id: 'act-2', type: 'risk_alert', title: 'Risk Score Updated', description: 'Risk score for NX-1024 decreased to 18', timestamp: '2026-07-28T14:20:00Z', dealId: 'NX-1024' },
  { id: 'act-3', type: 'protection_activated', title: 'Protection Activated', description: 'Adaptive Protection is active for NX-1024', timestamp: '2026-07-20T10:35:00Z', dealId: 'NX-1024' },
  { id: 'act-4', type: 'deal_created', title: 'Deal Created', description: 'DeFi Dashboard Development deal was created', timestamp: '2026-07-20T10:30:00Z', dealId: 'NX-1024', amount: 5000 },
  { id: 'act-5', type: 'deal_created', title: 'Deal Created', description: 'Smart Contract Audit deal was created', timestamp: '2026-07-22T09:15:00Z', dealId: 'NX-1023', amount: 3200 },
  { id: 'act-6', type: 'agent_action', title: 'AI Agent Activity', description: 'Negotiation Agent generated counteroffer for NX-1023', timestamp: '2026-07-25T11:00:00Z', dealId: 'NX-1023' },
];

export const demoPayments: Payment[] = [
  { id: 'pay-1', recipient: 'Nova Labs', amount: 1000, networkFee: 0.12, source: 'Nexotiq Wallet', status: 'confirmed', transactionHash: '0x8f3b6c2a1d4e5f7a8b9c0d1e2f3a4b5c6d7e8f9', timestamp: '2026-07-28T15:00:00Z', dealId: 'NX-1024' },
  { id: 'pay-2', recipient: 'SecureChain Labs', amount: 500, networkFee: 0.08, source: 'Nexotiq Wallet', status: 'pending', timestamp: '2026-07-28T16:00:00Z', dealId: 'NX-1023' },
];

export const demoDisputes: Dispute[] = [
  {
    id: 'DSP-001',
    dealId: 'NX-1020',
    openedBy: 'Alex Morgan',
    reason: 'Deliverable does not match agreed specifications',
    status: 'under_review',
    aiSummary: 'The buyer claims the delivered work does not match the specifications agreed in the contract. The seller has provided evidence of milestone completion. The deal terms specify a 7-day review period.',
    aiRecommendation: 'Release 50% of the disputed amount to the seller, and hold 50% until a revised deliverable is submitted within 5 business days.',
    evidence: ['Contract terms screenshot', 'Email correspondence', 'Deliverable preview'],
    createdAt: '2026-07-26T09:00:00Z',
  },
];
