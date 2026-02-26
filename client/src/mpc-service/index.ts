import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMpcEnvConfig } from "../config/env.js";
import {
  uploadDar,
  allocateParty,
  createUser,
  getActiveContracts,
  getLedgerEnd,
  type JsGetUpdatesResponse,
} from "../infra/canton-client.js";
import { createLedgerStream } from "../infra/ledger-stream.js";
import { VaultOrchestrator } from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import { handlePendingEvmDeposit } from "./deposit-handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAR_PATH = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");
const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
const USER_ID = "mpc-service";

async function main() {
  const config = loadMpcEnvConfig();
  console.log("[MPC] Starting MPC service");

  await uploadDar(DAR_PATH);
  console.log("[MPC] DAR uploaded");

  const issuer = await allocateParty("Issuer");
  console.log(`[MPC] Issuer party: ${issuer}`);

  await createUser(USER_ID, issuer);
  console.log("[MPC] User created");

  const contracts = await getActiveContracts([issuer], VAULT_ORCHESTRATOR);
  if (contracts.length === 0) {
    throw new Error("[MPC] No VaultOrchestrator contract found");
  }
  const orchCid = contracts[0]!.contractId;
  console.log(`[MPC] VaultOrchestrator CID: ${orchCid}`);

  const offset = await getLedgerEnd();
  console.log(`[MPC] Streaming from offset ${offset}`);

  createLedgerStream({
    parties: [issuer],
    beginExclusive: offset,
    onUpdate: (item: JsGetUpdatesResponse) => {
      const update = item.update;
      if (!("Transaction" in update)) return;

      for (const event of update.Transaction.value.events ?? []) {
        if (!("CreatedEvent" in event)) continue;
        const created = event.CreatedEvent;
        if (!created.templateId?.includes("PendingEvmDeposit")) continue;

        console.log(`[MPC] PendingEvmDeposit detected, contractId=${created.contractId}`);
        handlePendingEvmDeposit({
          orchCid,
          userId: USER_ID,
          actAs: [issuer],
          rootPrivateKey: config.MPC_ROOT_PRIVATE_KEY,
          rpcUrl: config.SEPOLIA_RPC_URL,
          event: created,
        }).catch((err) => {
          console.error(
            `[MPC] Failed to handle deposit: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    },
    onError: (err) => console.error("[MPC] Stream error:", err),
  });

  console.log("[MPC] Listening for PendingEvmDeposit events...");
}

main().catch((err) => {
  console.error("[MPC] Fatal:", err);
  process.exit(1);
});
