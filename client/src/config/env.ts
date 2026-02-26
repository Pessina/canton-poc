import { type Hex } from "viem";

export interface EnvConfig {
  CANTON_JSON_API_URL: string;
  SEPOLIA_RPC_URL: string;
  MPC_ROOT_PUBLIC_KEY: string; // "04..." uncompressed, no 0x
  SEPOLIA_CHAIN_ID: number;
  CAIP2_ID: string;
  KEY_VERSION: number;
  ERC20_ADDRESS: Hex; // USDC on Sepolia
}

export interface MpcEnvConfig extends EnvConfig {
  MPC_ROOT_PRIVATE_KEY: Hex; // "0x..." secp256k1 private key
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export function loadEnvConfig(): EnvConfig {
  return {
    CANTON_JSON_API_URL:
      process.env.CANTON_JSON_API_URL ?? "http://localhost:7575",
    SEPOLIA_RPC_URL: requireEnv("SEPOLIA_RPC_URL"),
    MPC_ROOT_PUBLIC_KEY: requireEnv("MPC_ROOT_PUBLIC_KEY"),
    SEPOLIA_CHAIN_ID: 11155111,
    CAIP2_ID: "eip155:11155111",
    KEY_VERSION: 1,
    ERC20_ADDRESS: (process.env.ERC20_ADDRESS ??
      "0xbe72E441BF55620febc26715db68d3494213D8Cb") as Hex,
  };
}

export function loadMpcEnvConfig(): MpcEnvConfig {
  return {
    ...loadEnvConfig(),
    MPC_ROOT_PRIVATE_KEY: requireEnv("MPC_ROOT_PRIVATE_KEY") as Hex,
  };
}
