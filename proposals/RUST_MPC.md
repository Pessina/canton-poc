# Rust MPC Node -- Design Document

## 1. Overview

The Rust MPC node is an off-chain service that bridges the Canton ledger with EVM-compatible blockchains. It watches for `PendingDeposit` and `PendingWithdrawal` contract events on a Canton participant via the gRPC Ledger API, then performs MPC signing operations and EVM interactions to complete the deposit/withdrawal lifecycle.

The node does not participate in Canton consensus. It connects exclusively to the Participant's Ledger API -- never to the sequencer or mediator. From Canton's perspective it is an automation bot that reads events and submits commands as the `operator` party.

**Responsibilities:**

- Stream `CreatedEvent` notifications for `PendingDeposit` and `PendingWithdrawal` templates
- For deposits: verify on-chain ERC-20 state, MPC-sign a response hash, exercise `ClaimDeposit`
- For withdrawals: build and MPC-sign a raw EVM transaction, broadcast it, exercise `CompleteWithdrawal`
- Maintain a persisted offset checkpoint for crash recovery

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────┐
│              Canton Participant Node                  │
│                                                      │
│   ┌──────────────────────────────────────────────┐   │
│   │           Ledger API (gRPC :6865)            │   │
│   │                                              │   │
│   │  StateService     - GetActiveContracts       │   │
│   │  UpdateService    - GetUpdates (streaming)   │   │
│   │  CommandService   - SubmitAndWait            │   │
│   └──────────────┬───────────────────────────────┘   │
└──────────────────┼───────────────────────────────────┘
                   │ gRPC (HTTP/2, plaintext in sandbox)
                   │
          ┌────────┴────────┐
          │  Rust MPC Node  │
          │                 │
          │  ┌───────────┐  │
          │  │ Canton    │  │  StateService::GetActiveContracts
          │  │ Client    │──│─ UpdateService::GetUpdates
          │  │ (tonic)   │  │  CommandService::SubmitAndWait
          │  └───────────┘  │
          │                 │
          │  ┌───────────┐  │
          │  │ MPC       │  │  secp256k1 threshold signing
          │  │ Signer    │  │  (protocol TBD: FROST, GG20, etc.)
          │  └───────────┘  │
          │                 │
          │  ┌───────────┐  │
          │  │ EVM       │──│─ eth_call, eth_sendRawTransaction
          │  │ Client    │  │  (JSON-RPC over HTTP)
          │  └───────────┘  │
          │                 │
          │  ┌───────────┐  │
          │  │ Offset    │  │  file or embedded DB (sled, redb)
          │  │ Store     │  │
          │  └───────────┘  │
          └─────────────────┘
                   │
                   │ JSON-RPC (HTTP)
                   │
          ┌────────┴────────┐
          │   EVM Node      │
          │  (e.g. Hardhat, │
          │   Geth, Anvil)  │
          └─────────────────┘
```

### Data flow summary

| Direction | Protocol | What |
|-----------|----------|------|
| Canton --> MPC Node | gRPC streaming | `CreatedEvent` for `PendingDeposit`, `PendingWithdrawal` |
| MPC Node --> Canton | gRPC unary | `SubmitAndWait` exercising `ClaimDeposit` or `CompleteWithdrawal` |
| MPC Node --> EVM | JSON-RPC | `eth_call` (verify deposit), `eth_sendRawTransaction` (broadcast withdrawal) |
| EVM --> MPC Node | JSON-RPC | Transaction receipts, ERC-20 balance reads |

---

## 3. gRPC Connection Setup

Canton exposes Ledger API v2 via gRPC. As of SDK 3.4.x, no published Rust crate wraps these protos -- you must generate stubs from the proto source using `tonic-build`.

### 3.1 Vendoring proto files

The proto definitions live in the `digital-asset/canton` repository. Pin to the `3.4.x` tag matching your SDK version.

| Proto set | Path in `digital-asset/canton` repo |
|-----------|-------------------------------------|
| Service definitions | `community/ledger-api-proto/src/main/protobuf/com/daml/ledger/api/v2/` |
| Value types (`Value`, `Record`, `Variant`, etc.) | `community/daml-lf/ledger-api-value/src/main/protobuf/com/daml/ledger/api/v2/value.proto` |

Recommended project layout:

```
mpc-node/
├── proto/
│   └── com/
│       └── daml/
│           └── ledger/
│               └── api/
│                   └── v2/
│                       ├── command_service.proto
│                       ├── commands.proto
│                       ├── state_service.proto
│                       ├── update_service.proto
│                       ├── event.proto
│                       ├── transaction.proto
│                       ├── transaction_filter.proto
│                       ├── value.proto
│                       └── ...
├── build.rs
├── Cargo.toml
└── src/
    └── main.rs
