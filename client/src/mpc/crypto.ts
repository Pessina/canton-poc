import { hashTypedData, toHex, toBytes, type Hex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1.js";

export interface EvmTransactionParams {
  to: string;
  functionSignature: string;
  args: string[];
  value: string;
  nonce: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFee: string;
  chainId: string;
}

// ---------------------------------------------------------------------------
// EIP-712 type definitions and domain
// ---------------------------------------------------------------------------

export const eip712Types = {
  EvmTransactionParams: [
    { name: "to", type: "address" },
    { name: "functionSignature", type: "string" },
    { name: "args", type: "bytes[]" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "gasLimit", type: "uint256" },
    { name: "maxFeePerGas", type: "uint256" },
    { name: "maxPriorityFee", type: "uint256" },
    { name: "chainId", type: "uint256" },
  ],
  CantonMpcDepositRequest: [
    { name: "sender", type: "string" },
    { name: "evmParams", type: "EvmTransactionParams" },
    { name: "caip2Id", type: "string" },
    { name: "keyVersion", type: "uint32" },
    { name: "path", type: "string" },
    { name: "algo", type: "string" },
    { name: "dest", type: "string" },
    { name: "authCidText", type: "string" },
  ],
  CantonMpcResponse: [
    { name: "requestId", type: "bytes32" },
    { name: "mpcOutput", type: "bytes" },
  ],
} as const;

export const eip712Domain = {
  name: "CantonMpc",
  version: "1",
} as const;

// ---------------------------------------------------------------------------
// EIP-712 typed data hashing (viem)
// ---------------------------------------------------------------------------

function toEvmParamsMessage(p: EvmTransactionParams) {
  const to: Hex = `0x${p.to}`;
  return {
    to,
    functionSignature: p.functionSignature,
    args: p.args.map((a): Hex => `0x${a}`),
    value: BigInt(`0x${p.value}`),
    nonce: BigInt(`0x${p.nonce}`),
    gasLimit: BigInt(`0x${p.gasLimit}`),
    maxFeePerGas: BigInt(`0x${p.maxFeePerGas}`),
    maxPriorityFee: BigInt(`0x${p.maxPriorityFee}`),
    chainId: BigInt(`0x${p.chainId}`),
  };
}

/**
 * Compute request_id using EIP-712 typed data hashing.
 * Mirrors Daml's computeRequestId in Crypto.daml.
 */
export function computeRequestId(
  sender: string,
  evmParams: EvmTransactionParams,
  caip2Id: string,
  keyVersion: number,
  path: string,
  algo: string,
  dest: string,
  authCidText: string,
): Hex {
  return hashTypedData({
    domain: eip712Domain,
    types: eip712Types,
    primaryType: "CantonMpcDepositRequest",
    message: {
      sender,
      evmParams: toEvmParamsMessage(evmParams),
      caip2Id,
      keyVersion,
      path,
      algo,
      dest,
      authCidText,
    },
  });
}

/**
 * Compute response_hash using EIP-712 typed data hashing.
 * Mirrors Daml's computeResponseHash in Crypto.daml.
 */
export function computeResponseHash(requestId: string, mpcOutput: string): Hex {
  return hashTypedData({
    domain: eip712Domain,
    types: eip712Types,
    primaryType: "CantonMpcResponse",
    message: {
      requestId: `0x${requestId}` as const,
      mpcOutput: `0x${mpcOutput}` as const,
    },
  });
}

// ---------------------------------------------------------------------------
// Key encoding
// ---------------------------------------------------------------------------

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
