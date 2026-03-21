import {
  serializeTransaction,
  toFunctionSelector,
  concat,
  createPublicClient,
  http,
  hexToBigInt,
  hexToNumber,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { sepolia } from "viem/chains";

/** Canton-format EVM transaction params (hex strings without 0x prefix) */
export interface CantonEvmParams {
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

/** Reconstruct calldata from functionSignature + args */
function buildCalldata(functionSignature: string, args: Hex[]): Hex {
  const selector = toFunctionSelector(`function ${functionSignature}`);
  // args are already ABI-encoded (32 bytes each), just concatenate
  const encodedArgs =
    args.length > 0 ? concat(args.map((a): Hex => (a.startsWith("0x") ? a : `0x${a}`))) : "0x";
  return concat([selector, encodedArgs]);
}

/** Build a viem-compatible EIP-1559 tx request from CantonEvmParams */
export function buildTxRequest(evmParams: CantonEvmParams): TransactionSerializableEIP1559 {
  return {
    type: "eip1559",
    chainId: hexToNumber(`0x${evmParams.chainId}`),
    nonce: hexToNumber(`0x${evmParams.nonce}`),
    maxPriorityFeePerGas: hexToBigInt(`0x${evmParams.maxPriorityFee}`),
    maxFeePerGas: hexToBigInt(`0x${evmParams.maxFeePerGas}`),
    gas: hexToBigInt(`0x${evmParams.gasLimit}`),
    to: `0x${evmParams.to}`,
    value: hexToBigInt(`0x${evmParams.value}`),
    data: buildCalldata(
      evmParams.functionSignature,
      evmParams.args.map((a): Hex => `0x${a}`),
    ),
    accessList: [],
  };
}

/** Serialize an unsigned EIP-1559 tx from CantonEvmParams */
export function serializeUnsignedTx(evmParams: CantonEvmParams): Hex {
  return serializeTransaction(buildTxRequest(evmParams));
}

/** Append signature to produce a signed EIP-1559 tx */
export function reconstructSignedTx(
  evmParams: CantonEvmParams,
  signature: { r: Hex; s: Hex; v: number },
): Hex {
  return serializeTransaction(buildTxRequest(evmParams), {
    r: signature.r,
    s: signature.s,
    yParity: signature.v,
  });
}

/** Submit raw signed tx to Ethereum RPC */
export async function submitRawTransaction(rpcUrl: string, raw: Hex): Promise<Hex> {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });
  const hash = await client.request({
    method: "eth_sendRawTransaction",
    params: [raw],
  });
  return hash;
}