```

To vendor the files:

```bash
CANTON_TAG="v3.4.11"
CANTON_REPO="https://github.com/digital-asset/canton"

# Clone sparse checkout (protos only)
git clone --depth 1 --branch "$CANTON_TAG" --filter=blob:none --sparse "$CANTON_REPO" canton-src
cd canton-src
git sparse-checkout set \
  community/ledger-api-proto/src/main/protobuf \
  community/daml-lf/ledger-api-value/src/main/protobuf

# Copy into your project
cp -r community/ledger-api-proto/src/main/protobuf/com ../mpc-node/proto/com
cp community/daml-lf/ledger-api-value/src/main/protobuf/com/daml/ledger/api/v2/value.proto \
   ../mpc-node/proto/com/daml/ledger/api/v2/value.proto
```

### 3.2 build.rs

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(false)  // client only
        .compile_protos(
            &[
                "proto/com/daml/ledger/api/v2/command_service.proto",
                "proto/com/daml/ledger/api/v2/state_service.proto",
                "proto/com/daml/ledger/api/v2/update_service.proto",
            ],
            &["proto/"],  // include root for imports
        )?;
    Ok(())
}
```

### 3.3 Connecting a channel

```rust
use tonic::transport::Channel;

async fn connect_ledger(endpoint: &str) -> Result<Channel, tonic::transport::Error> {
    // Sandbox: plaintext. Production: add TLS with .tls_config(...)
    Channel::from_shared(endpoint.to_string())?
        .connect()
        .await
}

// Usage
let channel = connect_ledger("http://localhost:6865").await?;
```

In production, TLS is required. Add a `tonic::transport::ClientTlsConfig`:

```rust
use tonic::transport::ClientTlsConfig;

let tls = ClientTlsConfig::new()
    .ca_certificate(tonic::transport::Certificate::from_pem(ca_pem));

let channel = Channel::from_shared("https://participant.example.com:6865")?
    .tls_config(tls)?
    .connect()
    .await?;
```

---

## 4. Startup Flow

On startup the MPC node must load all existing pending contracts so it does not miss events that were created before the node came online (or while it was down).

```rust
use ledger_api::state_service_client::StateServiceClient;
use ledger_api::GetActiveContractsRequest;

async fn load_active_contracts(
    channel: Channel,
    party: &str,
) -> Result<(Vec<CreatedEvent>, String), Box<dyn std::error::Error>> {
    let mut client = StateServiceClient::new(channel);

    let request = GetActiveContractsRequest {
        filter: Some(TransactionFilter {
            filters_by_party: [(
                party.to_string(),
                Filters {
                    cumulative: Some(CumulativeFilter {
                        template_filters: vec![
                            TemplateFilter {
                                template_id: Some(template_id(
                                    "canton-mpc-poc", "Erc20Vault", "PendingDeposit"
                                )),
                                include_created_event_blob: false,
                            },
                            TemplateFilter {
                                template_id: Some(template_id(
                                    "canton-mpc-poc", "Erc20Vault", "PendingWithdrawal"
                                )),
                                include_created_event_blob: false,
                            },
                        ],
                        ..Default::default()
                    }),
                },
            )].into_iter().collect(),
        }),
        ..Default::default()
    };

    let mut stream = client.get_active_contracts(request).await?.into_inner();

    let mut events = Vec::new();
    let mut offset = String::new();

    while let Some(response) = stream.message().await? {
        // Collect CreatedEvents from the active contract set
        if let Some(contract_entry) = response.contract_entry {
            match contract_entry {
                ContractEntry::ActiveContract(active) => {
                    if let Some(created) = active.created_event {
                        events.push(created);
                    }
                }
                _ => {}
            }
        }
        // The last message carries the offset
        offset = response.offset;
    }

    Ok((events, offset))
}
```

