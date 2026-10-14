"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { EventsTable, useDisplayToken } from "@/components/tables";
import { Chart, PairLogo, Spinner, Stat, Tabs, TokenLogo } from "@/components/ui";
import { useApi } from "@/lib/api";
import { NATIVE, useDex } from "@/lib/dex";
import { money, num, short } from "@/lib/format";
import { feeLabel, tickToPrice } from "@/lib/v3";

function PairView() {
  const { config, explorerAddress } = useDex();
  const show = useDisplayToken();
  const id = String(useSearchParams().get("id") || "").toLowerCase();
  const { data, error } = useApi(id ? `/pair/${id}` : null, { refreshMs: 15_000 });
  const [chart, setChart] = useState("price");
  const [invert, setInvert] = useState(false);

  if (error) return <p className="py-20 text-center text-sm text-down">{error}</p>;
  if (!data) {
    return (
      <div className="flex justify-center py-20 text-muted">
        <Spinner size={22} />
      </div>
    );
  }
  const { pair, candles, nativeUsd } = data;
  const t0 = show(pair.token0);
  const t1 = show(pair.token1);
  const symbol = config.chain.native.symbol;
  const fmt = (value) => money(value, nativeUsd, symbol);
  const [base, quote] = invert ? [t1, t0] : [t0, t1];
  const price = invert ? pair.price1 : pair.price0;
  const swapLink = (from, to) => `/?in=${from.native ? NATIVE : from.address}&out=${to.native ? NATIVE : to.address}`;
  const addLink = `/add/?a=${t0.native ? NATIVE : t0.address}&b=${t1.native ? NATIVE : t1.address}&fee=${pair.fee}`;
  const protocolFee = data.protocolFee && (data.protocolFee.token0 || data.protocolFee.token1) ? data.protocolFee : null;

  return (
    <div className="space-y-6">
      <Link href="/explore/?tab=pools" className="text-sm text-muted hover:text-ink dark:hover:text-white">
        ← Pools
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <PairLogo a={t0} b={t1} size={36} />
          <div>
            <h1 className="text-2xl font-semibold">
              {t0.symbol}/{t1.symbol}
            </h1>
            <p className="text-xs text-muted">
              {feeLabel(pair.fee)} fee tier
              {protocolFee ? ` (1/${protocolFee.token0 || protocolFee.token1} to protocol)` : ""} ·{" "}
              {explorerAddress(pair.address) ? (
                <a href={explorerAddress(pair.address)} target="_blank" rel="noreferrer" className="hover:underline">
                  {short(pair.address)}
                </a>
              ) : (
                short(pair.address)
              )}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={addLink} className="btn-soft">
            Add liquidity
          </Link>
          <Link href={swapLink(t0, t1)} className="btn-primary">
            Swap
          </Link>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="TVL" value={fmt(pair.tvl)} />
        <Stat label="Volume 24h" value={fmt(pair.volume24h)} sub={`${pair.swaps24h} swaps`} />
        <Stat label="Volume 7d" value={fmt(pair.volume7d)} />
        <Stat label="Fees 24h" value={fmt(pair.fees24h)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <Tabs
              value={chart}
              onChange={setChart}
              tabs={[
                { id: "price", label: "Price" },
                { id: "volume", label: "Volume" },
                { id: "liquidity", label: "Liquidity" },
              ]}
            />
            {chart !== "volume" ? (
              <button type="button" className="btn-ghost !rounded-xl text-xs" onClick={() => setInvert((v) => !v)}>
                {quote.symbol} per {base.symbol} ⇄
              </button>
            ) : null}
          </div>
          {chart === "liquidity" ? (
            <LiquidityChart id={pair.address} pair={pair} invert={invert} />
          ) : chart === "price" ? (
            <Chart
              points={candles.map((c) => ({ x: c.time, y: c.price == null ? null : invert ? 1 / c.price : c.price }))}
              format={(v) => `${num(v)} ${quote.symbol}`}
              label={(x) => new Date(x * 1000).toLocaleString()}
            />
          ) : (
            <Chart kind="bar" points={candles.map((c) => ({ x: c.time, y: c.volume ?? 0 }))} format={fmt} label={(x) => new Date(x * 1000).toLocaleString()} />
          )}
        </div>
        <div className="card space-y-4 p-5">
          <p className="label">Tokens in pool</p>
          {[
            [t0, pair.reserve0Float],
            [t1, pair.reserve1Float],
          ].map(([token, reserve]) => (
            <div key={token.address} className="flex items-center justify-between">
              <span className="flex items-center gap-2 font-medium">
                <TokenLogo token={token} size={22} />
                {token.symbol}
              </span>
              <span className="tabular-nums">{num(reserve)}</span>
            </div>
          ))}
          <div className="well space-y-1 p-3 text-sm">
            <p>
              1 {base.symbol} = {num(price)} {quote.symbol}
            </p>
            <p className="text-muted">
              1 {quote.symbol} = {num(price ? 1 / price : null)} {base.symbol}
            </p>
          </div>
          <div className="flex gap-2">
            <Link href={swapLink(t0, t1)} className="btn-ghost flex-1 !rounded-2xl">
              Buy {t1.symbol}
            </Link>
            <Link href={swapLink(t1, t0)} className="btn-ghost flex-1 !rounded-2xl">
              Buy {t0.symbol}
            </Link>
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <p className="p-5 font-semibold">Transactions</p>
        <EventsTable events={data.events} />
      </div>
    </div>
  );
}

/** Active liquidity by price: each initialized band, with the current price marked. */
function LiquidityChart({ id, pair, invert }) {
  const { data } = useApi(`/pair/${id}/liquidity`, { refreshMs: 30_000 });
  if (!data) return <div className="flex h-[220px] items-center justify-center text-muted"><Spinner /></div>;
  const d0 = pair.token0.decimals;
  const d1 = pair.token1.decimals;
  const near = data.tick == null ? data.bands : data.bands.filter((band) => band.tickUpper > data.tick - 40_000 && band.tickLower < data.tick + 40_000);
  if (!near.length) return <p className="flex h-[220px] items-center justify-center text-sm text-muted">No liquidity yet</p>;
  const max = near.reduce((top, band) => (BigInt(band.liquidity) > top ? BigInt(band.liquidity) : top), 1n);
  const price = (tick) => {
    const p = tickToPrice(tick, d0, d1);
    return invert ? 1 / p : p;
  };
  const rows = invert ? [...near].reverse() : near;
  return (
    <div className="flex h-[220px] items-end gap-px">
      {rows.map((band) => {
        const active = data.tick != null && band.tickLower <= data.tick && data.tick < band.tickUpper;
        const height = Math.max(2, Number((BigInt(band.liquidity) * 1000n) / max) / 10);
        const [lo, hi] = invert ? [price(band.tickUpper), price(band.tickLower)] : [price(band.tickLower), price(band.tickUpper)];
        return (
          <div
            key={`${band.tickLower}:${band.tickUpper}`}
            title={`${num(lo)} – ${num(hi)}${active ? " (current price)" : ""}`}
            className={`min-w-[3px] flex-1 rounded-t ${active ? "bg-brand" : "bg-brand/35"}`}
            style={{ height: `${height}%` }}
          />
        );
      })}
    </div>
  );
}

export default function PairPage() {
  const { config } = useDex();
  if (!config) return <p className="py-20 text-center text-muted">Loading…</p>;
  return (
    <Suspense fallback={null}>
      <PairView />
    </Suspense>
  );
}
