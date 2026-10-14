"use client";

import Link from "next/link";
import { formatUnits } from "viem";
import { useDisplayToken } from "@/components/tables";
import { PairLogo, Spinner } from "@/components/ui";
import { useApi } from "@/lib/api";
import { NATIVE, useDex } from "@/lib/dex";
import { money, num } from "@/lib/format";
import { usePositions } from "@/lib/positions";
import { RangeBadge, rangeText } from "@/components/position";
import { feeLabel } from "@/lib/v3";

export default function PoolPage() {
  const { config } = useDex();
  if (!config) return <p className="py-20 text-center text-muted">Loading…</p>;
  return <Pool />;
}

function Pool() {
  const { account, connect, config } = useDex();
  const show = useDisplayToken();
  const routeId = (token) => (token.native ? NATIVE : token.address);
  const { data } = useApi("/pairs?sort=tvl", { refreshMs: 30_000 });
  const positions = usePositions();
  const symbol = config?.chain.native.symbol;
  const [openRows, closedRows] = [positions.rows.filter((row) => row.liquidity > 0n), positions.rows.filter((row) => row.liquidity === 0n)];

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Liquidity</h1>
          <p className="mt-1 text-sm text-muted">
            Provide liquidity in a price range you choose. Tighter ranges earn more fees per token while the price stays inside them.
          </p>
        </div>
        <Link href="/add/" className="btn-primary">
          + New position
        </Link>
      </div>

      <section className="card p-5">
        <h2 className="mb-4 font-semibold">Your positions</h2>
        {!account ? (
          <div className="py-8 text-center">
            <p className="text-sm text-muted">Connect a wallet to see your positions.</p>
            <button type="button" className="btn-primary mt-4" onClick={() => connect().catch(() => {})}>
              Connect wallet
            </button>
          </div>
        ) : positions.status === "loading" ? (
          <div className="flex justify-center py-8 text-muted">
            <Spinner />
          </div>
        ) : !positions.rows.length ? (
          <p className="py-8 text-center text-sm text-muted">You have no liquidity positions yet.</p>
        ) : (
          <div className="space-y-3">
            {[...openRows, ...closedRows].map((position) => {
              const t0 = show(position.token0);
              const t1 = show(position.token1);
              return (
                <Link key={position.tokenId.toString()} href={`/position/?id=${position.tokenId}`} className="well block p-4 transition hover:brightness-95">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <PairLogo a={t0} b={t1} />
                      <span className="font-semibold">
                        {t0.symbol}/{t1.symbol}
                      </span>
                      <span className="chip">{feeLabel(position.fee)}</span>
                    </div>
                    <RangeBadge position={position} />
                  </div>
                  <p className="mt-3 text-sm text-muted">{rangeText(position, show)}</p>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    <Info label={t0.symbol} value={num(formatUnits(position.amount0, position.token0.decimals))} />
                    <Info label={t1.symbol} value={num(formatUnits(position.amount1, position.token1.decimals))} />
                    <Info label={`Fees ${t0.symbol}`} value={num(formatUnits(position.fees0, position.token0.decimals))} />
                    <Info label={`Fees ${t1.symbol}`} value={num(formatUnits(position.fees1, position.token1.decimals))} />
                  </div>
                  <p className="mt-3 text-xs text-muted">Position #{position.tokenId.toString()}</p>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between p-5">
          <h2 className="font-semibold">Top pools</h2>
          <Link href="/explore/?tab=pools" className="link text-sm">
            View all
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Pool</th>
                <th className="text-right">TVL</th>
                <th className="text-right">Volume 24h</th>
                <th className="text-right">Fees 24h</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.pairs || []).slice(0, 8).map((pair) => {
                const t0 = show(pair.token0);
                const t1 = show(pair.token1);
                return (
                  <tr key={pair.address}>
                    <td>
                      <Link href={`/pair/?id=${pair.address}`} className="flex items-center gap-3 font-medium">
                        <PairLogo a={t0} b={t1} size={22} />
                        {t0.symbol}/{t1.symbol}
                        <span className="chip">{feeLabel(pair.fee)}</span>
                      </Link>
                    </td>
                    <td className="text-right tabular-nums">{money(pair.tvl, data.nativeUsd, symbol)}</td>
                    <td className="text-right tabular-nums">{money(pair.volume24h, data.nativeUsd, symbol)}</td>
                    <td className="text-right tabular-nums">{money(pair.fees24h, data.nativeUsd, symbol)}</td>
                    <td className="text-right">
                      <Link href={`/add/?a=${routeId(t0)}&b=${routeId(t1)}&fee=${pair.fee}`} className="link text-sm">
                        Add
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {data && !data.pairs.length ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-muted">
                    No pools yet. Be the first to add liquidity.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div>
      <p className="label">{label}</p>
      <p className="mt-1 font-medium tabular-nums">{value}</p>
    </div>
  );
}
