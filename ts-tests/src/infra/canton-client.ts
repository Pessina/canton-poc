/**
 * Type-safe Canton JSON Ledger API v2 client.
 *
 * Uses {@link https://openapi-ts.dev/openapi-fetch/ openapi-fetch} with generated
 * OpenAPI types for compile-time request/response validation against the Canton
 * {@link https://docs.digitalasset.com/build/3.4/explanations/json-api/index.html JSON Ledger API v2}.
 *
 * All JSON endpoints use the typed `client` instance. Binary endpoints (DAR upload)
 * use raw `fetch` since openapi-fetch only handles JSON bodies.
 *
 * @module
 */

import createClient from "openapi-fetch";
import type { paths, components } from "../../generated/api/ledger-api.js";

/** Base URL for the Canton JSON Ledger API. */
export const BASE_URL = "http://localhost:7575";

/**
 * Type-safe HTTP client for the Canton JSON Ledger API v2.
 *
 * Created via `openapi-fetch` and parameterised with the generated `paths` type
 * so that every `client.GET`/`client.POST` call is validated at compile time.
 */
export const client = createClient<paths>({ baseUrl: BASE_URL });

/** A single contract creation event returned inside a transaction. */
export type CreatedEvent = components["schemas"]["CreatedEvent"];
/** A ledger event — a {@link CreatedEvent}, an ArchivedEvent, or an ExercisedEvent. */
export type Event = components["schemas"]["Event"];
/** A ledger command (CreateCommand, ExerciseCommand, etc.) sent to the participant. */
export type Command = components["schemas"]["Command"];
/** Response from `POST /v2/commands/submit-and-wait-for-transaction`. */
export type TransactionResponse =
  components["schemas"]["JsSubmitAndWaitForTransactionResponse"];

// ---------------------------------------------------------------------------
// Party & User management
// ---------------------------------------------------------------------------

/**
 * Allocate a new party on the Canton participant via `POST /v2/parties`.
 *
 * The participant generates a unique party identifier using `hint` as a
 * human-readable prefix (e.g. `"alice"` → `"alice::12209d…"`).
 * If the party already exists, falls back to listing all parties and
 * matching by the hint prefix.
 *
 * @param hint - Human-readable party-id prefix (e.g. `"alice"`).
 * @returns The fully-qualified party identifier.
 * @throws If allocation fails and no existing party matches.
 *
 * @see {@link https://docs.digitalasset.com/build/3.4/reference/json-api/openapi.html | POST /v2/parties}
 */
export async function allocateParty(hint: string): Promise<string> {
  const { data, error } = await client.POST("/v2/parties", {
    body: {
      partyIdHint: hint,
      identityProviderId: "",
      synchronizerId: "",
      userId: "",
    },
  });
  if (error) {
    const msg = JSON.stringify(error);
    if (msg.includes("Party already exists")) {
      const existing = await findPartyByHint(hint);
      if (existing) return existing;
    }
    throw new Error(`allocateParty failed: ${msg}`);
  }
  return data!.partyDetails!.party!;
}

/**
 * Search for an existing party whose identifier starts with `hint::`.
 *
 * Uses `GET /v2/parties` to list all known parties and prefix-matches.
 *
 * @param hint - The party-id prefix to search for.
 * @returns The full party identifier, or `undefined` if not found.
 */
async function findPartyByHint(hint: string): Promise<string | undefined> {
  const { data } = await client.GET("/v2/parties");
  const match = data?.partyDetails?.find((p) =>
    p.party?.startsWith(`${hint}::`),
  );
  return match?.party ?? undefined;
}

/**
 * Create a ledger API user with `CanActAs` and `CanReadAs` rights via `POST /v2/users`.
 *
 * Each party in `[primaryParty, ...additionalParties]` is granted both
 * `CanActAs` and `CanReadAs` rights. If the user already exists
 * (`USER_ALREADY_EXISTS`), the call is silently ignored.
 *
 * @param userId - Unique user identifier (e.g. `"alice-user"`).
 * @param primaryParty - The user's primary party (fully-qualified).
 * @param additionalParties - Extra parties the user can act/read as.
 * @throws If user creation fails for reasons other than duplication.
 *
 * @see {@link https://docs.digitalasset.com/build/3.4/reference/json-api/openapi.html | POST /v2/users}
 */
