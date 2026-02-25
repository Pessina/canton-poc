# Canton MPC PoC — Local Setup Guide (Sandbox)

This guide covers running the canton-mpc-poc project using the DPM in-memory sandbox. This is the recommended path for contract development, testing, and initial MPC integration work.

The Ledger API (gRPC and JSON) exposed by the sandbox uses the same protocol as a production Canton participant. Your off-chain service code (MPC node, TypeScript tests) will work against both without changes to the core integration logic. See [PROD_SETUP.md](./PROD_SETUP.md) for what changes when moving to a multi-node or production deployment.

---

## Architecture (Sandbox Mode)

```
┌─────────────────────────────────────────────────────────┐
│           Canton Sandbox (single JVM process)            │
│                                                          │
│  ┌────────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ Sequencer  │  │ Mediator │  │ Participant        │  │
│  │ (internal) │  │(internal)│  │ gRPC  :6865        │  │
│  └────────────┘  └──────────┘  │ JSON  :7575        │  │
│                                └─────────┬──────────┘  │
└──────────────────────────────────────────┼──────────────┘
                                           │
                   ┌───────────────────────┼───────────────┐
                   │                       │               │
             ┌─────┴──────┐      ┌────────┴────┐    ┌─────┴──────┐
             │ MPC Node   │      │ TypeScript  │    │   curl     │
             │ (Rust,     │      │ Tests       │    │   (manual) │
             │  tonic)    │      │ (vitest)    │    │            │
             └────────────┘      └─────────────┘    └────────────┘
```

### What the sandbox provides

| Component           | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| **Sequencer**       | Orders all messages (runs in-process, no exposed port)             |
| **Mediator**        | Aggregates validation responses (runs in-process, no exposed port) |
| **Participant**     | Hosts all parties, runs contracts, exposes Ledger APIs             |
| **JSON Ledger API** | REST + WebSocket interface at `http://localhost:7575`              |
| **gRPC Ledger API** | Streaming interface at `localhost:6865`                            |

In sandbox mode all Canton components run in a single JVM process with in-memory storage. Data is lost on restart.

### What the sandbox does NOT cover

The sandbox runs a single participant with all parties co-hosted. This means:

- No multi-participant transaction visibility — every party sees everything
- No JWT authentication required on API calls
- No TLS on gRPC/HTTP connections
- No real consensus latency (sequencer/mediator are in-process)
- No network failure scenarios (everything is localhost, in-process)

These concerns are covered in [PROD_SETUP.md](./PROD_SETUP.md).

---

## Hardhat Equivalence

| Hardhat                 | Canton                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx hardhat compile`   | `dpm build`                                                                                                                                                       |
| `npx hardhat test`      | `dpm test`                                                                                                                                                        |
| `npx hardhat node`      | `dpm sandbox`                                                                                                                                                     |
| `hardhat run deploy.js` | `curl -X POST "http://localhost:7575/v2/dars?vetAllPackages=true" -H "Content-Type: application/octet-stream" --data-binary @.daml/dist/canton-mpc-poc-0.0.1.dar` |
| ethers.js / web3.js     | gRPC via `tonic` (Rust) or JSON Ledger API v2 via `fetch`/`reqwest`                                                                                               |
| Hardhat console         | Canton Console (`./bin/canton -c config/...`) — not needed for sandbox                                                                                            |
| `hardhat.config.js`     | `daml.yaml`                                                                                                                                                       |

> **Note:** SDK 3.4 uses `dpm` (Digital Asset Package Manager) — the old `daml` CLI is deprecated.

---

## Prerequisites

### 1. Install JDK 21

Canton 3.4.x is built and tested against Java 21 (all [GitHub releases](https://github.com/digital-asset/canton/releases) report `OpenJDK 21.0.5`).

```bash
# macOS (Homebrew)
brew install openjdk@21

# Set JAVA_HOME (add to ~/.zshrc for persistence)
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home

# Verify
java -version   # Should be 21+
echo $JAVA_HOME
```

### 2. Install DPM

```bash
curl https://get.digitalasset.com/install/install.sh | sh

# Add to PATH (add to ~/.zshrc for persistence)
export PATH="$HOME/.dpm/bin:$PATH"

# Install the SDK version this project uses
dpm install 3.4.11

# Verify
dpm version
```

### 3. Increase JVM Memory (recommended)

Canton can be memory-hungry. Set at least 4 GB heap:

```bash
export _JAVA_OPTIONS="-Xmx4g"
```

---

## Step-by-Step: Sandbox Development

### Step 1: Build the DAR

```bash
dpm build
# Output: .daml/dist/canton-mpc-poc-0.0.1.dar
```

This compiles all `.daml` files in the `daml/` directory into a DAR (Daml Archive). The output path is determined by `name` and `version` in `daml.yaml`.

### Step 2: Run Offline Tests

```bash
# Run all tests
dpm test

