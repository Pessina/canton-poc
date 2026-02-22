# Daml TypeScript Integration Reference

Complete reference for building TypeScript clients that interact with Canton via the JSON Ledger API v2.

---

## Architecture Overview

DA's official TypeScript tutorial uses two code generation layers:

1. **OpenAPI Client** (`openapi-fetch` + `openapi-typescript`) — type-safe HTTP client generated from Canton's OpenAPI spec
2. **Daml Model Bindings** (`codegen-js`) — TypeScript types for Daml templates/choices generated from the DAR

Both layers are used together: the OpenAPI client provides the HTTP transport with typed request/response shapes, while the Daml model bindings provide template IDs and payload types that match Daml contracts.

---

## Layer 1: OpenAPI Client Setup

### Installation

```bash
npm install openapi-fetch
npm install -D openapi-typescript
```

### Generate Types from Running Sandbox

```bash
# Fetch the spec from running sandbox
curl http://localhost:7575/docs/openapi -o openapi.yaml

# Generate TypeScript types
npx openapi-typescript openapi.yaml -o generated/api/ledger-api.ts
```

### Create the Client

```typescript
// src/client.ts
import createClient from "openapi-fetch";
import type { paths, components } from "../generated/api/ledger-api.js";

export const client = createClient<paths>({ baseUrl: "http://localhost:7575" });

// Re-export generated types for convenience
export type JsCreatedEvent = components["schemas"]["JsCreatedEvent"];
export type TransactionResponse = components["schemas"]["JsSubmitAndWaitForTransactionResponse"];
```

> **NOTE**: DA recommends `openapi-fetch` specifically. Many other OpenAPI generators have bugs with the Canton 3.0.3 spec.

---

## Layer 2: Daml Model Bindings (codegen-js)

### Generate from DAR

```bash
# Generate from DAR file directly
dpm codegen-js .daml/dist/my-project-0.1.0.dar -o generated/model -s daml.js
```

Or configure in `daml.yaml`:

```yaml
codegen:
  js:
    output-directory: generated/model
    npm-scope: daml.js
```

### What It Generates

- TypeScript interfaces for all records, variants, enums
- Template companion objects with `templateId` constants
- Choice argument types
- Runtime serialization helpers

Depends on the `@daml/types` npm package for base types.

### Importing Generated Templates

```typescript
// Import generated template (uses templateId, never hardcode)
import {
  VaultOrchestrator,
  UserErc20Balance,
} from "../generated/model/my-project-0.1.0/lib/Erc20Vault/module.js";

const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
// e.g. "#canton-mpc-poc:Erc20Vault:VaultOrchestrator"
```

**BEST PRACTICE**: Always import `templateId` from generated bindings instead of hardcoding strings. This ensures type safety and catches breakage at compile time when templates change.

---

## Type Mappings (Daml -> TypeScript)

| Daml Type | TypeScript Type | JS Representation | Notes |
|---|---|---|---|
| `Text` | `string` | `string` | |
| `Int` | `string` | `string` | Avoids JS number precision loss! |
| `Decimal` | `string` | `string` | |
| `Bool` | `boolean` | `boolean` | |
| `Party` | `string` | `string` | Full party ID with namespace |
| `ContractId` | `string` | `string` | |
| `Time` | `string` | `string` | ISO 8601 |
| `Date` | `string` | `string` | |
| `[a]` | `a[]` | `a[]` | |
| `Optional a` | `a \| null` | conditional | |
| `TextMap a` | `{ [key: string]: a }` | object | |
| `BytesHex` | `string` | `string` | Bare hex in Daml, 0x-prefixed in TS/viem |

**CRITICAL**: `Int` maps to `string` in TypeScript. Pass amounts as `"100000000"` not `100000000`. JavaScript numbers lose precision beyond `Number.MAX_SAFE_INTEGER` (2^53 - 1), which is why the Daml codegen maps `Int` to `string`.

---

## Hex Encoding Convention

