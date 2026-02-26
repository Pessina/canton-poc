import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  uploadDar,
  allocateParty,
  createUser,
  getActiveContracts,
  getLedgerEnd,
  type JsGetUpdatesResponse,
} from "../infra/canton-client.js";
import { createLedgerStream } from "../infra/ledger-stream.js";
import { loadEnvConfig } from "../config/env.js";
import { handleEcdsaSignature } from "./mpc-signature-handler.js";
import { handleEvmTxOutcomeSignature } from "./tx-outcome-handler.js";
import { VaultOrchestrator } from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAR_PATH = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");
const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
const RELAYER_USER = "relayer";

async function main() {
  const config = loadEnvConfig();

  console.log("[Relayer] Uploading DAR...");
  await uploadDar(DAR_PATH);

  const issuerParty = await allocateParty("Issuer");
  console.log(`[Relayer] Issuer party: ${issuerParty}`);

  await createUser(RELAYER_USER, issuerParty);
  console.log(`[Relayer] User "${RELAYER_USER}" ready`);

  const orchContracts = await getActiveContracts([issuerParty], VAULT_ORCHESTRATOR);
  const orchCid = orchContracts[0]?.contractId;
  if (!orchCid) {
    throw new Error("[Relayer] No VaultOrchestrator contract found");
  }
  console.log(`[Relayer] VaultOrchestrator CID: ${orchCid}`);

  const offset = await getLedgerEnd();
  console.log(`[Relayer] Streaming from offset ${offset}`);

  createLedgerStream({
    parties: [issuerParty],
    beginExclusive: offset,
    onUpdate: (item: JsGetUpdatesResponse) => {
      const update = item.update;
      if (!("Transaction" in update)) return;

      for (const event of update.Transaction.value.events ?? []) {
        if (!("CreatedEvent" in event)) continue;
        const created = event.CreatedEvent;
        const templateId = created.templateId ?? "";

        if (templateId.includes("EcdsaSignature")) {
          handleEcdsaSignature({
            issuerParty,
            rpcUrl: config.SEPOLIA_RPC_URL,
            event: created,
          }).catch((err) =>
            console.error("[Relayer] EcdsaSignature handler failed:", err),
          );
        }

        if (templateId.includes("EvmTxOutcomeSignature")) {
          handleEvmTxOutcomeSignature({
            orchCid,
            userId: RELAYER_USER,
            actAs: [issuerParty],
            issuerParty,
            event: created,
          }).catch((err) =>
            console.error("[Relayer] EvmTxOutcomeSignature handler failed:", err),
          );
        }
      }
    },
    onError: (err) => console.error("[Relayer] Stream error:", err),
  });

  console.log("[Relayer] Listening for events...");
}

main().catch((err) => {
  console.error("[Relayer] Fatal:", err);
  process.exit(1);
});