# Run a specific test
dpm test --test-pattern "test5_depositLifecycle"

# Run tests from a specific file
dpm test --files daml/Test.daml
```

Tests execute against an in-memory ledger — no Canton sandbox needed. This is the fastest feedback loop for contract logic.

### Step 3: Start the Sandbox

```bash
# Start sandbox with DAR loaded at startup
dpm sandbox --json-api-port 7575 --dar .daml/dist/canton-mpc-poc-0.0.1.dar
```

This starts a full Canton node with:

- JSON Ledger API at `http://localhost:7575`
- gRPC Ledger API at `localhost:6865`

The sandbox runs in the foreground. Use `Ctrl+C` to stop it. Leave this terminal running and open a new one for the next steps.

**Wait for readiness** before proceeding:

```bash
# Poll until the JSON API is up (retry for ~20 seconds)
curl --retry 10 --retry-delay 2 --retry-connrefused http://localhost:7575/health
```

### Step 4: Allocate Parties

Party IDs include a namespace suffix (`::1220...`). Save the full IDs from the responses — you need them for all subsequent API calls.

```bash
# Allocate the Issuer party
curl -s -X POST http://localhost:7575/v2/parties \
  -H "Content-Type: application/json" \
  -d '{"partyIdHint": "Issuer", "identityProviderId": ""}'
# Response: {"partyDetails":{"party":"Issuer::1220abcd...","isLocal":true,...}}

# Allocate the Depositor party
curl -s -X POST http://localhost:7575/v2/parties \
  -H "Content-Type: application/json" \
  -d '{"partyIdHint": "Depositor", "identityProviderId": ""}'
# Response: {"partyDetails":{"party":"Depositor::1220efgh...","isLocal":true,...}}
```

### Step 5: Create a User with Rights

Commands require a `userId`. Create a user with `CanActAs` and `CanReadAs` rights for both parties:

```bash
curl -s -X POST http://localhost:7575/v2/users \
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

Replace `Issuer::1220...` and `Depositor::1220...` with the actual full party IDs from Step 4.

### Step 6: Create the VaultOrchestrator Contract

```bash
curl -s -X POST http://localhost:7575/v2/commands/submit-and-wait-for-transaction \
  -H "Content-Type: application/json" \
  -d '{
    "commands": {
      "commands": [
        {
          "CreateCommand": {
            "templateId": "#canton-mpc-poc:Erc20Vault:VaultOrchestrator",
            "createArguments": {
              "issuer": "Issuer::1220...",
              "mpcPublicKey": "3056301006072a8648ce3d020106052b8104000a034200049b51a3db8f697ac5e49078b01af8d2721dd9a39b81c59bae57d13e5c5d4c915649441be47149b0293b28d8b4a92416045bb39f922329f197fdeed3320c0746a5"
            }
          }
        }
      ],
      "commandId": "create-orchestrator-001",
      "userId": "admin-user",
      "actAs": ["Issuer::1220..."],
      "readAs": ["Issuer::1220..."]
    }
  }'
```

The response contains the created contract's ID — save it for exercising choices.

> **Template ID format:** `#packageName:ModuleName:TemplateName` — the `#` prefix enables package-name resolution so you don't need the full package hash.

### Step 7: Query Active Contracts

Verify the orchestrator was created:

```bash
curl -s -X POST http://localhost:7575/v2/state/active-contracts \
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

### Step 8: Exercise Choices (Example: RequestDeposit)

```bash
curl -s -X POST http://localhost:7575/v2/commands/submit-and-wait-for-transaction \
  -H "Content-Type: application/json" \
  -d '{
    "commands": {
      "commands": [
        {
          "ExerciseCommand": {
            "templateId": "#canton-mpc-poc:Erc20Vault:VaultOrchestrator",
            "contractId": "<orchestrator-contract-id>",
            "choice": "RequestDeposit",
            "choiceArgument": {
              "requester": "Depositor::1220...",
              "erc20Address": "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
              "amount": "100000000.0",
              "evmParams": {
                "erc20Address": "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                "recipient": "d8da6bf26964af9d7eed9e03e53415d37aa96045",
                "amount": "0000000000000000000000000000000000000000000000000000000005f5e100",
                "nonce": "0000000000000000000000000000000000000000000000000000000000000001",
                "gasLimit": "000000000000000000000000000000000000000000000000000000000000c350",
                "maxFeePerGas": "0000000000000000000000000000000000000000000000000000000ba43b7400",
                "maxPriorityFee": "0000000000000000000000000000000000000000000000000000000077359400",
                "chainId": "0000000000000000000000000000000000000000000000000000000000000001",
                "value": "0000000000000000000000000000000000000000000000000000000000000000",
                "operation": "Erc20Transfer"
              }
            }
          }
        }
      ],
      "commandId": "deposit-request-001",
      "userId": "admin-user",
      "actAs": ["Issuer::1220...", "Depositor::1220..."],
      "readAs": ["Issuer::1220...", "Depositor::1220..."]
    }
  }'
