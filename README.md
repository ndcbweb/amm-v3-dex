# Nadcab AMM v3 DEX

A concentrated-liquidity exchange (Uniswap V3) for any EVM chain, packaged so the Nadcab Console can host it.

- `contracts/`: the Uniswap V3 core and periphery contracts, unmodified (Solidity 0.7.6, 800 optimizer runs, no metadata hash), plus a wrapped native coin and a plain-JSON position descriptor. The pool bytecode reproduces Uniswap's canonical init code hash `0xe34f…8b54`; `scripts/init-code-hash.mjs` checks it in CI. Tests are Solidity 0.8 and deploy the 0.7.6 artifacts.
- `server/`: Fastify API that indexes pools, swaps, liquidity and fee collects into SQLite (exact pool balances, price from `sqrtPriceX96`, per-tick liquidity), prices tokens through the wrapped native coin, proxies read-only RPC for the site and serves the web app.
- `web/`: Next.js static site with swap (QuoterV2 across fee tiers and two-hop routes, exact in/out, native coin wrap/unwrap), positions (new range position, create and initialize pools, increase, remove, collect fees), explore and per-pool charts including liquidity by price.
- `artifacts/nadcab-v3.json`: ABIs and bytecode the Console uses to deploy the contracts from the owner's wallet.

## Licenses

Uniswap V3 core was released under BUSL-1.1 with a change date of 2023-04-01, after which it is GPL-2.0-or-later; the periphery is GPL-2.0-or-later. The original license files sit next to the vendored sources in `contracts/lib/`.

## Develop

```bash
npm ci
cd contracts && forge test && cd ..
node scripts/init-code-hash.mjs
node scripts/export-artifacts.mjs

anvil --port 8545 &
cd server && npm install && node test/seed.mjs   # deploys, creates pools and trades, prints addresses
FACTORY_ADDRESS=… ROUTER_ADDRESS=… POSITION_MANAGER_ADDRESS=… QUOTER_ADDRESS=… WNATIVE_ADDRESS=… CHAIN_ID=31337 npm run dev
cd web && npm install && npm run dev
```

## Server environment

| Variable | Meaning |
| --- | --- |
| `RPC_URL` | Chain RPC the indexer reads from |
| `PUBLIC_RPC_URL` | RPC URL wallets are asked to add (defaults to `RPC_URL`) |
| `CHAIN_ID`, `CHAIN_NAME`, `NATIVE_SYMBOL`, `NATIVE_NAME`, `EXPLORER_URL` | Chain details shown to users |
| `FACTORY_ADDRESS`, `ROUTER_ADDRESS`, `POSITION_MANAGER_ADDRESS`, `QUOTER_ADDRESS`, `WNATIVE_ADDRESS`, `START_BLOCK` | Deployed contracts and the block to index from |
| `ADMIN_SECRET` | Bearer token for `/api/admin/*` (branding, token list, logo) |
| `PORT`, `DATA_DIR`, `WEB_DIR`, `CONFIRMATIONS`, `POLL_MS`, `LOG_CHUNK` | Runtime tuning |

## Release

Every push to `main` runs the contract tests and the init code hash check, builds `dist/dex.tar.gz`, runs `test/e2e.sh` against anvil and uploads the bundle and `nadcab-v3.json` to the `latest` release. Hosts run it with `node:22-alpine sh /app/run.sh`.
