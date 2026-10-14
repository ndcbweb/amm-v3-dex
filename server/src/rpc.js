import { ENV } from "./config.js";

export class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

let nextId = 1;

async function post(body, timeoutMs) {
  const response = await fetch(ENV.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RpcError(`RPC answered HTTP ${response.status} with non-JSON`, response.status);
  }
  return parsed;
}

export async function rpc(method, params = [], { timeoutMs = 20_000 } = {}) {
  const body = await post({ jsonrpc: "2.0", id: nextId++, method, params }, timeoutMs);
  if (body.error) throw new RpcError(body.error.message || "RPC error", body.error.code, body.error.data);
  return body.result;
}

/** JSON-RPC batch; falls back to sequential calls when the node rejects batches. Returns results in order. */
export async function rpcBatch(calls, { timeoutMs = 30_000, size = 40 } = {}) {
  const results = [];
  for (let i = 0; i < calls.length; i += size) {
    const slice = calls.slice(i, i + size);
    const base = nextId;
    nextId += slice.length;
    let answer;
    try {
      answer = await post(
        slice.map(([method, params], j) => ({ jsonrpc: "2.0", id: base + j, method, params })),
        timeoutMs
      );
    } catch (error) {
      if (error instanceof RpcError) answer = null;
      else throw error;
    }
    if (!Array.isArray(answer)) {
      for (const [method, params] of slice) results.push(await rpc(method, params, { timeoutMs }));
      continue;
    }
    const byId = new Map(answer.map((row) => [row.id, row]));
    slice.forEach((_, j) => {
      const row = byId.get(base + j);
      if (!row || row.error) throw new RpcError(row?.error?.message || "RPC batch item failed", row?.error?.code);
      results.push(row.result);
    });
  }
  return results;
}

/** Forwards a browser JSON-RPC payload (single or batch) as-is. */
export async function forward(payload) {
  return post(payload, 20_000);
}
