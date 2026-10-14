// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungibleTokenPositionDescriptor.sol";

/// @notice Plain JSON metadata for liquidity position NFTs; a light stand-in for the SVG descriptor.
contract NadcabPositionDescriptor is INonfungibleTokenPositionDescriptor {
    string public label;

    constructor(string memory _label) {
        label = _label;
    }

    function tokenURI(INonfungiblePositionManager positionManager, uint256 tokenId)
        external
        view
        override
        returns (string memory)
    {
        string memory head =
            string(abi.encodePacked('data:application/json;utf8,{"name":"', label, " position #", _uint(tokenId)));
        return string(abi.encodePacked(head, '","description":"Liquidity position. ', _details(positionManager, tokenId), '"}'));
    }

    function _details(INonfungiblePositionManager positionManager, uint256 tokenId) private view returns (string memory) {
        (, , address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, , , , , ) =
            positionManager.positions(tokenId);
        string memory pair = string(abi.encodePacked("token0 ", _hex(token0), ", token1 ", _hex(token1)));
        return string(abi.encodePacked(pair, ", fee ", _uint(fee), ", ticks ", _int(tickLower), " to ", _int(tickUpper)));
    }

    function _uint(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) digits++;
        bytes memory out = new bytes(digits);
        for (; value != 0; value /= 10) out[--digits] = bytes1(uint8(48 + (value % 10)));
        return string(out);
    }

    function _int(int24 value) private pure returns (string memory) {
        if (value >= 0) return _uint(uint256(int256(value)));
        return string(abi.encodePacked("-", _uint(uint256(-int256(value)))));
    }

    function _hex(address account) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes20 raw = bytes20(account);
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            out[2 + i * 2] = alphabet[uint8(raw[i] >> 4)];
            out[3 + i * 2] = alphabet[uint8(raw[i] & 0x0f)];
        }
        return string(out);
    }
}
