"use client";

import { num } from "@/lib/format";
import { MAX_TICK, MIN_TICK, tickToPrice } from "@/lib/v3";

export function RangeBadge({ position }) {
  if (position.liquidity === 0n) return <span className="chip">Closed</span>;
  return position.inRange ? (
    <span className="chip !bg-up/15 !text-up">● In range</span>
  ) : (
    <span className="chip !bg-amber-500/15 !text-amber-600 dark:!text-amber-400">● Out of range</span>
  );
}

export function rangeText(position, show) {
  const t0 = show(position.token0);
  const t1 = show(position.token1);
  const spacingEdge = (tick) => tick <= MIN_TICK + 200 || tick >= MAX_TICK - 200;
  if (spacingEdge(position.tickLower) && spacingEdge(position.tickUpper)) return "Full range";
  const low = tickToPrice(position.tickLower, position.token0.decimals, position.token1.decimals);
  const high = tickToPrice(position.tickUpper, position.token0.decimals, position.token1.decimals);
  return `${num(low)} – ${num(high)} ${t1.symbol} per ${t0.symbol}`;
}
