import type { Hex } from "viem";
import {
  getActiveContracts,
  getLedgerEnd,
  type CreatedEvent,
  type JsGetUpdatesResponse,
} from "../infra/canton-client.js";
import { createLedgerStream, type StreamHandle } from "../infra/ledger-stream.js";
import { PendingEvmDeposit } from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import {
  signAndEnqueue,
  checkPendingDeposit,
  type PendingDeposit,
  type MpcServiceConfig,
} from "./deposit-handler.js";

const MONITOR_INTERVAL_MS = 5_000;

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
  private pendingDeposits = new Map<string, PendingDeposit>();
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private pollCounter = 0;

  private serviceConfig: MpcServiceConfig;

  constructor(private config: MpcServerConfig) {
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.serviceConfig = {
      orchCid: config.orchCid,
      userId: config.userId,
      actAs: config.parties,
      rootPrivateKey: config.rootPrivateKey,
      rpcUrl: config.rpcUrl,
    };
  }

  private dispatchDeposit(event: CreatedEvent): void {
    if (this.pendingDeposits.has(event.contractId)) return;
    console.log(`[MPC] PendingEvmDeposit detected, contractId=${event.contractId}`);
    void this.processDeposit(event);
  }

  private async processDeposit(event: CreatedEvent): Promise<void> {
    try {
      const pending = await signAndEnqueue(this.serviceConfig, event);
      this.pendingDeposits.set(event.contractId, pending);
      console.log(`[MPC] Monitoring tx ${pending.signedTxHash} for requestId=${pending.requestId}`);
    } catch (err) {
      console.error(
        `[MPC] Failed to sign deposit: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async catchUp(): Promise<void> {
    console.log("[MPC] Catching up on active PendingEvmDeposit contracts...");
    try {
      const contracts = await getActiveContracts(this.config.parties, PendingEvmDeposit.templateId);
      for (const c of contracts) this.dispatchDeposit(c);
      console.log(`[MPC] Catch-up complete (${contracts.length} active contracts)`);
    } catch (err) {
      console.error(`[MPC] Catch-up failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private startMonitor(): void {
    console.log(`[MPC] Starting transaction monitor (interval=${MONITOR_INTERVAL_MS}ms)`);
    this.monitorInterval = setInterval(() => void this.pollPendingDeposits(), MONITOR_INTERVAL_MS);
  }

  private async pollPendingDeposits(): Promise<void> {
    this.pollCounter++;
    if (this.pendingDeposits.size === 0) return;

    for (const [contractId, deposit] of this.pendingDeposits) {
      // Exponential backoff: check less frequently as checkCount grows
      let skipFactor = 1;
      if (deposit.checkCount > 15) skipFactor = 6;
      else if (deposit.checkCount > 5) skipFactor = 3;

      if (this.pollCounter % skipFactor !== 0) continue;

      try {
        const result = await checkPendingDeposit(this.serviceConfig, deposit);
        deposit.checkCount++;

        if (result === "done" || result === "failed") {
          this.pendingDeposits.delete(contractId);
          console.log(
            `[MPC] Deposit ${result} for requestId=${deposit.requestId}, removed from queue`,
          );
        }
      } catch (err) {
        deposit.checkCount++;
        console.error(
          `[MPC] Unexpected monitor error for requestId=${deposit.requestId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
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
        this.startMonitor();
        console.log("[MPC] Listening for PendingEvmDeposit events...");
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
