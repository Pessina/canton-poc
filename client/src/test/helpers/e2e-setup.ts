import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CantonClient, type CreatedEvent } from "../../infra/canton-client.js";
import { findCreated, firstCreated } from "../../infra/canton-helpers.js";
import {
  VaultOrchestrator,
  Erc20Holding,
  EcdsaSignature,
  EvmTxOutcomeSignature,
  PendingEvmTx,
} from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import { MpcServer } from "../../mpc-service/server.js";
import { chainIdHexToCaip2, deriveDepositAddress } from "../../mpc/address-derivation.js";
import { computeRequestId, toSpkiPublicKey } from "../../mpc/crypto.js";
import { reconstructSignedTx, submitRawTransaction } from "../../evm/tx-builder.js";
import { loadEnv } from "../../config/env.js";
import {
  DEPOSIT_AMOUNT,
  fetchNonce,
  fetchGasParams,
  toCantonHex,
  fundFromFaucet,
} from "./sepolia-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DAR_PATH = resolve(__dirname, "../../../../.daml/dist/canton-mpc-poc-0.0.1.dar");

export const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
export const ECDSA_SIGNATURE = EcdsaSignature.templateId;
export const OUTCOME_SIGNATURE = EvmTxOutcomeSignature.templateId;
export const ERC20_HOLDING = Erc20Holding.templateId;

export const SEPOLIA_CHAIN_ID = 11155111;
export const GAS_LIMIT = 100_000n;
export const POLL_INTERVAL = 5_000;
export const POLL_TIMEOUT = 180_000;
export const KEY_VERSION = 1;
export const ALGO = "ECDSA";
export const DEST = "ethereum";

export type { PendingEvmTx, EcdsaSignature, EvmTxOutcomeSignature, Erc20Holding };

export function tryLoadEnv() {
  try {
    return loadEnv();
  } catch {
    return null;
  }
}

const canton = new CantonClient();

