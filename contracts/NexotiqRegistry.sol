// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract NexotiqRegistry {
    address public owner;

    mapping(address => string) public addressToUsername;
    mapping(bytes32 => address) public usernameToAddress;

    event UsernameRegistered(address indexed user, string username);
    event UsernameUpdated(address indexed user, string oldUsername, string newUsername);

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }

    constructor() {
        owner = msg.sender;
    }

    function isUsernameTaken(string calldata _username) external view returns (bool) {
        bytes32 key = keccak256(abi.encodePacked(_username));
        return usernameToAddress[key] != address(0);
    }

    function register(string calldata _username) external {
        bytes memory b = bytes(_username);
        require(b.length >= 3 && b.length <= 32, "3-32 chars");
        bytes32 key = keccak256(abi.encodePacked(_username));
        require(usernameToAddress[key] == address(0), "Username taken");
        require(bytes(addressToUsername[msg.sender]).length == 0, "Already registered");

        addressToUsername[msg.sender] = _username;
        usernameToAddress[key] = msg.sender;

        emit UsernameRegistered(msg.sender, _username);
    }

    function getUsername(address _user) external view returns (string memory) {
        return addressToUsername[_user];
    }

    function getAddress(string calldata _username) external view returns (address) {
        return usernameToAddress[keccak256(abi.encodePacked(_username))];
    }

    function updateUsername(string calldata _newUsername) external {
        bytes memory b = bytes(_newUsername);
        require(b.length >= 3 && b.length <= 32, "3-32 chars");
        bytes32 newKey = keccak256(abi.encodePacked(_newUsername));
        require(usernameToAddress[newKey] == address(0), "Username taken");

        string memory old = addressToUsername[msg.sender];
        require(bytes(old).length > 0, "Not registered");
        bytes32 oldKey = keccak256(abi.encodePacked(old));

        usernameToAddress[oldKey] = address(0);
        addressToUsername[msg.sender] = _newUsername;
        usernameToAddress[newKey] = msg.sender;

        emit UsernameUpdated(msg.sender, old, _newUsername);
    }
}
