import {
  serializeTransaction,
  toFunctionSelector,
  concat,
  createPublicClient,
  http,
  type Hex,
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

/** Build functionSignature + args for an ERC20 transfer */
export function erc20TransferParams(
  to: Hex,
  amount: bigint,
): {
  functionSignature: string;
  args: Hex[];
} {
  return {
    functionSignature: "transfer(address,uint256)",
    args: [
      // address arg padded to 32 bytes (left-padded with zeros)
      ("0x" + to.slice(2).toLowerCase().padStart(64, "0")) as Hex,
      // uint256 arg padded to 32 bytes
      ("0x" + amount.toString(16).padStart(64, "0")) as Hex,
    ],
  };
}

/** Reconstruct calldata from functionSignature + args */
export function buildCalldata(functionSignature: string, args: Hex[]): Hex {
  const selector = toFunctionSelector(`function ${functionSignature}`);
  // args are already ABI-encoded (32 bytes each), just concatenate
  const encodedArgs =
    args.length > 0
      ? concat(
          args.map((a): Hex => (a.startsWith("0x") ? a : `0x${a}`)),
        )
      : "0x";
  return concat([selector, encodedArgs]);
}

/** Build CantonEvmParams — fetches nonce + gas from Sepolia */
export async function buildEvmParams(params: {
  from: Hex;
  to: Hex;
  functionSignature: string;
  args: Hex[];
  value: bigint;
  rpcUrl: string;
  chainId: number;
}): Promise<CantonEvmParams> {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(params.rpcUrl),
  });

  const calldata = buildCalldata(params.functionSignature, params.args);

  const [nonce, gasEstimate, feeData] = await Promise.all([
    client.getTransactionCount({ address: params.from }),
    client.estimateGas({
      account: params.from,
      to: params.to,
      data: calldata,
      value: params.value,
    }),
    client.estimateFeesPerGas(),
  ]);

  const gasLimit = (gasEstimate * 120n) / 100n; // 20% buffer
  const maxFeePerGas = feeData.maxFeePerGas ?? 50000000000n;
  const maxPriorityFee = feeData.maxPriorityFeePerGas ?? 1000000000n;

  const strip0x = (h: string) =>
    h.startsWith("0x") ? h.slice(2) : h;
  const pad32 = (v: bigint | number) =>
    BigInt(v).toString(16).padStart(64, "0");

  return {
    to: strip0x(params.to).padStart(40, "0"),
    functionSignature: params.functionSignature,
    args: params.args.map((a) => strip0x(a)),
    value: pad32(params.value),
    nonce: pad32(BigInt(nonce)),
    gasLimit: pad32(gasLimit),
    maxFeePerGas: pad32(maxFeePerGas),
    maxPriorityFee: pad32(maxPriorityFee),
    chainId: pad32(BigInt(params.chainId)),
  };
}

/** Serialize an unsigned EIP-1559 tx from CantonEvmParams */
export function serializeUnsignedTx(evmParams: CantonEvmParams): Hex {
  const calldata = buildCalldata(
    evmParams.functionSignature,
    evmParams.args.map((a): Hex => `0x${a}`),
  );

  return serializeTransaction({
    type: "eip1559",
    chainId: Number(BigInt(`0x${evmParams.chainId}`)),
    nonce: Number(BigInt(`0x${evmParams.nonce}`)),
    maxPriorityFeePerGas: BigInt(`0x${evmParams.maxPriorityFee}`),
    maxFeePerGas: BigInt(`0x${evmParams.maxFeePerGas}`),
    gas: BigInt(`0x${evmParams.gasLimit}`),
    to: `0x${evmParams.to}`,
    value: BigInt(`0x${evmParams.value}`),
    data: calldata,
    accessList: [],
  });
}

/** Reconstruct full signed EVM tx from evmParams + signature */
export function reconstructSignedTx(
  evmParams: CantonEvmParams,
  signature: { r: Hex; s: Hex; v: number },
): Hex {
  const calldata = buildCalldata(
    evmParams.functionSignature,
    evmParams.args.map((a): Hex => `0x${a}`),
  );

  return serializeTransaction(
    {
      type: "eip1559",
      chainId: Number(BigInt(`0x${evmParams.chainId}`)),
      nonce: Number(BigInt(`0x${evmParams.nonce}`)),
      maxPriorityFeePerGas: BigInt(`0x${evmParams.maxPriorityFee}`),
      maxFeePerGas: BigInt(`0x${evmParams.maxFeePerGas}`),
      gas: BigInt(`0x${evmParams.gasLimit}`),
      to: `0x${evmParams.to}`,
      value: BigInt(`0x${evmParams.value}`),
      data: calldata,
      accessList: [],
    },
    {
      r: signature.r,
      s: signature.s,
      yParity: signature.v,
    },
  );
}

/** Submit raw signed tx to Ethereum RPC */
export async function submitRawTransaction(
  rpcUrl: string,
  raw: Hex,
): Promise<Hex> {
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

/** Wait for transaction receipt */
export async function waitForReceipt(
  rpcUrl: string,
  txHash: Hex,
  timeoutMs = 120_000,
  pollIntervalMs = 3_000,
): Promise<{
  status: "success" | "reverted";
  transactionHash: Hex;
  blockNumber: bigint;
}> {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    timeout: timeoutMs,
    pollingInterval: pollIntervalMs,
  });
  if (receipt.status === "reverted") {
    throw new Error(`Transaction ${txHash} reverted`);
  }
  return {
    status: receipt.status,
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
  };
}