**Startup sequence:**

1. Connect gRPC channel to `localhost:6865`
2. Call `StateService::GetActiveContracts` with a filter for `PendingDeposit` and `PendingWithdrawal`
3. Collect all returned `CreatedEvent` entries
4. Record the offset from the final response message
5. Process any already-active pending contracts (see sections 6 and 7)
6. Begin streaming from the recorded offset (section 5)

---

## 5. Event Subscription

After loading the active contract snapshot, subscribe to new events from the recorded offset using `UpdateService::GetUpdates`.

```rust
use ledger_api::update_service_client::UpdateServiceClient;
use ledger_api::GetUpdatesRequest;

async fn subscribe_events(
    channel: Channel,
    party: &str,
    begin_offset: String,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut client = UpdateServiceClient::new(channel);

    let request = GetUpdatesRequest {
        begin_exclusive: begin_offset,
        // Empty string means "stream indefinitely"
        end_inclusive: String::new(),
        filter: Some(TransactionFilter {
            filters_by_party: [(
                party.to_string(),
                Filters {
                    cumulative: Some(CumulativeFilter {
                        template_filters: vec![
                            TemplateFilter {
                                template_id: Some(template_id(
                                    "canton-mpc-poc", "Erc20Vault", "PendingDeposit"
                                )),
                                include_created_event_blob: false,
                            },
                            TemplateFilter {
                                template_id: Some(template_id(
                                    "canton-mpc-poc", "Erc20Vault", "PendingWithdrawal"
                                )),
                                include_created_event_blob: false,
                            },
                        ],
                        ..Default::default()
                    }),
                },
            )].into_iter().collect(),
        }),
        verbose: false,
    };

    let mut stream = client.get_updates(request).await?.into_inner();

    while let Some(update) = stream.message().await? {
        let offset = update.offset.clone();

        match update.update {
            Some(Update::Transaction(tx)) => {
                for event in tx.events {
                    match event.event {
                        Some(Event::Created(created)) => {
                            handle_created_event(&created).await?;
                        }
                        Some(Event::Archived(_)) => {
                            // PendingDeposit/PendingWithdrawal archived --
                            // this happens as a result of our own exercises.
                            // No action needed.
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }

        // Persist offset after processing all events in the transaction
        persist_offset(&offset).await?;
    }

    Ok(())
}
```

### Template matching

Route `CreatedEvent` entries based on `template_id`:

```rust
async fn handle_created_event(
    event: &CreatedEvent,
) -> Result<(), Box<dyn std::error::Error>> {
    let template_id = event.template_id.as_ref()
        .ok_or("missing template_id")?;

    match template_id.entity_name.as_str() {
        "PendingDeposit" => handle_pending_deposit(event).await,
        "PendingWithdrawal" => handle_pending_withdrawal(event).await,
        other => {
            tracing::warn!(template = other, "unexpected template, skipping");
            Ok(())
        }
    }
}
```

---

## 6. Event Handling: PendingDeposit

When a `PendingDeposit` contract is created on the ledger, the MPC node must verify the corresponding ERC-20 deposit on-chain and then exercise `ClaimDeposit` to mint the user's Canton-side balance.

### 6.1 Daml contract reference

```haskell
template PendingDeposit
  with
    operator     : Party
    requester    : Party
    erc20Address : BytesHex      -- ERC-20 token contract address
    amount       : Decimal        -- expected deposit amount
    requestId    : BytesHex      -- keccak256(packed evmParams)
    evmParams    : EvmTransactionParams
```

### 6.2 Processing steps

```
PendingDeposit CREATED
  │
  ├─ 1. Extract fields from CreatedEvent
  │     requestId, evmParams, erc20Address, amount
  │
  ├─ 2. Verify ERC-20 deposit on-chain
  │     eth_call → balanceOf / Transfer event log
  │     Confirm token, amount, and recipient match
  │
  ├─ 3. MPC sign
  │     txHash = <EVM transaction hash of the verified deposit>
  │     responseHash = keccak256(requestId || txHash)
  │     signature = mpc_sign(responseHash)
  │
  └─ 4. Submit ClaimDeposit to Canton
        CommandService::SubmitAndWait
```

### 6.3 Field extraction

