// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./ISynqFactory.sol";
import "./ISynqDeal.sol";
import "./SynqDealTypes.sol";

/**
 * @title SynqResolutionCommittee
 * @notice 2-of-3 multisig resolution committee implementing bounded dispute resolution for Synq Deal V1.
 * @dev Governed exclusively by 2-of-3 signed committee consensus (no single-owner backdoor).
 *      Verifies authentic Synq Deals via ISynqFactory.
 *      Enforces outcome-bound EIP-712 authorizations with evidence/spec/version snapshot binding.
 *      Has zero custody over Deal escrow.
 */
contract SynqResolutionCommittee is EIP712 {
    // --- Constants ---
    uint256 public constant THRESHOLD = 2;

    bytes32 public constant RESOLUTION_PROPOSAL_TYPEHASH = keccak256(
        "ResolutionProposalAuth(address committee,uint256 chainId,address deal,uint256 milestoneId,uint256 freelancerAmount,uint256 clientAmount,bytes32 justificationHash,uint64 resolutionNonce,uint64 validUntil,bytes32 evidenceRootHash,bytes32 specHash,uint8 submissionVersion)"
    );

    bytes32 public constant FINAL_RESOLUTION_TYPEHASH = keccak256(
        "FinalResolutionAuth(address committee,uint256 chainId,address deal,uint256 milestoneId,uint256 freelancerAmount,uint256 clientAmount,bytes32 justificationHash,uint64 resolutionNonce,uint64 validUntil,bytes32 evidenceRootHash,bytes32 specHash,uint8 submissionVersion)"
    );

    bytes32 public constant SIGNER_ROTATION_TYPEHASH = keccak256(
        "SignerRotationOp(address committee,uint256 chainId,uint64 committeeEpoch,address oldSigner,address newSigner,uint64 rotationNonce,uint64 validUntil)"
    );

    // --- Committee Configuration ---
    ISynqFactory public immutable factory;
    uint64 public committeeEpoch;
    address[3] public signers;
    mapping(address => bool) public isSigner;

    // --- Replay Protection ---
    mapping(bytes32 => bool) public usedProposalNonces;
    mapping(bytes32 => bool) public usedFinalNonces;
    mapping(uint64 => bool) public usedRotationNonces;

    // --- Events ---
    event ResolutionProposalSubmitted(
        address indexed deal,
        uint256 indexed milestoneId,
        uint256 freelancerAmount,
        uint256 clientAmount,
        bytes32 justificationHash,
        uint64 resolutionNonce
    );

    event FinalResolutionSubmitted(
        address indexed deal,
        uint256 indexed milestoneId,
        uint256 freelancerAmount,
        uint256 clientAmount,
        bytes32 justificationHash,
        uint64 resolutionNonce
    );

    event SignerRotated(
        address indexed oldSigner,
        address indexed newSigner,
        uint64 rotationNonce
    );

    // --- Constructor ---
    constructor(
        address _factory,
        address signerA,
        address signerB,
        address signerC
    ) EIP712("SynqResolutionCommittee", "1") {
        require(_factory != address(0), "Zero factory address");
        require(_factory.code.length > 0, "Factory must be a contract");

        require(signerA != address(0), "Zero signer A");
        require(signerB != address(0), "Zero signer B");
        require(signerC != address(0), "Zero signer C");

        require(signerA != signerB, "Duplicate signer A and B");
        require(signerA != signerC, "Duplicate signer A and C");
        require(signerB != signerC, "Duplicate signer B and C");

        factory = ISynqFactory(_factory);

        signers[0] = signerA;
        signers[1] = signerB;
        signers[2] = signerC;

        isSigner[signerA] = true;
        isSigner[signerB] = true;
        isSigner[signerC] = true;
    }

    // --- Committee Actions ---

    /**
     * @notice Submits an initial resolution proposal to a disputed milestone on a Synq Deal.
     * @dev Requires 2 distinct valid signatures from current committee signers.
     *      Binds and verifies the current disputed milestone snapshot.
     */
    function _hashProposal(ResolutionProposalAuth calldata auth) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                RESOLUTION_PROPOSAL_TYPEHASH,
                auth.committee,
                auth.chainId,
                auth.deal,
                auth.milestoneId,
                auth.freelancerAmount,
                auth.clientAmount,
                auth.justificationHash,
                auth.resolutionNonce,
                auth.validUntil,
                auth.evidenceRootHash,
                auth.specHash,
                auth.submissionVersion
            )
        );
    }

    function _hashFinal(FinalResolutionAuth calldata auth) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                FINAL_RESOLUTION_TYPEHASH,
                auth.committee,
                auth.chainId,
                auth.deal,
                auth.milestoneId,
                auth.freelancerAmount,
                auth.clientAmount,
                auth.justificationHash,
                auth.resolutionNonce,
                auth.validUntil,
                auth.evidenceRootHash,
                auth.specHash,
                auth.submissionVersion
            )
        );
    }

    function submitResolutionProposal(
        ResolutionProposalAuth calldata auth,
        bytes calldata sig1,
        bytes calldata sig2
    ) external {
        require(auth.committee == address(this), "Mismatched committee");
        require(auth.chainId == block.chainid, "Mismatched chainId");
        require(block.timestamp <= auth.validUntil, "Authorization expired");
        require(factory.isSynqDeal(auth.deal), "Deal not registered with Factory");

        bytes32 nonceKey = keccak256(abi.encode(auth.deal, auth.milestoneId, auth.resolutionNonce));
        require(!usedProposalNonces[nonceKey], "Resolution nonce used");

        // Verify milestone snapshot
        Milestone memory m = ISynqDeal(auth.deal).getMilestone(auth.milestoneId);
        require(m.evidenceRootHash == auth.evidenceRootHash, "Mismatched evidenceRootHash");
        require(m.specHash == auth.specHash, "Mismatched specHash");
        require(m.version == auth.submissionVersion, "Mismatched submissionVersion");

        // Verify 2-of-3 signatures
        bytes32 digest = _hashTypedDataV4(_hashProposal(auth));
        address s1 = ECDSA.recover(digest, sig1);
        address s2 = ECDSA.recover(digest, sig2);

        require(isSigner[s1], "Signer 1 not authorized");
        require(isSigner[s2], "Signer 2 not authorized");
        require(s1 != s2, "Duplicate signer signature");

        usedProposalNonces[nonceKey] = true;

        // Forward to Deal
        ISynqDeal(auth.deal).proposeMilestoneResolution(
            auth.milestoneId,
            auth.freelancerAmount,
            auth.clientAmount,
            auth.justificationHash
        );

        emit ResolutionProposalSubmitted(
            auth.deal,
            auth.milestoneId,
            auth.freelancerAmount,
            auth.clientAmount,
            auth.justificationHash,
            auth.resolutionNonce
        );
    }

    /**
     * @notice Submits a final resolution following reconsideration.
     * @dev Requires 2 distinct valid signatures from current committee signers.
     */
    function submitFinalResolution(
        FinalResolutionAuth calldata auth,
        bytes calldata sig1,
        bytes calldata sig2
    ) external {
        require(auth.committee == address(this), "Mismatched committee");
        require(auth.chainId == block.chainid, "Mismatched chainId");
        require(block.timestamp <= auth.validUntil, "Authorization expired");
        require(factory.isSynqDeal(auth.deal), "Deal not registered with Factory");

        bytes32 nonceKey = keccak256(abi.encode(auth.deal, auth.milestoneId, auth.resolutionNonce));
        require(!usedFinalNonces[nonceKey], "Final resolution nonce used");

        // Verify milestone snapshot
        Milestone memory m = ISynqDeal(auth.deal).getMilestone(auth.milestoneId);
        require(m.evidenceRootHash == auth.evidenceRootHash, "Mismatched evidenceRootHash");
        require(m.specHash == auth.specHash, "Mismatched specHash");
        require(m.version == auth.submissionVersion, "Mismatched submissionVersion");

        // Verify 2-of-3 signatures
        bytes32 digest = _hashTypedDataV4(_hashFinal(auth));
        address s1 = ECDSA.recover(digest, sig1);
        address s2 = ECDSA.recover(digest, sig2);

        require(isSigner[s1], "Signer 1 not authorized");
        require(isSigner[s2], "Signer 2 not authorized");
        require(s1 != s2, "Duplicate signer signature");

        usedFinalNonces[nonceKey] = true;

        // Forward to Deal
        ISynqDeal(auth.deal).executeFinalResolution(
            auth.milestoneId,
            auth.freelancerAmount,
            auth.clientAmount,
            auth.justificationHash
        );

        emit FinalResolutionSubmitted(
            auth.deal,
            auth.milestoneId,
            auth.freelancerAmount,
            auth.clientAmount,
            auth.justificationHash,
            auth.resolutionNonce
        );
    }

    /**
     * @notice Rotates a committee signer via 2-of-3 signed committee consensus.
     * @dev No single owner backdoor. Always preserves exactly 3 unique signers.
     */
    function rotateSigner(
        SignerRotationOp calldata op,
        bytes calldata sig1,
        bytes calldata sig2
    ) external {
        require(op.committee == address(this), "Mismatched committee");
        require(op.chainId == block.chainid, "Mismatched chainId");
        require(op.committeeEpoch == committeeEpoch, "Mismatched committee epoch");
        require(block.timestamp <= op.validUntil, "Rotation expired");
        require(!usedRotationNonces[op.rotationNonce], "Rotation nonce used");
        require(isSigner[op.oldSigner], "oldSigner is not current signer");
        require(op.newSigner != address(0), "Zero new signer");
        require(!isSigner[op.newSigner], "newSigner is already a signer");

        bytes32 structHash = keccak256(
            abi.encode(
                SIGNER_ROTATION_TYPEHASH,
                op.committee,
                op.chainId,
                op.committeeEpoch,
                op.oldSigner,
                op.newSigner,
                op.rotationNonce,
                op.validUntil
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address s1 = ECDSA.recover(digest, sig1);
        address s2 = ECDSA.recover(digest, sig2);

        require(isSigner[s1], "Signer 1 not authorized");
        require(isSigner[s2], "Signer 2 not authorized");
        require(s1 != s2, "Duplicate signer signature");

        usedRotationNonces[op.rotationNonce] = true;
        committeeEpoch++;

        // Replace oldSigner with newSigner
        isSigner[op.oldSigner] = false;
        isSigner[op.newSigner] = true;

        for (uint256 i = 0; i < 3; i++) {
            if (signers[i] == op.oldSigner) {
                signers[i] = op.newSigner;
                break;
            }
        }

        emit SignerRotated(op.oldSigner, op.newSigner, op.rotationNonce);
    }

    // --- Views ---

    function getSigners() external view returns (address[3] memory) {
        return signers;
    }
}
