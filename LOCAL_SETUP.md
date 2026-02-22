# Canton MPC PoC — Local Setup Guide

## Components

```
┌─────────────────────────────────────────────────┐
│              Canton Synchronizer                 │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │ Sequencer│  │ Mediator │  │ Sync Manager  │ │
│  │  :10018  │  │  :10028  │  │   :10038      │ │
│  └──────────┘  └──────────┘  └───────────────┘ │
└────────────────────┬────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
┌───────┴────────┐       ┌───────┴────────┐
│ Participant 1  │       │ Participant 2  │
│ (Operator)     │       │ (Users)        │
│ gRPC    :5011  │       │ gRPC    :5021  │
│ JSON    :7575  │       │ JSON    :7585  │
│ Admin   :5012  │       │ Admin   :5022  │
└───────┬────────┘       └───────┬────────┘
        │                         │
  ┌─────┴──────┐          ┌──────┴──────┐
  │ MPC Node   │          │ User App    │
  │ (Rust,     │          │ (Frontend)  │
  │  tonic)    │          │             │
  └────────────┘          └─────────────┘
        │
  ┌─────┴──────┐
  │ PostgreSQL │
  │  :5432     │
  └────────────┘
```

### What each component does

| Component | Role |
|-----------|------|
| **Sequencer** | Orders all messages in the synchronizer (total-order multicast) |
| **Mediator** | Aggregates validation responses from participants |
| **Sync Manager** | Validates topology changes |
| **Participant 1** | Hosts the Operator party, runs VaultOrchestrator contracts |
| **Participant 2** | Hosts user parties (optional for PoC — single participant works) |
| **MPC Node (Rust)** | Subscribes to ledger events, signs EVM transactions, submits results back |
| **PostgreSQL** | Persistent storage for all Canton nodes |

---

## Hardhat Equivalence

| Hardhat | Canton |
|---------|--------|
| `npx hardhat compile` | `dpm build` |
| `npx hardhat test` | `dpm test` |
| `npx hardhat node` | `dpm sandbox` |
| `hardhat run deploy.js` | `curl --data-binary @.dar http://localhost:7575/v2/packages` |
| ethers.js / web3.js | gRPC via `tonic` (Rust) or JSON API via `reqwest` |
| Hardhat console | Canton Console (`./bin/canton -c config/...`) |
| `hardhat.config.js` | `daml.yaml` + `canton.conf` |

> **Note:** SDK 3.4 uses `dpm` (Digital Asset Package Manager) — the old `daml` CLI is deprecated.

---

## Path 1: Quick Start (In-Memory Sandbox)

Best for contract development and initial MPC integration testing. No persistence.

### Prerequisites

```bash
# Install dpm
curl -sSL https://get.digitalasset.com/install/install.sh | sh -s
dpm version --active
```

### Steps

```bash
# 1. Build the DAR
dpm build
# Output: .daml/dist/canton-mpc-poc-0.1.0.dar

# 2. Run offline tests (no Canton needed)
dpm test

# 3. Start sandbox (1 participant + 1 synchronizer, in-memory)
dpm sandbox
# gRPC Ledger API → localhost:5011
# JSON Ledger API → localhost:7575

# 4. Upload DAR (in another terminal)
curl --data-binary @.daml/dist/canton-mpc-poc-0.1.0.dar \
  http://localhost:7575/v2/packages

# 5. Allocate parties
curl -d '{"partyIdHint":"Operator"}' http://localhost:7575/v2/parties
curl -d '{"partyIdHint":"Depositor"}' http://localhost:7575/v2/parties

# 6. Run MPC node (connects to gRPC at localhost:5011)
cd mpc-node && cargo run
```

---

## Path 2: Multi-Node with Docker + PostgreSQL

Best for realistic integration testing and PoC demos. Persistent storage, multi-participant topology.

### Prerequisites

- Docker Desktop (8 GB+ memory allocated)
- PostgreSQL (via Docker or local install)
- Canton Community Edition: `docker pull digitalasset/canton-open-source:3.4.11`
  - Or download binary from https://github.com/digital-asset/canton/releases

### canton.conf (minimal)

