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
import "./ISynqProtectionManagerV1_1.sol";

/**
 * @title SynqPremiumProtectionManagerV1_1
 * @notice Enhanced core management contract for Synq Premium Protection V1.1.
 * @dev Introduces purchase-time eligibility snapshotting (coveredBitmap) and partial-deal economics.
 *      Enforces that only unstarted (Pending), unexpired milestones with positive escrow can enter coverage.
 *      Excludes InProgress, Submitted, Disputed, and Settled milestones from retrospective coverage.
 *      Premium calculation and maximum coverage are strictly based on eligiblePrincipal rather than totalEscrow.
 */
contract SynqPremiumProtectionManagerV1_1 is ISynqProtectionManagerV1_1, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Fixed Protocol Parameters ---
    uint16 public constant COVERAGE_RATE_BPS = 2000; // 20% fixed V1.1 coverage rate
    uint16 public constant BPS_DENOMINATOR = 10000;
    uint16 public constant MAX_PREMIUM_FEE_BPS = 3000; // 30% maximum configurable fee cap
    uint256 public constant MAX_MILESTONES = 16; // Maximum supported milestones for 16-bit bitmap

    // --- Immutable Core Dependencies ---
    ISynqFactory public immutable factory;
    IERC20 public immutable usdc;
    ISynqProtectionPool public immutable pool;

    // --- Configurable Governance Parameters ---
    address public protectionCommittee;
    uint16 public premiumFeeBps;

    // --- Storage ---
    mapping(address => PolicyV1_1) public policies;
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
     * @notice Purchases a Premium Protection policy with purchase-time milestone eligibility snapshotting.
     * @dev Restricted to verified deal client. Evaluates each milestone individually:
     *      Only Pending milestones whose workDeadline + gracePeriod >= block.timestamp are included.
     *      Calculates premiumFee and maxCoverage exclusively from eligiblePrincipal.
     * @param dealAddress Address of authentic Synq Deal clone.
     */
    function purchasePolicy(address dealAddress) external override nonReentrant returns (uint256 premiumFee) {
        require(dealAddress != address(0), "Zero deal address");
        require(factory.isSynqDeal(dealAddress), "Deal not registered with Factory");

        ISynqDeal deal = ISynqDeal(dealAddress);
        address client = deal.client();
        require(msg.sender == client, "Only deal client can purchase");
        require(deal.usdc() == address(usdc), "USDC asset mismatch");
        require(deal.state() == DealState.Active, "Deal must be active and funded");

        PolicyV1_1 storage p = policies[dealAddress];
        require(!p.active && p.purchasedAt == 0, "Policy already exists for deal");
        require(premiumFeeBps > 0, "Premium fee not configured");

        uint256 count = deal.milestoneCount();
        require(count > 0, "Deal has zero milestones");
        require(count <= MAX_MILESTONES, "Milestone count exceeds maximum 16");

        uint16 coveredBitmap = 0;
        uint256 eligiblePrincipal = 0;

        for (uint256 i = 0; i < count; i++) {
            Milestone memory m = deal.getMilestone(i);
            // Strict V1.1 eligibility: Pending only, unexpired, amount > 0
            if (
                m.status == MilestoneStatus.Pending &&
                block.timestamp <= m.workDeadline + m.gracePeriod &&
                m.amount > 0
            ) {
                coveredBitmap |= uint16(1 << i);
                eligiblePrincipal += m.amount;
            }
        }

        require(eligiblePrincipal > 0, "No eligible milestones for protection");

        premiumFee = (eligiblePrincipal * uint256(premiumFeeBps)) / BPS_DENOMINATOR;
        require(premiumFee > 0, "Zero premium fee");

        uint256 maxCoverage = (eligiblePrincipal * uint256(COVERAGE_RATE_BPS)) / BPS_DENOMINATOR;
        require(maxCoverage > 0, "Zero max coverage");

        // Transfer premium fee directly from client into ProtectionPool
        usdc.safeTransferFrom(msg.sender, address(pool), premiumFee);

        policies[dealAddress] = PolicyV1_1({
            client: client,
            purchasedAt: uint64(block.timestamp),
            coveredBitmap: coveredBitmap,
            active: true,
            eligiblePrincipal: eligiblePrincipal,
            premiumPaid: premiumFee,
            maxCoverage: maxCoverage,
            totalPaid: 0
        });

        emit PolicyPurchased(dealAddress, client, eligiblePrincipal, coveredBitmap, premiumFee, maxCoverage);
    }

    // --- Claim Submission ---

    /**
     * @notice Submits a protection claim on an eligible failed milestone.
     * @dev Enforces that milestone was captured in the purchase-time coveredBitmap snapshot
     *      and has finalized as SettledRefunded (exclusive to ExpiredRefund).
     * @param dealAddress Address of protected Synq Deal.
     * @param milestoneId 0-indexed milestone ID.
     * @param evidenceHash Cryptographic hash of claimant's failure evidence.
     */
    function submitClaim(
        address dealAddress,
        uint256 milestoneId,
        bytes32 evidenceHash
    ) external override {
        PolicyV1_1 storage policy = policies[dealAddress];
        require(policy.active, "Policy not active");
        require(msg.sender == policy.client, "Only policy client can submit claim");

        ISynqDeal deal = ISynqDeal(dealAddress);
        require(milestoneId < deal.milestoneCount(), "Invalid milestone ID");
        require(milestoneId < MAX_MILESTONES, "Milestone ID exceeds maximum 16");

        // Verify milestone was snapshotted as covered at purchase time
        require((policy.coveredBitmap & (1 << milestoneId)) != 0, "Milestone not covered by policy");

        Claim storage claim = claims[dealAddress][milestoneId];
        require(claim.status == ClaimStatus.None, "Claim already recorded");

        Milestone memory m = deal.getMilestone(milestoneId);
        // Objective V1.1 eligibility: milestone finalized as SettledRefunded (expired deadline + grace refund)
        require(m.status == MilestoneStatus.SettledRefunded, "Milestone not eligible: not SettledRefunded");
        require(m.amount > 0, "Zero milestone amount");
        require(policy.maxCoverage > policy.totalPaid, "Policy coverage cap exhausted");

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
     * @dev Restricted strictly to authorized SynqProtectionCommittee.
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

        PolicyV1_1 storage policy = policies[dealAddress];
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
     * @notice Disburses an Approved claim payout from ProtectionPool to client.
     * @dev Anyone can call to disburse an approved claim. Reverts if pool liquidity is insufficient.
     */
    function disburseClaim(
        address dealAddress,
        uint256 milestoneId
    ) external override nonReentrant returns (uint256 payoutAmount) {
        Claim storage claim = claims[dealAddress][milestoneId];
        require(claim.status == ClaimStatus.Approved, "Claim not in Approved status");

        PolicyV1_1 storage policy = policies[dealAddress];
        require(policy.active, "Policy not active");

        uint256 remainingCoverage = policy.maxCoverage > policy.totalPaid
            ? policy.maxCoverage - policy.totalPaid
            : 0;

        uint256 rawPayout = (claim.milestoneAmount * uint256(COVERAGE_RATE_BPS)) / BPS_DENOMINATOR;
        payoutAmount = rawPayout < remainingCoverage ? rawPayout : remainingCoverage;
        require(payoutAmount > 0, "Policy coverage cap exhausted");

        // Verify pool has sufficient liquidity
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

    function getPolicy(address dealAddress) external view override returns (PolicyV1_1 memory) {
        return policies[dealAddress];
    }

    function getClaim(address dealAddress, uint256 milestoneId) external view override returns (Claim memory) {
        return claims[dealAddress][milestoneId];
    }

    function isMilestoneCovered(address dealAddress, uint256 milestoneId) external view override returns (bool) {
        if (milestoneId >= MAX_MILESTONES) return false;
        return (policies[dealAddress].coveredBitmap & (1 << milestoneId)) != 0;
    }
}
