// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ISynqResolver {
    function proposeResolution(
        uint256 milestoneId,
        uint256 freelancerAmount,
        uint256 clientAmount,
        bytes32 justificationHash
    ) external;

    function executeFinalResolution(
        uint256 milestoneId,
        uint256 freelancerAmount,
        uint256 clientAmount
    ) external;

    function responseSLA() external view returns (uint256);
}