`CreatedEvent.create_arguments` is a `Record` with labeled fields. Extract values by field name:

```rust
fn extract_field<'a>(record: &'a Record, name: &str) -> Option<&'a Value> {
    record.fields.iter()
        .find(|f| f.label == name)
        .and_then(|f| f.value.as_ref())
}

fn extract_text_field(record: &Record, name: &str) -> Result<String, Error> {
    match extract_field(record, name) {
        Some(Value { sum: Some(value::Sum::Text(t)) }) => Ok(t.clone()),
        _ => Err(anyhow!("missing or non-text field: {}", name)),
    }
}

// Usage for PendingDeposit
let args = event.create_arguments.as_ref().ok_or("no create_arguments")?;
let request_id = extract_text_field(args, "requestId")?;
let erc20_address = extract_text_field(args, "erc20Address")?;
```

For nested records like `evmParams`:

```rust
fn extract_record_field<'a>(record: &'a Record, name: &str) -> Option<&'a Record> {
    match extract_field(record, name) {
        Some(Value { sum: Some(value::Sum::Record(r)) }) => Some(r),
        _ => None,
    }
}

let evm_params = extract_record_field(args, "evmParams")
    .ok_or("missing evmParams")?;
let nonce = extract_text_field(evm_params, "nonce")?;
let chain_id = extract_text_field(evm_params, "chainId")?;
```

### 6.4 On-chain verification (EVM RPC)

Before signing, verify that the ERC-20 transfer actually occurred:

```rust
// Pseudocode -- use ethers-rs or alloy for actual implementation
async fn verify_erc20_deposit(
    evm_client: &EvmClient,
    erc20_address: &str,
    recipient: &str,
    expected_amount: U256,
) -> Result<H256, Error> {
    // Option A: query Transfer event logs
    let logs = evm_client.get_logs(Filter {
        address: Some(erc20_address.parse()?),
        topics: vec![
            keccak256("Transfer(address,address,uint256)").into(),
            None,                              // from: any
            Some(pad_address(recipient)),       // to: vault address
        ],
        ..Default::default()
    }).await?;

    // Find the log matching the expected amount
    let matching_log = logs.iter()
        .find(|log| decode_uint256(&log.data) == expected_amount)
        .ok_or("no matching Transfer event")?;

    Ok(matching_log.transaction_hash)
}
```

### 6.5 MPC signing

The response hash binds the `requestId` (deterministic from `evmParams`) to the EVM transaction hash:

```rust
fn compute_response_hash(request_id: &[u8], tx_hash: &[u8]) -> [u8; 32] {
    // responseHash = keccak256(requestId || txHash)
    // This matches Daml's computeResponseHash in Crypto.daml
    let mut preimage = Vec::with_capacity(request_id.len() + tx_hash.len());
    preimage.extend_from_slice(request_id);
    preimage.extend_from_slice(tx_hash);
    keccak256(&preimage)
}

// MPC signing (protocol-specific -- FROST, GG20, etc.)
let response_hash = compute_response_hash(&request_id_bytes, &tx_hash_bytes);
let mpc_signature = mpc_signer.sign(&response_hash).await?;
```

### 6.6 Command submission: ClaimDeposit

