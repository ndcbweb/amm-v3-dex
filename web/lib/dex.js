"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, parseAbi } from "viem";
import { api } from "./api";

export const NATIVE = "native";

export const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function totalSupply() view returns (uint256)",
]);
export const FACTORY = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
export const POOL = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
]);
export const WNATIVE = parseAbi(["function deposit() payable", "function withdraw(uint256 wad)"]);
export const ROUTER = parseAbi([
  "struct ExactInputParams { bytes path; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; }",
  "struct ExactOutputParams { bytes path; address recipient; uint256 deadline; uint256 amountOut; uint256 amountInMaximum; }",
  "function exactInput(ExactInputParams params) payable returns (uint256 amountOut)",
  "function exactOutput(ExactOutputParams params) payable returns (uint256 amountIn)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function refundETH() payable",
]);
export const QUOTER = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
  "function quoteExactOutput(bytes path, uint256 amountOut) returns (uint256 amountIn, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
export const POSITIONS = parseAbi([
  "struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }",
  "struct IncreaseLiquidityParams { uint256 tokenId; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }",
  "struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }",
  "struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function increaseLiquidity(IncreaseLiquidityParams params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity(DecreaseLiquidityParams params) payable returns (uint256 amount0, uint256 amount1)",
  "function collect(CollectParams params) payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function refundETH() payable",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function sweepToken(address token, uint256 amountMinimum, address recipient) payable",
]);

const DexContext = createContext(null);
export const useDex = () => useContext(DexContext);

const lower = (value) => String(value || "").toLowerCase();
const storageKey = (chainId, name) => `dex:${chainId}:${name}`;

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function contrastInk(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.6 ? "#111318" : "#ffffff";
}

