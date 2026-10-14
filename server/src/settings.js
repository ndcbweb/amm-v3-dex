import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENV } from "./config.js";

const FILE = join(ENV.dataDir, "settings.json");
export const BRANDING_DIR = join(ENV.dataDir, "branding");
mkdirSync(BRANDING_DIR, { recursive: true });

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const text = (value, max) => String(value ?? "").replace(/[\r\n<>]+/g, " ").trim().slice(0, max);
const url = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("/branding/")) return raw.slice(0, 200);
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString().slice(0, 500) : "";
  } catch {
    return "";
  }
};

/** Normalises settings pushed by the Console or an admin; unknown keys are dropped. */
export function sanitizeSettings(input = {}) {
  const tokens = [];
  const seen = new Set();
  for (const token of Array.isArray(input.tokens) ? input.tokens : []) {
    const address = String(token?.address || "").trim().toLowerCase();
    const decimals = Number(token?.decimals);
    if (!ADDRESS.test(address) || seen.has(address) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    seen.add(address);
    tokens.push({
      address,
      symbol: text(token.symbol, 16) || "TOKEN",
      name: text(token.name, 60) || text(token.symbol, 16) || "Token",
      decimals,
      logoURI: url(token.logoURI),
    });
    if (tokens.length >= 200) break;
  }
  const slippage = Number(input.defaultSlippageBps);
  const stable = String(input.stableToken || "").trim().toLowerCase();
  return {
    name: text(input.name, 40) || "Nadcab Swap",
    tagline: text(input.tagline, 120),
    brandColor: /^#[0-9a-fA-F]{6}$/.test(String(input.brandColor || "")) ? input.brandColor : "#1163fb",
    defaultTheme: input.defaultTheme === "light" ? "light" : "dark",
    logoUrl: url(input.logoUrl),
    tokens,
    stableToken: ADDRESS.test(stable) ? stable : "",
    defaultSlippageBps: Number.isInteger(slippage) && slippage >= 1 && slippage <= 5000 ? slippage : 50,
    links: {
      website: url(input.links?.website),
      twitter: url(input.links?.twitter),
      telegram: url(input.links?.telegram),
      docs: url(input.links?.docs),
    },
  };
}

let cached = null;

export function getSettings() {
  if (cached) return cached;
  let raw = {};
  if (existsSync(FILE)) {
    try {
      raw = JSON.parse(readFileSync(FILE, "utf8"));
    } catch {
      raw = {};
    }
  }
  cached = sanitizeSettings(raw);
  return cached;
}

export function saveSettings(input) {
  const next = sanitizeSettings({ ...getSettings(), ...input });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(next, null, 2));
  renameSync(`${FILE}.tmp`, FILE);
  cached = next;
  return next;
}
