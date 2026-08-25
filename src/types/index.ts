export interface Deal {
  id: string;
  title: string;
  buyer: string;
  seller: string;
  value: number;
  deadline: string;
  status: DealStatus;
  milestones: Milestone[];
  protection: ProtectionLevel;
  risk: RiskLevel;
  escrowId: string;
  createdAt: string;
  updatedAt: string;
  description: string;
}

export type DealStatus = 'draft' | 'negotiating' | 'active' | 'in_progress' | 'completed' | 'disputed' | 'cancelled';

export interface Milestone {
  id: string;
  title: string;
  description: string;
  amount: number;
  status: MilestoneStatus;
  dueDate: string;
  completedAt?: string;
  evidence?: string;
}

export type MilestoneStatus = 'pending' | 'in_progress' | 'completed' | 'approved' | 'rejected';

export interface Escrow {
  id: string;
  dealId: string;
  buyer: string;
  seller: string;
  totalValue: number;
  lockedAmount: number;
  status: EscrowStatus;
  currentMilestone: number;
  milestones: Milestone[];
  createdAt: string;
  transactionHash?: string;
  network?: string;
}

export type EscrowStatus = 'funding' | 'locked' | 'awaiting_approval' | 'ready_to_release' | 'released' | 'disputed';

export interface Protection {
  id: string;
  dealId: string;
  status: 'active' | 'inactive' | 'pending';
  coverage: number;
  premium: number;
  riskScore: number;
  riskFactors: RiskFactor[];
  timeline: RiskTimelineEvent[];
  aiExplanation?: string;
}

export interface RiskFactor {
  name: string;
  score: number;
  label: string;
}

export interface RiskTimelineEvent {
  date: string;
  risk: number;
  label: string;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export type ProtectionLevel = 'standard' | 'enhanced' | 'maximum';

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  status: 'active' | 'idle' | 'busy';
  permissions: string[];
  restrictedPermissions: string[];
  dailyLimit: number;
  singleTransactionLimit: number;
  lastAction: string;
  mode: AgentMode;
}

export type AgentRole = 'negotiation' | 'escrow' | 'risk' | 'protection' | 'payment' | 'dispute';

export type AgentMode = 'manual' | 'semi_autonomous' | 'autonomous';

export interface Message {
  id: string;
  role: 'user' | 'ai' | 'system';
  content: string;
  timestamp: string;
  type?: 'text' | 'offer' | 'counteroffer' | 'approval' | 'payment' | 'alert';
}

export interface Offer {
  id: string;
  label: string;
  amount: number;
  timeline: string;
  risk: RiskLevel;
  description: string;
  isRecommended: boolean;
}

export interface Reputation {
  score: number;
  totalDeals: number;
  totalVolume: number;
  successfulDeals: number;
  failedDeals: number;
  successRate: number;
  paymentReliability: number;
  deliveryRate: number;
  disputeRate: number;
  averageResponseTime: string;
  timeline: ReputationEvent[];
}

export interface ReputationEvent {
  date: string;
  type: 'deal_completed' | 'payment_received' | 'dispute_resolved' | 'milestone_approved';
  label: string;
  impact: number;
}

export interface Activity {
  id: string;
  type: 'deal_created' | 'milestone_completed' | 'payment_sent' | 'payment_received' | 'dispute_opened' | 'protection_activated' | 'risk_alert' | 'agent_action';
  title: string;
  description: string;
  timestamp: string;
  dealId?: string;
  amount?: number;
}

export interface Payment {
  id: string;
  recipient: string;
  amount: number;
  networkFee: number;
  source: string;
  status: 'pending' | 'confirmed' | 'failed';
  transactionHash?: string;
  timestamp: string;
  dealId?: string;
}

export interface CreateDealForm {
  type: string;
  counterparty: string;
  budget: number;
  deliverables: string;
  deadline: string;
  paymentStructure: string;
  protection: boolean;
  protectionLevel: ProtectionLevel;
}

export interface Dispute {
  id: string;
  dealId: string;
  openedBy: string;
  reason: string;
  status: 'open' | 'under_review' | 'resolved';
  aiSummary: string;
  aiRecommendation: string;
  evidence: string[];
  createdAt: string;
}
