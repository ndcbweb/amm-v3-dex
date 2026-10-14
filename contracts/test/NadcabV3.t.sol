// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

contract TestToken {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _symbol, uint8 _decimals, uint256 supply) {
        name = _symbol;
        symbol = _symbol;
        decimals = _decimals;
        mint(msg.sender, supply);
    }

    function mint(address to, uint256 amount) public {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return transferFrom(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        if (from != msg.sender && allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

interface IFactory {
    function owner() external view returns (address);
    function getPool(address, address, uint24) external view returns (address);
    function feeAmountTickSpacing(uint24) external view returns (int24);
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external;
}

interface IPool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
    function setFeeProtocol(uint8, uint8) external;
    function protocolFees() external view returns (uint128, uint128);
    function collectProtocol(address, uint128, uint128) external returns (uint128, uint128);
}

interface IPositions {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function createAndInitializePoolIfNecessary(address, address, uint24, uint160) external payable returns (address);
    function mint(MintParams calldata) external payable returns (uint256, uint128, uint256, uint256);
    function decreaseLiquidity(DecreaseLiquidityParams calldata) external payable returns (uint256, uint256);
    function collect(CollectParams calldata) external payable returns (uint256, uint256);
    function positions(uint256)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128);
    function tokenURI(uint256) external view returns (string memory);
    function multicall(bytes[] calldata) external payable returns (bytes[] memory);
    function refundETH() external payable;
    function ownerOf(uint256) external view returns (address);
}

interface IRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
    function exactInput(ExactInputParams calldata) external payable returns (uint256);
    function unwrapWETH9(uint256, address) external payable;
    function multicall(bytes[] calldata) external payable returns (bytes[] memory);
}

interface IQuoter {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory)
        external
        returns (uint256, uint160, uint32, uint256);
    function quoteExactInput(bytes memory, uint256) external returns (uint256, uint160[] memory, uint32[] memory, uint256);
}

interface IWrapped {
    function balanceOf(address) external view returns (uint256);
}

