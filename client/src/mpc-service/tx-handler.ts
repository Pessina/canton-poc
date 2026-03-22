import { keccak256, createPublicClient, http, hexToNumber, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { sepolia } from "viem/chains";
import { serializeUnsignedTx, reconstructSignedTx } from "../evm/tx-builder.js";
import { deriveChildPrivateKey, signEvmTxHash, signMpcResponse } from "./signer.js";
import {
  exerciseChoice,
  type CreatedEvent,
  type TransactionResponse,
} from "../infra/canton-client.js";
import { computeRequestId, type EvmTransactionParams } from "../mpc/crypto.js";
import { chainIdHexToCaip2 } from "../mpc/address-derivation.js";
import {
  VaultOrchestrator,
  type PendingEvmTx,
} from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";

const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;

const ERC20_TRANSFER_TOPIC = keccak256(
  new TextEncoder().encode("Transfer(address,address,uint256)"),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MpcServiceConfig {
  orchCid: string;
  userId: string;
  actAs: string[];
  rootPrivateKey: Hex;
  rpcUrl: string;
}

export interface PendingTx {
  requestId: string;
  requester: string;
  signedTxHash: Hex;
  fromAddress: Hex;
  nonce: number;
  checkCount: number;
}

export type CheckResult = "pending" | "done" | "failed";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  return (
    msg.includes("fetch failed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("socket hang up") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504")
  );
}

// ---------------------------------------------------------------------------
// Retry wrapper for Canton exerciseChoice
// ---------------------------------------------------------------------------

async function exerciseChoiceWithRetry(
  userId: string,
  actAs: string[],
  templateId: string,
  contractId: string,
  choice: string,
  choiceArgument: Record<string, unknown>,
  maxAttempts = 3,
): Promise<TransactionResponse> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await exerciseChoice(userId, actAs, templateId, contractId, choice, choiceArgument);
    } catch (err) {
      if (!isTransientError(err) || attempt === maxAttempts) throw err;
      const delay = 1000 * 2 ** (attempt - 1);
      console.warn(
        `[MPC] Canton transient error (${choice}), retry ${attempt}/${maxAttempts} in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Phase 1: Sign and enqueue (tx-type agnostic)
// ---------------------------------------------------------------------------

export async function signAndEnqueue(
  config: MpcServiceConfig,
  event: CreatedEvent,
): Promise<PendingTx> {
  const { orchCid, userId, actAs, rootPrivateKey } = config;
  const {
    requester,
    path: requestPath,
    requestId: contractRequestId,
    evmParams,
    issuer,
    vaultId,
    nonceCidText,
    keyVersion,
    algo,
    dest,
  } = event.createArgument as PendingEvmTx;

  const predecessorId = `${vaultId}${issuer}`;

  // Validate requestId
  const caip2Id = chainIdHexToCaip2(evmParams.chainId);
  const computedRequestId = computeRequestId(
    requester,
    evmParams as EvmTransactionParams,
    caip2Id,
    Number(keyVersion),
    requestPath,
    algo,
    dest,
    nonceCidText,
  );
  if (computedRequestId.slice(2) !== contractRequestId) {
    throw new Error(
      `requestId mismatch: computed=${computedRequestId.slice(2)} contract=${contractRequestId}`,
    );
  }
  const requestId = computedRequestId.slice(2);

  console.log(`[MPC] Processing PendingEvmTx requestId=${requestId}`);

  // Derive child key and sender address
  const childPrivateKey = deriveChildPrivateKey(rootPrivateKey, predecessorId, requestPath);
  const fromAddress = privateKeyToAddress(childPrivateKey);
  const txNonce = hexToNumber(`0x${evmParams.nonce}`);

  // Sign EVM transaction
  const serializedUnsigned = serializeUnsignedTx(evmParams);
  const txHash = keccak256(serializedUnsigned);
  const { r, s, v } = signEvmTxHash(childPrivateKey, txHash);

  console.log(`[MPC] Signing EVM tx, exercising SignEvmTx`);
  await exerciseChoiceWithRetry(userId, actAs, VAULT_ORCHESTRATOR, orchCid, "SignEvmTx", {
    requester,
    requestId,
    r,
    s,
    v,
  });
  console.log(`[MPC] SignEvmTx exercised`);

  // Compute signed tx hash for monitoring
  const signedTx = reconstructSignedTx(evmParams, {
    r: `0x${r}`,
    s: `0x${s}`,
    v,
  });
  const signedTxHash = keccak256(signedTx);

  return {
    requestId,
    requester,
    signedTxHash,
    fromAddress,
    nonce: txNonce,
    checkCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: Monitor — check receipt and report outcome (tx-type agnostic)
// ---------------------------------------------------------------------------

export async function checkPendingTx(
  config: MpcServiceConfig,
  tx: PendingTx,
): Promise<CheckResult> {
  const client = createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });

  let mpcOutput: string | null = null;

  try {
    const receipt = await client.getTransactionReceipt({ hash: tx.signedTxHash });

    const hasTransferEvent = receipt.logs.some(
      (log) => log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase(),
    );

    if (receipt.status === "success" && hasTransferEvent) {
      mpcOutput = "01";
    } else {
      mpcOutput = "00";
      console.warn(
        `[MPC] Tx reverted or missing transfer: status=${receipt.status}, ` +
          `hasTransferEvent=${hasTransferEvent}, requestId=${tx.requestId}`,
      );
    }
    console.log(`[MPC] Receipt found for requestId=${tx.requestId}, status=${receipt.status}`);
  } catch {
    // No receipt yet — check if nonce was consumed (tx replaced)
    try {
      const currentNonce = await client.getTransactionCount({ address: tx.fromAddress });
      if (currentNonce > tx.nonce) {
        // Double-check: maybe the receipt just appeared
        try {
          await client.getTransactionReceipt({ hash: tx.signedTxHash });
          // Receipt appeared in the race — let the next poll cycle handle it
          return "pending";
        } catch {
          console.warn(
            `[MPC] Nonce consumed but no receipt — tx replaced. requestId=${tx.requestId}`,
          );
          mpcOutput = "00";
        }
      }
    } catch {
      // RPC error during nonce check — try again next cycle
      return "pending";
    }
  }

  if (mpcOutput === null) return "pending";

  // Report outcome to Canton
  return reportOutcome(config, tx, mpcOutput);
}

async function reportOutcome(
  config: MpcServiceConfig,
  tx: PendingTx,
  mpcOutput: string,
): Promise<CheckResult> {
  const signature = signMpcResponse(config.rootPrivateKey, tx.requestId, mpcOutput);

  try {
    console.log(`[MPC] Exercising ProvideEvmOutcomeSig for requestId=${tx.requestId}`);
    await exerciseChoiceWithRetry(
      config.userId,
      config.actAs,
      VAULT_ORCHESTRATOR,
      config.orchCid,
      "ProvideEvmOutcomeSig",
      {
        requester: tx.requester,
        requestId: tx.requestId,
        signature,
        mpcOutput,
      },
    );
    console.log(
      `[MPC] ProvideEvmOutcomeSig exercised for requestId=${tx.requestId} (output=${mpcOutput})`,
    );
    return "done";
  } catch (err) {
    if (isTransientError(err)) {
      console.warn(
        `[MPC] Transient error reporting outcome, will retry. requestId=${tx.requestId}`,
      );
      return "pending";
    }
    console.error(
      `[MPC] Fatal error reporting outcome for requestId=${tx.requestId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "failed";
  }
}
