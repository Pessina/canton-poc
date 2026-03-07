import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRequestId, type EvmTransactionParams } from "../mpc/crypto.js";
import { deriveChildPrivateKey, signEvmTxHash, signMpcResponse } from "../mpc-service/signer.js";
import { chainIdHexToCaip2, deriveDepositAddress } from "../mpc/address-derivation.js";
import { serializeUnsignedTx, type CantonEvmParams } from "../evm/tx-builder.js";
import { keccak256, type Hex } from "viem";
import {
  allocateParty,
  createUser,
  uploadDar,
  createContract,
  exerciseChoice,
  getActiveContracts,
  type TransactionResponse,
  type Event,
  type CreatedEvent,
} from "../infra/canton-client.js";
import {
  VaultOrchestrator,
  Erc20Holding,
} from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MPC_ROOT_PRIVATE_KEY =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex;
const MPC_ROOT_PUBLIC_KEY =
  "04bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4";
const MPC_PUB_KEY_SPKI =
  "3056301006072a8648ce3d020106052b8104000a03420004bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4";
const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
const ERC20_HOLDING = Erc20Holding.templateId;

const VAULT_PATH = "root";
const KEY_VERSION = 1;
const ALGO = "ECDSA";
const DEST = "ethereum";

function buildSampleEvmParams(vaultAddress: Hex): EvmTransactionParams {
  return {
    to: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    functionSignature: "transfer(address,uint256)",
    args: [
      vaultAddress.slice(2).padStart(64, "0"),
      "0000000000000000000000000000000000000000000000000000000005f5e100",
    ],
    value: "0000000000000000000000000000000000000000000000000000000000000000",
    nonce: "0000000000000000000000000000000000000000000000000000000000000001",
    gasLimit: "000000000000000000000000000000000000000000000000000000000000c350",
    maxFeePerGas: "00000000000000000000000000000000000000000000000000000001dcd65000",
    maxPriorityFee: "000000000000000000000000000000000000000000000000000000003b9aca00",
    chainId: "0000000000000000000000000000000000000000000000000000000000aa36a7",
  };
}

function getCreatedEvent(event: Event): CreatedEvent | undefined {
  if ("CreatedEvent" in event) return event.CreatedEvent;
  return undefined;
}

function getArgs(event: CreatedEvent): Record<string, unknown> {
  return event.createArgument as Record<string, unknown>;
}

function findCreated(res: TransactionResponse, templateFragment: string) {
  const event = res.transaction.events!.find((e) => {
    const created = getCreatedEvent(e);
    return created?.templateId.includes(templateFragment);
  });
  return event ? getCreatedEvent(event)! : undefined;
}

function firstCreatedCid(res: TransactionResponse): string {
  const first = res.transaction.events?.[0];
  if (!first) throw new Error("No events in transaction");
  const created = getCreatedEvent(first);
  if (!created) throw new Error("First event is not a CreatedEvent");
  return created.contractId;
}

