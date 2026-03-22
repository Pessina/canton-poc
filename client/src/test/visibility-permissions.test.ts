import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Hex } from "viem";
import {
  allocateParty,
  createContract,
  createUser,
  exerciseChoice,
  getActiveContracts,
  getDisclosedContract,
  uploadDar,
  type CreatedEvent,
  type DisclosedContract,
} from "../infra/canton-client.js";
import { findCreated, firstCreated } from "../infra/canton-helpers.js";
import {
  VaultOrchestrator,
  DepositAuthProposal,
  DepositAuthorization,
  PendingEvmTx,
  EcdsaSignature,
  EvmTxOutcomeSignature,
  Erc20Holding,
} from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import { deriveDepositAddress } from "../mpc/address-derivation.js";
import { signMpcResponse } from "../mpc-service/signer.js";
import { loadEnv } from "../config/env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAR_PATH = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");

const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
const DEPOSIT_AUTH_PROPOSAL = DepositAuthProposal.templateId;
const DEPOSIT_AUTHORIZATION = DepositAuthorization.templateId;
const PENDING_EVM_TX = PendingEvmTx.templateId;
const ECDSA_SIGNATURE = EcdsaSignature.templateId;
const EVM_TX_OUTCOME_SIG = EvmTxOutcomeSignature.templateId;
const ERC20_HOLDING = Erc20Holding.templateId;

const MPC_ROOT_PRIVATE_KEY =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex;
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

function hasContract(contracts: CreatedEvent[], cid: string): boolean {
  return contracts.some((c) => c.contractId === cid);
}

async function assertVisibility(
  templateId: string,
  contractId: string,
  visible: string[],
  notVisible: string[],
) {
  const checks = [...visible, ...notVisible].map(async (party) => {
    const contracts = await getActiveContracts([party], templateId);
    return { party, found: hasContract(contracts, contractId) };
  });
  const results = await Promise.all(checks);
  for (const { party, found } of results) {
    if (visible.includes(party)) {
      expect(found, `${party} should see contract`).toBe(true);
    } else {
      expect(found, `${party} should NOT see contract`).toBe(false);
    }
  }
}

