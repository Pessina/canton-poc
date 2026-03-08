import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Hex } from "viem";
import {
  allocateParty,
  createContract,
  createUser,
  createUserWithRights,
  canActAsRight,
  canReadAsRight,
  exerciseChoice,
  getActiveContracts,
  listUserRights,
  uploadDar,
  type CreatedEvent,
  type Event,
  type TransactionResponse,
  type UserRight,
} from "../infra/canton-client.js";
import {
  VaultOrchestrator,
  DepositAuthProposal,
  DepositAuthorization,
  PendingEvmDeposit,
} from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import { deriveDepositAddress } from "../mpc/address-derivation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAR_PATH = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");

const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
const DEPOSIT_AUTH_PROPOSAL = DepositAuthProposal.templateId;
const DEPOSIT_AUTHORIZATION = DepositAuthorization.templateId;
const PENDING_EVM_DEPOSIT = PendingEvmDeposit.templateId;

const MPC_ROOT_PUBLIC_KEY =
  "04bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4";
const MPC_PUB_KEY_SPKI =
  "3056301006072a8648ce3d020106052b8104000a03420004bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4";

const KEY_VERSION = 1;
const ALGO = "ECDSA";
const DEST = "ethereum";

function buildSampleEvmParams(vaultAddress: Hex) {
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

function firstCreated(res: TransactionResponse): CreatedEvent {
  const first = res.transaction.events?.[0];
  if (!first) throw new Error("No events in transaction");
  const created = getCreatedEvent(first);
  if (!created) throw new Error("First event is not a CreatedEvent");
  return created;
}

function findCreated(res: TransactionResponse, templateFragment: string): CreatedEvent {
  const event = res.transaction.events?.find((e) =>
    getCreatedEvent(e)?.templateId.includes(templateFragment),
  );
  const created = event ? getCreatedEvent(event) : undefined;
  if (!created) throw new Error(`CreatedEvent ${templateFragment} not found`);
  return created;
}

function packageIdFromTemplateId(templateId: string): string {
  const packageId = templateId.split(":")[0];
  if (!packageId) throw new Error(`Invalid templateId: ${templateId}`);
  return packageId;
}

function hasContract(contracts: CreatedEvent[], cid: string): boolean {
  return contracts.some((c) => c.contractId === cid);
}

function hasRight(rights: UserRight[], kind: "CanActAs" | "CanReadAs", party: string): boolean {
  return rights.some((right) => {
    const rightKind = right.kind as Record<string, unknown>;
    if (!(kind in rightKind)) return false;
    const entry = rightKind[kind] as { value?: { party?: string } };
    return entry.value?.party === party;
  });
}

describe("ledger visibility + permission model", () => {
  const RUN_ID = Math.random().toString(36).slice(2, 8);
  const ISSUER_USER = `issuer-user-${RUN_ID}`;
  const REQUESTER_ONLY_USER = `requester-only-user-${RUN_ID}`;
  const REQUESTER_READ_ISSUER_USER = `requester-read-issuer-user-${RUN_ID}`;
  const MPC_USER = `mpc-user-${RUN_ID}`;
  const OUTSIDER_USER = `outsider-user-${RUN_ID}`;

  let issuer: string;
  let requester: string;
  let mpc: string;
  let outsider: string;
  let orchCid: string;
  let vaultAddress: Hex;

  beforeAll(async () => {
    await uploadDar(DAR_PATH);

    issuer = await allocateParty(`IssuerPerm_${RUN_ID}`);
    requester = await allocateParty(`RequesterPerm_${RUN_ID}`);
    mpc = await allocateParty(`MpcPerm_${RUN_ID}`);
    outsider = await allocateParty(`OutsiderPerm_${RUN_ID}`);

    await createUser(ISSUER_USER, issuer);
    await createUser(REQUESTER_ONLY_USER, requester);
    await createUser(MPC_USER, mpc);
    await createUser(OUTSIDER_USER, outsider);
    await createUserWithRights(REQUESTER_READ_ISSUER_USER, requester, [
      canActAsRight(requester),
      canReadAsRight(requester),
      canReadAsRight(issuer),
    ]);

    const packageId = packageIdFromTemplateId(VaultOrchestrator.templateIdWithPackageId);
    vaultAddress = deriveDepositAddress(MPC_ROOT_PUBLIC_KEY, `${packageId}${issuer}`, "root");

    const orchResult = await createContract(ISSUER_USER, [issuer], VAULT_ORCHESTRATOR, {
      issuer,
      mpc,
      mpcPublicKey: MPC_PUB_KEY_SPKI,
      vaultAddress: vaultAddress.slice(2).padStart(64, "0"),
    });
    orchCid = firstCreated(orchResult).contractId;
  }, 40_000);

  it("enforces least-privilege actAs/readAs for requester-controlled choices", async () => {
    const rights = await listUserRights(REQUESTER_READ_ISSUER_USER);
    expect(hasRight(rights, "CanActAs", requester)).toBe(true);
    expect(hasRight(rights, "CanReadAs", requester)).toBe(true);
    expect(hasRight(rights, "CanReadAs", issuer)).toBe(true);
    expect(hasRight(rights, "CanActAs", issuer)).toBe(false);

    await expect(
      exerciseChoice(
        REQUESTER_ONLY_USER,
        [requester],
        VAULT_ORCHESTRATOR,
        orchCid,
        "RequestDepositAuth",
        { requester },
      ),
    ).rejects.toThrow();

    const requestResult = await exerciseChoice(
      REQUESTER_READ_ISSUER_USER,
      [requester],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestDepositAuth",
      { requester },
      [issuer],
    );

    const proposal = findCreated(requestResult, "DepositAuthProposal");
    const proposalCid = proposal.contractId;
    const proposalArgs = proposal.createArgument as Record<string, unknown>;
    expect(proposal.templateId).toContain("DepositAuthProposal");
    expect(proposalArgs.issuer).toBe(issuer);
    expect(proposalArgs.owner).toBe(requester);
    expect(typeof proposal.createdEventBlob).toBe("string");

    await expect(
      exerciseChoice(
        REQUESTER_READ_ISSUER_USER,
        [issuer],
        VAULT_ORCHESTRATOR,
        orchCid,
        "RequestDepositAuth",
        { requester },
        [issuer],
      ),
    ).rejects.toThrow();

    await expect(
      exerciseChoice(
        REQUESTER_READ_ISSUER_USER,
        [requester],
        VAULT_ORCHESTRATOR,
        orchCid,
        "ApproveDepositAuth",
        { proposalCid, remainingUses: 1 },
        [issuer],
      ),
    ).rejects.toThrow();

    const approveResult = await exerciseChoice(
      ISSUER_USER,
      [issuer],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ApproveDepositAuth",
      { proposalCid, remainingUses: 1 },
    );
    const auth = findCreated(approveResult, "DepositAuthorization");
    const authArgs = auth.createArgument as Record<string, unknown>;
    expect(authArgs.owner).toBe(requester);
    expect(authArgs.issuer).toBe(issuer);
    expect(authArgs.mpc).toBe(mpc);
    expect(typeof auth.createdEventBlob).toBe("string");
  });

  it("returns party-scoped active contracts and correct create payload fields", async () => {
    const proposalResult = await exerciseChoice(
      REQUESTER_READ_ISSUER_USER,
      [requester],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestDepositAuth",
      { requester },
      [issuer],
    );
    const proposal = findCreated(proposalResult, "DepositAuthProposal");
    const proposalCid = proposal.contractId;

    const issuerProposals = await getActiveContracts([issuer], DEPOSIT_AUTH_PROPOSAL);
    const requesterProposals = await getActiveContracts([requester], DEPOSIT_AUTH_PROPOSAL);
    const mpcProposals = await getActiveContracts([mpc], DEPOSIT_AUTH_PROPOSAL);
    const outsiderProposals = await getActiveContracts([outsider], DEPOSIT_AUTH_PROPOSAL);

    expect(hasContract(issuerProposals, proposalCid)).toBe(true);
    expect(hasContract(requesterProposals, proposalCid)).toBe(true);
    expect(hasContract(mpcProposals, proposalCid)).toBe(false);
    expect(hasContract(outsiderProposals, proposalCid)).toBe(false);

    const approveResult = await exerciseChoice(
      ISSUER_USER,
      [issuer],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ApproveDepositAuth",
      { proposalCid, remainingUses: 2 },
    );
    const auth = findCreated(approveResult, "DepositAuthorization");
    const authCid = auth.contractId;

    const issuerAuths = await getActiveContracts([issuer], DEPOSIT_AUTHORIZATION);
    const requesterAuths = await getActiveContracts([requester], DEPOSIT_AUTHORIZATION);
    const mpcAuths = await getActiveContracts([mpc], DEPOSIT_AUTHORIZATION);
    const outsiderAuths = await getActiveContracts([outsider], DEPOSIT_AUTHORIZATION);

    expect(hasContract(issuerAuths, authCid)).toBe(true);
    expect(hasContract(requesterAuths, authCid)).toBe(true);
    expect(hasContract(mpcAuths, authCid)).toBe(true);
    expect(hasContract(outsiderAuths, authCid)).toBe(false);

    const evmParams = buildSampleEvmParams(vaultAddress);
    await expect(
      exerciseChoice(
        REQUESTER_ONLY_USER,
        [issuer],
        VAULT_ORCHESTRATOR,
        orchCid,
        "RequestEvmDeposit",
        {
          requester,
          path: requester,
          evmParams,
          authCidText: authCid,
          keyVersion: KEY_VERSION,
          algo: ALGO,
          dest: DEST,
          authCid,
        },
        [issuer],
      ),
    ).rejects.toThrow();

    const pendingResult = await exerciseChoice(
      REQUESTER_READ_ISSUER_USER,
      [requester],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestEvmDeposit",
      {
        requester,
        path: requester,
        evmParams,
        authCidText: authCid,
        keyVersion: KEY_VERSION,
        algo: ALGO,
        dest: DEST,
        authCid,
      },
      [issuer],
    );
    const pending = findCreated(pendingResult, "PendingEvmDeposit");
    const pendingCid = pending.contractId;
    const pendingArgs = pending.createArgument as Record<string, unknown>;

    expect(pending.templateId).toContain("PendingEvmDeposit");
    expect(pendingArgs.requester).toBe(requester);
    expect(pendingArgs.issuer).toBe(issuer);
    expect(pendingArgs.mpc).toBe(mpc);
    expect(pendingArgs.authCid).toBe(authCid);
    expect(pendingArgs.authCidText).toBe(authCid);
    expect(typeof pending.createdEventBlob).toBe("string");

    const issuerPending = await getActiveContracts([issuer], PENDING_EVM_DEPOSIT);
    const requesterPending = await getActiveContracts([requester], PENDING_EVM_DEPOSIT);
    const mpcPending = await getActiveContracts([mpc], PENDING_EVM_DEPOSIT);
    const outsiderPending = await getActiveContracts([outsider], PENDING_EVM_DEPOSIT);

    expect(hasContract(issuerPending, pendingCid)).toBe(true);
    expect(hasContract(requesterPending, pendingCid)).toBe(true);
    expect(hasContract(mpcPending, pendingCid)).toBe(true);
    expect(hasContract(outsiderPending, pendingCid)).toBe(false);
  }, 40_000);
});
