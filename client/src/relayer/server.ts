import {
  getActiveContracts,
  getLedgerEnd,
  type CreatedEvent,
  type JsGetUpdatesResponse,
} from "../infra/canton-client.js";
import { createLedgerStream, type StreamHandle } from "../infra/ledger-stream.js";
import {
  EcdsaSignature,
  EvmTxOutcomeSignature,
} from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import { handleEcdsaSignature } from "./mpc-signature-handler.js";
import { handleEvmTxOutcomeSignature } from "./tx-outcome-handler.js";

/** Extract "Module:Template" suffix, ignoring package hash vs name prefix. */
function templateSuffix(templateId: string): string {
  const parts = templateId.split(":");
  return parts.slice(-2).join(":");
}

const ECDSA_SUFFIX = templateSuffix(EcdsaSignature.templateId);
const OUTCOME_SUFFIX = templateSuffix(EvmTxOutcomeSignature.templateId);

export interface RelayerServerConfig {
  orchCid: string;
  userId: string;
  parties: string[];
  issuerParty: string;
  rpcUrl: string;
}

export class RelayerServer {
  private stream: StreamHandle | null = null;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private processedContractIds = new Set<string>();

  constructor(private config: RelayerServerConfig) {
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  private dispatchSignature(event: CreatedEvent): void {
    if (this.processedContractIds.has(event.contractId)) return;
    this.processedContractIds.add(event.contractId);

    handleEcdsaSignature({
      issuerParty: this.config.issuerParty,
      rpcUrl: this.config.rpcUrl,
      event,
    }).catch((err) => console.error("[Relayer] EcdsaSignature handler failed:", err));
  }

  private dispatchOutcome(event: CreatedEvent): void {
    if (this.processedContractIds.has(event.contractId)) return;
    this.processedContractIds.add(event.contractId);

    handleEvmTxOutcomeSignature({
      orchCid: this.config.orchCid,
      userId: this.config.userId,
      actAs: this.config.parties,
      issuerParty: this.config.issuerParty,
      event,
    }).catch((err) => console.error("[Relayer] EvmTxOutcomeSignature handler failed:", err));
  }

  private catchUp(): void {
    console.log("[Relayer] Catching up on active contracts...");
    Promise.all([
      getActiveContracts(this.config.parties, EcdsaSignature.templateId),
      getActiveContracts(this.config.parties, EvmTxOutcomeSignature.templateId),
    ])
      .then(([sigs, outcomes]) => {
        for (const c of sigs) this.dispatchSignature(c);
        for (const c of outcomes) this.dispatchOutcome(c);
        console.log(
          `[Relayer] Catch-up complete (${sigs.length} signatures, ${outcomes.length} outcomes)`,
        );
      })
      .catch((err) => {
        console.error(
          `[Relayer] Catch-up failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  async start(): Promise<void> {
    const offset = await getLedgerEnd();

    this.stream = createLedgerStream({
      parties: this.config.parties,
      beginExclusive: offset,
      maxReconnectAttempts: 2,
      onUpdate: (item: JsGetUpdatesResponse) => {
        const update = item.update;
        if (!("Transaction" in update)) return;

        for (const event of update.Transaction.value.events ?? []) {
          if (!("CreatedEvent" in event)) continue;
          const created = event.CreatedEvent;
          const suffix = templateSuffix(created.templateId);
          if (suffix === ECDSA_SUFFIX) {
            this.dispatchSignature(created);
          } else if (suffix === OUTCOME_SUFFIX) {
            this.dispatchOutcome(created);
          }
        }
      },
      onError: (err) => console.error("[Relayer] Stream error:", err),
      onReady: () => {
        this.resolveReady();
        console.log("[Relayer] Listening for events...");
      },
      onReconnect: () => this.catchUp(),
    });
  }

  async waitUntilReady(timeoutMs = 5_000): Promise<void> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("RelayerServer readiness timed out")), timeoutMs);
    });
    await Promise.race([this.readyPromise, timeout]);
  }

  shutdown(): void {
    this.stream?.close();
    this.stream = null;
    console.log("[Relayer] Shut down");
  }
}
