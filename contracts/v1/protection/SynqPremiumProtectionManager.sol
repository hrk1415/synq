// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../ISynqFactory.sol";
import "../ISynqDeal.sol";
import "../SynqDealTypes.sol";
import "./ISynqProtectionPool.sol";
import "./ISynqProtectionManager.sol";

/**
 * @title SynqPremiumProtectionManager
 * @notice Core management contract for Synq Premium Protection V1.
 * @dev Manages client policy issuance, per-milestone claim registration, deterministic
 *      payout calculations, and claim disbursement triggers to the ProtectionPool.
 *      External to Standard V2 Deal execution: observes authentic Deal and milestone states
 *      without modifying or intercepting Standard V2 sequential settlement.
 */
contract SynqPremiumProtectionManager is ISynqProtectionManager, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Fixed Protocol Parameters ---
    uint16 public constant COVERAGE_RATE_BPS = 2000; // 20% fixed V1 coverage rate
    uint16 public constant BPS_DENOMINATOR = 10000;
    uint16 public constant MAX_PREMIUM_FEE_BPS = 3000; // 30% maximum configurable fee cap

    // --- Immutable Core Dependencies ---
    ISynqFactory public immutable factory;
    IERC20 public immutable usdc;
    ISynqProtectionPool public immutable pool;

    // --- Configurable Governance Parameters ---
    address public protectionCommittee;
    uint16 public premiumFeeBps;

    // --- Storage ---
    mapping(address => Policy) public policies;
    mapping(address => mapping(uint256 => Claim)) public claims;

    constructor(
        address initialOwner,
        address _factory,
        address _usdc,
        address _pool,
        address _initialCommittee,
        uint16 _initialFeeBps
    ) Ownable(initialOwner) {
        require(_factory != address(0), "Zero factory address");
        require(_factory.code.length > 0, "Factory must be contract");
        require(_usdc != address(0), "Zero USDC address");
        require(_pool != address(0), "Zero pool address");
        require(_pool.code.length > 0, "Pool must be contract");
        require(ISynqProtectionPool(_pool).usdc() == _usdc, "Mismatched pool USDC");
        require(_initialCommittee != address(0), "Zero committee address");
        require(_initialFeeBps <= MAX_PREMIUM_FEE_BPS, "Fee exceeds maximum");

        factory = ISynqFactory(_factory);
        usdc = IERC20(_usdc);
        pool = ISynqProtectionPool(_pool);
        protectionCommittee = _initialCommittee;
        premiumFeeBps = _initialFeeBps;

        emit CommitteeUpdated(address(0), _initialCommittee);
        if (_initialFeeBps > 0) {
            emit PremiumFeeRateUpdated(0, _initialFeeBps);
        }
    }

    // --- Governance Setters (onlyOwner) ---

    function setPremiumFeeBps(uint16 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_PREMIUM_FEE_BPS, "Fee exceeds maximum");
        uint16 oldFee = premiumFeeBps;
        premiumFeeBps = newFeeBps;
        emit PremiumFeeRateUpdated(oldFee, newFeeBps);
    }

    function setProtectionCommittee(address newCommittee) external onlyOwner {
        require(newCommittee != address(0), "Zero committee address");
        require(newCommittee != protectionCommittee, "Identical committee");
        address oldCommittee = protectionCommittee;
        protectionCommittee = newCommittee;
        emit CommitteeUpdated(oldCommittee, newCommittee);
    }

    // --- Policy Purchase ---

    /**
     * @notice Purchases a Premium Protection policy for a funded, authentic Standard V2 Deal.
     * @dev Restricted to the verified Deal client. Transfers premiumFee USDC directly into ProtectionPool.
     * @param dealAddress The address of the authentic Synq Deal clone.
     */
    function purchasePolicy(address dealAddress) external override nonReentrant returns (uint256 premiumFee) {
        require(dealAddress != address(0), "Zero deal address");
        require(factory.isSynqDeal(dealAddress), "Deal not registered with Factory");

        ISynqDeal deal = ISynqDeal(dealAddress);
        address client = deal.client();
        require(msg.sender == client, "Only deal client can purchase");
        require(deal.usdc() == address(usdc), "USDC asset mismatch");
        require(deal.state() == DealState.Active, "Deal must be active and funded");

        uint256 totalEscrow = deal.totalEscrow();
        require(totalEscrow > 0, "Deal has zero total escrow");

        Policy storage p = policies[dealAddress];
        require(!p.active && p.purchasedAt == 0, "Policy already exists for deal");
        require(premiumFeeBps > 0, "Premium fee not configured");

        premiumFee = (totalEscrow * uint256(premiumFeeBps)) / BPS_DENOMINATOR;
        require(premiumFee > 0, "Zero premium fee");

        uint256 maxCoverage = (totalEscrow * uint256(COVERAGE_RATE_BPS)) / BPS_DENOMINATOR;

        // Transfer premium fee directly from client into ProtectionPool
        usdc.safeTransferFrom(msg.sender, address(pool), premiumFee);

        policies[dealAddress] = Policy({
            client: client,
            purchasedAt: uint64(block.timestamp),
            premiumPaid: premiumFee,
            maxCoverage: maxCoverage,
            totalPaid: 0,
            active: true
        });

        emit PolicyPurchased(dealAddress, client, totalEscrow, premiumFee, maxCoverage);
    }

    // --- Claim Submission ---

    /**
     * @notice Submits a protection claim on an eligible failed milestone.
     * @dev Eligibility in V1 requires the milestone to have finalized as SettledRefunded via ExpiredRefund.
     * @param dealAddress The address of the protected Synq Deal.
     * @param milestoneId The 0-indexed milestone ID.
     * @param evidenceHash Cryptographic hash of claimant's failure evidence.
     */
    function submitClaim(
        address dealAddress,
        uint256 milestoneId,
        bytes32 evidenceHash
    ) external override {
        Policy storage policy = policies[dealAddress];
        require(policy.active, "Policy not active");
        require(msg.sender == policy.client, "Only policy client can submit claim");

        Claim storage claim = claims[dealAddress][milestoneId];
        require(claim.status == ClaimStatus.None, "Claim already recorded");

        ISynqDeal deal = ISynqDeal(dealAddress);
        require(milestoneId < deal.milestoneCount(), "Invalid milestone ID");

        Milestone memory m = deal.getMilestone(milestoneId);
        // Objective V1 eligibility: milestone finalized as SettledRefunded (expired deadline + grace refund)
        require(m.status == MilestoneStatus.SettledRefunded, "Milestone not eligible: not SettledRefunded");
        require(m.amount > 0, "Zero milestone amount");

        claims[dealAddress][milestoneId] = Claim({
            status: ClaimStatus.Submitted,
            milestoneId: milestoneId,
            milestoneAmount: m.amount,
            evidenceHash: evidenceHash,
            decisionReportHash: bytes32(0),
            submittedAt: uint64(block.timestamp),
            resolvedAt: 0,
            payout: 0
        });

        emit ClaimSubmitted(dealAddress, milestoneId, msg.sender, m.amount, evidenceHash);
    }

    // --- Committee Decision Recording ---

    /**
     * @notice Records a 2-of-3 signed committee decision (Approve or Reject).
     * @dev Restricted strictly to the authorized SynqProtectionCommittee.
     *      Committee cannot set or adjust payout amount; payout is deterministic.
     */
    function recordCommitteeDecision(
        address dealAddress,
        uint256 milestoneId,
        CommitteeDecision decision,
        bytes32 decisionReportHash
    ) external override {
        require(msg.sender == protectionCommittee, "Only protection committee");

        Claim storage claim = claims[dealAddress][milestoneId];
        require(claim.status == ClaimStatus.Submitted, "Claim not in Submitted status");

        Policy storage policy = policies[dealAddress];
        require(policy.active, "Policy not active");

        if (decision == CommitteeDecision.Approve) {
            claim.status = ClaimStatus.Approved;
            claim.decisionReportHash = decisionReportHash;
            claim.resolvedAt = uint64(block.timestamp);

            // Deterministic calculation: 20% of canonical milestone amount, capped at remaining policy coverage
            uint256 rawPayout = (claim.milestoneAmount * uint256(COVERAGE_RATE_BPS)) / BPS_DENOMINATOR;
            uint256 remainingCoverage = policy.maxCoverage > policy.totalPaid
                ? policy.maxCoverage - policy.totalPaid
                : 0;

            uint256 actualPayout = rawPayout < remainingCoverage ? rawPayout : remainingCoverage;
            require(actualPayout > 0, "Policy coverage cap exhausted");

            claim.payout = actualPayout;

            emit ClaimApproved(dealAddress, milestoneId, actualPayout, decisionReportHash);
        } else if (decision == CommitteeDecision.Reject) {
            claim.status = ClaimStatus.Rejected;
            claim.decisionReportHash = decisionReportHash;
            claim.resolvedAt = uint64(block.timestamp);

            emit ClaimRejected(dealAddress, milestoneId, decisionReportHash);
        } else {
            revert("Invalid committee decision");
        }
    }

    // --- Claim Disbursement ---

    /**
     * @notice Disburses an Approved claim payout from ProtectionPool to the client.
     * @dev Anyone can call to disburse an approved claim. Reverts if pool liquidity is insufficient.
     */
    function disburseClaim(
        address dealAddress,
        uint256 milestoneId
    ) external override nonReentrant returns (uint256 payoutAmount) {
        Claim storage claim = claims[dealAddress][milestoneId];
        require(claim.status == ClaimStatus.Approved, "Claim not in Approved status");

        Policy storage policy = policies[dealAddress];
        require(policy.active, "Policy not active");

        // Live remaining coverage calculation prevents concurrent approval overpayments
        uint256 remainingCoverage = policy.maxCoverage > policy.totalPaid
            ? policy.maxCoverage - policy.totalPaid
            : 0;

        uint256 rawPayout = (claim.milestoneAmount * uint256(COVERAGE_RATE_BPS)) / BPS_DENOMINATOR;
        payoutAmount = rawPayout < remainingCoverage ? rawPayout : remainingCoverage;
        require(payoutAmount > 0, "Policy coverage cap exhausted");

        // Verify pool has sufficient liquidity (reverts cleanly without mutating state if shortfall exists)
        require(pool.availableBalance() >= payoutAmount, "Insufficient pool liquidity");

        // Checks-Effects-Interactions
        claim.status = ClaimStatus.Paid;
        claim.payout = payoutAmount;
        policy.totalPaid += payoutAmount;

        if (policy.totalPaid >= policy.maxCoverage) {
            policy.active = false;
        }

        pool.payout(policy.client, payoutAmount);

        emit ClaimPaid(dealAddress, milestoneId, policy.client, payoutAmount);
    }

    // --- View Getters ---

    function getPolicy(address dealAddress) external view override returns (Policy memory) {
        return policies[dealAddress];
    }

    function getClaim(address dealAddress, uint256 milestoneId) external view override returns (Claim memory) {
        return claims[dealAddress][milestoneId];
    }
}