```rust
use ledger_api::command_service_client::CommandServiceClient;
use ledger_api::{SubmitAndWaitRequest, Command, ExerciseCommand};

async fn exercise_claim_deposit(
    channel: Channel,
    orchestrator_contract_id: &str,
    pending_contract_id: &str,
    mpc_signature: &MpcSignatureBytes,
    mpc_output: &str,    // hex-encoded tx hash
    user_id: &str,
    operator_party: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut client = CommandServiceClient::new(channel);

    let choice_argument = Record {
        fields: vec![
            RecordField {
                label: "pendingCid".into(),
                value: Some(Value {
                    sum: Some(value::Sum::ContractId(pending_contract_id.to_string())),
                }),
            },
            RecordField {
                label: "mpcSignature".into(),
                value: Some(Value {
                    sum: Some(value::Sum::Record(Record {
                        fields: vec![
                            RecordField {
                                label: "signature".into(),
                                value: Some(Value {
                                    sum: Some(value::Sum::Text(
                                        hex::encode(&mpc_signature.der_signature)
                                    )),
                                }),
                            },
                            RecordField {
                                label: "publicKey".into(),
                                value: Some(Value {
                                    sum: Some(value::Sum::Text(
                                        hex::encode(&mpc_signature.public_key)
                                    )),
                                }),
                            },
                        ],
                        ..Default::default()
                    })),
                }),
            },
            RecordField {
                label: "mpcOutput".into(),
                value: Some(Value {
                    sum: Some(value::Sum::Text(mpc_output.to_string())),
                }),
            },
        ],
        ..Default::default()
    };

    let command = Command {
        command: Some(command::Command::ExerciseCommand(ExerciseCommand {
            template_id: Some(template_id(
                "canton-mpc-poc", "Erc20Vault", "VaultOrchestrator"
            )),
            contract_id: orchestrator_contract_id.to_string(),
            choice: "ClaimDeposit".to_string(),
            choice_argument: Some(Value {
                sum: Some(value::Sum::Record(choice_argument)),
            }),
        })),
    };

    let request = SubmitAndWaitRequest {
        commands: Some(Commands {
            commands: vec![command],
            command_id: format!("claim-deposit-{}", uuid::Uuid::new_v4()),
            user_id: user_id.to_string(),
            act_as: vec![operator_party.to_string()],
            read_as: vec![operator_party.to_string()],
            ..Default::default()
        }),
    };

    client.submit_and_wait_for_transaction(request).await?;

    Ok(())
}
```

---

## 7. Event Handling: PendingWithdrawal

When a `PendingWithdrawal` contract is created, the MPC node must build an EVM transaction, MPC-sign it, broadcast it, and report the result back to Canton.

### 7.1 Daml contract reference

```haskell
template PendingWithdrawal
  with
    operator         : Party
    requester        : Party
    erc20Address     : BytesHex
    amount           : Decimal
    recipientAddress : BytesHex    -- EVM address to send tokens to
    requestId        : BytesHex
    evmParams        : EvmTransactionParams
```

### 7.2 Processing steps

```
PendingWithdrawal CREATED
  │
  ├─ 1. Extract fields from CreatedEvent
  │     evmParams, recipientAddress, amount, erc20Address
  │
  ├─ 2. Build raw EVM transaction
  │     ERC-20 transfer(recipientAddress, amount)
  │     Use nonce, gasLimit, maxFeePerGas, maxPriorityFee, chainId from evmParams
  │
  ├─ 3. MPC sign the EVM transaction
  │     signingHash = keccak256(RLP-encoded unsigned tx)
  │     signature = mpc_sign(signingHash)
  │     Produce signed raw transaction bytes
  │
  ├─ 4. Broadcast to Ethereum
  │     eth_sendRawTransaction(signedTx)
  │     Wait for receipt (or timeout)
  │
  └─ 5. Submit CompleteWithdrawal to Canton
        txHash on success, or failure indicator
        CommandService::SubmitAndWait
```

### 7.3 Building the EVM transaction

The `EvmTransactionParams` record carries all fields needed to deterministically reconstruct the unsigned transaction:

| Field | Bytes | EVM type | Purpose |
|-------|-------|----------|---------|
| `erc20Address` | 20 | `address` | Target ERC-20 contract |
| `recipient` | 20 | `address` | Token transfer destination |
| `amount` | 32 | `uint256` | Token amount (raw units) |
| `nonce` | 32 | `uint256` | Sender nonce |
| `gasLimit` | 32 | `uint256` | Gas limit |
| `maxFeePerGas` | 32 | `uint256` | EIP-1559 max fee |
| `maxPriorityFee` | 32 | `uint256` | EIP-1559 priority fee |
| `chainId` | 32 | `uint256` | EIP-155 chain ID |
| `value` | 32 | `uint256` | ETH value (usually 0 for ERC-20) |

```rust
// Pseudocode -- use alloy or ethers-rs for actual transaction building
fn build_erc20_transfer_tx(params: &EvmTransactionParams) -> UnsignedTransaction {
    // ERC-20 transfer(address,uint256) calldata
    let selector = &keccak256(b"transfer(address,uint256)")[..4]; // 0xa9059cbb
    let calldata = [
        selector,
        &left_pad(&params.recipient, 32),
        &params.amount,
    ].concat();

    UnsignedTransaction {
        chain_id: parse_u256(&params.chain_id),
        nonce: parse_u256(&params.nonce),
        to: Some(parse_address(&params.erc20_address)),
        value: parse_u256(&params.value),
        gas_limit: parse_u256(&params.gas_limit),
        max_fee_per_gas: parse_u256(&params.max_fee_per_gas),
        max_priority_fee_per_gas: parse_u256(&params.max_priority_fee),
        data: calldata,
    }
}
```

