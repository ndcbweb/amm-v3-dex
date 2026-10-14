#!/usr/bin/env node
// The periphery finds pools by CREATE2, so PoolAddress.POOL_INIT_CODE_HASH must equal keccak256 of the compiled pool.
// `--write` patches the vendored library; without it the script fails when they differ (CI check).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

const root = join(dirname(fileURLToPath(import.meta.url)), "../contracts");
const pool = JSON.parse(readFileSync(join(root, "out/UniswapV3Pool.sol/UniswapV3Pool.json"), "utf8"));
const hash = keccak256(pool.bytecode.object);
const file = join(root, "lib/v3-periphery/contracts/libraries/PoolAddress.sol");
const source = readFileSync(file, "utf8");
const current = source.match(/POOL_INIT_CODE_HASH = (0x[0-9a-f]{64})/)[1];
if (current === hash) {
  console.log(`POOL_INIT_CODE_HASH ${hash}`);
} else if (process.argv.includes("--write")) {
  writeFileSync(file, source.replace(current, hash));
  console.log(`POOL_INIT_CODE_HASH updated to ${hash}; rebuild the periphery`);
} else {
  console.error(`POOL_INIT_CODE_HASH is ${current} but the pool hashes to ${hash}. Run with --write.`);
  process.exit(1);
}
