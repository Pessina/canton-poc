import { keccak256, toBytes, toHex, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { utils } from "signet.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const { deriveChildPublicKey } = utils.cryptography;
const EPSILON_DERIVATION_PREFIX = "sig.network v2.0.0 epsilon derivation";
const CURVE_ORDER = secp256k1.Point.Fn.ORDER;

export const KEY_VERSION = 1;

function deriveChildPublicKeyFallback(
  rootPubKey: `04${string}`,
  predecessorId: string,
  path: string,
  caip2Id: string,
): `04${string}` {
  const derivationPath = `${EPSILON_DERIVATION_PREFIX}:${caip2Id}:${predecessorId}:${path}`;
  const epsilon = BigInt(keccak256(toBytes(derivationPath)));
  const scalar = (((epsilon % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER);

  const rootPoint = secp256k1.Point.fromHex(rootPubKey);
  const epsilonPoint = secp256k1.Point.BASE.multiply(scalar);
  const childPoint = rootPoint.add(epsilonPoint);
  return toHex(childPoint.toBytes(false)).slice(2) as `04${string}`;
}

/**
 * Derive an Ethereum deposit address from MPC root key + derivation params.
 */
export function deriveDepositAddress(
  rootPubKey: string, // "04..." uncompressed secp256k1 (no 0x)
  predecessorId: string,
  path: string,
  caip2Id: string,
  keyVersion = KEY_VERSION,
): Hex {
  let childPubKey: `04${string}`;
  try {
    childPubKey = deriveChildPublicKey(
      rootPubKey as `04${string}`,
      predecessorId,
      path,
      caip2Id,
      keyVersion,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Invalid chain ID")) throw err;
    childPubKey = deriveChildPublicKeyFallback(
      rootPubKey as `04${string}`,
      predecessorId,
      path,
      caip2Id,
    );
  }
  return publicKeyToAddress(`0x${childPubKey}`);
}

/**
 * Convert chainId hex (with or without left padding) to CAIP-2 text.
 * Example: "000...aa36a7" -> "eip155:11155111".
 */
export function chainIdHexToCaip2(chainIdHex: string): string {
  const normalized = chainIdHex.replace(/^0+/, "") || "0";
  return `eip155:${BigInt(`0x${normalized}`).toString()}`;
}
