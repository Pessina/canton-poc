/**
 * WebSocket-first ledger update stream with HTTP polling fallback.
 *
 * Connects to Canton's JSON Ledger API v2 `/v2/updates` endpoint via
 * WebSocket for real-time streaming. If the WebSocket connection fails
 * or is unavailable, automatically falls back to HTTP polling using
 * the existing `getUpdates()` client.
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
  /** Called on transport errors (informational; stream continues via fallback) */
  onError?: (err: Error) => void;
  /** Idle timeout for HTTP polling batches in ms (default: 2000) */
  pollingIdleTimeoutMs?: number;
  /** Backoff delay on HTTP polling errors in ms (default: 1000) */
  pollingErrorBackoffMs?: number;
}

interface StreamHandle {
  close: () => void;
}

/**
 * Create a ledger update stream. Attempts WebSocket first, falls back to
 * HTTP polling if the WebSocket connection fails or closes unexpectedly.
 */
export function createLedgerStream(opts: LedgerStreamOptions): StreamHandle {
  const baseUrl = opts.baseUrl ?? BASE_URL;
  const pollingIdleTimeoutMs = opts.pollingIdleTimeoutMs ?? 2000;
  const pollingErrorBackoffMs = opts.pollingErrorBackoffMs ?? 1000;

  let currentOffset = opts.beginExclusive;
  let closed = false;
  let ws: WebSocket | null = null;
  let pollingAbort: AbortController | null = null;

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
      return (update.Transaction as { value: { offset?: number } }).value.offset;
    }
    if ("OffsetCheckpoint" in update) {
      return (update.OffsetCheckpoint as { value: { offset?: number } }).value.offset;
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

  // --- WebSocket transport ---

  function connectWebSocket(): void {
    if (closed) return;

    const wsUrl = baseUrl.replace(/^http/, "ws") + "/v2/updates";
    // Canton echoes back the "daml.ws.auth" subprotocol; we must request it
    // so the ws library doesn't reject the handshake.
    ws = new WebSocket(wsUrl, ["daml.ws.auth"]);

    ws.on("open", () => {
      console.log(`WebSocket connected to ${wsUrl}`);

      const subscriptionMsg = JSON.stringify({
        beginExclusive: currentOffset,
        verbose: true,
        filter: { filtersByParty: buildFilter() },
      });
      ws!.send(subscriptionMsg);
    });

    ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());

        // Canton wraps errors as { error: JsCantonError }
        if (parsed.error) {
          opts.onError?.(new Error(`Ledger stream error: ${JSON.stringify(parsed.error)}`));
          return;
        }

        handleUpdate(parsed as JsGetUpdatesResponse);
      } catch (err) {
        opts.onError?.(new Error(`Failed to parse WebSocket message: ${err}`));
      }
    });

    ws.on("close", (code, reason) => {
      if (closed) return;
      console.warn(
        `WebSocket closed (code=${code}, reason=${reason.toString()}). Falling back to HTTP polling.`,
      );
      ws = null;
      startPolling();
    });

    ws.on("error", (err) => {
      if (closed) return;
      console.warn(`WebSocket error: ${err.message}. Falling back to HTTP polling.`);
      opts.onError?.(err);
      // 'close' event will fire after 'error', which triggers the fallback
    });
  }

  // --- HTTP polling fallback ---

  async function startPolling(): Promise<void> {
    if (closed) return;
    console.log("Starting HTTP polling fallback...");

    pollingAbort = new AbortController();

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
    if (ws) {
      ws.close();
      ws = null;
    }
    if (pollingAbort) {
      pollingAbort.abort();
      pollingAbort = null;
    }
  }

  // Start with WebSocket
  connectWebSocket();

  return { close };
}
