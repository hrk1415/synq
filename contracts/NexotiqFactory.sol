// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./NexotiqDeal.sol";
import "./NexotiqProtection.sol";
import "./NexotiqReputation.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

contract NexotiqFactory {
    using Clones for address;

    address public dealImplementation;
    address public reputationContract;
    address public protectionContract;

    address public feeCollector;
    uint256 public feeBps = 50; // 0.5%

    struct DealInfo {
        address dealAddress;
        address buyer;
        address seller;
        uint256 totalValue;
        uint256 createdAt;
        bool active;
        address asset;
    }

    DealInfo[] public deals;
    mapping(address => uint256[]) public userDealIndices;
    /// @dev Lets a deal prove it was created here. Stored as index+1 so 0 means
    /// "not one of ours" without ambiguity with deals[0].
    mapping(address => uint256) private dealIndexPlusOne;

    event DealCreated(address indexed dealAddress, address indexed buyer, address indexed seller, uint256 value, uint256 dealId);
    event CoverageCreated(address indexed dealAddress, address indexed buyer, uint256 amount, uint256 premium);
    event ProtectionEnabledChanged(address indexed dealAddress, bool enabled);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event ReputationContractUpdated(address indexed oldContract, address indexed newContract);
    event DealSettled(address indexed dealAddress, bool success, uint256 value);
    event ReputationUpdateFailed(address indexed dealAddress, address indexed user);
    event CoverageCloseFailed(address indexed dealAddress);

    constructor(address _dealImplementation, address _reputationContract, address _feeCollector) {
        dealImplementation = _dealImplementation;
        reputationContract = _reputationContract;
        feeCollector = _feeCollector;
    }

    function setProtectionContract(address _protectionContract) external {
        require(msg.sender == feeCollector, "Not authorized");
        protectionContract = _protectionContract;
    }

    /// @notice Re-point the factory at a reputation contract. Needed because the
    /// reputation contract must exist before the factory, so a mis-wired pair
    /// would otherwise require redeploying the factory and orphaning live deals.
    function setReputationContract(address _reputationContract) external {
        require(msg.sender == feeCollector, "Not authorized");
        emit ReputationContractUpdated(reputationContract, _reputationContract);
        reputationContract = _reputationContract;
    }

    function isDeal(address _dealAddress) external view returns (bool) {
        return dealIndexPlusOne[_dealAddress] != 0;
    }

    function createDeal(
        address _seller,
        string calldata _title,
        string calldata _description,
        uint256 _totalValue,
        uint256 _deadline,
        bool _protectionEnabled,
        address _asset
    ) external returns (address) {
        require(_seller != address(0), "Invalid seller");
        require(_totalValue > 0, "Value must be > 0");
        // Reject rather than silently hand back a deal whose `protectionEnabled`
        // is true but which has no coverage. The pool is ETH-denominated; see
        // NexotiqProtection for why ERC20 coverage is refused, not mispriced.
        require(!_protectionEnabled || _asset == address(0), "Protection: ETH deals only");

        address payable dealAddr = payable(dealImplementation.clone());
        NexotiqDeal(dealAddr).initialize(msg.sender, _seller, _title, _description, _totalValue, _deadline, _protectionEnabled, _asset);

        deals.push(DealInfo(dealAddr, msg.sender, _seller, _totalValue, block.timestamp, true, _asset));
        uint256 dealId = deals.length - 1;
        dealIndexPlusOne[dealAddr] = dealId + 1;
        userDealIndices[msg.sender].push(dealId);
        userDealIndices[_seller].push(dealId);

        if (_protectionEnabled && protectionContract != address(0)) {
            uint256 riskScore = NexotiqDeal(dealAddr).riskScore();
            uint256 premium = NexotiqProtection(protectionContract).createCoverage(dealAddr, msg.sender, _totalValue, riskScore, _asset);
            emit CoverageCreated(dealAddr, msg.sender, _totalValue, premium);
        }

        emit DealCreated(dealAddr, msg.sender, _seller, _totalValue, dealId);
        return dealAddr;
    }

    function resolveClaim(address _dealAddress, bool _approved) external {
        require(msg.sender == feeCollector, "Not authorized");
        require(protectionContract != address(0), "No protection");
        NexotiqProtection(protectionContract).resolveClaim(_dealAddress, _approved);
    }

    /// @notice Called by a deal created here when it reaches a terminal state.
    /// This is what makes the reputation contract mean anything — before it
    /// existed, `reputationContract` was stored and never called, so every score
    /// stayed at its default 85 forever.
    /// @dev Reputation writes are wrapped in try/catch: a mis-wired or reverting
    /// reputation contract must never be able to block a buyer's final milestone
    /// approval, which is what releases the seller's money.
    function onDealSettled(bool _success, uint256 _value) external {
        uint256 idxPlusOne = dealIndexPlusOne[msg.sender];
        require(idxPlusOne != 0, "Unknown deal");

        DealInfo storage info = deals[idxPlusOne - 1];
        if (!info.active) return; // already settled — idempotent
        info.active = false;

        emit DealSettled(msg.sender, _success, _value);

        // Coverage used to stay active forever after a deal ended, so a Cancelled
        // deal still looked insured. Skipped when a claim is already filed so the
        // claim stays resolvable.
        if (protectionContract != address(0)) {
            try NexotiqProtection(protectionContract).closeCoverage(msg.sender) {}
            catch { emit CoverageCloseFailed(msg.sender); }
        }

        if (reputationContract != address(0)) {
            try NexotiqReputation(reputationContract).recordDealCompletion(info.seller, _success, _value) {}
            catch { emit ReputationUpdateFailed(msg.sender, info.seller); }
            try NexotiqReputation(reputationContract).recordDealCompletion(info.buyer, _success, _value) {}
            catch { emit ReputationUpdateFailed(msg.sender, info.buyer); }
        }
    }

    function forceResolve(address _dealAddress, string calldata _resolution) external {
        require(msg.sender == feeCollector, "Not authorized");
        NexotiqDeal(payable(_dealAddress)).forceResolve(_resolution);
    }

    function getDealCount() external view returns (uint256) { return deals.length; }
    function getDeal(uint256 _index) external view returns (DealInfo memory) { return deals[_index]; }
    function getUserDeals(address _user) external view returns (DealInfo[] memory) {
        uint256[] memory indices = userDealIndices[_user];
        DealInfo[] memory userDeals = new DealInfo[](indices.length);
        for (uint256 i = 0; i < indices.length; i++) {
            userDeals[i] = deals[indices[i]];
        }
        return userDeals;
    }

    function updateDealImplementation(address _newImpl) external {
        require(msg.sender == feeCollector, "Not authorized");
        dealImplementation = _newImpl;
    }

    function updateFee(uint256 _newFeeBps) external {
        require(msg.sender == feeCollector, "Not authorized");
        emit FeeUpdated(feeBps, _newFeeBps);
        feeBps = _newFeeBps;
    }
}