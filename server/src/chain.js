import { decodeFunctionResult, encodeFunctionData, hexToString, parseAbi } from "viem";
import { ENV } from "./config.js";
import { q } from "./db.js";
import { rpc, rpcBatch } from "./rpc.js";

export const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const BYTES32_ABI = parseAbi(["function name() view returns (bytes32)", "function symbol() view returns (bytes32)"]);
export const FACTORY_ABI = parseAbi([
  "function owner() view returns (address)",
  "function feeAmountTickSpacing(uint24) view returns (int24)",
]);
const POOL_ABI = parseAbi(["function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)"]);

/** Fee tiers every Uniswap V3 factory may have; tiers enabled later are picked up from FeeAmountEnabled logs. */
export const KNOWN_FEES = [100, 500, 3000, 10000];

const call = (to, abi, functionName, args) => ["eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args }) }, "latest"]];

function decodeText(abi, name, data) {
  try {
    return decodeFunctionResult({ abi, functionName: name, data });
  } catch {
    try {
      return hexToString(decodeFunctionResult({ abi: BYTES32_ABI, functionName: name, data }), { size: 32 }).replace(/\0+$/, "");
    } catch {
      return "";
    }
  }
}

/** Reads (and caches) ERC-20 metadata; tokens that answer nothing get placeholders rather than failing the index. */
export async function tokenMeta(address) {
  const hit = q("SELECT address, symbol, name, decimals FROM tokens WHERE address = ?").get(address);
  if (hit) return hit;
  let results;
  try {
    results = await rpcBatch([call(address, ERC20_ABI, "name"), call(address, ERC20_ABI, "symbol"), call(address, ERC20_ABI, "decimals")]);
  } catch {
    results = await Promise.all(
      ["name", "symbol", "decimals"].map((fn) => rpc(...call(address, ERC20_ABI, fn)).catch(() => "0x"))
    );
  }
  const [nameData, symbolData, decimalsData] = results;
  let decimals = 18;
  try {
    decimals = Number(decodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", data: decimalsData }));
  } catch {
    /* non-standard token */
  }
  const isNative = address === ENV.wnative;
  const symbol = (decodeText(ERC20_ABI, "symbol", symbolData) || (isNative ? `W${ENV.nativeSymbol}` : "TOKEN")).slice(0, 24);
  const name = (decodeText(ERC20_ABI, "name", nameData) || symbol).slice(0, 80);
  const row = { address, symbol, name, decimals: Number.isInteger(decimals) && decimals <= 36 ? decimals : 18 };
  q("INSERT OR REPLACE INTO tokens (address, symbol, name, decimals) VALUES (?, ?, ?, ?)").run(row.address, row.symbol, row.name, row.decimals);
  return row;
}

export async function factoryState() {
  const extra = q("SELECT value FROM meta WHERE key = 'fee_tiers'").get();
  const fees = [...new Set([...KNOWN_FEES, ...JSON.parse(extra?.value || "[]")])].sort((a, b) => a - b);
  const results = await rpcBatch([call(ENV.factory, FACTORY_ABI, "owner"), ...fees.map((fee) => call(ENV.factory, FACTORY_ABI, "feeAmountTickSpacing", [fee]))]);
  const owner = decodeFunctionResult({ abi: FACTORY_ABI, functionName: "owner", data: results[0] });
  const feeTiers = [];
  fees.forEach((fee, i) => {
    const tickSpacing = Number(decodeFunctionResult({ abi: FACTORY_ABI, functionName: "feeAmountTickSpacing", data: results[i + 1] }));
    if (tickSpacing > 0) feeTiers.push({ fee, tickSpacing });
  });
  return {
    version: 3,
    owner: owner.toLowerCase(),
    feeTiers,
    poolCount: q("SELECT COUNT(*) AS n FROM pools").get().n,
  };
}

/** Protocol fee per pool as 1/N of the swap fee for each side (0 = off), read from slot0. */
export async function poolProtocolFee(pool) {
  const [, , , , , feeProtocol] = decodeFunctionResult({ abi: POOL_ABI, functionName: "slot0", data: await rpc(...call(pool, POOL_ABI, "slot0")) });
  return { token0: Number(feeProtocol) % 16, token1: Number(feeProtocol) >> 4 };
}
