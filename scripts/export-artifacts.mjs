#!/usr/bin/env node
// Writes artifacts/nadcab-v3.json (ABI + creation bytecode) from the Foundry build, for the web app and the Console.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "contracts/out");
const read = (file, name) => JSON.parse(readFileSync(join(out, file, `${name}.json`), "utf8"));

const contracts = {};
for (const [file, name, withBytecode] of [
  ["WrappedNative.sol", "WrappedNative", true],
  ["UniswapV3Factory.sol", "UniswapV3Factory", true],
  ["NadcabPositionDescriptor.sol", "NadcabPositionDescriptor", true],
  ["NonfungiblePositionManager.sol", "NonfungiblePositionManager", true],
  ["SwapRouter.sol", "SwapRouter", true],
  ["QuoterV2.sol", "QuoterV2", true],
  ["TickLens.sol", "TickLens", true],
  ["UniswapV3Pool.sol", "UniswapV3Pool", false],
]) {
  const artifact = read(file, name);
  contracts[name] = { abi: artifact.abi, ...(withBytecode ? { bytecode: artifact.bytecode.object } : {}) };
}
const pool = read("UniswapV3Pool.sol", "UniswapV3Pool");

const payload = {
  name: "Nadcab AMM v3",
  compiler: "0.7.6",
  evmVersion: "istanbul",
  poolInitCodeHash: keccak256(pool.bytecode.object),
  defaultFeeTiers: [
    { fee: 500, tickSpacing: 10 },
    { fee: 3000, tickSpacing: 60 },
    { fee: 10000, tickSpacing: 200 },
  ],
  optionalFeeTiers: [{ fee: 100, tickSpacing: 1 }],
  contracts,
};
mkdirSync(join(root, "artifacts"), { recursive: true });
writeFileSync(join(root, "artifacts/nadcab-v3.json"), `${JSON.stringify(payload)}\n`);
console.log(`artifacts/nadcab-v3.json: ${Object.keys(contracts).join(", ")}`);
