import "dotenv/config";
import * as z from "zod";
import { type Hex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { toHex, toBytes } from "viem";

const hex = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/, "Must be a 0x-prefixed hex string") as z.ZodType<Hex>;

const SepoliaE2eEnvSchema = z.object({
  SEPOLIA_RPC_URL: z.url(),
  MPC_ROOT_PRIVATE_KEY: hex,
  MPC_ROOT_PUBLIC_KEY: z
    .string()
    .regex(/^04[0-9a-fA-F]{128}$/, "Must be uncompressed secp256k1 public key (no 0x)"),
  ERC20_ADDRESS: hex.default("0xB4F1737Af37711e9A5890D9510c9bB60e170CB0D" as Hex),
  FAUCET_PRIVATE_KEY: hex,
  CANTON_JSON_API_URL: z.url().default("http://localhost:7575"),
});

export type SepoliaE2eEnv = z.infer<typeof SepoliaE2eEnvSchema>;

export function loadSepoliaE2eEnv(): SepoliaE2eEnv | null {
  if (!process.env.SEPOLIA_RPC_URL) return null;

  return SepoliaE2eEnvSchema.parse({
    SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL,
    MPC_ROOT_PRIVATE_KEY: process.env.MPC_ROOT_PRIVATE_KEY,
    MPC_ROOT_PUBLIC_KEY: process.env.MPC_ROOT_PUBLIC_KEY,
    ERC20_ADDRESS: process.env.ERC20_ADDRESS,
    FAUCET_PRIVATE_KEY: process.env.FAUCET_PRIVATE_KEY ?? process.env.MPC_ROOT_PRIVATE_KEY,
    CANTON_JSON_API_URL: process.env.CANTON_JSON_API_URL,
  });
}

/**
 * Derive the SPKI-encoded public key from an uncompressed secp256k1 public key.
 * Matches the format used by Canton's VaultOrchestrator.mpcPublicKey field.
 */
export function toSpkiPublicKey(uncompressedPubKey: string): string {
  const pubKeyBytes = toBytes(`0x${uncompressedPubKey}`);

  // secp256k1 SPKI header: SEQUENCE { SEQUENCE { OID ecPublicKey, OID secp256k1 }, BIT STRING }
  const spkiHeader = new Uint8Array([
    0x30,
    0x56, // SEQUENCE (86 bytes)
    0x30,
    0x10, // SEQUENCE (16 bytes)
    0x06,
    0x07,
    0x2a,
    0x86,
    0x48,
    0xce,
    0x3d,
    0x02,
    0x01, // OID ecPublicKey
    0x06,
    0x05,
    0x2b,
    0x81,
    0x04,
    0x00,
    0x0a, // OID secp256k1
    0x03,
    0x42,
    0x00, // BIT STRING (66 bytes, 0 unused bits)
    0x04, // uncompressed point marker
  ]);

  // Remove the 0x04 prefix from pubKeyBytes since spkiHeader already includes it
  const rawPoint = pubKeyBytes.slice(1);
  const spki = new Uint8Array(spkiHeader.length + rawPoint.length);
  spki.set(spkiHeader);
  spki.set(rawPoint, spkiHeader.length);

  return toHex(spki).slice(2);
}

/**
 * Derive the uncompressed public key from a private key.
 */
export function derivePublicKey(privateKey: Hex): string {
  const pubKeyBytes = secp256k1.getPublicKey(toBytes(privateKey), false);
  return toHex(pubKeyBytes).slice(2);
}
