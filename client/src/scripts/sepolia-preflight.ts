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
 *   - MPC_ROOT_PUBLIC_KEY env var set
 *   - SEPOLIA_RPC_URL env var set (for balance checks)
 *   - ERC20_ADDRESS env var (optional, defaults to test USDC)
 */

import "dotenv/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { uploadDar, allocateParty } from "../infra/canton-client.js";
import { deriveDepositAddress } from "../mpc/address-derivation.js";
import { DEPOSIT_PATH, DEPOSIT_AMOUNT } from "../test/helpers/sepolia-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAR_PATH = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");

const MPC_ROOT_PUBLIC_KEY = process.env.MPC_ROOT_PUBLIC_KEY;
const MPC_ROOT_PRIVATE_KEY = process.env.MPC_ROOT_PRIVATE_KEY;
const FAUCET_PRIVATE_KEY = (process.env.FAUCET_PRIVATE_KEY ?? MPC_ROOT_PRIVATE_KEY) as
  | Hex
  | undefined;
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL;
const ERC20_ADDRESS = (process.env.ERC20_ADDRESS ??
  "0xB4F1737Af37711e9A5890D9510c9bB60e170CB0D") as Hex;

async function main() {
  if (!MPC_ROOT_PUBLIC_KEY) {
    console.error("MPC_ROOT_PUBLIC_KEY env var is required");
    process.exit(1);
  }

  console.log("── Sepolia E2E Pre-flight ──\n");

  await uploadDar(DAR_PATH);
  const depositor = await allocateParty("SepoliaDepositor");
  console.log(`Canton depositor party: ${depositor}`);

  const depositAddress = deriveDepositAddress(MPC_ROOT_PUBLIC_KEY, depositor, DEPOSIT_PATH);

  // Faucet address — the stable address the user funds once
  if (FAUCET_PRIVATE_KEY) {
    const faucetAccount = privateKeyToAccount(FAUCET_PRIVATE_KEY);
    console.log("\n── Faucet (stable, fund once) ──\n");
    console.log(`  Faucet address: ${faucetAccount.address}`);
    console.log(`    - This address auto-funds each session's deposit address`);
    console.log(`    - Keep it stocked with ETH + ERC20 tokens`);

    if (SEPOLIA_RPC_URL) {
      const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
      const faucetEth = await client.getBalance({ address: faucetAccount.address });
      const faucetErc20 = await client.readContract({
        address: ERC20_ADDRESS,
        abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
        functionName: "balanceOf",
        args: [faucetAccount.address],
      });
      console.log(`  ETH:   ${faucetEth} wei (${Number(faucetEth) / 1e18} ETH)`);
      console.log(`  ERC20: ${faucetErc20}`);
    }
  } else {
    console.log("\n  No FAUCET_PRIVATE_KEY or MPC_ROOT_PRIVATE_KEY set — faucet info unavailable.");
  }

  // Deposit address — session-specific, auto-funded by faucet at test runtime
  console.log("\n── Deposit address (session-specific) ──\n");
  console.log(`  Deposit address: ${depositAddress}`);
  console.log(`    - Auto-funded by faucet at test runtime`);

  if (SEPOLIA_RPC_URL) {
    console.log("\n── Deposit address balances ──\n");
    const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });

    const ethBalance = await client.getBalance({ address: depositAddress });
    console.log(`  ETH: ${ethBalance} wei (${Number(ethBalance) / 1e18} ETH)`);

    const erc20Balance = await client.readContract({
      address: ERC20_ADDRESS,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [depositAddress],
    });
    console.log(`  ERC20 (${ERC20_ADDRESS}): ${erc20Balance}`);

    const ethOk = ethBalance > 0n;
    const erc20Ok = erc20Balance >= DEPOSIT_AMOUNT;

    console.log("\n── Status ──\n");
    console.log(`  ETH:   ${ethOk ? "OK" : "NEEDS FUNDING (will be auto-funded at test runtime)"}`);
    console.log(
      `  ERC20: ${erc20Ok ? "OK" : "NEEDS FUNDING (will be auto-funded at test runtime)"}`,
    );

    if (ethOk && erc20Ok) {
      console.log("\n  Ready to run: pnpm test:e2e:sepolia");
    } else {
      console.log("\n  Deposit address will be funded automatically when the test runs.");
    }
  } else {
    console.log("\n  Set SEPOLIA_RPC_URL to check live balances.");
  }
}

main().catch((err) => {
  console.error("Pre-flight failed:", err);
  process.exit(1);
});
