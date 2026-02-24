/**
 * Single-command end-to-end demo: sets up the ledger, captures the offset,
 * triggers a deposit, then polls until the observer sees the PendingDeposit.
 *
 * Usage:  npm run demo
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  uploadDar,
  allocateParty,
  createUser,
  createContract,
  exerciseChoice,
  getLedgerEnd,
  getUpdates,
} from "../infra/canton-client.js";
import { VaultOrchestrator } from "../../generated/model/canton-mpc-poc-0.2.0/lib/Erc20Vault/module.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAR_PATH = resolve(
  __dirname,
  "../../../.daml/dist/canton-mpc-poc-0.2.0.dar",
);
const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;

const TEST_PUB_KEY =
  "3056301006072a8648ce3d020106052b8104000a034200049b51a3db8f697ac5e49078b01af8d2721dd9a39b81c59bae57d13e5c5d4c915649441be47149b0293b28d8b4a92416045bb39f922329f197fdeed3320c0746a5";

const damlEvmParams = {
  erc20Address: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  recipient: "d8da6bf26964af9d7eed9e03e53415d37aa96045",
  amount: "0000000000000000000000000000000000000000000000000000000005f5e100",
  nonce: "0000000000000000000000000000000000000000000000000000000000000001",
  gasLimit: "000000000000000000000000000000000000000000000000000000000000c350",
  maxFeePerGas:
    "0000000000000000000000000000000000000000000000000000000ba43b7400",
  maxPriorityFee:
    "0000000000000000000000000000000000000000000000000000000077359400",
  chainId: "0000000000000000000000000000000000000000000000000000000000000001",
  value: "0000000000000000000000000000000000000000000000000000000000000000",
  operation: "Erc20Transfer",
};

const USER_ID = "mpc-demo";

async function main() {
  // 1. Setup
  console.log("=== Setup ===");
  await uploadDar(DAR_PATH);
  console.log("Uploaded DAR");

  const issuer = await allocateParty("Issuer");
  const depositor = await allocateParty("Depositor");
  console.log(`Issuer:  ${issuer}`);
  console.log(`Depositor: ${depositor}`);

  await createUser(USER_ID, issuer, [depositor]);

  const orchResult = await createContract(
    USER_ID,
    [issuer],
    VAULT_ORCHESTRATOR,
    { issuer, mpcPublicKey: TEST_PUB_KEY },
  );
  const firstEvent = orchResult.transaction.events![0];
  const orchCid =
    "CreatedEvent" in firstEvent
      ? firstEvent.CreatedEvent.contractId
      : undefined;
  if (!orchCid) throw new Error("Failed to get VaultOrchestrator contract ID");
  console.log(`Orchestrator CID: ${orchCid}`);

  // 2. Snapshot offset before the deposit
  const offsetBefore = await getLedgerEnd();
  console.log(`\n=== Triggering deposit (offset before: ${offsetBefore}) ===`);

  // 3. Fire RequestDeposit
  const result = await exerciseChoice(
    USER_ID,
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
  console.log(`RequestDeposit tx: ${result.transaction.updateId}`);

  // 4. Poll for the PendingDeposit event
  console.log("\n=== Observing ===");
  let offset = offsetBefore;
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const updates = await getUpdates(offset, [issuer]);
    for (const item of updates) {
      const update = item.update;
      if (!("Transaction" in update)) continue;
      const tx = update.Transaction.value;
      offset = tx.offset;

      for (const event of tx.events ?? []) {
        if (!("CreatedEvent" in event)) continue;
        const created = event.CreatedEvent;
        if (!created.templateId?.includes("PendingDeposit")) continue;

        const args = created.createArgument as Record<string, unknown>;
        console.log(`[PendingDeposit detected]`);
        console.log(`  requestId: ${args.requestId}`);
        console.log(`  requester: ${args.requester}`);
        console.log(`  amount:    ${args.amount}`);
        console.log(`  erc20:     ${args.erc20Address}`);
        console.log("\nDemo complete.");
        process.exit(0);
      }
    }
  }

  console.error("Timed out waiting for PendingDeposit event");
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
