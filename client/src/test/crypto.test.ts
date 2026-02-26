import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRequestId, packParams, type EvmTransactionParams } from "../mpc/crypto.js";
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
import { VaultOrchestrator } from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
const MPC_PUB_KEY_SPKI =
  "3056301006072a8648ce3d020106052b8104000a03420004bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4";

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

const SENDER = "Issuer::1220abcdef";
const CAIP2_ID = "eip155:11155111";
const KEY_VERSION = 1;
const PATH = "m/44/60/0/0";

// ---------------------------------------------------------------------------
// Unit tests: packParams
// ---------------------------------------------------------------------------
describe("packParams", () => {
  it("produces correct byte layout", () => {
    const packed = packParams(sampleEvmParams);

    expect(packed).toContain(sampleEvmParams.to);
    expect(packed).toContain(sampleEvmParams.args.join(""));
    expect(packed).toContain(sampleEvmParams.value);
    expect(packed).toContain(sampleEvmParams.nonce);
    expect(packed).toContain(sampleEvmParams.gasLimit);
    expect(packed).toContain(sampleEvmParams.maxFeePerGas);
    expect(packed).toContain(sampleEvmParams.maxPriorityFee);
    expect(packed).toContain(sampleEvmParams.chainId);

    const fnSigHex = Buffer.from(sampleEvmParams.functionSignature, "utf8").toString("hex");
    expect(packed.startsWith(sampleEvmParams.to + fnSigHex)).toBe(true);
    expect(packed.endsWith(sampleEvmParams.chainId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: computeRequestId
// ---------------------------------------------------------------------------
describe("computeRequestId", () => {
  it("is deterministic", () => {
    const a = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH);
    const b = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH);
    expect(a).toBe(b);
  });

  it("produces 32-byte hash", () => {
    const hash = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: Canton
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

describe("cross-runtime request_id", () => {
  it("TypeScript request_id matches Canton's request_id from RequestEvmDeposit", async () => {
    const orchResult = await createContract(ADMIN_USER, [issuer], VAULT_ORCHESTRATOR, {
      issuer,
      mpcPublicKey: MPC_PUB_KEY_SPKI,
    });
    const orchCid = firstCreatedCid(orchResult);

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

    const cantonRequestId = getArgs(pending!).requestId as string;
    const tsRequestId = computeRequestId(depositor, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH);

    expect(tsRequestId.slice(2)).toBe(cantonRequestId);
  }, 30_000);
});

describe("full deposit lifecycle", () => {
  it("creates PendingEvmDeposit with correct fields", async () => {
    const orchResult = await createContract(ADMIN_USER, [issuer], VAULT_ORCHESTRATOR, {
      issuer,
      mpcPublicKey: MPC_PUB_KEY_SPKI,
    });
    const orchCid = firstCreatedCid(orchResult);

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
    const args = getArgs(pending!);

    const tsRequestId = computeRequestId(depositor, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH);
    expect(args.requestId).toBe(tsRequestId.slice(2));
    expect(args.requester).toBe(depositor);
    expect(args.path).toBe(PATH);
    expect(args.issuer).toBe(issuer);

    const evmParamsResult = args.evmParams as Record<string, unknown>;
    expect(evmParamsResult.to).toBe(sampleEvmParams.to);
    expect(evmParamsResult.functionSignature).toBe(sampleEvmParams.functionSignature);
  }, 30_000);
});
