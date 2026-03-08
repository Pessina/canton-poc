import { secp256k1 } from "@noble/curves/secp256k1.js";
import { DER } from "@noble/curves/abstract/weierstrass.js";
import { keccak256, toBytes, toHex, numberToHex, hexToBigInt, type Hex } from "viem";
import { computeResponseHash } from "../mpc/crypto.js";

const EPSILON_DERIVATION_PREFIX = "sig.network v2.0.0 epsilon derivation";

/** signet.js uses eip155:1 for all EVM key derivation, regardless of network. */
const KDF_CHAIN_ID = "eip155:1";

/** secp256k1 curve order (n). */
const CURVE_ORDER = secp256k1.Point.Fn.ORDER;

/**
 * Derive a child private key for signing EVM transactions.
 * childKey = (rootPrivateKey + epsilon) mod n
 * where epsilon = keccak256("{prefix}:eip155:1:{predecessorId}:{path}")
 */
export function deriveChildPrivateKey(
  rootPrivateKey: Hex,
  predecessorId: string,
  path: string,
): Hex {
  const derivationPath = `${EPSILON_DERIVATION_PREFIX}:${KDF_CHAIN_ID}:${predecessorId}:${path}`;
  const epsilon = keccak256(toBytes(derivationPath));

  const rootKey = BigInt(rootPrivateKey);
  const eps = BigInt(epsilon);
  const childKey = (((rootKey + eps) % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;

  return numberToHex(childKey, { size: 32 });
}

/**
 * Sign an EVM transaction hash with a secp256k1 private key.
 * Returns { r, s, v } as bare hex (no 0x) for Canton's EcdsaSignature.
 *
 * Uses @noble/curves v2.0 'recovered' format: [v, r_32bytes, s_32bytes].
 */
export function signEvmTxHash(privateKey: Hex, txHash: Hex): { r: string; s: string; v: number } {
  const msgHash = toBytes(txHash);
  const privKeyBytes = toBytes(privateKey);

  // 'recovered' format: Uint8Array(65) = [recovery_byte, r_32, s_32]
  // prehash: false because txHash is already keccak256'd
  const sig = secp256k1.sign(msgHash, privKeyBytes, {
    format: "recovered",
    prehash: false,
  });

  const v = sig[0]!;
  const r = toHex(sig.slice(1, 33)).slice(2);
  const s = toHex(sig.slice(33, 65)).slice(2);

  return { r, s, v };
}

/**
 * Sign the MPC response for Canton's EvmTxOutcomeSignature.
 * responseHash = keccak256(RESPONSE_TYPE_HASH || requestId || mpcOutput)
 * Returns DER-encoded signature as bare hex without 0x prefix (Daml format).
 */
export function signMpcResponse(rootPrivateKey: Hex, requestId: string, mpcOutput: string): string {
  // requestId and mpcOutput are bare hex (no 0x)
  const responseHash = computeResponseHash(requestId, mpcOutput);
  const msgHash = toBytes(responseHash);
  const privKeyBytes = toBytes(rootPrivateKey);

  // Default format: 'compact' (64 bytes = r || s), prehash: false
  const raw = secp256k1.sign(msgHash, privKeyBytes, { prehash: false });
  const r = hexToBigInt(toHex(raw.slice(0, 32)));
  const s = hexToBigInt(toHex(raw.slice(32, 64)));

  // DER-encode via @noble/curves
  return DER.hexFromSig({ r, s });
}
