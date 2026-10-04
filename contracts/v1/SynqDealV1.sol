// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "./SynqDealTypes.sol";
import "./ISynqDeal.sol";

/**
 * @title SynqDealV1
 * @notice Core escrow and milestone settlement automaton for Synq Deal V1.
 * @dev Designed to be deployed as minimal proxy clones (ERC-1167) by SynqFactoryV1.
 */
contract SynqDealV1 is Initializable, ReentrancyGuard, EIP712, ISynqDeal {
    using SafeERC20 for IERC20;

    // --- Constants ---
    bytes32 public constant MUTUAL_SETTLEMENT_TYPEHASH = keccak256(
        "MutualSettlementProposal(address dealAddress,uint256 chainId,uint256 milestoneId,address proposer,uint256 freelancerAmount,uint256 clientAmount,uint64 proposalNonce,uint64 validUntil)"
    );

    uint64 public constant REVISION_RESPONSE_WINDOW = 48 hours;
    uint64 public constant PRIMARY_RESOLVER_SLA = 14 days;
    uint64 public constant RECONSIDERATION_WINDOW = 72 hours;
    uint64 public constant CHALLENGE_WINDOW = 48 hours;
    uint64 public constant ASSESSMENT_TIMEOUT = 72 hours;

    // --- Immutables / Deal Storage ---
    address public override client;
    address public override freelancer;
    address public override usdc;
    address public override primaryResolver;
    address public override emergencyResolver;
    bool public override isProtected;
    address public override protectionModule;
    bytes32 public override policyId;

    DealState public override state;
    uint256 public override totalEscrow;
    uint256 public override totalSettled;
    uint256 public override milestoneCount;

    mapping(uint256 => Milestone) internal _milestones;
    mapping(uint256 => uint64) public revisionRequestedAt;
    mapping(uint256 => uint64) public proposedRevisionDeadlines;
    mapping(uint256 => uint256) public override milestoneDisputeOpenedAt;
    mapping(uint256 => mapping(address => mapping(uint64 => bool))) public usedProposalNonces;
    mapping(uint256 => ResolutionProposal) public resolutionProposals;
    mapping(uint256 => AssessmentRequest) public assessmentRequests;
    mapping(uint256 => AssessmentProposal) public assessmentProposals;

    // --- Modifiers ---
    modifier onlyClient() {
        _checkClient();
        _;
    }

    modifier onlyFreelancer() {
        _checkFreelancer();
        _;
    }

    modifier onlyParticipant() {
        _checkParticipant();
        _;
    }

    modifier inDealState(DealState expected) {
        _checkDealState(expected);
        _;
    }

    modifier validMilestone(uint256 milestoneId) {
        _checkMilestone(milestoneId);
        _;
    }

    function _checkClient() internal view {
        require(msg.sender == client, "Only client");
    }

    function _checkFreelancer() internal view {
        require(msg.sender == freelancer, "Only freelancer");
    }

    function _checkParticipant() internal view {
        require(msg.sender == client || msg.sender == freelancer, "Only participant");
    }

    function _checkDealState(DealState expected) internal view {
        require(state == expected, "Invalid deal state");
    }

    function _checkMilestone(uint256 milestoneId) internal view {
        require(milestoneId < milestoneCount, "Invalid milestone ID");
    }

    // --- Constructor & Initialization ---
    constructor() EIP712("SynqDealV1", "1") {
        _disableInitializers();
    }

    /**
     * @notice Initialize the clone instance with participants, tokens, resolvers, and milestones.
     */
    function initialize(
        DealInitParams calldata params,
        MilestoneInit[] calldata _milestoneInits
    ) external initializer {
        require(params.client != address(0), "Zero client address");
        require(params.freelancer != address(0), "Zero freelancer address");
        require(params.client != params.freelancer, "Client equals freelancer");
        require(params.usdc != address(0), "Zero USDC address");
        require(params.usdc.code.length > 0, "USDC must be a contract");
        require(params.primaryResolver != address(0), "Zero primary resolver");
        require(params.emergencyResolver != address(0), "Zero emergency resolver");
        require(_milestoneInits.length > 0, "Zero milestones provided");

        if (params.isProtected) {
            require(params.protectionModule != address(0), "Zero protection module");
            require(params.protectionModule.code.length > 0, "Protection module must be a contract");
            require(params.policyId != bytes32(0), "Zero policy ID");
            isProtected = true;
            protectionModule = params.protectionModule;
            policyId = params.policyId;
        } else {
            require(params.protectionModule == address(0), "Standard deal must have zero protection module");
            require(params.policyId == bytes32(0), "Standard deal must have zero policy ID");
            isProtected = false;
            protectionModule = address(0);
            policyId = bytes32(0);
        }

        client = params.client;
        freelancer = params.freelancer;
        usdc = params.usdc;
        primaryResolver = params.primaryResolver;
        emergencyResolver = params.emergencyResolver;

        uint256 count = _milestoneInits.length;
        milestoneCount = count;
        uint256 runningEscrow = 0;

        for (uint256 i = 0; i < count; i++) {
            MilestoneInit calldata init = _milestoneInits[i];
            require(init.amount > 0, "Zero milestone amount");
            require(init.workDeadline > block.timestamp, "Work deadline in past");
            require(init.reviewWindow >= 1 hours && init.reviewWindow <= 30 days, "Invalid review window");
            require(init.specHash != bytes32(0), "Zero specHash");

            _milestones[i] = Milestone({
                amount: init.amount,
                workDeadline: init.workDeadline,
                reviewWindow: init.reviewWindow,
                gracePeriod: init.gracePeriod,
                status: MilestoneStatus.Pending,
                specHash: init.specHash,
                evidenceRootHash: bytes32(0),
                submittedAt: 0,
                version: 0
            });

            runningEscrow += init.amount;
        }

        totalEscrow = runningEscrow;
        state = DealState.Draft;

        emit DealInitialized(
            address(this),
            params.client,
            params.freelancer,
            params.usdc,
            params.primaryResolver,
            params.emergencyResolver,
            isProtected,
            runningEscrow,
            count
        );
    }

    // --- Funding & Cancellation ---

    /**
     * @notice Funds the deal escrow in full. Must be called by client.
     */
    function fundDeal() external override onlyClient inDealState(DealState.Draft) nonReentrant {
        uint256 balanceBefore = IERC20(usdc).balanceOf(address(this));
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), totalEscrow);
        uint256 balanceAfter = IERC20(usdc).balanceOf(address(this));

        require(balanceAfter - balanceBefore == totalEscrow, "Incomplete collateralization");

        state = DealState.Active;
        emit DealFunded(address(this), totalEscrow);
    }

    /**
     * @notice Unilaterally cancel an unfunded draft deal.
     */
    function cancelBeforeFunding() external override onlyParticipant inDealState(DealState.Draft) {
        state = DealState.Cancelled;
        emit DealCancelled(address(this));
    }

    // --- Standard Milestone Lifecycle ---

    /**
     * @notice Freelancer signals start of work on a pending milestone.
     */
    function startMilestone(uint256 milestoneId)
        external
        override
        onlyFreelancer
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.Pending, "Milestone not pending");

        m.status = MilestoneStatus.InProgress;
        emit MilestoneStarted(milestoneId);
    }

    /**
     * @notice Freelancer submits deliverable with cryptographic evidence commitment.
     */
    function submitWork(uint256 milestoneId, bytes32 evidenceRootHash)
        external
        override
        onlyFreelancer
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.InProgress, "Milestone not in progress");
        require(evidenceRootHash != bytes32(0), "Empty evidence root hash");
        require(block.timestamp <= m.workDeadline + m.gracePeriod, "Work deadline and grace expired");

        m.evidenceRootHash = evidenceRootHash;
        m.submittedAt = uint64(block.timestamp);
        m.version += 1;
        m.status = MilestoneStatus.Submitted;

        emit MilestoneSubmitted(milestoneId, evidenceRootHash, m.specHash, m.version);
    }

    /**
     * @notice Client approves submitted milestone. Releases 100% to freelancer.
     */
    function clientApprove(uint256 milestoneId)
        external
        override
        onlyClient
        inDealState(DealState.Active)
        validMilestone(milestoneId)
        nonReentrant
    {
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.Submitted, "Milestone not submitted");

        m.status = MilestoneStatus.SettledPaid;
        _disburse(freelancer, m.amount);
        emit MilestoneSettled(milestoneId, m.amount, 0, SettlementType.ClientApproval);

        _checkAndFinalizeDeal();
    }

    /**
     * @notice Permissionless settlement if client review window expires without action.
     */
    function settleReviewTimeout(uint256 milestoneId)
        external
        override
        inDealState(DealState.Active)
        validMilestone(milestoneId)
        nonReentrant
    {
        require(!isProtected, "Protected deals must use triggerReviewTimeoutProtected");
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.Submitted, "Milestone not submitted");
        require(block.timestamp > m.submittedAt + m.reviewWindow, "Review window not expired");

        m.status = MilestoneStatus.SettledPaid;
        _disburse(freelancer, m.amount);
        emit MilestoneSettled(milestoneId, m.amount, 0, SettlementType.StandardReviewTimeout);

        _checkAndFinalizeDeal();
    }

    /**
     * @notice On Protected deals, client inactivity after review window routes milestone to assessment.
     */
    function triggerReviewTimeoutProtected(uint256 milestoneId)
        external
        override
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        require(isProtected, "Only protected deals");
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.Submitted, "Milestone not submitted");
        require(block.timestamp > m.submittedAt + m.reviewWindow, "Review window not expired");

        m.status = MilestoneStatus.AssessmentPending;
        assessmentRequests[milestoneId] = AssessmentRequest({
            trigger: AssessmentTrigger.Inactivity,
            requestedAt: uint64(block.timestamp),
            reasonHash: bytes32(0)
        });

        emit AssessmentRequested(milestoneId, AssessmentTrigger.Inactivity, bytes32(0), uint64(block.timestamp));
    }

    /**
     * @notice On Protected deals, ordinary client rejection routes milestone to assessment instead of revision.
     */
    function rejectWorkProtected(uint256 milestoneId, bytes32 rejectionReasonHash)
        external
        override
        onlyClient
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        require(isProtected, "Only protected deals");
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.Submitted, "Milestone not submitted");

        m.status = MilestoneStatus.AssessmentPending;
        assessmentRequests[milestoneId] = AssessmentRequest({
            trigger: AssessmentTrigger.Rejection,
            requestedAt: uint64(block.timestamp),
            reasonHash: rejectionReasonHash
        });

        emit AssessmentRequested(milestoneId, AssessmentTrigger.Rejection, rejectionReasonHash, uint64(block.timestamp));
    }

    /**
     * @notice Permissionless refund to client if work was never submitted before deadline + grace.
     */
    function claimExpiredRefund(uint256 milestoneId)
        external
        override
        inDealState(DealState.Active)
        validMilestone(milestoneId)
        nonReentrant
    {
        Milestone storage m = _milestones[milestoneId];
        require(
            m.status == MilestoneStatus.Pending || m.status == MilestoneStatus.InProgress,
            "Invalid status for expiration refund"
        );
        require(block.timestamp > m.workDeadline + m.gracePeriod, "Deadline and grace not expired");

        m.status = MilestoneStatus.SettledRefunded;
        _disburse(client, m.amount);
        emit MilestoneSettled(milestoneId, 0, m.amount, SettlementType.ExpiredRefund);

        _checkAndFinalizeDeal();
    }

    // --- Revision Lifecycle ---

    /**
     * @notice Client requests revision and proposes an exact new deadline.
     */
    function requestRevision(
        uint256 milestoneId,
        bytes32 reasonHash,
        uint64 proposedRevisionDeadline
    )
        external
        override
        onlyClient
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        require(!isProtected, "Protected deals cannot request revision");
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.Submitted, "Milestone not submitted");
        require(proposedRevisionDeadline > block.timestamp, "Proposed deadline in past");
        require(proposedRevisionDeadline <= block.timestamp + 365 days, "Proposed deadline exceeds max bound");

        m.status = MilestoneStatus.RevisionRequested;
        revisionRequestedAt[milestoneId] = uint64(block.timestamp);
        proposedRevisionDeadlines[milestoneId] = proposedRevisionDeadline;

        emit RevisionRequested(milestoneId, reasonHash, proposedRevisionDeadline);
    }

    /**
     * @notice Freelancer accepts revision. Activates EXACTLY the client's proposed deadline.
     */
    function acceptRevision(uint256 milestoneId)
        external
        override
        onlyFreelancer
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.RevisionRequested, "Revision not requested");

        uint64 newDeadline = proposedRevisionDeadlines[milestoneId];
        require(newDeadline > block.timestamp, "Proposed revision deadline has already expired");

        m.workDeadline = newDeadline;
        m.status = MilestoneStatus.InProgress;

        emit RevisionAccepted(milestoneId, newDeadline);
    }

    /**
     * @notice Freelancer declines revision request, escalating milestone directly to DISPUTED.
     */
    function declineRevision(uint256 milestoneId)
        external
        override
        onlyFreelancer
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.RevisionRequested, "Revision not requested");

        m.status = MilestoneStatus.Disputed;
        milestoneDisputeOpenedAt[milestoneId] = block.timestamp;

        emit RevisionDeclined(milestoneId);
        emit MilestoneDisputed(milestoneId, msg.sender, bytes32(0));
    }

    /**
     * @notice Permissionless transition to DISPUTED if freelancer does not respond within 48h.
     */
    function timeoutRevisionResponse(uint256 milestoneId)
        external
        override
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.RevisionRequested, "Revision not requested");
        require(
            block.timestamp > revisionRequestedAt[milestoneId] + REVISION_RESPONSE_WINDOW,
            "Revision response window not expired"
        );

        m.status = MilestoneStatus.Disputed;
        milestoneDisputeOpenedAt[milestoneId] = block.timestamp;

        emit MilestoneDisputed(milestoneId, address(0), bytes32(0));
    }

    // --- Dispute Entry ---

    /**
     * @notice Participant opens serious dispute from eligible active states, freezing ordinary timeouts.
     */
    function openSeriousDispute(uint256 milestoneId, bytes32 reasonHash)
        external
        override
        onlyParticipant
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        Milestone storage m = _milestones[milestoneId];
        require(
            m.status == MilestoneStatus.InProgress ||
            m.status == MilestoneStatus.Submitted ||
            m.status == MilestoneStatus.RevisionRequested ||
            m.status == MilestoneStatus.AssessmentPending ||
            m.status == MilestoneStatus.AssessmentProposed,
            "Milestone not in eligible dispute state"
        );

        m.status = MilestoneStatus.Disputed;
        milestoneDisputeOpenedAt[milestoneId] = block.timestamp;

        emit SeriousDisputeOpened(milestoneId, msg.sender, reasonHash);
        emit MilestoneDisputed(milestoneId, msg.sender, reasonHash);
    }

    // --- Mutual Settlement ---

    /**
     * @notice Cancel an unexecuted proposal by the proposer.
     */
    function cancelProposal(uint256 milestoneId, uint64 proposalNonce)
        external
        override
        onlyParticipant
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        require(!usedProposalNonces[milestoneId][msg.sender][proposalNonce], "Nonce already used or cancelled");
        usedProposalNonces[milestoneId][msg.sender][proposalNonce] = true;
        emit ProposalCancelled(milestoneId, msg.sender, proposalNonce);
    }

    /**
     * @notice Mutual settlement executed by one participant presenting an EIP-712 signature from counterparty.
     */
    function executeMutualSettlement(
        MutualSettlementProposal calldata proposal,
        bytes calldata counterpartySignature
    )
        external
        override
        onlyParticipant
        inDealState(DealState.Active)
        validMilestone(proposal.milestoneId)
        nonReentrant
    {
        require(proposal.dealAddress == address(this), "Mismatched dealAddress");
        require(proposal.chainId == block.chainid, "Mismatched chainId");
        require(block.timestamp <= proposal.validUntil, "Proposal expired");
        require(proposal.proposer == client || proposal.proposer == freelancer, "Invalid proposal proposer");
        require(msg.sender != proposal.proposer, "Proposer cannot execute own proposal");
        require(!usedProposalNonces[proposal.milestoneId][proposal.proposer][proposal.proposalNonce], "Nonce already used");

        Milestone storage m = _milestones[proposal.milestoneId];
        require(
            m.status == MilestoneStatus.Submitted ||
            m.status == MilestoneStatus.RevisionRequested ||
            m.status == MilestoneStatus.Disputed ||
            m.status == MilestoneStatus.ResolutionProposed ||
            m.status == MilestoneStatus.FinalReview ||
            m.status == MilestoneStatus.AssessmentPending ||
            m.status == MilestoneStatus.AssessmentProposed,
            "Milestone status ineligible for mutual settlement"
        );
        require(
            proposal.freelancerAmount + proposal.clientAmount == m.amount,
            "Split does not equal milestone amount"
        );

        // Verify EIP-712 counterparty signature
        bytes32 structHash = keccak256(
            abi.encode(
                MUTUAL_SETTLEMENT_TYPEHASH,
                proposal.dealAddress,
                proposal.chainId,
                proposal.milestoneId,
                proposal.proposer,
                proposal.freelancerAmount,
                proposal.clientAmount,
                proposal.proposalNonce,
                proposal.validUntil
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, counterpartySignature);

        require(recovered == proposal.proposer, "Invalid signature from proposer");

        usedProposalNonces[proposal.milestoneId][proposal.proposer][proposal.proposalNonce] = true;
        m.status = MilestoneStatus.SettledSplit;

        if (proposal.freelancerAmount > 0) {
            _disburse(freelancer, proposal.freelancerAmount);
        }
        if (proposal.clientAmount > 0) {
            _disburse(client, proposal.clientAmount);
        }

        emit MilestoneSettled(
            proposal.milestoneId,
            proposal.freelancerAmount,
            proposal.clientAmount,
            SettlementType.MutualSettlement
        );

        _checkAndFinalizeDeal();
    }

    // --- Formal Dispute Resolution ---

    /**
     * @notice Submit an initial resolution proposal by the authorized resolver.
     * @dev Before PRIMARY_RESOLVER_SLA (14 days), only primaryResolver can propose.
     *      At/after PRIMARY_RESOLVER_SLA, only emergencyResolver can propose.
     */
    function proposeMilestoneResolution(
        uint256 milestoneId,
        uint256 freelancerAmount,
        uint256 clientAmount,
        bytes32 justificationHash
    )
        external
        override
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.Disputed, "Milestone not disputed");

        uint256 disputeTime = milestoneDisputeOpenedAt[milestoneId];
        require(disputeTime > 0, "Dispute opened time not recorded");

        if (block.timestamp < disputeTime + PRIMARY_RESOLVER_SLA) {
            require(msg.sender == primaryResolver, "Only primary resolver within SLA");
        } else {
            require(msg.sender == emergencyResolver, "Only emergency resolver after SLA");
        }

        require(freelancerAmount + clientAmount == m.amount, "Split does not equal milestone amount");

        uint64 deadline = uint64(block.timestamp + RECONSIDERATION_WINDOW);
        resolutionProposals[milestoneId] = ResolutionProposal({
            freelancerAmount: freelancerAmount,
            clientAmount: clientAmount,
            justificationHash: justificationHash,
            proposedAt: uint64(block.timestamp),
            reconsiderationDeadline: deadline,
            resolver: msg.sender
        });

        m.status = MilestoneStatus.ResolutionProposed;

        emit ResolutionProposed(
            milestoneId,
            msg.sender,
            freelancerAmount,
            clientAmount,
            justificationHash,
            deadline
        );
    }

    /**
     * @notice Participant requests final reconsideration within the 72h window, moving milestone to FINAL_REVIEW.
     */
    function requestFinalReconsideration(uint256 milestoneId)
        external
        override
        onlyParticipant
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.ResolutionProposed, "No active resolution proposed");
        require(
            block.timestamp < resolutionProposals[milestoneId].reconsiderationDeadline,
            "Reconsideration window expired"
        );

        m.status = MilestoneStatus.FinalReview;

        emit FinalReconsiderationRequested(milestoneId, msg.sender);
    }

    /**
     * @notice Permissionlessly execute resolution split after 72h reconsideration window expires without reconsideration.
     */
    function executeResolution(uint256 milestoneId)
        external
        override
        inDealState(DealState.Active)
        validMilestone(milestoneId)
        nonReentrant
    {
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.ResolutionProposed, "No proposed resolution to execute");
        ResolutionProposal memory prop = resolutionProposals[milestoneId];
        require(
            block.timestamp >= prop.reconsiderationDeadline,
            "Reconsideration window active"
        );

        m.status = MilestoneStatus.SettledSplit;

        if (prop.freelancerAmount > 0) {
            _disburse(freelancer, prop.freelancerAmount);
        }
        if (prop.clientAmount > 0) {
            _disburse(client, prop.clientAmount);
        }

        emit ResolutionExecuted(milestoneId, prop.resolver, prop.freelancerAmount, prop.clientAmount);
        emit MilestoneSettled(
            milestoneId,
            prop.freelancerAmount,
            prop.clientAmount,
            SettlementType.ResolverResolution
        );

        _checkAndFinalizeDeal();
    }

    /**
     * @notice Execute final resolution split submitted by the proposing resolver after reconsideration.
     */
    function executeFinalResolution(
        uint256 milestoneId,
        uint256 freelancerAmount,
        uint256 clientAmount,
        bytes32 justificationHash
    )
        external
        override
        inDealState(DealState.Active)
        validMilestone(milestoneId)
        nonReentrant
    {
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.FinalReview, "Milestone not in final review");
        require(
            msg.sender == resolutionProposals[milestoneId].resolver,
            "Only proposing resolver can finalize"
        );
        require(freelancerAmount + clientAmount == m.amount, "Split does not equal milestone amount");

        m.status = MilestoneStatus.SettledSplit;

        if (freelancerAmount > 0) {
            _disburse(freelancer, freelancerAmount);
        }
        if (clientAmount > 0) {
            _disburse(client, clientAmount);
        }

        emit FinalResolutionExecuted(milestoneId, msg.sender, freelancerAmount, clientAmount, justificationHash);
        emit MilestoneSettled(
            milestoneId,
            freelancerAmount,
            clientAmount,
            SettlementType.ResolverResolution
        );

        _checkAndFinalizeDeal();
    }

    function getResolutionProposal(uint256 milestoneId)
        external
        view
        override
        validMilestone(milestoneId)
        returns (ResolutionProposal memory)
    {
        return resolutionProposals[milestoneId];
    }

    // --- Active Protection Methods ---

    /**
     * @notice Registers an AI assessment proposal from the authorized protection module.
     */
    function registerAssessmentProposal(
        uint256 milestoneId,
        uint16 completionBps,
        bytes32 reportHash
    )
        external
        override
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        require(isProtected, "Deal not protected");
        require(msg.sender == protectionModule, "Only protection module");
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.AssessmentPending, "Milestone not awaiting assessment");
        require(
            block.timestamp < assessmentRequests[milestoneId].requestedAt + ASSESSMENT_TIMEOUT,
            "Assessment timeout expired"
        );
        require(completionBps <= 10000, "completionBps exceeds 10000");

        uint64 challengeDeadline = uint64(block.timestamp + CHALLENGE_WINDOW);
        assessmentProposals[milestoneId] = AssessmentProposal({
            completionBps: completionBps,
            reportHash: reportHash,
            proposedAt: uint64(block.timestamp),
            challengeDeadline: challengeDeadline,
            clientAccepted: false,
            freelancerAccepted: false
        });

        m.status = MilestoneStatus.AssessmentProposed;

        emit AssessmentProposed(milestoneId, completionBps, reportHash, challengeDeadline);
    }

    /**
     * @notice Either participant can challenge the assessment during the 48h window, escalating to formal dispute.
     */
    function challengeAssessment(uint256 milestoneId)
        external
        override
        onlyParticipant
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        require(isProtected, "Deal not protected");
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.AssessmentProposed, "No proposed assessment to challenge");
        require(
            block.timestamp < assessmentProposals[milestoneId].challengeDeadline,
            "Challenge window expired"
        );

        m.status = MilestoneStatus.Disputed;
        milestoneDisputeOpenedAt[milestoneId] = block.timestamp;

        emit AssessmentChallenged(milestoneId, msg.sender);
        emit MilestoneDisputed(milestoneId, msg.sender, bytes32(0));
    }

    /**
     * @notice Participant explicitly accepts the proposed assessment.
     */
    function acceptAssessment(uint256 milestoneId)
        external
        override
        onlyParticipant
        inDealState(DealState.Active)
        validMilestone(milestoneId)
    {
        require(isProtected, "Deal not protected");
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.AssessmentProposed, "No proposed assessment");

        AssessmentProposal storage prop = assessmentProposals[milestoneId];
        if (msg.sender == client) {
            prop.clientAccepted = true;
        } else {
            prop.freelancerAccepted = true;
        }

        emit AssessmentAccepted(milestoneId, msg.sender);
    }

    /**
     * @notice Permissionlessly executes assessment settlement after 48h challenge window or if both accepted.
     */
    function executeAssessmentSettlement(uint256 milestoneId)
        external
        override
        inDealState(DealState.Active)
        validMilestone(milestoneId)
        nonReentrant
    {
        require(isProtected, "Deal not protected");
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.AssessmentProposed, "No proposed assessment to execute");

        AssessmentProposal storage prop = assessmentProposals[milestoneId];
        require(
            block.timestamp >= prop.challengeDeadline || (prop.clientAccepted && prop.freelancerAccepted),
            "Challenge window active"
        );

        m.status = MilestoneStatus.SettledSplit;

        uint256 freelancerAmount = (m.amount * uint256(prop.completionBps)) / 10000;
        uint256 clientAmount = m.amount - freelancerAmount;

        if (freelancerAmount > 0) {
            _disburse(freelancer, freelancerAmount);
        }
        if (clientAmount > 0) {
            _disburse(client, clientAmount);
        }

        emit AssessmentSettled(milestoneId, prop.completionBps, freelancerAmount, clientAmount);
        emit MilestoneSettled(milestoneId, freelancerAmount, clientAmount, SettlementType.AssessmentSettlement);

        _checkAndFinalizeDeal();
    }

    /**
     * @notice Permissionless AI failure fallback after 72h assessment timeout.
     * @dev Inactivity trigger falls back to 100% freelancer payout; Rejection trigger escalates to DISPUTED.
     */
    function timeoutAssessment(uint256 milestoneId)
        external
        override
        inDealState(DealState.Active)
        validMilestone(milestoneId)
        nonReentrant
    {
        require(isProtected, "Deal not protected");
        Milestone storage m = _milestones[milestoneId];
        require(m.status == MilestoneStatus.AssessmentPending, "Milestone not awaiting assessment");

        AssessmentRequest memory req = assessmentRequests[milestoneId];
        require(block.timestamp >= req.requestedAt + ASSESSMENT_TIMEOUT, "Assessment timeout not reached");

        if (req.trigger == AssessmentTrigger.Inactivity) {
            m.status = MilestoneStatus.SettledPaid;
            _disburse(freelancer, m.amount);

            emit AssessmentTimeoutResolved(milestoneId, AssessmentTrigger.Inactivity, m.amount, 0);
            emit MilestoneSettled(milestoneId, m.amount, 0, SettlementType.StandardReviewTimeout);

            _checkAndFinalizeDeal();
        } else {
            // Rejection trigger
            m.status = MilestoneStatus.Disputed;
            milestoneDisputeOpenedAt[milestoneId] = block.timestamp;

            emit AssessmentTimeoutResolved(milestoneId, AssessmentTrigger.Rejection, 0, 0);
            emit MilestoneDisputed(milestoneId, address(0), bytes32(0));
        }
    }

    function getAssessmentRequest(uint256 milestoneId)
        external
        view
        override
        validMilestone(milestoneId)
        returns (AssessmentRequest memory)
    {
        return assessmentRequests[milestoneId];
    }

    function getAssessmentProposal(uint256 milestoneId)
        external
        view
        override
        validMilestone(milestoneId)
        returns (AssessmentProposal memory)
    {
        return assessmentProposals[milestoneId];
    }

    // --- Internal Helpers ---

    function _disburse(address to, uint256 amount) internal {
        totalSettled += amount;
        IERC20(usdc).safeTransfer(to, amount);
    }

    function _checkAndFinalizeDeal() internal {
        for (uint256 i = 0; i < milestoneCount; i++) {
            MilestoneStatus s = _milestones[i].status;
            if (
                s != MilestoneStatus.SettledPaid &&
                s != MilestoneStatus.SettledRefunded &&
                s != MilestoneStatus.SettledSplit
            ) {
                return;
            }
        }
        state = DealState.Completed;
        emit DealCompleted(address(this));
    }

    // --- Views ---

    function getMilestone(uint256 milestoneId)
        external
        view
        override
        validMilestone(milestoneId)
        returns (Milestone memory)
    {
        return _milestones[milestoneId];
    }
}
