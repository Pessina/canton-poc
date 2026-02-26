import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRequestId, type EvmTransactionParams } from "../mpc/crypto.js";
import { deriveChildPrivateKey, signEvmTxHash, signMpcResponse } from "../mpc-service/signer.js";
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
const MPC_PUB_KEY_SPKI =
  "3056301006072a8648ce3d020106052b8104000a03420004bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4";
const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
const ERC20_HOLDING = Erc20Holding.templateId;

const PATH = "m/44/60/0/0";
const KEY_VERSION = 1;

const sampleEvmParams: EvmTransactionParams = {
  to: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  functionSignature: "transfer(address,uint256)",
  args: [
    "000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045",
    "0000000000000000000000000000000000000000000000000000000005f5e100",
  ],
  value: "0000000000000000000000000000000000000000000000000000000000000000",
  nonce: "0000000000000000000000000000000000000000000000000000000000000001",
  gasLimit: "000000000000000000000000000000000000000000000000000000000000c350",
  maxFeePerGas: "00000000000000000000000000000000000000000000000000000001dcd65000",
  maxPriorityFee: "000000000000000000000000000000000000000000000000000000003b9aca00",
  chainId: "0000000000000000000000000000000000000000000000000000000000aa36a7",
};

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
    return created?.templateId?.includes(templateFragment);
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

function deriveCaip2Id(chainIdHex: string): string {
  return "eip155:" + Number(BigInt("0x" + chainIdHex.replace(/^0+/, ""))).toString();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
let issuer: string;
let depositor: string;
const RUN_ID = Math.random().toString(36).slice(2, 8);
const ADMIN_USER = `e2e-${RUN_ID}`;

beforeAll(async () => {
  const darPath = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");
  await uploadDar(darPath);

  issuer = await allocateParty(`Issuer_${RUN_ID}`);
  depositor = await allocateParty(`Depositor_${RUN_ID}`);

  await createUser(ADMIN_USER, issuer, [depositor]);
}, 30_000);

// ---------------------------------------------------------------------------
// Full deposit lifecycle e2e
// ---------------------------------------------------------------------------
describe("deposit e2e lifecycle", () => {
  it("completes the full deposit flow from request to Erc20Holding", async () => {
    const caip2Id = deriveCaip2Id(sampleEvmParams.chainId);

    // Step 1: Create VaultOrchestrator
    const orchResult = await createContract(ADMIN_USER, [issuer], VAULT_ORCHESTRATOR, {
      issuer,
      mpcPublicKey: MPC_PUB_KEY_SPKI,
    });
    const orchCid = firstCreatedCid(orchResult);

    // Step 2: RequestEvmDeposit
    const depositResult = await exerciseChoice(
      ADMIN_USER,
      [issuer, depositor],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestEvmDeposit",
      {
        requester: depositor,
        path: PATH,
        evmParams: sampleEvmParams,
      },
    );

    const pending = findCreated(depositResult, "PendingEvmDeposit");
    expect(pending).toBeDefined();
    const pendingArgs = getArgs(pending!);
    const requestId = pendingArgs.requestId as string;

    const tsRequestId = computeRequestId(depositor, sampleEvmParams, caip2Id, KEY_VERSION, PATH);
    expect(tsRequestId.slice(2)).toBe(requestId);

    // Step 3: MPC signs the EVM transaction
    const childPrivateKey = deriveChildPrivateKey(
      MPC_ROOT_PRIVATE_KEY,
      depositor,
      PATH,
      caip2Id,
    );
    const evmParamsForTx: CantonEvmParams = sampleEvmParams;
    const serializedUnsigned = serializeUnsignedTx(evmParamsForTx);
    const txHash = keccak256(serializedUnsigned);
    const { r, s, v } = signEvmTxHash(childPrivateKey, txHash);

    // Step 4: SignEvmTx
    const signResult = await exerciseChoice(
      ADMIN_USER,
      [issuer],
      VAULT_ORCHESTRATOR,
      orchCid,
      "SignEvmTx",
      { requestId, r, s, v },
    );

    const ecdsaSig = findCreated(signResult, "EcdsaSignature");
    expect(ecdsaSig).toBeDefined();
    const ecdsaArgs = getArgs(ecdsaSig!);
    expect(ecdsaArgs.requestId).toBe(requestId);
    expect(ecdsaArgs.r).toBe(r);
    expect(ecdsaArgs.s).toBe(s);

    // Step 5: ProvideEvmOutcomeSig (simulate success = "01")
    const mpcOutput = "01";
    const outcomeSig = signMpcResponse(MPC_ROOT_PRIVATE_KEY, requestId, mpcOutput);

    const outcomeResult = await exerciseChoice(
      ADMIN_USER,
      [issuer],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ProvideEvmOutcomeSig",
      { requestId, signature: outcomeSig, mpcOutput },
    );

    const outcomeEvent = findCreated(outcomeResult, "EvmTxOutcomeSignature");
    expect(outcomeEvent).toBeDefined();
    const outcomeCid = outcomeEvent!.contractId;

    // Step 6: ClaimEvmDeposit
    const pendingCid = pending!.contractId;
    const amountFromArgs = BigInt("0x" + sampleEvmParams.args[1]!).toString();

    const claimResult = await exerciseChoice(
      ADMIN_USER,
      [issuer],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ClaimEvmDeposit",
      { pendingCid, outcomeCid, amount: amountFromArgs },
    );

    const holding = findCreated(claimResult, "Erc20Holding");
    expect(holding).toBeDefined();
    const holdingArgs = getArgs(holding!);
    expect(parseFloat(holdingArgs.amount as string)).toBe(parseFloat(amountFromArgs));
    expect(holdingArgs.owner).toBe(depositor);
    expect(holdingArgs.issuer).toBe(issuer);

    // Step 7: Verify via active contracts query
    const activeHoldings = await getActiveContracts([issuer, depositor], ERC20_HOLDING);
    const matchingHolding = activeHoldings.find((c) => {
      const cArgs = c.createArgument as Record<string, unknown>;
      return cArgs.owner === depositor && parseFloat(cArgs.amount as string) === parseFloat(amountFromArgs);
    });
    expect(matchingHolding).toBeDefined();
  }, 30_000);
});
