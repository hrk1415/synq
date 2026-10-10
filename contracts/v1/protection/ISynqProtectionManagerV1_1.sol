// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./ISynqProtectionManager.sol";

struct PolicyV1_1 {
    address client;
    uint64 purchasedAt;
    uint16 coveredBitmap;
    bool active;
    uint256 eligiblePrincipal;
    uint256 premiumPaid;
    uint256 maxCoverage;
    uint256 totalPaid;
}

interface ISynqProtectionManagerV1_1 {
    event PremiumFeeRateUpdated(uint16 oldFeeRateBps, uint16 newFeeRateBps);
    event CommitteeUpdated(address indexed oldCommittee, address indexed newCommittee);
    event PolicyPurchased(
        address indexed deal,
        address indexed client,
        uint256 eligiblePrincipal,
        uint16 coveredBitmap,
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
    function getPolicy(address deal) external view returns (PolicyV1_1 memory);
    function getClaim(address deal, uint256 milestoneId) external view returns (Claim memory);
    function isMilestoneCovered(address deal, uint256 milestoneId) external view returns (bool);
}
