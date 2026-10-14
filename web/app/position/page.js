"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { encodeFunctionData, formatUnits, maxUint256, parseUnits, zeroAddress } from "viem";
import { RangeBadge, rangeText } from "@/components/position";
import { useDisplayToken } from "@/components/tables";
import { AmountField, PairLogo, SlippageSettings, Spinner } from "@/components/ui";
import { ERC20, NATIVE, POSITIONS, deadline, useBalances, useDex, withSlippageDown } from "@/lib/dex";
import { clampDecimals, num } from "@/lib/format";
import { readPosition, useTokenMeta } from "@/lib/positions";
import { feeLabel, pairedAmount, sqrtRatioAtTick } from "@/lib/v3";

const MAX_U128 = 2n ** 128n - 1n;

function parse(text, decimals) {
  try {
    const value = parseUnits(text || "0", decimals);
    return value > 0n ? value : 0n;
  } catch {
    return 0n;
  }
}

function Position() {
  const dex = useDex();
  const { config, publicClient, account, send, slippageBps, deadlineMin, refreshKey, tokenByAddress } = dex;
  const show = useDisplayToken();
  const tokenMeta = useTokenMeta();
  const params = useSearchParams();
  const id = /^\d+$/.test(params.get("id") || "") ? BigInt(params.get("id")) : null;
  const [position, setPosition] = useState({ status: "loading" });
  const [owner, setOwner] = useState("");
  const [percent, setPercent] = useState(100);
  const [asNative, setAsNative] = useState(true);
  const [field, setField] = useState("0");
  const [typed, setTyped] = useState("");
  const [allowances, setAllowances] = useState({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const manager = config.contracts.positionManager;
  const wnative = config.contracts.wnative;

  useEffect(() => {
    if (!publicClient || id == null) return undefined;
    let alive = true;
    (async () => {
      const holder = (await publicClient.readContract({ address: manager, abi: POSITIONS, functionName: "ownerOf", args: [id] })).toLowerCase();
      const row = await readPosition({ publicClient, config, tokenId: id, owner: holder, tokenMeta });
      if (alive) {
        setOwner(holder);
        setPosition({ status: "ready", ...row });
      }
    })().catch((err) => alive && setPosition({ status: "error", error: /nonexistent|invalid token/i.test(err.message) ? "This position does not exist or was burned." : err.message }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, id, refreshKey]);

  const ready = position.status === "ready";
  const t0 = ready ? show(position.token0) : null;
  const t1 = ready ? show(position.token1) : null;
  const hasNative = ready && (position.token0.address === wnative || position.token1.address === wnative);
  const isOwner = ready && account && account === owner;
  const nativeToken = tokenByAddress(NATIVE);
  const depositToken = (side) => {
    const token = side === "0" ? position.token0 : position.token1;
    return asNative && token.address === wnative ? nativeToken : token;
  };
  const dep0 = ready ? depositToken("0") : null;
  const dep1 = ready ? depositToken("1") : null;
  const balances = useBalances(ready ? [dep0, dep1] : []);

  useEffect(() => {
    if (!ready || !account || !publicClient) return undefined;
    let alive = true;
    Promise.all(
      [position.token0, position.token1].map((token) =>
        publicClient.readContract({ address: token.address, abi: ERC20, functionName: "allowance", args: [account, manager] }).catch(() => null)
      )
    ).then(([a, b]) => alive && setAllowances({ "0": a, "1": b }));
    return () => {
      alive = false;
    };
  }, [ready, position, account, publicClient, manager, refreshKey]);

  if (id == null) return <p className="py-20 text-center text-muted">Open a position from the Liquidity page.</p>;
  if (position.status === "loading") return <div className="flex justify-center py-20 text-muted"><Spinner /></div>;
  if (position.status === "error") return <p className="py-20 text-center text-down">{position.error}</p>;

  /** Collect into the position manager and forward, so the native coin can be unwrapped in the same transaction. */
  const payoutCalls = (from) => {
    const native = asNative && hasNative;
    const calls = [
      encodeFunctionData({
        abi: POSITIONS,
        functionName: "collect",
        args: [{ tokenId: id, recipient: native ? zeroAddress : from, amount0Max: MAX_U128, amount1Max: MAX_U128 }],
      }),
    ];
    if (native) {
      const other = position.token0.address === wnative ? position.token1.address : position.token0.address;
      calls.push(encodeFunctionData({ abi: POSITIONS, functionName: "unwrapWETH9", args: [0n, from] }));
      calls.push(encodeFunctionData({ abi: POSITIONS, functionName: "sweepToken", args: [other, 0n, from] }));
    }
    return calls;
  };

  async function run(kind, label, build) {
    setBusy(kind);
    setError("");
    try {
      await send(label, (wallet, from) => build(wallet, from));
      setTyped("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  const collect = () =>
    run("collect", `Collect ${t0.symbol}/${t1.symbol} fees`, (wallet, from) =>
      wallet.writeContract({ address: manager, abi: POSITIONS, functionName: "multicall", args: [payoutCalls(from)], account: from })
    );

  const removeLiquidity = position.liquidity > 0n ? (position.liquidity * BigInt(percent)) / 100n : 0n;
  const removeAmount0 = (position.amount0 * BigInt(percent)) / 100n;
  const removeAmount1 = (position.amount1 * BigInt(percent)) / 100n;
  const remove = () =>
    run("remove", `Remove ${percent}% of ${t0.symbol}/${t1.symbol}`, (wallet, from) => {
      const calls = [
        encodeFunctionData({
          abi: POSITIONS,
          functionName: "decreaseLiquidity",
          args: [
            {
              tokenId: id,
              liquidity: removeLiquidity,
              amount0Min: withSlippageDown(removeAmount0, slippageBps),
              amount1Min: withSlippageDown(removeAmount1, slippageBps),
              deadline: deadline(deadlineMin),
            },
          ],
        }),
        ...payoutCalls(from),
      ];
      return wallet.writeContract({ address: manager, abi: POSITIONS, functionName: "multicall", args: [calls], account: from });
    });

  const sqrtP = position.pool?.sqrtPriceX96;
  const onlyToken0 = sqrtP ? sqrtP <= sqrtRatioAtTick(position.tickLower) : false;
  const onlyToken1 = sqrtP ? sqrtP >= sqrtRatioAtTick(position.tickUpper) : false;
  const typedToken = field === "0" ? dep0 : dep1;
  const typedAmount = parse(typed, typedToken.decimals);
  const other = sqrtP && typedAmount > 0n ? pairedAmount({ sqrtP, tickLower: position.tickLower, tickUpper: position.tickUpper, amount: typedAmount, side: field }) : null;
  const add0 = field === "0" ? typedAmount : other ?? 0n;
  const add1 = field === "1" ? typedAmount : other ?? 0n;
  const shown = (side) => {
    if (field === side) return typed;
    const raw = side === "0" ? add0 : add1;
    return raw > 0n ? clampDecimals(formatUnits(raw, (side === "0" ? dep0 : dep1).decimals), 8) : "";
  };
  const need = ["0", "1"].find((side) => {
    const token = side === "0" ? dep0 : dep1;
    const amount = side === "0" ? add0 : add1;
    return !token.native && allowances[side] != null && amount > 0n && allowances[side] < amount;
  });
  const short = [[dep0, add0], [dep1, add1]].find(([token, amount]) => balances[token.address] != null && amount > balances[token.address])?.[0];

  const approve = (side) => {
    const token = side === "0" ? position.token0 : position.token1;
    return run(`approve-${side}`, `Approve ${token.symbol}`, (wallet, from) =>
      wallet.writeContract({ address: token.address, abi: ERC20, functionName: "approve", args: [manager, maxUint256], account: from })
    );
  };

  const increase = () =>
    run("increase", `Add to ${t0.symbol}/${t1.symbol} position`, (wallet, from) => {
      const value = dep0.native ? add0 : dep1.native ? add1 : 0n;
      const calls = [
        encodeFunctionData({
          abi: POSITIONS,
          functionName: "increaseLiquidity",
          args: [
            {
              tokenId: id,
              amount0Desired: add0,
              amount1Desired: add1,
              amount0Min: withSlippageDown(add0, slippageBps),
              amount1Min: withSlippageDown(add1, slippageBps),
              deadline: deadline(deadlineMin),
            },
          ],
        }),
      ];
      if (value) calls.push(encodeFunctionData({ abi: POSITIONS, functionName: "refundETH" }));
      return wallet.writeContract({ address: manager, abi: POSITIONS, functionName: "multicall", args: [calls], value: value || undefined, account: from });
    });

  let addAction = { label: "Add liquidity", onClick: increase };
  if (!account) addAction = { label: "Connect wallet", onClick: () => dex.connect().catch((err) => setError(err.message)) };
  else if (!(add0 > 0n || add1 > 0n)) addAction = { label: "Enter an amount", disabled: true };
  else if (short) addAction = { label: `Insufficient ${short.symbol} balance`, disabled: true };
  else if (need) addAction = { label: `Approve ${(need === "0" ? position.token0 : position.token1).symbol}`, onClick: () => approve(need) };

  const fees = position.fees0 > 0n || position.fees1 > 0n;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/pool/" className="btn-ghost h-9 w-9 !rounded-xl !p-0" aria-label="Back">
            ←
          </Link>
          <PairLogo a={t0} b={t1} />
          <h1 className="text-xl font-semibold">
            {t0.symbol}/{t1.symbol}
          </h1>
          <span className="chip">{feeLabel(position.fee)}</span>
          <RangeBadge position={position} />
        </div>
        <button type="button" className="btn-ghost h-9 !rounded-xl text-xs text-muted" onClick={() => setSettingsOpen(true)}>
          {slippageBps / 100}% slippage
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card space-y-3 p-5">
          <p className="label">Liquidity</p>
          <Amount token={t0} raw={position.amount0} decimals={position.token0.decimals} />
          <Amount token={t1} raw={position.amount1} decimals={position.token1.decimals} />
          <p className="label pt-2">Price range</p>
          <p className="text-sm">{rangeText(position, show)}</p>
          {position.price != null ? (
            <p className="text-xs text-muted">
              Current price: {num(position.price)} {t1.symbol} per {t0.symbol}
            </p>
          ) : null}
          <p className="text-xs text-muted">
            Position #{id.toString()} · owner {owner.slice(0, 6)}…{owner.slice(-4)}
          </p>
        </section>

        <section className="card space-y-3 p-5">
          <p className="label">Unclaimed fees</p>
          <Amount token={t0} raw={position.fees0} decimals={position.token0.decimals} />
          <Amount token={t1} raw={position.fees1} decimals={position.token1.decimals} />
          {hasNative ? (
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={asNative} onChange={(event) => setAsNative(event.target.checked)} />
              Receive {config.chain.native.symbol} instead of the wrapped token
            </label>
          ) : null}
          <button type="button" className="btn-soft w-full" disabled={!isOwner || !fees || Boolean(busy)} onClick={collect}>
            {busy === "collect" ? <Spinner /> : null}
            {isOwner ? (fees ? "Collect fees" : "No fees yet") : "Only the owner can collect"}
          </button>
        </section>
      </div>

      {isOwner && position.liquidity > 0n ? (
        <section className="card p-5">
          <p className="font-semibold">Remove liquidity</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-3xl font-semibold tabular-nums">{percent}%</span>
            {[25, 50, 75, 100].map((value) => (
              <button key={value} type="button" className={`chip !px-3 !py-1.5 ${percent === value ? "!bg-brand/15 !text-brand" : ""}`} onClick={() => setPercent(value)}>
                {value === 100 ? "Max" : `${value}%`}
              </button>
            ))}
          </div>
          <input type="range" min="1" max="100" value={percent} onChange={(event) => setPercent(Number(event.target.value))} className="mt-3 w-full accent-[var(--brand)]" />
          <p className="mt-2 text-sm text-muted">
            You receive about {num(formatUnits(removeAmount0, position.token0.decimals))} {t0.symbol} + {num(formatUnits(removeAmount1, position.token1.decimals))} {t1.symbol}, plus unclaimed fees.
          </p>
          <button type="button" className="btn-primary mt-3 w-full" disabled={Boolean(busy)} onClick={remove}>
            {busy === "remove" ? <Spinner /> : null}
            Remove
          </button>
        </section>
      ) : null}

      {isOwner ? (
        <section className="card space-y-2 p-5">
          <p className="font-semibold">Add more liquidity</p>
          {onlyToken1 ? null : (
            <AmountField
              label={dep0.symbol}
              token={dep0}
              value={shown("0")}
              onChange={(value) => {
                setField("0");
                setTyped(clampDecimals(value, dep0.decimals));
              }}
              balance={balances[dep0.address]}
            />
          )}
          {onlyToken0 ? null : (
            <AmountField
              label={dep1.symbol}
              token={dep1}
              value={shown("1")}
              onChange={(value) => {
                setField("1");
                setTyped(clampDecimals(value, dep1.decimals));
              }}
              balance={balances[dep1.address]}
            />
          )}
          <button type="button" className="btn-primary h-12 w-full" disabled={addAction.disabled || Boolean(busy)} onClick={addAction.onClick}>
            {busy === "increase" || busy.startsWith("approve") ? <Spinner /> : null}
            {addAction.label}
          </button>
        </section>
      ) : null}

      {error ? <p className="break-words px-2 text-sm text-down">{error}</p> : null}
      {settingsOpen ? <SlippageSettings onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}

function Amount({ token, raw, decimals }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="font-medium">{token.symbol}</span>
      <span className="tabular-nums">{num(formatUnits(raw, decimals))}</span>
    </div>
  );
}

export default function PositionPage() {
  const { config } = useDex();
  if (!config) return <p className="py-20 text-center text-muted">Loading…</p>;
  return (
    <Suspense fallback={null}>
      <Position />
    </Suspense>
  );
}
