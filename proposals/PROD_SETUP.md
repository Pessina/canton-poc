# Canton MPC PoC — Production Setup Guide

This guide covers migrating from the local sandbox ([LOCAL_SETUP.md](./LOCAL_SETUP.md)) to a multi-node Canton topology and eventually to production. It focuses on what changes for the off-chain MPC node and other services that integrate with the Ledger API.

---

## Sandbox vs Production: What's the Same, What Changes

### Ledger API — identical protocol

The gRPC and JSON Ledger API v2 is the same protocol in sandbox and production. Your off-chain service code uses the same:

| Concern | Same across sandbox and production? |
|---------|-------------------------------------|
| gRPC proto contract (`UpdateService`, `StateService`, `CommandService`) | Yes |
| JSON Ledger API endpoints (`/v2/commands/*`, `/v2/state/*`, `/v2/updates/*`) | Yes |
| Event streaming model (`CreatedEvent`, `ArchivedEvent`, offset-based) | Yes |
| Command submission format (`SubmitAndWait`, template IDs, choice arguments) | Yes |
| Contract payload encoding (Daml-to-JSON / Daml-to-protobuf) | Yes |

Your MPC node's core loop — subscribe to `PendingDeposit`/`PendingWithdrawal`, extract fields, exercise `ClaimDeposit`/`CompleteWithdrawal` — works identically.

### What changes in production

| Concern | Sandbox | Production | Impact on MPC Node |
|---------|---------|------------|-------------------|
| **Transaction visibility** | Single participant sees all events for all parties | Each participant only sees events for parties it hosts | MPC node must connect to the participant hosting Issuer. It won't see Depositor-only events unless Issuer is a stakeholder on the contract. |
| **Authentication** | No JWT required (unsecured) | JWT required on every gRPC and JSON API call | You need a JWT token provider in the Rust client. This is a real code change. |
| **TLS** | Plaintext localhost | TLS required on all connections | `tonic` TLS config with CA certs, client certs if mTLS. |
| **Multi-controller choices** | Both parties on same participant — single `actAs` list works | Parties on separate participants — Canton's confirmation protocol handles cross-participant authorization | `ClaimDeposit` (controller: issuer only) works fine. `RequestDeposit` (controller: issuer + requester) needs cross-participant `actAs` grants or delegation. |
| **Offset semantics** | Simple, monotonic | Causal within a synchronizer, but not globally ordered across synchronizers | Minimal impact for single-synchronizer setups, but crash recovery should not assume global offset ordering. |
| **Network reliability** | Localhost, never fails | gRPC connections drop, need reconnect/retry | Exponential backoff, stream reconnection, idempotent command submission. |
| **Latency** | Near-instant (in-process sequencer/mediator) | Real consensus rounds (tens of ms) | Timeouts and polling intervals need realistic values. |
| **Storage** | In-memory (lost on restart) | PostgreSQL (persistent) | No code change — this is Canton config, not Ledger API behavior. |

---

## Phase 1: Multi-Node Local (Staging Environment)

Before going to production, test against a multi-node Canton topology running locally. This catches visibility, auth, and multi-participant issues without deploying infrastructure.

### Prerequisites

Everything from [LOCAL_SETUP.md](./LOCAL_SETUP.md), plus:

#### Install JDK 21

