// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./ISynqProtectionPool.sol";

/**
 * @title SynqProtectionPool
 * @notice Minimal USDC protection capital vault for Synq Premium Protection V1.
 * @dev Holds canonical USDC capital, receives premium fees and external capitalization,
 *      and executes claim disbursements strictly when called by the authorized Manager.
 *      Has zero general owner withdrawal in V1 to eliminate solvency and reserve accounting risks.
 */
contract SynqProtectionPool is ISynqProtectionPool, Ownable2Step {
    using SafeERC20 for IERC20;

    address public immutable override usdc;
    address public override manager;

    modifier onlyManager() {
        require(msg.sender == manager, "Only manager");
        _;
    }

    constructor(
        address initialOwner,
        address _usdc,
        address _initialManager
    ) Ownable(initialOwner) {
        require(_usdc != address(0), "Zero USDC address");
        require(_usdc.code.length > 0, "USDC must be a contract");
        if (_initialManager != address(0)) {
            require(_initialManager.code.length > 0, "Manager must be a contract");
        }

        usdc = _usdc;
        manager = _initialManager;
        emit ManagerUpdated(address(0), _initialManager);
    }

    /**
     * @notice Returns the available USDC balance of the pool.
     */
    function availableBalance() external view override returns (uint256) {
        return IERC20(usdc).balanceOf(address(this));
    }

    /**
     * @notice Permissionlessly capitalizes the pool with canonical USDC.
     * @param amount The amount of USDC base units to deposit.
     */
    function fundPool(uint256 amount) external override {
        require(amount > 0, "Zero funding amount");
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
        emit PoolFunded(msg.sender, amount);
    }

    /**
     * @notice Executes an authorized claim payout to a protected client.
     * @dev Restricted strictly to the authorized PremiumProtectionManager.
     * @param recipient The client address receiving the payout.
     * @param amount The exact deterministic payout amount.
     */
    function payout(address recipient, uint256 amount) external override onlyManager {
        require(recipient != address(0), "Zero recipient address");
        require(amount > 0, "Zero payout amount");
        require(IERC20(usdc).balanceOf(address(this)) >= amount, "Insufficient pool balance");

        IERC20(usdc).safeTransfer(recipient, amount);
        emit PoolPayout(recipient, amount);
    }

    /**
     * @notice Updates the authorized manager contract.
     * @dev Restricted to governance (two-step owner).
     * @param newManager The address of the new PremiumProtectionManager.
     */
    function setManager(address newManager) external override onlyOwner {
        require(newManager != address(0), "Zero manager address");
        require(newManager.code.length > 0, "Manager must be a contract");
        require(newManager != manager, "Identical manager");
        address oldManager = manager;
        manager = newManager;
        emit ManagerUpdated(oldManager, newManager);
    }
}
