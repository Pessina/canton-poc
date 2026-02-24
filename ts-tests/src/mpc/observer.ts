/**
 * MPC Observer — watches the Canton ledger for PendingDeposit events.
 *
 * On startup: uploads DAR, allocates parties, creates a user and
 * a VaultOrchestrator contract, then enters a poll loop printing
 * any PendingDeposit created events it sees.
 *
 * Usage:  npm run observe
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  uploadDar,
  allocateParty,
  createUser,
  createContract,
  getLedgerEnd,
  type JsGetUpdatesResponse,
} from "../infra/canton-client.js";
import { createLedgerStream } from "../infra/ledger-stream.js";
import { VaultOrchestrator } from "../../generated/model/canton-mpc-poc-0.2.0/lib/Erc20Vault/module.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAR_PATH = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.2.0.dar");

const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
const TEST_PUB_KEY =
  "3056301006072a8648ce3d020106052b8104000a034200049b51a3db8f697ac5e49078b01af8d2721dd9a39b81c59bae57d13e5c5d4c915649441be47149b0293b28d8b4a92416045bb39f922329f197fdeed3320c0746a5";

const USER_ID = "mpc-observer";

async function setup() {
  await uploadDar(DAR_PATH);
  console.log("Uploaded DAR");

  const issuer = await allocateParty("Issuer");
  const depositor = await allocateParty("Depositor");
  console.log(`Issuer: ${issuer}`);
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

  return { issuer, depositor, orchCid };
}

function processBatch(updates: JsGetUpdatesResponse[]): number | undefined {
  let latestOffset: number | undefined;

  for (const item of updates) {
    const update = item.update;

    if ("Transaction" in update) {
      const tx = update.Transaction.value;
      latestOffset = tx.offset;

      for (const event of tx.events ?? []) {
        if (!("CreatedEvent" in event)) continue;
        const created = event.CreatedEvent;
        if (!created.templateId?.includes("PendingDeposit")) continue;

        const args = created.createArgument as Record<string, unknown>;
        console.log(
          `[PendingDeposit] requestId=${args.requestId} requester=${args.requester} amount=${args.amount} erc20=${args.erc20Address}`,
        );
      }
    }

    if ("OffsetCheckpoint" in update) {
      const checkpoint = update.OffsetCheckpoint.value;
      if (checkpoint.offset != null) {
        latestOffset = checkpoint.offset;
      }
    }
  }

  return latestOffset;
}

async function main() {
  const { issuer } = await setup();

  const offset = await getLedgerEnd();
  console.log(`Watching for PendingDeposit events from offset ${offset}...`);

  createLedgerStream({
    parties: [issuer],
    beginExclusive: offset,
    onUpdate: (item) => {
      processBatch([item]);
    },
    onError: (err) => console.error("Stream error:", err),
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