```hocon
canton {
  participants {
    participant1 {
      storage.type = postgres
      storage.config {
        url = "jdbc:postgresql://localhost:5432/participant1"
        user = canton
        password = canton
      }
      ledger-api {
        address = "0.0.0.0"
        port = 5011
      }
      admin-api {
        address = "0.0.0.0"
        port = 5012
      }
      http-ledger-api {
        address = "0.0.0.0"
        port = 7575
      }
    }
  }

  sequencers {
    sequencer1 {
      storage.type = postgres
      storage.config {
        url = "jdbc:postgresql://localhost:5432/sequencer1"
        user = canton
        password = canton
      }
      public-api.port = 10018
      admin-api.port = 10019
    }
  }

  mediators {
    mediator1 {
      storage.type = postgres
      storage.config {
        url = "jdbc:postgresql://localhost:5432/mediator1"
        user = canton
        password = canton
      }
      admin-api.port = 10028
    }
  }
}
```

### Bootstrap in Canton Console

```bash
# Start Canton with interactive console
./bin/canton -c canton.conf
```

```scala
// 1. Bootstrap the synchronizer
bootstrap.synchronizer(
  synchronizerName = "mySynchronizer",
  sequencers = sequencers.all,
  mediators = mediators.all,
  synchronizerOwners = Seq(sequencer1),
  synchronizerThreshold = PositiveInt.one,
  staticSynchronizerParameters =
    StaticSynchronizerParameters
      .defaultsWithoutKMS(ProtocolVersion.latest)
)

// 2. Connect participant to synchronizer
participant1.synchronizers.connect(
  "mySynchronizer",
  "https://localhost:10018"
)

// 3. Upload DAR
participant1.dars.upload("/path/to/canton-mpc-poc-0.1.0.dar")

// 4. Allocate parties
val operator = participant1.parties.enable("Operator")
val depositor = participant1.parties.enable("Depositor")

// 5. Create user for MPC bot with actAs rights
participant1.users.create("mpc-bot", actAsParties = Set(operator))
```

---

## MPC Node Connection

The Rust MPC node connects to **Participant 1's Ledger API** only. It never touches the sequencer, mediator, or sync manager directly.

### APIs available

| API | Endpoint | Use |
|-----|----------|-----|
| **gRPC Ledger API** | `localhost:5011` | Primary — streaming events + command submission |
| **JSON Ledger API** | `localhost:7575` | Alternative — REST + WebSocket |

### Authentication

For local development, use HMAC-256 (unsafe, testing only):

```hocon
canton.participants.participant1.ledger-api.auth-services = [{
  type = unsafe-jwt-hmac-256
  secret = "test-secret"
}]
```

For production, use RS256 with a certificate or JWKS endpoint.

### MPC Node Flow

```
1. STARTUP
   ├── Connect gRPC channel to localhost:5011 with JWT
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
4. Start Canton           →  dpm sandbox  (or Docker multi-node)
5. Deploy DAR             →  curl --data-binary @.dar http://localhost:7575/v2/packages
6. Setup parties          →  curl -d '{"partyIdHint":"Operator"}' .../v2/parties
7. Run MPC node           →  cargo run  (connects to gRPC :5011)
8. Iterate                →  Edit → dpm build → re-upload DAR
```

---

## Useful Commands

| Command | Purpose |
|---------|---------|
| `dpm build` | Compile Daml to .dar |
| `dpm test` | Run all Daml Script tests |
| `dpm sandbox` | Start in-memory Canton sandbox |
| `dpm script --ledger-host localhost --ledger-port 5011 --script-name Test:test5_depositLifecycle` | Run script against live Canton |
| `curl http://localhost:7575/v2/packages` | List uploaded packages |
| `curl http://localhost:7575/v2/parties` | List allocated parties |
| `curl -X POST http://localhost:7575/v2/state/active-contracts -d '{...}'` | Query active contracts |
| `curl http://localhost:7575/docs/openapi` | OpenAPI spec (JSON API reference) |

---

## Reference

- [DPM CLI](https://docs.digitalasset.com/build/3.4/dpm/dpm.html)
- [Canton Releases](https://github.com/digital-asset/canton/releases)
- [gRPC Ledger API Reference](https://docs.digitalasset.com/build/3.4/reference/lapi-proto-docs.html)
- [JSON Ledger API](https://docs.digitalasset.com/build/3.4/explanations/json-api/index.html)
- [JWT Authentication](https://docs.digitalasset.com/operate/3.4/howtos/secure/apis/jwt.html)
- [CN-Quickstart (full Docker stack)](https://github.com/digital-asset/cn-quickstart)