function packageIdFromTemplateId(templateId: string): string {
  const parts = templateId.split(":");
  const packageId = parts[0];
  if (!packageId) throw new Error(`Invalid templateId: ${templateId}`);
  return packageId;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
let issuer: string;
let depositor: string;
let mpc: string;
const RUN_ID = Math.random().toString(36).slice(2, 8);
const ADMIN_USER = `e2e-${RUN_ID}`;

beforeAll(async () => {
  const darPath = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");
  await uploadDar(darPath);

  issuer = await allocateParty(`Issuer_${RUN_ID}`);
  depositor = await allocateParty(`Depositor_${RUN_ID}`);
  mpc = await allocateParty(`Mpc_${RUN_ID}`);

  await createUser(ADMIN_USER, issuer, [depositor, mpc]);
}, 30_000);

// ---------------------------------------------------------------------------
// Full deposit lifecycle e2e
// ---------------------------------------------------------------------------
describe("deposit e2e lifecycle", () => {
  it("completes the full deposit flow from request to Erc20Holding", async () => {
    const packageId = packageIdFromTemplateId(VaultOrchestrator.templateIdWithPackageId);
    const requesterPath = depositor;
    const caip2Id = chainIdHexToCaip2("0000000000000000000000000000000000000000000000000000000000aa36a7");
    const vaultAddress = deriveDepositAddress(MPC_ROOT_PUBLIC_KEY, packageId, VAULT_PATH, caip2Id);
    const sampleEvmParams = buildSampleEvmParams(vaultAddress);

    // Step 1: Create VaultOrchestrator
    const orchResult = await createContract(ADMIN_USER, [issuer], VAULT_ORCHESTRATOR, {
      issuer,
      mpc,
      mpcPublicKey: MPC_PUB_KEY_SPKI,
      vaultAddress: sampleEvmParams.args[0],
    });
    const orchCid = firstCreatedCid(orchResult);

    // Step 2: Auth card flow — RequestDepositAuth → ApproveDepositAuth
    // controller is requester; issuer provides visibility via readAs (not actAs)
    const proposalResult = await exerciseChoice(
      ADMIN_USER,
      [depositor],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestDepositAuth",
      { requester: depositor },
      [issuer],
    );
    const proposalCid = firstCreatedCid(proposalResult);

    const approveResult = await exerciseChoice(
      ADMIN_USER,
      [issuer],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ApproveDepositAuth",
      { proposalCid, remainingUses: 3 },
    );
    const authEvent = findCreated(approveResult, "DepositAuthorization");
    expect(authEvent).toBeDefined();
    const authCid = authEvent!.contractId;

    // Step 3: RequestEvmDeposit (controller requester — only depositor signs)
    const depositResult = await exerciseChoice(
      ADMIN_USER,
      [depositor],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestEvmDeposit",
      {
        requester: depositor,
        path: requesterPath,
        evmParams: sampleEvmParams,
        contractId: "",
        authContractId: "",
        keyVersion: KEY_VERSION,
        algo: ALGO,
        dest: DEST,
        authCid,
      },
      [issuer],
    );

    const pending = findCreated(depositResult, "PendingEvmDeposit");
    expect(pending).toBeDefined();
    const pendingArgs = getArgs(pending!);
    const requestId = pendingArgs.requestId as string;

    const tsRequestId = computeRequestId(
      depositor,
      sampleEvmParams,
      caip2Id,
      KEY_VERSION,
      requesterPath,
      ALGO,
      DEST,
      "",
      "",
    );
    expect(tsRequestId.slice(2)).toBe(requestId);

    // Step 4: MPC signs the EVM transaction
    const predecessorId = packageIdFromTemplateId(pending!.templateId);
    const childPrivateKey = deriveChildPrivateKey(
      MPC_ROOT_PRIVATE_KEY,
      predecessorId,
      depositor,
      chainIdHexToCaip2(sampleEvmParams.chainId),
    );
    const evmParamsForTx: CantonEvmParams = sampleEvmParams;
    const serializedUnsigned = serializeUnsignedTx(evmParamsForTx);
    const txHash = keccak256(serializedUnsigned);
    const { r, s, v } = signEvmTxHash(childPrivateKey, txHash);

    // Step 5: SignEvmTx
    const signResult = await exerciseChoice(
      ADMIN_USER,
      [issuer],
      VAULT_ORCHESTRATOR,
      orchCid,
      "SignEvmTx",
      { requester: depositor, requestId, r, s, v },
    );

    const ecdsaSig = findCreated(signResult, "EcdsaSignature");
    expect(ecdsaSig).toBeDefined();
    const ecdsaArgs = getArgs(ecdsaSig!);
    expect(ecdsaArgs.requestId).toBe(requestId);
    expect(ecdsaArgs.r).toBe(r);
    expect(ecdsaArgs.s).toBe(s);

    // Step 6: ProvideEvmOutcomeSig (simulate success = "01")
    const mpcOutput = "01";
    const outcomeSig = signMpcResponse(MPC_ROOT_PRIVATE_KEY, requestId, mpcOutput);

    const outcomeResult = await exerciseChoice(
      ADMIN_USER,
      [issuer],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ProvideEvmOutcomeSig",
      { requester: depositor, requestId, signature: outcomeSig, mpcOutput },
    );

    const outcomeEvent = findCreated(outcomeResult, "EvmTxOutcomeSignature");
    expect(outcomeEvent).toBeDefined();
    const outcomeCid = outcomeEvent!.contractId;
    const ecdsaCid = ecdsaSig!.contractId;

    // Step 7: ClaimEvmDeposit (controller requester — only depositor signs)
    const pendingCid = pending!.contractId;

    const claimResult = await exerciseChoice(
      ADMIN_USER,
      [depositor],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ClaimEvmDeposit",
      { requester: depositor, pendingCid, outcomeCid, ecdsaCid },
      [issuer],
    );

    const holding = findCreated(claimResult, "Erc20Holding");
    expect(holding).toBeDefined();
    const holdingArgs = getArgs(holding!);
    expect(holdingArgs.amount).toBe(sampleEvmParams.args[1]);
    expect(holdingArgs.owner).toBe(depositor);
    expect(holdingArgs.issuer).toBe(issuer);

    // Step 8: Verify via active contracts query
    const activeHoldings = await getActiveContracts([issuer, depositor], ERC20_HOLDING);
    const matchingHolding = activeHoldings.find((c) => {
      const cArgs = c.createArgument as Record<string, unknown>;
      return (
        cArgs.owner === depositor &&
        cArgs.amount === sampleEvmParams.args[1]
      );
    });
    expect(matchingHolding).toBeDefined();
  }, 30_000);
});