```

> **Multi-controller note:** `RequestDeposit` requires `controller issuer, requester` — both parties must be in `actAs`.

---

## Contract Templates

| Template                   | Module       | Description                                         |
| -------------------------- | ------------ | --------------------------------------------------- |
| `VaultOrchestrator`        | `Erc20Vault` | Drives the deposit/withdraw state machine           |
| `PendingDeposit`           | `Erc20Vault` | Deposit waiting for MPC confirmation                |
| `PendingWithdrawal`        | `Erc20Vault` | Withdrawal waiting for MPC execution                |
| `Erc20Holding`         | `Holding`    | Per-user ERC-20 balance (CIP-56 Holding)            |
| `VaultTransferFactory`     | `Transfer`   | CIP-56 TransferFactory for transfers                |
| `VaultTransferInstruction` | `Transfer`   | CIP-56 TransferInstruction (accept/reject/withdraw) |

### Choice Map

| Template            | Choice               | Type         | Controller          | Returns                                                                  |
| ------------------- | -------------------- | ------------ | ------------------- | ------------------------------------------------------------------------ |
| `VaultOrchestrator` | `RequestDeposit`     | nonconsuming | issuer, requester | `ContractId PendingDeposit`                                              |
| `VaultOrchestrator` | `ClaimDeposit`       | nonconsuming | issuer            | `ContractId Erc20Holding`                                            |
| `VaultOrchestrator` | `RequestWithdrawal`  | nonconsuming | issuer, requester | `(Optional (ContractId Erc20Holding), ContractId PendingWithdrawal)` |
| `VaultOrchestrator` | `CompleteWithdrawal` | nonconsuming | issuer            | `Optional (ContractId Erc20Holding)`                                 |
| `VaultOrchestrator` | `ExecuteTransfer`    | nonconsuming | issuer, sender    | `TransferInstructionResult`                                              |

---

## MPC Node Connection

The Rust MPC node connects to the Participant's gRPC Ledger API only. It never touches the sequencer or mediator directly.

### Endpoints

| API                 | Endpoint                | Use                                             |
| ------------------- | ----------------------- | ----------------------------------------------- |
| **gRPC Ledger API** | `localhost:6865`        | Primary — streaming events + command submission |
| **JSON Ledger API** | `http://localhost:7575` | REST + WebSocket alternative                    |

### MPC Node Flow

```
1. STARTUP
   ├── Connect gRPC channel to localhost:6865
   ├── StateService::GetActiveContracts → load existing PendingDeposit/PendingWithdrawal
   └── Record offset

2. SUBSCRIBE (from offset)
   └── UpdateService::GetUpdates → streaming loop, filtered by template

3. ON PendingDeposit CREATED
   ├── Extract requestId, evmParams from CreatedEvent fields
   ├── Verify the ERC-20 deposit on-chain (EVM RPC)
   ├── MPC sign: responseHash = keccak256(requestId || txHash)
   └── CommandService::SubmitAndWait → exercise ClaimDeposit

4. ON PendingWithdrawal CREATED
   ├── Extract evmParams, recipientAddress, amount
   ├── Build raw EVM transaction from params
   ├── MPC sign the EVM transaction
   ├── Broadcast to Ethereum
   ├── Collect result (tx hash or failure)
   └── CommandService::SubmitAndWait → exercise CompleteWithdrawal

5. CRASH RECOVERY
   └── Restart from last persisted offset checkpoint
```

### Rust gRPC Setup

Canton proto files are vendored from `digital-asset/canton` (pin to 3.4.x tag):

- Services: `community/ledger-api-proto/src/main/protobuf/com/daml/ledger/api/v2/`
- Values: `community/daml-lf/ledger-api-value/src/main/protobuf/com/daml/ledger/api/v2/value.proto`

```toml
# Cargo.toml
[dependencies]
tonic = { version = "0.12", features = ["tls"] }
prost = "0.13"
prost-types = "0.13"
tokio = { version = "1", features = ["full"] }

[build-dependencies]
tonic-build = "0.12"
```

No existing Rust crates for Canton 3.x — build from proto stubs with `tonic-build`.

---

## Development Workflow

