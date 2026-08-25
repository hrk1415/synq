// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract NexotiqDirectory {
    struct Profile {
        address wallet;
        string name;
        string category;
        string[] skills;
        uint256 rate;
        string bio;
        bool available;
        uint256 createdAt;
        uint256 lastUpdated;
        uint256 completedDeals;
    }

    address[] private wallets;
    mapping(address => Profile) public profiles;
    mapping(address => bool) private exists;

    event ProfileCreated(address indexed wallet, string name, string category);
    event ProfileUpdated(address indexed wallet, string name, string category);
    event AvailabilityChanged(address indexed wallet, bool available);

    function _validate(string calldata _name, string calldata _category, string[] calldata _skills, uint256 _rate, string calldata _bio) private pure {
        bytes memory n = bytes(_name);
        require(n.length >= 2 && n.length <= 40, "Name 2-40 chars");
        require(bytes(_category).length <= 30, "Category too long");
        require(_skills.length <= 8, "Max 8 skills");
        require(_rate > 0, "Rate must be > 0");
        require(bytes(_bio).length <= 300, "Bio too long");
    }

    function registerProfile(
        string calldata _name,
        string calldata _category,
        string[] calldata _skills,
        uint256 _rate,
        string calldata _bio
    ) external {
        require(!exists[msg.sender], "Already registered");
        _validate(_name, _category, _skills, _rate, _bio);

        Profile storage p = profiles[msg.sender];
        p.wallet = msg.sender;
        p.name = _name;
        p.category = _category;
        for (uint256 i = 0; i < _skills.length; i++) {
            p.skills.push(_skills[i]);
        }
        p.rate = _rate;
        p.bio = _bio;
        p.available = true;
        p.createdAt = block.timestamp;
        p.lastUpdated = block.timestamp;

        wallets.push(msg.sender);
        exists[msg.sender] = true;

        emit ProfileCreated(msg.sender, _name, _category);
    }

    function updateProfile(
        string calldata _name,
        string calldata _category,
        string[] calldata _skills,
        uint256 _rate,
        string calldata _bio
    ) external {
        require(exists[msg.sender], "Not registered");
        _validate(_name, _category, _skills, _rate, _bio);

        Profile storage p = profiles[msg.sender];
        p.name = _name;
        p.category = _category;
        delete p.skills;
        for (uint256 i = 0; i < _skills.length; i++) {
            p.skills.push(_skills[i]);
        }
        p.rate = _rate;
        p.bio = _bio;
        p.lastUpdated = block.timestamp;

        emit ProfileUpdated(msg.sender, _name, _category);
    }

    function setAvailable(bool _available) external {
        require(exists[msg.sender], "Not registered");
        profiles[msg.sender].available = _available;
        emit AvailabilityChanged(msg.sender, _available);
    }

    function incrementCompletedDeals(address _wallet) external {
        require(exists[_wallet], "Not registered");
        profiles[_wallet].completedDeals += 1;
    }

    function getProfile(address _wallet) external view returns (Profile memory) {
        return profiles[_wallet];
    }

    function isRegistered(address _wallet) external view returns (bool) {
        return exists[_wallet];
    }

    function getProfileCount() external view returns (uint256) {
        return wallets.length;
    }

    function getProfileAt(uint256 _index) external view returns (Profile memory) {
        return profiles[wallets[_index]];
    }

    function getAllProfiles() external view returns (Profile[] memory) {
        Profile[] memory all = new Profile[](wallets.length);
        for (uint256 i = 0; i < wallets.length; i++) {
            all[i] = profiles[wallets[i]];
        }
        return all;
    }
}