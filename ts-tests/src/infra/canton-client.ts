/**
 * Type-safe Canton JSON Ledger API v2 client.
 * Uses openapi-fetch (DA-recommended) + generated OpenAPI types.
 */

import createClient from "openapi-fetch";
import type { paths, components } from "../../generated/api/ledger-api.js";

export const BASE_URL = "http://localhost:7575";

export const client = createClient<paths>({ baseUrl: BASE_URL });

export type CreatedEvent = components["schemas"]["CreatedEvent"];
export type Event = components["schemas"]["Event"];
export type Command = components["schemas"]["Command"];
export type TransactionResponse =
  components["schemas"]["JsSubmitAndWaitForTransactionResponse"];

// ---------------------------------------------------------------------------
// Party & User management
// ---------------------------------------------------------------------------

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

async function findPartyByHint(hint: string): Promise<string | undefined> {
  const { data } = await client.GET("/v2/parties");
  const match = data?.partyDetails?.find((p) =>
    p.party?.startsWith(`${hint}::`),
  );
  return match?.party ?? undefined;
}

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

export type JsGetUpdatesResponse =
  components["schemas"]["JsGetUpdatesResponse"];

export async function getLedgerEnd(): Promise<number> {
  const { data, error } = await client.GET("/v2/state/ledger-end");
  if (error) throw new Error(`getLedgerEnd failed: ${JSON.stringify(error)}`);
  return data!.offset;
}

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
