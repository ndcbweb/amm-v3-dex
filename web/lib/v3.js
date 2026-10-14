import { concatHex, numberToHex } from "viem";

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const Q96 = 2n ** 96n;
const Q32 = 2n ** 32n;
const MAX_UINT256 = 2n ** 256n - 1n;

const TICK_FACTORS = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** TickMath.getSqrtRatioAtTick, bit for bit. */
export function sqrtRatioAtTick(tick) {
  const abs = Math.abs(tick);
  if (abs > MAX_TICK) throw new Error("Tick out of range");
  let ratio = abs & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, factor] of TICK_FACTORS) if (abs & bit) ratio = (ratio * factor) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % Q32 === 0n ? 0n : 1n);
}

/** Price of token0 in token1, decimal-adjusted, at a tick. */
export function tickToPrice(tick, d0, d1) {
  return 1.0001 ** tick * 10 ** (d0 - d1);
}

export function priceToTick(price, d0, d1) {
  if (!(price > 0)) return null;
  return Math.floor(Math.log(price / 10 ** (d0 - d1)) / Math.log(1.0001));
}

export function sqrtPriceToPrice(sqrtPriceX96, d0, d1) {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return ratio * ratio * 10 ** (d0 - d1);
}

export function usableTick(tick, spacing) {
  const rounded = Math.round(tick / spacing) * spacing;
  const min = Math.ceil(MIN_TICK / spacing) * spacing;
  const max = Math.floor(MAX_TICK / spacing) * spacing;
  return Math.min(max, Math.max(min, rounded));
}

export const fullRange = (spacing) => [Math.ceil(MIN_TICK / spacing) * spacing, Math.floor(MAX_TICK / spacing) * spacing];

function bigSqrt(value) {
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/** sqrt(amount1 / amount0) as Q64.96, the starting price for a new pool. */
export function encodeSqrtPrice(amount1, amount0) {
  return bigSqrt((amount1 << 192n) / amount0);
}

/** Q64.96 sqrt price from a decimal price of token0 in token1. */
export function sqrtPriceFromPrice(price, d0, d1) {
  const raw = price * 10 ** (d1 - d0);
  const scale = 10n ** 18n;
  const numerator = BigInt(Math.round(raw * 1e18));
  if (numerator <= 0n) return null;
  return encodeSqrtPrice(numerator, scale);
}

const sort = (a, b) => (a > b ? [b, a] : [a, b]);

function liquidityForAmount0(sqrtA, sqrtB, amount0) {
  [sqrtA, sqrtB] = sort(sqrtA, sqrtB);
  return (amount0 * ((sqrtA * sqrtB) / Q96)) / (sqrtB - sqrtA);
}

function liquidityForAmount1(sqrtA, sqrtB, amount1) {
  [sqrtA, sqrtB] = sort(sqrtA, sqrtB);
  return (amount1 * Q96) / (sqrtB - sqrtA);
}

export function amount0ForLiquidity(sqrtA, sqrtB, liquidity) {
  [sqrtA, sqrtB] = sort(sqrtA, sqrtB);
  return (((liquidity << 96n) * (sqrtB - sqrtA)) / sqrtB) / sqrtA;
}

export function amount1ForLiquidity(sqrtA, sqrtB, liquidity) {
  [sqrtA, sqrtB] = sort(sqrtA, sqrtB);
  return (liquidity * (sqrtB - sqrtA)) / Q96;
}

/** LiquidityAmounts.getLiquidityForAmounts. */
export function liquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1) {
  [sqrtA, sqrtB] = sort(sqrtA, sqrtB);
  if (sqrtP <= sqrtA) return liquidityForAmount0(sqrtA, sqrtB, amount0);
  if (sqrtP < sqrtB) {
    const l0 = liquidityForAmount0(sqrtP, sqrtB, amount0);
    const l1 = liquidityForAmount1(sqrtA, sqrtP, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return liquidityForAmount1(sqrtA, sqrtB, amount1);
}

/** LiquidityAmounts.getAmountsForLiquidity. */
export function amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity) {
  [sqrtA, sqrtB] = sort(sqrtA, sqrtB);
  if (sqrtP <= sqrtA) return [amount0ForLiquidity(sqrtA, sqrtB, liquidity), 0n];
  if (sqrtP < sqrtB) return [amount0ForLiquidity(sqrtP, sqrtB, liquidity), amount1ForLiquidity(sqrtA, sqrtP, liquidity)];
  return [0n, amount1ForLiquidity(sqrtA, sqrtB, liquidity)];
}

/**
 * Given one side of a deposit into [tickLower, tickUpper] at the current price, the other side's amount.
 * Returns null when the range only takes the other token.
 */
export function pairedAmount({ sqrtP, tickLower, tickUpper, amount, side }) {
  const sqrtA = sqrtRatioAtTick(tickLower);
  const sqrtB = sqrtRatioAtTick(tickUpper);
  if (sqrtP <= sqrtA) return side === "0" ? 0n : null;
  if (sqrtP >= sqrtB) return side === "1" ? 0n : null;
  if (side === "0") return amount1ForLiquidity(sqrtA, sqrtP, liquidityForAmount0(sqrtP, sqrtB, amount));
  return amount0ForLiquidity(sqrtP, sqrtB, liquidityForAmount1(sqrtA, sqrtP, amount));
}

/** Packed swap path: token, fee, token, fee, token… (reverse it for exact-output swaps). */
export function encodePath(tokens, fees) {
  const parts = [tokens[0]];
  fees.forEach((fee, i) => parts.push(numberToHex(fee, { size: 3 }), tokens[i + 1]));
  return concatHex(parts);
}

export const feeLabel = (fee) => `${(fee / 10_000).toString()}%`;
