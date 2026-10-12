// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./ISynqFactory.sol";
import "./SynqDealTypes.sol";

enum ProposalStatus {
    Pending,
    Accepted,
    Declined,
    Cancelled,
    Expired
}

struct DealProposal {
    address client;
    address freelancer;
    address canonicalUsdc;
    address dealImplementation;
    address primaryResolver;
    address emergencyResolver;
    bytes32 milestonesHash;
    bool isProtected;
    address protectionModule;
    bytes32 policyId;
    uint256 proposalNonce;
    uint256 expiry;
}

interface ISynqFactoryV2 is ISynqFactory {
    // Proposal Events
    event DealProposalAccepted(
        bytes32 indexed proposalId,
        address indexed client,
        address indexed freelancer,
        address dealAddress,
        uint256 nonce
    );

    event DealProposalDeclined(
        bytes32 indexed proposalId,
        address indexed client,
        address indexed freelancer,
        uint256 nonce
    );

    event DealProposalCancelled(
        bytes32 indexed proposalId,
        address indexed client,
        address indexed freelancer,
        uint256 nonce
    );

    event ProposalNonceCancelled(
        address indexed client,
        uint256 indexed nonce
    );

    // Governance Setters
    function setDefaultPrimaryResolver(address newResolver) external;
    function setDefaultEmergencyResolver(address newResolver) external;
    function setDealImplementation(address newImplementation) external;
    function setDefaultProtectionModule(address newModule) external;
    function setDefaultProtectionPolicyId(bytes32 newPolicyId) external;

    // Proposal Actions
    function acceptDealProposal(
        DealProposal calldata proposal,
        MilestoneInit[] calldata milestoneInits,
        bytes calldata clientSignature
    ) external returns (address dealAddress);

    function declineDealProposal(
        DealProposal calldata proposal,
        bytes calldata clientSignature
    ) external;

    function cancelDealProposal(DealProposal calldata proposal) external;

    function cancelProposalNonce(uint256 nonce) external;

    // View Helpers
    function getProposalStatus(DealProposal calldata proposal) external view returns (ProposalStatus);
    function getProposalStatusById(
        bytes32 proposalId,
        address client,
        uint256 nonce,
        uint256 expiry
    ) external view returns (ProposalStatus);
    function isProposalNonceUsed(address client, uint256 nonce) external view returns (bool);
    function hashDealProposal(DealProposal calldata proposal) external view returns (bytes32);
    function hashMilestones(MilestoneInit[] calldata milestoneInits) external pure returns (bytes32);
}
