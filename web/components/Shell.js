"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { DexProvider, NATIVE, useBalances, useDex } from "@/lib/dex";
import { num, short } from "@/lib/format";
import { Toasts } from "./ui";

const NAV = [
  { href: "/", label: "Swap" },
  { href: "/pool/", label: "Pool" },
  { href: "/explore/", label: "Explore" },
];

function ThemeToggle() {
  const [dark, setDark] = useState(true);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("dex-theme", next ? "dark" : "light");
    } catch {
      /* private mode */
    }
  };
  return (
    <button type="button" onClick={toggle} className="btn-ghost h-10 w-10 !rounded-2xl !p-0" aria-label="Toggle theme">
      {dark ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}

function WalletButton() {
  const { account, connect, disconnect, wrongNetwork, switchNetwork, hasWallet, config, tokens } = useDex();
  const native = tokens.find((token) => token.address === NATIVE);
  const balances = useBalances(native ? [native] : []);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  if (!account) {
    return (
      <div className="relative">
        <button
          type="button"
          className="btn-primary h-10"
          onClick={() => connect().catch((err) => setError(hasWallet ? err.message : "Install MetaMask or another browser wallet"))}
        >
          Connect wallet
        </button>
        {error ? <p className="absolute right-0 top-full mt-2 w-64 rounded-xl bg-down px-3 py-2 text-xs text-white">{error}</p> : null}
      </div>
    );
  }
  if (wrongNetwork) {
    return (
      <button type="button" className="btn h-10 bg-down text-white" onClick={() => switchNetwork().catch((err) => setError(err.message))}>
        Switch to {config?.chain.name}
      </button>
    );
  }
  return (
    <div className="relative">
      <button type="button" className="btn-ghost h-10 !rounded-2xl" onClick={() => setOpen((v) => !v)}>
        {balances[NATIVE] != null ? (
          <span className="hidden text-muted sm:inline">
            {num(formatUnits(balances[NATIVE], 18))} {native?.symbol}
          </span>
        ) : null}
        <span className="h-2 w-2 rounded-full bg-up" />
        <span className="mono">{short(account)}</span>
      </button>
      {open ? (
        <div className="card absolute right-0 top-full z-40 mt-2 w-56 p-2">
          <button
            type="button"
            className="w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
            onClick={() => {
              navigator.clipboard?.writeText(account);
              setOpen(false);
            }}
          >
            Copy address
          </button>
          <Link href="/pool/" className="block rounded-xl px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/5" onClick={() => setOpen(false)}>
            My liquidity
          </Link>
          <button
            type="button"
            className="w-full rounded-xl px-3 py-2 text-left text-sm text-down hover:bg-black/5 dark:hover:bg-white/5"
            onClick={() => {
              disconnect();
              setOpen(false);
            }}
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Brand() {
  const { config } = useDex();
  const settings = config?.settings;
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2.5">
      {settings?.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={settings.logoUrl} alt="" className="h-9 w-9 rounded-xl object-contain" />
      ) : (
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand text-base font-bold text-brand-ink">{(settings?.name || "S").slice(0, 1)}</span>
      )}
      <span className="hidden text-base font-semibold sm:block">{settings?.name || "Swap"}</span>
    </Link>
  );
}

function Frame({ children }) {
  const pathname = usePathname();
  const { config, configError, explorerAddress } = useDex();
  const active = (href) => (href === "/" ? pathname === "/" : pathname.startsWith(href.replace(/\/$/, "")));
  const settings = config?.settings;
  const protocol = config?.protocol;

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/80 backdrop-blur dark:border-white/5 dark:bg-night/80">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
          <Brand />
          <nav className="flex flex-1 items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                  active(item.href) ? "bg-black/5 text-ink dark:bg-white/5 dark:text-white" : "text-muted hover:text-ink dark:hover:text-white"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <ThemeToggle />
          <WalletButton />
        </div>
      </header>
      {configError ? <div className="bg-down/15 px-4 py-2 text-center text-xs font-medium">Cannot reach the DEX server: {configError}</div> : null}
      {config && config.index.indexed < config.index.chainHead - 10 ? (
        <div className="bg-brand/15 px-4 py-2 text-center text-xs font-medium">
          Indexing pools: block {config.index.indexed.toLocaleString()} of {config.index.chainHead.toLocaleString()}. Charts fill in as it catches up.
        </div>
      ) : null}
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      <footer className="border-t border-black/5 py-8 text-xs text-muted dark:border-white/5">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4">
          <div>
            <p className="font-medium text-ink dark:text-white">{settings?.name}</p>
            {settings?.tagline ? <p className="mt-1">{settings.tagline}</p> : null}
            {protocol ? (
              <p className="mt-1">
                {config.chain.name} · Fee tiers {protocol.feeTiers.map((tier) => `${tier.fee / 10_000}%`).join(" · ")}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-4">
            {config
              ? ["factory", "router", "positionManager"].map((key) => {
                  const url = explorerAddress(config.contracts[key]);
                  return url ? (
                    <a key={key} href={url} target="_blank" rel="noreferrer" className="hover:underline">
                      {{ factory: "Factory", router: "Router", positionManager: "Positions" }[key]} {short(config.contracts[key])}
                    </a>
                  ) : (
                    <span key={key} className="mono">
                      {{ factory: "Factory", router: "Router", positionManager: "Positions" }[key]} {short(config.contracts[key])}
                    </span>
                  );
                })
              : null}
            {Object.entries(settings?.links || {})
              .filter(([, url]) => url)
              .map(([key, url]) => (
                <a key={key} href={url} target="_blank" rel="noreferrer" className="capitalize hover:underline">
                  {key}
                </a>
              ))}
          </div>
        </div>
      </footer>
      <Toasts />
    </>
  );
}

export default function Shell({ children }) {
  return (
    <DexProvider>
      <Frame>{children}</Frame>
    </DexProvider>
  );
}
