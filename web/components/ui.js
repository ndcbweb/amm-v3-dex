"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { api } from "@/lib/api";
import { useBalances, useDex } from "@/lib/dex";
import { compact, num, short } from "@/lib/format";

const PALETTE = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

export function TokenLogo({ token, size = 28 }) {
  const [broken, setBroken] = useState(false);
  const symbol = token?.symbol || "?";
  const color = PALETTE[[...symbol].reduce((sum, c) => sum + c.charCodeAt(0), 0) % PALETTE.length];
  if (token?.logoURI && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={token.logoURI} alt="" width={size} height={size} onError={() => setBroken(true)} className="shrink-0 rounded-full bg-white object-cover" style={{ width: size, height: size }} />
    );
  }
  return (
    <span className="grid shrink-0 place-items-center rounded-full font-bold text-white" style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}>
      {symbol.slice(0, symbol.length > 3 ? 1 : 2)}
    </span>
  );
}

export function PairLogo({ a, b, size = 26 }) {
  return (
    <span className="flex items-center">
      <TokenLogo token={a} size={size} />
      <span className="-ml-2 rounded-full ring-2 ring-white dark:ring-panel">
        <TokenLogo token={b} size={size} />
      </span>
    </span>
  );
}

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div className="card w-full max-w-md p-5" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button type="button" className="btn-ghost h-8 w-8 !p-0" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function TokenSelect({ onSelect, onClose, exclude }) {
  const { tokens, importToken, config } = useDex();
  const balances = useBalances(tokens);
  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState({ status: "idle", token: null, error: "" });
  const trimmed = query.trim().toLowerCase();

  const list = useMemo(() => {
    const matches = tokens.filter(
      (token) => !trimmed || token.symbol.toLowerCase().includes(trimmed) || token.name.toLowerCase().includes(trimmed) || token.address === trimmed
    );
    return matches.sort((a, b) => {
      const ba = balances[a.address] ?? 0n;
      const bb = balances[b.address] ?? 0n;
      if (a.native !== b.native) return a.native ? -1 : 1;
      if ((ba > 0n) !== (bb > 0n)) return ba > 0n ? -1 : 1;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [tokens, trimmed, balances]);

  useEffect(() => {
    if (!/^0x[0-9a-f]{40}$/.test(trimmed) || tokens.some((token) => token.address === trimmed)) {
      setLookup({ status: "idle", token: null, error: "" });
      return undefined;
    }
    let alive = true;
    setLookup({ status: "loading", token: null, error: "" });
    api(`/token/${trimmed}`)
      .then((data) => alive && setLookup({ status: "found", token: data.token, error: "" }))
      .catch((error) => alive && setLookup({ status: "error", token: null, error: error.message }));
    return () => {
      alive = false;
    };
  }, [trimmed, tokens]);

  const bases = [tokens.find((t) => t.native), ...config.settings.tokens.slice(0, 5).map((t) => tokens.find((x) => x.address === t.address))].filter(Boolean);

  return (
    <Modal title="Select a token" onClose={onClose}>
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search name, symbol or paste address"
        className="well h-11 w-full px-4 text-sm outline-none placeholder:text-muted focus:ring-2 focus:ring-brand/40"
        spellCheck={false}
      />
      {bases.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {bases.map((token) => (
            <button
              key={token.address}
              type="button"
              disabled={token.address === exclude}
              onClick={() => onSelect(token)}
              className="flex items-center gap-1.5 rounded-xl border border-black/10 px-2.5 py-1.5 text-sm font-medium hover:bg-black/5 disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
            >
              <TokenLogo token={token} size={18} />
              {token.symbol}
            </button>
          ))}
        </div>
      ) : null}
      <div className="-mx-2 mt-3 max-h-[52vh] overflow-y-auto">
        {lookup.status === "found" ? (
          <div className="mx-2 mb-2 rounded-2xl border border-brand/30 bg-brand/5 p-3">
            <div className="flex items-center gap-3">
              <TokenLogo token={lookup.token} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{lookup.token.symbol}</p>
                <p className="truncate text-xs text-muted">
                  {lookup.token.name} · {short(lookup.token.address)}
                </p>
              </div>
              <button
                type="button"
                className="btn-primary !rounded-xl !px-3 !py-1.5"
                onClick={() => {
                  importToken(lookup.token);
                  onSelect({ ...lookup.token, source: "imported" });
                }}
              >
                Import
              </button>
            </div>
            <p className="mt-2 text-xs text-muted">Anyone can create a token with any name. Check the address before trading.</p>
          </div>
        ) : null}
        {lookup.status === "loading" ? <p className="px-4 py-3 text-sm text-muted">Looking up token…</p> : null}
        {lookup.status === "error" ? <p className="px-4 py-3 text-sm text-down">{lookup.error}</p> : null}
        {list.map((token) => {
          const balance = balances[token.address];
          return (
            <button
              key={token.address}
              type="button"
              disabled={token.address === exclude}
              onClick={() => onSelect(token)}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5"
            >
              <TokenLogo token={token} size={32} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {token.symbol}
                  {token.source === "imported" ? <span className="chip ml-2 !text-[10px]">Imported</span> : null}
                </p>
                <p className="truncate text-xs text-muted">{token.name}</p>
              </div>
              {balance != null && balance > 0n ? <span className="text-sm tabular-nums">{num(formatUnits(balance, token.decimals))}</span> : null}
            </button>
          );
        })}
        {!list.length && lookup.status === "idle" ? <p className="px-4 py-6 text-center text-sm text-muted">No tokens found. Paste a contract address to import one.</p> : null}
      </div>
    </Modal>
  );
}

export function TokenButton({ token, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-10 shrink-0 items-center gap-2 rounded-full pl-1.5 pr-3 text-[15px] font-semibold transition ${
        token ? "bg-white shadow-sm hover:bg-black/5 dark:bg-field dark:hover:bg-white/10" : "bg-brand pl-4 text-brand-ink"
      }`}
    >
      {token ? <TokenLogo token={token} size={28} /> : null}
      {token ? token.symbol : "Select token"}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}

export function AmountField({ label, token, value, onChange, onToken, balance, usd, readOnly = false, onMax }) {
  return (
    <div className="well p-4">
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        {balance != null && token ? (
          <span className="flex items-center gap-2 text-xs text-muted">
            Balance: {num(formatUnits(balance, token.decimals))}
            {onMax && balance > 0n ? (
              <button type="button" className="font-semibold text-brand" onClick={onMax}>
                Max
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <input
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange?.(event.target.value)}
          inputMode="decimal"
          placeholder="0"
          className="min-w-0 flex-1 bg-transparent text-3xl font-medium tabular-nums outline-none placeholder:text-muted/60"
        />
        <TokenButton token={token} onClick={onToken} />
      </div>
      {usd != null ? <p className="mt-1 text-xs text-muted">≈ ${compact(usd)}</p> : <p className="mt-1 h-4" />}
    </div>
  );
}

export function SlippageSettings({ onClose }) {
  const { slippageBps, deadlineMin, savePrefs } = useDex();
  const [custom, setCustom] = useState("");
  return (
    <Modal title="Transaction settings" onClose={onClose}>
      <p className="label mb-2">Max slippage</p>
      <div className="flex gap-2">
        {[10, 50, 100].map((bps) => (
          <button
            key={bps}
            type="button"
            className={`btn !rounded-xl !py-2 ${slippageBps === bps ? "bg-brand text-brand-ink" : "bg-black/5 dark:bg-white/5"}`}
            onClick={() => savePrefs({ slippageBps: bps })}
          >
            {bps / 100}%
          </button>
        ))}
        <input
          value={custom}
          onChange={(event) => {
            setCustom(event.target.value);
            const bps = Math.round(Number(event.target.value) * 100);
            if (bps >= 1 && bps <= 5000) savePrefs({ slippageBps: bps });
          }}
          placeholder={`${slippageBps / 100}%`}
          className="well h-10 w-24 px-3 text-sm outline-none"
          inputMode="decimal"
        />
      </div>
      {slippageBps > 500 ? <p className="mt-2 text-xs text-down">High slippage: your trade may be front-run.</p> : null}
      <p className="label mb-2 mt-5">Transaction deadline</p>
      <div className="flex items-center gap-2">
        <input
          value={deadlineMin}
          onChange={(event) => savePrefs({ deadlineMin: Math.max(1, Math.min(180, Number(event.target.value) || 20)) })}
          className="well h-10 w-24 px-3 text-sm outline-none"
          inputMode="numeric"
        />
        <span className="text-sm text-muted">minutes</span>
      </div>
    </Modal>
  );
}

export function Toasts() {
  const { toasts, explorerTx } = useDex();
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <div key={toast.id} className="card flex items-start gap-3 p-4 text-sm">
          <span
            className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
              toast.status === "success" ? "bg-up" : toast.status === "failed" ? "bg-down" : "animate-pulse bg-brand"
            }`}
          />
          <div className="min-w-0">
            <p className="font-semibold">{toast.label}</p>
            <p className="text-xs text-muted">
              {toast.status === "wallet" ? "Confirm in your wallet" : toast.status === "pending" ? "Waiting for confirmation…" : toast.status === "success" ? "Confirmed" : "Failed"}
            </p>
            {toast.hash && explorerTx(toast.hash) ? (
              <a href={explorerTx(toast.hash)} target="_blank" rel="noreferrer" className="link text-xs">
                View transaction ↗
              </a>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub, tone }) {
  return (
    <div className="card p-5">
      <p className="label">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      {sub ? <p className={`mt-1 text-xs ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-muted"}`}>{sub}</p> : null}
    </div>
  );
}

/** Area (line) or bar chart over [{x, y}] with a hover readout. */
export function Chart({ points, kind = "area", height = 220, format = compact, label = (x) => new Date(x * 1000).toLocaleDateString() }) {
  const [hover, setHover] = useState(null);
  const data = points.filter((p) => p.y != null && Number.isFinite(p.y));
  if (data.length < 2) return <div className="grid place-items-center text-sm text-muted" style={{ height }}>Not enough data yet</div>;
  const width = 600;
  const max = Math.max(...data.map((p) => p.y)) || 1;
  const min = kind === "bar" ? 0 : Math.min(...data.map((p) => p.y));
  const span = max - min || max || 1;
  const x = (i) => (i / (data.length - 1)) * width;
  const y = (v) => height - 6 - ((v - min) / span) * (height - 24);
  const line = data.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
  const shown = hover ?? data.length - 1;
  const barWidth = Math.max(2, width / data.length - 3);

  return (
    <div>
      <p className="text-2xl font-semibold tabular-nums">{format(data[shown].y)}</p>
      <p className="mb-3 text-xs text-muted">{label(data[shown].x)}</p>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(data.length - 1, Math.round(((event.clientX - box.left) / box.width) * (data.length - 1)))));
        }}
      >
        <defs>
          <linearGradient id={`fill-${kind}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {kind === "bar" ? (
          data.map((p, i) => (
            <rect
              key={p.x}
              x={x(i) - barWidth / 2 + (i === 0 ? barWidth / 2 : i === data.length - 1 ? -barWidth / 2 : 0)}
              y={y(p.y)}
              width={barWidth}
              height={Math.max(0, height - 6 - y(p.y))}
              rx="2"
              fill="var(--brand)"
              opacity={hover == null || hover === i ? 0.9 : 0.4}
            />
          ))
        ) : (
          <>
            <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#fill-${kind})`} />
            <path d={line} fill="none" stroke="var(--brand)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            {hover != null ? <line x1={x(hover)} x2={x(hover)} y1="0" y2={height} stroke="currentColor" strokeOpacity="0.2" vectorEffect="non-scaling-stroke" /> : null}
          </>
        )}
      </svg>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="inline-flex gap-1 rounded-2xl bg-black/5 p-1 dark:bg-white/5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`rounded-xl px-3.5 py-1.5 text-sm font-medium transition ${value === tab.id ? "bg-white shadow-sm dark:bg-field" : "text-muted hover:text-ink dark:hover:text-white"}`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
