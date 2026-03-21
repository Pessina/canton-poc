/**
 * Pre-flight script for Sepolia e2e test.
 *
 * Connects to Canton, allocates the fixed parties used by the test,
 * derives the deposit address, and prints what needs to be funded.
 *
 * Usage: pnpm sepolia:preflight
 *
 * Requires:
 *   - Canton sandbox running (pnpm daml:sandbox)
 *   - .env with MPC_ROOT_PUBLIC_KEY, SEPOLIA_RPC_URL, etc.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnv } from "../config/env.js";
import { uploadDar, allocateParty } from "../infra/canton-client.js";
import { deriveDepositAddress } from "../mpc/address-derivation.js";
import { DEPOSIT_AMOUNT } from "../test/helpers/sepolia-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAR_PATH = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");

const env = loadEnv();

async function main() {
  console.log("── Sepolia E2E Pre-flight ──\n");

  await uploadDar(DAR_PATH);
  const issuer = await allocateParty("Issuer");
  const requester = await allocateParty("SepoliaRequester");
  console.log(`Canton issuer party:    ${issuer}`);
  console.log(`Canton requester party: ${requester}`);

  const predecessorId = `${env.VAULT_ID}${issuer}`;
  const requestPath = requester;
  const depositDerivationPath = `${requester},${requestPath}`;
  const depositAddress = deriveDepositAddress(
    env.MPC_ROOT_PUBLIC_KEY,
    predecessorId,
    depositDerivationPath,
  );
  const vaultAddress = deriveDepositAddress(env.MPC_ROOT_PUBLIC_KEY, predecessorId, "root");

  console.log(`Vault ID: ${env.VAULT_ID}`);
  console.log(`Predecessor ID: ${predecessorId}`);
  console.log(`Deposit derivation path: ${depositDerivationPath}`);

  // Faucet address — the stable address the user funds once
  const faucetAccount = privateKeyToAccount(env.FAUCET_PRIVATE_KEY);
  console.log("\n── Faucet (stable, fund once) ──\n");
  console.log(`  Faucet address: ${faucetAccount.address}`);
  console.log(`    - This address auto-funds each session's deposit address`);
  console.log(`    - Keep it stocked with ETH + ERC20 tokens`);

  const client = createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
  const faucetEth = await client.getBalance({ address: faucetAccount.address });
  const faucetErc20 = await client.readContract({
    address: env.ERC20_ADDRESS,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [faucetAccount.address],
  });
  console.log(`  ETH:   ${faucetEth} wei (${Number(faucetEth) / 1e18} ETH)`);
  console.log(`  ERC20: ${faucetErc20}`);

  // Deposit address — session-specific, auto-funded by faucet at test runtime
  console.log("\n── Deposit address (session-specific) ──\n");
  console.log(`  Deposit address: ${depositAddress}`);
  console.log(`    - Auto-funded by faucet at test runtime`);
  console.log(`  Vault address:   ${vaultAddress}`);

  console.log("\n── Deposit address balances ──\n");

  const ethBalance = await client.getBalance({ address: depositAddress });
  console.log(`  ETH: ${ethBalance} wei (${Number(ethBalance) / 1e18} ETH)`);

  const erc20Balance = await client.readContract({
    address: env.ERC20_ADDRESS,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [depositAddress],
  });
  console.log(`  ERC20 (${env.ERC20_ADDRESS}): ${erc20Balance}`);

  const ethOk = ethBalance > 0n;
  const erc20Ok = erc20Balance >= DEPOSIT_AMOUNT;

  console.log("\n── Status ──\n");
  console.log(`  ETH:   ${ethOk ? "OK" : "NEEDS FUNDING (will be auto-funded at test runtime)"}`);
  console.log(`  ERC20: ${erc20Ok ? "OK" : "NEEDS FUNDING (will be auto-funded at test runtime)"}`);

  if (ethOk && erc20Ok) {
    console.log("\n  Ready to run: pnpm test:e2e:sepolia");
  } else {
    console.log("\n  Deposit address will be funded automatically when the test runs.");
  }
}

main().catch((err) => {
  console.error("Pre-flight failed:", err);
  process.exit(1);
});
