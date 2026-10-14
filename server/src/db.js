import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ENV } from "./config.js";

export const db = new DatabaseSync(join(ENV.dataDir, "index.db"));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  decimals INTEGER NOT NULL
);

-- balance0/1 are the pool's token holdings, kept exact from Mint, Swap, Collect, Flash and CollectProtocol.
CREATE TABLE IF NOT EXISTS pools (
  address TEXT PRIMARY KEY,
  idx INTEGER NOT NULL,
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  created_block INTEGER NOT NULL,
  created_time INTEGER NOT NULL,
  sqrt_price TEXT NOT NULL DEFAULT '0',
  tick INTEGER,
  liquidity TEXT NOT NULL DEFAULT '0',
  balance0 TEXT NOT NULL DEFAULT '0',
  balance1 TEXT NOT NULL DEFAULT '0',
  swaps INTEGER NOT NULL DEFAULT 0
);

-- Net liquidity change when the price crosses each initialized tick.
CREATE TABLE IF NOT EXISTS ticks (
  pool TEXT NOT NULL,
  tick INTEGER NOT NULL,
  liquidity_net TEXT NOT NULL,
  PRIMARY KEY (pool, tick)
);

-- Swaps, adds, removes and fee collects. Raw amounts are exact strings; volume* are decimal-adjusted.
CREATE TABLE IF NOT EXISTS events (
  block INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  pair TEXT NOT NULL,
  kind TEXT NOT NULL,
  time INTEGER NOT NULL,
  tx TEXT NOT NULL,
  account TEXT,
  amount0_in TEXT NOT NULL DEFAULT '0',
  amount1_in TEXT NOT NULL DEFAULT '0',
  amount0_out TEXT NOT NULL DEFAULT '0',
  amount1_out TEXT NOT NULL DEFAULT '0',
  volume0 REAL NOT NULL DEFAULT 0,
  volume1 REAL NOT NULL DEFAULT 0,
  tick_lower INTEGER,
  tick_upper INTEGER,
  PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS events_pair ON events (pair, block DESC);
CREATE INDEX IF NOT EXISTS events_time ON events (time);
CREATE INDEX IF NOT EXISTS events_account ON events (account, block DESC);

-- Hourly candles per pool: closing balances and price (token1 per token0), swap volume; all decimal-adjusted.
CREATE TABLE IF NOT EXISTS pool_hours (
  pool TEXT NOT NULL,
  hour INTEGER NOT NULL,
  balance0 REAL NOT NULL,
  balance1 REAL NOT NULL,
  price REAL,
  volume0 REAL NOT NULL DEFAULT 0,
  volume1 REAL NOT NULL DEFAULT 0,
  swaps INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pool, hour)
);
`);

const statements = new Map();
export function q(sql) {
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

export function getMeta(key, fallback = null) {
  return q("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? fallback;
}

export function setMeta(key, value) {
  q("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

export function transaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
