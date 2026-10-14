import { ENV } from "./config.js";
import { q } from "./db.js";
import { priceFromSqrt } from "./indexer.js";
import { getSettings } from "./settings.js";

const DAY = 86_400;
const HOUR = 3_600;
const now = () => Math.floor(Date.now() / 1000);

function loadPairs() {
  return q(
    `SELECT p.address, p.idx, p.token0, p.token1, p.fee, p.tick_spacing AS tickSpacing, p.sqrt_price AS sqrtPrice, p.tick, p.liquidity,
            p.balance0 AS reserve0, p.balance1 AS reserve1, p.swaps, p.created_time AS createdTime,
            t0.symbol AS symbol0, t0.name AS name0, t0.decimals AS d0,
            t1.symbol AS symbol1, t1.name AS name1, t1.decimals AS d1
     FROM pools p JOIN tokens t0 ON t0.address = p.token0 JOIN tokens t1 ON t1.address = p.token1`
  )
    .all()
    .map((row) => ({
      ...row,
      r0: Number(BigInt(row.reserve0)) / 10 ** row.d0,
      r1: Number(BigInt(row.reserve1)) / 10 ** row.d1,
      price: BigInt(row.sqrtPrice) > 0n ? priceFromSqrt(BigInt(row.sqrtPrice), row.d0, row.d1) : null,
    }));
}

/**
 * Prices every token in the native coin by walking pools outward from the wrapped native token,
 * always trusting the deepest pool (by value held) that links a token to an already-priced one.
 */
