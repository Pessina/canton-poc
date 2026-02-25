/**
 * WebSocket ledger update stream with auto-reconnect and HTTP polling fallback.
 *
 * Connects to Canton's JSON Ledger API v2 `/v2/updates` endpoint via
 * WebSocket for real-time streaming. On disconnection, reconnects with
 * exponential backoff, resuming from the last seen offset. If WebSocket
 * reconnection is exhausted, falls back to HTTP polling using the
 * existing `getUpdates()` client.
 */

import WebSocket from "ws";
import { BASE_URL, getUpdates, type JsGetUpdatesResponse } from "./canton-client.js";

export interface LedgerStreamOptions {
  /** Base URL of the Canton JSON Ledger API (e.g. "http://localhost:7575") */
  baseUrl?: string;
  /** Parties to filter updates for */
  parties: string[];
  /** Offset to start streaming from (exclusive) */
  beginExclusive: number;
  /** Called for each incoming update */
  onUpdate: (update: JsGetUpdatesResponse) => void;
  /** Called on transport errors (informational; stream continues automatically) */
  onError?: (err: Error) => void;
  /** Max WebSocket reconnection delay in ms (default: 10000) */
  maxReconnectDelayMs?: number;
  /** Max WebSocket reconnection attempts before falling back to HTTP polling (default: 10) */
  maxReconnectAttempts?: number;
  /** Idle timeout for HTTP polling batches in ms (default: 2000) */
  pollingIdleTimeoutMs?: number;
  /** Backoff delay on HTTP polling errors in ms (default: 1000) */
  pollingErrorBackoffMs?: number;
}

export interface StreamHandle {
  close: () => void;
}

export function createLedgerStream(opts: LedgerStreamOptions): StreamHandle {
  const baseUrl = opts.baseUrl ?? BASE_URL;
  const maxDelay = opts.maxReconnectDelayMs ?? 10_000;
  const maxAttempts = opts.maxReconnectAttempts ?? 10;
  const pollingIdleTimeoutMs = opts.pollingIdleTimeoutMs ?? 2000;
  const pollingErrorBackoffMs = opts.pollingErrorBackoffMs ?? 1000;

  let currentOffset = opts.beginExclusive;
  let closed = false;
  let ws: WebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function buildFilter(): Record<string, Record<string, never>> {
    const filtersByParty: Record<string, Record<string, never>> = {};
    for (const party of opts.parties) {
      filtersByParty[party] = {};
    }
    return filtersByParty;
  }

  function extractOffset(item: JsGetUpdatesResponse): number | undefined {
    const update = item.update;
    if ("Transaction" in update) {
      return update.Transaction.value.offset;
    }
    if ("OffsetCheckpoint" in update) {
      return update.OffsetCheckpoint.value.offset;
    }
    return undefined;
  }

  function handleUpdate(item: JsGetUpdatesResponse): void {
    const offset = extractOffset(item);
    if (offset != null) {
      currentOffset = offset;
    }
    opts.onUpdate(item);
  }

  // --- WebSocket transport with reconnection ---

  function scheduleReconnect(): void {
    if (closed) return;

    if (reconnectAttempt >= maxAttempts) {
      console.warn(
        `WebSocket reconnection exhausted after ${maxAttempts} attempts. Falling back to HTTP polling.`,
      );
      void startPolling();
      return;
    }

    const delay = Math.min(1000 * 2 ** reconnectAttempt, maxDelay);
    reconnectAttempt++;
    console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempt}/${maxAttempts})...`);
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect(): void {
    if (closed) return;

    const wsUrl = baseUrl.replace(/^http/, "ws") + "/v2/updates";
    ws = new WebSocket(wsUrl, ["daml.ws.auth"]);

    ws.on("open", () => {
      console.log(`WebSocket connected to ${wsUrl}`);
      reconnectAttempt = 0;

      ws!.send(
        JSON.stringify({
          beginExclusive: currentOffset,
          verbose: true,
          filter: { filtersByParty: buildFilter() },
        }),
      );
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const text = Buffer.isBuffer(data)
          ? data.toString("utf-8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf-8")
            : new TextDecoder().decode(data);
        const parsed = JSON.parse(text) as JsGetUpdatesResponse;

        if ("error" in parsed) {
          opts.onError?.(new Error(`Ledger stream error: ${JSON.stringify(parsed.error)}`));
          return;
        }

        handleUpdate(parsed);
      } catch (err) {
        opts.onError?.(
          new Error(
            `Failed to parse WebSocket message: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });

    ws.on("close", () => {
      if (closed) return;
      ws = null;
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      if (closed) return;
      opts.onError?.(err);
    });
  }

  // --- HTTP polling fallback ---

  async function startPolling(): Promise<void> {
    if (closed) return;
    console.log("Starting HTTP polling fallback...");

    while (!closed) {
      try {
        const updates = await getUpdates(currentOffset, opts.parties, pollingIdleTimeoutMs);
        for (const item of updates) {
          if (closed) break;
          handleUpdate(item);
        }
      } catch (err) {
        if (closed) break;
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        await new Promise((r) => setTimeout(r, pollingErrorBackoffMs));
      }
    }
  }

  // --- Lifecycle ---

  function close(): void {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
  }

  connect();

  return { close };
}
