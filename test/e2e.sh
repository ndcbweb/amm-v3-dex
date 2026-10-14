#!/usr/bin/env bash
# Deploys the DEX on anvil, trades on it, then runs the bundled server and checks the API and site.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_PORT=18545
APP_PORT=14300
WORK=$(mktemp -d)
cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

anvil --port "$RPC_PORT" --silent &
ANVIL_PID=$!
for _ in $(seq 1 30); do
  curl -sf -X POST "http://127.0.0.1:$RPC_PORT" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' >/dev/null && break
  sleep 1
done

RPC_URL="http://127.0.0.1:$RPC_PORT" node server/test/seed.mjs > "$WORK/seed.json"
cat "$WORK/seed.json"
seed() { node -e "const s=require('$WORK/seed.json'); console.log($1)"; }

mkdir -p "$WORK/app" && tar -xzf dist/dex.tar.gz -C "$WORK/app"
(
  cd "$WORK/app/dex/server"
  RPC_URL="http://127.0.0.1:$RPC_PORT" CHAIN_ID=31337 CHAIN_NAME="Anvil" NATIVE_SYMBOL=ETH \
    FACTORY_ADDRESS=$(seed s.factory) ROUTER_ADDRESS=$(seed s.router) WNATIVE_ADDRESS=$(seed s.wnative) \
    POSITION_MANAGER_ADDRESS=$(seed s.positionManager) QUOTER_ADDRESS=$(seed s.quoter) \
    START_BLOCK=$(seed s.startBlock) PORT=$APP_PORT DATA_DIR="$WORK/data" WEB_DIR=../web/out ADMIN_SECRET=e2e-secret \
    CONFIRMATIONS=0 POLL_MS=1000 \
    exec node --experimental-sqlite --no-warnings src/index.js
) > "$WORK/server.log" 2>&1 &
SERVER_PID=$!

BASE="http://127.0.0.1:$APP_PORT"
fail() { echo "FAIL: $*"; cat "$WORK/server.log"; exit 1; }

for _ in $(seq 1 60); do
  SWAPS=$(curl -sf "$BASE/api/overview" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).swaps24h)}catch{console.log(0)}})" || true)
  [ "${SWAPS:-0}" -gt 0 ] && break
  sleep 1
done
[ "${SWAPS:-0}" -gt 0 ] || fail "indexer never saw swaps"

json() { curl -sf "$BASE$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($2)})"; }

[ "$(json /api/pairs 'j.pairs.length')" = "3" ] || fail "expected 3 pools"
[ "$(json /api/config 'j.protocol.feeTiers.map(t => t.fee).join(",")')" = "100,500,3000,10000" ] || fail "fee tiers not read from the factory"
[ "$(json /api/pairs 'j.pairs.every(p => BigInt(p.liquidity) > 0n && p.price0 > 0)')" = "true" ] || fail "pools have no price or liquidity"
[ "$(json /api/tokens 'j.tokens.every(t => t.price > 0)')" = "true" ] || fail "tokens are not priced"
PAIR=$(json /api/pairs 'j.pairs[0].address')
[ "$(json "/api/pair/$PAIR" 'j.events.length > 0')" = "true" ] || fail "pool has no events"
[ "$(json "/api/pair/$PAIR/liquidity" 'j.bands.length > 0')" = "true" ] || fail "pool has no liquidity bands"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/settings")
[ "$CODE" = "401" ] || fail "admin API is open ($CODE)"
curl -sf -X PUT "$BASE/api/admin/settings" -H 'authorization: Bearer e2e-secret' -H 'content-type: application/json' \
  -d '{"name":"E2E Swap","brandColor":"#ff3366"}' >/dev/null || fail "admin settings update"
[ "$(json /api/config 'j.settings.name')" = "E2E Swap" ] || fail "settings not saved"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/rpc" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}')
[ "$CODE" = "403" ] || fail "RPC proxy allowed a write ($CODE)"
[ "$(curl -sf -X POST "$BASE/api/rpc" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).result))")" = "0x7a69" ] || fail "RPC proxy read"

for path in / /pool/ /add/ /position/ /explore/ /pair/; do
  PAGE=$(curl -sf "$BASE$path") || fail "page $path"
  [[ "$PAGE" == *"<html"* ]] || fail "page $path is not HTML"
done
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/no-such-page")
[ "$CODE" = "404" ] || fail "404 page ($CODE)"

echo "E2E OK"
