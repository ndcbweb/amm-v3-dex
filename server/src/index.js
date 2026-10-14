import { timingSafeEqual } from "node:crypto";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { events, liquidityBands, overview, pairDetail, snapshot, tokens } from "./analytics.js";
import { factoryState, poolProtocolFee, tokenMeta } from "./chain.js";
import { ENV } from "./config.js";
import { startIndexer, state } from "./indexer.js";
import { forward, RpcError } from "./rpc.js";
import { BRANDING_DIR, getSettings, saveSettings } from "./settings.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const READ_METHODS = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
]);

const app = Fastify({ trustProxy: "127.0.0.1", logger: { level: "info" }, disableRequestLogging: true, bodyLimit: 3 * 1024 * 1024 });
app.setReplySerializer((payload) => JSON.stringify(payload, (key, value) => (typeof value === "bigint" ? value.toString() : value)));

app.addHook("onSend", async (request, reply, payload) => {
  reply.header(
    "content-security-policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
  );
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "strict-origin-when-cross-origin");
  return payload;
});

await app.register(rateLimit, {
  global: true,
  max: 600,
  timeWindow: "1 minute",
  allowList: (request) => request.url === "/api/health",
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof RpcError) return reply.code(502).send({ ok: false, error: error.message });
  if (error.name === "TimeoutError" || error.message === "fetch failed") {
    return reply.code(503).send({ ok: false, error: "The chain RPC is not reachable right now" });
  }
  reply.code(error.statusCode || 500).send({ ok: false, error: error.message || "Request failed" });
});

