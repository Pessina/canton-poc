import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allocateParty,
  createUser,
  uploadDar,
  createContract,
  exerciseChoice,
  getActiveContracts,
  getDisclosedContract,
  type CreatedEvent,
} from "../infra/canton-client.js";
import { findCreated, firstCreated } from "../infra/canton-helpers.js";
import {
  VaultOrchestrator,
  Erc20Holding,
  EcdsaSignature,
  EvmTxOutcomeSignature,
  PendingEvmTx,
} from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import { MpcServer } from "../mpc-service/server.js";
import { chainIdHexToCaip2, deriveDepositAddress } from "../mpc/address-derivation.js";
import { computeRequestId, toSpkiPublicKey } from "../mpc/crypto.js";
import { reconstructSignedTx, submitRawTransaction } from "../evm/tx-builder.js";
import { loadEnv } from "../config/env.js";
import {
  DEPOSIT_AMOUNT,
  fetchNonce,
  fetchGasParams,
  checkErc20Balance,
  toCantonHex,
  fundFromFaucet,
} from "./helpers/sepolia-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAR_PATH = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");
const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
const ECDSA_SIGNATURE = EcdsaSignature.templateId;
const OUTCOME_SIGNATURE = EvmTxOutcomeSignature.templateId;
const ERC20_HOLDING = Erc20Holding.templateId;

const SEPOLIA_CHAIN_ID = 11155111;
const GAS_LIMIT = 100_000n;
const POLL_INTERVAL = 5_000;
const POLL_TIMEOUT = 180_000;

const KEY_VERSION = 1;
const ALGO = "ECDSA";
const DEST = "ethereum";