### 7.4 MPC signing and broadcast

```rust
async fn process_withdrawal(
    evm_client: &EvmClient,
    mpc_signer: &MpcSigner,
    params: &EvmTransactionParams,
) -> Result<WithdrawalResult, Error> {
    // 1. Build unsigned transaction
    let unsigned_tx = build_erc20_transfer_tx(params);

    // 2. Compute EIP-1559 signing hash
    let signing_hash = unsigned_tx.signing_hash(); // keccak256(0x02 || RLP(...))

    // 3. MPC sign
    let signature = mpc_signer.sign(&signing_hash).await?;

    // 4. Encode signed transaction
    let signed_tx = unsigned_tx.with_signature(signature);
    let raw_tx = signed_tx.rlp_encode();

    // 5. Broadcast
    let tx_hash = evm_client.send_raw_transaction(&raw_tx).await?;

    // 6. Wait for receipt (with timeout)
    let receipt = evm_client
        .wait_for_receipt(tx_hash, Duration::from_secs(120))
        .await?;

    match receipt.status {
        1 => Ok(WithdrawalResult::Success { tx_hash }),
        _ => Ok(WithdrawalResult::Failure {
            tx_hash,
            reason: "transaction reverted".into(),
        }),
    }
}
```

### 7.5 Command submission: CompleteWithdrawal

```rust
async fn exercise_complete_withdrawal(
    channel: Channel,
    orchestrator_contract_id: &str,
    pending_contract_id: &str,
    balance_contract_id: &str,
    mpc_signature: &MpcSignatureBytes,
    mpc_output: &str,    // hex-encoded tx hash (success) or empty (failure)
    user_id: &str,
    operator_party: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut client = CommandServiceClient::new(channel);

    let choice_argument = Record {
        fields: vec![
            RecordField {
                label: "pendingCid".into(),
                value: Some(Value {
                    sum: Some(value::Sum::ContractId(pending_contract_id.to_string())),
                }),
            },
            RecordField {
                label: "balanceCid".into(),
                value: Some(Value {
                    sum: Some(value::Sum::ContractId(balance_contract_id.to_string())),
                }),
            },
            RecordField {
                label: "mpcSignature".into(),
                value: Some(Value {
                    sum: Some(value::Sum::Record(Record {
                        fields: vec![
                            RecordField {
                                label: "signature".into(),
                                value: Some(Value {
                                    sum: Some(value::Sum::Text(
                                        hex::encode(&mpc_signature.der_signature)
                                    )),
                                }),
                            },
                            RecordField {
                                label: "publicKey".into(),
                                value: Some(Value {
                                    sum: Some(value::Sum::Text(
                                        hex::encode(&mpc_signature.public_key)
                                    )),
                                }),
                            },
                        ],
                        ..Default::default()
                    })),
                }),
            },
            RecordField {
                label: "mpcOutput".into(),
                value: Some(Value {
                    sum: Some(value::Sum::Text(mpc_output.to_string())),
                }),
            },
        ],
        ..Default::default()
    };

    let command = Command {
        command: Some(command::Command::ExerciseCommand(ExerciseCommand {
            template_id: Some(template_id(
                "canton-mpc-poc", "Erc20Vault", "VaultOrchestrator"
            )),
            contract_id: orchestrator_contract_id.to_string(),
            choice: "CompleteWithdrawal".to_string(),
            choice_argument: Some(Value {
                sum: Some(value::Sum::Record(choice_argument)),
            }),
        })),
    };

    let request = SubmitAndWaitRequest {
        commands: Some(Commands {
            commands: vec![command],
            command_id: format!("complete-withdrawal-{}", uuid::Uuid::new_v4()),
            user_id: user_id.to_string(),
            act_as: vec![operator_party.to_string()],
            read_as: vec![operator_party.to_string()],
            ..Default::default()
        }),
    };

    client.submit_and_wait_for_transaction(request).await?;

    Ok(())
}
```

