"use client";

import Link from "next/link";
import { formatUnits } from "viem";
import { NATIVE, useDex } from "@/lib/dex";
import { ago, money, num, short } from "@/lib/format";
import { PairLogo, TokenLogo } from "./ui";
import { feeLabel } from "@/lib/v3";

export function useDisplayToken() {
  const { config, tokenByAddress } = useDex();
  return (token) => {
    if (!token) return token;
    if (token.address === config?.contracts.wnative) return tokenByAddress(NATIVE) || token;
    return tokenByAddress(token.address) || token;
  };
}

export function PairsTable({ pairs, nativeUsd, limit }) {
  const { config } = useDex();
  const show = useDisplayToken();
  const symbol = config?.chain.native.symbol;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Pool</th>
            <th className="text-right">TVL</th>
            <th className="text-right">Volume 24h</th>
            <th className="text-right">Volume 7d</th>
            <th className="text-right">Fees 24h</th>
          </tr>
        </thead>
        <tbody>
          {pairs.slice(0, limit).map((pair, i) => {
            const t0 = show(pair.token0);
            const t1 = show(pair.token1);
            return (
              <tr key={pair.address}>
                <td className="text-muted">{i + 1}</td>
                <td>
                  <Link href={`/pair/?id=${pair.address}`} className="flex items-center gap-3 font-medium">
                    <PairLogo a={t0} b={t1} size={22} />
                    {t0.symbol}/{t1.symbol}
                    <span className="chip">{feeLabel(pair.fee)}</span>
                  </Link>
                </td>
                <td className="text-right tabular-nums">{money(pair.tvl, nativeUsd, symbol)}</td>
                <td className="text-right tabular-nums">{money(pair.volume24h, nativeUsd, symbol)}</td>
                <td className="text-right tabular-nums">{money(pair.volume7d, nativeUsd, symbol)}</td>
                <td className="text-right tabular-nums">
                  {money(pair.fees24h, nativeUsd, symbol)}
                </td>
              </tr>
            );
          })}
          {!pairs.length ? (
            <tr>
              <td colSpan={6} className="py-10 text-center text-muted">
                No pools yet
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function TokensTable({ tokens, nativeUsd }) {
  const { config } = useDex();
  const show = useDisplayToken();
  const symbol = config?.chain.native.symbol;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Token</th>
            <th className="text-right">Price</th>
            <th className="text-right">24h</th>
            <th className="text-right">TVL</th>
            <th className="text-right">Volume 24h</th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((token, i) => {
            const shown = show(token);
            return (
              <tr key={token.address}>
                <td className="text-muted">{i + 1}</td>
                <td>
                  <Link href={`/?in=${NATIVE}&out=${token.address}`} className="flex items-center gap-3">
                    <TokenLogo token={shown} size={24} />
                    <span className="font-medium">{token.name}</span>
                    <span className="text-muted">{token.symbol}</span>
                  </Link>
                </td>
                <td className="text-right tabular-nums">
                  {token.priceUsd != null ? `$${num(token.priceUsd)}` : token.price != null ? `${num(token.price)} ${symbol}` : "–"}
                </td>
                <td className={`text-right tabular-nums ${token.priceChange24h > 0 ? "text-up" : token.priceChange24h < 0 ? "text-down" : "text-muted"}`}>
                  {token.priceChange24h == null ? "–" : `${token.priceChange24h > 0 ? "+" : ""}${(token.priceChange24h * 100).toFixed(2)}%`}
                </td>
                <td className="text-right tabular-nums">{money(token.tvl, nativeUsd, symbol)}</td>
                <td className="text-right tabular-nums">{money(token.volume24h, nativeUsd, symbol)}</td>
              </tr>
            );
          })}
          {!tokens.length ? (
            <tr>
              <td colSpan={6} className="py-10 text-center text-muted">
                No tokens yet
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function describe(event, show) {
  const t0 = show({ address: event.token0, symbol: event.symbol0 });
  const t1 = show({ address: event.token1, symbol: event.symbol1 });
  const a0 = BigInt(event.amount0In) + BigInt(event.amount0Out);
  const a1 = BigInt(event.amount1In) + BigInt(event.amount1Out);
  const fmt0 = `${num(formatUnits(a0, event.d0))} ${t0.symbol}`;
  const fmt1 = `${num(formatUnits(a1, event.d1))} ${t1.symbol}`;
  if (event.kind === "swap") {
    const sold0 = BigInt(event.amount0In) > 0n;
    return {
      title: `Swap ${sold0 ? t0.symbol : t1.symbol} for ${sold0 ? t1.symbol : t0.symbol}`,
      detail: sold0 ? `${num(formatUnits(BigInt(event.amount0In), event.d0))} ${t0.symbol} → ${num(formatUnits(BigInt(event.amount1Out), event.d1))} ${t1.symbol}` : `${num(formatUnits(BigInt(event.amount1In), event.d1))} ${t1.symbol} → ${num(formatUnits(BigInt(event.amount0Out), event.d0))} ${t0.symbol}`,
    };
  }
  const verb = { add: "Add", remove: "Remove", collect: "Collect" }[event.kind] || "Update";
  return { title: `${verb} ${t0.symbol} and ${t1.symbol}`, detail: `${fmt0} + ${fmt1}` };
}

export function EventsTable({ events }) {
  const { explorerTx, explorerAddress } = useDex();
  const show = useDisplayToken();
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Transaction</th>
            <th>Amounts</th>
            <th>Account</th>
            <th className="text-right">Time</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const { title, detail } = describe(event, show);
            const txUrl = explorerTx(event.tx);
            return (
              <tr key={`${event.block}-${event.logIndex}`}>
                <td>
                  {txUrl ? (
                    <a href={txUrl} target="_blank" rel="noreferrer" className="link font-medium">
                      {title}
                    </a>
                  ) : (
                    <span className="font-medium">{title}</span>
                  )}
                </td>
                <td className="tabular-nums">{detail}</td>
                <td className="mono text-muted">
                  {event.account ? (
                    explorerAddress(event.account) ? (
                      <a href={explorerAddress(event.account)} target="_blank" rel="noreferrer" className="hover:underline">
                        {short(event.account)}
                      </a>
                    ) : (
                      short(event.account)
                    )
                  ) : (
                    "–"
                  )}
                </td>
                <td className="text-right text-muted">{ago(event.time)}</td>
              </tr>
            );
          })}
          {!events.length ? (
            <tr>
              <td colSpan={4} className="py-10 text-center text-muted">
                No transactions yet
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