async function pollForContract(
  parties: string[],
  templateId: string,
  predicate: (args: Record<string, unknown>) => boolean,
  label: string,
): Promise<CreatedEvent> {
  const startTime = Date.now();
  while (Date.now() - startTime < POLL_TIMEOUT) {
    const contracts = await getActiveContracts(parties, templateId);
    const match = contracts.find((c) => predicate(c.createArgument as Record<string, unknown>));
    if (match) return match;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error(`Timed out waiting for ${label} (${POLL_TIMEOUT / 1000}s)`);
}

let env: ReturnType<typeof loadEnv> | null = null;
try {
  env = loadEnv();
} catch {
  // .env missing or incomplete — skip E2E tests
}
const describeIf = env ? describe : describe.skip;

describeIf("sepolia e2e withdrawal lifecycle", () => {
  let mpcServer: MpcServer;
  let issuer: string;
  let requester: string;
  let mpc: string;
  let orchCid: string;
  let orchDisclosure: Awaited<ReturnType<typeof getDisclosedContract>>;
  const VAULT_ID = env!.VAULT_ID;
  let vaultAddressPadded: string;
  let holdingCid: string;

  const USER_ID = "sepolia-withdrawal-e2e";

  beforeAll(async () => {
    await uploadDar(DAR_PATH);

    issuer = await allocateParty("WdlIssuer");
    requester = await allocateParty("WdlRequester");
    mpc = await allocateParty("WdlMpc");
    await createUser(USER_ID, issuer, [requester, mpc]);

    const vaultAddress = deriveDepositAddress(
      env!.MPC_ROOT_PUBLIC_KEY,
      `${VAULT_ID}${issuer}`,
      "root",
    );
    vaultAddressPadded = vaultAddress.slice(2).padStart(64, "0");

    const mpcPubKeySpki = toSpkiPublicKey(env!.MPC_ROOT_PUBLIC_KEY);
    const orchResult = await createContract(USER_ID, [issuer], VAULT_ORCHESTRATOR, {
      issuer,
      mpc,
      mpcPublicKey: mpcPubKeySpki,
      vaultAddress: vaultAddressPadded,
      vaultId: VAULT_ID,
    });
    const orchEvent = findCreated(orchResult.transaction.events, "VaultOrchestrator");
    orchCid = orchEvent.contractId;
    orchDisclosure = await getDisclosedContract([issuer], VAULT_ORCHESTRATOR, orchCid);

    // ── Do a full deposit to get an Erc20Holding ──
    const requesterPath = requester;
    const depositAddress = deriveDepositAddress(
      env!.MPC_ROOT_PUBLIC_KEY,
      `${VAULT_ID}${issuer}`,
      `${requester},${requesterPath}`,
    );
    console.log(`[wdl-e2e] Deposit address derived: ${depositAddress}`);

    // Fund deposit address
    await fundFromFaucet(
      env!.SEPOLIA_RPC_URL,
      env!.FAUCET_PRIVATE_KEY,
      depositAddress,
      env!.ERC20_ADDRESS,
      DEPOSIT_AMOUNT,
    );

    // Also fund vault address with ERC20 (for the withdrawal tx)
    await fundFromFaucet(
      env!.SEPOLIA_RPC_URL,
      env!.FAUCET_PRIVATE_KEY,
      vaultAddress,
      env!.ERC20_ADDRESS,
      DEPOSIT_AMOUNT,
    );

    // Start MPC server before deposit flow
    mpcServer = new MpcServer({
      orchCid,
      userId: USER_ID,
      parties: [issuer],
      rootPrivateKey: env!.MPC_ROOT_PRIVATE_KEY,
      rpcUrl: env!.SEPOLIA_RPC_URL,
    });
    await mpcServer.start();
    await mpcServer.waitUntilReady();

    // Auth card flow
    const depositNonce = await fetchNonce(env!.SEPOLIA_RPC_URL, depositAddress);
    const { maxFeePerGas, maxPriorityFeePerGas } = await fetchGasParams(env!.SEPOLIA_RPC_URL);
    const amountPadded = toCantonHex(DEPOSIT_AMOUNT, 32);
    const erc20AddressNoPrefix = env!.ERC20_ADDRESS.slice(2).toLowerCase();

    const depositEvmParams = {
      to: erc20AddressNoPrefix,
      functionSignature: "transfer(address,uint256)",
      args: [vaultAddressPadded, amountPadded],
      value: toCantonHex(0n, 32),
      nonce: toCantonHex(BigInt(depositNonce), 32),
      gasLimit: toCantonHex(GAS_LIMIT, 32),
      maxFeePerGas: toCantonHex(maxFeePerGas, 32),
      maxPriorityFee: toCantonHex(maxPriorityFeePerGas, 32),
      chainId: toCantonHex(BigInt(SEPOLIA_CHAIN_ID), 32),
    };

    const proposalResult = await exerciseChoice(
      USER_ID,
      [requester],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestDepositAuth",
      { requester },
      undefined,
      [orchDisclosure],
    );
    const proposalCid = firstCreated(proposalResult.transaction.events).contractId;

    const approveResult = await exerciseChoice(
      USER_ID,
      [issuer],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ApproveDepositAuth",
      { proposalCid, remainingUses: 1 },
    );
    const authEvent = findCreated(approveResult.transaction.events, "DepositAuthorization");
    const authCid = authEvent.contractId;

    const depositResult = await exerciseChoice(
      USER_ID,
      [requester],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestEvmDeposit",
      {
        requester,
        path: requesterPath,
        evmParams: depositEvmParams,
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
    const { requestId } = pending.createArgument as PendingEvmTx;

    // Wait for MPC to sign
    const ecdsaSig = await pollForContract(
      [issuer],
      ECDSA_SIGNATURE,
      (args) => args.requestId === requestId,
      "EcdsaSignature (deposit)",
    );
    const ecdsaCid = ecdsaSig.contractId;
    const ecdsaArgs = ecdsaSig.createArgument as EcdsaSignature;

    // Submit deposit tx to Sepolia
    const signedTx = reconstructSignedTx(depositEvmParams, {
      r: `0x${ecdsaArgs.r}`,
      s: `0x${ecdsaArgs.s}`,
      v: Number(ecdsaArgs.v),
    });
    await submitRawTransaction(env!.SEPOLIA_RPC_URL, signedTx);

    // Wait for outcome
    const outcome = await pollForContract(
      [issuer],
      OUTCOME_SIGNATURE,
      (args) => args.requestId === requestId,
      "EvmTxOutcomeSignature (deposit)",
    );
    const outcomeCid = outcome.contractId;

    // Claim deposit
    const claimResult = await exerciseChoice(
      USER_ID,
      [requester],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ClaimEvmDeposit",
      { requester, pendingCid, outcomeCid, ecdsaCid },
      undefined,
      [orchDisclosure],
    );

    const holding = findCreated(claimResult.transaction.events, "Erc20Holding");
    holdingCid = holding.contractId;
    console.log(`[wdl-e2e] Deposit complete, holdingCid=${holdingCid}`);
  }, 600_000);

  afterAll(() => {
    mpcServer.shutdown();
  });

  it("completes full withdrawal flow through Sepolia", async () => {
    const erc20AddressNoPrefix = env!.ERC20_ADDRESS.slice(2).toLowerCase();
    const amountPadded = toCantonHex(DEPOSIT_AMOUNT, 32);

    // Recipient is the faucet address (send tokens back)
    const { privateKeyToAddress } = await import("viem/accounts");
    const recipientAddress = privateKeyToAddress(env!.FAUCET_PRIVATE_KEY).slice(2).toLowerCase();
    const recipientPadded = recipientAddress.padStart(64, "0");

    // Fetch vault nonce and gas
    const vaultAddress = deriveDepositAddress(
      env!.MPC_ROOT_PUBLIC_KEY,
      `${VAULT_ID}${issuer}`,
      "root",
    );
    const vaultNonce = await fetchNonce(env!.SEPOLIA_RPC_URL, vaultAddress);
    const { maxFeePerGas, maxPriorityFeePerGas } = await fetchGasParams(env!.SEPOLIA_RPC_URL);

    const evmParams = {
      to: erc20AddressNoPrefix,
      functionSignature: "transfer(address,uint256)",
      args: [recipientPadded, amountPadded],
      value: toCantonHex(0n, 32),
      nonce: toCantonHex(BigInt(vaultNonce), 32),
      gasLimit: toCantonHex(GAS_LIMIT, 32),
      maxFeePerGas: toCantonHex(maxFeePerGas, 32),
      maxPriorityFee: toCantonHex(maxPriorityFeePerGas, 32),
      chainId: toCantonHex(BigInt(SEPOLIA_CHAIN_ID), 32),
    };

    // Check recipient balance before withdrawal
    const balanceBefore = await checkErc20Balance(
      env!.SEPOLIA_RPC_URL,
      env!.ERC20_ADDRESS,
      `0x${recipientAddress}`,
    );
    console.log(`[wdl-e2e] Recipient ERC20 balance before: ${balanceBefore}`);

    // ── Request withdrawal ──
    console.log("[wdl-e2e] User → Canton: RequestEvmWithdrawal");
    const wdlResult = await exerciseChoice(
      USER_ID,
      [requester],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestEvmWithdrawal",
      {
        requester,
        evmParams,
        recipientAddress: recipientPadded,
        balanceCidText: holdingCid,
        keyVersion: KEY_VERSION,
        algo: ALGO,
        dest: DEST,
        balanceCid: holdingCid,
      },
      undefined,
      [orchDisclosure],
    );

    const pendingWdl = findCreated(wdlResult.transaction.events, "PendingEvmTx");
    const pendingWdlCid = pendingWdl.contractId;
    const { requestId, path: pendingPath } = pendingWdl.createArgument as PendingEvmTx;
    expect(pendingPath).toBe("root");

    const caip2Id = chainIdHexToCaip2(evmParams.chainId);
    const tsRequestId = computeRequestId(
      requester,
      evmParams,
      caip2Id,
      KEY_VERSION,
      "root",
      ALGO,
      DEST,
      holdingCid,
    );
    expect(tsRequestId.slice(2)).toBe(requestId);
    console.log(`[wdl-e2e] PendingEvmTx created (requestId=${requestId})`);

    // ── MPC signs withdrawal tx on Canton ──
    const ecdsaSig = await pollForContract(
      [issuer],
      ECDSA_SIGNATURE,
      (args) => args.requestId === requestId,
      "EcdsaSignature (withdrawal)",
    );
    const ecdsaCid = ecdsaSig.contractId;
    const ecdsaArgs = ecdsaSig.createArgument as EcdsaSignature;
    console.log("[wdl-e2e] EcdsaSignature observed");

    // ── User submits signed withdrawal tx to Sepolia ──
    const signedTx = reconstructSignedTx(evmParams, {
      r: `0x${ecdsaArgs.r}`,
      s: `0x${ecdsaArgs.s}`,
      v: Number(ecdsaArgs.v),
    });
    const txHash = await submitRawTransaction(env!.SEPOLIA_RPC_URL, signedTx);
    console.log(`[wdl-e2e] User submitted signed withdrawal tx: ${txHash}`);

    // ── MPC verifies Sepolia receipt and posts outcome signature ──
    const outcome = await pollForContract(
      [issuer],
      OUTCOME_SIGNATURE,
      (args) => args.requestId === requestId,
      "EvmTxOutcomeSignature (withdrawal)",
    );
    const outcomeCid = outcome.contractId;
    const outcomeArgs = outcome.createArgument as EvmTxOutcomeSignature;
    expect(outcomeArgs.mpcOutput).toBe("01");
    console.log("[wdl-e2e] EvmTxOutcomeSignature observed");

    // ── User completes withdrawal on Canton ──
    await exerciseChoice(
      USER_ID,
      [requester],
      VAULT_ORCHESTRATOR,
      orchCid,
      "CompleteEvmWithdrawal",
      {
        requester,
        pendingCid: pendingWdlCid,
        outcomeCid,
        ecdsaCid,
      },
      undefined,
      [orchDisclosure],
    );

    // CompleteEvmWithdrawal succeeded (no throw).
    // On success (mpcOutput=="01"): returns None — no refund Erc20Holding created.
    const holdings = await getActiveContracts([issuer, requester], ERC20_HOLDING);
    const refund = holdings.find((c) => (c.createArgument as Erc20Holding).owner === requester);
    expect(refund).toBeUndefined();

    // Verify recipient balance increased on Sepolia
    const balanceAfter = await checkErc20Balance(
      env!.SEPOLIA_RPC_URL,
      env!.ERC20_ADDRESS,
      `0x${recipientAddress}`,
    );
    console.log(`[wdl-e2e] Recipient ERC20 balance after: ${balanceAfter}`);
    expect(balanceAfter).toBeGreaterThan(balanceBefore);

    console.log("[wdl-e2e] All withdrawal assertions passed");
  }, 300_000);
});