function priceTokens(pairs) {
  const prices = new Map([[ENV.wnative, 1]]);
  const depth = new Map([[ENV.wnative, Infinity]]);
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const pair of pairs) {
      if (!(pair.price > 0) || !(BigInt(pair.liquidity) > 0n)) continue;
      for (const [known, other, rKnown, rOther, otherInKnown] of [
        [pair.token0, pair.token1, pair.r0, pair.r1, 1 / pair.price],
        [pair.token1, pair.token0, pair.r1, pair.r0, pair.price],
      ]) {
        if (!prices.has(known) || depth.get(other) === Infinity) continue;
        const otherPrice = otherInKnown * prices.get(known);
        const liquidity = rKnown * prices.get(known) + rOther * otherPrice;
        if (liquidity > (depth.get(other) ?? 0)) {
          prices.set(other, otherPrice);
          depth.set(other, liquidity);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return prices;
}

function pairValue(pair, prices) {
  const p0 = prices.get(pair.token0);
  const p1 = prices.get(pair.token1);
  if (p0 != null && p1 != null) return pair.r0 * p0 + pair.r1 * p1;
  if (p0 != null && pair.price > 0) return pair.r0 * p0 + (pair.r1 / pair.price) * p0;
  if (p1 != null && pair.price > 0) return pair.r1 * p1 + pair.r0 * pair.price * p1;
  return null;
}

function volumeValue(volume0, volume1, pair, prices) {
  const p0 = prices.get(pair.token0);
  const p1 = prices.get(pair.token1);
  if (p0 != null && p1 != null) return (volume0 * p0 + volume1 * p1) / 2;
  if (p0 != null) return volume0 * p0;
  if (p1 != null) return volume1 * p1;
  return null;
}

let cache = { at: 0, value: null };

export function snapshot() {
  if (cache.value && Date.now() - cache.at < 4000) return cache.value;
  const settings = getSettings();
  const pairs = loadPairs();
  const prices = priceTokens(pairs);
  const stablePrice = settings.stableToken ? prices.get(settings.stableToken) : null;
  const nativeUsd = stablePrice ? 1 / stablePrice : null;

  const since24 = now() - DAY;
  const since48 = now() - 2 * DAY;
  const since7d = now() - 7 * DAY;
  const volumes = new Map();
  for (const row of q(
    `SELECT pool AS pair,
            SUM(CASE WHEN hour >= ? THEN volume0 ELSE 0 END) AS v0d, SUM(CASE WHEN hour >= ? THEN volume1 ELSE 0 END) AS v1d,
            SUM(CASE WHEN hour >= ? AND hour < ? THEN volume0 ELSE 0 END) AS v0p, SUM(CASE WHEN hour >= ? AND hour < ? THEN volume1 ELSE 0 END) AS v1p,
            SUM(volume0) AS v0w, SUM(volume1) AS v1w,
            SUM(CASE WHEN hour >= ? THEN swaps ELSE 0 END) AS swaps24
     FROM pool_hours WHERE hour >= ? GROUP BY pool`
  ).all(since24, since24, since48, since24, since48, since24, since24, since7d)) {
    volumes.set(row.pair, row);
  }

  const enriched = pairs.map((pair) => {
    const v = volumes.get(pair.address) || {};
    const tvl = pairValue(pair, prices);
    const volume24h = volumeValue(v.v0d || 0, v.v1d || 0, pair, prices);
    return {
      address: pair.address,
      idx: pair.idx,
      fee: pair.fee,
      tickSpacing: pair.tickSpacing,
      sqrtPriceX96: pair.sqrtPrice,
      tick: pair.tick,
      liquidity: pair.liquidity,
      token0: { address: pair.token0, symbol: pair.symbol0, name: pair.name0, decimals: pair.d0 },
      token1: { address: pair.token1, symbol: pair.symbol1, name: pair.name1, decimals: pair.d1 },
      reserve0: pair.reserve0,
      reserve1: pair.reserve1,
      reserve0Float: pair.r0,
      reserve1Float: pair.r1,
      price0: pair.price,
      price1: pair.price > 0 ? 1 / pair.price : null,
      tvl,
      volume24h,
      fees24h: volume24h == null ? null : (volume24h * pair.fee) / 1e6,
      volumePrev24h: volumeValue(v.v0p || 0, v.v1p || 0, pair, prices),
      volume7d: volumeValue(v.v0w || 0, v.v1w || 0, pair, prices),
      swaps24h: v.swaps24 || 0,
      swaps: pair.swaps,
      createdTime: pair.createdTime,
    };
  });

  const value = { pairs: enriched, prices, nativeUsd, raw: pairs };
  cache = { at: Date.now(), value };
  return value;
}

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0);

export function overview() {
  const { pairs, nativeUsd, raw, prices } = snapshot();
  const days = 30;
  const start = Math.floor(now() / DAY) * DAY - (days - 1) * DAY;
  const byPair = new Map(raw.map((pair) => [pair.address, pair]));

  const baseline = new Map();
  for (const row of q(
    `SELECT h.pool AS pair, h.balance0 AS reserve0, h.balance1 AS reserve1, h.price FROM pool_hours h
     JOIN (SELECT pool, MAX(hour) AS hour FROM pool_hours WHERE hour < ? GROUP BY pool) last
       ON last.pool = h.pool AND last.hour = h.hour`
  ).all(start)) {
    baseline.set(row.pair, row);
  }
  const series = Array.from({ length: days }, (_, i) => ({ day: start + i * DAY, volume: 0, tvl: 0 }));
  const reserves = new Map(baseline);
  const hours = q(
    "SELECT pool AS pair, hour, balance0 AS reserve0, balance1 AS reserve1, price, volume0, volume1 FROM pool_hours WHERE hour >= ? ORDER BY hour"
  ).all(start);
  let cursor = 0;
  for (const point of series) {
    const end = point.day + DAY;
    for (; cursor < hours.length && hours[cursor].hour < end; cursor += 1) {
      const row = hours[cursor];
      const pair = byPair.get(row.pair);
      if (!pair) continue;
      reserves.set(row.pair, row);
      point.volume += volumeValue(row.volume0, row.volume1, pair, prices) || 0;
    }
    for (const [address, row] of reserves) {
      const pair = byPair.get(address);
      if (pair) point.tvl += pairValue({ ...pair, r0: row.reserve0, r1: row.reserve1, price: row.price ?? pair.price }, prices) || 0;
    }
  }

  const volume24h = sum(pairs, "volume24h");
  const volumePrev24h = sum(pairs, "volumePrev24h");
  const tvl = sum(pairs, "tvl");
  return {
    tvl,
    volume24h,
    fees24h: sum(pairs, "fees24h"),
    volumeChange: volumePrev24h > 0 ? (volume24h - volumePrev24h) / volumePrev24h : null,
    volume7d: sum(pairs, "volume7d"),
    swaps24h: sum(pairs, "swaps24h"),
    pairCount: pairs.length,
    tokenCount: q("SELECT COUNT(*) AS n FROM tokens").get().n,
    nativeUsd,
    series,
  };
}

export function tokens() {
  const { pairs, prices, nativeUsd } = snapshot();
  const map = new Map();
  for (const pair of pairs) {
    for (const [token, reserve] of [
      [pair.token0, pair.reserve0Float],
      [pair.token1, pair.reserve1Float],
    ]) {
      const entry = map.get(token.address) || { ...token, price: prices.get(token.address) ?? null, tvl: 0, volume24h: 0, pairs: 0 };
      entry.pairs += 1;
      if (entry.price != null) entry.tvl += reserve * entry.price;
      if (pair.volume24h) entry.volume24h += pair.volume24h;
      map.set(token.address, entry);
    }
  }
  const dayAgo = now() - DAY;
  for (const entry of map.values()) {
    entry.priceUsd = entry.price != null && nativeUsd ? entry.price * nativeUsd : null;
    entry.priceChange24h = priceChange(entry.address, dayAgo, entry.price);
  }
  return { tokens: [...map.values()].sort((a, b) => b.tvl - a.tvl), nativeUsd };
}

/** Change against the deepest native-quoted pool's closing reserves a day ago. */
function priceChange(token, at, price) {
  if (price == null || token === ENV.wnative) return token === ENV.wnative ? 0 : null;
  const pair = q(
    `SELECT address, token0 FROM pools WHERE ((token0 = ? AND token1 = ?) OR (token0 = ? AND token1 = ?)) AND liquidity != '0'
     ORDER BY CAST(liquidity AS REAL) DESC LIMIT 1`
  ).get(token, ENV.wnative, ENV.wnative, token);
  if (!pair) return null;
  const old = q("SELECT price FROM pool_hours WHERE pool = ? AND hour <= ? AND price > 0 ORDER BY hour DESC LIMIT 1").get(pair.address, at);
  if (!old) return null;
  const then = pair.token0 === token ? old.price : 1 / old.price;
  return then > 0 ? (price - then) / then : null;
}

export function pairDetail(address) {
  const { pairs, nativeUsd, prices } = snapshot();
  const pair = pairs.find((row) => row.address === address);
  if (!pair) return null;
  const since = now() - 7 * DAY;
  const hours = q("SELECT hour, price, volume0, volume1, swaps FROM pool_hours WHERE pool = ? AND hour >= ? ORDER BY hour").all(address, since);
  const raw = { token0: pair.token0.address, token1: pair.token1.address, price: pair.price0 };
  const candles = hours.map((row) => ({
    time: row.hour,
    price: row.price,
    volume: volumeValue(row.volume0, row.volume1, raw, prices),
    swaps: row.swaps,
  }));
  return { pair, candles, nativeUsd, hourSeconds: HOUR };
}

export function events({ pair, account, limit = 50 }) {
  const where = [];
  const args = [];
  if (pair) {
    where.push("e.pair = ?");
    args.push(pair);
  }
  if (account) {
    where.push("e.account = ?");
    args.push(account);
  }
  return q(
    `SELECT e.block, e.log_index AS logIndex, e.pair, e.kind, e.time, e.tx, e.account,
            e.amount0_in AS amount0In, e.amount1_in AS amount1In, e.amount0_out AS amount0Out, e.amount1_out AS amount1Out,
            e.tick_lower AS tickLower, e.tick_upper AS tickUpper, p.fee,
            t0.symbol AS symbol0, t0.decimals AS d0, t1.symbol AS symbol1, t1.decimals AS d1, p.token0, p.token1
     FROM events e JOIN pools p ON p.address = e.pair
       JOIN tokens t0 ON t0.address = p.token0 JOIN tokens t1 ON t1.address = p.token1
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY e.block DESC, e.log_index DESC LIMIT ?`
  ).all(...args, limit);
}

/** Active liquidity across price ranges, for the range chart: one entry per initialized tick boundary. */
export function liquidityBands(address) {
  const pool = q("SELECT tick, liquidity FROM pools WHERE address = ?").get(address);
  if (!pool) return null;
  const rows = q("SELECT tick, liquidity_net AS net FROM ticks WHERE pool = ? ORDER BY tick").all(address);
  const bands = [];
  let active = 0n;
  for (let i = 0; i < rows.length; i += 1) {
    active += BigInt(rows[i].net);
    const next = rows[i + 1];
    if (next && active > 0n) bands.push({ tickLower: rows[i].tick, tickUpper: next.tick, liquidity: active.toString() });
  }
  return { tick: pool.tick, liquidity: pool.liquidity, bands };
}
