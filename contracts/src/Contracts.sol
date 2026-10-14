// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

// Pulls the unmodified Uniswap V3 contracts into the build so their artifacts can be exported.
import {UniswapV3Factory} from "@uniswap/v3-core/contracts/UniswapV3Factory.sol";
import {NonfungiblePositionManager} from "@uniswap/v3-periphery/contracts/NonfungiblePositionManager.sol";
import {SwapRouter} from "@uniswap/v3-periphery/contracts/SwapRouter.sol";
import {QuoterV2} from "@uniswap/v3-periphery/contracts/lens/QuoterV2.sol";
import {TickLens} from "@uniswap/v3-periphery/contracts/lens/TickLens.sol";
