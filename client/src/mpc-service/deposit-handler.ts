import { keccak256, createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import {
  serializeUnsignedTx,
  reconstructSignedTx,
  type CantonEvmParams,
} from "../evm/tx-builder.js";
import { deriveChildPrivateKey, signEvmTxHash, signMpcResponse } from "./signer.js";
import { exerciseChoice, type CreatedEvent } from "../infra/canton-client.js";
import { computeRequestId, type EvmTransactionParams } from "../mpc/crypto.js";
import { chainIdHexToCaip2 } from "../mpc/address-derivation.js";
import { VaultOrchestrator } from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";

const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;

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
  const requestPath = args.path as string;
  const contractRequestId = args.requestId as string;
  const evmParams = args.evmParams as CantonEvmParams;
  const predecessorId = event.templateId.split(":")[0];
  if (!predecessorId) {
    throw new Error(`Invalid templateId format: ${event.templateId}`);
  }
  const keyDerivationPath = requester;

  // Independently derive requestId — never trust on-chain data blindly
  const caip2Id = chainIdHexToCaip2(evmParams.chainId);
  const computedRequestId = computeRequestId(
    requester,
    evmParams as EvmTransactionParams,
    caip2Id,
    1,
    requestPath,
  );
  if (computedRequestId.slice(2) !== contractRequestId) {
    throw new Error(
      `requestId mismatch: computed=${computedRequestId.slice(2)} contract=${contractRequestId}`,
    );
  }
  const requestId = computedRequestId.slice(2);

  console.log(`[MPC] Processing PendingEvmDeposit requestId=${requestId}`);

  // Phase 1: Sign the EVM transaction
  const serializedUnsigned = serializeUnsignedTx(evmParams);
  const txHash = keccak256(serializedUnsigned);

  const childPrivateKey = deriveChildPrivateKey(
    rootPrivateKey,
    predecessorId,
    keyDerivationPath,
    caip2Id,
  );
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
    console.error(
      `[MPC] Failed to get receipt: ${err instanceof Error ? err.message : String(err)}`,
    );
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
