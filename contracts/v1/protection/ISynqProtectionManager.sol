// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

enum ClaimStatus {
    None,
    Submitted,
    Approved,
    Rejected,
    Paid
}

enum CommitteeDecision {
    None,
    Approve,
    Reject
}

struct Policy {
    address client;
    uint64 purchasedAt;
    uint256 premiumPaid;
    uint256 maxCoverage;
    uint256 totalPaid;
    bool active;
}

struct Claim {
    ClaimStatus status;
    uint256 milestoneId;
    uint256 milestoneAmount;
    bytes32 evidenceHash;
    bytes32 decisionReportHash;
    uint64 submittedAt;
    uint64 resolvedAt;
    uint256 payout;
}

struct ProtectionClaimDecisionAuth {
    address committee;
    uint256 chainId;
    address manager;
    address deal;
    uint256 milestoneId;
    uint8 decision; // 1 = Approve, 2 = Reject
    bytes32 decisionReportHash;
    uint64 decisionNonce;
    uint64 validUntil;
}

interface ISynqProtectionManager {
    event PremiumFeeRateUpdated(uint16 oldFeeRateBps, uint16 newFeeRateBps);
    event CommitteeUpdated(address indexed oldCommittee, address indexed newCommittee);
    event PolicyPurchased(
        address indexed deal,
        address indexed client,
        uint256 totalEscrow,
        uint256 premiumPaid,
        uint256 maxCoverage
    );
    event ClaimSubmitted(
        address indexed deal,
        uint256 indexed milestoneId,
        address indexed client,
        uint256 milestoneAmount,
        bytes32 evidenceHash
    );
    event ClaimApproved(
        address indexed deal,
        uint256 indexed milestoneId,
        uint256 calculatedPayout,
        bytes32 decisionReportHash
    );
    event ClaimRejected(
        address indexed deal,
        uint256 indexed milestoneId,
        bytes32 decisionReportHash
    );
    event ClaimPaid(
        address indexed deal,
        uint256 indexed milestoneId,
        address indexed recipient,
        uint256 payoutAmount
    );

    function purchasePolicy(address deal) external returns (uint256 premiumFee);
    function submitClaim(address deal, uint256 milestoneId, bytes32 evidenceHash) external;
    function recordCommitteeDecision(
        address deal,
        uint256 milestoneId,
        CommitteeDecision decision,
        bytes32 decisionReportHash
    ) external;
    function disburseClaim(address deal, uint256 milestoneId) external returns (uint256 payoutAmount);
    function getPolicy(address deal) external view returns (Policy memory);
    function getClaim(address deal, uint256 milestoneId) external view returns (Claim memory);
}