describe("ledger visibility + permission model", () => {
  const RUN_ID = Math.random().toString(36).slice(2, 8);
  const ISSUER_USER = `issuer-user-${RUN_ID}`;
  const REQUESTER_USER = `requester-user-${RUN_ID}`;
  let issuer: string;
  let requester: string;
  let mpc: string;
  let orchCid: string;
  let orchDisclosure: DisclosedContract;
  let vaultAddress: Hex;

  beforeAll(async () => {
    await uploadDar(DAR_PATH);

    issuer = await allocateParty(`IssuerPerm_${RUN_ID}`);
    requester = await allocateParty(`RequesterPerm_${RUN_ID}`);
    mpc = await allocateParty(`MpcPerm_${RUN_ID}`);

    await createUser(ISSUER_USER, issuer);
    await createUser(REQUESTER_USER, requester);

    const { VAULT_ID } = loadEnv();
    vaultAddress = deriveDepositAddress(MPC_ROOT_PUBLIC_KEY, `${VAULT_ID}${issuer}`, "root");

    const orchResult = await createContract(ISSUER_USER, [issuer], VAULT_ORCHESTRATOR, {
      issuer,
      mpc,
      mpcPublicKey: MPC_PUB_KEY_SPKI,
      vaultAddress: vaultAddress.slice(2).padStart(64, "0"),
      vaultId: VAULT_ID,
    });
    orchCid = firstCreated(orchResult.transaction.events).contractId;

    // Issuer fetches the createdEventBlob and shares it off-chain with requesters
    orchDisclosure = await getDisclosedContract([issuer], VAULT_ORCHESTRATOR, orchCid);
  }, 40_000);

  it("disclosure grants visibility without authorization", async () => {
    // Without disclosure, requester has no visibility into VaultOrchestrator
    await expect(
      exerciseChoice(
        REQUESTER_USER,
        [requester],
        VAULT_ORCHESTRATOR,
        orchCid,
        "RequestDepositAuth",
        { requester },
      ),
    ).rejects.toThrow();

    // With disclosed blob, requester can exercise requester-controlled choices
    const requestResult = await exerciseChoice(
      REQUESTER_USER,
      [requester],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestDepositAuth",
      { requester },
      undefined,
      [orchDisclosure],
    );
    const proposal = findCreated(requestResult.transaction.events, "DepositAuthProposal");
    const proposalArgs = proposal.createArgument as DepositAuthProposal;
    expect(proposalArgs.issuer).toBe(issuer);
    expect(proposalArgs.owner).toBe(requester);

    // Disclosure does NOT grant authorization — requester cannot exercise issuer-controlled choices
    await expect(
      exerciseChoice(
        REQUESTER_USER,
        [requester],
        VAULT_ORCHESTRATOR,
        orchCid,
        "ApproveDepositAuth",
        { proposalCid: proposal.contractId, remainingUses: 1 },
        undefined,
        [orchDisclosure],
      ),
    ).rejects.toThrow();

    // Issuer approves (signatory, no disclosure needed)
    await exerciseChoice(ISSUER_USER, [issuer], VAULT_ORCHESTRATOR, orchCid, "ApproveDepositAuth", {
      proposalCid: proposal.contractId,
      remainingUses: 1,
    });
  });

  it("full lifecycle: controller permissions and observer visibility", async () => {
    // -- VaultOrchestrator visibility: signatory=issuer, observer=mpc
    await assertVisibility(VAULT_ORCHESTRATOR, orchCid, [issuer, mpc], [requester]);

    // -- Step 1: RequestDepositAuth (controller=requester)
    const proposalResult = await exerciseChoice(
      REQUESTER_USER,
      [requester],
      VAULT_ORCHESTRATOR,
      orchCid,
      "RequestDepositAuth",
      { requester },
      undefined,
      [orchDisclosure],
    );
    const proposalCid = findCreated(
      proposalResult.transaction.events,
      "DepositAuthProposal",
    ).contractId;

    // DepositAuthProposal: signatory=issuer, observer=owner(requester)
    await assertVisibility(DEPOSIT_AUTH_PROPOSAL, proposalCid, [issuer, requester], [mpc]);

    // -- Step 2: ApproveDepositAuth (controller=issuer)
    const approveResult = await exerciseChoice(
      ISSUER_USER,
      [issuer],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ApproveDepositAuth",
      { proposalCid, remainingUses: 2 },
    );
    const authCid = findCreated(
      approveResult.transaction.events,
      "DepositAuthorization",
    ).contractId;

    // DepositAuthorization: signatory=issuer, observer=mpc,owner
    await assertVisibility(DEPOSIT_AUTHORIZATION, authCid, [issuer, requester, mpc], []);

    // -- Step 4: RequestEvmDeposit (controller=requester)
    const evmParams = buildSampleEvmParams(vaultAddress);
    const pendingResult = await exerciseChoice(
      REQUESTER_USER,
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
      undefined,
      [orchDisclosure],
    );
    const pending = findCreated(pendingResult.transaction.events, "PendingEvmTx");
    const pendingCid = pending.contractId;
    const { requestId } = pending.createArgument as PendingEvmTx;

    // PendingEvmTx: signatory=issuer, observer=mpc,requester
    await assertVisibility(PENDING_EVM_TX, pendingCid, [issuer, requester, mpc], []);

    // -- Step 7: SignEvmTx (controller=issuer)
    // Requester cannot exercise issuer-controlled choices
    await expect(
      exerciseChoice(
        REQUESTER_USER,
        [requester],
        VAULT_ORCHESTRATOR,
        orchCid,
        "SignEvmTx",
        { requester, requestId, r: "00", s: "00", v: 0 },
        undefined,
        [orchDisclosure],
      ),
    ).rejects.toThrow();

    const signResult = await exerciseChoice(
      ISSUER_USER,
      [issuer],
      VAULT_ORCHESTRATOR,
      orchCid,
      "SignEvmTx",
      { requester, requestId, r: "00", s: "00", v: 0 },
    );
    const ecdsaCid = findCreated(signResult.transaction.events, "EcdsaSignature").contractId;

    // EcdsaSignature: signatory=issuer, observer=requester
    await assertVisibility(ECDSA_SIGNATURE, ecdsaCid, [issuer, requester], [mpc]);

    // -- Step 10: ProvideEvmOutcomeSig (controller=issuer)
    await expect(
      exerciseChoice(
        REQUESTER_USER,
        [requester],
        VAULT_ORCHESTRATOR,
        orchCid,
        "ProvideEvmOutcomeSig",
        { requester, requestId, signature: "00", mpcOutput: "01" },
        undefined,
        [orchDisclosure],
      ),
    ).rejects.toThrow();

    const mpcOutput = "01";
    const mpcSignature = signMpcResponse(MPC_ROOT_PRIVATE_KEY, requestId, mpcOutput);
    const outcomeResult = await exerciseChoice(
      ISSUER_USER,
      [issuer],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ProvideEvmOutcomeSig",
      { requester, requestId, signature: mpcSignature, mpcOutput },
    );
    const outcomeCid = findCreated(
      outcomeResult.transaction.events,
      "EvmTxOutcomeSignature",
    ).contractId;

    // EvmTxOutcomeSignature: signatory=issuer, observer=requester
    await assertVisibility(EVM_TX_OUTCOME_SIG, outcomeCid, [issuer, requester], [mpc]);

    // -- Step 11: ClaimEvmDeposit (controller=requester)
    // Issuer cannot claim (controller is requester, not issuer)
    await expect(
      exerciseChoice(ISSUER_USER, [issuer], VAULT_ORCHESTRATOR, orchCid, "ClaimEvmDeposit", {
        requester,
        pendingCid,
        outcomeCid,
        ecdsaCid,
      }),
    ).rejects.toThrow();

    // Requester claims via disclosure
    const claimResult = await exerciseChoice(
      REQUESTER_USER,
      [requester],
      VAULT_ORCHESTRATOR,
      orchCid,
      "ClaimEvmDeposit",
      { requester, pendingCid, outcomeCid, ecdsaCid },
      undefined,
      [orchDisclosure],
    );
    const holding = findCreated(claimResult.transaction.events, "Erc20Holding");
    const holdingArgs = holding.createArgument as Erc20Holding;
    expect(holdingArgs.owner).toBe(requester);
    expect(holdingArgs.issuer).toBe(issuer);

    // Erc20Holding: signatory=issuer, observer=owner(requester)
    await assertVisibility(ERC20_HOLDING, holding.contractId, [issuer, requester], [mpc]);

    // Evidence contracts must be archived after claim
    const remainingPending = await getActiveContracts([issuer], PENDING_EVM_TX);
    expect(hasContract(remainingPending, pendingCid)).toBe(false);
    const remainingEcdsa = await getActiveContracts([issuer], ECDSA_SIGNATURE);
    expect(hasContract(remainingEcdsa, ecdsaCid)).toBe(false);
    const remainingOutcome = await getActiveContracts([issuer], EVM_TX_OUTCOME_SIG);
    expect(hasContract(remainingOutcome, outcomeCid)).toBe(false);
  }, 60_000);
});