### 7.6 CompleteWithdrawal contract behavior

The Daml `CompleteWithdrawal` choice has a built-in refund mechanism:

- If `verifyMpcSignature` succeeds: the withdrawal is finalized, returns `None`
- If `verifyMpcSignature` fails: the pending amount is refunded to the user's `UserErc20Balance`, returns `Some refundCid`

This means if the MPC node submits an invalid signature (e.g., due to a broadcast failure where the node signs over an error output), the user's balance is automatically restored on-ledger.

---

## 8. Crash Recovery

The MPC node must survive restarts without losing or duplicating events.

### 8.1 Offset persistence

Every Canton event carries an opaque offset string. After successfully processing a transaction's events, persist the offset before acknowledging:

```rust
use std::path::Path;
use tokio::fs;

const OFFSET_FILE: &str = "data/offset.checkpoint";

async fn persist_offset(offset: &str) -> Result<(), std::io::Error> {
    // Atomic write: write to temp file, then rename
    let tmp = format!("{}.tmp", OFFSET_FILE);
    fs::write(&tmp, offset.as_bytes()).await?;
    fs::rename(&tmp, OFFSET_FILE).await?;
    Ok(())
}

async fn load_offset() -> Option<String> {
    fs::read_to_string(OFFSET_FILE).await.ok()
}
```

For a more robust solution, use an embedded database like `redb` or `sled` that provides atomic writes.

### 8.2 Startup with recovery

```rust
async fn run(config: &Config) -> Result<(), Box<dyn std::error::Error>> {
    let channel = connect_ledger(&config.ledger_endpoint).await?;

    let begin_offset = match load_offset().await {
        Some(offset) => {
            tracing::info!(offset = %offset, "resuming from persisted offset");
            offset
        }
        None => {
            tracing::info!("no persisted offset, loading full active contract set");
            let (active_events, offset) = load_active_contracts(
                channel.clone(), &config.operator_party
            ).await?;

            // Process any existing pending contracts
            for event in &active_events {
                handle_created_event(event).await?;
            }

            persist_offset(&offset).await?;
            offset
        }
    };

    // Subscribe from the resolved offset
    subscribe_events(channel, &config.operator_party, begin_offset).await
}
```

### 8.3 Idempotency

Events may be replayed after a crash (e.g., if the node crashes after processing an event but before persisting the offset). Each handler must be idempotent:

| Event | Idempotency check |
|-------|-------------------|
| `PendingDeposit` | Before exercising `ClaimDeposit`, query active contracts to verify the `PendingDeposit` contract still exists (has not already been archived by a previous `ClaimDeposit`). |
| `PendingWithdrawal` | Before broadcasting the EVM transaction, check if a transaction with the same nonce has already been mined. Before exercising `CompleteWithdrawal`, verify the `PendingWithdrawal` contract still exists. |

```rust
async fn is_contract_active(
    channel: Channel,
    contract_id: &str,
    party: &str,
) -> Result<bool, Error> {
    // Query active contracts filtered to this specific contract ID.
    // If the contract has been archived, it won't appear in the result.
    let (events, _) = load_active_contracts(channel, party).await?;
    Ok(events.iter().any(|e| e.contract_id == contract_id))
}
```

A more efficient approach is to maintain an in-memory set of processed contract IDs, persisted alongside the offset.

---

## 9. Dependencies (Cargo.toml)

```toml
[package]
name = "mpc-node"
version = "0.1.0"
edition = "2021"

[dependencies]
# gRPC client
tonic = { version = "0.12", features = ["tls"] }
prost = "0.13"
prost-types = "0.13"

# Async runtime
tokio = { version = "1", features = ["full"] }

# EVM interaction (pick one)
# alloy = { version = "0.9", features = ["full"] }
# ethers = { version = "2", features = ["ws", "rustls"] }

# Crypto
sha3 = "0.10"           # keccak256
# k256 = "0.13"         # secp256k1 (if not using alloy/ethers)

# Serialization
hex = "0.4"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Utilities
uuid = { version = "1", features = ["v4"] }
anyhow = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

[build-dependencies]
tonic-build = "0.12"
```

### Crate selection notes