Daml and TypeScript/viem use different hex encoding conventions:

```
Daml (bare hex):     "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
TypeScript/viem:     "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
```

When sending hex values to the Canton API, strip the `0x` prefix.
When comparing Canton response values with TypeScript values, strip `0x` from the TS side.

```typescript
// Comparing hex values across boundaries
expect(tsRequestId.slice(2)).toBe(cantonRequestId);
```

```typescript
// Stripping prefix before sending to Canton
function toCantonHex(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

// Adding prefix when reading from Canton
function toViemHex(hex: string): `0x${string}` {
  return hex.startsWith("0x") ? (hex as `0x${string}`) : `0x${hex}`;
}
```

---

## Party Allocation

```typescript
async function allocateParty(hint: string): Promise<string> {
  const { data, error } = await client.POST("/v2/parties", {
    body: { partyIdHint: hint, identityProviderId: "" },
  });
  if (error) throw new Error(`allocateParty failed: ${JSON.stringify(error)}`);
  return data!.partyDetails!.party!;
}
```

The returned party string includes the full namespace, e.g. `Operator_abc123::122041a3...`.

---

## User Creation

Users need `CanActAs` and `CanReadAs` rights for each party they act as:

```typescript
async function createUser(
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
```

The `rights` array must include both `CanActAs` and `CanReadAs` for every party the user needs to interact with. Missing rights cause authorization errors at command submission time.

---

## DAR Upload

```typescript
async function uploadDar(darPath: string): Promise<void> {
  const fs = await import("node:fs");
  const darBytes = fs.readFileSync(darPath);
  const res = await fetch("http://localhost:7575/v2/dars?vetAllPackages=true", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: darBytes,
  });
  if (!res.ok) {
    const text = await res.text();
    if (text.includes("KNOWN_PACKAGE_VERSION")) return; // idempotent
    throw new Error(`Upload DAR failed: ${res.status} ${text}`);
  }
}
```

DAR upload uses raw `fetch` instead of `openapi-fetch` because the endpoint expects `application/octet-stream` binary body. Re-uploading the same DAR returns a 400 with `KNOWN_PACKAGE_VERSION` which should be handled gracefully for idempotency.

---

## Command Submission

### Submit and Wait (Synchronous)

```typescript
async function submitAndWait(
  userId: string,
  actAs: string[],
  commands: components["schemas"]["JsCommand"][],
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
```

**NOTE the double nesting**: The outer `commands` object wraps the inner `commands` array along with metadata (`commandId`, `userId`, `actAs`, `readAs`). This is a common source of confusion.

### Create Contract

```typescript
async function createContract(
  userId: string,
  actAs: string[],
  templateId: string,
  payload: Record<string, unknown>,
): Promise<TransactionResponse> {
  return submitAndWait(userId, actAs, [
    { CreateCommand: { templateId, createArguments: payload } },
  ]);
}
```

### Exercise Choice

```typescript
async function exerciseChoice(
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
```

---

## Querying Active Contracts

```typescript
const { data: contracts } = await client.POST("/v2/state/active-contracts", {
  body: {
    filter: {
      filtersByParty: {
        [partyId]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId: "#myProject:Module:Template",
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
});
```

The filter structure uses `filtersByParty` keyed by the party's full ID string. Each party's filter contains a `cumulative` array of identifier filters. Use `TemplateFilter` to match a specific template, or `WildcardFilter` to match all templates visible to that party.

---

## Response Format

```typescript
// Created events use `createArgument` (SINGULAR, not plural)
const event = result.transaction.events[0].CreatedEvent!;
const contractId = event.contractId;
const args = event.createArgument;
// e.g., args.requestId, args.amount, args.operator
```

**IMPORTANT**: The API accepts `createArguments` (plural) in command submission but returns `createArgument` (singular) in events. This asymmetry is a common source of bugs.

### Extracting Events from Transaction Results

