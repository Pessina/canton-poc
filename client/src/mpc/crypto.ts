import { keccak256, stringToHex, numberToHex, type Hex } from "viem";

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
// EIP-712-style domain-separated hashing
// ---------------------------------------------------------------------------

/** Domain tag for EvmTransactionParams struct hash. */
export const EVM_PARAMS_TYPE_HASH = keccak256(stringToHex("EvmTransactionParamsV1")).slice(2);

/** Domain tag for deposit request hash. */
export const REQUEST_TYPE_HASH = keccak256(stringToHex("CantonMpcDepositRequestV1")).slice(2);

/** Domain tag for MPC response hash. */
export const RESPONSE_TYPE_HASH = keccak256(stringToHex("CantonMpcResponseV1")).slice(2);

/** Hash a string to 32 bytes (matching Daml's hashText). */
function hashText(t: string): string {
  return keccak256(stringToHex(t)).slice(2);
}

/** Hash a list of hex values (matching Daml's hashBytesList). */
function hashBytesList(xs: string[]): string {
  const inner = xs.map((x) => keccak256(`0x${x}`).slice(2)).join("");
  return keccak256(`0x${inner}`).slice(2);
}

/** Left-pad hex to the given byte width (matching Daml's padHex). */
function padHex(hex: string, bytes: number): string {
  return hex.padStart(bytes * 2, "0").slice(-(bytes * 2));
}

/**
 * EIP-712-style struct hash for EvmTransactionParams.
 * Mirrors Daml's hashEvmParams in Crypto.daml.
 */
export function hashEvmParams(p: EvmTransactionParams): string {
  const preimage =
    EVM_PARAMS_TYPE_HASH +
    padHex(p.to, 32) +
    hashText(p.functionSignature) +
    hashBytesList(p.args) +
    padHex(p.value, 32) +
    padHex(p.nonce, 32) +
    padHex(p.gasLimit, 32) +
    padHex(p.maxFeePerGas, 32) +
    padHex(p.maxPriorityFee, 32) +
    padHex(p.chainId, 32);
  return keccak256(`0x${preimage}`).slice(2);
}

/**
 * Compute request_id using EIP-712-style domain-separated hashing.
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
  const packed =
    REQUEST_TYPE_HASH +
    hashText(sender) +
    hashEvmParams(evmParams) +
    hashText(caip2Id) +
    numberToHex(keyVersion, { size: 4 }).slice(2) +
    hashText(path) +
    hashText(algo) +
    hashText(dest) +
    hashText(authCidText);

  return keccak256(`0x${packed}`);
}

/**
 * Compute response_hash with domain separator.
 * Mirrors Daml's computeResponseHash in Crypto.daml.
 */
export function computeResponseHash(requestId: string, mpcOutput: string): Hex {
  return keccak256(`0x${RESPONSE_TYPE_HASH}${requestId}${mpcOutput}` as Hex);
}
