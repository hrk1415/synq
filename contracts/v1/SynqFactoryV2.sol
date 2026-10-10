// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "./ISynqFactoryV2.sol";
import "./ISynqDeal.sol";
import "./SynqDealTypes.sol";

/**
 * @title SynqFactoryV2
 * @notice Factory for deploying and registering standardized Synq Deal V1 ERC-1167 clones with
 *         cryptographic freelancer consent (EIP-712).
 * @dev Enforces the Complete Configuration & Freelancer Consent Invariant:
 *      A Deal clone cannot be deployed or funded until the designated freelancer has accepted
 *      the exact terms proposed and signed by the client.
 *      The client-signed proposal cryptographically binds all deal terms, milestones, and
 *      all governance snapshots (dealImplementation, primaryResolver, emergencyResolver).
 *      Direct unconsented deal creation is permanently disabled.
 */
contract SynqFactoryV2 is ISynqFactoryV2, Ownable2Step, EIP712 {
    using Clones for address;

    // --- EIP-712 Constants ---
    bytes32 public constant DEAL_PROPOSAL_TYPEHASH = keccak256(
        "DealProposal(address client,address freelancer,address canonicalUsdc,address dealImplementation,address primaryResolver,address emergencyResolver,bytes32 milestonesHash,bool isProtected,address protectionModule,bytes32 policyId,uint256 proposalNonce,uint256 expiry)"
    );

    // --- Immutable Protocol Configuration ---
    address public immutable override canonicalUsdc;

    // --- Mutable Defaults for Future Deals (Owner Governed) ---
    address public override dealImplementation;
    address public override defaultPrimaryResolver;
    address public override defaultEmergencyResolver;
    address public override defaultProtectionModule;
    bytes32 public override defaultProtectionPolicyId;

    // --- Registry & Discovery Storage ---
    address[] public override allDeals;
    mapping(address => bool) public override isSynqDeal;
    mapping(address => address[]) private _dealsByClient;
    mapping(address => address[]) private _dealsByFreelancer;

    // --- Proposal Lifecycle Storage ---
    mapping(bytes32 => ProposalStatus) public proposalStatus;
    mapping(address => mapping(uint256 => bool)) public usedClientNonces;

    // --- Constructor ---
    constructor(
        address initialOwner,
        address _canonicalUsdc,
        address _dealImplementation,
        address _defaultPrimaryResolver,
        address _defaultEmergencyResolver
    )
        Ownable(initialOwner)
        EIP712("SynqFactoryV2", "1")
    {
        require(initialOwner != address(0), "Zero owner address");
        require(_canonicalUsdc != address(0), "Zero USDC address");
        require(_canonicalUsdc.code.length > 0, "USDC must be a contract");
        require(_dealImplementation != address(0), "Zero implementation address");
        require(_dealImplementation.code.length > 0, "Implementation must be a contract");
        require(_defaultPrimaryResolver != address(0), "Zero primary resolver");
        require(_defaultPrimaryResolver.code.length > 0, "Primary resolver must be a contract");
        require(_defaultEmergencyResolver != address(0), "Zero emergency resolver");
        require(_defaultEmergencyResolver.code.length > 0, "Emergency resolver must be a contract");

        canonicalUsdc = _canonicalUsdc;
        dealImplementation = _dealImplementation;
        defaultPrimaryResolver = _defaultPrimaryResolver;
        defaultEmergencyResolver = _defaultEmergencyResolver;
    }

    // --- Proposal Actions ---

    /**
     * @notice Freelancer accepts an authorized client proposal, deploying and initializing the Deal clone.
     * @param proposal Complete signed deal proposal parameters.
     * @param milestoneInits Array of milestone definitions matching proposal.milestonesHash.
     * @param clientSignature EIP-712 signature from proposal.client.
     * @return dealAddress Address of the deployed and initialized SynqDealV1 clone.
     */
    function acceptDealProposal(
        DealProposal calldata proposal,
        MilestoneInit[] calldata milestoneInits,
        bytes calldata clientSignature
    ) external override returns (address dealAddress) {
        bytes32 proposalId = _verifyAndConsumeProposal(proposal, milestoneInits, clientSignature);
        dealAddress = _materializeDeal(proposal, milestoneInits, proposalId);
    }

    /**
     * @notice Freelancer permanently declines an authorized client proposal.
     * @param proposal Complete deal proposal parameters.
     * @param clientSignature Valid client signature over the proposal to prevent unauthorized nonce consumption.
     */
    function declineDealProposal(
        DealProposal calldata proposal,
        bytes calldata clientSignature
    ) external override {
        require(msg.sender == proposal.freelancer, "Only designated freelancer can decline");
        require(block.timestamp <= proposal.expiry, "Proposal expired");

        bytes32 proposalId = hashDealProposal(proposal);
        require(proposalStatus[proposalId] == ProposalStatus.Pending, "Proposal not pending");
        require(!usedClientNonces[proposal.client][proposal.proposalNonce], "Proposal nonce already used");

        address signer = ECDSA.recover(proposalId, clientSignature);
        require(signer == proposal.client, "Invalid client signature");

        proposalStatus[proposalId] = ProposalStatus.Declined;
        usedClientNonces[proposal.client][proposal.proposalNonce] = true;

        emit DealProposalDeclined(
            proposalId,
            proposal.client,
            proposal.freelancer,
            proposal.proposalNonce
        );
    }

    /**
     * @notice Client cancels their own pending proposal before it has been accepted or declined.
     * @param proposal Complete deal proposal parameters.
     */
    function cancelDealProposal(DealProposal calldata proposal) external override {
        require(msg.sender == proposal.client, "Only client can cancel");

        bytes32 proposalId = hashDealProposal(proposal);
        require(proposalStatus[proposalId] == ProposalStatus.Pending, "Proposal not pending");
        require(!usedClientNonces[proposal.client][proposal.proposalNonce], "Proposal nonce already used");

        proposalStatus[proposalId] = ProposalStatus.Cancelled;
        usedClientNonces[proposal.client][proposal.proposalNonce] = true;

        emit DealProposalCancelled(
            proposalId,
            proposal.client,
            proposal.freelancer,
            proposal.proposalNonce
        );
    }

    /**
     * @notice Client invalidates a specific proposal nonce directly.
     * @param nonce Nonce to cancel.
     */
    function cancelProposalNonce(uint256 nonce) external override {
        require(!usedClientNonces[msg.sender][nonce], "Proposal nonce already used");
        usedClientNonces[msg.sender][nonce] = true;

        emit ProposalNonceCancelled(msg.sender, nonce);
    }

    // --- Internal Helpers ---

    function _verifyAndConsumeProposal(
        DealProposal calldata proposal,
        MilestoneInit[] calldata milestoneInits,
        bytes calldata clientSignature
    ) internal returns (bytes32 proposalId) {
        require(msg.sender == proposal.freelancer, "Only designated freelancer can accept");
        require(proposal.client != address(0), "Zero client address");
        require(proposal.freelancer != address(0), "Zero freelancer address");
        require(proposal.client != proposal.freelancer, "Client equals freelancer");
        require(block.timestamp <= proposal.expiry, "Proposal expired");
        require(proposal.canonicalUsdc == canonicalUsdc, "Invalid canonical USDC");
        require(proposal.dealImplementation == dealImplementation, "Deal implementation mismatch");
        require(proposal.primaryResolver == defaultPrimaryResolver, "Primary resolver mismatch");
        require(proposal.emergencyResolver == defaultEmergencyResolver, "Emergency resolver mismatch");
        require(proposal.milestonesHash == keccak256(abi.encode(milestoneInits)), "Milestones hash mismatch");
        require(milestoneInits.length > 0, "Zero milestones provided");

        if (proposal.isProtected) {
            require(defaultProtectionModule != address(0), "Protection module not configured");
            require(defaultProtectionPolicyId != bytes32(0), "Protection policy not configured");
            require(proposal.protectionModule == defaultProtectionModule, "Protection module mismatch");
            require(proposal.policyId == defaultProtectionPolicyId, "Protection policy mismatch");
        } else {
            require(proposal.protectionModule == address(0), "Non-zero protection module in standard proposal");
            require(proposal.policyId == bytes32(0), "Non-zero policyId in standard proposal");
        }

        proposalId = hashDealProposal(proposal);
        require(proposalStatus[proposalId] == ProposalStatus.Pending, "Proposal not pending");
        require(!usedClientNonces[proposal.client][proposal.proposalNonce], "Proposal nonce already used");

        address signer = ECDSA.recover(proposalId, clientSignature);
        require(signer == proposal.client, "Invalid client signature");

        // Checks-Effects-Interactions: consume proposal before external clone deployment
        proposalStatus[proposalId] = ProposalStatus.Accepted;
        usedClientNonces[proposal.client][proposal.proposalNonce] = true;
    }

    function _materializeDeal(
        DealProposal calldata proposal,
        MilestoneInit[] calldata milestoneInits,
        bytes32 proposalId
    ) internal returns (address dealAddress) {
        uint256 totalEscrow = 0;
        for (uint256 i = 0; i < milestoneInits.length; i++) {
            require(milestoneInits[i].amount > 0, "Zero milestone amount");
            require(milestoneInits[i].workDeadline > block.timestamp, "Work deadline in past");
            require(
                milestoneInits[i].reviewWindow >= 1 hours && milestoneInits[i].reviewWindow <= 30 days,
                "Invalid review window"
            );
            require(milestoneInits[i].specHash != bytes32(0), "Zero specHash");
            totalEscrow += milestoneInits[i].amount;
        }

        dealAddress = proposal.dealImplementation.clone();

        DealInitParams memory params = DealInitParams({
            client: proposal.client,
            freelancer: proposal.freelancer,
            usdc: canonicalUsdc,
            primaryResolver: proposal.primaryResolver,
            emergencyResolver: proposal.emergencyResolver,
            isProtected: proposal.isProtected,
            protectionModule: proposal.protectionModule,
            policyId: proposal.policyId
        });

        ISynqDeal(dealAddress).initialize(params, milestoneInits);

        allDeals.push(dealAddress);
        isSynqDeal[dealAddress] = true;
        _dealsByClient[proposal.client].push(dealAddress);
        _dealsByFreelancer[proposal.freelancer].push(dealAddress);

        emit DealCreated(
            dealAddress,
            proposal.client,
            proposal.freelancer,
            msg.sender,
            canonicalUsdc,
            proposal.primaryResolver,
            proposal.emergencyResolver,
            totalEscrow,
            milestoneInits.length
        );

        emit DealProposalAccepted(
            proposalId,
            proposal.client,
            proposal.freelancer,
            dealAddress,
            proposal.proposalNonce
        );
    }

    // --- Legacy ISynqFactory Deprecation ---

    /**
     * @dev Direct unconsented deal creation is permanently disabled in Factory V2.
     */
    function createDeal(
        address,
        address,
        MilestoneInit[] calldata
    ) external pure override returns (address) {
        revert("Direct creation disabled: use acceptDealProposal");
    }

    /**
     * @dev Direct unconsented protected deal creation is permanently disabled in Factory V2.
     */
    function createProtectedDeal(
        address,
        address,
        MilestoneInit[] calldata
    ) external pure override returns (address) {
        revert("Direct creation disabled: use acceptDealProposal");
    }

    // --- View Helpers ---

    function getProposalStatus(DealProposal calldata proposal) external view override returns (ProposalStatus) {
        bytes32 proposalId = hashDealProposal(proposal);
        return _computeProposalStatus(proposalId, proposal.client, proposal.proposalNonce, proposal.expiry);
    }

    function getProposalStatusById(
        bytes32 proposalId,
        address client,
        uint256 nonce,
        uint256 expiry
    ) external view override returns (ProposalStatus) {
        return _computeProposalStatus(proposalId, client, nonce, expiry);
    }

    function _computeProposalStatus(
        bytes32 proposalId,
        address client,
        uint256 nonce,
        uint256 expiry
    ) internal view returns (ProposalStatus) {
        ProposalStatus s = proposalStatus[proposalId];
        if (s != ProposalStatus.Pending) {
            return s;
        }
        if (usedClientNonces[client][nonce]) {
            return ProposalStatus.Cancelled;
        }
        if (block.timestamp > expiry) {
            return ProposalStatus.Expired;
        }
        return ProposalStatus.Pending;
    }

    function isProposalNonceUsed(address client, uint256 nonce) external view override returns (bool) {
        return usedClientNonces[client][nonce];
    }

    function hashDealProposal(DealProposal calldata proposal) public view override returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            DEAL_PROPOSAL_TYPEHASH,
            proposal.client,
            proposal.freelancer,
            proposal.canonicalUsdc,
            proposal.dealImplementation,
            proposal.primaryResolver,
            proposal.emergencyResolver,
            proposal.milestonesHash,
            proposal.isProtected,
            proposal.protectionModule,
            proposal.policyId,
            proposal.proposalNonce,
            proposal.expiry
        )));
    }

    function hashMilestones(MilestoneInit[] calldata milestoneInits) external pure override returns (bytes32) {
        return keccak256(abi.encode(milestoneInits));
    }

    // --- Discovery & Registry Views ---

    function getDealCount() external view override returns (uint256) {
        return allDeals.length;
    }

    function getDeals(uint256 offset, uint256 limit) external view override returns (address[] memory) {
        uint256 total = allDeals.length;
        if (offset >= total || limit == 0) {
            return new address[](0);
        }
        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }
        uint256 size = end - offset;
        address[] memory result = new address[](size);
        for (uint256 i = 0; i < size; i++) {
            result[i] = allDeals[offset + i];
        }
        return result;
    }

    function getDealsCountByClient(address client) external view override returns (uint256) {
        return _dealsByClient[client].length;
    }

    function getDealsByClient(address client, uint256 offset, uint256 limit) external view override returns (address[] memory) {
        address[] storage userDeals = _dealsByClient[client];
        uint256 total = userDeals.length;
        if (offset >= total || limit == 0) {
            return new address[](0);
        }
        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }
        uint256 size = end - offset;
        address[] memory result = new address[](size);
        for (uint256 i = 0; i < size; i++) {
            result[i] = userDeals[offset + i];
        }
        return result;
    }

    function getDealsCountByFreelancer(address freelancer) external view override returns (uint256) {
        return _dealsByFreelancer[freelancer].length;
    }

    function getDealsByFreelancer(address freelancer, uint256 offset, uint256 limit) external view override returns (address[] memory) {
        address[] storage userDeals = _dealsByFreelancer[freelancer];
        uint256 total = userDeals.length;
        if (offset >= total || limit == 0) {
            return new address[](0);
        }
        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }
        uint256 size = end - offset;
        address[] memory result = new address[](size);
        for (uint256 i = 0; i < size; i++) {
            result[i] = userDeals[offset + i];
        }
        return result;
    }

    // --- Governance Setters (Future Deals Only) ---

    function setDefaultPrimaryResolver(address newResolver) external override onlyOwner {
        require(newResolver != address(0), "Zero resolver address");
        require(newResolver.code.length > 0, "Resolver must be contract");
        address oldResolver = defaultPrimaryResolver;
        defaultPrimaryResolver = newResolver;
        emit PrimaryResolverUpdated(oldResolver, newResolver);
    }

    function setDefaultEmergencyResolver(address newResolver) external override onlyOwner {
        require(newResolver != address(0), "Zero resolver address");
        require(newResolver.code.length > 0, "Resolver must be contract");
        address oldResolver = defaultEmergencyResolver;
        defaultEmergencyResolver = newResolver;
        emit EmergencyResolverUpdated(oldResolver, newResolver);
    }

    function setDealImplementation(address newImplementation) external override onlyOwner {
        require(newImplementation != address(0), "Zero implementation address");
        require(newImplementation.code.length > 0, "Implementation must be contract");
        address oldImpl = dealImplementation;
        dealImplementation = newImplementation;
        emit DealImplementationUpdated(oldImpl, newImplementation);
    }

    function setDefaultProtectionModule(address newModule) external override onlyOwner {
        address oldModule = defaultProtectionModule;
        defaultProtectionModule = newModule;
        emit ProtectionModuleUpdated(oldModule, newModule);
    }

    function setDefaultProtectionPolicyId(bytes32 newPolicyId) external override onlyOwner {
        bytes32 oldPolicy = defaultProtectionPolicyId;
        defaultProtectionPolicyId = newPolicyId;
        emit ProtectionPolicyUpdated(oldPolicy, newPolicyId);
    }
}
