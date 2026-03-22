import "dotenv/config";
import * as z from "zod";
import { type Hex } from "viem";

const hex = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/, "Must be a 0x-prefixed hex string") as z.ZodType<Hex>;

const EnvSchema = z.object({
  CANTON_JSON_API_URL: z.url().default("http://localhost:7575"),
  SEPOLIA_RPC_URL: z.url(),
  MPC_ROOT_PUBLIC_KEY: z
    .string()
    .regex(/^04[0-9a-fA-F]{128}$/, "Must be uncompressed secp256k1 public key (no 0x)"),
  MPC_ROOT_PRIVATE_KEY: hex,
  ERC20_ADDRESS: hex.default("0xB4F1737Af37711e9A5890D9510c9bB60e170CB0D" as Hex),
  FAUCET_PRIVATE_KEY: hex,
  VAULT_ID: z.string().default("default-vault"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  return EnvSchema.parse({
    CANTON_JSON_API_URL: process.env.CANTON_JSON_API_URL,
    SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL,
    MPC_ROOT_PUBLIC_KEY: process.env.MPC_ROOT_PUBLIC_KEY,
    MPC_ROOT_PRIVATE_KEY: process.env.MPC_ROOT_PRIVATE_KEY,
    ERC20_ADDRESS: process.env.ERC20_ADDRESS,
    FAUCET_PRIVATE_KEY: process.env.FAUCET_PRIVATE_KEY ?? process.env.MPC_ROOT_PRIVATE_KEY,
    VAULT_ID: process.env.VAULT_ID,
  });
}