Canton 3.4.x is built and tested against Java 21. All [GitHub releases](https://github.com/digital-asset/canton/releases) for 3.4.x report `OpenJDK 21.0.5`.

```bash
# macOS (Homebrew)
brew install openjdk@21

# Set JAVA_HOME (add to ~/.zshrc for persistence)
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home

# Verify
java -version   # Should be 21+
```

#### Download the Canton Binary

The Canton open-source release (~291 MB) is distributed separately from DPM. It contains `bin/canton`, reference configs, and all JARs.

```bash
# Download from GitHub
curl -L -o canton-open-source-3.4.11.tar.gz \
  https://github.com/digital-asset/canton/releases/download/v3.4.11/canton-open-source-3.4.11.tar.gz

# Or from the Daml repo (same file, mirrored)
# https://github.com/digital-asset/daml/releases/download/v3.4.11/canton-open-source-3.4.11.tar.gz

# Extract
tar xzf canton-open-source-3.4.11.tar.gz

# Verify
./canton-open-source-3.4.11/bin/canton --help
```

Contents:

```
canton-open-source-3.4.11/
├── bin/canton          # Main launcher script
├── lib/               # JARs
├── config/            # Reference HOCON configs (participant.conf, sequencer.conf, etc.)
├── examples/          # Example topologies
└── scripts/           # Utility scripts
```

> **Note:** `dpm sandbox` runs the IDE Ledger (single-process). It does not support multi-participant topologies. The standalone `bin/canton` binary is required for multi-node setups.

---

### Architecture (Multi-Node Mode)

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Sequencer   │   │   Mediator   │   │  (Canton     │
│  :5001 pub   │   │   :5202 adm  │   │   Console)   │
│  :5002 adm   │   │              │   │              │
│  BFT mode    │   │              │   │              │
└──────┬───────┘   └──────┬───────┘   └──────────────┘
       │                  │
       └────────┬─────────┘
                │ synchronizer "da"
       ┌────────┴────────┐
       │                 │
┌──────┴───────┐  ┌──────┴───────┐
│ Participant1 │  │ Participant2 │
│ gRPC  :5011  │  │ gRPC  :5021  │
│ JSON  :5013  │  │ JSON  :5023  │
│ Admin :5012  │  │ Admin :5022  │
│              │  │              │
│ → Issuer     │  │ → Depositor  │
└──────┬───────┘  └──────┬───────┘
       │                 │
 ┌─────┴──────┐   ┌──────┴─────┐
 │ MPC Node   │   │ TypeScript │
 │ (Rust,     │   │ Tests      │
 │  tonic)    │   │ (vitest)   │
 └────────────┘   └────────────┘
```

Each participant has its own Ledger API endpoints. The MPC node connects to **Participant 1's** gRPC (`:5011`).

---

### Step 1: Create the Topology Config

Create `config/multi-node.conf`:

```hocon
canton {
  sequencers {
    sequencer1 {
      storage.type = memory
      public-api.port = 5001
      admin-api.port = 5002
      sequencer.type = BFT
    }
  }

  mediators {
    mediator1 {
      storage.type = memory
      admin-api.port = 5202
    }
  }

  participants {
    participant1 {
      storage.type = memory
      admin-api.port = 5012
      ledger-api.port = 5011
      http-ledger-api.port = 5013
    }
    participant2 {
      storage.type = memory
      admin-api.port = 5022
      ledger-api.port = 5021
      http-ledger-api.port = 5023
    }
  }
}
```

> **Source:** [Getting Started — Digital Asset docs 3.4](https://docs.digitalasset.com/operate/3.4/tutorials/getting_started.html)

### Step 2: Create the Bootstrap Script

Create `config/bootstrap.canton`:

```scala
// Start all nodes defined in the HOCON config
nodes.local.start()

// Create the synchronizer (consensus domain) connecting sequencer + mediator
bootstrap.synchronizer(
  synchronizerName = "da",
  sequencers = sequencers.all,
  mediators = mediators.all,
  synchronizerOwners = Seq(sequencer1),
  synchronizerThreshold = PositiveInt.one,
  staticSynchronizerParameters = StaticSynchronizerParameters.defaultsWithoutKMS(ProtocolVersion.latest),
)

// Connect both participants to the synchronizer
participant1.synchronizers.connect_local(sequencer1, "da")
participant2.synchronizers.connect_local(sequencer1, "da")

// Wait until participant2 is fully connected
utils.retry_until_true {
  participant2.synchronizers.active("da")
}

// Allocate parties on separate participants
val issuer = participant1.parties.enable("Issuer")
val depositor = participant2.parties.enable("Depositor")

// Upload the DAR to both participants
participants.all.dars.upload(".daml/dist/canton-mpc-poc-0.2.0.dar")

// Print party IDs for use in API calls
println(s"Issuer:  ${issuer.toLf}")
println(s"Depositor: ${depositor.toLf}")
```

> **Source:** [Getting Started — Automation Using Bootstrap Scripts](https://docs.digitalasset.com/operate/3.4/tutorials/getting_started.html)

### Step 3: Build and Start

```bash
# Build the DAR
dpm build

# Start Canton (drops into Canton Console after bootstrap)
./canton-open-source-3.4.11/bin/canton \
  -c config/multi-node.conf \
  --bootstrap config/bootstrap.canton
```

The bootstrap script prints the full party IDs. Save them.

To run as a background daemon instead:

```bash
./canton-open-source-3.4.11/bin/canton daemon \
  -c config/multi-node.conf \
  --bootstrap config/bootstrap.canton
```

### Step 4: Wait for Readiness

```bash
# Participant 1 (Issuer)
curl --retry 10 --retry-delay 2 --retry-connrefused http://localhost:5013/health

# Participant 2 (Depositor)
curl --retry 10 --retry-delay 2 --retry-connrefused http://localhost:5023/health
```

### Step 5: Create Users

Each participant gets its own user, scoped to its hosted party:

```bash
# Issuer user on Participant 1
curl -s -X POST http://localhost:5013/v2/users \
  -H "Content-Type: application/json" \
  -d '{
    "user": {
      "id": "issuer-user",
      "primaryParty": "Issuer::1220...",
      "isDeactivated": false,
      "identityProviderId": ""
    },
    "rights": [
      {"kind": {"CanActAs": {"value": {"party": "Issuer::1220..."}}}},
      {"kind": {"CanReadAs": {"value": {"party": "Issuer::1220..."}}}}
    ]
  }'

