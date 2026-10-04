// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./ISynqFactory.sol";
import "./ISynqDeal.sol";
import "./SynqDealTypes.sol";

/**
 * @title SynqProtectionModule
 * @notice Active Protection assessment module for Synq Deal V1.
 * @dev Verifies EIP-712 signed attestations from approved off-chain verifiers, validates policy
 *      and snapshot commitments, and forwards bounded completionBps (0-10000) to authentic Synq Deals.
 *      Has zero custody, zero token balances, and zero direct settlement authority over Deal escrow.
 */
contract SynqProtectionModule is Ownable2Step, EIP712 {
    bytes32 public constant ASSESSMENT_ATTESTATION_TYPEHASH = keccak256(
        "AssessmentAttestation(address protectionModule,uint256 chainId,address deal,uint256 milestoneId,bytes32 evidenceRootHash,bytes32 specHash,bytes32 policyId,uint8 submissionVersion,uint16 completionBps,bytes32 reportHash,uint64 assessmentNonce,uint64 validUntil,uint8 trigger)"
    );

    ISynqFactory public immutable factory;
    mapping(address => bool) public isVerifier;
    mapping(bytes32 => bool) public usedAssessmentNonces;

    // --- Events ---
    event VerifierAdded(address indexed verifier);
    event VerifierRemoved(address indexed verifier);
    event AssessmentSubmitted(
        address indexed deal,
        uint256 indexed milestoneId,
        uint16 completionBps,
        bytes32 reportHash,
        uint64 assessmentNonce
    );

    // --- Constructor ---
    constructor(
        address initialOwner,
        address _factory,
        address initialVerifier
    ) Ownable(initialOwner) EIP712("SynqProtectionModule", "1") {
        require(_factory != address(0), "Zero factory address");
        require(_factory.code.length > 0, "Factory must be a contract");
        require(initialVerifier != address(0), "Zero initial verifier");

        factory = ISynqFactory(_factory);
        isVerifier[initialVerifier] = true;
        emit VerifierAdded(initialVerifier);
    }

    // --- Verifier Administration (onlyOwner) ---

    function addVerifier(address verifier) external onlyOwner {
        require(verifier != address(0), "Zero verifier address");
        require(!isVerifier[verifier], "Already verifier");
        isVerifier[verifier] = true;
        emit VerifierAdded(verifier);
    }

    function removeVerifier(address verifier) external onlyOwner {
        require(isVerifier[verifier], "Not verifier");
        isVerifier[verifier] = false;
        emit VerifierRemoved(verifier);
    }

    // --- Assessment Submission ---

    function _hashAttestation(AssessmentAttestation calldata att) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ASSESSMENT_ATTESTATION_TYPEHASH,
                att.protectionModule,
                att.chainId,
                att.deal,
                att.milestoneId,
                att.evidenceRootHash,
                att.specHash,
                att.policyId,
                att.submissionVersion,
                att.completionBps,
                att.reportHash,
                att.assessmentNonce,
                att.validUntil,
                uint8(att.trigger)
            )
        );
    }

    /**
     * @notice Submits a verified AI assessment attestation to an authentic Protected Synq Deal.
     * @param att The structured assessment attestation parameters.
     * @param signature The EIP-712 ECDSA signature from an authorized verifier.
     */
    function submitAssessment(
        AssessmentAttestation calldata att,
        bytes calldata signature
    ) external {
        require(att.protectionModule == address(this), "Mismatched protection module");
        require(att.chainId == block.chainid, "Mismatched chainId");
        require(block.timestamp <= att.validUntil, "Attestation expired");
        require(att.completionBps <= 10000, "completionBps exceeds 10000");
        require(factory.isSynqDeal(att.deal), "Deal not registered with Factory");

        bytes32 nonceKey = keccak256(abi.encode(att.deal, att.milestoneId, att.assessmentNonce));
        require(!usedAssessmentNonces[nonceKey], "Assessment nonce used");

        ISynqDeal dealContract = ISynqDeal(att.deal);
        require(dealContract.isProtected(), "Deal not protected");
        require(dealContract.policyId() == att.policyId, "Mismatched policyId");

        // Verify milestone snapshot
        Milestone memory m = dealContract.getMilestone(att.milestoneId);
        require(m.evidenceRootHash == att.evidenceRootHash, "Mismatched evidenceRootHash");
        require(m.specHash == att.specHash, "Mismatched specHash");
        require(m.version == att.submissionVersion, "Mismatched submissionVersion");

        // Verify assessment request trigger
        AssessmentRequest memory req = dealContract.getAssessmentRequest(att.milestoneId);
        require(req.trigger == att.trigger, "Mismatched trigger");

        // Verify signature
        bytes32 digest = _hashTypedDataV4(_hashAttestation(att));
        address signer = ECDSA.recover(digest, signature);
        require(isVerifier[signer], "Signer not authorized verifier");

        usedAssessmentNonces[nonceKey] = true;

        // Register with Deal
        dealContract.registerAssessmentProposal(
            att.milestoneId,
            att.completionBps,
            att.reportHash
        );

        emit AssessmentSubmitted(
            att.deal,
            att.milestoneId,
            att.completionBps,
            att.reportHash,
            att.assessmentNonce
        );
    }
}
