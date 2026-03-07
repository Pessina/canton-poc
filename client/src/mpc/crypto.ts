import { keccak256, stringToHex, numberToHex, type Hex } from "viem";

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
 * abi_encode_packed equivalent: concatenate all params at their canonical widths.
 * Mirrors Daml's packParams in Crypto.daml.
 *
 * to (20 bytes) + stringToHex(functionSignature) + concat(args) + value (32)
 * + nonce (32) + gasLimit (32) + maxFeePerGas (32) + maxPriorityFee (32) + chainId (32)
 */
export function packParams(p: EvmTransactionParams): string {
  return (
    p.to.padStart(40, "0") +
    stringToHex(p.functionSignature).slice(2) +
    p.args.join("") +
    p.value.padStart(64, "0") +
    p.nonce.padStart(64, "0") +
    p.gasLimit.padStart(64, "0") +
    p.maxFeePerGas.padStart(64, "0") +
    p.maxPriorityFee.padStart(64, "0") +
    p.chainId.padStart(64, "0")
  );
}

/**
 * Compute request_id using the 9-field formula matching
 * signet.js's getRequestIdBidirectional encodePacked layout.
 *
 * encodePacked(
 *   string sender,
 *   bytes  payload,
 *   string caip2Id,
 *   uint32 keyVersion,
 *   string path,
 *   string algo,
 *   string dest,
 *   string contractId,
 *   string authContractId,
 * )
 */
export function computeRequestId(
  sender: string,
  evmParams: EvmTransactionParams,
  caip2Id: string,
  keyVersion: number,
  path: string,
  algo: string,
  dest: string,
  contractId: string,
  authContractId: string,
): Hex {
  const payload = packParams(evmParams);

  const packed =
    stringToHex(sender).slice(2) +
    payload +
    stringToHex(caip2Id).slice(2) +
    numberToHex(keyVersion, { size: 4 }).slice(2) +
    stringToHex(path).slice(2) +
    stringToHex(algo).slice(2) +
    stringToHex(dest).slice(2) +
    stringToHex(contractId).slice(2) +
    stringToHex(authContractId).slice(2);

  return keccak256(`0x${packed}`);
}