# Depositor user on Participant 2
curl -s -X POST http://localhost:5023/v2/users \
  -H "Content-Type: application/json" \
  -d '{
    "user": {
      "id": "depositor-user",
      "primaryParty": "Depositor::1220...",
      "isDeactivated": false,
      "identityProviderId": ""
    },
    "rights": [
      {"kind": {"CanActAs": {"value": {"party": "Depositor::1220..."}}}},
      {"kind": {"CanReadAs": {"value": {"party": "Depositor::1220..."}}}}
    ]
  }'
```

### Step 6: Handle Multi-Controller Choices

In the sandbox, a single user has `actAs` for all parties. In multi-node, parties live on separate participants.

For choices like `RequestDeposit` (controller: issuer + requester), grant cross-participant rights via Canton Console:

```scala
// Grant issuer-user on participant1 the ability to act as Depositor
participant1.ledger_api.users.rights.grant(
  id = "issuer-user",
  actAs = Set(depositor),
  readAs = Set(depositor),
)
```

Then submit from Participant 1 with both parties in `actAs`:

```bash
curl -s -X POST http://localhost:5013/v2/commands/submit-and-wait-for-transaction \
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
              ...
            }
          }
        }
      ],
      "commandId": "deposit-request-001",
      "userId": "issuer-user",
      "actAs": ["Issuer::1220...", "Depositor::1220..."],
      "readAs": ["Issuer::1220...", "Depositor::1220..."]
    }
  }'
```

For single-controller choices (`ClaimDeposit`, `CompleteWithdrawal` — controller: issuer only), no cross-participant grants are needed. The MPC node submits directly to Participant 1.

---

### MPC Node Connection (Multi-Node)

| API | Endpoint | Use |
|-----|----------|-----|
| **gRPC Ledger API (Participant 1)** | `localhost:5011` | MPC node streaming + commands |
| **JSON Ledger API (Participant 1)** | `http://localhost:5013` | REST alternative for Issuer actions |
| **JSON Ledger API (Participant 2)** | `http://localhost:5023` | REST for Depositor-scoped queries |

