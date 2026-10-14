"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { EventsTable, PairsTable, TokensTable } from "@/components/tables";
import { Chart, Stat, Tabs } from "@/components/ui";
import { useApi } from "@/lib/api";
import { useDex } from "@/lib/dex";
import { money, pct } from "@/lib/format";

function Explore() {
  const { config } = useDex();
  const params = useSearchParams();
  const [tab, setTab] = useState(["tokens", "pools", "txs"].includes(params.get("tab")) ? params.get("tab") : "tokens");
  const { data: overview } = useApi("/overview", { refreshMs: 20_000 });
  const { data: tokens } = useApi("/tokens", { refreshMs: 30_000 });
  const { data: pairs } = useApi("/pairs?sort=tvl", { refreshMs: 30_000 });
  const { data: txs } = useApi("/txs?limit=50", { refreshMs: 10_000 });
  const symbol = config?.chain.native.symbol || "";
  const usd = overview?.nativeUsd;
  const fmt = (value) => money(value, usd, symbol);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Explore</h1>
        <p className="mt-1 text-sm text-muted">
          Live liquidity, volume and trades on {config?.settings.name}
          {usd ? "" : ` · values in ${symbol}`}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total value locked" value={overview ? fmt(overview.tvl) : "–"} />
        <Stat
          label="Volume 24h"
          value={overview ? fmt(overview.volume24h) : "–"}
          sub={overview?.volumeChange != null ? `${pct(overview.volumeChange)} vs previous day` : "Last 24 hours"}
          tone={overview?.volumeChange > 0 ? "up" : overview?.volumeChange < 0 ? "down" : ""}
        />
        <Stat label="Swaps 24h" value={overview ? overview.swaps24h.toLocaleString() : "–"} sub={overview ? `${fmt(overview.volume7d)} in 7 days` : ""} />
        <Stat label="Pools" value={overview ? overview.pairCount.toLocaleString() : "–"} sub={overview ? `${overview.tokenCount} tokens` : ""} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-5">
          <p className="label mb-2">TVL</p>
          {overview ? <Chart points={overview.series.map((p) => ({ x: p.day, y: p.tvl }))} format={fmt} /> : <div className="h-[260px]" />}
        </div>
        <div className="card p-5">
          <p className="label mb-2">Volume</p>
          {overview ? <Chart kind="bar" points={overview.series.map((p) => ({ x: p.day, y: p.volume }))} format={fmt} /> : <div className="h-[260px]" />}
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="p-4">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "tokens", label: "Tokens" },
              { id: "pools", label: "Pools" },
              { id: "txs", label: "Transactions" },
            ]}
          />
        </div>
        {tab === "tokens" ? <TokensTable tokens={tokens?.tokens || []} nativeUsd={tokens?.nativeUsd} /> : null}
        {tab === "pools" ? <PairsTable pairs={pairs?.pairs || []} nativeUsd={pairs?.nativeUsd} /> : null}
        {tab === "txs" ? <EventsTable events={txs?.events || []} /> : null}
      </div>
    </div>
  );
}

export default function ExplorePage() {
  return (
    <Suspense fallback={null}>
      <Explore />
    </Suspense>
  );
}
