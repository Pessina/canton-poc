import { hashTypedData, type Hex } from "viem";

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
