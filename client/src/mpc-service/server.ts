import type { Hex } from "viem";
import {
  getActiveContracts,
  getLedgerEnd,
  type CreatedEvent,
  type JsGetUpdatesResponse,
} from "../infra/canton-client.js";
import { createLedgerStream, type StreamHandle } from "../infra/ledger-stream.js";
import { PendingEvmDeposit } from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import { handlePendingEvmDeposit } from "./deposit-handler.js";

/** Extract "Module:Template" suffix, ignoring package hash vs name prefix. */
function templateSuffix(templateId: string): string {
  const parts = templateId.split(":");
  return parts.slice(-2).join(":");
}

const PENDING_SUFFIX = templateSuffix(PendingEvmDeposit.templateId);

export interface MpcServerConfig {
  orchCid: string;
  userId: string;
  parties: string[];
  rootPrivateKey: Hex;
  rpcUrl: string;
}

export class MpcServer {
  private stream: StreamHandle | null = null;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private processedContractIds = new Set<string>();

  constructor(private config: MpcServerConfig) {
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  private dispatchDeposit(event: CreatedEvent): void {
    if (this.processedContractIds.has(event.contractId)) return;
    this.processedContractIds.add(event.contractId);

    console.log(`[MPC] PendingEvmDeposit detected, contractId=${event.contractId}`);
    handlePendingEvmDeposit({
      orchCid: this.config.orchCid,
      userId: this.config.userId,
      actAs: this.config.parties,
      rootPrivateKey: this.config.rootPrivateKey,
      rpcUrl: this.config.rpcUrl,
      event,
    }).catch((err) => {
      console.error(
        `[MPC] Failed to handle deposit: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private catchUp(): void {
    console.log("[MPC] Catching up on active PendingEvmDeposit contracts...");
    getActiveContracts(this.config.parties, PendingEvmDeposit.templateId)
      .then((contracts) => {
        for (const c of contracts) this.dispatchDeposit(c);
        console.log(`[MPC] Catch-up complete (${contracts.length} active contracts)`);
      })
      .catch((err) => {
        console.error(`[MPC] Catch-up failed: ${err instanceof Error ? err.message : String(err)}`);
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
          if (templateSuffix(created.templateId) !== PENDING_SUFFIX) continue;
          this.dispatchDeposit(created);
        }
      },
      onError: (err) => console.error("[MPC] Stream error:", err),
      onReady: () => {
        this.resolveReady();
        console.log("[MPC] Listening for PendingEvmDeposit events...");
      },
      onReconnect: () => this.catchUp(),
    });
  }

  async waitUntilReady(timeoutMs = 5_000): Promise<void> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("MpcServer readiness timed out")), timeoutMs);
    });
    await Promise.race([this.readyPromise, timeout]);
  }

  shutdown(): void {
    this.stream?.close();
    this.stream = null;
    console.log("[MPC] Shut down");
  }
}
