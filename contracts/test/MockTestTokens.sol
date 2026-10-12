// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../v1/ISynqDeal.sol";

contract MockFeeToken is IERC20 {
    string public name = "Mock Fee Token";
    string public symbol = "MFT";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    // Takes 10% fee on transferFrom
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "Allow");
        require(balanceOf[from] >= amount, "Bal");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        uint256 fee = amount / 10;
        uint256 received = amount - fee;
        balanceOf[to] += received;
        return true;
    }
}

contract MockReentrantToken is IERC20 {
    string public name = "Mock Reentrant Token";
    string public symbol = "MRT";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public attackTargetDeal;
    uint256 public attackMilestoneId;
    bool public attackTriggered;

    function setAttack(address deal, uint256 milestoneId) external {
        attackTargetDeal = deal;
        attackMilestoneId = milestoneId;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "Allow");
        require(balanceOf[from] >= amount, "Bal");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        // Attempt reentrancy during payout transfer
        if (attackTargetDeal != address(0) && !attackTriggered) {
            attackTriggered = true;
            // Attempt to call settleReviewTimeout on the deal during payout
            ISynqDeal(attackTargetDeal).settleReviewTimeout(attackMilestoneId);
        }

        return true;
    }
}

contract MockResolver {
    uint256 public constant SLA = 7 days;
    function responseSLA() external pure returns (uint256) {
        return SLA;
    }
}
