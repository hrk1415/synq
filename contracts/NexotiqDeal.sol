// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @dev Declared locally rather than importing NexotiqFactory, which imports
/// this file — a direct import would be circular.
interface IDealSettlementSink {
    function onDealSettled(bool success, uint256 value) external;
}

contract NexotiqDeal is ReentrancyGuard {
    address public factory;
    address public buyer;
    address public seller;
    /// @dev address(0) means native ETH, otherwise the ERC20 token (e.g. USDC/EURC on Arc)
    address public asset;

    string public title;
    string public description;
    uint256 public totalValue;
    uint256 public deadline;
    uint256 public riskScore;
    bool public protectionEnabled;

    enum DealStatus { Draft, Active, Completed, Disputed, Cancelled }
    enum MilestoneStatus { Pending, InProgress, Completed, Approved, Rejected }

    DealStatus public status;
    uint256 public currentMilestone;

    struct Milestone {
        string title;
        string description;
        uint256 amount;
        MilestoneStatus msStatus;
        uint256 dueDate;
        string evidenceHash;
        uint256 completedAt;
    }

    struct Dispute {
        address openedBy;
        string reason;
        string aiSummary;
        string aiRecommendation;
        bool buyerApproved;
        bool sellerApproved;
    }

    Milestone[] public milestones;
    Dispute public dispute;

    event MilestoneApproved(uint256 indexed milestoneId, uint256 amount, uint256 timestamp);
    event PaymentReleased(uint256 indexed milestoneId, uint256 amount, address indexed to);
    event DisputeOpened(address indexed openedBy, string reason);
    event DisputeResolved(string resolution);
    event DealCompleted(uint256 timestamp);
    event DealCancelled(uint256 timestamp);

    modifier onlyBuyer() { require(msg.sender == buyer, "Only buyer"); _; }
    modifier onlySeller() { require(msg.sender == seller, "Only seller"); _; }
    modifier onlyParty() { require(msg.sender == buyer || msg.sender == seller, "Only party"); _; }
    modifier inStatus(DealStatus s) { require(status == s, "Wrong status"); _; }
    modifier notDisputed() { require(status != DealStatus.Disputed, "Disputed"); _; }

    constructor() {
        factory = msg.sender;
    }

    function initialize(
        address _buyer,
        address _seller,
        string calldata _title,
        string calldata _description,
        uint256 _totalValue,
        uint256 _deadline,
        bool _protectionEnabled,
        address _asset
    ) external {
        require(factory == address(0) || msg.sender == factory, "Only factory");
        require(_buyer != address(0) && _seller != address(0), "Invalid address");
        require(_totalValue > 0, "Value must be > 0");

        factory = msg.sender;
        buyer = _buyer;
        seller = _seller;
        title = _title;
        description = _description;
        totalValue = _totalValue;
        deadline = _deadline;
        protectionEnabled = _protectionEnabled;
        asset = _asset;
        // Previously never assigned, so every deal reported riskScore 0 forever.
        // The factory reads this immediately after initialize to price coverage,
        // which meant every premium collapsed to the pool's minimum regardless
        // of how large or how tight the deal was.
        riskScore = _computeRiskScore(_totalValue, _deadline, _asset, _buyer, _seller);
        status = DealStatus.Active;
    }

    /**
     * @dev Deterministic, transparent risk score (0-100).
     *
     * Kept on-chain and formula-based on purpose: this number prices the
     * protection premium, and a counterparty must be able to re-derive it. An
     * off-chain or AI-produced score cannot be verified by the party paying for
     * it.
     *
     * Value is normalised by the asset's own decimals before being bucketed —
     * comparing a raw uint256 against `1 ether` would score every USDC deal as
     * negligible, the same decimals bug that broke milestone amounts.
     *
     * Known limitation: buckets are in whole asset units, not fiat. Without a
     * price oracle, 100 USDC and 100 ETH land in the same size bucket.
     */
    function _computeRiskScore(
        uint256 _totalValue,
        uint256 _deadline,
        address _asset,
        address _buyer,
        address _seller
    ) internal view returns (uint256) {
        uint256 score = 20; // baseline: any escrowed deal carries some risk

        // Deadline pressure — the strongest predictor of non-delivery.
        if (_deadline <= block.timestamp) {
            score += 35; // already past due at creation
        } else {
            uint256 window = (_deadline - block.timestamp) / 1 days;
            if (window < 3) score += 30;
            else if (window < 7) score += 20;
            else if (window < 30) score += 10;
        }

        // Size — normalised to whole units of the deal's own asset.
        uint8 dec = 18;
        if (_asset != address(0)) {
            try IERC20Metadata(_asset).decimals() returns (uint8 d) {
                dec = d;
            } catch {
                dec = 18; // non-conforming token: fall back rather than revert
            }
        }
        uint256 whole = _totalValue / (10 ** uint256(dec));
        if (whole >= 100) score += 25;
        else if (whole >= 10) score += 15;
        else if (whole >= 1) score += 8;

        // A self-deal has no counterparty risk; it is a test or an internal move.
        if (_buyer == _seller && score > 20) score = 20;

        return score > 100 ? 100 : score;
    }

    function _isNative() internal view returns (bool) { return asset == address(0); }

    function addMilestone(string calldata _title, string calldata _description, uint256 _amount, uint256 _dueDate) external onlyBuyer inStatus(DealStatus.Active) {
        milestones.push(Milestone(_title, _description, _amount, MilestoneStatus.Pending, _dueDate, "", 0));
    }

    function fundEscrow() external payable onlyBuyer inStatus(DealStatus.Active) {
        if (_isNative()) {
            require(msg.value == totalValue, "Send exact total value");
        } else {
            require(msg.value == 0, "Native ETH not expected");
            require(IERC20(asset).transferFrom(msg.sender, address(this), totalValue), "Transfer failed");
        }
    }

    function _release(address _to, uint256 _amount) internal {
        if (_isNative()) {
            (bool sent,) = _to.call{value: _amount}("");
            require(sent, "Transfer failed");
        } else {
            require(IERC20(asset).transfer(_to, _amount), "Token transfer failed");
        }
    }

    function startMilestone(uint256 _milestoneId) external onlySeller inStatus(DealStatus.Active) {
        require(_milestoneId < milestones.length, "Invalid milestone");
        require(milestones[_milestoneId].msStatus == MilestoneStatus.Pending, "Not pending");
        milestones[_milestoneId].msStatus = MilestoneStatus.InProgress;
    }

    function submitMilestone(uint256 _milestoneId, string calldata _evidenceHash) external onlySeller inStatus(DealStatus.Active) {
        require(_milestoneId < milestones.length, "Invalid milestone");
        require(milestones[_milestoneId].msStatus == MilestoneStatus.InProgress, "Not in progress");
        milestones[_milestoneId].msStatus = MilestoneStatus.Completed;
        milestones[_milestoneId].evidenceHash = _evidenceHash;
        milestones[_milestoneId].completedAt = block.timestamp;
    }

    function approveMilestone(uint256 _milestoneId) external onlyBuyer inStatus(DealStatus.Active) {
        require(_milestoneId < milestones.length, "Invalid milestone");
        require(milestones[_milestoneId].msStatus == MilestoneStatus.Completed, "Not completed");
        milestones[_milestoneId].msStatus = MilestoneStatus.Approved;

        uint256 amount = milestones[_milestoneId].amount;
        _release(seller, amount);

        emit MilestoneApproved(_milestoneId, amount, block.timestamp);
        emit PaymentReleased(_milestoneId, amount, seller);

        if (_milestoneId == milestones.length - 1) {
            status = DealStatus.Completed;
            emit DealCompleted(block.timestamp);
            _notifySettled(true);
        } else {
            currentMilestone = _milestoneId + 1;
        }
    }

    /// @dev Tell the factory this deal is finished so it can close the DealInfo
    /// and record reputation. Wrapped in try/catch: money has already moved by
    /// this point, so a factory that reverts must not undo the release.
    function _notifySettled(bool _success) internal {
        if (factory == address(0) || factory == address(this)) return;
        try IDealSettlementSink(factory).onDealSettled(_success, totalValue) {} catch {}
    }

    function requestRevision(uint256 _milestoneId) external onlyBuyer inStatus(DealStatus.Active) {
        require(_milestoneId < milestones.length, "Invalid milestone");
        require(milestones[_milestoneId].msStatus == MilestoneStatus.Completed, "Not completed");
        milestones[_milestoneId].msStatus = MilestoneStatus.InProgress;
    }

    function openDispute(string calldata _reason) external onlyParty inStatus(DealStatus.Active) {
        status = DealStatus.Disputed;
        dispute = Dispute(msg.sender, _reason, "", "", false, false);
        emit DisputeOpened(msg.sender, _reason);
    }

    function updateDisputeAI(string calldata _summary, string calldata _recommendation) external {
        require(msg.sender == factory || msg.sender == buyer || msg.sender == seller, "Not authorized");
        require(status == DealStatus.Disputed, "Not disputed");
        dispute.aiSummary = _summary;
        dispute.aiRecommendation = _recommendation;
    }

    function approveDisputeResolution() external onlyParty {
        require(status == DealStatus.Disputed, "Not disputed");
        if (msg.sender == buyer) dispute.buyerApproved = true;
        if (msg.sender == seller) dispute.sellerApproved = true;
    }

    function executeDisputeResolution(string calldata _resolution) external {
        require(status == DealStatus.Disputed, "Not disputed");
        require(dispute.buyerApproved && dispute.sellerApproved, "Both must approve");
        _resolve(_resolution);
    }

    /// @dev Admin override — only the factory (guarded by the factory's feeCollector check) can force a resolution.
    function forceResolve(string calldata _resolution) external {
        require(msg.sender == factory, "Only factory");
        require(status == DealStatus.Disputed, "Not disputed");
        _resolve(_resolution);
    }

    function _resolve(string calldata _resolution) internal {
        bool releasedToSeller = false;
        if (keccak256(bytes(_resolution)) == keccak256(bytes("release_to_seller"))) {
            uint256 balance = address(this).balance;
            if (!_isNative()) balance = IERC20(asset).balanceOf(address(this));
            _release(seller, balance);
            releasedToSeller = true;
        } else if (keccak256(bytes(_resolution)) == keccak256(bytes("refund_buyer"))) {
            uint256 balance = address(this).balance;
            if (!_isNative()) balance = IERC20(asset).balanceOf(address(this));
            _release(buyer, balance);
        }

        status = DealStatus.Completed;
        emit DisputeResolved(_resolution);
        emit DealCompleted(block.timestamp);
        // A dispute that ended in a refund is not a successful delivery.
        _notifySettled(releasedToSeller);
    }

    function cancelDeal() external onlyParty inStatus(DealStatus.Active) {
        // Escrow is always refunded to the buyer (the party who funded it),
        // regardless of which party initiated the cancellation.
        if (_isNative()) {
            uint256 balance = address(this).balance;
            if (balance > 0) {
                (bool sent,) = buyer.call{value: balance}("");
                require(sent, "Refund failed");
            }
        } else {
            uint256 balance = IERC20(asset).balanceOf(address(this));
            if (balance > 0) {
                require(IERC20(asset).transfer(buyer, balance), "Refund failed");
            }
        }
        status = DealStatus.Cancelled;
        emit DealCancelled(block.timestamp);
        _notifySettled(false);
    }

    function escrowBalance() external view returns (uint256) {
        if (_isNative()) return address(this).balance;
        return IERC20(asset).balanceOf(address(this));
    }

    function getMilestones() external view returns (Milestone[] memory) { return milestones; }
    function getMilestoneCount() external view returns (uint256) { return milestones.length; }

    receive() external payable {}
}
