import { keccak256, type Hex } from "viem";

export interface EvmTransactionParams {
  to: string; // 20 bytes hex, no 0x
  functionSignature: string;
  args: string[]; // hex values, no 0x
  value: string; // 32 bytes hex, no 0x
  nonce: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFee: string;
  chainId: string;
}

/**
 * Convert a UTF-8 string to its hex encoding (no 0x prefix).
 */
function textToHex(s: string): string {
  return Buffer.from(s, "utf8").toString("hex");
}

/**
 * Encode a uint32 as 4 bytes hex (no 0x prefix).
 */
function uint32ToHex(n: number): string {
  return n.toString(16).padStart(8, "0");
}

/**
 * abi_encode_packed equivalent: concatenate all params at their canonical widths.
 * Mirrors Daml's packParams in Crypto.daml.
 *
 * to (20 bytes) + textToHex(functionSignature) + concat(args) + value (32)
 * + nonce (32) + gasLimit (32) + maxFeePerGas (32) + maxPriorityFee (32) + chainId (32)
 */
export function packParams(p: EvmTransactionParams): string {
  const to = p.to.padStart(40, "0"); // 20 bytes = 40 hex chars
  const fnSig = textToHex(p.functionSignature);
  const args = p.args.join("");
  const value = p.value.padStart(64, "0");
  const nonce = p.nonce.padStart(64, "0");
  const gasLimit = p.gasLimit.padStart(64, "0");
  const maxFeePerGas = p.maxFeePerGas.padStart(64, "0");
  const maxPriorityFee = p.maxPriorityFee.padStart(64, "0");
  const chainId = p.chainId.padStart(64, "0");

  return (
    to +
    fnSig +
    args +
    value +
    nonce +
    gasLimit +
    maxFeePerGas +
    maxPriorityFee +
    chainId
  );
}

/**
 * Compute request_id using the full 8-field formula matching
 * signet.js's getRequestIdBidirectional encodePacked layout.
 *
 * encodePacked(
 *   string sender,
 *   bytes  payload,
 *   string caip2Id,
 *   uint32 keyVersion,
 *   string path,
 *   string algo,     // "ECDSA"
 *   string dest,     // "ethereum"
 *   string params    // ""
 * )
 */
export function computeRequestId(
  sender: string,
  evmParams: EvmTransactionParams,
  caip2Id: string,
  keyVersion: number,
  path: string,
): Hex {
  const payload = packParams(evmParams);

  const packed =
    textToHex(sender) +
    payload +
    textToHex(caip2Id) +
    uint32ToHex(keyVersion) +
    textToHex(path) +
    textToHex("ECDSA") +
    textToHex("ethereum");
  // params = "" -> empty bytes

  return keccak256(`0x${packed}`);
}
