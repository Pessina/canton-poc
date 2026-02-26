import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  uploadDar,
  allocateParty,
  createUser,
  createContract,
  exerciseChoice,
  getLedgerEnd,
  type JsGetUpdatesResponse,
} from "../infra/canton-client.js";
import { createLedgerStream } from "../infra/ledger-stream.js";
import { VaultOrchestrator } from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import type { EvmTransactionParams } from "../mpc/crypto.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAR_PATH = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");
const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;

const MPC_PUB_KEY_SPKI =
  "3056301006072a8648ce3d020106052b8104000a03420004bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4";

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

const USER_ID = "mpc-demo";
const PATH = "m/44/60/0/0";

async function main() {
  console.log("=== Setup ===");
  await uploadDar(DAR_PATH);
  console.log("Uploaded DAR");

  const issuer = await allocateParty("Issuer");
  const depositor = await allocateParty("Depositor");
  console.log(`Issuer:    ${issuer}`);
  console.log(`Depositor: ${depositor}`);

  await createUser(USER_ID, issuer, [depositor]);

  const orchResult = await createContract(USER_ID, [issuer], VAULT_ORCHESTRATOR, {
    issuer,
    mpcPublicKey: MPC_PUB_KEY_SPKI,
  });
  const firstEvent = orchResult.transaction.events?.[0];
  const orchCid =
    firstEvent && "CreatedEvent" in firstEvent ? firstEvent.CreatedEvent.contractId : undefined;
  if (!orchCid) throw new Error("Failed to get VaultOrchestrator contract ID");
  console.log(`Orchestrator CID: ${orchCid}`);

  const offsetBefore = await getLedgerEnd();
  console.log(`\n=== Triggering deposit (offset before: ${offsetBefore}) ===`);

  const result = await exerciseChoice(
    USER_ID,
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
  console.log(`RequestEvmDeposit tx: ${result.transaction.updateId}`);

  console.log("\n=== Observing ===");

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stream.close();
      reject(new Error("Timed out waiting for PendingEvmDeposit event"));
    }, 10_000);

    const stream = createLedgerStream({
      parties: [issuer],
      beginExclusive: offsetBefore,
      onUpdate: (item: JsGetUpdatesResponse) => {
        const update = item.update;
        if (!("Transaction" in update)) return;

        for (const event of update.Transaction.value.events ?? []) {
          if (!("CreatedEvent" in event)) continue;
          const created = event.CreatedEvent;
          if (!created.templateId?.includes("PendingEvmDeposit")) continue;

          const args = created.createArgument as Record<string, string>;
          console.log(`[PendingEvmDeposit detected]`);
          console.log(`  requestId: ${args.requestId}`);
          console.log(`  requester: ${args.requester}`);
          console.log(`  path:      ${args.path}`);

          clearTimeout(timeout);
          stream.close();
          resolve();
        }
      },
      onError: (err) => console.error("Stream error:", err),
    });
  });

  console.log("\nDemo complete.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