| Purpose | Recommended crate | Notes |
|---------|-------------------|-------|
| gRPC client | `tonic` + `prost` | Only option -- no Canton-specific Rust crate exists for 3.x |
| EVM transactions | `alloy` | Newer, actively developed successor to `ethers-rs` |
| EVM transactions (alt) | `ethers` | Mature, in maintenance mode |
| keccak256 | `sha3` or `alloy-primitives` | Use the same implementation as EVM crate to avoid mismatches |
| secp256k1 | `k256` or via `alloy` | Only needed if MPC library does not provide signing directly |
| Embedded DB | `redb` or `sled` | For offset + processed contract ID persistence |

---

## 10. Proto File Locations

### Source repository

All proto definitions are in [`digital-asset/canton`](https://github.com/digital-asset/canton) on GitHub.

Pin to a release tag matching your SDK version (e.g., `v3.4.11` for SDK 3.4.11).

### Directory map

| What | Path in the canton repository |
|------|-------------------------------|
| Ledger API v2 services | `community/ledger-api-proto/src/main/protobuf/com/daml/ledger/api/v2/` |
| Value types | `community/daml-lf/ledger-api-value/src/main/protobuf/com/daml/ledger/api/v2/value.proto` |
| Google protobuf imports | Bundled with `prost-types` -- do not vendor separately |

### Key proto files

| Proto file | Services / Messages |
|------------|---------------------|
| `command_service.proto` | `CommandService` -- `SubmitAndWait`, `SubmitAndWaitForTransaction` |
| `state_service.proto` | `StateService` -- `GetActiveContracts`, `GetConnectedDomains` |
| `update_service.proto` | `UpdateService` -- `GetUpdates`, `GetUpdateTrees` |
| `commands.proto` | `Commands`, `Command`, `CreateCommand`, `ExerciseCommand` |
| `event.proto` | `CreatedEvent`, `ArchivedEvent`, `ExercisedEvent` |
| `transaction.proto` | `Transaction`, `TransactionTree` |
| `transaction_filter.proto` | `TransactionFilter`, `Filters`, `CumulativeFilter`, `TemplateFilter` |
| `value.proto` | `Value`, `Record`, `RecordField`, `Variant`, `List`, `Optional` |

### Vendoring procedure

```bash
# 1. Clone with sparse checkout (protos only, ~2 MB)
git clone --depth 1 --branch v3.4.11 \
  --filter=blob:none --sparse \
  https://github.com/digital-asset/canton.git canton-protos

cd canton-protos
git sparse-checkout set \
  community/ledger-api-proto/src/main/protobuf/com/daml/ledger/api/v2 \
  community/daml-lf/ledger-api-value/src/main/protobuf/com/daml/ledger/api/v2

# 2. Copy to your project
mkdir -p ../mpc-node/proto/com/daml/ledger/api/v2

cp community/ledger-api-proto/src/main/protobuf/com/daml/ledger/api/v2/*.proto \
   ../mpc-node/proto/com/daml/ledger/api/v2/

# Overwrite value.proto with the one from daml-lf (more complete)
cp community/daml-lf/ledger-api-value/src/main/protobuf/com/daml/ledger/api/v2/value.proto \
   ../mpc-node/proto/com/daml/ledger/api/v2/value.proto

# 3. Clean up
cd .. && rm -rf canton-protos

# 4. Verify build
cd mpc-node && cargo build
```

### Proto import resolution

The proto files use imports like `com/daml/ledger/api/v2/value.proto`. The `tonic-build` `compile_protos` call needs an include path that resolves these:

```rust
// build.rs
tonic_build::configure()
    .compile_protos(
        &["proto/com/daml/ledger/api/v2/command_service.proto", /* ... */],
        &["proto/"],  // <-- this is the include root
    )?;
```

Some proto files import `google/protobuf/timestamp.proto`, `google/protobuf/any.proto`, etc. These are provided automatically by `prost-types` and do not need to be vendored.

### Updating protos

When upgrading the Canton SDK version:

1. Update the tag in the vendor script (`v3.4.11` --> `v3.5.0`, etc.)
2. Re-run the vendor script
3. Run `cargo build` -- `tonic-build` will regenerate the Rust stubs
4. Fix any compilation errors from proto schema changes
