# Daml + TypeScript Integration Guide

> Based on the official DA tutorials and [Canton JSON Ledger API v2 docs](https://docs.digitalasset.com/build/3.4/tutorials/json-api/canton_and_the_json_ledger_api_ts.html) as of Feb 2026.

## Prerequisites

- **Daml SDK 3.4.11+** via [DPM](https://docs.digitalasset.com/build/3.4/dpm/dpm.html) (Digital Asset Package Manager, replaces the deprecated `daml` CLI)
- **JDK 17+** (OpenJDK or Eclipse Adoptium)
- **Node.js 18.20+**

### Install DPM

```bash
# macOS / Linux
curl https://get.digitalasset.com/install/install.sh | sh

# Add to shell profile
export PATH="$HOME/.dpm/bin:$PATH"
```

### Install SDK + Set Java

```bash
dpm install 3.4.11

# macOS with Homebrew
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
```

## Project Setup

### Build the DAR

```bash
dpm build
# Output: .daml/dist/canton-mpc-poc-0.1.0.dar
```

### Start the Sandbox

```bash
dpm sandbox --json-api-port 7575 --dar .daml/dist/canton-mpc-poc-0.1.0.dar
```

Starts a full Canton node with the JSON Ledger API v2 on `http://localhost:7575`.

---

## TypeScript Integration (Recommended Stack)

DA's official TypeScript tutorial uses two code generation layers.

### Layer 1: OpenAPI Client (`openapi-fetch` + `openapi-typescript`)

This is the **primary integration point** -- a type-safe HTTP client generated from the Canton OpenAPI spec.

```bash
npm install openapi-fetch
npm install -D openapi-typescript
```

Generate types from the running sandbox:

```bash
# The spec is served at /docs/openapi (OpenAPI 3.0.3)
curl http://localhost:7575/docs/openapi -o openapi.yaml
npx openapi-typescript openapi.yaml -o generated/api/ledger-api.ts
```

Create the client (`src/client.ts`):

```typescript
import createClient from "openapi-fetch";
import type { paths } from "../generated/api/ledger-api";

export const client = createClient<paths>({ baseUrl: "http://localhost:7575" });
```

All API calls are then fully typed:

```typescript
// Allocate a party
const { data } = await client.POST("/v2/parties", {
  body: { partyIdHint: "Operator", identityProviderId: "" },
});
const party = data!.partyDetails!.party;

// Submit a create command
import type { components } from "../generated/api/ledger-api";
import * as Iou from "../generated/model/lib/Iou";

const command: components["schemas"]["CreateCommand"] = {
  createArguments: { issuer: party, owner: party, currency: "USD", amount: "100" },
  templateId: Iou.Iou.templateId,
};

await client.POST("/v2/commands/submit-and-wait", {
  body: makeCommands(party, [{ CreateCommand: command }]),
});

// Query active contracts
const { data: contracts } = await client.POST("/v2/state/active-contracts", {
  body: filter,
});
```

> DA's recommended generator: [openapi-ts.dev/openapi-fetch](https://openapi-ts.dev/openapi-fetch/).
> Note: many OpenAPI generators have bugs with the 3.0.3 spec. DA tests `openapi-fetch` specifically.

### Layer 2: Daml Model Bindings (`codegen-js`)

Generates TypeScript types for your Daml templates, choices, and data types from the DAR.

```bash
dpm codegen-js .daml/dist/canton-mpc-poc-0.1.0.dar -o generated/model -s daml.js
```

Or via `daml.yaml`:

```yaml
codegen:
  js:
    output-directory: generated/model
    npm-scope: daml.js
```

Then `dpm codegen-js` with no args.

**What it generates:**

- TypeScript interfaces for all records, variants, enums
- Template companion objects with `templateId` constants
- Choice argument types
- Runtime serialization helpers

Depends on the `@daml/types` npm package for base types.

**Type mappings (Daml -> TypeScript):**

| Daml          | TypeScript           | JS representation            |
| ------------- | -------------------- | ---------------------------- |
| `Text`        | `string`             | `string`                     |
| `Int`         | `string`             | `string` (avoids precision loss) |
| `Decimal`     | `string`             | `string`                     |
| `Bool`        | `boolean`            | `boolean`                    |
| `Party`       | `string`             | `string`                     |
| `ContractId`  | `string`             | `string`                     |
| `Time`        | `string`             | `string` (ISO 8601)          |
| `Date`        | `string`             | `string`                     |
| `[a]`         | `a[]`                | `a[]`                        |
| `Optional a`  | `a \| null`          | conditional encoding         |
| `TextMap a`   | `{ [key: string]: a }` | object                     |

**Generated code example:**

```daml
-- Daml
data EvmTransactionParams = EvmTransactionParams with
  erc20Address : BytesHex
  recipient    : BytesHex
  amount       : BytesHex
```

```typescript
// Generated TypeScript
type EvmTransactionParams = {
  erc20Address: string;
  recipient: string;
  amount: string;
};
```

Templates generate companion objects with `templateId` so you never hardcode IDs:

```typescript
// Instead of "#canton-mpc-poc:Erc20Vault:VaultOrchestrator"
import * as VaultOrchestrator from "../generated/model/lib/Erc20Vault/VaultOrchestrator";
const tid = VaultOrchestrator.VaultOrchestrator.templateId;
```

### Layer 3 (Optional): WebSocket Streaming (AsyncAPI)

For real-time contract updates, Canton exposes WebSocket endpoints described by an AsyncAPI spec at `http://localhost:7575/docs/asyncapi`.

Key streaming channels:

| Endpoint                       | Purpose                        |
| ------------------------------ | ------------------------------ |
| `ws://.../v2/updates`          | Transaction and reassignment events |
| `ws://.../v2/state/active-contracts` | Active contract snapshot stream |
| `ws://.../v2/commands/completions`   | Command completion status      |

```typescript
const ws = new WebSocket("ws://localhost:7575/v2/updates");

ws.onopen = () => {
  ws.send(JSON.stringify({
    beginExclusive: 0,
    verbose: true,
    updateFormat: {
      includeTransactions: {
        eventFormat: {
          filtersByParty: {
            [operatorParty]: {
              cumulative: [{
                identifierFilter: {
                  WildcardFilter: { value: { includeCreatedEventBlob: true } }
                }
              }]
            }
          }
        },
        transactionShape: "TRANSACTION_SHAPE_ACS_DELTA"
      }
    }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.update?.Transaction) {
    // handle transaction events
  }
};
```

---

## JSON Ledger API v2 Quick Reference

### Key Concepts

- **User-based auth**: Commands require a `userId`. Users must be created with `CanActAs`/`CanReadAs` rights first.
- **Template IDs**: `#packageName:Module:Template` (the `#` prefix enables package-name resolution so you don't need the full hash).
- **Hex in Daml**: Bare hex, no `0x` prefix (`"a0b86991..."`).
- **Hex in TypeScript/viem**: `0x`-prefixed (`"0xa0b86991..."`).

### Command Submission

`POST /v2/commands/submit-and-wait-for-transaction`

```json
{
  "commands": {
    "commands": [
      {
        "CreateCommand": {
          "templateId": "#canton-mpc-poc:Erc20Vault:VaultOrchestrator",
          "createArguments": { "operator": "...", "mpcPublicKey": "..." }
        }
      }
    ],
    "commandId": "unique-uuid",
    "userId": "my-user",
    "actAs": ["Party::1220..."],
    "readAs": ["Party::1220..."]
  }
}
```

Note the nesting: outer `commands` object wraps inner `commands` array + metadata.

### Response Format

Created events use `createArgument` (**singular**):

```json
{
  "transaction": {
    "events": [{
      "CreatedEvent": {
        "contractId": "00abc...",
        "templateId": "hash:Module:Template",
        "createArgument": { "field": "value" },
        "signatories": ["Party::1220..."],
        "observers": []
      }
    }]
  }
}
```

### Endpoint Summary

| Endpoint                                            | Purpose                |
| --------------------------------------------------- | ---------------------- |
| `POST /v2/parties`                                  | Allocate a party       |
| `POST /v2/users`                                    | Create user + rights   |
| `POST /v2/dars?vetAllPackages=true`                 | Upload a DAR           |
| `POST /v2/commands/submit-and-wait-for-transaction` | Submit commands (sync) |
| `POST /v2/commands/async/submit`                    | Submit commands (async)|
| `POST /v2/state/active-contracts`                   | Query active contracts |
| `GET /docs/openapi`                                 | OpenAPI spec (YAML)    |
| `GET /docs/asyncapi`                                | AsyncAPI spec (WS)     |

### Party Allocation

```json
POST /v2/parties
{
  "partyIdHint": "Operator",
  "identityProviderId": ""
}
```

### User Creation

Users need `CanActAs` rights for each party they act as:

```json
POST /v2/users
{
  "user": {
    "id": "admin-user",
    "primaryParty": "Operator::1220...",
    "isDeactivated": false,
    "identityProviderId": ""
  },
  "rights": [
    { "kind": { "CanActAs": { "value": { "party": "Operator::1220..." } } } },
    { "kind": { "CanReadAs": { "value": { "party": "Operator::1220..." } } } },
    { "kind": { "CanActAs": { "value": { "party": "Depositor::1220..." } } } },
    { "kind": { "CanReadAs": { "value": { "party": "Depositor::1220..." } } } }
  ]
}
```

---

## Gotchas

- **Request vs response field names**: The API accepts `createArguments` (plural) in commands but returns `createArgument` (singular) in events.
- **DAR upload idempotency**: Re-uploading the same DAR returns `KNOWN_PACKAGE_VERSION` (400). Handle gracefully.
- **DAR upgrades**: Canton enforces strict upgrade rules -- new fields in choice arguments must be `Optional`. To deploy breaking changes, restart the sandbox.
- **OpenAPI spec quirks**: Some fields marked required in the spec are actually optional. Check component descriptions when things don't match.
- **`DA.Crypto.Text` alpha flag**: Requires `-Wno-crypto-text-is-alpha` in `build-options` in `daml.yaml`.
- **Daml crypto functions**: `keccak256` and `secp256k1WithEcdsaOnly` operate on bare hex (no `0x`). `secp256k1WithEcdsaOnly` does NOT hash the input (unlike `secp256k1` which SHA256-hashes first).
- **DER encoding**: Public keys and signatures for `secp256k1WithEcdsaOnly` must be DER-encoded, not raw r||s values.
- **`submitMulti` deprecated**: Use `submit (actAs x <> actAs y)` in Daml Script instead.
- **`Int` as string**: Daml `Int` maps to TypeScript `string` to avoid JS number precision loss. Pass amounts as `"100000000"` not `100000000`.

---

## Sources

- [Canton + JSON API + TypeScript Tutorial](https://docs.digitalasset.com/build/3.4/tutorials/json-api/canton_and_the_json_ledger_api_ts.html)
- [DPM Documentation](https://docs.digitalasset.com/build/3.4/dpm/dpm.html)
- [Daml Codegen for JavaScript](https://docs.digitalasset.com/build/3.5/component-howtos/application-development/daml-codegen-javascript.html)
- [JSON Ledger API OpenAPI Reference](https://docs.digitalasset.com/build/3.4/reference/json-api/openapi.html)
- [JSON Ledger API AsyncAPI (WebSocket)](https://docs.digitalasset.com/build/3.3/reference/json-api/asyncapi.html)
- [openapi-fetch (DA-recommended generator)](https://openapi-ts.dev/openapi-fetch/)
