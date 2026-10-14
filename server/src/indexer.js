import { decodeEventLog, parseAbi, toEventSelector } from "viem";
import { tokenMeta } from "./chain.js";
import { ENV } from "./config.js";
import { getMeta, q, setMeta, transaction } from "./db.js";
import { rpc, rpcBatch } from "./rpc.js";

const FACTORY_EVENTS = parseAbi([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
  "event FeeAmountEnabled(uint24 indexed fee, int24 indexed tickSpacing)",
]);
const POOL_EVENTS = parseAbi([
  "event Initialize(uint160 sqrtPriceX96, int24 tick)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)",
  "event Flash(address indexed sender, address indexed recipient, uint256 amount0, uint256 amount1, uint256 paid0, uint256 paid1)",
  "event CollectProtocol(address indexed sender, address indexed recipient, uint128 amount0, uint128 amount1)",
]);
const FACTORY_TOPICS = FACTORY_EVENTS.map((item) => toEventSelector(item));
const POOL_TOPICS = POOL_EVENTS.map((item) => toEventSelector(item));
const ADDRESSES_PER_QUERY = 500;
const Q96 = 2 ** 96;

export const state = { indexed: -1, chainHead: -1, lastError: "", running: false };

const toFloat = (raw, decimals) => Number(raw) / 10 ** decimals;
const hex = (n) => `0x${n.toString(16)}`;
const abs = (n) => (n < 0n ? -n : n);

/** token1 per token0, decimal-adjusted. */
export function priceFromSqrt(sqrtPriceX96, d0, d1) {
  const ratio = Number(sqrtPriceX96) / Q96;
  return ratio * ratio * 10 ** (d0 - d1);
}

let chunk = ENV.logChunk;

async function getLogs(filter) {
  return rpc("eth_getLogs", [filter], { timeoutMs: 45_000 });
}

/** eth_getLogs with the range halved whenever the node refuses it (block range or result-size limits). */
async function logsInRange(from, to, build) {
  try {
    return await getLogs(build(from, to));
  } catch (error) {
    if (to <= from) throw error;
    chunk = Math.max(10, Math.floor((to - from + 1) / 2));
    const mid = from + chunk - 1;
    const left = await logsInRange(from, mid, build);
    const right = await logsInRange(mid + 1, to, build);
    return [...left, ...right];
  }
}

const poolCache = new Map();
function loadPools() {
  if (poolCache.size) return poolCache;
  for (const row of q(
    "SELECT p.address, p.token0, p.token1, t0.decimals AS d0, t1.decimals AS d1 FROM pools p JOIN tokens t0 ON t0.address = p.token0 JOIN tokens t1 ON t1.address = p.token1"
  ).all()) {
    poolCache.set(row.address, row);
  }
  return poolCache;
}

async function blockTimes(numbers) {
  const unique = [...new Set(numbers)];
  const blocks = await rpcBatch(unique.map((n) => ["eth_getBlockByNumber", [hex(n), false]]));
  return new Map(unique.map((n, i) => [n, Number(BigInt(blocks[i].timestamp))]));
}

/** Who signed each transaction; Swap recipients and Mint owners are usually the router or position manager. */
async function txSenders(hashes) {
  const unique = [...new Set(hashes)];
  const txs = await rpcBatch(unique.map((hash) => ["eth_getTransactionByHash", [hash]]));
  return new Map(unique.map((hash, i) => [hash, txs[i]?.from?.toLowerCase() || null]));
}