```typescript
function extractCreatedEvents(
  result: TransactionResponse,
): JsCreatedEvent[] {
  return (result.transaction?.events ?? [])
    .filter((e) => e.CreatedEvent)
    .map((e) => e.CreatedEvent!);
}

function extractArchivedContractIds(
  result: TransactionResponse,
): string[] {
  return (result.transaction?.events ?? [])
    .filter((e) => e.ArchivedEvent)
    .map((e) => e.ArchivedEvent!.contractId!);
}
```

---

## Template IDs

```
Format: "#packageName:ModuleName:TemplateName"
```

The `#` prefix enables package-name resolution so you do not need the full package hash.

```
Example: "#canton-mpc-poc:Erc20Vault:VaultOrchestrator"
```

**BEST PRACTICE**: Import from generated bindings instead of hardcoding:

```typescript
import { VaultOrchestrator } from "../generated/model/.../module.js";
const tid = VaultOrchestrator.templateId;
```

---

## WebSocket Streaming

```typescript
const ws = new WebSocket("ws://localhost:7575/v2/updates");

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      beginExclusive: 0,
      verbose: true,
      updateFormat: {
        includeTransactions: {
          eventFormat: {
            filtersByParty: {
              [operatorParty]: {
                cumulative: [
                  {
                    identifierFilter: {
                      WildcardFilter: {
                        value: { includeCreatedEventBlob: true },
                      },
                    },
                  },
                ],
              },
            },
          },
          transactionShape: "TRANSACTION_SHAPE_ACS_DELTA",
        },
      },
    }),
  );
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.update?.Transaction) {
    const txEvents = msg.update.Transaction.events ?? [];
    for (const evt of txEvents) {
      if (evt.CreatedEvent) {
        console.log("Created:", evt.CreatedEvent.templateId, evt.CreatedEvent.contractId);
      }
      if (evt.ArchivedEvent) {
        console.log("Archived:", evt.ArchivedEvent.contractId);
      }
    }
  }
};

ws.onerror = (err) => {
  console.error("WebSocket error:", err);
};

ws.onclose = () => {
  console.log("WebSocket closed");
};
```

The WebSocket connection at `/v2/updates` streams ledger updates in real time. The subscription message specifies:
- `beginExclusive`: offset to start streaming from (0 for beginning)
- `verbose`: include full template IDs in events
- `updateFormat.includeTransactions`: which transactions to include, with party-based event filtering
- `transactionShape`: `TRANSACTION_SHAPE_ACS_DELTA` returns only created/archived events (no exercise nodes)

---

## JSON Ledger API v2 Endpoint Reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/v2/parties` | POST | Allocate a party |
| `/v2/users` | POST | Create user with rights |
| `/v2/users/{userId}/rights` | POST | Add rights to existing user |
| `/v2/dars?vetAllPackages=true` | POST | Upload a DAR (binary body) |
| `/v2/commands/submit-and-wait-for-transaction` | POST | Submit commands, wait for result |
| `/v2/commands/async/submit` | POST | Submit commands asynchronously |
| `/v2/state/active-contracts` | POST | Query active contract set |
| `/v2/updates` | WebSocket | Stream ledger updates |
| `/docs/openapi` | GET | OpenAPI spec (YAML) |
| `/docs/asyncapi` | GET | AsyncAPI spec (WebSocket) |

---

## Testing Pattern (Vitest)

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import {
  allocateParty,
  createUser,
  uploadDar,
  createContract,
  exerciseChoice,
} from "./canton-client.js";
import { VaultOrchestrator } from "../generated/model/my-project-0.1.0/lib/Erc20Vault/module.js";

let operator: string;
let depositor: string;
const RUN_ID = Math.random().toString(36).slice(2, 8);
const ADMIN_USER = `admin-${RUN_ID}`;

beforeAll(async () => {
  // Upload DAR
  await uploadDar(
    resolve(__dirname, "../../.daml/dist/my-project-0.1.0.dar"),
  );

  // Allocate parties with unique names
  operator = await allocateParty(`Operator_${RUN_ID}`);
  depositor = await allocateParty(`Depositor_${RUN_ID}`);

  // Create user with rights for both parties
  await createUser(ADMIN_USER, operator, [depositor]);
}, 30_000);