export function DexProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [indexedTokens, setIndexedTokens] = useState([]);
  const [imported, setImported] = useState([]);
  const [account, setAccount] = useState("");
  const [walletChainId, setWalletChainId] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [prefs, setPrefs] = useState({ slippageBps: null, deadlineMin: 20 });
  const [refreshKey, setRefreshKey] = useState(0);
  const hasWallet = typeof window !== "undefined" && Boolean(window.ethereum);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await api("/config"));
      setConfigError("");
    } catch (error) {
      setConfigError(error.message);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    const timer = setInterval(loadConfig, 30_000);
    return () => clearInterval(timer);
  }, [loadConfig]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/tokens")
        .then((data) => alive && setIndexedTokens(data.tokens || []))
        .catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const chainId = config?.chain.id;

  useEffect(() => {
    if (!chainId) return;
    setImported(readJson(storageKey(chainId, "imported"), []));
    setPrefs((prev) => ({ ...prev, ...readJson(storageKey(chainId, "prefs"), {}) }));
  }, [chainId]);

  useEffect(() => {
    const settings = config?.settings;
    if (!settings) return;
    const root = document.documentElement;
    root.style.setProperty("--brand", settings.brandColor);
    root.style.setProperty("--brand-ink", contrastInk(settings.brandColor));
    document.title = `${settings.name} · Swap`;
    try {
      if (!localStorage.getItem("dex-theme")) root.classList.toggle("dark", settings.defaultTheme !== "light");
    } catch {
      /* private mode */
    }
  }, [config?.settings]);

  const chain = useMemo(() => {
    if (!config) return null;
    return {
      id: config.chain.id,
      name: config.chain.name,
      nativeCurrency: config.chain.native,
      rpcUrls: { default: { http: [config.chain.rpcUrl] } },
      blockExplorers: config.chain.explorerUrl ? { default: { name: "Explorer", url: config.chain.explorerUrl } } : undefined,
    };
  }, [config]);

  const publicClient = useMemo(() => {
    if (!chain || typeof window === "undefined") return null;
    return createPublicClient({ chain, transport: http(`${window.location.origin}/api/rpc`, { batch: { wait: 16, batchSize: 50 } }) });
  }, [chain]);

  /* ---------- wallet ---------- */

  useEffect(() => {
    if (!hasWallet) return undefined;
    const eth = window.ethereum;
    const onAccounts = (accounts) => setAccount(lower(accounts?.[0]));
    const onChain = (id) => setWalletChainId(Number(id));
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    eth.request({ method: "eth_chainId" }).then(onChain).catch(() => {});
    if (readJson("dex:connected", false)) eth.request({ method: "eth_accounts" }).then(onAccounts).catch(() => {});
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [hasWallet]);

  const connect = useCallback(async () => {
    if (!window.ethereum) throw new Error("Install MetaMask or another browser wallet to continue");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    setAccount(lower(accounts?.[0]));
    localStorage.setItem("dex:connected", "true");
    return lower(accounts?.[0]);
  }, []);

  const disconnect = useCallback(() => {
    setAccount("");
    localStorage.removeItem("dex:connected");
  }, []);

  const switchNetwork = useCallback(async () => {
    if (!window.ethereum || !config) return;
    const hexId = `0x${config.chain.id.toString(16)}`;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (error) {
      if (error?.code !== 4902 && !/unrecognized|not been added|unknown chain/i.test(error?.message || "")) throw error;
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: config.chain.name,
            nativeCurrency: config.chain.native,
            rpcUrls: [config.chain.rpcUrl],
            ...(config.chain.explorerUrl ? { blockExplorerUrls: [config.chain.explorerUrl] } : {}),
          },
        ],
      });
    }
    setWalletChainId(config.chain.id);
  }, [config]);

  const wrongNetwork = Boolean(account && walletChainId && chainId && walletChainId !== chainId);

  /* ---------- transactions ---------- */

  const pushToast = useCallback((toast) => {
    setToasts((rows) => [...rows.filter((row) => row.id !== toast.id), toast].slice(-4));
    if (toast.status !== "pending") setTimeout(() => setToasts((rows) => rows.filter((row) => row.id !== toast.id)), 9000);
  }, []);

  /** Runs a wallet write: connects, switches network, sends, waits for the receipt and reports progress. */
  const send = useCallback(
    async (label, write) => {
      const from = account || (await connect());
      if (Number(await window.ethereum.request({ method: "eth_chainId" })) !== chainId) await switchNetwork();
      const client = createWalletClient({ account: from, chain, transport: custom(window.ethereum) });
      // Pools write their price accumulators only when time has passed since the last trade, so an estimate taken
      // in the same second as that trade comes in low. A 25% margin keeps such transactions from running out of gas.
      const walletClient = {
        writeContract: async (request) => {
          if (request.gas) return client.writeContract(request);
          const gas = await publicClient.estimateContractGas(request);
          return client.writeContract({ ...request, gas: (gas * 125n) / 100n });
        },
      };
      const id = `${Date.now()}-${Math.random()}`;
      pushToast({ id, label, status: "wallet" });
      let hash;
      try {
        hash = await write(walletClient, from);
      } catch (error) {
        setToasts((rows) => rows.filter((row) => row.id !== id));
        throw new Error(error?.shortMessage || error?.details || error?.message || "Transaction cancelled");
      }
      pushToast({ id, label, status: "pending", hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 1500, timeout: 300_000 });
      pushToast({ id, label, status: receipt.status === "success" ? "success" : "failed", hash });
      setRefreshKey((key) => key + 1);
      if (receipt.status !== "success") throw new Error(`${label} failed on-chain`);
      return receipt;
    },
    [account, chain, chainId, connect, publicClient, pushToast, switchNetwork]
  );

  /* ---------- tokens ---------- */

  const tokens = useMemo(() => {
    if (!config) return [];
    const map = new Map();
    map.set(NATIVE, { address: NATIVE, native: true, ...config.chain.native, logoURI: "" });
    const add = (token, source) => {
      const address = lower(token.address);
      if (!/^0x[0-9a-f]{40}$/.test(address)) return;
      const prev = map.get(address);
      map.set(address, { ...prev, ...token, address, logoURI: token.logoURI || prev?.logoURI || "", source: prev?.source || source });
    };
    indexedTokens.forEach((token) => add(token, "pool"));
    imported.forEach((token) => add(token, "imported"));
    config.settings.tokens.forEach((token) => add(token, "list"));
    return [...map.values()];
  }, [config, indexedTokens, imported]);

  const importToken = useCallback(
    (token) => {
      const next = [...imported.filter((row) => lower(row.address) !== lower(token.address)), token].slice(-100);
      setImported(next);
      localStorage.setItem(storageKey(chainId, "imported"), JSON.stringify(next));
    },
    [chainId, imported]
  );

  const savePrefs = useCallback(
    (patch) => {
      setPrefs((prev) => {
        const next = { ...prev, ...patch };
        localStorage.setItem(storageKey(chainId, "prefs"), JSON.stringify(next));
        return next;
      });
    },
    [chainId]
  );

  const slippageBps = prefs.slippageBps ?? config?.settings.defaultSlippageBps ?? 50;
  const tokenByAddress = useCallback((address) => tokens.find((token) => token.address === lower(address)) || null, [tokens]);
  const routeAddress = useCallback((token) => (token?.native ? config?.contracts.wnative : token?.address), [config]);
  const explorerTx = (hash) => (config?.chain.explorerUrl ? `${config.chain.explorerUrl}/tx/${hash}` : "");
  const explorerAddress = (address) => (config?.chain.explorerUrl ? `${config.chain.explorerUrl}/address/${address}` : "");

  const value = {
    config,
    configError,
    chain,
    publicClient,
    hasWallet,
    account,
    walletChainId,
    wrongNetwork,
    connect,
    disconnect,
    switchNetwork,
    send,
    toasts,
    tokens,
    tokenByAddress,
    routeAddress,
    importToken,
    slippageBps,
    deadlineMin: prefs.deadlineMin,
    savePrefs,
    refreshKey,
    refresh: () => setRefreshKey((key) => key + 1),
    explorerTx,
    explorerAddress,
  };
  return <DexContext.Provider value={value}>{children}</DexContext.Provider>;
}

/** Balances of `tokens` for the connected account; native coin via eth_getBalance. */
export function useBalances(list) {
  const { publicClient, account, refreshKey } = useDex();
  const [balances, setBalances] = useState({});
  const key = list.map((token) => token?.address).filter(Boolean).join(",");
  const listRef = useRef(list);
  listRef.current = list;

  useEffect(() => {
    if (!publicClient || !account) {
      setBalances({});
      return undefined;
    }
    let alive = true;
    const load = async () => {
      const targets = listRef.current.filter(Boolean);
      const results = await Promise.all(
        targets.map((token) =>
          (token.native
            ? publicClient.getBalance({ address: account })
            : publicClient.readContract({ address: token.address, abi: ERC20, functionName: "balanceOf", args: [account] })
          ).catch(() => null)
        )
      );
      if (!alive) return;
      const next = {};
      targets.forEach((token, i) => {
        if (results[i] != null) next[token.address] = results[i];
      });
      setBalances(next);
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [publicClient, account, key, refreshKey]);

  return balances;
}

export function deadline(minutes) {
  return BigInt(Math.floor(Date.now() / 1000) + Math.max(1, Number(minutes) || 20) * 60);
}

export function withSlippageDown(amount, bps) {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

export function withSlippageUp(amount, bps) {
  return (amount * BigInt(10_000 + bps)) / 10_000n;
}