```
1. Edit Daml contracts    →  daml/*.daml
2. Build                  →  dpm build
3. Test (offline)         →  dpm test
4. Start Canton           →  dpm sandbox --json-api-port 7575 --dar .daml/dist/canton-mpc-poc-0.0.1.dar
5. Wait for health        →  curl --retry 10 --retry-delay 2 --retry-connrefused http://localhost:7575/health
6. Setup parties + user   →  POST /v2/parties + POST /v2/users (see steps 4-5 above)
7. Create contracts       →  POST /v2/commands/submit-and-wait-for-transaction
8. Run MPC node           →  cargo run  (connects to gRPC :6865)
9. Iterate                →  Ctrl+C sandbox → dpm build → restart sandbox
```

### Key Points

- The sandbox uses in-memory storage — **all data is lost on restart**
- After changing Daml templates, you must `dpm build` and restart the sandbox
- Party IDs change on each sandbox restart (they include a unique namespace hash)
- `vetAllPackages=true` is required when uploading DARs to make templates available
- Always use the full party ID (`Issuer::1220...`), never just `Issuer`
- Command submission has double nesting: outer `commands` object wraps inner `commands` array

---

## Useful Commands

| Command                                                                                                                                                              | Purpose                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `dpm build`                                                                                                                                                          | Compile Daml to .dar                   |
| `dpm test`                                                                                                                                                           | Run all Daml Script tests              |
| `dpm test --test-pattern "testName"`                                                                                                                                 | Run a specific test                    |
| `dpm sandbox --json-api-port 7575 --dar .daml/dist/canton-mpc-poc-0.0.1.dar`                                                                                         | Start sandbox with DAR                 |
| `curl http://localhost:7575/health`                                                                                                                                  | Health check (HTTP 200 = ready)        |
| `curl -s -X POST http://localhost:7575/v2/parties -H "Content-Type: application/json" -d '{"partyIdHint":"Alice","identityProviderId":""}'`                          | Allocate a party                       |
| `curl -s -X POST "http://localhost:7575/v2/dars?vetAllPackages=true" -H "Content-Type: application/octet-stream" --data-binary @.daml/dist/canton-mpc-poc-0.0.1.dar` | Upload DAR (if not loaded at startup)  |
| `curl http://localhost:7575/docs/openapi`                                                                                                                            | OpenAPI spec (YAML)                    |
| `curl http://localhost:7575/docs/asyncapi`                                                                                                                           | AsyncAPI spec (WebSocket)              |
| `dpm daml script --dar .daml/dist/canton-mpc-poc-0.0.1.dar --script-name Test:test5_depositLifecycle --ledger-host localhost --ledger-port 6865`                     | Run a Daml Script against live sandbox |

---

## Troubleshooting

### Java Not Found

```bash
# Check if Java is installed
java -version

# If not installed (macOS)
brew install openjdk@21
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
```

### Port Already in Use

```bash
lsof -i :7575
lsof -i :6865
kill <PID>

# Or use different ports
dpm sandbox --json-api-port 7576 --canton-port 6866
```

### Sandbox Crashes on Startup

1. Check JVM memory: `export _JAVA_OPTIONS="-Xmx4g"`
2. Clear sandbox state: `rm -rf .canton`
3. Ensure DAR was built with same SDK version: `grep sdk-version daml.yaml && dpm version`

### "KNOWN_PACKAGE_VERSION" on DAR Upload

The DAR is already uploaded. Safe to ignore — this is idempotent behavior.

### Party Not Found

Party IDs include a namespace suffix. Always use the full ID returned from `/v2/parties`:

- Correct: `Issuer::122034ab...5678`
- Wrong: `Issuer`

### Command Fails with INVALID_ARGUMENT

- Check that `actAs` includes all required signatories/controllers for the choice
- Verify template ID format uses `#` prefix: `#canton-mpc-poc:Erc20Vault:VaultOrchestrator`
- Ensure all required fields are present in `createArguments` or `choiceArgument`

### Template Not Found After DAR Upload

- Ensure `vetAllPackages=true` was in the upload URL
- Module and template names are case-sensitive
- Verify the DAR was actually uploaded: check the upload response for package IDs

---

## Reference

- [DPM CLI](https://docs.digitalasset.com/build/3.4/dpm/dpm.html)
- [Canton Releases](https://github.com/digital-asset/canton/releases)
- [gRPC Ledger API Reference](https://docs.digitalasset.com/build/3.4/reference/lapi-proto-docs.html)
- [gRPC Ledger API Services](https://docs.digitalasset.com/build/3.5/explanations/ledger-api-services.html)
- [JSON Ledger API](https://docs.digitalasset.com/build/3.4/explanations/json-api/index.html)
- [JWT Authentication](https://docs.digitalasset.com/operate/3.4/howtos/secure/apis/jwt.html)
- [Production Setup Guide](./PROD_SETUP.md)
