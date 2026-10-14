"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { encodeFunctionData, formatUnits, maxUint256, parseUnits } from "viem";
import { AmountField, SlippageSettings, Spinner, TokenButton, TokenSelect } from "@/components/ui";
import { useApi } from "@/lib/api";
import { ERC20, NATIVE, POSITIONS, deadline, useBalances, useDex, withSlippageDown } from "@/lib/dex";
import { clampDecimals, num } from "@/lib/format";
import { readPool } from "@/lib/positions";
import {
  feeLabel,
  fullRange,
  pairedAmount,
  priceToTick,
  sqrtPriceFromPrice,
  sqrtPriceToPrice,
  sqrtRatioAtTick,
  tickToPrice,
  usableTick,
} from "@/lib/v3";

const PRESETS = [
  { id: "full", label: "Full range" },
  { id: 0.05, label: "±5%" },
  { id: 0.1, label: "±10%" },
  { id: 0.25, label: "±25%" },
];

function parse(text, decimals) {
  try {
    const value = parseUnits(text || "0", decimals);
    return value > 0n ? value : 0n;
  } catch {
    return 0n;
  }
}

function NewPosition() {
  const dex = useDex();
  const { config, tokens, tokenByAddress, routeAddress, publicClient, account, send, slippageBps, deadlineMin, refreshKey } = dex;
  const params = useSearchParams();
  const feeTiers = config.protocol?.feeTiers?.length ? config.protocol.feeTiers : [{ fee: 3000, tickSpacing: 60 }];
  const [tokenA, setTokenA] = useState(null);
  const [tokenB, setTokenB] = useState(null);
  const [fee, setFee] = useState(Number(params.get("fee")) || 3000);
  const [pool, setPool] = useState({ status: "idle" });
  const [startPrice, setStartPrice] = useState("");
  const [range, setRange] = useState({ min: "", max: "", preset: "full" });
  const [field, setField] = useState("a");
  const [typed, setTyped] = useState("");
  const [picker, setPicker] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [allowances, setAllowances] = useState({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const { data: poolData } = useApi("/pairs?limit=500", { refreshMs: 30_000 });

  useEffect(() => {
    if (!tokens.length || tokenA) return;
    if ((params.get("a") || params.get("b")) && tokens.length < 2) return;
    setTokenA(tokenByAddress(params.get("a") || NATIVE) || tokenByAddress(NATIVE));
    const b = params.get("b") && tokenByAddress(params.get("b"));
    setTokenB(b || null);
  }, [tokens, tokenA, params, tokenByAddress]);

  const tier = feeTiers.find((item) => item.fee === fee) || feeTiers[0];
  const spacing = tier.tickSpacing;
  const a = tokenA ? routeAddress(tokenA) : null;
  const b = tokenB ? routeAddress(tokenB) : null;
  const sameUnderlying = a && b && a === b;
  const aIs0 = a && b ? BigInt(a) < BigInt(b) : true;
  const [t0, t1] = aIs0 ? [tokenA, tokenB] : [tokenB, tokenA];

  useEffect(() => {
    if (!publicClient || !a || !b || a === b) {
      setPool({ status: "idle" });
      return undefined;
    }
    let alive = true;
    setPool((prev) => ({ ...prev, status: "loading" }));
    readPool(publicClient, config.contracts.factory, a, b, tier.fee)
      .then((state) => alive && setPool(state && state.sqrtPriceX96 > 0n ? { status: "ready", ...state } : { status: "missing" }))
      .catch((err) => alive && setPool({ status: "error", error: err.message }));
    return () => {
      alive = false;
    };
  }, [publicClient, config, a, b, tier.fee, refreshKey]);

  const tierStats = useMemo(() => {
    const map = new Map();
    for (const row of poolData?.pairs || []) {
      const pairMatch = (row.token0.address === a && row.token1.address === b) || (row.token0.address === b && row.token1.address === a);
      if (pairMatch) map.set(row.fee, row);
    }
    return map;
  }, [poolData, a, b]);

  /* Prices in the UI are "B per A"; the pool works in token1 per token0. */
  const toPool = (priceBA) => (aIs0 ? priceBA : 1 / priceBA);
  const fromPool = (price01) => (aIs0 ? price01 : 1 / price01);
  const d0 = t0?.decimals ?? 18;
  const d1 = t1?.decimals ?? 18;

  const sqrtP = pool.status === "ready" ? pool.sqrtPriceX96 : (() => {
    const p = Number(startPrice);
    return p > 0 && t0 && t1 ? sqrtPriceFromPrice(toPool(p), d0, d1) : null;
  })();
  const currentPrice = sqrtP ? fromPool(sqrtPriceToPrice(sqrtP, d0, d1)) : null;
  const currentTick = sqrtP ? priceToTick(sqrtPriceToPrice(sqrtP, d0, d1), d0, d1) : null;

  const ticks = useMemo(() => {
    if (range.preset === "full") return fullRange(spacing);
    const min = Number(range.min);
    const max = Number(range.max);
    if (!(min > 0 && max > min) || !t0 || !t1) return null;
    let lower = usableTick(priceToTick(toPool(aIs0 ? min : max), d0, d1), spacing);
    let upper = usableTick(priceToTick(toPool(aIs0 ? max : min), d0, d1), spacing);
    if (upper <= lower) upper = lower + spacing;
    return [lower, upper];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, spacing, aIs0, d0, d1, t0, t1]);

  useEffect(() => {
    if (typeof range.preset !== "number" || !currentPrice) return;
    setRange((prev) => ({
      ...prev,
      min: String(Number((currentPrice * (1 - prev.preset)).toPrecision(6))),
      max: String(Number((currentPrice * (1 + prev.preset)).toPrecision(6))),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.preset, currentPrice == null ? null : currentPrice.toPrecision(8)]);

  const balances = useBalances([tokenA, tokenB]);
  const typedToken = field === "a" ? tokenA : tokenB;
  const typedAmount = typedToken ? parse(typed, typedToken.decimals) : 0n;
  const typedSide = (field === "a") === aIs0 ? "0" : "1";
  const other = sqrtP && ticks && typedAmount > 0n ? pairedAmount({ sqrtP, tickLower: ticks[0], tickUpper: ticks[1], amount: typedAmount, side: typedSide }) : null;
  const onlyToken0 = sqrtP && ticks ? sqrtP <= sqrtRatioAtTick(ticks[0]) : false;
  const onlyToken1 = sqrtP && ticks ? sqrtP >= sqrtRatioAtTick(ticks[1]) : false;
  const aDisabled = (aIs0 && onlyToken1) || (!aIs0 && onlyToken0);
  const bDisabled = (aIs0 && onlyToken0) || (!aIs0 && onlyToken1);
  const amountA = field === "a" ? typedAmount : other ?? 0n;
  const amountB = field === "b" ? typedAmount : other ?? 0n;

  useEffect(() => {
    if ((field === "a" && aDisabled) || (field === "b" && bDisabled)) {
      setField(aDisabled ? "b" : "a");
      setTyped("");
    }
  }, [aDisabled, bDisabled, field]);

  const shown = (side) => {
    if (field === side) return typed;
    const raw = side === "a" ? amountA : amountB;
    const token = side === "a" ? tokenA : tokenB;
    return raw > 0n && token ? clampDecimals(formatUnits(raw, token.decimals), 8) : "";
  };

  useEffect(() => {
    if (!account || !publicClient) return undefined;
    let alive = true;
    Promise.all(
      [tokenA, tokenB].map((token) =>
        token && !token.native
          ? publicClient.readContract({ address: token.address, abi: ERC20, functionName: "allowance", args: [account, config.contracts.positionManager] }).catch(() => null)
          : null
      )
    ).then(([x, y]) => alive && setAllowances({ a: x, b: y }));
    return () => {
      alive = false;
    };
  }, [tokenA, tokenB, account, publicClient, config, refreshKey]);

  const pick = (token) => {
    if (picker === "a") {
      if (tokenB?.address === token.address) setTokenB(tokenA);
      setTokenA(token);
    } else {
      if (tokenA?.address === token.address) setTokenA(tokenB);
      setTokenB(token);
    }
    setPicker(null);
    setTyped("");
  };

  const needA = tokenA && !tokenA.native && allowances.a != null && amountA > 0n && allowances.a < amountA;
  const needB = tokenB && !tokenB.native && allowances.b != null && amountB > 0n && allowances.b < amountB;
  const short = [[tokenA, amountA], [tokenB, amountB]].find(([token, amount]) => token && balances[token.address] != null && amount > balances[token.address])?.[0];

  async function approve(token) {
    setBusy(`approve-${token.address}`);
    setError("");
    try {
      await send(`Approve ${token.symbol}`, (wallet, from) =>
        wallet.writeContract({ address: token.address, abi: ERC20, functionName: "approve", args: [config.contracts.positionManager, maxUint256], account: from })
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function supply() {
    setBusy("supply");
    setError("");
    try {
      await send(`Add ${tokenA.symbol}/${tokenB.symbol} ${feeLabel(tier.fee)} liquidity`, (wallet, from) => {
        const [amount0, amount1] = aIs0 ? [amountA, amountB] : [amountB, amountA];
        const fresh = pool.status !== "ready";
        const calls = [];
        if (fresh) {
          calls.push(encodeFunctionData({ abi: POSITIONS, functionName: "createAndInitializePoolIfNecessary", args: [routeAddress(t0), routeAddress(t1), tier.fee, sqrtP] }));
        }
        calls.push(
          encodeFunctionData({
            abi: POSITIONS,
            functionName: "mint",
            args: [
              {
                token0: routeAddress(t0),
                token1: routeAddress(t1),
                fee: tier.fee,
                tickLower: ticks[0],
                tickUpper: ticks[1],
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: fresh ? 0n : withSlippageDown(amount0, slippageBps),
                amount1Min: fresh ? 0n : withSlippageDown(amount1, slippageBps),
                recipient: from,
                deadline: deadline(deadlineMin),
              },
            ],
          })
        );
        const value = tokenA.native ? amountA : tokenB.native ? amountB : 0n;
        if (value) calls.push(encodeFunctionData({ abi: POSITIONS, functionName: "refundETH" }));
        return wallet.writeContract({
          address: config.contracts.positionManager,
          abi: POSITIONS,
          functionName: "multicall",
          args: [calls],
          value: value || undefined,
          account: from,
        });
      });
      setTyped("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  let action = { label: pool.status === "missing" ? "Create pool & add liquidity" : "Add liquidity", onClick: supply };
  if (!account) action = { label: "Connect wallet", onClick: () => dex.connect().catch((err) => setError(err.message)) };
  else if (!tokenA || !tokenB) action = { label: "Select a token", disabled: true };
  else if (sameUnderlying) action = { label: "Pick two different tokens", disabled: true };
  else if (!sqrtP) action = { label: pool.status === "missing" ? "Set a starting price" : "Loading pool…", disabled: true };
  else if (!ticks) action = { label: "Set a valid price range", disabled: true };
  else if (!(amountA > 0n || amountB > 0n)) action = { label: "Enter an amount", disabled: true };
  else if (short) action = { label: `Insufficient ${short.symbol} balance`, disabled: true };
  else if (needA) action = { label: `Approve ${tokenA.symbol}`, onClick: () => approve(tokenA) };
  else if (needB) action = { label: `Approve ${tokenB.symbol}`, onClick: () => approve(tokenB) };

  const maxFor = (token) => () => {
    const balance = balances[token.address];
    const reserve = token.native ? parseUnits("0.005", 18) : 0n;
    setField(token === tokenA ? "a" : "b");
    setTyped(formatUnits(balance > reserve ? balance - reserve : 0n, token.decimals));
  };
  const rangePrices = ticks && t0 && t1
    ? [fromPool(tickToPrice(ticks[aIs0 ? 0 : 1], d0, d1)), fromPool(tickToPrice(ticks[aIs0 ? 1 : 0], d0, d1))]
    : null;
  const full = range.preset === "full";
  const pairLabel = tokenA && tokenB ? `${tokenB.symbol} per ${tokenA.symbol}` : "";

  return (
    <div className="mx-auto w-full max-w-[520px]">
      <div className="card p-3">
        <div className="flex items-center justify-between px-2 pb-3 pt-1">
          <div className="flex items-center gap-2">
            <Link href="/pool/" className="btn-ghost h-9 w-9 !rounded-xl !p-0" aria-label="Back">
              ←
            </Link>
            <h1 className="text-lg font-semibold">New position</h1>
          </div>
          <button type="button" className="btn-ghost h-9 !rounded-xl text-xs text-muted" onClick={() => setSettingsOpen(true)}>
            {slippageBps / 100}% slippage
          </button>
        </div>

        <p className="label px-2">Pair</p>
        <div className="mt-2 grid grid-cols-2 gap-2 px-1">
          <div className="well flex justify-center p-2">
            <TokenButton token={tokenA} onClick={() => setPicker("a")} />
          </div>
          <div className="well flex justify-center p-2">
            <TokenButton token={tokenB} onClick={() => setPicker("b")} />
          </div>
        </div>

        <p className="label mt-4 px-2">Fee tier</p>
        <div className="mt-2 grid grid-cols-2 gap-2 px-1 sm:grid-cols-4">
          {feeTiers.map((item) => {
            const stats = tierStats.get(item.fee);
            return (
              <button
                key={item.fee}
                type="button"
                onClick={() => setFee(item.fee)}
                className={`rounded-2xl border px-3 py-2 text-left text-sm transition ${item.fee === tier.fee ? "border-brand bg-brand/10" : "border-black/10 dark:border-white/10"}`}
              >
                <span className="block font-semibold">{feeLabel(item.fee)}</span>
                <span className="block text-xs text-muted">{stats ? `${stats.tvl != null ? "Live pool" : "Pool exists"}` : "Not created"}</span>
              </button>
            );
          })}
        </div>

        {tokenA && tokenB && !sameUnderlying && pool.status === "missing" ? (
          <div className="mx-1 mt-4 rounded-2xl bg-brand/10 px-4 py-3 text-sm">
            <p className="font-semibold text-brand">This pool does not exist yet</p>
            <p className="mt-1 text-xs text-muted">Set its starting price. Check it against other markets so you are not arbitraged.</p>
            <label className="mt-3 block">
              <span className="label">Starting price ({pairLabel})</span>
              <input
                className="input mt-1 w-full"
                inputMode="decimal"
                placeholder="0.0"
                value={startPrice}
                onChange={(event) => setStartPrice(clampDecimals(event.target.value, 18))}
              />
            </label>
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between px-2">
          <p className="label">Price range</p>
          {currentPrice ? (
            <p className="text-xs text-muted">
              Current: {num(currentPrice)} {pairLabel}
            </p>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 px-1">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => setRange((prev) => ({ ...prev, preset: preset.id }))}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium ${range.preset === preset.id ? "border-brand bg-brand/10 text-brand" : "border-black/10 dark:border-white/10"}`}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 px-1">
          {["min", "max"].map((key) => (
            <label key={key} className="well block p-3">
              <span className="label">{key === "min" ? "Min price" : "Max price"}</span>
              <input
                className="mt-1 w-full bg-transparent text-lg font-medium tabular-nums outline-none"
                inputMode="decimal"
                placeholder={full ? (key === "min" ? "0" : "∞") : "0.0"}
                value={full ? "" : range[key]}
                onChange={(event) => setRange((prev) => ({ ...prev, preset: "custom", [key]: clampDecimals(event.target.value, 18) }))}
              />
              <span className="text-xs text-muted">{pairLabel}</span>
            </label>
          ))}
        </div>
        {rangePrices && !full ? (
          <p className="mt-2 px-2 text-xs text-muted">
            Rounded to the {feeLabel(tier.fee)} tick spacing: {num(rangePrices[0])} – {num(rangePrices[1])}
            {currentTick != null && ticks && (currentTick < ticks[0] || currentTick >= ticks[1]) ? ". The current price is outside this range, so you deposit one token only and earn no fees until the price enters it." : ""}
          </p>
        ) : null}

        <p className="label mt-4 px-2">Deposit</p>
        <div className="mt-2 space-y-2">
          {aDisabled ? (
            <p className="well p-4 text-sm text-muted">{tokenA?.symbol} is not needed for this range.</p>
          ) : (
            <AmountField
              label={tokenA?.symbol || "Token A"}
              token={tokenA}
              value={shown("a")}
              onChange={(value) => {
                setField("a");
                setTyped(clampDecimals(value, tokenA?.decimals ?? 18));
              }}
              onToken={() => setPicker("a")}
              balance={tokenA ? balances[tokenA.address] : null}
              onMax={tokenA ? maxFor(tokenA) : undefined}
            />
          )}
          {bDisabled ? (
            <p className="well p-4 text-sm text-muted">{tokenB?.symbol} is not needed for this range.</p>
          ) : (
            <AmountField
              label={tokenB?.symbol || "Token B"}
              token={tokenB}
              value={shown("b")}
              onChange={(value) => {
                setField("b");
                setTyped(clampDecimals(value, tokenB?.decimals ?? 18));
              }}
              onToken={() => setPicker("b")}
              balance={tokenB ? balances[tokenB.address] : null}
              onMax={tokenB ? maxFor(tokenB) : undefined}
            />
          )}
        </div>

        <button type="button" className="btn-primary mt-3 h-14 w-full text-base" disabled={action.disabled || Boolean(busy)} onClick={action.onClick}>
          {busy ? <Spinner /> : null}
          {busy.startsWith("approve") ? "Approving…" : busy === "supply" ? "Adding liquidity…" : action.label}
        </button>
        {error ? <p className="mt-3 break-words px-2 text-sm text-down">{error}</p> : null}
      </div>

      {picker ? <TokenSelect onSelect={pick} onClose={() => setPicker(null)} exclude={picker === "a" ? tokenA?.address : tokenB?.address} /> : null}
      {settingsOpen ? <SlippageSettings onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}

export default function AddPage() {
  const { config } = useDex();
  if (!config) return <p className="py-20 text-center text-muted">Loading…</p>;
  return (
    <Suspense fallback={null}>
      <NewPosition />
    </Suspense>
  );
}
