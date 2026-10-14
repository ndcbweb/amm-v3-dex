import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const env = process.env;
const address = (value) => {
  const text = String(value || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : "";
};
const clean = (value, fallback = "") => String(value ?? "").replace(/[\r\n]+/g, " ").trim() || fallback;

export const ENV = {
  rpcUrl: clean(env.RPC_URL, "http://127.0.0.1:8545"),
  /** RPC URL that wallets are told to use; the server itself always reads through RPC_URL. */
  publicRpcUrl: clean(env.PUBLIC_RPC_URL, clean(env.RPC_URL, "http://127.0.0.1:8545")),
  chainId: Number(env.CHAIN_ID) || 0,
  chainName: clean(env.CHAIN_NAME, "EVM chain"),
  nativeSymbol: clean(env.NATIVE_SYMBOL, "ETH"),
  nativeName: clean(env.NATIVE_NAME, clean(env.NATIVE_SYMBOL, "Ether")),
  explorerUrl: clean(env.EXPLORER_URL).replace(/\/+$/, ""),
  factory: address(env.FACTORY_ADDRESS),
  router: address(env.ROUTER_ADDRESS),
  positionManager: address(env.POSITION_MANAGER_ADDRESS),
  quoter: address(env.QUOTER_ADDRESS),
  wnative: address(env.WNATIVE_ADDRESS),
  startBlock: Math.max(0, Number(env.START_BLOCK) || 0),
  port: Number(env.PORT) || 4300,
  dataDir: resolve(clean(env.DATA_DIR, "./.data")),
  webDir: resolve(clean(env.WEB_DIR, "../web/out")),
  pollMs: Math.max(1000, Number(env.POLL_MS) || 4000),
  /** Blocks behind head the indexer stays, so short reorgs never reach the database. */
  confirmations: Math.max(0, Number(env.CONFIRMATIONS ?? 2)),
  logChunk: Math.max(10, Number(env.LOG_CHUNK) || 2000),
  adminSecret: clean(env.ADMIN_SECRET),
};

for (const key of ["factory", "router", "positionManager", "quoter", "wnative"]) {
  if (!ENV[key]) throw new Error(`${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}_ADDRESS must be a 0x address`);
}

mkdirSync(ENV.dataDir, { recursive: true });
