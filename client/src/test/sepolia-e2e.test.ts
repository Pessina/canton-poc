import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hexToBigInt } from "viem";
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
} from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import { MpcServer } from "../mpc-service/server.js";
import { RelayerServer } from "../relayer/server.js";
import { deriveDepositAddress } from "../mpc/address-derivation.js";
import { loadSepoliaE2eEnv, toSpkiPublicKey } from "./helpers/e2e-env.js";
import {
  DEPOSIT_PATH,
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
const ERC20_HOLDING = Erc20Holding.templateId;

const SEPOLIA_CHAIN_ID = 11155111;
const GAS_LIMIT = 100_000n;
const POLL_INTERVAL = 5_000;
const POLL_TIMEOUT = 180_000;

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
  let relayerServer: RelayerServer;
  let issuer: string;
  let depositor: string;
  let orchCid: string;

  const USER_ID = "sepolia-e2e";

  beforeAll(async () => {
    await uploadDar(DAR_PATH);

    issuer = await allocateParty("Issuer");
    depositor = await allocateParty("SepoliaDepositor");
    await createUser(USER_ID, issuer, [depositor]);

    const mpcPubKeySpki = toSpkiPublicKey(env!.MPC_ROOT_PUBLIC_KEY);

    const orchResult = await createContract(USER_ID, [issuer], VAULT_ORCHESTRATOR, {
      issuer,
      mpcPublicKey: mpcPubKeySpki,
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

    relayerServer = new RelayerServer({
      orchCid,
      userId: USER_ID,
      parties: [issuer],
      issuerParty: issuer,
      rpcUrl: env!.SEPOLIA_RPC_URL,
    });

    await mpcServer.start();
    await mpcServer.waitUntilReady();
    await relayerServer.start();
    await relayerServer.waitUntilReady();
  }, 60_000);

  afterAll(() => {
    mpcServer.shutdown();
    relayerServer.shutdown();
  });

  it("completes full deposit flow through Sepolia", async () => {
    // ── Pre-flight ──
    const depositAddress = deriveDepositAddress(env!.MPC_ROOT_PUBLIC_KEY, depositor, DEPOSIT_PATH);
    console.log(`[e2e] Deposit address derived: ${depositAddress}`);

    const vaultAddress = deriveDepositAddress(env!.MPC_ROOT_PUBLIC_KEY, issuer, "vault");
    console.log(`[e2e] Vault address derived: ${vaultAddress}`);

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

    const recipientPadded = toCantonHex(hexToBigInt(vaultAddress), 32);
    const amountPadded = toCantonHex(DEPOSIT_AMOUNT, 32);
    const erc20AddressNoPrefix = env!.ERC20_ADDRESS.slice(2).toLowerCase();

    const evmParams = {
      to: erc20AddressNoPrefix,
      functionSignature: "transfer(address,uint256)",
      args: [recipientPadded, amountPadded],
      value: toCantonHex(0n, 32),
      nonce: toCantonHex(BigInt(nonce), 32),
      gasLimit: toCantonHex(GAS_LIMIT, 32),
      maxFeePerGas: toCantonHex(maxFeePerGas, 32),
      maxPriorityFee: toCantonHex(maxPriorityFeePerGas, 32),
      chainId: toCantonHex(BigInt(SEPOLIA_CHAIN_ID), 32),
    };

    // ── User → Canton: RequestEvmDeposit (evmParams, path) ──
    console.log("[e2e] User → Canton: RequestEvmDeposit (evmParams, path)");
    const depositResult = await exerciseChoice(
      USER_ID,
      [issuer, depositor],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestEvmDeposit",
      {
        requester: depositor,
        path: DEPOSIT_PATH,
        evmParams,
      },
    );

    // ── Canton: creates PendingEvmDeposit ──
    const pending = findCreated(depositResult.transaction.events, "PendingEvmDeposit");
    expect(pending).toBeDefined();
    const pendingArgs = pending!.createArgument as Record<string, unknown>;
    const requestId = pendingArgs.requestId as string;
    console.log(`[e2e] Canton: creates PendingEvmDeposit (requestId=${requestId})`);

    // ── Canton → MPC Service: observes PendingEvmDeposit ──
    // ── MPC Service: buildCalldata, serializeTx, keccak256→txHash, deriveChildKey, sign(txHash) ──
    // ── MPC Service → Canton: SignEvmTx → EcdsaSignature (r, s, v) ──
    console.log("[e2e] Waiting for MPC to sign... (Canton → MPC → Canton: SignEvmTx)");
    const ecdsaSig = await pollForContract(
      [issuer],
      ECDSA_SIGNATURE,
      (args) => args.requestId === requestId,
      "EcdsaSignature",
    );
    const ecdsaArgs = ecdsaSig.createArgument as Record<string, unknown>;
    console.log(
      `[e2e] MPC Service → Canton: EcdsaSignature created (r=${(ecdsaArgs.r as string).slice(0, 16)}..., v=${String(ecdsaArgs.v)})`,
    );

    // ── Relayer: observes EcdsaSignature → reconstructSignedTx → eth_sendRawTransaction ──
    // ── MPC Service: polls Sepolia for receipt → verifies status → signs outcome ──
    // ── MPC Service → Canton: ProvideEvmOutcomeSig → EvmTxOutcomeSignature ──
    // ── Relayer: observes EvmTxOutcomeSignature → ClaimEvmDeposit → Erc20Holding ──
    // NOTE: EvmTxOutcomeSignature is transient — archived immediately on claim.
    // We skip polling for it and go straight to the final Erc20Holding.
    console.log(
      "[e2e] Waiting for Relayer → Sepolia, MPC receipt verification, and ClaimEvmDeposit...",
    );
    const holding = await pollForContract(
      [issuer, depositor],
      ERC20_HOLDING,
      (args) => args.owner === depositor,
      "Erc20Holding",
    );
    const holdingArgs = holding.createArgument as Record<string, unknown>;
    console.log(
      `[e2e] Canton: creates Erc20Holding (owner=${depositor}, amount=${String(holdingArgs.amount)})`,
    );

    // ── User: assert balance ──
    console.log("[e2e] User: assert balance");
    expect(holdingArgs.owner).toBe(depositor);
    expect(holdingArgs.issuer).toBe(issuer);
    expect(parseFloat(holdingArgs.amount as string)).toBe(parseFloat(DEPOSIT_AMOUNT.toString()));
    console.log("[e2e] All assertions passed");
  }, 300_000);
});