export async function pollForContract(
  parties: string[],
  templateId: string,
  predicate: (args: Record<string, unknown>) => boolean,
  label: string,
): Promise<CreatedEvent> {
  const startTime = Date.now();
  while (Date.now() - startTime < POLL_TIMEOUT) {
    const contracts = await canton.getActiveContracts(parties, templateId);
    const match = contracts.find((c) => predicate(c.createArgument as Record<string, unknown>));
    if (match) return match;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error(`Timed out waiting for ${label} (${POLL_TIMEOUT / 1000}s)`);
}

// ── Vault setup ──

export interface VaultSetup {
  canton: CantonClient;
  mpcServer: MpcServer;
  issuer: string;
  requester: string;
  mpc: string;
  orchCid: string;
  orchDisclosure: Awaited<ReturnType<CantonClient["getDisclosedContract"]>>;
  vaultAddress: `0x${string}`;
  vaultAddressPadded: string;
  userId: string;
}

export async function setupVault(
  env: ReturnType<typeof loadEnv>,
  userId: string,
  partyPrefix: string,
): Promise<VaultSetup> {
  await canton.uploadDar(DAR_PATH);

  const issuer = await canton.allocateParty(`${partyPrefix}Issuer`);
  const requester = await canton.allocateParty(`${partyPrefix}Requester`);
  const mpc = await canton.allocateParty(`${partyPrefix}Mpc`);
  await canton.createUser(userId, issuer, [requester, mpc]);

  const vaultAddress = deriveDepositAddress(
    env.MPC_ROOT_PUBLIC_KEY,
    `${env.VAULT_ID}${issuer}`,
    "root",
  );
  const vaultAddressPadded = vaultAddress.slice(2).padStart(64, "0");

  const mpcPubKeySpki = toSpkiPublicKey(env.MPC_ROOT_PUBLIC_KEY);
  const orchResult = await canton.createContract(userId, [issuer], VAULT_ORCHESTRATOR, {
    issuer,
    mpc,
    mpcPublicKey: mpcPubKeySpki,
    vaultAddress: vaultAddressPadded,
    vaultId: env.VAULT_ID,
  });
  const orchEvent = findCreated(orchResult.transaction.events, "VaultOrchestrator");
  const orchCid = orchEvent.contractId;
  const orchDisclosure = await canton.getDisclosedContract([issuer], VAULT_ORCHESTRATOR, orchCid);

  const mpcServer = new MpcServer({
    canton,
    orchCid,
    userId,
    parties: [issuer],
    rootPrivateKey: env.MPC_ROOT_PRIVATE_KEY,
    rpcUrl: env.SEPOLIA_RPC_URL,
  });
  await mpcServer.start();
  await mpcServer.waitUntilReady();

  return {
    canton,
    mpcServer,
    issuer,
    requester,
    mpc,
    orchCid,
    orchDisclosure,
    vaultAddress,
    vaultAddressPadded,
    userId,
  };
}

// ── Deposit flow ──

export interface DepositResult {
  holdingCid: string;
  holdingArgs: Erc20Holding;
  requestId: string;
  amountPadded: string;
  mpcOutput: string;
}

export async function executeDepositFlow(
  env: ReturnType<typeof loadEnv>,
  setup: VaultSetup,
  logPrefix = "[e2e]",
): Promise<DepositResult> {
  const { canton, issuer, requester, orchCid, orchDisclosure, vaultAddressPadded, userId } = setup;

  const requesterPath = requester;
  const depositAddress = deriveDepositAddress(
    env.MPC_ROOT_PUBLIC_KEY,
    `${env.VAULT_ID}${issuer}`,
    `${requester},${requesterPath}`,
  );
  console.log(`${logPrefix} Deposit address derived: ${depositAddress}`);

  await fundFromFaucet(
    env.SEPOLIA_RPC_URL,
    env.FAUCET_PRIVATE_KEY,
    depositAddress,
    env.ERC20_ADDRESS,
    DEPOSIT_AMOUNT,
  );

  const nonce = await fetchNonce(env.SEPOLIA_RPC_URL, depositAddress);
  const { maxFeePerGas, maxPriorityFeePerGas } = await fetchGasParams(env.SEPOLIA_RPC_URL);

  const amountPadded = toCantonHex(DEPOSIT_AMOUNT, 32);
  const erc20AddressNoPrefix = env.ERC20_ADDRESS.slice(2).toLowerCase();
  const evmParams = {
    to: erc20AddressNoPrefix,
    functionSignature: "transfer(address,uint256)",
    args: [vaultAddressPadded, amountPadded],
    value: toCantonHex(0n, 32),
    nonce: toCantonHex(BigInt(nonce), 32),
    gasLimit: toCantonHex(GAS_LIMIT, 32),
    maxFeePerGas: toCantonHex(maxFeePerGas, 32),
    maxPriorityFee: toCantonHex(maxPriorityFeePerGas, 32),
    chainId: toCantonHex(BigInt(SEPOLIA_CHAIN_ID), 32),
  };

  // ── Auth card flow ──
  console.log(`${logPrefix} RequestDepositAuth`);
  const proposalResult = await canton.exerciseChoice(
    userId,
    [requester],
    VAULT_ORCHESTRATOR,
    orchCid,
    "RequestDepositAuth",
    { requester },
    undefined,
    [orchDisclosure],
  );
  const proposalCid = firstCreated(proposalResult.transaction.events).contractId;

  console.log(`${logPrefix} ApproveDepositAuth`);
  const approveResult = await canton.exerciseChoice(
    userId,
    [issuer],
    VAULT_ORCHESTRATOR,
    orchCid,
    "ApproveDepositAuth",
    { proposalCid, remainingUses: 1 },
  );
  const authEvent = findCreated(approveResult.transaction.events, "DepositAuthorization");
  const authCid = authEvent.contractId;

  // ── Request deposit ──
  console.log(`${logPrefix} RequestEvmDeposit`);
  const depositResult = await canton.exerciseChoice(
    userId,
    [requester],
    VAULT_ORCHESTRATOR,
    orchCid,
    "RequestEvmDeposit",
    {
      requester,
      path: requesterPath,
      evmParams,
      authCidText: authCid,
      keyVersion: KEY_VERSION,
      algo: ALGO,
      dest: DEST,
      authCid,
    },
    undefined,
    [orchDisclosure],
  );

  const pending = findCreated(depositResult.transaction.events, "PendingEvmTx");
  const pendingCid = pending.contractId;
  const { requestId, path: pendingPath } = pending.createArgument as PendingEvmTx;

  // Cross-language requestId invariant
  const caip2Id = chainIdHexToCaip2(evmParams.chainId);
  const tsRequestId = computeRequestId(
    requester,
    evmParams,
    caip2Id,
    KEY_VERSION,
    pendingPath,
    ALGO,
    DEST,
    authCid,
  );
  if (tsRequestId.slice(2) !== requestId) {
    throw new Error(
      `${logPrefix} RequestId mismatch: TS=${tsRequestId.slice(2)}, Canton=${requestId}`,
    );
  }
  console.log(`${logPrefix} PendingEvmTx created (requestId=${requestId})`);

  // ── MPC signs ──
  const ecdsaSig = await pollForContract(
    [issuer],
    ECDSA_SIGNATURE,
    (args) => args.requestId === requestId,
    "EcdsaSignature (deposit)",
  );
  const ecdsaCid = ecdsaSig.contractId;
  const ecdsaArgs = ecdsaSig.createArgument as EcdsaSignature;
  console.log(`${logPrefix} EcdsaSignature observed`);

  // ── Submit to Sepolia ──
  const signedTx = reconstructSignedTx(evmParams, {
    r: `0x${ecdsaArgs.r}`,
    s: `0x${ecdsaArgs.s}`,
    v: Number(ecdsaArgs.v),
  });
  const txHash = await submitRawTransaction(env.SEPOLIA_RPC_URL, signedTx);
  console.log(`${logPrefix} Submitted signed tx: ${txHash}`);

  // ── Wait for outcome ──
  const outcome = await pollForContract(
    [issuer],
    OUTCOME_SIGNATURE,
    (args) => args.requestId === requestId,
    "EvmTxOutcomeSignature (deposit)",
  );
  const outcomeCid = outcome.contractId;
  const outcomeArgs = outcome.createArgument as EvmTxOutcomeSignature;
  console.log(`${logPrefix} EvmTxOutcomeSignature observed`);

  // ── Claim deposit ──
  console.log(`${logPrefix} ClaimEvmDeposit`);
  const claimResult = await canton.exerciseChoice(
    userId,
    [requester],
    VAULT_ORCHESTRATOR,
    orchCid,
    "ClaimEvmDeposit",
    { requester, pendingCid, outcomeCid, ecdsaCid },
    undefined,
    [orchDisclosure],
  );

  const holding = findCreated(claimResult.transaction.events, "Erc20Holding");
  console.log(`${logPrefix} Deposit complete (holdingCid=${holding.contractId})`);

  return {
    holdingCid: holding.contractId,
    holdingArgs: holding.createArgument as Erc20Holding,
    requestId,
    amountPadded,
    mpcOutput: outcomeArgs.mpcOutput,
  };
}
