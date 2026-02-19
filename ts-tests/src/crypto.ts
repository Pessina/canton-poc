import { keccak256, concat, pad, type Hex } from "viem";

export interface EvmTransactionParams {
  erc20Address: Hex; // 20 bytes
  recipient: Hex; // 20 bytes
  amount: Hex; // 32 bytes (uint256)
  nonce: Hex; // 32 bytes
  gasLimit: Hex; // 32 bytes
  maxFeePerGas: Hex; // 32 bytes
  maxPriorityFee: Hex; // 32 bytes
  chainId: Hex; // 32 bytes
  value: Hex; // 32 bytes
}

/**
 * Pad a hex value to a specific byte size (left-padded with zeros).
 * Mirrors Daml's packHexBytes.
 */
function padHex(hex: Hex, size: number): Hex {
  return pad(hex, { size });
}

/**
 * abi_encode_packed equivalent: concatenate all params at their canonical EVM widths.
 * Mirrors Daml's packParams in Crypto.daml.
 */
export function packParams(p: EvmTransactionParams): Hex {
  return concat([
    padHex(p.erc20Address, 20), // address = 20 bytes
    padHex(p.recipient, 20),
    padHex(p.amount, 32), // uint256 = 32 bytes
    padHex(p.nonce, 32),
    padHex(p.gasLimit, 32),
    padHex(p.maxFeePerGas, 32),
    padHex(p.maxPriorityFee, 32),
    padHex(p.chainId, 32),
    padHex(p.value, 32),
  ]);
}

/**
 * Compute request_id = keccak256(packed params).
 * Mirrors Daml's computeRequestId.
 */
export function computeRequestId(params: EvmTransactionParams): Hex {
  return keccak256(packParams(params));
}

/**
 * Compute response_hash = keccak256(request_id || serialized_output).
 * Mirrors Daml's computeResponseHash.
 */
export function computeResponseHash(requestId: Hex, output: Hex): Hex {
  return keccak256(concat([requestId, output]));
}
