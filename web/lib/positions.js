"use client";

import { useEffect, useState } from "react";
import { zeroAddress } from "viem";
import { FACTORY, POOL, POSITIONS, useDex } from "./dex";
import { amountsForLiquidity, sqrtPriceToPrice, sqrtRatioAtTick } from "./v3";

const MAX_U128 = 2n ** 128n - 1n;

/** Live pool state (price, tick, liquidity) for a token pair and fee tier. */
export async function readPool(publicClient, factory, tokenA, tokenB, fee) {
  const address = await publicClient.readContract({ address: factory, abi: FACTORY, functionName: "getPool", args: [tokenA, tokenB, fee] });
  if (address === zeroAddress) return null;
  const [[sqrtPriceX96, tick], liquidity] = await Promise.all([
    publicClient.readContract({ address, abi: POOL, functionName: "slot0" }),
    publicClient.readContract({ address, abi: POOL, functionName: "liquidity" }),
  ]);
  return { address: address.toLowerCase(), sqrtPriceX96, tick: Number(tick), liquidity };
}

/** One position NFT with its pool, token amounts at the current price and fees waiting to be collected. */
export async function readPosition({ publicClient, config, tokenId, owner, tokenMeta }) {
  const manager = config.contracts.positionManager;
  const p = await publicClient.readContract({ address: manager, abi: POSITIONS, functionName: "positions", args: [tokenId] });
  const [, , token0, token1, fee, tickLower, tickUpper, liquidity, , , owed0, owed1] = p;
  const t0 = await tokenMeta(token0.toLowerCase());
  const t1 = await tokenMeta(token1.toLowerCase());
  const pool = await readPool(publicClient, config.contracts.factory, token0, token1, fee);
  let amount0 = 0n;
  let amount1 = 0n;
  if (pool && liquidity > 0n) {
    [amount0, amount1] = amountsForLiquidity(pool.sqrtPriceX96, sqrtRatioAtTick(Number(tickLower)), sqrtRatioAtTick(Number(tickUpper)), liquidity);
  }
  let fees0 = owed0;
  let fees1 = owed1;
  if (owner) {
    try {
      const { result } = await publicClient.simulateContract({
        address: manager,
        abi: POSITIONS,
        functionName: "collect",
        args: [{ tokenId, recipient: owner, amount0Max: MAX_U128, amount1Max: MAX_U128 }],
        account: owner,
      });
      [fees0, fees1] = result;
    } catch {
      /* fall back to tokensOwed */
    }
  }
  return {
    tokenId,
    token0: t0,
    token1: t1,
    fee: Number(fee),
    tickLower: Number(tickLower),
    tickUpper: Number(tickUpper),
    liquidity,
    pool,
    amount0,
    amount1,
    fees0,
    fees1,
    inRange: Boolean(pool && pool.tick >= Number(tickLower) && pool.tick < Number(tickUpper)),
    price: pool ? sqrtPriceToPrice(pool.sqrtPriceX96, t0.decimals, t1.decimals) : null,
  };
}

/** Token metadata from the token list, falling back to the DEX API (which reads it on-chain). */
export function useTokenMeta() {
  const { tokenByAddress } = useDex();
  return async (address) => {
    const known = tokenByAddress(address);
    if (known) return known;
    const response = await fetch(`/api/token/${address}`);
    const body = await response.json().catch(() => ({}));
    return body.token || { address, symbol: "TOKEN", name: "Token", decimals: 18 };
  };
}

export function usePositions() {
  const { publicClient, config, account, refreshKey } = useDex();
  const tokenMeta = useTokenMeta();
  const [state, setState] = useState({ status: "idle", rows: [] });

  useEffect(() => {
    if (!publicClient || !account || !config) {
      setState({ status: "idle", rows: [] });
      return undefined;
    }
    let alive = true;
    setState((prev) => ({ ...prev, status: prev.rows.length ? "ready" : "loading" }));
    (async () => {
      const manager = config.contracts.positionManager;
      const count = Number(await publicClient.readContract({ address: manager, abi: POSITIONS, functionName: "balanceOf", args: [account] }));
      const ids = await Promise.all(
        Array.from({ length: Math.min(count, 100) }, (_, i) =>
          publicClient.readContract({ address: manager, abi: POSITIONS, functionName: "tokenOfOwnerByIndex", args: [account, BigInt(i)] })
        )
      );
      const rows = await Promise.all(ids.map((tokenId) => readPosition({ publicClient, config, tokenId, owner: account, tokenMeta })));
      if (alive) setState({ status: "ready", rows: rows.sort((a, b) => Number(b.tokenId - a.tokenId)) });
    })().catch((error) => alive && setState({ status: "error", rows: [], error: error.message }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, config, account, refreshKey]);

  return state;
}