describe("VaultOrchestrator", () => {
  it("should create a contract", async () => {
    const result = await createContract(
      ADMIN_USER,
      [operator],
      VaultOrchestrator.templateId,
      {
        operator,
        depositors: [depositor],
      },
    );

    const events = result.transaction!.events!;
    const created = events.find((e) => e.CreatedEvent)?.CreatedEvent;
    expect(created).toBeDefined();
    expect(created!.createArgument!.operator).toBe(operator);
  });

  it("should exercise a choice", async () => {
    // First create the contract
    const createResult = await createContract(
      ADMIN_USER,
      [operator],
      VaultOrchestrator.templateId,
      { operator, depositors: [depositor] },
    );

    const contractId = createResult.transaction!.events!.find(
      (e) => e.CreatedEvent,
    )!.CreatedEvent!.contractId!;

    // Then exercise a choice on it
    const exerciseResult = await exerciseChoice(
      ADMIN_USER,
      [operator, depositor],
      VaultOrchestrator.templateId,
      contractId,
      "SomeChoice",
      { arg1: "value1" },
    );

    expect(exerciseResult.transaction).toBeDefined();
  });
});
```

### Test Isolation with RUN_ID

The `RUN_ID` pattern generates random suffixes for parties and users in each test run. This prevents conflicts when running tests multiple times against the same sandbox without restarting it. Each test run gets its own isolated set of parties and contracts.

---

## Common Gotchas

### 1. createArguments vs createArgument

The API accepts `createArguments` (plural) in `CreateCommand` payloads but returns `createArgument` (singular) in `CreatedEvent` responses. This naming asymmetry causes frequent bugs.

```typescript
// Sending (plural)
{ CreateCommand: { templateId, createArguments: payload } }

// Receiving (singular)
event.CreatedEvent.createArgument.someField
```

### 2. Int as String

Daml `Int` maps to TypeScript `string`, not `number`. Always pass integer amounts as strings.

```typescript
// CORRECT
{ amount: "100000000" }

// WRONG - will lose precision for large values
{ amount: 100000000 }
```

### 3. DAR Upload Idempotency

Re-uploading the same DAR returns HTTP 400 with error code `KNOWN_PACKAGE_VERSION`. This is expected and should be handled gracefully rather than treated as a failure.

### 4. Hex Prefix Mismatch

Daml uses bare hex strings. TypeScript/viem uses `0x`-prefixed hex. Always strip or add the prefix when crossing the boundary.

```typescript
// Daml -> TypeScript
const viemAddress = `0x${damlAddress}`;

// TypeScript -> Daml
const damlAddress = viemAddress.slice(2);
```

### 5. DAR Upgrade Rules

Canton enforces strict upgrade rules for DAR packages. New fields in choice arguments must be `Optional`. For breaking changes during development, restart the sandbox with a clean state.

### 6. OpenAPI Spec Quirks

Some fields marked as required in the Canton OpenAPI spec are actually optional at runtime. Always check the component descriptions and test against the actual API behavior.

### 7. RUN_ID Pattern

Use random IDs for parties and users in tests to avoid conflicts across runs. Without unique IDs, re-running tests against a persistent sandbox causes party/user collision errors.

### 8. Double-Nested Commands Object

The submit endpoint expects `{ commands: { commands: [...], userId, actAs, ... } }`. Forgetting the outer wrapper is a common mistake.

### 9. Party ID Format

Allocated party IDs include a namespace suffix (e.g., `Operator_abc123::122041a3...`). Always use the full string returned by the allocation endpoint, never truncate it.

### 10. readAs in Commands

The `readAs` field in command submission should typically include the same parties as `actAs`. Missing `readAs` parties can cause contract-not-found errors when the submitting party needs visibility into contracts owned by other parties.
