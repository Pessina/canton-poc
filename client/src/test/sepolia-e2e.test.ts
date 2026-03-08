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
  type Event,
  type CreatedEvent,
} from "../infra/canton-client.js";
import {
  VaultOrchestrator,
  Erc20Holding,
  EcdsaSignature,
  EvmTxOutcomeSignature,
} from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import { MpcServer } from "../mpc-service/server.js";
import { deriveDepositAddress } from "../mpc/address-derivation.js";
import { reconstructSignedTx, submitRawTransaction } from "../evm/tx-builder.js";
import { loadSepoliaE2eEnv, toSpkiPublicKey } from "./helpers/e2e-env.js";
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

function getCreatedEvent(event: Event): CreatedEvent | undefined {
  if ("CreatedEvent" in event) return event.CreatedEvent;
  return undefined;
}

function findCreated(
  events: Event[] | undefined,
  templateFragment: string,
): CreatedEvent | undefined {
  const event = events?.find((e) => {
    const created = getCreatedEvent(e);
    return created?.templateId.includes(templateFragment);
  });
  return event ? getCreatedEvent(event) : undefined;
}

function firstCreatedCid(events: Event[] | undefined): string {
  const first = events?.[0];
  if (!first) throw new Error("No events in transaction");
  const created = getCreatedEvent(first);
  if (!created) throw new Error("First event is not a CreatedEvent");
  return created.contractId;
}

function packageIdFromTemplateId(templateId: string): string {
  const packageId = templateId.split(":")[0];
  if (!packageId) throw new Error(`Invalid templateId: ${templateId}`);
  return packageId;
}

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

const env = loadSepoliaE2eEnv();
const describeIf = env ? describe : describe.skip;

