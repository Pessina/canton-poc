import { keccak256, createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { serializeUnsignedTx, reconstructSignedTx, type CantonEvmParams } from "../evm/tx-builder.js";
import { deriveChildPrivateKey, signEvmTxHash, signMpcResponse } from "./signer.js";
import { exerciseChoice, type CreatedEvent } from "../infra/canton-client.js";

const VAULT_ORCHESTRATOR = "Erc20Vault:VaultOrchestrator";

function hexChainIdToDecimal(hexChainId: string): number {
  return Number(BigInt("0x" + (hexChainId.replace(/^0+/, "") || "0")));
}

export async function handlePendingEvmDeposit(params: {
  orchCid: string;
  userId: string;
  actAs: string[];
  rootPrivateKey: Hex;
  rpcUrl: string;
  event: CreatedEvent;
}): Promise<void> {
  const { orchCid, userId, actAs, rootPrivateKey, rpcUrl, event } = params;
  const args = event.createArgument as Record<string, unknown>;
  const requester = args.requester as string;
  const path = args.path as string;
  const requestId = args.requestId as string;
  const evmParams = args.evmParams as CantonEvmParams;

  console.log(`[MPC] Processing PendingEvmDeposit requestId=${requestId}`);

  // Phase 1: Sign the EVM transaction
  const caip2Id = "eip155:" + hexChainIdToDecimal(evmParams.chainId);
  const serializedUnsigned = serializeUnsignedTx(evmParams);
  const txHash = keccak256(serializedUnsigned);

  const childPrivateKey = deriveChildPrivateKey(rootPrivateKey, requester, path, caip2Id);
  const { r, s, v } = signEvmTxHash(childPrivateKey, txHash);

  console.log(`[MPC] Signing EVM tx, exercising SignEvmTx`);
  await exerciseChoice(userId, actAs, VAULT_ORCHESTRATOR, orchCid, "SignEvmTx", {
    requestId,
    r,
    s,
    v,
  });
  console.log(`[MPC] SignEvmTx exercised`);

  // Phase 2: Verify ETH outcome
  const signedTx = reconstructSignedTx(evmParams, {
    r: `0x${r}`,
    s: `0x${s}`,
    v,
  });
  const signedTxHash = keccak256(signedTx);

  console.log(`[MPC] Polling Sepolia for receipt txHash=${signedTxHash}`);
  const client = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });

  let mpcOutput: string;
  try {
    const receipt = await client.waitForTransactionReceipt({
      hash: signedTxHash,
      timeout: 120_000,
      pollingInterval: 5_000,
    });
    mpcOutput = receipt.status === "success" ? "01" : "00";
    console.log(`[MPC] Receipt received, status=${receipt.status}`);
  } catch (err) {
    console.error(`[MPC] Failed to get receipt: ${err instanceof Error ? err.message : String(err)}`);
    mpcOutput = "00";
  }

  const signature = signMpcResponse(rootPrivateKey, requestId, mpcOutput);

  console.log(`[MPC] Exercising ProvideEvmOutcomeSig`);
  await exerciseChoice(userId, actAs, VAULT_ORCHESTRATOR, orchCid, "ProvideEvmOutcomeSig", {
    requestId,
    signature,
    mpcOutput,
  });
  console.log(`[MPC] ProvideEvmOutcomeSig exercised for requestId=${requestId}`);
}
