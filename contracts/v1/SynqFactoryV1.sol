// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "./ISynqFactory.sol";
import "./ISynqDeal.sol";
import "./SynqDealTypes.sol";

/**
 * @title SynqFactoryV1
 * @notice Factory for deploying and registering standardized Synq Deal V1 ERC-1167 clones.
 * @dev Employs the Immutable Snapshot Principle: every Deal instance permanently binds the
 *      canonical USDC, deal implementation, and resolver configuration snapshot at creation time.
 *      Future configuration updates to this Factory affect future Deals only.
 *      This Factory has zero custody, zero administrative rights over Deal escrow, and zero
 *      settlement authority over created Deals.
 */
contract SynqFactoryV1 is ISynqFactory, Ownable2Step {
    using Clones for address;

    // --- Immutable Protocol Configuration ---
    address public immutable canonicalUsdc;

    // --- Mutable Defaults for Future Deals (Owner Governed) ---
    address public dealImplementation;
    address public defaultPrimaryResolver;
    address public defaultEmergencyResolver;
    address public defaultProtectionModule;
    bytes32 public defaultProtectionPolicyId;

    // --- Registry & Discovery Storage ---
    address[] public allDeals;
    mapping(address => bool) public isSynqDeal;
    mapping(address => address[]) private _dealsByClient;
    mapping(address => address[]) private _dealsByFreelancer;

    // --- Constructor ---
    constructor(
        address initialOwner,
        address _canonicalUsdc,
        address _dealImplementation,
        address _defaultPrimaryResolver,
        address _defaultEmergencyResolver
    ) Ownable(initialOwner) {
        require(initialOwner != address(0), "Zero owner address");
        require(_canonicalUsdc != address(0), "Zero USDC address");
        require(_canonicalUsdc.code.length > 0, "USDC must be a contract");
        require(_dealImplementation != address(0), "Zero implementation address");
        require(_dealImplementation.code.length > 0, "Implementation must be a contract");
        require(_defaultPrimaryResolver != address(0), "Zero primary resolver");
        require(_defaultPrimaryResolver.code.length > 0, "Primary resolver must be a contract");
        require(_defaultEmergencyResolver != address(0), "Zero emergency resolver");
        require(_defaultEmergencyResolver.code.length > 0, "Emergency resolver must be a contract");

        canonicalUsdc = _canonicalUsdc;
        dealImplementation = _dealImplementation;
        defaultPrimaryResolver = _defaultPrimaryResolver;
        defaultEmergencyResolver = _defaultEmergencyResolver;
    }

    // --- Deal Creation ---

    /**
     * @notice Creates, initializes, and registers a new Standard Synq Deal V1 minimal clone.
     */
    function createDeal(
        address client,
        address freelancer,
        MilestoneInit[] calldata milestoneInits
    ) external returns (address dealAddress) {
        require(msg.sender == client || msg.sender == freelancer, "Only participant can create deal");
        require(client != address(0), "Zero client address");
        require(freelancer != address(0), "Zero freelancer address");
        require(client != freelancer, "Client equals freelancer");
        require(milestoneInits.length > 0, "Zero milestones provided");

        uint256 totalEscrow = 0;
        for (uint256 i = 0; i < milestoneInits.length; i++) {
            require(milestoneInits[i].amount > 0, "Zero milestone amount");
            totalEscrow += milestoneInits[i].amount;
        }

        // Deploy minimal proxy clone
        dealAddress = dealImplementation.clone();

        // Snapshot parameters
        DealInitParams memory params = DealInitParams({
            client: client,
            freelancer: freelancer,
            usdc: canonicalUsdc,
            primaryResolver: defaultPrimaryResolver,
            emergencyResolver: defaultEmergencyResolver,
            isProtected: false,
            protectionModule: address(0),
            policyId: bytes32(0)
        });

        // Atomically initialize clone instance
        ISynqDeal(dealAddress).initialize(params, milestoneInits);

        // Register in discovery records
        allDeals.push(dealAddress);
        isSynqDeal[dealAddress] = true;
        _dealsByClient[client].push(dealAddress);
        _dealsByFreelancer[freelancer].push(dealAddress);

        emit DealCreated(
            dealAddress,
            client,
            freelancer,
            msg.sender,
            canonicalUsdc,
            defaultPrimaryResolver,
            defaultEmergencyResolver,
            totalEscrow,
            milestoneInits.length
        );
    }

    /**
     * @notice Creates, initializes, and registers a new Protected Synq Deal V1 minimal clone.
     */
    function createProtectedDeal(
        address client,
        address freelancer,
        MilestoneInit[] calldata milestoneInits
    ) external returns (address dealAddress) {
        require(msg.sender == client || msg.sender == freelancer, "Only participant can create deal");
        require(defaultProtectionModule != address(0), "Protection module not configured");
        require(defaultProtectionPolicyId != bytes32(0), "Protection policy not configured");
        require(client != address(0), "Zero client address");
        require(freelancer != address(0), "Zero freelancer address");
        require(client != freelancer, "Client equals freelancer");
        require(milestoneInits.length > 0, "Zero milestones provided");

        uint256 totalEscrow = 0;
        for (uint256 i = 0; i < milestoneInits.length; i++) {
            require(milestoneInits[i].amount > 0, "Zero milestone amount");
            require(milestoneInits[i].specHash != bytes32(0), "Zero specHash");
            totalEscrow += milestoneInits[i].amount;
        }

        // Deploy minimal proxy clone
        dealAddress = dealImplementation.clone();

        // Snapshot parameters
        DealInitParams memory params = DealInitParams({
            client: client,
            freelancer: freelancer,
            usdc: canonicalUsdc,
            primaryResolver: defaultPrimaryResolver,
            emergencyResolver: defaultEmergencyResolver,
            isProtected: true,
            protectionModule: defaultProtectionModule,
            policyId: defaultProtectionPolicyId
        });

        // Atomically initialize clone instance
        ISynqDeal(dealAddress).initialize(params, milestoneInits);

        // Register in discovery records
        allDeals.push(dealAddress);
        isSynqDeal[dealAddress] = true;
        _dealsByClient[client].push(dealAddress);
        _dealsByFreelancer[freelancer].push(dealAddress);

        emit DealCreated(
            dealAddress,
            client,
            freelancer,
            msg.sender,
            canonicalUsdc,
            defaultPrimaryResolver,
            defaultEmergencyResolver,
            totalEscrow,
            milestoneInits.length
        );
    }

    // --- Configuration Management for FUTURE Deals (onlyOwner) ---

    /**
     * @notice Updates the Deal implementation contract cloned for future Deals.
     * @dev Does not alter existing Deal clones, which remain bound to their cloned bytecode.
     */
    function setDealImplementation(address newImplementation) external onlyOwner {
        require(newImplementation != address(0), "Zero implementation address");
        require(newImplementation.code.length > 0, "Implementation must be a contract");
        require(newImplementation != dealImplementation, "Identical implementation");

        address oldImpl = dealImplementation;
        dealImplementation = newImplementation;
        emit DealImplementationUpdated(oldImpl, newImplementation);
    }

    /**
     * @notice Updates the default primary resolver configured into future Deals.
     */
    function setDefaultPrimaryResolver(address newResolver) external onlyOwner {
        require(newResolver != address(0), "Zero primary resolver");
        require(newResolver.code.length > 0, "Primary resolver must be a contract");
        require(newResolver != defaultPrimaryResolver, "Identical primary resolver");

        address oldResolver = defaultPrimaryResolver;
        defaultPrimaryResolver = newResolver;
        emit PrimaryResolverUpdated(oldResolver, newResolver);
    }

    /**
     * @notice Updates the default emergency resolver configured into future Deals.
     */
    function setDefaultEmergencyResolver(address newResolver) external onlyOwner {
        require(newResolver != address(0), "Zero emergency resolver");
        require(newResolver.code.length > 0, "Emergency resolver must be a contract");
        require(newResolver != defaultEmergencyResolver, "Identical emergency resolver");

        address oldResolver = defaultEmergencyResolver;
        defaultEmergencyResolver = newResolver;
        emit EmergencyResolverUpdated(oldResolver, newResolver);
    }

    /**
     * @notice Updates the default protection module configured into future Protected Deals.
     */
    function setDefaultProtectionModule(address newModule) external onlyOwner {
        require(newModule != address(0), "Zero protection module");
        require(newModule.code.length > 0, "Protection module must be a contract");
        require(newModule != defaultProtectionModule, "Identical protection module");

        address oldModule = defaultProtectionModule;
        defaultProtectionModule = newModule;
        emit ProtectionModuleUpdated(oldModule, newModule);
    }

    /**
     * @notice Updates the default protection policy ID configured into future Protected Deals.
     */
    function setDefaultProtectionPolicyId(bytes32 newPolicyId) external onlyOwner {
        require(newPolicyId != bytes32(0), "Zero policy ID");
        require(newPolicyId != defaultProtectionPolicyId, "Identical policy ID");

        bytes32 oldPolicy = defaultProtectionPolicyId;
        defaultProtectionPolicyId = newPolicyId;
        emit ProtectionPolicyUpdated(oldPolicy, newPolicyId);
    }

    // --- Registry & Discovery Queries ---

    function getDealCount() external view returns (uint256) {
        return allDeals.length;
    }

    function getDealsCountByClient(address client) external view returns (uint256) {
        return _dealsByClient[client].length;
    }

    function getDealsCountByFreelancer(address freelancer) external view returns (uint256) {
        return _dealsByFreelancer[freelancer].length;
    }

    function getDeals(uint256 offset, uint256 limit) external view returns (address[] memory) {
        return _paginate(allDeals, offset, limit);
    }

    function getDealsByClient(address client, uint256 offset, uint256 limit) external view returns (address[] memory) {
        return _paginate(_dealsByClient[client], offset, limit);
    }

    function getDealsByFreelancer(address freelancer, uint256 offset, uint256 limit) external view returns (address[] memory) {
        return _paginate(_dealsByFreelancer[freelancer], offset, limit);
    }

    // --- Internal Helpers ---

    function _paginate(
        address[] storage list,
        uint256 offset,
        uint256 limit
    ) internal view returns (address[] memory) {
        uint256 total = list.length;
        if (offset >= total || limit == 0) {
            return new address[](0);
        }

        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }

        uint256 size = end - offset;
        address[] memory page = new address[](size);
        for (uint256 i = 0; i < size; i++) {
            page[i] = list[offset + i];
        }
        return page;
    }
}
