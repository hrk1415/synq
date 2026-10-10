// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

enum DealState {
    Draft,
    Active,
    Completed,
    TerminatedEarly,
    Cancelled
}

enum MilestoneStatus {
    Pending,
    InProgress,
    Submitted,
    RevisionRequested,
    Disputed,
    ResolutionProposed,
    FinalReview,
    SettledPaid,
    SettledRefunded,
    SettledSplit,
    AssessmentPending,
    AssessmentProposed
}

enum SettlementType {
    None,
    ClientApproval,
    StandardReviewTimeout,
    ExpiredRefund,
    MutualSettlement,
    ResolverResolution,
    AssessmentSettlement
}

enum AssessmentTrigger {
    None,
    Rejection,
    Inactivity
}

struct Milestone {
    uint256 amount;           // USDC base units (6 decimals)
    uint64 workDeadline;      // Unix timestamp
    uint64 reviewWindow;      // Seconds
    uint64 gracePeriod;       // Seconds
    MilestoneStatus status;
    bytes32 specHash;         // Hash of agreed acceptance criteria
    bytes32 evidenceRootHash; // keccak256(canonicalEvidenceManifest)
    uint64 submittedAt;       // Unix timestamp of submission
    uint8 version;            // Incremented on revision resubmissions
}

struct MilestoneInit {
    uint256 amount;
    uint64 workDeadline;
    uint64 reviewWindow;
    uint64 gracePeriod;
    bytes32 specHash;
}

struct DealInitParams {
    address client;
    address freelancer;
    address usdc;
    address primaryResolver;
    address emergencyResolver;
    bool isProtected;
    address protectionModule;
    bytes32 policyId;
}

struct MutualSettlementProposal {
    address dealAddress;
    uint256 chainId;
    uint256 milestoneId;
    address proposer;
    uint256 freelancerAmount;
    uint256 clientAmount;
    uint64 proposalNonce;
    uint64 validUntil;
}

struct ResolutionProposal {
    uint256 freelancerAmount;
    uint256 clientAmount;
    bytes32 justificationHash;
    uint64 proposedAt;
    uint64 reconsiderationDeadline;
    address resolver;
}

struct ResolutionProposalAuth {
    address committee;
    uint256 chainId;
    address deal;
    uint256 milestoneId;
    uint256 freelancerAmount;
    uint256 clientAmount;
    bytes32 justificationHash;
    uint64 resolutionNonce;
    uint64 validUntil;
    bytes32 evidenceRootHash;
    bytes32 specHash;
    uint8 submissionVersion;
}

struct FinalResolutionAuth {
    address committee;
    uint256 chainId;
    address deal;
    uint256 milestoneId;
    uint256 freelancerAmount;
    uint256 clientAmount;
    bytes32 justificationHash;
    uint64 resolutionNonce;
    uint64 validUntil;
    bytes32 evidenceRootHash;
    bytes32 specHash;
    uint8 submissionVersion;
}

struct SignerRotationOp {
    address committee;
    uint256 chainId;
    uint64 committeeEpoch;
    address oldSigner;
    address newSigner;
    uint64 rotationNonce;
    uint64 validUntil;
}

struct AssessmentRequest {
    AssessmentTrigger trigger;
    uint64 requestedAt;
    bytes32 reasonHash;
}

struct AssessmentProposal {
    uint16 completionBps;
    bytes32 reportHash;
    uint64 proposedAt;
    uint64 challengeDeadline;
    bool clientAccepted;
    bool freelancerAccepted;
}

struct AssessmentAttestation {
    address protectionModule;
    uint256 chainId;
    address deal;
    uint256 milestoneId;
    bytes32 evidenceRootHash;
    bytes32 specHash;
    bytes32 policyId;
    uint8 submissionVersion;
    uint16 completionBps;
    bytes32 reportHash;
    uint64 assessmentNonce;
    uint64 validUntil;
    AssessmentTrigger trigger;
}


