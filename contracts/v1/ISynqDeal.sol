// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./SynqDealTypes.sol";

interface ISynqDeal {
    // Events
    event DealInitialized(
        address indexed dealAddress,
        address indexed client,
        address indexed freelancer,
        address usdc,
        address primaryResolver,
        address emergencyResolver,
        bool isProtected,
        uint256 totalEscrow,
        uint256 milestoneCount
    );
    event DealFunded(address indexed dealAddress, uint256 totalEscrow);
    event DealCancelled(address indexed dealAddress);
    event DealCompleted(address indexed dealAddress);
    event DealTerminatedEarly(address indexed dealAddress, uint256 refundedToClient);

    event MilestoneStarted(uint256 indexed milestoneId);
    event MilestoneSubmitted(
        uint256 indexed milestoneId,
        bytes32 indexed evidenceRootHash,
        bytes32 specHash,
        uint8 version
    );
    event RevisionRequested(
        uint256 indexed milestoneId,
        bytes32 indexed reasonHash,
        uint64 proposedRevisionDeadline
    );
    event RevisionAccepted(uint256 indexed milestoneId, uint64 newDeadline);
    event RevisionDeclined(uint256 indexed milestoneId);
    event SeriousDisputeOpened(uint256 indexed milestoneId, address indexed opener, bytes32 reasonHash);
    event MilestoneDisputed(uint256 indexed milestoneId, address indexed opener, bytes32 reasonHash);
    event ProposalCancelled(uint256 indexed milestoneId, address indexed proposer, uint64 proposalNonce);
    event MilestoneSettled(
        uint256 indexed milestoneId,
        uint256 paidToFreelancer,
        uint256 refundedToClient,
        SettlementType settlementType
    );

    event ResolutionProposed(
        uint256 indexed milestoneId,
        address indexed resolver,
        uint256 freelancerAmount,
        uint256 clientAmount,
        bytes32 justificationHash,
        uint64 reconsiderationDeadline
    );
    event FinalReconsiderationRequested(uint256 indexed milestoneId, address indexed participant);
    event ResolutionExecuted(
        uint256 indexed milestoneId,
        address indexed resolver,
        uint256 freelancerAmount,
        uint256 clientAmount
    );
    event FinalResolutionExecuted(
        uint256 indexed milestoneId,
        address indexed resolver,
        uint256 freelancerAmount,
        uint256 clientAmount,
        bytes32 justificationHash
    );

    // Active Protection Events
    event AssessmentRequested(
        uint256 indexed milestoneId,
        AssessmentTrigger trigger,
        bytes32 reasonHash,
        uint64 requestedAt
    );
    event AssessmentProposed(
        uint256 indexed milestoneId,
        uint16 completionBps,
        bytes32 reportHash,
        uint64 challengeDeadline
    );
    event AssessmentChallenged(uint256 indexed milestoneId, address indexed challenger);
    event AssessmentAccepted(uint256 indexed milestoneId, address indexed participant);
    event AssessmentSettled(
        uint256 indexed milestoneId,
        uint16 completionBps,
        uint256 paidToFreelancer,
        uint256 refundedToClient
    );
    event AssessmentTimeoutResolved(
        uint256 indexed milestoneId,
        AssessmentTrigger trigger,
        uint256 paidToFreelancer,
        uint256 refundedToClient
    );

    // Core Lifecycle Actions
    function initialize(
        DealInitParams calldata params,
        MilestoneInit[] calldata milestoneInits
    ) external;
    function fundDeal() external;
    function cancelBeforeFunding() external;
    function startMilestone(uint256 milestoneId) external;
    function submitWork(uint256 milestoneId, bytes32 evidenceRootHash) external;
    function claimExpiredRefund(uint256 milestoneId) external;
    function clientApprove(uint256 milestoneId) external;
    function settleReviewTimeout(uint256 milestoneId) external;
    function requestRevision(
        uint256 milestoneId,
        bytes32 reasonHash,
        uint64 proposedRevisionDeadline
    ) external;
    function acceptRevision(uint256 milestoneId) external;
    function declineRevision(uint256 milestoneId) external;
    function timeoutRevisionResponse(uint256 milestoneId) external;
    function openSeriousDispute(uint256 milestoneId, bytes32 reasonHash) external;
    function cancelProposal(uint256 milestoneId, uint64 proposalNonce) external;
    function executeMutualSettlement(
        MutualSettlementProposal calldata proposal,
        bytes calldata counterpartySignature
    ) external;

    // Formal Dispute Resolution
    function proposeMilestoneResolution(
        uint256 milestoneId,
        uint256 freelancerAmount,
        uint256 clientAmount,
        bytes32 justificationHash
    ) external;
    function requestFinalReconsideration(uint256 milestoneId) external;
    function executeResolution(uint256 milestoneId) external;
    function executeFinalResolution(
        uint256 milestoneId,
        uint256 freelancerAmount,
        uint256 clientAmount,
        bytes32 justificationHash
    ) external;

    // Active Protection Actions
    function rejectWorkProtected(uint256 milestoneId, bytes32 rejectionReasonHash) external;
    function triggerReviewTimeoutProtected(uint256 milestoneId) external;
    function registerAssessmentProposal(
        uint256 milestoneId,
        uint16 completionBps,
        bytes32 reportHash
    ) external;
    function challengeAssessment(uint256 milestoneId) external;
    function acceptAssessment(uint256 milestoneId) external;
    function executeAssessmentSettlement(uint256 milestoneId) external;
    function timeoutAssessment(uint256 milestoneId) external;

    // View Getters
    function client() external view returns (address);
    function freelancer() external view returns (address);
    function usdc() external view returns (address);
    function totalEscrow() external view returns (uint256);
    function totalSettled() external view returns (uint256);
    function state() external view returns (DealState);
    function isProtected() external view returns (bool);
    function protectionModule() external view returns (address);
    function policyId() external view returns (bytes32);
    function primaryResolver() external view returns (address);
    function emergencyResolver() external view returns (address);
    function milestoneCount() external view returns (uint256);
    function getMilestone(uint256 milestoneId) external view returns (Milestone memory);
    function getResolutionProposal(uint256 milestoneId) external view returns (ResolutionProposal memory);
    function getAssessmentRequest(uint256 milestoneId) external view returns (AssessmentRequest memory);
    function getAssessmentProposal(uint256 milestoneId) external view returns (AssessmentProposal memory);
    function milestoneDisputeOpenedAt(uint256 milestoneId) external view returns (uint256);
}