async function indexRange(from, to) {
  const factoryLogs = await logsInRange(from, to, (a, b) => ({
    address: ENV.factory,
    topics: [FACTORY_TOPICS],
    fromBlock: hex(a),
    toBlock: hex(b),
  }));
  const newPools = [];
  const newFees = [];
  for (const log of factoryLogs) {
    const { eventName, args } = decodeEventLog({ abi: FACTORY_EVENTS, data: log.data, topics: log.topics });
    if (eventName === "FeeAmountEnabled") {
      newFees.push(Number(args.fee));
      continue;
    }
    const token0 = args.token0.toLowerCase();
    const token1 = args.token1.toLowerCase();
    const [m0, m1] = [await tokenMeta(token0), await tokenMeta(token1)];
    newPools.push({
      address: args.pool.toLowerCase(),
      token0,
      token1,
      fee: Number(args.fee),
      tickSpacing: Number(args.tickSpacing),
      d0: m0.decimals,
      d1: m1.decimals,
      block: Number(BigInt(log.blockNumber)),
    });
  }

  const pools = loadPools();
  const addresses = [...pools.keys(), ...newPools.map((p) => p.address)];
  const logs = [];
  for (let i = 0; i < addresses.length; i += ADDRESSES_PER_QUERY) {
    const group = addresses.slice(i, i + ADDRESSES_PER_QUERY);
    logs.push(
      ...(await logsInRange(from, to, (a, b) => ({ address: group, topics: [POOL_TOPICS], fromBlock: hex(a), toBlock: hex(b) })))
    );
  }
  logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  const times = await blockTimes([...logs.map((log) => Number(BigInt(log.blockNumber))), ...newPools.map((p) => p.block)]);
  const senders = await txSenders(logs.map((log) => log.transactionHash));

  transaction(() => {
    if (newFees.length) {
      const known = JSON.parse(getMeta("fee_tiers", "[]"));
      setMeta("fee_tiers", JSON.stringify([...new Set([...known, ...newFees])]));
    }
    let idx = q("SELECT COUNT(*) AS n FROM pools").get().n;
    for (const pool of newPools) {
      idx += 1;
      q(
        `INSERT OR IGNORE INTO pools (address, idx, token0, token1, fee, tick_spacing, created_block, created_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(pool.address, idx, pool.token0, pool.token1, pool.fee, pool.tickSpacing, pool.block, times.get(pool.block) || 0);
      pools.set(pool.address, pool);
    }
    for (const log of logs) {
      applyLog(log, pools.get(log.address.toLowerCase()), times.get(Number(BigInt(log.blockNumber))), senders.get(log.transactionHash));
    }
    setMeta("indexed", to);
  });
}

function bumpHour(pool, time, current, volume0 = 0, volume1 = 0, swaps = 0) {
  const hour = Math.floor(time / 3600) * 3600;
  const price = BigInt(current.sqrt_price) > 0n ? priceFromSqrt(BigInt(current.sqrt_price), pool.d0, pool.d1) : null;
  q(
    `INSERT INTO pool_hours (pool, hour, balance0, balance1, price, volume0, volume1, swaps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pool, hour) DO UPDATE SET
       balance0 = excluded.balance0, balance1 = excluded.balance1, price = excluded.price,
       volume0 = pool_hours.volume0 + excluded.volume0, volume1 = pool_hours.volume1 + excluded.volume1,
       swaps = pool_hours.swaps + excluded.swaps`
  ).run(pool.address, hour, toFloat(BigInt(current.balance0), pool.d0), toFloat(BigInt(current.balance1), pool.d1), price, volume0, volume1, swaps);
}

function addTickNet(pool, tick, delta) {
  const row = q("SELECT liquidity_net FROM ticks WHERE pool = ? AND tick = ?").get(pool, tick);
  const next = BigInt(row?.liquidity_net || "0") + delta;
  if (next === 0n) q("DELETE FROM ticks WHERE pool = ? AND tick = ?").run(pool, tick);
  else q("INSERT OR REPLACE INTO ticks (pool, tick, liquidity_net) VALUES (?, ?, ?)").run(pool, tick, next.toString());
}

function applyLog(log, pool, time, sender) {
  if (!pool) return;
  let decoded;
  try {
    decoded = decodeEventLog({ abi: POOL_EVENTS, data: log.data, topics: log.topics });
  } catch {
    return;
  }
  const { eventName, args } = decoded;
  const block = Number(BigInt(log.blockNumber));
  const logIndex = Number(BigInt(log.logIndex));
  const tx = log.transactionHash;
  const current = q("SELECT sqrt_price, tick, liquidity, balance0, balance1 FROM pools WHERE address = ?").get(pool.address);
  let b0 = BigInt(current.balance0);
  let b1 = BigInt(current.balance1);
  let liquidity = BigInt(current.liquidity);
  let sqrtPrice = current.sqrt_price;
  let tick = current.tick;
  const insert = q(
    `INSERT OR IGNORE INTO events (block, log_index, pair, kind, time, tx, account, amount0_in, amount1_in, amount0_out, amount1_out, volume0, volume1, tick_lower, tick_upper)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let volume0 = 0;
  let volume1 = 0;
  let swaps = 0;

  if (eventName === "Initialize") {
    sqrtPrice = args.sqrtPriceX96.toString();
    tick = Number(args.tick);
  } else if (eventName === "Swap") {
    b0 += args.amount0;
    b1 += args.amount1;
    sqrtPrice = args.sqrtPriceX96.toString();
    tick = Number(args.tick);
    liquidity = args.liquidity;
    volume0 = toFloat(abs(args.amount0), pool.d0);
    volume1 = toFloat(abs(args.amount1), pool.d1);
    swaps = 1;
    insert.run(
      block, logIndex, pool.address, "swap", time, tx, sender || args.recipient.toLowerCase(),
      (args.amount0 > 0n ? args.amount0 : 0n).toString(), (args.amount1 > 0n ? args.amount1 : 0n).toString(),
      (args.amount0 < 0n ? -args.amount0 : 0n).toString(), (args.amount1 < 0n ? -args.amount1 : 0n).toString(),
      volume0, volume1, null, null
    );
    q("UPDATE pools SET swaps = swaps + 1 WHERE address = ?").run(pool.address);
  } else if (eventName === "Mint") {
    b0 += args.amount0;
    b1 += args.amount1;
    const lower = Number(args.tickLower);
    const upper = Number(args.tickUpper);
    addTickNet(pool.address, lower, args.amount);
    addTickNet(pool.address, upper, -args.amount);
    if (tick != null && lower <= tick && tick < upper) liquidity += args.amount;
    insert.run(block, logIndex, pool.address, "add", time, tx, sender, args.amount0.toString(), args.amount1.toString(), "0", "0", 0, 0, lower, upper);
  } else if (eventName === "Burn") {
    const lower = Number(args.tickLower);
    const upper = Number(args.tickUpper);
    if (args.amount > 0n) {
      addTickNet(pool.address, lower, -args.amount);
      addTickNet(pool.address, upper, args.amount);
      if (tick != null && lower <= tick && tick < upper) liquidity -= args.amount;
      insert.run(block, logIndex, pool.address, "remove", time, tx, sender, "0", "0", args.amount0.toString(), args.amount1.toString(), 0, 0, lower, upper);
    }
  } else if (eventName === "Collect") {
    b0 -= args.amount0;
    b1 -= args.amount1;
    if (args.amount0 > 0n || args.amount1 > 0n) {
      insert.run(
        block, logIndex, pool.address, "collect", time, tx, sender, "0", "0", args.amount0.toString(), args.amount1.toString(), 0, 0,
        Number(args.tickLower), Number(args.tickUpper)
      );
    }
  } else if (eventName === "Flash") {
    b0 += args.paid0;
    b1 += args.paid1;
  } else if (eventName === "CollectProtocol") {
    b0 -= args.amount0;
    b1 -= args.amount1;
  }

  const next = { sqrt_price: sqrtPrice, balance0: b0.toString(), balance1: b1.toString() };
  q("UPDATE pools SET sqrt_price = ?, tick = ?, liquidity = ?, balance0 = ?, balance1 = ? WHERE address = ?").run(
    sqrtPrice, tick, (liquidity < 0n ? 0n : liquidity).toString(), next.balance0, next.balance1, pool.address
  );
  bumpHour(pool, time, next, volume0, volume1, swaps);
}

async function tick(log) {
  const head = Number(BigInt(await rpc("eth_blockNumber")));
  state.chainHead = head;
  const target = head - ENV.confirmations;
  let from = Number(getMeta("indexed", String(ENV.startBlock - 1))) + 1;
  while (from <= target) {
    const to = Math.min(target, from + chunk - 1);
    await indexRange(from, to);
    state.indexed = to;
    from = to + 1;
    if (chunk < ENV.logChunk) chunk = Math.min(ENV.logChunk, chunk * 2);
  }
  state.indexed = Math.max(state.indexed, target);
  if (state.lastError) log.info("indexer recovered");
  state.lastError = "";
}

export function startIndexer(log) {
  const chainId = getMeta("chain_id");
  if (chainId && Number(chainId) !== ENV.chainId) throw new Error(`index.db belongs to chain ${chainId}, not ${ENV.chainId}`);
  const factory = getMeta("factory");
  if (factory && factory !== ENV.factory) throw new Error(`index.db was built for factory ${factory}`);
  setMeta("chain_id", ENV.chainId);
  setMeta("factory", ENV.factory);
  state.indexed = Number(getMeta("indexed", String(ENV.startBlock - 1)));

  const loop = async () => {
    if (state.running) return;
    state.running = true;
    try {
      await tick(log);
    } catch (error) {
      state.lastError = error.message || String(error);
      log.warn({ err: state.lastError }, "indexer error");
    } finally {
      state.running = false;
      setTimeout(loop, ENV.pollMs);
    }
  };
  loop();
}