Update the MPC node config to target port `5011` instead of `6865`.

---

### Canton Console Quick Reference

```scala
// Check all node health
health.status

// List connected synchronizers
participant1.synchronizers.list_connected()

// Upload updated DAR (after dpm build)
participants.all.dars.upload(".daml/dist/canton-mpc-poc-0.2.0.dar")

// Allocate a new party
val newParty = participant1.parties.enable("NewParty")

// Inspect active contracts
participant1.testing.state_inspection.find_contracts("da", _ => true)
```

---

## Phase 2: PostgreSQL Persistence

Replace in-memory storage so data survives restarts.

### Setup PostgreSQL

```bash
# macOS (Homebrew)
brew install postgresql@14
brew services start postgresql@14

# Create databases (one per Canton node)
psql postgres -c "CREATE USER canton_user WITH PASSWORD 'canton-dev-password';"
psql postgres -c "CREATE DATABASE canton_sequencer1 OWNER canton_user;"
psql postgres -c "CREATE DATABASE canton_mediator1 OWNER canton_user;"
psql postgres -c "CREATE DATABASE canton_participant1 OWNER canton_user;"
psql postgres -c "CREATE DATABASE canton_participant2 OWNER canton_user;"
```

### Updated HOCON Config

Create `config/multi-node-postgres.conf`:

```hocon
_shared {
  storage {
    type = postgres
    config {
      dataSourceClass = "org.postgresql.ds.PGSimpleDataSource"
      properties {
        serverName = "localhost"
        serverName = ${?POSTGRES_HOST}
        portNumber = "5432"
        portNumber = ${?POSTGRES_PORT}
        user = "canton_user"
        user = ${?POSTGRES_USER}
        password = "canton-dev-password"
        password = ${?POSTGRES_PASSWORD}
      }
    }
  }
}

canton {
  sequencers {
    sequencer1 {
      storage = ${_shared.storage}
      storage.config.properties.databaseName = "canton_sequencer1"
      public-api.port = 5001
      admin-api.port = 5002
      sequencer.type = BFT
    }
  }

  mediators {
    mediator1 {
      storage = ${_shared.storage}
      storage.config.properties.databaseName = "canton_mediator1"
      admin-api.port = 5202
    }
  }

  participants {
    participant1 {
      storage = ${_shared.storage}
      storage.config.properties.databaseName = "canton_participant1"
      admin-api.port = 5012
      ledger-api.port = 5011
      http-ledger-api.port = 5013
    }
    participant2 {
      storage = ${_shared.storage}
      storage.config.properties.databaseName = "canton_participant2"
      admin-api.port = 5022
      ledger-api.port = 5021
      http-ledger-api.port = 5023
    }
  }
}
```

