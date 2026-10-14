"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { encodeFunctionData, formatUnits, maxUint256, parseUnits } from "viem";
import { AmountField, SlippageSettings, Spinner, TokenSelect } from "@/components/ui";
import { useApi } from "@/lib/api";
import { ERC20, NATIVE, ROUTER, WNATIVE, deadline, useBalances, useDex, withSlippageDown, withSlippageUp } from "@/lib/dex";
import { clampDecimals, num, pct } from "@/lib/format";
import { bestQuote, candidateRoutes, routeMidPrice } from "@/lib/route";
import { feeLabel } from "@/lib/v3";

function useDebounced(value, ms) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function safeParse(text, decimals) {
  try {
    const value = parseUnits(text || "0", decimals);
    return value > 0n ? value : 0n;
  } catch {
    return 0n;
  }
}

function SwapCard() {
  const dex = useDex();
  const { config, tokens, tokenByAddress, routeAddress, publicClient, account, send, slippageBps, deadlineMin, refreshKey } = dex;
  const params = useSearchParams();
  const [tokenIn, setTokenIn] = useState(null);
  const [tokenOut, setTokenOut] = useState(null);
  const [field, setField] = useState("in");
  const [typed, setTyped] = useState("");
  const [picker, setPicker] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quote, setQuote] = useState({ status: "idle" });
  const [allowance, setAllowance] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [impactAck, setImpactAck] = useState(false);
  const [invert, setInvert] = useState(false);

  useEffect(() => {
    if (!tokens.length || tokenIn) return;
    if ((params.get("in") || params.get("out")) && tokens.length < 2) return;
    const fromParam = params.get("in") && tokenByAddress(params.get("in") === NATIVE ? NATIVE : params.get("in"));
    const toParam = params.get("out") && tokenByAddress(params.get("out") === NATIVE ? NATIVE : params.get("out"));
    setTokenIn(fromParam || tokenByAddress(NATIVE));
    const fallbackOut =
      tokenByAddress(config.settings.stableToken) || tokenByAddress(config.settings.tokens[0]?.address) || tokens.find((t) => !t.native && t.address !== config.contracts.wnative);
    setTokenOut(toParam && toParam.address !== (fromParam || tokenByAddress(NATIVE))?.address ? toParam : fallbackOut || null);
  }, [tokens, tokenIn, params, tokenByAddress, config]);

  const balances = useBalances([tokenIn, tokenOut]);
  const debouncedTyped = useDebounced(typed, 280);
  const wnative = config?.contracts.wnative;
  const wrapMode =
    tokenIn && tokenOut && ((tokenIn.native && tokenOut.address === wnative) || (tokenIn.address === wnative && tokenOut.native)) ? (tokenIn.native ? "wrap" : "unwrap") : "";

  const { data: poolData } = useApi("/pairs?limit=500", { refreshMs: 30_000 });
  const pools = useMemo(() => poolData?.pairs || [], [poolData]);

  useEffect(() => {
    if (!tokenIn || !tokenOut || !publicClient) return undefined;
    const exactIn = field === "in";
    const amount = safeParse(debouncedTyped, exactIn ? tokenIn.decimals : tokenOut.decimals);
    if (!amount) {
      setQuote({ status: "idle" });
      return undefined;
    }
    if (wrapMode) {
      setQuote({ status: "ok", amountIn: amount, amountOut: amount, route: null, impact: 0, exactIn });
      return undefined;
    }
    let alive = true;
    setQuote((prev) => ({ ...prev, status: "loading" }));
    (async () => {
      const a = routeAddress(tokenIn);
      const b = routeAddress(tokenOut);
      const best = await bestQuote({ publicClient, quoter: config.contracts.quoter, routes: candidateRoutes(a, b, pools), amount, exactIn });
      if (!alive) return;
      if (!best) {
        setQuote({ status: "none" });
        return;
      }
      const amountIn = exactIn ? amount : best.quoted;
      const amountOut = exactIn ? best.quoted : amount;
      const { price: mid, keep } = routeMidPrice(best.route);
      const execution = Number(formatUnits(amountOut, tokenOut.decimals)) / Number(formatUnits(amountIn, tokenIn.decimals));
      const impact = mid > 0 ? Math.max(0, 1 - execution / (mid * keep)) : null;
      if (alive) setQuote({ status: "ok", amountIn, amountOut, route: best.route, path: best.path, impact, exactIn });
    })().catch((err) => alive && setQuote({ status: "error", error: err.message }));
    return () => {
      alive = false;
    };
  }, [debouncedTyped, field, tokenIn, tokenOut, publicClient, config, pools, wrapMode, routeAddress, refreshKey]);

  useEffect(() => {
    setImpactAck(false);
  }, [quote.amountIn, quote.amountOut]);

  useEffect(() => {
    if (!tokenIn || tokenIn.native || !account || !publicClient || wrapMode) {
      setAllowance(null);
      return;
    }
    publicClient
      .readContract({ address: tokenIn.address, abi: ERC20, functionName: "allowance", args: [account, config.contracts.router] })
      .then(setAllowance)
      .catch(() => setAllowance(null));
  }, [tokenIn, account, publicClient, config, wrapMode, refreshKey]);

  const ok = quote.status === "ok";
  const amountInRaw = field === "in" ? safeParse(typed, tokenIn?.decimals ?? 18) : ok ? quote.amountIn : 0n;
  const display = (side) => {
    if (field === side) return typed;
    if (!ok) return "";
    const token = side === "in" ? tokenIn : tokenOut;
    const raw = side === "in" ? quote.amountIn : quote.amountOut;
    return clampDecimals(formatUnits(raw, token.decimals), 8);
  };
  const balanceIn = tokenIn ? balances[tokenIn.address] : null;
  const insufficient = balanceIn != null && amountInRaw > balanceIn;
  const needsApproval = !wrapMode && tokenIn && !tokenIn.native && allowance != null && amountInRaw > 0n && allowance < (field === "in" ? amountInRaw : withSlippageUp(quote.amountIn || 0n, slippageBps));
  const highImpact = ok && quote.impact != null && quote.impact > 0.05;
  const extreme = ok && quote.impact != null && quote.impact > 0.15;

  const flip = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setField(field === "in" ? "out" : "in");
  };

  const pick = (token) => {
    if (picker === "in") {
      if (tokenOut?.address === token.address) setTokenOut(tokenIn);
      setTokenIn(token);
    } else {
      if (tokenIn?.address === token.address) setTokenIn(tokenOut);
      setTokenOut(token);
    }
    setPicker(null);
  };

  async function approve() {
    setBusy("approve");
    setError("");
    try {
      await send(`Approve ${tokenIn.symbol}`, (wallet, from) =>
        wallet.writeContract({ address: tokenIn.address, abi: ERC20, functionName: "approve", args: [config.contracts.router, maxUint256], account: from })
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function swap() {
    setBusy("swap");
    setError("");
    const label = `Swap ${num(formatUnits(quote.amountIn, tokenIn.decimals))} ${tokenIn.symbol} for ${tokenOut.symbol}`;
    try {
      await send(wrapMode ? `${wrapMode === "wrap" ? "Wrap" : "Unwrap"} ${tokenIn.symbol}` : label, async (wallet, from) => {
        if (wrapMode === "wrap") return wallet.writeContract({ address: wnative, abi: WNATIVE, functionName: "deposit", value: quote.amountIn, account: from });
        if (wrapMode === "unwrap") return wallet.writeContract({ address: wnative, abi: WNATIVE, functionName: "withdraw", args: [quote.amountIn], account: from });
        const dl = deadline(deadlineMin);
        const router = config.contracts.router;
        const exactIn = quote.exactIn;
        const minOut = withSlippageDown(quote.amountOut, slippageBps);
        const maxIn = withSlippageUp(quote.amountIn, slippageBps);
        // Native coin out: the router receives the wrapped coin, then unwraps it to the trader in the same transaction.
        const recipient = tokenOut.native ? router : from;
        const swapCall = exactIn
          ? { functionName: "exactInput", args: [{ path: quote.path, recipient, deadline: dl, amountIn: quote.amountIn, amountOutMinimum: minOut }] }
          : { functionName: "exactOutput", args: [{ path: quote.path, recipient, deadline: dl, amountOut: quote.amountOut, amountInMaximum: maxIn }] };
        const value = tokenIn.native ? (exactIn ? quote.amountIn : maxIn) : undefined;
        const extra = [];
        if (tokenOut.native) extra.push(encodeFunctionData({ abi: ROUTER, functionName: "unwrapWETH9", args: [exactIn ? minOut : quote.amountOut, from] }));
        if (tokenIn.native && !exactIn) extra.push(encodeFunctionData({ abi: ROUTER, functionName: "refundETH" }));
        const call = extra.length
          ? { functionName: "multicall", args: [[encodeFunctionData({ abi: ROUTER, ...swapCall }), ...extra]], value }
          : { ...swapCall, value };
        return wallet.writeContract({ address: router, abi: ROUTER, account: from, ...call });
      });
      setTyped("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  let action = { label: "Swap", disabled: false, onClick: swap };
  if (!account) action = { label: "Connect wallet", onClick: () => dex.connect().catch((err) => setError(err.message)) };
  else if (!tokenIn || !tokenOut) action = { label: "Select a token", disabled: true };
  else if (!typed) action = { label: "Enter an amount", disabled: true };
  else if (quote.status === "loading") action = { label: "Finding the best price…", disabled: true };
  else if (quote.status === "none") action = { label: "No liquidity for this pair", disabled: true };
  else if (!ok) action = { label: "Enter an amount", disabled: true };
  else if (insufficient) action = { label: `Insufficient ${tokenIn.symbol} balance`, disabled: true };
  else if (needsApproval) action = { label: `Approve ${tokenIn.symbol}`, onClick: approve };
  else if (extreme && !impactAck) action = { label: "Price impact too high", disabled: true };
  else if (highImpact) action = { label: "Swap anyway", onClick: swap, danger: true };
  else if (wrapMode) action = { label: wrapMode === "wrap" ? "Wrap" : "Unwrap", onClick: swap };

  const rate = ok && quote.amountIn > 0n
    ? Number(formatUnits(quote.amountOut, tokenOut.decimals)) / Number(formatUnits(quote.amountIn, tokenIn.decimals))
    : null;
  const routeTokens = ok && quote.route ? quote.route.tokens : [];
  const routeSymbols = routeTokens.map((address, i) => (i === 0 ? tokenIn.symbol : i === routeTokens.length - 1 ? tokenOut.symbol : tokenByAddress(address)?.symbol || "?"));

  return (
    <div className="mx-auto w-full max-w-[480px]">
      <div className="card p-3">
        <div className="flex items-center justify-between px-2 pb-3 pt-1">
          <h1 className="text-lg font-semibold">Swap</h1>
          <button type="button" className="btn-ghost h-9 gap-1.5 !rounded-xl" onClick={() => setSettingsOpen(true)}>
            <span className="text-xs text-muted">{slippageBps / 100}% slippage</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </button>
        </div>

        <AmountField
          label="You pay"
          token={tokenIn}
          value={display("in")}
          onChange={(value) => {
            setField("in");
            setTyped(clampDecimals(value, tokenIn?.decimals ?? 18));
          }}
          onToken={() => setPicker("in")}
          balance={balanceIn}
          onMax={() => {
            if (balanceIn == null) return;
            const reserve = tokenIn.native ? parseUnits("0.005", 18) : 0n;
            const max = balanceIn > reserve ? balanceIn - reserve : 0n;
            setField("in");
            setTyped(formatUnits(max, tokenIn.decimals));
          }}
        />
        <div className="relative z-10 -my-3 flex justify-center">
          <button type="button" onClick={flip} className="grid h-10 w-10 place-items-center rounded-xl border-4 border-white bg-black/5 transition hover:rotate-180 dark:border-panel dark:bg-field" aria-label="Flip">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </button>
        </div>
        <AmountField
          label="You receive"
          token={tokenOut}
          value={display("out")}
          onChange={(value) => {
            setField("out");
            setTyped(clampDecimals(value, tokenOut?.decimals ?? 18));
          }}
          onToken={() => setPicker("out")}
          balance={tokenOut ? balances[tokenOut.address] : null}
        />

        {ok && rate != null && !wrapMode ? (
          <div className="mt-3 space-y-2 rounded-2xl border border-black/5 px-4 py-3 text-sm dark:border-white/5">
            <button type="button" className="flex w-full justify-between font-medium" onClick={() => setInvert((v) => !v)}>
              <span>
                1 {invert ? tokenOut.symbol : tokenIn.symbol} = {num(invert ? 1 / rate : rate)} {invert ? tokenIn.symbol : tokenOut.symbol}
              </span>
              {quote.status === "loading" ? <Spinner size={14} /> : null}
            </button>
            <Row label="Price impact" value={quote.impact == null ? "–" : quote.impact < 0.0001 ? "<0.01%" : pct(-quote.impact)} tone={highImpact ? "down" : ""} />
            {quote.exactIn ? (
              <Row label="Minimum received" value={`${num(formatUnits(withSlippageDown(quote.amountOut, slippageBps), tokenOut.decimals))} ${tokenOut.symbol}`} />
            ) : (
              <Row label="Maximum sold" value={`${num(formatUnits(withSlippageUp(quote.amountIn, slippageBps), tokenIn.decimals))} ${tokenIn.symbol}`} />
            )}
            <Row label="Fee tier" value={quote.route.pools.map((pool) => feeLabel(pool.fee)).join(" + ")} />
            <Row label="Route" value={routeSymbols.join(" → ")} />
          </div>
        ) : null}

        {extreme ? (
          <label className="mt-3 flex items-start gap-2 rounded-2xl bg-down/10 px-4 py-3 text-xs text-down">
            <input type="checkbox" checked={impactAck} onChange={(event) => setImpactAck(event.target.checked)} className="mt-0.5" />
            This trade moves the price by {pct(quote.impact)}. I understand I may receive much less.
          </label>
        ) : null}

        <button
          type="button"
          className={`mt-3 h-14 w-full text-base ${action.danger ? "btn bg-down text-white" : "btn-primary"}`}
          disabled={action.disabled || Boolean(busy)}
          onClick={action.onClick}
        >
          {busy ? <Spinner /> : null}
          {busy === "approve" ? `Approving ${tokenIn.symbol}…` : busy === "swap" ? "Swapping…" : action.label}
        </button>
        {error ? <p className="mt-3 break-words px-2 text-sm text-down">{error}</p> : null}
      </div>

      {picker ? <TokenSelect onSelect={pick} onClose={() => setPicker(null)} exclude={picker === "in" ? tokenIn?.address : tokenOut?.address} /> : null}
      {settingsOpen ? <SlippageSettings onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}

function Row({ label, value, tone }) {
  return (
    <div className="flex justify-between gap-4 text-muted">
      <span>{label}</span>
      <span className={`text-right ${tone === "down" ? "text-down" : "text-ink dark:text-white"}`}>{value}</span>
    </div>
  );
}

export default function SwapPage() {
  const { config } = useDex();
  if (!config) return <p className="py-20 text-center text-muted">Loading…</p>;
  return (
    <Suspense fallback={null}>
      <SwapCard />
    </Suspense>
  );
}
