# Canton Operations Reference

Complete reference for Canton blockchain node setup and operations with Daml 3.x.

## Prerequisites

- **Daml SDK 3.4.11+** installed via DPM (Daml Package Manager)
- **JDK 17+** (OpenJDK or Eclipse Adoptium)
- macOS Java configuration:
  ```bash
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  ```
- Verify Java version:
  ```bash
  java -version  # Must be 17+
  ```

---

## Starting Canton Sandbox

### Basic Startup

```bash
# Start with JSON API on default port
dpm sandbox --dar .daml/dist/my-project-0.1.0.dar

# Start with explicit JSON API port
dpm sandbox --json-api-port 7575 --dar .daml/dist/my-project-0.1.0.dar

# Start without loading a DAR (upload later via API)
dpm sandbox --json-api-port 7575
```

The sandbox starts a full Canton node with:
- Sequencer, Mediator, and Participant nodes
- JSON Ledger API v2 on the specified port (default 7575)
- Admin API for topology management

### What Canton Sandbox Provides

- Single-participant Canton network (suitable for development)
- In-memory storage (data lost on restart)
- JSON Ledger API v2 (REST + WebSocket)
- Auto-generated topology (domain, participant, sequencer, mediator)

---

## Party Management

### Allocate a Party (REST API)

```bash
curl -X POST http://localhost:7575/v2/parties \
  -H "Content-Type: application/json" \
  -d '{"partyIdHint": "Issuer", "identityProviderId": ""}'
```

Response:
```json
{
  "partyDetails": {
    "party": "Issuer::122034ab...5678",
    "isLocal": true,
    "identityProviderId": ""
  }
}
```

The full party ID includes a namespace suffix (e.g., `Issuer::1220...`). Always use the full ID in subsequent API calls.

### Create a User with Rights

```bash
curl -X POST http://localhost:7575/v2/users \
  -H "Content-Type: application/json" \
  -d '{
    "user": {
      "id": "admin-user",
      "primaryParty": "Issuer::1220...",
      "isDeactivated": false,
      "identityProviderId": ""
    },
    "rights": [
      {"kind": {"CanActAs": {"value": {"party": "Issuer::1220..."}}}},
      {"kind": {"CanReadAs": {"value": {"party": "Issuer::1220..."}}}},
      {"kind": {"CanActAs": {"value": {"party": "Depositor::1220..."}}}},
      {"kind": {"CanReadAs": {"value": {"party": "Depositor::1220..."}}}}
    ]
  }'
```

### User Rights Explained

Users need:
- `CanActAs` to submit commands as a party
- `CanReadAs` to read contracts visible to a party
- A user can have rights for multiple parties
- `primaryParty` is the default party for the user (used when no explicit actAs is provided)

---

## DAR Deployment

### Upload via API

```bash
curl -X POST "http://localhost:7575/v2/dars?vetAllPackages=true" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @.daml/dist/my-project-0.1.0.dar
```

- `vetAllPackages=true` enables all packages in the DAR immediately
- Re-uploading the same DAR returns HTTP 400 with `KNOWN_PACKAGE_VERSION` -- this is safe to ignore
- Upload returns the package IDs of all packages in the DAR

### Upload at Startup

```bash
dpm sandbox --dar .daml/dist/my-project-0.1.0.dar
```

This loads the DAR during sandbox initialization before the JSON API becomes available.

### DAR Upgrade Rules

Canton enforces strict upgrade rules:

