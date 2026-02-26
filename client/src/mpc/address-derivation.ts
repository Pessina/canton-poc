import { keccak256, type Hex } from "viem";
import { utils } from "signet.js";

const { deriveChildPublicKey } = utils.cryptography;

/**
 * Derive an Ethereum deposit address from MPC root key + derivation params.
 */
export function deriveDepositAddress(
  rootPubKey: string, // "04..." uncompressed secp256k1 (no 0x)
  predecessorId: string,
  path: string,
  caip2Id: string,
  keyVersion: number,
): Hex {
  const childPubKey = deriveChildPublicKey(
    rootPubKey as `04${string}`,
    predecessorId,
    path,
    caip2Id,
    keyVersion,
  );
  return publicKeyToEthAddress(childPubKey);
}

/**
 * Convert uncompressed public key to Ethereum address.
 * address = keccak256(pubkey_x || pubkey_y)[12..32]
 */
export function publicKeyToEthAddress(uncompressedPubKey: string): Hex {
  const stripped = uncompressedPubKey.startsWith("04")
    ? uncompressedPubKey.slice(2)
    : uncompressedPubKey;

  const hash = keccak256(`0x${stripped}`);
  // Take the last 20 bytes (last 40 hex chars)
  return `0x${hash.slice(26)}`;
}
