#!/usr/bin/env node
// Deploys the DEX on a dev chain (anvil) from the exported artifacts, the same way the Console wizard does,
// then creates pools, adds full-range and concentrated liquidity and trades. Prints the deployment as JSON.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeFunctionData, encodePacked, http, maxUint256, parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const KEY = process.env.DEPLOYER_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const artifacts = JSON.parse(readFileSync(new URL("../../artifacts/nadcab-v3.json", import.meta.url)));
const testToken = JSON.parse(readFileSync(new URL("../../contracts/out/NadcabV3.t.sol/TestToken.json", import.meta.url)));

const account = privateKeyToAccount(KEY);
const chainId = Number(process.env.CHAIN_ID || 31337);
const chain = { id: chainId, name: "dev", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

async function deploy(abi, bytecode, args = []) {
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { address: receipt.contractAddress, block: Number(receipt.blockNumber) };
}

async function send(address, abi, functionName, args, value) {
  const gas = await pub.estimateContractGas({ address, abi, functionName, args, value, account });
  const hash = await wallet.writeContract({ address, abi, functionName, args, value, gas: (gas * 125n) / 100n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}

const C = artifacts.contracts;
const wnative = await deploy(C.WrappedNative.abi, C.WrappedNative.bytecode, ["Wrapped Ether", "WETH"]);
const factory = await deploy(C.UniswapV3Factory.abi, C.UniswapV3Factory.bytecode);
await send(factory.address, C.UniswapV3Factory.abi, "enableFeeAmount", [100, 1]);
const descriptor = await deploy(C.NadcabPositionDescriptor.abi, C.NadcabPositionDescriptor.bytecode, ["Nova Swap"]);
const positions = await deploy(C.NonfungiblePositionManager.abi, C.NonfungiblePositionManager.bytecode, [factory.address, wnative.address, descriptor.address]);
const router = await deploy(C.SwapRouter.abi, C.SwapRouter.bytecode, [factory.address, wnative.address]);
const quoter = await deploy(C.QuoterV2.abi, C.QuoterV2.bytecode, [factory.address, wnative.address]);

const tokens = {};
for (const [symbol, decimals] of [["USDT", 6], ["NOVA", 18], ["GOLD", 18]]) {
  const { address } = await deploy(testToken.abi, testToken.bytecode.object, [symbol, decimals, 0n]);
  await send(address, testToken.abi, "mint", [account.address, parseUnits("100000000", decimals)]);
  await send(address, testToken.abi, "approve", [positions.address, maxUint256]);
  await send(address, testToken.abi, "approve", [router.address, maxUint256]);
  tokens[symbol] = { address, decimals };
}

/** sqrt(price of token0 in token1, raw units) * 2^96. */
function sqrtPriceX96(amount0, amount1) {
  const ratio = (amount1 << 192n) / amount0;
  let x = ratio;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + ratio / x) / 2n;
  }
  return x;
}

const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const P = C.NonfungiblePositionManager.abi;
const native = wnative.address.toLowerCase();

/** Creates a pool at the price implied by the two amounts and adds liquidity in [lower, upper] ticks (full range when omitted). */
async function addPool(a, amountA, b, amountB, fee, spacing, range) {
  const [t0, a0, t1, a1] = BigInt(a) < BigInt(b) ? [a, amountA, b, amountB] : [b, amountB, a, amountA];
  const edge = Math.floor(887272 / spacing) * spacing;
  const center = Math.floor(Math.log(Number(a1) / Number(a0)) / Math.log(1.0001) / spacing) * spacing;
  const [lower, upper] = range === "near" ? [center - 16 * spacing, center + 16 * spacing] : range || [-edge, edge];
  const value = t0.toLowerCase() === native ? a0 : t1.toLowerCase() === native ? a1 : 0n;
  const calls = [
    encodeFunctionData({ abi: P, functionName: "createAndInitializePoolIfNecessary", args: [t0, t1, fee, sqrtPriceX96(a0, a1)] }),
    encodeFunctionData({
      abi: P,
      functionName: "mint",
      args: [{ token0: t0, token1: t1, fee, tickLower: lower, tickUpper: upper, amount0Desired: a0, amount1Desired: a1, amount0Min: 0n, amount1Min: 0n, recipient: account.address, deadline }],
    }),
  ];
  if (value) calls.push(encodeFunctionData({ abi: P, functionName: "refundETH" }));
  await send(positions.address, P, "multicall", [calls], value);
}

await addPool(native, parseEther("100"), tokens.USDT.address, parseUnits("200000", 6), 500, 10);
await addPool(native, parseEther("50"), tokens.NOVA.address, parseUnits("500000", 18), 3000, 60);
await addPool(tokens.NOVA.address, parseUnits("10000", 18), tokens.GOLD.address, parseUnits("10", 18), 10000, 200);
// A concentrated position around the current NOVA/WETH price.
await addPool(native, parseEther("5"), tokens.NOVA.address, parseUnits("50000", 18), 3000, 60, "near");

const R = C.SwapRouter.abi;
const rounds = Number(process.env.SWAPS || 6);
for (let i = 0; i < rounds; i += 1) {
  await send(
    router.address, R, "exactInputSingle",
    [{ tokenIn: native, tokenOut: tokens.USDT.address, fee: 500, recipient: account.address, deadline, amountIn: parseEther("1"), amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
    parseEther("1")
  );
  const toNative = encodePacked(["address", "uint24", "address"], [tokens.NOVA.address, 3000, native]);
  await send(router.address, R, "multicall", [[
    encodeFunctionData({ abi: R, functionName: "exactInput", args: [{ path: toNative, recipient: "0x0000000000000000000000000000000000000000", deadline, amountIn: parseUnits("1000", 18), amountOutMinimum: 0n }] }),
    encodeFunctionData({ abi: R, functionName: "unwrapWETH9", args: [0n, account.address] }),
  ]]);
  const multi = encodePacked(["address", "uint24", "address", "uint24", "address"], [tokens.USDT.address, 500, native, 3000, tokens.NOVA.address]);
  await send(router.address, R, "exactInput", [{ path: multi, recipient: account.address, deadline, amountIn: parseUnits("100", 6), amountOutMinimum: 0n }]);
}

console.log(
  JSON.stringify({
    chainId,
    deployer: account.address,
    startBlock: wnative.block,
    wnative: wnative.address,
    factory: factory.address,
    positionManager: positions.address,
    router: router.address,
    quoter: quoter.address,
    tokens,
  })
);