1. New fields in template records must be `Optional`
2. New fields in choice arguments must be `Optional`
3. Cannot remove existing fields
4. Cannot change field types
5. For breaking changes, restart the sandbox (it's in-memory)
6. Package name + version must be unique

---

## JSON Ledger API v2

### Available Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v2/parties` | POST | Allocate a party |
| `/v2/users` | POST | Create user with rights |
| `/v2/dars?vetAllPackages=true` | POST | Upload a DAR (binary) |
| `/v2/commands/submit-and-wait-for-transaction` | POST | Submit commands (sync, full transaction tree) |
| `/v2/commands/submit-and-wait` | POST | Submit commands (sync, returns less data) |
| `/v2/commands/async/submit` | POST | Submit commands (async) |
| `/v2/state/active-contracts` | POST | Query active contracts |
| `/docs/openapi` | GET | OpenAPI 3.0.3 spec (YAML) |
| `/docs/asyncapi` | GET | AsyncAPI spec (WebSocket) |
| `/health` | GET | Health check |

### Command Submission Format

```json
{
  "commands": {
    "commands": [
      {
        "CreateCommand": {
          "templateId": "#canton-mpc-poc:Erc20Vault:VaultOrchestrator",
          "createArguments": {
            "issuer": "Issuer::1220...",
            "mpcPublicKey": "04abcdef..."
          }
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

**NOTE:** Double nesting -- the outer `commands` object wraps the inner `commands` array plus metadata fields (`commandId`, `userId`, `actAs`, `readAs`).

### Template ID Format

```
#packageName:ModuleName:TemplateName
```

The `#` prefix enables package-name resolution so you don't need the full package hash. Examples:
- `#canton-mpc-poc:Erc20Vault:VaultOrchestrator`
- `#canton-mpc-poc:Erc20Vault:DepositRequest`

### Create Command

```json
{
  "commands": {
    "commands": [
      {
        "CreateCommand": {
          "templateId": "#canton-mpc-poc:Erc20Vault:VaultOrchestrator",
          "createArguments": {
            "issuer": "Issuer::1220...",
            "mpcPublicKey": "04abcdef..."
          }
        }
      }
    ],
    "commandId": "create-orchestrator-001",
    "userId": "admin-user",
    "actAs": ["Issuer::1220..."],
    "readAs": ["Issuer::1220..."]
  }
}
```

### Exercise Choice

```json
{
  "commands": {
    "commands": [
      {
        "ExerciseCommand": {
          "templateId": "#canton-mpc-poc:Erc20Vault:VaultOrchestrator",
          "contractId": "00abc...",
          "choice": "RequestDeposit",
          "choiceArgument": {
            "requester": "Depositor::1220...",
            "erc20Address": "a0b86991...",
            "amount": "100000000",
            "evmParams": {}
          }
        }
      }
    ],
    "commandId": "deposit-request-001",
    "userId": "admin-user",
    "actAs": ["Issuer::1220...", "Depositor::1220..."],
    "readAs": ["Issuer::1220...", "Depositor::1220..."]
  }
}
```

### Query Active Contracts

```bash
curl -X POST http://localhost:7575/v2/state/active-contracts \
  -H "Content-Type: application/json" \
  -d '{
    "filter": {
      "filtersByParty": {
        "Issuer::1220...": {
          "cumulative": {
            "templateFilters": [
              {
                "templateId": "#canton-mpc-poc:Erc20Vault:VaultOrchestrator",
                "includeCreatedEventBlob": false
              }
            ]
          }
        }
      }
    }
  }'
```

### Full cURL Example: Submit and Wait

```bash
curl -X POST http://localhost:7575/v2/commands/submit-and-wait-for-transaction \
  -H "Content-Type: application/json" \
  -d '{
    "commands": {
      "commands": [
        {
          "CreateCommand": {
            "templateId": "#canton-mpc-poc:Erc20Vault:VaultOrchestrator",
            "createArguments": {
              "issuer": "Issuer::1220...",
              "mpcPublicKey": "04abcdef..."
            }
          }
        }
      ],
      "commandId": "'"$(uuidgen)"'",
      "userId": "admin-user",
      "actAs": ["Issuer::1220..."],
      "readAs": ["Issuer::1220..."]
    }
  }'
```

---

## Canton Topology

Canton sandbox creates the following components:

- **Domain**: The shared synchronization domain where transactions are sequenced and validated
- **Participant**: Where parties and contracts live; hosts the ledger API
- **Sequencer**: Orders transactions within the domain
- **Mediator**: Validates transaction confirmations from participants

In sandbox mode, all four components run in a single process. In production, these would be separate services.

---

## Logging

```bash
# Canton logs go to stdout/stderr by default
# Also check log directory if configured
ls log/canton.log
```

Canton logs include:
- Transaction processing events
- Party/user management operations
- Package upload results
- Error details with gRPC status codes

---

## Health Check

```bash
curl http://localhost:7575/health
# Returns HTTP 200 if healthy
```

Use this to verify the sandbox is fully started before making API calls. The JSON API may take a few seconds to become available after the sandbox process starts.

---

## Troubleshooting

### Sandbox Won't Start

1. **Check `JAVA_HOME` is set to JDK 17+:**
   ```bash
   java -version  # Must be 17+
   echo $JAVA_HOME
   ```

2. **Check port is free:**
   ```bash
   lsof -i :7575
   ```
   Kill any process using the port, or choose a different port with `--json-api-port`.

3. **Increase JVM memory if OOM:**
   ```bash
   export _JAVA_OPTIONS="-Xmx4g"
   ```

4. **Check DPM is available:**
   ```bash
   dpm --version
   ```

### "KNOWN_PACKAGE_VERSION" on DAR Upload

This means the DAR is already uploaded. Safe to ignore -- handle in code:

```typescript
if (text.includes("KNOWN_PACKAGE_VERSION")) return; // idempotent
```

This is expected behavior when re-running setup scripts.

### Party Not Found

- Party IDs include a namespace suffix: `Issuer::1220...` not just `Issuer`
- Always use the full party ID returned from `/v2/parties`
- Party IDs are stable for the lifetime of the sandbox but change on restart

### Command Fails with INVALID_ARGUMENT

- Check signatory/observer rules match the `actAs` parties
- Verify template ID format: `#packageName:Module:Template`
- Ensure all required fields are present in `createArguments`
- Check that `actAs` includes all required signatories for the template

### "NOT_FOUND" for Contract

- Contract may have been consumed (archived) by a choice exercise
- Check if the contract ID is from a previous transaction that was already exercised
- Use `/v2/state/active-contracts` to query current active state
- Contract IDs change after each exercise (consuming choices archive the old contract and may create new ones)

### Sandbox Crashes Silently

- Check Java version (must be 17+)
- Check for port conflicts on both the JSON API port and internal Canton ports
- Look at stderr output for stack traces
- Try running with `--verbose` flag for additional debug output
- Ensure sufficient memory is available (Canton needs at least 1-2 GB)

### Connection Refused

- The sandbox may still be starting up -- wait a few seconds and retry
- Use the health endpoint to check readiness:
  ```bash
  curl --retry 10 --retry-delay 2 --retry-connrefused http://localhost:7575/health
  ```

### Template Not Found After DAR Upload

- Ensure `vetAllPackages=true` was used in the upload
- Verify the template ID format uses `#` prefix for package-name resolution
- Check that the module and template names match the Daml source exactly (case-sensitive)

---

## Development Workflow

```bash
# 1. Build DAR
dpm build

# 2. Run Daml tests
dpm test

# 3. Start sandbox (in a separate terminal)
dpm sandbox --json-api-port 7575 --dar .daml/dist/my-project-0.1.0.dar

# 4. Generate TypeScript types (while sandbox is running)
curl http://localhost:7575/docs/openapi -o ts-tests/openapi.yaml
npx openapi-typescript ts-tests/openapi.yaml -o ts-tests/generated/api/ledger-api.ts
dpm codegen-js .daml/dist/my-project-0.1.0.dar -o ts-tests/generated/model -s daml.js

# 5. Run TypeScript tests
cd ts-tests && npm test

# 6. When changing Daml contracts:
#    - Stop sandbox (Ctrl+C)
#    - dpm build
#    - Restart sandbox with new DAR
#    - Re-run codegen if templates changed
```

### Key Points for the Development Loop

- The sandbox uses in-memory storage, so all data is lost on restart
- After changing Daml templates, you must rebuild the DAR and restart the sandbox
- TypeScript codegen should be re-run whenever template definitions change
- The OpenAPI spec is generated from the running sandbox and reflects uploaded packages
- Party IDs change on each sandbox restart (they include a unique namespace hash)

---

## Quick Reference

### Common Commands

| Task | Command |
|------|---------|
| Build DAR | `dpm build` |
| Run Daml tests | `dpm test` |
| Start sandbox | `dpm sandbox --json-api-port 7575 --dar .daml/dist/my-project-0.1.0.dar` |
| Health check | `curl http://localhost:7575/health` |
| Allocate party | `curl -X POST http://localhost:7575/v2/parties -H "Content-Type: application/json" -d '{"partyIdHint":"Alice","identityProviderId":""}'` |
| Upload DAR | `curl -X POST "http://localhost:7575/v2/dars?vetAllPackages=true" -H "Content-Type: application/octet-stream" --data-binary @.daml/dist/my-project-0.1.0.dar` |
| Get OpenAPI spec | `curl http://localhost:7575/docs/openapi` |

### Important Reminders

- Always use full party IDs (with `::1220...` suffix) in API calls
- Template IDs use `#` prefix for package-name resolution
- Command submission has double nesting: outer `commands` object wraps inner `commands` array
- `vetAllPackages=true` is required when uploading DARs to make templates available
- The sandbox must be restarted when Daml templates change (in-memory storage)
- JDK 17+ is required; set `JAVA_HOME` on macOS