> **Source:** [Configure Canton with PostgreSQL](https://docs.digitalasset.com/operate/3.4/howtos/configure/storage/postgres.html)

With PostgreSQL:
- Party IDs persist across restarts (no need to re-allocate)
- Contract state survives Canton restarts
- Offset checkpoints are durable

---

## Phase 3: Production Hardening

### JWT Authentication

Production Canton requires JWT tokens on every Ledger API call. The JSON Ledger API docs state JWT is required even in development setups.

#### What changes in the MPC node

```rust
// Before (sandbox): plain gRPC channel
let channel = Channel::from_static("http://localhost:6865").connect().await?;

// After (production): channel with JWT interceptor
let channel = Channel::from_static("https://participant1.example.com:5011")
    .tls_config(tls)?
    .connect()
    .await?;

// Add JWT token to every request via tonic interceptor
let token: MetadataValue<_> = format!("Bearer {}", jwt_token).parse()?;
let client = CommandServiceClient::with_interceptor(channel, move |mut req: Request<()>| {
    req.metadata_mut().insert("authorization", token.clone());
    Ok(req)
});
```

JWT tokens encode the `actAs` and `readAs` parties. The token must grant rights for the parties the MPC node acts as (Issuer).

> **Reference:** [JWT Authentication](https://docs.digitalasset.com/operate/3.4/howtos/secure/apis/jwt.html)

### TLS Configuration

Production Canton requires TLS on gRPC and HTTP connections.

```rust
// tonic TLS setup
use tonic::transport::{Certificate, ClientTlsConfig};

let ca_cert = std::fs::read("certs/ca.pem")?;
let tls = ClientTlsConfig::new()
    .ca_certificate(Certificate::from_pem(ca_cert))
    .domain_name("participant1.example.com");

let channel = Channel::from_static("https://participant1.example.com:5011")
    .tls_config(tls)?
    .connect()
    .await?;
```

For mTLS (mutual TLS), also provide client certificates:

```rust
use tonic::transport::Identity;

let client_cert = std::fs::read("certs/client.pem")?;
let client_key = std::fs::read("certs/client-key.pem")?;

let tls = ClientTlsConfig::new()
    .ca_certificate(Certificate::from_pem(ca_cert))
    .identity(Identity::from_pem(client_cert, client_key))
    .domain_name("participant1.example.com");
```

### Network Resilience

The sandbox never drops connections. Production gRPC streams will break. The MPC node needs:

#### Stream reconnection

```rust
loop {
    match subscribe_to_updates(&channel, offset).await {
        Ok(stream) => {
            offset = process_stream(stream).await?;
        }
        Err(e) => {
            tracing::warn!("Stream disconnected: {e}, reconnecting...");
            tokio::time::sleep(backoff.next()).await;
        }
    }
}
```

#### Idempotent command submission

Use deterministic `commandId` values so retried submissions are deduplicated by Canton:

```rust
// commandId derived from the event being processed — safe to retry
let command_id = format!("claim-deposit-{}", pending_deposit_contract_id);
```

Canton deduplicates commands by `(userId, commandId)` within the deduplication window.

#### Health checking

```rust
// Periodic health check
let response = reqwest::get("http://participant1:5013/health").await?;
if !response.status().is_success() {
    // Trigger reconnection or alert
}
```

### Transaction Visibility

In the sandbox, a single participant sees all events. In production:

- **Participant 1** (hosting Issuer) sees events where Issuer is a stakeholder
- **Participant 2** (hosting Depositor) sees events where Depositor is a stakeholder
- A contract with both Issuer and Depositor as signatories/observers is visible to both

For the MPC node, this means:
- `VaultOrchestrator` (signatory: issuer) — visible on Participant 1
- `PendingDeposit` (signatory: issuer, observer: requester) — visible on Participant 1
- `PendingWithdrawal` (signatory: issuer, observer: requester) — visible on Participant 1
- `Erc20Holding` (signatory: issuer, observer: owner) — visible on Participant 1

Since the MPC node acts as Issuer and all contracts have Issuer as signatory, the MPC node will see all relevant events on Participant 1. No visibility issues for this specific contract design.

### Offset Semantics

Offsets are causal within a single synchronizer but may not be globally ordered across synchronizers. For a single-synchronizer setup (which is the typical case), offsets behave like the sandbox — monotonically increasing.

For crash recovery:
- Persist the last processed offset to durable storage (PostgreSQL, file, etc.)
- On restart, resume from the persisted offset via `StateService::GetActiveContracts` + `UpdateService::GetUpdates`
- Do not assume offset values are comparable across different participant nodes

---

## Production Checklist

### MPC Node Code Changes

| Change | Priority | Sandbox Equivalent |
|--------|----------|-------------------|
| Add JWT token provider (interceptor on gRPC channel) | **Required** | No auth needed |
| Add TLS config (CA cert, optionally client cert for mTLS) | **Required** | Plaintext |
| Configurable participant endpoint (host, port) | **Required** | Hardcoded `localhost:6865` |
| gRPC stream reconnection with exponential backoff | **Required** | Never disconnects |
| Deterministic `commandId` for idempotent retries | **Recommended** | Optional but good practice |
| Health check loop with alerting | **Recommended** | Not needed |
| Configurable timeouts (connection, request, stream idle) | **Recommended** | Defaults work |

### Infrastructure

| Concern | Detail |
|---------|--------|
| **Java 21** | Required for Canton 3.4.x standalone binary |
| **PostgreSQL 14+** | Required for persistent storage |
| **TLS certificates** | CA + server certs for Canton nodes, client certs if mTLS |
| **JWT token issuer** | Canton supports RS256, ES256 — configure via Canton's auth config |
| **Monitoring** | Canton exposes Prometheus metrics on admin API ports |
| **Resource requirements** | 6 GB RAM minimum for Canton, 4+ CPU cores, 4 GB JVM heap |

---

## Development Workflow (Multi-Node)

```
1. Edit Daml contracts    →  daml/*.daml
2. Build                  →  dpm build
3. Test (offline)         →  dpm test
4. Start Canton           →  ./canton-open-source-3.4.11/bin/canton -c config/multi-node.conf --bootstrap config/bootstrap.canton
5. Wait for health        →  curl --retry 10 ... http://localhost:5013/health && curl ... http://localhost:5023/health
6. Setup users            →  POST /v2/users to each participant
7. Create contracts       →  POST to participant1 :5013
8. Run MPC node           →  cargo run  (connects to gRPC :5011)
9. Iterate                →  Ctrl+C Canton → dpm build → restart Canton
```

---

## Troubleshooting

### Canton Binary Not Found

```bash
ls -la ./canton-open-source-3.4.11/bin/canton
chmod +x ./canton-open-source-3.4.11/bin/canton
```

### Bootstrap Script Fails

- Ensure the DAR path in the bootstrap script matches your build output
- Check that no other process is using ports 5001, 5002, 5011-5013, 5021-5023, 5202
- Verify Java 21 is active: `java -version`

### Participant Fails to Connect to Synchronizer

```scala
// In Canton Console
sequencer1.health.status
mediator1.health.status
participant1.synchronizers.list_connected()
participant2.synchronizers.list_connected()
```

### Port Conflicts with Sandbox

Sandbox uses ports 6865 and 7575. Multi-node uses the 5xxx range. They don't conflict — you can run both simultaneously.

### PostgreSQL Connection Refused

```bash
# Check PostgreSQL is running
brew services list | grep postgresql
pg_isready -h localhost -p 5432

# Check databases exist
psql postgres -c "\l" | grep canton
```

---

## Reference

- [Getting Started (multi-node)](https://docs.digitalasset.com/operate/3.4/tutorials/getting_started.html)
- [Install Canton](https://docs.digitalasset.com/operate/3.4/tutorials/install.html)
- [Canton Console Reference](https://docs.digitalasset.com/operate/3.4/reference/console.html)
- [Configure PostgreSQL Storage](https://docs.digitalasset.com/operate/3.4/howtos/configure/storage/postgres.html)
- [gRPC Ledger API Services](https://docs.digitalasset.com/build/3.5/explanations/ledger-api-services.html)
- [JWT Authentication](https://docs.digitalasset.com/operate/3.4/howtos/secure/apis/jwt.html)
- [Best Practices for Canton Network Apps](https://docs.digitalasset.com/build/3.5/sdlc-howtos/sdlc-best-practices.html)
- [Canton Open Source Releases](https://github.com/digital-asset/canton/releases)
- [Canton Developer Survey 2026](https://discuss.daml.com/t/canton-network-developer-experience-and-tooling-survey-analysis-2026/8412)
- [Community Docker Compose for Canton 3.x](https://discuss.daml.com/t/minimal-docker-compose-canton-config-and-canton-bootstrap-for-3-x/7929)
- [CN-Quickstart (full Docker stack)](https://github.com/digital-asset/cn-quickstart)
- [Local Setup Guide (Sandbox)](./LOCAL_SETUP.md)
