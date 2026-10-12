// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./SynqDealTypes.sol";

interface ISynqFactory {
    // Events
    event DealCreated(
        address indexed dealAddress,
        address indexed client,
        address indexed freelancer,
        address creator,
        address usdc,
        address primaryResolver,
        address emergencyResolver,
        uint256 totalEscrow,
        uint256 milestoneCount
    );

    event DealImplementationUpdated(address indexed oldImplementation, address indexed newImplementation);
    event PrimaryResolverUpdated(address indexed oldResolver, address indexed newResolver);
    event EmergencyResolverUpdated(address indexed oldResolver, address indexed newResolver);
    event ProtectionModuleUpdated(address indexed oldModule, address indexed newModule);
    event ProtectionPolicyUpdated(bytes32 indexed oldPolicy, bytes32 indexed newPolicy);

    // Deal Creation
    function createDeal(
        address client,
        address freelancer,
        MilestoneInit[] calldata milestoneInits
    ) external returns (address dealAddress);

    function createProtectedDeal(
        address client,
        address freelancer,
        MilestoneInit[] calldata milestoneInits
    ) external returns (address dealAddress);

    // Configuration Getters
    function canonicalUsdc() external view returns (address);
    function dealImplementation() external view returns (address);
    function defaultPrimaryResolver() external view returns (address);
    function defaultEmergencyResolver() external view returns (address);
    function defaultProtectionModule() external view returns (address);
    function defaultProtectionPolicyId() external view returns (bytes32);

    // Discovery & Registry
    function isSynqDeal(address deal) external view returns (bool);
    function getDealCount() external view returns (uint256);
    function allDeals(uint256 index) external view returns (address);
    function getDeals(uint256 offset, uint256 limit) external view returns (address[] memory);
    function getDealsCountByClient(address client) external view returns (uint256);
    function getDealsByClient(address client, uint256 offset, uint256 limit) external view returns (address[] memory);
    function getDealsCountByFreelancer(address freelancer) external view returns (uint256);
    function getDealsByFreelancer(address freelancer, uint256 offset, uint256 limit) external view returns (address[] memory);
}
