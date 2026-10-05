// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title ISynqProtectionPool
 * @notice Interface for the Synq Protection Pool vault holding USDC protection capital.
 */
interface ISynqProtectionPool {
    event PoolFunded(address indexed funder, uint256 amount);
    event PoolPayout(address indexed recipient, uint256 amount);
    event ManagerUpdated(address indexed oldManager, address indexed newManager);

    function usdc() external view returns (address);
    function manager() external view returns (address);
    function availableBalance() external view returns (uint256);

    function fundPool(uint256 amount) external;
    function payout(address recipient, uint256 amount) external;
    function setManager(address newManager) external;
}
