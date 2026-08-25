// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Minimal view of a deal, declared locally to avoid importing NexotiqDeal
/// (which pulls in the factory's dependency graph).
interface ICoveredDeal {
    /// 0=Draft 1=Active 2=Completed 3=Disputed 4=Cancelled
    function status() external view returns (uint8);
    function buyer() external view returns (address);
}

/**
 * Protection pool for Synq deals.
 *
 * Coverage is deliberately restricted to native-ETH deals. The pool holds and
 * pays out ETH, so pricing a premium off an ERC20 `coverageAmount` mixed base
 * units with wei — a 100 USDC deal (1e8 base units) priced a premium of
 * 500_000 wei, i.e. effectively free coverage. Refusing ERC20 coverage is
 * honest; silently mispricing it was not.
 */
contract NexotiqProtection {
    address public factory;
    address public feeCollector;

    /// Floor so dust deals still pay something. Exposed as a constant so the UI
    /// can never drift from it — and the UI should read `coverages[deal].premium`
    /// rather than recompute the premium at all.
    uint256 public constant MIN_PREMIUM = 1e12; // 0.000001 ETH

    struct Coverage {
        address dealAddress;
        address buyer;
        uint256 coverageAmount;
        uint256 premium;
        uint256 riskScore;
        bool active;
        bool claimed;
        /// Was the premium actually received? `createCoverage` only quotes it.
        bool premiumPaid;
    }

    mapping(address => Coverage) public coverages;

    /// ETH actually received as premiums. Previously this was incremented when
    /// coverage was *quoted*, so the UI reported 0.004 ETH of premiums while the
    /// pool held 0 ETH.
    uint256 public totalPremiums;
    uint256 public totalPayouts;
    /// Sum of quoted premiums, paid or not — the old meaning of totalPremiums,
    /// kept as a separate number so nothing has to lie.
    uint256 public totalPremiumsQuoted;
    /// Coverage that has been filed against and not yet resolved. Blocks
    /// withdrawPremiums so the operator cannot drain the pool out from under a
    /// pending claim.
    uint256 public openClaims;

    event CoverageCreated(address indexed deal, address indexed buyer, uint256 amount, uint256 premium);
    event PremiumPaid(address indexed deal, address indexed payer, uint256 amount);
    event ClaimFiled(address indexed deal, uint256 amount);
    event ClaimResolved(address indexed deal, bool approved, uint256 payout, uint256 shortfall);
    event CoverageClosed(address indexed deal);
    event PoolFunded(address indexed from, uint256 amount);
    event PremiumsWithdrawn(address indexed to, uint256 amount);

    modifier onlyFactory() { require(msg.sender == factory, "Only factory"); _; }

    constructor(address _factory, address _feeCollector) {
        require(_factory != address(0) && _feeCollector != address(0), "Zero address");
        factory = _factory;
        feeCollector = _feeCollector;
    }

    /**
     * @notice Quote and register coverage for a deal. Called by the factory at
     * deal creation. The premium is only a quote until `payPremium` is called —
     * an unpaid coverage cannot be claimed against.
     * @param _asset The deal's asset. Must be address(0) (native ETH); see the
     * contract-level note on why ERC20 coverage is refused rather than mispriced.
     */
    function createCoverage(
        address _dealAddress,
        address _buyer,
        uint256 _coverageAmount,
        uint256 _riskScore,
        address _asset
    ) external onlyFactory returns (uint256 premium) {
        require(_dealAddress != address(0) && _buyer != address(0), "Zero address");
        require(_asset == address(0), "ETH deals only");
        require(_coverageAmount > 0, "Zero coverage");
        require(_riskScore <= 100, "Risk out of range");
        require(coverages[_dealAddress].dealAddress == address(0), "Coverage exists");

        premium = (_coverageAmount * _riskScore) / 10000;
        if (premium < MIN_PREMIUM) premium = MIN_PREMIUM;

        coverages[_dealAddress] = Coverage({
            dealAddress: _dealAddress,
            buyer: _buyer,
            coverageAmount: _coverageAmount,
            premium: premium,
            riskScore: _riskScore,
            active: true,
            claimed: false,
            premiumPaid: false
        });
        totalPremiumsQuoted += premium;

        emit CoverageCreated(_dealAddress, _buyer, _coverageAmount, premium);
        return premium;
    }

    /// @notice Pay the quoted premium. Anyone may pay on the buyer's behalf.
    function payPremium(address _dealAddress) external payable {
        Coverage storage cov = coverages[_dealAddress];
        require(cov.active, "No active coverage");
        require(!cov.premiumPaid, "Premium already paid");
        require(msg.value == cov.premium, "Premium must match coverage premium");

        cov.premiumPaid = true;
        // Credited on receipt, not on quote — this is the number the pool balance
        // can actually be reconciled against.
        totalPremiums += msg.value;
        emit PremiumPaid(_dealAddress, msg.sender, msg.value);
    }

    /**
     * @notice File a claim against coverage. Buyer only.
     *
     * Previously this had no access control and no status check, so anyone could
     * file against anyone's deal — including a happily Completed one, which
     * permanently locked that coverage in a claimed-but-unresolvable state.
     */
    function fileClaim(address _dealAddress) external {
        Coverage storage cov = coverages[_dealAddress];
        require(cov.active, "No active coverage");
        require(msg.sender == cov.buyer, "Only buyer");
        require(cov.premiumPaid, "Premium not paid");
        require(!cov.claimed, "Already claimed");

        // Only a live or disputed deal can be claimed against.
        uint8 st = ICoveredDeal(_dealAddress).status();
        require(st == 1 || st == 3, "Deal not claimable");

        cov.claimed = true;
        openClaims += 1;
        emit ClaimFiled(_dealAddress, cov.coverageAmount);
    }

    /**
     * @notice Resolve a filed claim.
     *
     * A premium-funded pool cannot cover full deal value, so the payout is
     * capped at the pool balance and any shortfall is emitted rather than
     * reverting with "Insufficient pool" and stranding the claim forever.
     * Top the pool up with `fundPool()` before resolving to pay in full.
     */
    function resolveClaim(address _dealAddress, bool _approved) external onlyFactory {
        Coverage storage cov = coverages[_dealAddress];
        require(cov.claimed, "No claim filed");
        require(cov.active, "Not active");

        uint256 payout = 0;
        uint256 shortfall = 0;

        if (_approved) {
            uint256 owed = cov.coverageAmount;
            uint256 balance = address(this).balance;
            payout = owed > balance ? balance : owed;
            shortfall = owed - payout;

            if (payout > 0) {
                totalPayouts += payout;
                (bool sent,) = cov.buyer.call{value: payout}("");
                require(sent, "Payout failed");
            }
        }

        cov.active = false;
        openClaims -= 1;
        emit ClaimResolved(_dealAddress, _approved, payout, shortfall);
    }

    /**
     * @notice Close coverage when its deal reaches a terminal state. Called by
     * the factory from `onDealSettled`. A coverage with a claim already filed is
     * left open so the claim can still be resolved.
     */
    function closeCoverage(address _dealAddress) external onlyFactory {
        Coverage storage cov = coverages[_dealAddress];
        if (!cov.active || cov.claimed) return;
        cov.active = false;
        emit CoverageClosed(_dealAddress);
    }

    /// @notice Capitalize the pool. Premiums alone cannot cover full deal value.
    function fundPool() external payable {
        require(msg.value > 0, "Nothing sent");
        emit PoolFunded(msg.sender, msg.value);
    }

    function withdrawPremiums() external {
        require(msg.sender == feeCollector, "Not authorized");
        require(openClaims == 0, "Claims pending");
        uint256 balance = address(this).balance;
        require(balance > 0, "Nothing to withdraw");
        (bool sent,) = feeCollector.call{value: balance}("");
        require(sent, "Withdraw failed");
        emit PremiumsWithdrawn(feeCollector, balance);
    }

    function getCoverage(address _dealAddress) external view returns (Coverage memory) {
        return coverages[_dealAddress];
    }

    /// @notice What the pool can actually pay out right now.
    function poolBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // Deliberately no `receive()`: every ETH entering the pool should arrive
    // through payPremium or fundPool so it is attributed and emits an event.
    // A bare payable fallback also forced callers to cast to `address payable`.
}
