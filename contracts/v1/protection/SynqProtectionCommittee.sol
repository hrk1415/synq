// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./ISynqProtectionManager.sol";

/**
 * @title SynqProtectionCommittee
 * @notice 2-of-3 multisig resolution committee for Synq Premium Protection claims.
 * @dev Governed exclusively by 2-of-3 signed committee consensus (no single-owner backdoor).
 *      Authenticates strictly binary APPROVE / REJECT claim determinations.
 *      Has ZERO control over payout amounts, zero token custody, and zero access to the ProtectionPool.
 */
contract SynqProtectionCommittee is EIP712 {
    uint256 public constant THRESHOLD = 2;

    bytes32 public constant CLAIM_DECISION_TYPEHASH = keccak256(
        "ProtectionClaimDecisionAuth(address committee,uint256 chainId,address manager,address deal,uint256 milestoneId,uint8 decision,bytes32 decisionReportHash,uint64 decisionNonce,uint64 validUntil)"
    );

    bytes32 public constant SIGNER_ROTATION_TYPEHASH = keccak256(
        "SignerRotationOp(address committee,uint256 chainId,uint64 committeeEpoch,address oldSigner,address newSigner,uint64 rotationNonce,uint64 validUntil)"
    );

    uint64 public committeeEpoch;
    address[3] public signers;
    mapping(address => bool) public isSigner;

    mapping(bytes32 => bool) public usedDecisionNonces;
    mapping(uint64 => bool) public usedRotationNonces;

    event ClaimDecisionSubmitted(
        address indexed manager,
        address indexed deal,
        uint256 indexed milestoneId,
        uint8 decision,
        bytes32 decisionReportHash,
        uint64 decisionNonce
    );

    event SignerRotated(
        address indexed oldSigner,
        address indexed newSigner,
        uint64 rotationNonce
    );

    constructor(
        address signerA,
        address signerB,
        address signerC
    ) EIP712("SynqProtectionCommittee", "1") {
        require(signerA != address(0), "Zero signer A");
        require(signerB != address(0), "Zero signer B");
        require(signerC != address(0), "Zero signer C");

        require(signerA != signerB, "Duplicate signer A and B");
        require(signerA != signerC, "Duplicate signer A and C");
        require(signerB != signerC, "Duplicate signer B and C");

        signers[0] = signerA;
        signers[1] = signerB;
        signers[2] = signerC;

        isSigner[signerA] = true;
        isSigner[signerB] = true;
        isSigner[signerC] = true;
    }

    function _hashClaimDecision(ProtectionClaimDecisionAuth calldata auth) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CLAIM_DECISION_TYPEHASH,
                auth.committee,
                auth.chainId,
                auth.manager,
                auth.deal,
                auth.milestoneId,
                auth.decision,
                auth.decisionReportHash,
                auth.decisionNonce,
                auth.validUntil
            )
        );
    }

    /**
     * @notice Submits a 2-of-3 signed committee decision (Approve or Reject) for a filed claim.
     * @param auth The structured claim decision authorization.
     * @param sig1 Signature from the first committee signer.
     * @param sig2 Signature from the second committee signer.
     */
    function submitClaimDecision(
        ProtectionClaimDecisionAuth calldata auth,
        bytes calldata sig1,
        bytes calldata sig2
    ) external {
        require(auth.committee == address(this), "Mismatched committee");
        require(auth.chainId == block.chainid, "Mismatched chainId");
        require(block.timestamp <= auth.validUntil, "Authorization expired");
        require(
            auth.decision == uint8(CommitteeDecision.Approve) || auth.decision == uint8(CommitteeDecision.Reject),
            "Invalid decision: must be Approve or Reject"
        );
        require(auth.manager != address(0), "Zero manager");
        require(auth.deal != address(0), "Zero deal");

        bytes32 nonceKey = keccak256(abi.encode(auth.manager, auth.deal, auth.milestoneId, auth.decisionNonce));
        require(!usedDecisionNonces[nonceKey], "Decision nonce already used");

        bytes32 digest = _hashTypedDataV4(_hashClaimDecision(auth));
        address s1 = ECDSA.recover(digest, sig1);
        address s2 = ECDSA.recover(digest, sig2);

        require(isSigner[s1], "Signer 1 not authorized");
        require(isSigner[s2], "Signer 2 not authorized");
        require(s1 != s2, "Duplicate signer signature");

        usedDecisionNonces[nonceKey] = true;

        ISynqProtectionManager(auth.manager).recordCommitteeDecision(
            auth.deal,
            auth.milestoneId,
            CommitteeDecision(auth.decision),
            auth.decisionReportHash
        );

        emit ClaimDecisionSubmitted(
            auth.manager,
            auth.deal,
            auth.milestoneId,
            auth.decision,
            auth.decisionReportHash,
            auth.decisionNonce
        );
    }

    /**
     * @notice Rotates a committee signer upon 2-of-3 committee consensus.
     */
    function rotateSigner(
        address oldSigner,
        address newSigner,
        uint64 rotationNonce,
        uint64 validUntil,
        bytes calldata sig1,
        bytes calldata sig2
    ) external {
        require(block.timestamp <= validUntil, "Rotation expired");
        require(!usedRotationNonces[rotationNonce], "Rotation nonce used");
        require(isSigner[oldSigner], "Old signer not in committee");
        require(newSigner != address(0), "Zero new signer");
        require(!isSigner[newSigner], "New signer already in committee");

        bytes32 structHash = keccak256(
            abi.encode(
                SIGNER_ROTATION_TYPEHASH,
                address(this),
                block.chainid,
                committeeEpoch,
                oldSigner,
                newSigner,
                rotationNonce,
                validUntil
            )
        );

        bytes32 digest = _hashTypedDataV4(structHash);
        address s1 = ECDSA.recover(digest, sig1);
        address s2 = ECDSA.recover(digest, sig2);

        require(isSigner[s1], "Signer 1 not authorized");
        require(isSigner[s2], "Signer 2 not authorized");
        require(s1 != s2, "Duplicate signer signature");

        usedRotationNonces[rotationNonce] = true;
        committeeEpoch++;

        isSigner[oldSigner] = false;
        isSigner[newSigner] = true;

        for (uint256 i = 0; i < 3; i++) {
            if (signers[i] == oldSigner) {
                signers[i] = newSigner;
                break;
            }
        }

        emit SignerRotated(oldSigner, newSigner, rotationNonce);
    }
}
