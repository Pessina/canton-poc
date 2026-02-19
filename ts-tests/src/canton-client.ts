/**
 * Type-safe Canton JSON Ledger API v2 client.
 * Uses openapi-fetch (DA-recommended) + generated OpenAPI types.
 */

import createClient from "openapi-fetch";
import type { paths, components } from "../generated/api/ledger-api.js";

const BASE_URL = "http://localhost:7575";

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
  if (error) throw new Error(`allocateParty failed: ${JSON.stringify(error)}`);
  return data!.partyDetails!.party!;
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
  if (error) throw new Error(`createUser failed: ${JSON.stringify(error)}`);
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