function authorized(request) {
  if (!ENV.adminSecret) return false;
  const given = Buffer.from(String(request.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(ENV.adminSecret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

app.addHook("onRequest", async (request, reply) => {
  if (request.url.startsWith("/api/admin/") && !authorized(request)) {
    return reply.code(401).send({ ok: false, error: "Unauthorized" });
  }
});

function memo(ms, load) {
  let value;
  let at = 0;
  let pending = null;
  return async () => {
    if (value !== undefined && Date.now() - at < ms) return value;
    pending ||= load()
      .then((result) => {
        value = result;
        at = Date.now();
        return result;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

const factory = memo(30_000, factoryState);

app.get("/api/health", async () => ({
  ok: state.chainHead >= 0 && !state.lastError,
  indexed: state.indexed,
  chainHead: state.chainHead,
  syncing: state.indexed < state.chainHead - ENV.confirmations - 1,
  error: state.lastError || undefined,
}));

app.get("/api/config", async () => {
  const settings = getSettings();
  return {
    chain: {
      id: ENV.chainId,
      name: ENV.chainName,
      rpcUrl: ENV.publicRpcUrl,
      explorerUrl: ENV.explorerUrl,
      native: { symbol: ENV.nativeSymbol, name: ENV.nativeName, decimals: 18 },
    },
    contracts: {
      factory: ENV.factory,
      router: ENV.router,
      positionManager: ENV.positionManager,
      quoter: ENV.quoter,
      wnative: ENV.wnative,
    },
    protocol: await factory().catch(() => null),
    settings,
    index: { indexed: state.indexed, chainHead: state.chainHead },
  };
});

app.get("/api/overview", async () => overview());

app.get("/api/pairs", async (request) => {
  const sort = ["tvl", "volume24h", "fees24h", "swaps", "createdTime"].includes(request.query.sort) ? request.query.sort : "tvl";
  const { pairs, nativeUsd } = snapshot();
  const sorted = [...pairs].sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1));
  return { pairs: sorted.slice(0, Math.min(500, Number(request.query.limit) || 200)), nativeUsd };
});

app.get("/api/pair/:address", async (request, reply) => {
  const address = String(request.params.address).toLowerCase();
  if (!ADDRESS.test(address)) return reply.code(400).send({ ok: false, error: "Not a pool address" });
  const detail = pairDetail(address);
  if (!detail) return reply.code(404).send({ ok: false, error: "Pool not found" });
  return {
    ...detail,
    protocolFee: await poolProtocolFee(address).catch(() => null),
    events: events({ pair: address, limit: 50 }),
  };
});

app.get("/api/pair/:address/liquidity", async (request, reply) => {
  const address = String(request.params.address).toLowerCase();
  if (!ADDRESS.test(address)) return reply.code(400).send({ ok: false, error: "Not a pool address" });
  const bands = liquidityBands(address);
  if (!bands) return reply.code(404).send({ ok: false, error: "Pool not found" });
  return bands;
});

app.get("/api/tokens", async () => tokens());

app.get("/api/token/:address", async (request, reply) => {
  const address = String(request.params.address).toLowerCase();
  if (!ADDRESS.test(address)) return reply.code(400).send({ ok: false, error: "Enter a token contract address" });
  const code = await forward({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] });
  if (!code.result || code.result === "0x") return reply.code(404).send({ ok: false, error: "No contract at this address" });
  return { token: await tokenMeta(address) };
});

app.get("/api/txs", async (request) => {
  const pair = ADDRESS.test(String(request.query.pair || "")) ? String(request.query.pair).toLowerCase() : null;
  const account = ADDRESS.test(String(request.query.account || "")) ? String(request.query.account).toLowerCase() : null;
  return { events: events({ pair, account, limit: Math.min(200, Number(request.query.limit) || 50) }) };
});

/** Read-only JSON-RPC for the web app, so browsers never need CORS access to the chain RPC. */
app.post("/api/rpc", { config: { rateLimit: { max: 1200, timeWindow: "1 minute" } } }, async (request, reply) => {
  const body = request.body;
  const items = Array.isArray(body) ? body : [body];
  if (!items.length || items.length > 50) return reply.code(400).send({ ok: false, error: "Send 1 to 50 calls" });
  for (const item of items) {
    if (!item || typeof item !== "object" || !READ_METHODS.has(item.method)) {
      return reply.code(403).send({ jsonrpc: "2.0", id: item?.id ?? null, error: { code: -32601, message: `${item?.method} is not allowed` } });
    }
  }
  return forward(body);
});

/* ---------- admin (the Console pushes branding and token lists here) ---------- */

app.get("/api/admin/settings", async () => ({ settings: getSettings() }));

app.put("/api/admin/settings", async (request) => ({ settings: saveSettings(request.body || {}) }));

const LOGO_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };

app.post("/api/admin/logo", async (request, reply) => {
  const match = /^data:([a-z+/]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(request.body?.dataUrl || ""));
  const ext = match && LOGO_TYPES[match[1]];
  if (!ext) return reply.code(400).send({ ok: false, error: "Upload a PNG, JPG, WEBP or SVG" });
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 1024 * 1024) return reply.code(400).send({ ok: false, error: "Logo must be under 1 MB" });
  if (ext === "svg" && /<script|on\w+=/i.test(bytes.toString("utf8"))) return reply.code(400).send({ ok: false, error: "SVG cannot contain scripts" });
  for (const file of readdirSync(BRANDING_DIR)) if (file.startsWith("logo.")) rmSync(join(BRANDING_DIR, file));
  writeFileSync(join(BRANDING_DIR, `logo.${ext}`), bytes);
  return { settings: saveSettings({ logoUrl: `/branding/logo.${ext}?v=${Date.now()}` }) };
});

app.get("/api/*", async (request, reply) => reply.code(404).send({ ok: false, error: "Not found" }));

await app.register(fastifyStatic, { root: BRANDING_DIR, prefix: "/branding/", decorateReply: false });
await app.register(fastifyStatic, { root: ENV.webDir, prefix: "/", redirect: true });
app.setNotFoundHandler((request, reply) => reply.code(404).sendFile("404.html"));

startIndexer(app.log);
await app.listen({ port: ENV.port, host: "0.0.0.0" });
app.log.info(`${getSettings().name} DEX on :${ENV.port}, chain ${ENV.chainId} via ${ENV.rpcUrl}`);
