// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract NexotiqReputation {
    /// @dev Kept separate from `factory` so the wiring can be corrected after
    /// deployment. Without this the contract is permanently write-locked if the
    /// constructor is handed anything other than the real factory.
    address public owner;
    address public factory;

    struct Reputation {
        uint256 totalDeals;
        uint256 successfulDeals;
        uint256 failedDeals;
        uint256 totalVolume;
        uint256 disputesOpened;
        uint256 disputesWon;
        uint256 score;
        bool exists;
    }

    mapping(address => Reputation) public reputations;
    mapping(address => address[]) public verifiers;

    event ReputationUpdated(address indexed user, uint256 newScore);
    event DealRecorded(address indexed user, bool success, uint256 volume);
    event FactoryUpdated(address indexed oldFactory, address indexed newFactory);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event VerifierAdded(address indexed user, address indexed verifier);

    modifier onlyFactory() { require(msg.sender == factory, "Only factory"); _; }
    modifier onlyOwner() { require(msg.sender == owner, "Only owner"); _; }

    constructor(address _factory) {
        owner = msg.sender;
        factory = _factory;
        emit OwnershipTransferred(address(0), msg.sender);
        emit FactoryUpdated(address(0), _factory);
    }

    /// @notice Point this contract at the real factory. Required because the
    /// deploy script must create the factory *after* the reputation contract,
    /// so the constructor cannot know the factory address yet.
    function setFactory(address _factory) external onlyOwner {
        require(_factory != address(0), "Zero factory");
        emit FactoryUpdated(factory, _factory);
        factory = _factory;
    }

    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "Zero owner");
        emit OwnershipTransferred(owner, _newOwner);
        owner = _newOwner;
    }

    function recordDealCompletion(address _user, bool _success, uint256 _volume) external onlyFactory {
        Reputation storage rep = reputations[_user];
        if (!rep.exists) {
            rep.exists = true;
            rep.score = 85;
        }

        rep.totalDeals++;
        rep.totalVolume += _volume;

        if (_success) {
            rep.successfulDeals++;
        } else {
            rep.failedDeals++;
        }

        emit DealRecorded(_user, _success, _volume);
        _recalculateScore(_user);
    }

    function recordDispute(address _user, bool _won) external onlyFactory {
        Reputation storage rep = reputations[_user];
        if (!rep.exists) { rep.exists = true; rep.score = 85; }
        rep.disputesOpened++;
        if (_won) rep.disputesWon++;
        _recalculateScore(_user);
    }

    function _recalculateScore(address _user) internal {
        Reputation storage rep = reputations[_user];
        uint256 score = 85;

        if (rep.totalDeals > 0) {
            uint256 successRate = (rep.successfulDeals * 100) / rep.totalDeals;
            score = successRate;

            if (rep.totalVolume > 0) {
                uint256 volumeBonus = rep.totalVolume / 1000 ether;
                if (volumeBonus > 10) volumeBonus = 10;
                score += volumeBonus;
            }

            if (rep.disputesOpened > 0) {
                uint256 disputePenalty = (rep.disputesOpened * 5);
                if (disputePenalty > score / 2) disputePenalty = score / 2;
                score -= disputePenalty;
            }
        }

        if (score > 100) score = 100;
        rep.score = score;
        emit ReputationUpdated(_user, score);
    }

    function getReputation(address _user) external view returns (Reputation memory) {
        if (!reputations[_user].exists) {
            return Reputation(0, 0, 0, 0, 0, 0, 85, false);
        }
        return reputations[_user];
    }

    /// @notice Attach a verifier to a specific user. The old version pushed onto
    /// `verifiers[msg.sender]`, i.e. always the factory's own slot, so the record
    /// could never be looked up for the user it was meant for.
    function addVerifier(address _user, address _verifier) external onlyFactory {
        require(_user != address(0) && _verifier != address(0), "Zero address");
        verifiers[_user].push(_verifier);
        emit VerifierAdded(_user, _verifier);
    }

    function getVerifiers(address _user) external view returns (address[] memory) {
        return verifiers[_user];
    }
}