describeIf("sepolia e2e deposit lifecycle", () => {
  let mpcServer: MpcServer;
  let issuer: string;
  let depositor: string;
  let mpc: string;
  let orchCid: string;
  let packageId: string;
  let vaultAddressPadded: string;

  const USER_ID = "sepolia-e2e";

  beforeAll(async () => {
    await uploadDar(DAR_PATH);

    issuer = await allocateParty("Issuer");
    depositor = await allocateParty("SepoliaDepositor");
    mpc = await allocateParty("Mpc");
    await createUser(USER_ID, issuer, [depositor, mpc]);

    packageId = packageIdFromTemplateId(VaultOrchestrator.templateIdWithPackageId);
    const vaultAddress = deriveDepositAddress(env!.MPC_ROOT_PUBLIC_KEY, `${packageId}${issuer}`, "root");
    vaultAddressPadded = vaultAddress.slice(2).padStart(64, "0");

    const mpcPubKeySpki = toSpkiPublicKey(env!.MPC_ROOT_PUBLIC_KEY);
    const orchResult = await createContract(USER_ID, [issuer], VAULT_ORCHESTRATOR, {
      issuer,
      mpc,
      mpcPublicKey: mpcPubKeySpki,
      vaultAddress: vaultAddressPadded,
    });
    const orchEvent = findCreated(orchResult.transaction.events, "VaultOrchestrator");
    orchCid = orchEvent!.contractId;

    mpcServer = new MpcServer({
      orchCid,
      userId: USER_ID,
      parties: [issuer],
      rootPrivateKey: env!.MPC_ROOT_PRIVATE_KEY,
      rpcUrl: env!.SEPOLIA_RPC_URL,
    });

    await mpcServer.start();
    await mpcServer.waitUntilReady();
  }, 60_000);

  afterAll(() => {
    mpcServer.shutdown();
  });

  it("completes full deposit flow through Sepolia", async () => {
    // ── Pre-flight ──
    const requesterPath = depositor;
    const depositAddress = deriveDepositAddress(
      env!.MPC_ROOT_PUBLIC_KEY,
      `${packageId}${issuer}`,
      `${depositor}${requesterPath}`,
    );
    console.log(`[e2e] Deposit address derived: ${depositAddress}`);

    // Fund the deposit address from the faucet (idempotent)
    await fundFromFaucet(
      env!.SEPOLIA_RPC_URL,
      env!.FAUCET_PRIVATE_KEY,
      depositAddress,
      env!.ERC20_ADDRESS,
      DEPOSIT_AMOUNT,
    );

    const balance = await checkErc20Balance(
      env!.SEPOLIA_RPC_URL,
      env!.ERC20_ADDRESS,
      depositAddress,
    );
    expect(balance).toBeGreaterThanOrEqual(DEPOSIT_AMOUNT);
    console.log(`[e2e] ERC20 balance: ${balance} (need >= ${DEPOSIT_AMOUNT})`);

    const nonce = await fetchNonce(env!.SEPOLIA_RPC_URL, depositAddress);
    const { maxFeePerGas, maxPriorityFeePerGas } = await fetchGasParams(env!.SEPOLIA_RPC_URL);
    console.log(
      `[e2e] Sepolia state: nonce=${nonce}, maxFeePerGas=${maxFeePerGas}, maxPriorityFeePerGas=${maxPriorityFeePerGas}`,
    );

    const amountPadded = toCantonHex(DEPOSIT_AMOUNT, 32);
    const erc20AddressNoPrefix = env!.ERC20_ADDRESS.slice(2).toLowerCase();
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
    console.log("[e2e] User → Canton: RequestDepositAuth");
    const proposalResult = await exerciseChoice(
      USER_ID,
      [depositor],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestDepositAuth",
      { requester: depositor },
      [issuer],
    );
    const proposalCid = firstCreatedCid(proposalResult.transaction.events);

    console.log("[e2e] Issuer → Canton: ApproveDepositAuth");
    const approveResult = await exerciseChoice(
      USER_ID,
      [issuer],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ApproveDepositAuth",
      { proposalCid, remainingUses: 1 },
    );
    const authEvent = findCreated(approveResult.transaction.events, "DepositAuthorization");
    const authCid = authEvent!.contractId;

    // ── User → Canton: RequestEvmDeposit (evmParams, path=requesterParty) ──
    console.log("[e2e] User → Canton: RequestEvmDeposit");
    const depositResult = await exerciseChoice(
      USER_ID,
      [depositor],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestEvmDeposit",
      {
        requester: depositor,
        path: requesterPath,
        evmParams,
        authCidText: authCid,
        keyVersion: KEY_VERSION,
        algo: ALGO,
        dest: DEST,
        authCid,
      },
      [issuer],
    );

    const pending = findCreated(depositResult.transaction.events, "PendingEvmDeposit");
    expect(pending).toBeDefined();
    const pendingCid = pending!.contractId;
    const pendingArgs = pending!.createArgument as Record<string, unknown>;
    const requestId = pendingArgs.requestId as string;
    console.log(`[e2e] PendingEvmDeposit created (requestId=${requestId})`);

    // ── MPC signs tx on Canton ──
    const ecdsaSig = await pollForContract(
      [issuer],
      ECDSA_SIGNATURE,
      (args) => args.requestId === requestId,
      "EcdsaSignature",
    );
    const ecdsaCid = ecdsaSig.contractId;
    const ecdsaArgs = ecdsaSig.createArgument as Record<string, unknown>;
    console.log("[e2e] EcdsaSignature observed");

    // ── User submits signed tx to Sepolia ──
    const signedTx = reconstructSignedTx(evmParams, {
      r: `0x${ecdsaArgs.r as string}`,
      s: `0x${ecdsaArgs.s as string}`,
      v: Number(ecdsaArgs.v),
    });
    const txHash = await submitRawTransaction(env!.SEPOLIA_RPC_URL, signedTx);
    console.log(`[e2e] User submitted signed tx: ${txHash}`);

    // ── MPC verifies Sepolia receipt and posts outcome signature ──
    const outcome = await pollForContract(
      [issuer],
      OUTCOME_SIGNATURE,
      (args) => args.requestId === requestId,
      "EvmTxOutcomeSignature",
    );
    const outcomeCid = outcome.contractId;
    const outcomeArgs = outcome.createArgument as Record<string, unknown>;
    expect(outcomeArgs.mpcOutput).toBe("01");
    console.log("[e2e] EvmTxOutcomeSignature observed");

    // ── User claims on Canton (controller requester — only depositor signs) ──
    const claimResult = await exerciseChoice(
      USER_ID,
      [depositor],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ClaimEvmDeposit",
      {
        requester: depositor,
        pendingCid,
        outcomeCid,
        ecdsaCid,
      },
      [issuer],
    );

    const holding = findCreated(claimResult.transaction.events, "Erc20Holding");
    expect(holding).toBeDefined();
    const holdingArgs = holding!.createArgument as Record<string, unknown>;
    expect(holdingArgs.owner).toBe(depositor);
    expect(holdingArgs.issuer).toBe(issuer);
    expect(holdingArgs.amount).toBe(amountPadded);

    const activeHoldings = await getActiveContracts([issuer, depositor], ERC20_HOLDING);
    expect(activeHoldings.some((c) => (c.createArgument as Record<string, unknown>).owner === depositor)).toBe(
      true,
    );
    console.log("[e2e] All assertions passed");
  }, 300_000);
});