export async function createUser(
  userId: string,
  primaryParty: string,
  additionalParties: string[] = [],
): Promise<void> {
  const allParties = [primaryParty, ...additionalParties];
  const rights = allParties.flatMap((party) => [
    { kind: { CanActAs: { value: { party } } } },
    { kind: { CanReadAs: { value: { party } } } },
  ]);
  const { error } = await client.POST("/v2/users", {
    body: {
      user: {
        id: userId,
        primaryParty,
        isDeactivated: false,
        identityProviderId: "",
      },
      rights,
    } as components["schemas"]["CreateUserRequest"],
  });
  if (error) {
    const msg = JSON.stringify(error);
    if (msg.includes("USER_ALREADY_EXISTS")) return;
    throw new Error(`createUser failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// DAR upload — binary, kept as raw fetch (openapi-fetch is for JSON)
// ---------------------------------------------------------------------------

/**
 * Upload a DAR (Daml Archive) file to the participant via `POST /v2/dars`.
 *
 * Sends the file as raw bytes with `Content-Type: application/octet-stream`.
 * Uses native `fetch` instead of openapi-fetch because this endpoint accepts
 * binary — not JSON — request bodies. The `vetAllPackages=true` query param
 * ensures all packages in the DAR are vetted for use on upload.
 *
 * Silently succeeds when:
 * - The exact package version is already uploaded (`KNOWN_PACKAGE_VERSION`).
 * - The DAR is an incompatible upgrade (`NOT_VALID_UPGRADE_PACKAGE`).
 *
 * @param darPath - Absolute filesystem path to the `.dar` file.
 * @throws If the upload fails for reasons other than the above.
 *
 * @see {@link https://docs.digitalasset.com/build/3.4/reference/json-api/openapi.html | POST /v2/dars}
 */
export async function uploadDar(darPath: string): Promise<void> {
  const fs = await import("node:fs");
  const darBytes = fs.readFileSync(darPath);
  const res = await fetch(`${BASE_URL}/v2/dars?vetAllPackages=true`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: darBytes,
  });
  if (!res.ok) {
    const text = await res.text();
    if (text.includes("KNOWN_PACKAGE_VERSION")) return;
    if (text.includes("NOT_VALID_UPGRADE_PACKAGE")) return;
    throw new Error(`Upload DAR failed: ${res.status} ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Command submission
// ---------------------------------------------------------------------------

/**
 * Submit commands and synchronously wait for the resulting transaction
 * via `POST /v2/commands/submit-and-wait-for-transaction`.
 *
 * Wraps the provided commands in a {@link Command} array with a random
 * `commandId`, then blocks until the participant confirms the transaction.
 *
 * @param userId - Ledger API user submitting the commands.
 * @param actAs  - Parties the user is acting as (authorization scope).
 * @param commands - Array of ledger {@link Command}s: `CreateCommand`,
 *   `ExerciseCommand`, `CreateAndExerciseCommand`, or `ExerciseByKeyCommand`.
 *   See {@link https://docs.digitalasset.com/build/3.4/reference/json-api/openapi.html | JSON Ledger API OpenAPI reference}.
 * @returns The confirmed transaction including all resulting events.
 * @throws On command rejection or ledger errors (400 / `JsCantonError`).
 *
 * @see {@link https://docs.digitalasset.com/build/3.4/reference/json-api/openapi.html | POST /v2/commands/submit-and-wait-for-transaction}
 */
export async function submitAndWait(
  userId: string,
  actAs: string[],
  commands: Command[],
): Promise<TransactionResponse> {
  const { data, error } = await client.POST(
    "/v2/commands/submit-and-wait-for-transaction",
    {
      body: {
        commands: {
          commands,
          commandId: crypto.randomUUID(),
          userId,
          actAs,
          readAs: actAs,
        },
      } as components["schemas"]["JsSubmitAndWaitForTransactionRequest"],
    },
  );
  if (error) throw new Error(`submitAndWait failed: ${JSON.stringify(error)}`);
  return data!;
}

/**
 * Create a single contract on the ledger.
 *
 * Convenience wrapper around {@link submitAndWait} that builds a
 * `CreateCommand` from the given template ID and payload.
 *
 * @param userId    - Ledger API user submitting the command.
 * @param actAs     - Parties the user is acting as.
 * @param templateId - Fully-qualified Daml template identifier
 *   (e.g. `"Erc20Vault:Erc20Holding"`).
 * @param payload   - Template argument fields matching the Daml record.
 * @returns Transaction containing the {@link CreatedEvent} for the new contract.
 */
export async function createContract(
  userId: string,
  actAs: string[],
  templateId: string,
  payload: Record<string, unknown>,
): Promise<TransactionResponse> {
  return submitAndWait(userId, actAs, [
    { CreateCommand: { templateId, createArguments: payload } },
  ]);
}

/**
 * Exercise a choice on an existing contract.
 *
 * Convenience wrapper around {@link submitAndWait} that builds an
 * `ExerciseCommand` targeting a specific contract by ID.
 *
 * @param userId         - Ledger API user submitting the command.
 * @param actAs          - Parties the user is acting as.
 * @param templateId     - Fully-qualified Daml template identifier.
 * @param contractId     - Contract ID of the target contract.
 * @param choice         - Name of the choice to exercise (e.g. `"Transfer"`).
 * @param choiceArgument - Choice argument fields matching the Daml record.
 * @returns Transaction containing all events produced by the choice.
 */
export async function exerciseChoice(
  userId: string,
  actAs: string[],
  templateId: string,
  contractId: string,
  choice: string,
  choiceArgument: Record<string, unknown>,
): Promise<TransactionResponse> {
  return submitAndWait(userId, actAs, [
    { ExerciseCommand: { templateId, contractId, choice, choiceArgument } },
  ]);
}

// ---------------------------------------------------------------------------
// Ledger state & updates
// ---------------------------------------------------------------------------

/** A single update item from the `POST /v2/updates` response. */
export type JsGetUpdatesResponse =
  components["schemas"]["JsGetUpdatesResponse"];

/**
 * Get the current ledger end offset via `GET /v2/state/ledger-end`.
 *
 * The offset is a monotonically increasing number representing the latest
 * committed transaction position. Useful as the `beginExclusive` boundary
 * for {@link getUpdates} to avoid replaying historical transactions.
 *
 * @returns The current ledger-end offset.
 * @throws On communication errors.
 *
 * @see {@link https://docs.digitalasset.com/build/3.4/reference/json-api/openapi.html | GET /v2/state/ledger-end}
 */
export async function getLedgerEnd(): Promise<number> {
  const { data, error } = await client.GET("/v2/state/ledger-end");
  if (error) throw new Error(`getLedgerEnd failed: ${JSON.stringify(error)}`);
  return data!.offset;
}

/**
 * Fetch ledger updates since a given offset via `POST /v2/updates`.
 *
 * This is a blocking HTTP call — the server holds the connection open
 * until either new updates arrive or `idleTimeoutMs` elapses. Suitable for
 * small result sets; the server returns `413 Content Too Large` if the
 * response exceeds its `http-list-max-elements-limit` configuration.
 *
 * For continuous streaming prefer the WebSocket transport in
 * {@link ../ledger-stream.ts | createLedgerStream}.
 *
 * @param beginExclusive - Offset to start from (exclusive). Use
 *   {@link getLedgerEnd} to get the current position.
 * @param parties - Parties whose visible updates should be included.
 * @param idleTimeoutMs - Server-side idle timeout in ms before the
 *   connection closes with an empty batch (default `2000`).
 * @returns Array of update items (transactions, reassignments, topology transactions, or offset checkpoints).
 * @throws On communication or server errors.
 *
 * @see {@link https://docs.digitalasset.com/build/3.4/reference/json-api/openapi.html | POST /v2/updates}
 */
export async function getUpdates(
  beginExclusive: number,
  parties: string[],
  idleTimeoutMs = 2000,
): Promise<JsGetUpdatesResponse[]> {
  const filtersByParty: Record<string, components["schemas"]["Filters"]> = {};
  for (const party of parties) {
    filtersByParty[party] = {};
  }

  const { data, error } = await client.POST("/v2/updates", {
    params: { query: { stream_idle_timeout_ms: idleTimeoutMs } },
    body: {
      beginExclusive,
      verbose: true,
      filter: { filtersByParty },
    },
  });
  if (error) throw new Error(`getUpdates failed: ${JSON.stringify(error)}`);
  return data!;
}
