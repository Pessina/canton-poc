import { keccak256, createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { serializeUnsignedTx, reconstructSignedTx } from "../evm/tx-builder.js";
import { deriveChildPrivateKey, signEvmTxHash, signMpcResponse } from "./signer.js";
import { exerciseChoice, type CreatedEvent } from "../infra/canton-client.js";
import { computeRequestId, type EvmTransactionParams } from "../mpc/crypto.js";
import { chainIdHexToCaip2 } from "../mpc/address-derivation.js";
import {
  VaultOrchestrator,
  type PendingEvmDeposit,
} from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";

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
  const {
    requester,
    path: requestPath,
    requestId: contractRequestId,
    evmParams,
    issuer,
    vaultId,
    authCid,
    keyVersion,
    algo,
    dest,
  } = event.createArgument as PendingEvmDeposit;
  // vaultId (issuer-controlled discriminator) + issuer ensures different vaults
  // never control the same EVM address via MPC KDF.
  const predecessorId = `${vaultId}${issuer}`;
  const keyDerivationPath = requestPath;

  // Independently derive requestId from the verified authCid (not user-supplied authCidText)
  const caip2Id = chainIdHexToCaip2(evmParams.chainId);
  const computedRequestId = computeRequestId(
    requester,
    evmParams as EvmTransactionParams,
    caip2Id,
    Number(keyVersion),
    requestPath,
    algo,
    dest,
    authCid,
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

  const childPrivateKey = deriveChildPrivateKey(rootPrivateKey, predecessorId, keyDerivationPath);
  const { r, s, v } = signEvmTxHash(childPrivateKey, txHash);

  console.log(`[MPC] Signing EVM tx, exercising SignEvmTx`);
  await exerciseChoice(userId, actAs, VAULT_ORCHESTRATOR, orchCid, "SignEvmTx", {
    requester,
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

  // ERC-20 Transfer(address,address,uint256) event signature
  const ERC20_TRANSFER_TOPIC = keccak256(
    new TextEncoder().encode("Transfer(address,address,uint256)"),
  );

  let mpcOutput: string;
  try {
    const receipt = await client.waitForTransactionReceipt({
      hash: signedTxHash,
      timeout: 120_000,
      pollingInterval: 5_000,
    });

    const hasTransferEvent = receipt.logs.some(
      (log) => log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase(),
    );

    if (receipt.status === "success" && hasTransferEvent) {
      mpcOutput = "01";
    } else {
      mpcOutput = "00";
      console.warn(
        `[MPC] Tx did not produce a valid transfer: status=${receipt.status}, hasTransferEvent=${hasTransferEvent}`,
      );
    }
    console.log(
      `[MPC] Receipt received, status=${receipt.status}, hasTransferEvent=${hasTransferEvent}`,
    );
  } catch (err) {
    console.error(
      `[MPC] Failed to get receipt: ${err instanceof Error ? err.message : String(err)}`,
    );
    mpcOutput = "00";
  }

  const signature = signMpcResponse(rootPrivateKey, requestId, mpcOutput);

  console.log(`[MPC] Exercising ProvideEvmOutcomeSig`);
  await exerciseChoice(userId, actAs, VAULT_ORCHESTRATOR, orchCid, "ProvideEvmOutcomeSig", {
    requester,
    requestId,
    signature,
    mpcOutput,
  });
  console.log(`[MPC] ProvideEvmOutcomeSig exercised for requestId=${requestId}`);
}