contract NadcabV3Test is Test {
    // 1:1 price.
    uint160 constant PRICE_ONE = 79228162514264337593543950336;

    IFactory factory;
    IPositions positions;
    IRouter router;
    IQuoter quoter;
    address wnative;
    TestToken usdt;
    TestToken nova;
    address me = address(this);
    uint256 deadline;

    function setUp() public {
        deadline = block.timestamp + 1 hours;
        wnative = deployCode("WrappedNative.sol:WrappedNative", abi.encode("Wrapped Nova", "WNOVA"));
        factory = IFactory(deployCode("UniswapV3Factory.sol:UniswapV3Factory"));
        address descriptor = deployCode("NadcabPositionDescriptor.sol:NadcabPositionDescriptor", abi.encode("Nadcab V3"));
        positions = IPositions(
            deployCode("NonfungiblePositionManager.sol:NonfungiblePositionManager", abi.encode(address(factory), wnative, descriptor))
        );
        router = IRouter(deployCode("SwapRouter.sol:SwapRouter", abi.encode(address(factory), wnative)));
        quoter = IQuoter(deployCode("QuoterV2.sol:QuoterV2", abi.encode(address(factory), wnative)));

        usdt = new TestToken("USDT", 18, 1e30);
        nova = new TestToken("NOVA", 18, 1e30);
        usdt.approve(address(positions), type(uint256).max);
        nova.approve(address(positions), type(uint256).max);
        usdt.approve(address(router), type(uint256).max);
        nova.approve(address(router), type(uint256).max);
    }

    function sorted(address a, address b) internal pure returns (address, address) {
        return a < b ? (a, b) : (b, a);
    }

    function addPool(address a, address b, uint24 fee, int24 spacing, uint256 amount, uint256 value) internal returns (uint256 id) {
        (address t0, address t1) = sorted(a, b);
        positions.createAndInitializePoolIfNecessary(t0, t1, fee, PRICE_ONE);
        int24 edge = (887272 / spacing) * spacing;
        (id, , , ) = positions.mint{value: value}(
            IPositions.MintParams(t0, t1, fee, -edge, edge, amount, amount, 0, 0, me, deadline)
        );
    }

    function testDeployAndDefaultFeeTiers() public view {
        assertEq(factory.owner(), me);
        assertEq(factory.feeAmountTickSpacing(500), 10);
        assertEq(factory.feeAmountTickSpacing(3000), 60);
        assertEq(factory.feeAmountTickSpacing(10000), 200);
        assertEq(factory.feeAmountTickSpacing(100), 0);
    }

    function testEnableLowFeeTier() public {
        factory.enableFeeAmount(100, 1);
        uint256 id = addPool(address(usdt), address(nova), 100, 1, 1000e18, 0);
        assertGt(id, 0);
    }

    function testSwapQuoteMatchesAndFeesAccrue() public {
        uint256 id = addPool(address(usdt), address(nova), 3000, 60, 100_000e18, 0);
        address pool = factory.getPool(address(usdt), address(nova), 3000);
        assertTrue(pool != address(0));
        assertGt(IPool(pool).liquidity(), 0);

        (uint256 quoted, , , ) =
            quoter.quoteExactInputSingle(IQuoter.QuoteExactInputSingleParams(address(usdt), address(nova), 1000e18, 3000, 0));
        uint256 before = nova.balanceOf(me);
        uint256 out = router.exactInputSingle(
            IRouter.ExactInputSingleParams(address(usdt), address(nova), 3000, me, deadline, 1000e18, quoted, 0)
        );
        assertEq(out, quoted);
        assertEq(nova.balanceOf(me) - before, out);

        (uint256 got0, uint256 got1) =
            positions.collect(IPositions.CollectParams(id, me, type(uint128).max, type(uint128).max));
        assertApproxEqAbs(got0 + got1, 3e18, 1e16);
    }

    function testMultiHopThroughNativeAndUnwrap() public {
        vm.deal(me, 1000 ether);
        (address t0, address t1) = sorted(address(usdt), wnative);
        positions.createAndInitializePoolIfNecessary(t0, t1, 500, PRICE_ONE);
        int24 edge = (887272 / int24(10)) * 10;
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSelector(
            IPositions.mint.selector, IPositions.MintParams(t0, t1, 500, -edge, edge, 100e18, 100e18, 0, 0, me, deadline)
        );
        calls[1] = abi.encodeWithSelector(IPositions.refundETH.selector);
        positions.multicall{value: 100e18}(calls);
        addPool(address(nova), wnative, 3000, 60, 100e18, 100e18);
        assertEq(address(positions).balance, 0);

        bytes memory path = abi.encodePacked(address(usdt), uint24(500), wnative, uint24(3000), address(nova));
        (uint256 quoted, , , ) = quoter.quoteExactInput(path, 1e18);
        uint256 out = router.exactInput(IRouter.ExactInputParams(path, me, deadline, 1e18, quoted));
        assertEq(out, quoted);

        bytes memory toNative = abi.encodePacked(address(usdt), uint24(500), wnative);
        bytes[] memory swap = new bytes[](2);
        swap[0] = abi.encodeWithSelector(
            IRouter.exactInput.selector, IRouter.ExactInputParams(toNative, address(router), deadline, 1e18, 0)
        );
        swap[1] = abi.encodeWithSelector(IRouter.unwrapWETH9.selector, 0, me);
        uint256 nativeBefore = me.balance;
        router.multicall(swap);
        assertGt(me.balance, nativeBefore);
    }

    function testProtocolFeeAndDecrease() public {
        uint256 id = addPool(address(usdt), address(nova), 3000, 60, 100_000e18, 0);
        IPool pool = IPool(factory.getPool(address(usdt), address(nova), 3000));
        pool.setFeeProtocol(4, 4);
        router.exactInputSingle(IRouter.ExactInputSingleParams(address(usdt), address(nova), 3000, me, deadline, 1000e18, 0, 0));
        (uint128 p0, uint128 p1) = pool.protocolFees();
        assertGt(uint256(p0) + uint256(p1), 0);
        address treasury = address(0xBEEF);
        pool.collectProtocol(treasury, type(uint128).max, type(uint128).max);
        assertGt(usdt.balanceOf(treasury) + nova.balanceOf(treasury), 0);

        (, , , , , , , uint128 liquidity, , , , ) = positions.positions(id);
        positions.decreaseLiquidity(IPositions.DecreaseLiquidityParams(id, liquidity / 2, 0, 0, deadline));
        (uint256 got0, uint256 got1) =
            positions.collect(IPositions.CollectParams(id, me, type(uint128).max, type(uint128).max));
        assertGt(got0 + got1, 49_000e18);
    }

    function testOnlyOwnerSetsProtocolFee() public {
        addPool(address(usdt), address(nova), 3000, 60, 1000e18, 0);
        IPool pool = IPool(factory.getPool(address(usdt), address(nova), 3000));
        vm.prank(address(0xBAD));
        vm.expectRevert();
        pool.setFeeProtocol(4, 4);
    }

    function testTokenUri() public {
        uint256 id = addPool(address(usdt), address(nova), 3000, 60, 1000e18, 0);
        string memory uri = positions.tokenURI(id);
        assertEq(bytes(uri)[0], bytes1("d"));
        assertEq(positions.ownerOf(id), me);
    }

    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
