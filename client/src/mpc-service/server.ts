import type { Hex } from "viem";
import {
  CantonClient,
  type CreatedEvent,
  type JsGetUpdatesResponse,
} from "../infra/canton-client.js";
import { createLedgerStream, type StreamHandle } from "../infra/ledger-stream.js";
import { PendingEvmTx } from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import {
  signAndEnqueue,
  checkPendingTx,
  type PendingTx,
  type MpcServiceConfig,
} from "./tx-handler.js";

const MONITOR_INTERVAL_MS = 5_000;

/** Extract "Module:Template" suffix, ignoring package hash vs name prefix. */
function templateSuffix(templateId: string): string {
  const parts = templateId.split(":");
  return parts.slice(-2).join(":");
}

const PENDING_TX_SUFFIX = templateSuffix(PendingEvmTx.templateId);

export interface MpcServerConfig {
  canton: CantonClient;
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
  private pendingTxs = new Map<string, PendingTx>();
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private pollCounter = 0;

  private serviceConfig: MpcServiceConfig;

  constructor(private config: MpcServerConfig) {
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.serviceConfig = {
      canton: config.canton,
      orchCid: config.orchCid,
      userId: config.userId,
      actAs: config.parties,
      rootPrivateKey: config.rootPrivateKey,
      rpcUrl: config.rpcUrl,
    };
  }

  private dispatch(event: CreatedEvent): void {
    if (this.pendingTxs.has(event.contractId)) return;
    console.log(`[MPC] PendingEvmTx detected, contractId=${event.contractId}`);
    void this.process(event);
  }

  private async process(event: CreatedEvent): Promise<void> {
    try {
      const pending = await signAndEnqueue(this.serviceConfig, event);
      this.pendingTxs.set(event.contractId, pending);
      console.log(`[MPC] Monitoring tx ${pending.signedTxHash} for requestId=${pending.requestId}`);
    } catch (err) {
      console.error(`[MPC] Failed to sign tx: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async catchUp(): Promise<void> {
    console.log("[MPC] Catching up on active PendingEvmTx contracts...");
    try {
      const txs = await this.config.canton.getActiveContracts(
        this.config.parties,
        PendingEvmTx.templateId,
      );
      for (const c of txs) this.dispatch(c);
      console.log(`[MPC] Catch-up complete (${txs.length} pending txs)`);
    } catch (err) {
      console.error(`[MPC] Catch-up failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private startMonitor(): void {
    console.log(`[MPC] Starting transaction monitor (interval=${MONITOR_INTERVAL_MS}ms)`);
    this.monitorInterval = setInterval(() => void this.pollPendingTxs(), MONITOR_INTERVAL_MS);
  }

  private async pollPendingTxs(): Promise<void> {
    this.pollCounter++;
    if (this.pendingTxs.size === 0) return;

    for (const [contractId, tx] of this.pendingTxs) {
      let skipFactor = 1;
      if (tx.checkCount > 15) skipFactor = 6;
      else if (tx.checkCount > 5) skipFactor = 3;

      if (this.pollCounter % skipFactor !== 0) continue;

      try {
        const result = await checkPendingTx(this.serviceConfig, tx);
        tx.checkCount++;

        if (result === "done" || result === "failed") {
          this.pendingTxs.delete(contractId);
          console.log(`[MPC] Tx ${result} for requestId=${tx.requestId}, removed from queue`);
        }
      } catch (err) {
        tx.checkCount++;
        console.error(
          `[MPC] Unexpected monitor error for requestId=${tx.requestId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  async start(): Promise<void> {
    const offset = await this.config.canton.getLedgerEnd();

    this.stream = createLedgerStream({
      canton: this.config.canton,
      parties: this.config.parties,
      beginExclusive: offset,
      maxReconnectAttempts: 2,
      onUpdate: (item: JsGetUpdatesResponse) => {
        const update = item.update;
        if (!("Transaction" in update)) return;

        for (const event of update.Transaction.value.events ?? []) {
          if (!("CreatedEvent" in event)) continue;
          const created = event.CreatedEvent;
          if (templateSuffix(created.templateId) === PENDING_TX_SUFFIX) {
            this.dispatch(created);
          }
        }
      },
      onError: (err) => console.error("[MPC] Stream error:", err),
      onReady: () => {
        this.resolveReady();
        this.startMonitor();
        console.log("[MPC] Listening for PendingEvmTx events...");
      },
      onReconnect: () => void this.catchUp(),
    });
  }

  async waitUntilReady(timeoutMs = 5_000): Promise<void> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("MpcServer readiness timed out")), timeoutMs);
    });
    await Promise.race([this.readyPromise, timeout]);
  }

  shutdown(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.stream?.close();
    this.stream = null;
    console.log("[MPC] Shut down");
  }
}
