import { QUOTER } from "./dex";
import { encodePath } from "./v3";

const MAX_ROUTES = 12;

/**
 * Routes from `from` to `to` through indexed pools that have liquidity: every direct fee tier,
 * then two-hop routes through any shared token, deepest first.
 */
export function candidateRoutes(from, to, pools) {
  const live = pools.filter((pool) => BigInt(pool.liquidity || 0) > 0n);
  const touching = (token) => live.filter((pool) => pool.token0.address === token || pool.token1.address === token);
  const other = (pool, token) => (pool.token0.address === token ? pool.token1.address : pool.token0.address);
  const routes = [];
  for (const pool of touching(from)) {
    if (other(pool, from) === to) routes.push({ tokens: [from, to], pools: [pool], depth: pool.tvl || 0 });
  }
  const hops = [];
  for (const first of touching(from)) {
    const mid = other(first, from);
    if (mid === to) continue;
    for (const second of touching(mid)) {
      if (other(second, mid) !== to) continue;
      hops.push({ tokens: [from, mid, to], pools: [first, second], depth: Math.min(first.tvl || 0, second.tvl || 0) });
    }
  }
  hops.sort((a, b) => b.depth - a.depth);
  return [...routes, ...hops].slice(0, MAX_ROUTES);
}

/** Quotes every route with QuoterV2 and returns the best: most output for exact input, least input for exact output. */
export async function bestQuote({ publicClient, quoter, routes, amount, exactIn }) {
  const results = await Promise.all(
    routes.map((route) => {
      const fees = route.pools.map((pool) => pool.fee);
      const path = exactIn ? encodePath(route.tokens, fees) : encodePath([...route.tokens].reverse(), [...fees].reverse());
      return publicClient
        .simulateContract({ address: quoter, abi: QUOTER, functionName: exactIn ? "quoteExactInput" : "quoteExactOutput", args: [path, amount] })
        .then(({ result }) => ({ route, path, quoted: result[0], gas: result[3] }))
        .catch(() => null);
    })
  );
  let best = null;
  for (const result of results) {
    if (!result || result.quoted === 0n) continue;
    if (!best || (exactIn ? result.quoted > best.quoted : result.quoted < best.quoted)) best = result;
  }
  return best;
}

/** Spot price along a route (output per input, decimal-adjusted) and the combined fee, from indexed pool prices. */
export function routeMidPrice(route) {
  let price = 1;
  let keep = 1;
  route.pools.forEach((pool, i) => {
    const input = route.tokens[i];
    const p = pool.token0.address === input ? pool.price0 : pool.price1;
    price *= p || 0;
    keep *= 1 - pool.fee / 1e6;
  });
  return { price, keep };
}
