import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRequestId, type EvmTransactionParams } from "../mpc/crypto.js";
import {
  allocateParty,
  createUser,
  uploadDar,
  createContract,
  exerciseChoice,
  type TransactionResponse,
  type Event,
  type CreatedEvent,
} from "../infra/canton-client.js";
import {
  VaultOrchestrator,
  Erc20Holding,
} from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
const USER_BALANCE = Erc20Holding.templateId;

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

// ---------------------------------------------------------------------------
// Shared test params — must match Daml Test.daml sampleEvmParams exactly
// ---------------------------------------------------------------------------
const sampleEvmParams: EvmTransactionParams = {
  erc20Address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  recipient: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
  amount: "0x0000000000000000000000000000000000000000000000000000000005f5e100",
  nonce: "0x0000000000000000000000000000000000000000000000000000000000000001",
  gasLimit: "0x000000000000000000000000000000000000000000000000000000000000c350",
  maxFeePerGas: "0x0000000000000000000000000000000000000000000000000000000ba43b7400",
  maxPriorityFee: "0x0000000000000000000000000000000000000000000000000000000077359400",
  chainId: "0x0000000000000000000000000000000000000000000000000000000000000001",
  value: "0x0000000000000000000000000000000000000000000000000000000000000000",
};

// Daml contract params — same values WITHOUT 0x prefix (Daml uses bare hex)
const damlEvmParams = {
  erc20Address: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  recipient: "d8da6bf26964af9d7eed9e03e53415d37aa96045",
  amount: "0000000000000000000000000000000000000000000000000000000005f5e100",
  nonce: "0000000000000000000000000000000000000000000000000000000000000001",
  gasLimit: "000000000000000000000000000000000000000000000000000000000000c350",
  maxFeePerGas: "0000000000000000000000000000000000000000000000000000000ba43b7400",
  maxPriorityFee: "0000000000000000000000000000000000000000000000000000000077359400",
  chainId: "0000000000000000000000000000000000000000000000000000000000000001",
  value: "0000000000000000000000000000000000000000000000000000000000000000",
  operation: "Erc20Transfer",
};

const TEST_PUB_KEY =
  "3056301006072a8648ce3d020106052b8104000a034200049b51a3db8f697ac5e49078b01af8d2721dd9a39b81c59bae57d13e5c5d4c915649441be47149b0293b28d8b4a92416045bb39f922329f197fdeed3320c0746a5";

// ---------------------------------------------------------------------------
// Setup: upload DAR, allocate parties, create user
// ---------------------------------------------------------------------------
let issuer: string;
let depositor: string;
const RUN_ID = Math.random().toString(36).slice(2, 8);
const ADMIN_USER = `admin-${RUN_ID}`;

beforeAll(async () => {
  const darPath = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");
  await uploadDar(darPath);

  issuer = await allocateParty(`Issuer_${RUN_ID}`);
  depositor = await allocateParty(`Depositor_${RUN_ID}`);

  await createUser(ADMIN_USER, issuer, [depositor]);
}, 30_000);

// ---------------------------------------------------------------------------
// Cross-runtime request_id
// ---------------------------------------------------------------------------
describe("cross-runtime request_id", () => {
  it("TypeScript request_id matches Canton's request_id from RequestDeposit", async () => {
    const tsRequestId = computeRequestId(sampleEvmParams);

    const orchResult = await createContract(ADMIN_USER, [issuer], VAULT_ORCHESTRATOR, {
      issuer,
      mpcPublicKey: TEST_PUB_KEY,
    });
    const orchCid = firstCreatedCid(orchResult);

    const depositResult = await exerciseChoice(
      ADMIN_USER,
      [issuer, depositor],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestDeposit",
      {
        requester: depositor,
        erc20Address: damlEvmParams.erc20Address,
        amount: "100000000",
        evmParams: damlEvmParams,
      },
    );

    const pending = findCreated(depositResult, "PendingDeposit");
    expect(pending).toBeDefined();

    const cantonRequestId = getArgs(pending!).requestId as string;

    expect(tsRequestId.slice(2)).toBe(cantonRequestId);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Cross-runtime deposit lifecycle
// ---------------------------------------------------------------------------
describe("cross-runtime deposit lifecycle", () => {
  it("deposit creates PendingDeposit with matching requestId", async () => {
    const orchResult = await createContract(ADMIN_USER, [issuer], VAULT_ORCHESTRATOR, {
      issuer,
      mpcPublicKey: TEST_PUB_KEY,
    });
    const orchCid = firstCreatedCid(orchResult);

    const depositResult = await exerciseChoice(
      ADMIN_USER,
      [issuer, depositor],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestDeposit",
      {
        requester: depositor,
        erc20Address: damlEvmParams.erc20Address,
        amount: "100000000",
        evmParams: damlEvmParams,
      },
    );

    const pending = findCreated(depositResult, "PendingDeposit");
    expect(pending).toBeDefined();
    const args = getArgs(pending!);

    expect(args.requestId).toBe(computeRequestId(sampleEvmParams).slice(2));
    expect(parseFloat(args.amount as string)).toBe(100000000);
    expect(args.erc20Address).toBe(damlEvmParams.erc20Address);
    expect(args.requester).toBe(depositor);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Cross-runtime withdrawal lifecycle
// ---------------------------------------------------------------------------
describe("cross-runtime withdrawal lifecycle", () => {
  it("withdrawal debits balance and creates PendingWithdrawal with correct requestId", async () => {
    const orchResult = await createContract(ADMIN_USER, [issuer], VAULT_ORCHESTRATOR, {
      issuer,
      mpcPublicKey: TEST_PUB_KEY,
    });
    const orchCid = firstCreatedCid(orchResult);

    const balResult = await createContract(ADMIN_USER, [issuer], USER_BALANCE, {
      issuer,
      owner: depositor,
      erc20Address: damlEvmParams.erc20Address,
      amount: "500000000",
    });
    const balCid = firstCreatedCid(balResult);

    const withdrawResult = await exerciseChoice(
      ADMIN_USER,
      [issuer, depositor],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestWithdrawal",
      {
        requester: depositor,
        balanceCid: balCid,
        recipientAddress: "d8da6bf26964af9d7eed9e03e53415d37aa96045",
        withdrawAmount: "200000000",
        evmParams: damlEvmParams,
      },
    );

    const pending = findCreated(withdrawResult, "PendingWithdrawal");
    expect(pending).toBeDefined();
    expect(getArgs(pending!).requestId).toBe(computeRequestId(sampleEvmParams).slice(2));

    const newBal = findCreated(withdrawResult, "Erc20Holding");
    expect(newBal).toBeDefined();
    expect(parseFloat(getArgs(newBal!).amount as string)).toBe(300000000);
  }, 30_000);
});
