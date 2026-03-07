# E2E Deposit Test Plan: Solana → Canton Port

Port the ERC20 deposit E2E test from the Solana contract examples into Canton,
preserving the same actor separation: test creates the request, MPC signs
autonomously, user submits to Ethereum and triggers claim.

Mirrors the familiar CEX deposit experience: the user sends tokens to a
personal **deposit address**, and the system automatically sweeps them into a
centralized vault — except here the "CEX backend" is a Canton ledger + MPC
signing service, giving cryptographic proof of every step.

## What the Demo Does

1. User sends ERC20 tokens to a **deposit address** on Sepolia
   (derived from the MPC root public key + vault derivation path + user-specific derivation path)
2. User exercises `RequestEvmDeposit` on Canton to request a **sweep from the
   deposit address to the vault address**
   (derived from the MPC root public key + vault derivation path)
   via an ERC20 `transfer` call
3. Canton creates a `PendingEvmDeposit`; the MPC Service observes it
4. MPC Service builds, serializes, and signs the EVM sweep transaction
5. MPC Service exercises `SignEvmTx` on Canton, creating an `EcdsaSignature`
6. User observes the `EcdsaSignature`, reconstructs the signed transaction,
   and submits it to Sepolia via `eth_sendRawTransaction` — this executes the
   ERC20 `transfer` on-chain, sweeping tokens from the **deposit address** to the
   **vault address**
7. MPC Service polls Sepolia for the receipt and verifies `receipt.status === 1`
8. MPC Service exercises `ProvideEvmOutcomeSig` on Canton, creating an
   `EvmTxOutcomeSignature`
9. User observes the outcome signature and exercises `ClaimEvmDeposit` on Canton
10. Canton archives all evidence contracts and creates an `Erc20Holding`

The result: an `Erc20Holding` contract on Canton representing the user's
wrapped ERC-20 balance.

## Reference Files (solana-contract-examples)

| File                                                    | What it does                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `contract/tests/sign-respond-erc20.ts`                  | E2E deposit test — the source of truth we're porting          |
| `contract/programs/.../src/instructions/erc20_vault.rs` | On-chain deposit + claim logic                                |
| `contract/programs/.../src/crypto.rs`                   | Address derivation (epsilon \* G) + signature verification    |
| `contract/programs/.../src/state/erc20.rs`              | PendingErc20Deposit, UserErc20Balance state types             |
| `contract/utils/envConfig.ts`                           | Environment config + fakenet constants                        |
| `frontend/lib/services/cross-chain-orchestrator.ts`     | Shows the actor separation: MPC signs, user submits to ETH    |
| `frontend/lib/relayer/embedded-signer.ts`               | Fakenet-signer lifecycle (start/shutdown)                     |
| `frontend/lib/evm/tx-builder.ts`                        | ERC20 transfer tx construction                                |
| `frontend/lib/relayer/handlers.ts`                      | Server-side deposit handler (await MPC, submit, claim)        |

Key `signet.js` internals (in `contract/node_modules/signet.js/dist/index.js`):

- `deriveChildPublicKey` (line ~144) — epsilon derivation + point addition
- `getRequestIdBidirectional` (line ~2833) — `keccak256(encodePacked(...))` request ID

## Architecture: Who Does What

In Solana, the MPC (fakenet-signer) signs and returns signatures **on-chain**
as events. It **never** submits to Ethereum. A user/frontend picks up the
signature, builds the full signed tx, and submits to Sepolia on its own. After
Ethereum confirms, the MPC reads the receipt and signs a response proving
success. The user picks up that response and calls claim.

Canton mirrors this with **evidence contracts** on the `VaultOrchestrator`.
`PendingEvmDeposit` stays as the anchor contract throughout the lifecycle.
The MPC posts signatures to separate templates; the user submits to
Ethereum and triggers the final claim:

```
 User                           Canton (VaultOrchestrator)     MPC Service                    Sepolia
 |                              |                              |                              |
 | 1. ERC20 transfer            |                              |                              |
 |                              |                              |                              |
 |----------------------------------------------------------------------------- transfer ---->|
 |                              |                              |        (user → deposit addr) |
 |<---------------------------------------------------------------------------- receipt ------|
 |                              |                              |                              |
 | 2. RequestEvmDeposit         |                              |                              |
 |    (evmParams, path,         |                              |                              |
 |     contractId)              |                              |                              |
 |----------------------------->|                              |                              |
 |                              |                              |                              |
 |                              | 3. creates PendingEvmDeposit |                              |
 |                              |    (path, evmParams,         |                              |
 |                              |     requester, contractId)   |                              |
 |                              |                              |                              |
 |                              |    observes PendingEvmDeposit|                              |
 |                              |----------------------------->|                              |
 |                              |                              |                              |
 |                              |                              | 4. buildCalldata             |
 |                              |                              |    serializeTx               |
 |                              |                              |    keccak256 -> txHash       |
 |                              |                              |    deriveChildKey            |
 |                              |                              |    sign(txHash)              |
 |                              |                              |                              |
 |                              |                              | 5. SignEvmTx                 |
 |                              |<------ EcdsaSignature -------|                              |
 |                              |        (r, s, v)             |                              |
 |                              |                              |                              |
 | 6. observes EcdsaSignature   |                              |                              |
 |<-----------------------------|                              |                              |
 |    reconstructSignedTx       |                              |                              |
 |    eth_sendRawTransaction    |                              |                              |
 |----------------------------------------------------------------------------- sweep tx ---->|
 |                              |                              |  (deposit addr → vault addr) |
 |<---------------------------------------------------------------------------- receipt ------|
 |                              |                              |                              |
 |                              |                              | 7. polls Sepolia             |
 |                              |                              |    (knows expected           |
 |                              |                              |     sweep tx hash)           |
 |                              |                              |                              |
 |                              |                              |--- getTransactionReceipt --->|
 |                              |                              |<-----------------------------|
 |                              |                              |    verify receipt.status     |
 |                              |                              |                              |
 |                              |                              | 8. ProvideEvmOutcomeSig      |
 |                              |<--- EvmTxOutcomeSignature ---|                              |
 |                              |    (signature, mpcOutput)    |                              |
 |                              |                              |                              |
 | 9. observes EvmTxOutcomeSig  |                              |                              |
 |<-----------------------------|                              |                              |
 |    ClaimEvmDeposit           |                              |                              |
 |-- pending, outcome, ecdsa -->|                              |                              |
 |                              |                              |                              |
 |                              | 10. archive PendingEvmDeposit|                              |
 |                              |     archive EvmTxOutcomeSig  |                              |
 |                              |     archive EcdsaSignature   |                              |
 |                              |                              |                              |
 |                              |     creates Erc20Holding     |                              |
 |                              |                              |                              |
 |<------- Erc20Holding --------|                              |                              |
 |                              |                              |                              |
```

### Actor Responsibilities

| Actor       | Holds                                         | Observes on Canton                    | Does                                                                                                                                                                                                            | Writes to Canton                                                                 |
| ----------- | --------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **User**    | MPC public key, Sepolia RPC (read+write)      | EcdsaSignature, EvmTxOutcomeSignature | Derives addresses (signet.js), builds calldata + evmParams, fetches nonce/gas from Sepolia, reconstructs signed tx from EcdsaSignature, submits to Sepolia, triggers claim after observing EvmTxOutcomeSignature | PendingEvmDeposit (via RequestEvmDeposit), Erc20Holding (via ClaimEvmDeposit)    |
| **MPC**     | MPC root private key, Sepolia RPC (read-only) | PendingEvmDeposit                     | Verifies contractId matches VaultOrchestrator, reads evmParams/path/requester, derives caip2Id from chainId, derives child key, signs EVM tx, polls Sepolia for receipt, signs outcome                          | EcdsaSignature (via SignEvmTx), EvmTxOutcomeSignature (via ProvideEvmOutcomeSig) |

The MPC **reads** Sepolia (to verify the ETH tx result) but **never writes** to
it. Only the user submits transactions to Ethereum. The user reconstructs
the signed tx from the MPC's on-chain signature.

### Mapping Solana → Canton

| Solana concept                                        | Canton equivalent                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `deposit_erc20` instruction + CPI to Chain Signatures | `RequestEvmDeposit` choice → creates `PendingEvmDeposit`                       |
| `signatureRespondedEvent` (MPC EVM signature)         | `EcdsaSignature` contract (created by `SignEvmTx`)                             |
| User picks up signature, submits to ETH               | User observes `EcdsaSignature`, submits to ETH                                 |
| `respondBidirectionalEvent` (MPC response)            | `EvmTxOutcomeSignature` contract (created by `ProvideEvmOutcomeSig`)           |
| `claim_erc20` instruction (secp256k1_recover)         | `ClaimEvmDeposit` choice — user triggers, `secp256k1WithEcdsaOnly` verifies    |
| `UserErc20Balance` PDA account                        | `Erc20Holding` contract                                                        |
| vault_authority PDA as predecessorId                  | VaultOrchestrator's `contractId` (read by MPC from PendingEvmDeposit)          |
| user's Solana pubkey as derivation path               | `requester` + user-supplied `path` field on `RequestEvmDeposit`                |

### Key Divergences from Solana

| Area                    | Solana                                                                                                                                                      | Canton                                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EVM params              | Builds ERC20 calldata on-chain (`IERC20::transferCall` in Rust)                                                                                             | Generic EIP-1559 — caller pre-builds `functionSignature` + `args` off-chain                                                                                                                                                                 |
| Deposit lifecycle       | `PendingErc20Deposit` closed at claim (`close = payer` in Anchor)                                                                                           | `PendingEvmDeposit` stays as anchor; MPC posts signatures to separate templates; all archived at claim (including `EcdsaSignature`)                                                                                                         |
| Response key            | MPC signs response with **per-user derived key** (vault PDA + `"solana response key"` path); claim verifies via `secp256k1_recover` against derived address | MPC signs response with **root key**; claim verifies via `secp256k1WithEcdsaOnly` against `mpcPublicKey` on VaultOrchestrator. Equivalent security — root key compromise breaks both models; `requestId` matching prevents cross-user claim |
| predecessorId           | `vault_authority` PDA (derived from user's Solana pubkey, seeds `[b"vault_authority", user_pubkey]`)                                                        | VaultOrchestrator's `contractId` — globally unique per instance, authenticated by MPC via contractId verification                                                                                                                           |
| path                    | user's Solana pubkey string                                                                                                                                 | `requester` (Canton party text) + user-supplied `path` argument                                                                                                                                                                            |
| CAIP2 in key derivation | Hardcodes `SOLANA_CAIP2_ID` (`"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"`) for epsilon derivation, even for EVM tx signing                                   | Derives `"eip155:" <> chainId` from `evmParams.chainId` on-chain (like Solana's `format!("eip155:{}", tx_params.chain_id)`) — provides chain isolation (different EVM chains get different derived keys)                                    |
| ETH submission tracking | No on-chain record — relayer tracks tx hash off-chain (Redis); MPC monitors Sepolia independently                                                           | Same — no on-chain record; MPC computes expected tx hash from its own signature and polls Sepolia                                                                                                                                           |
| Request ID              | `keccak256(encodePacked(sender, rlpTx, caip2Id, ...))` — 8-field formula                                                                                    | Same 8-field formula — `packParams(evmParams)` replaces RLP as payload, `partyToText requester` as sender, `contractId` replaces empty `params`                                                                                            |
| DDoS prevention         | Solana tx fees + account rent provide natural rate limiting                                                                                                  | `DepositAuthorization` token — issuer grants limited uses per user; `RequestEvmDeposit` burns one use per call                                                                                                                              |

## Deposit State Machine

`PendingEvmDeposit` is the anchor contract — it lives from request creation until
claim. The MPC posts its outputs as evidence contracts on the
`VaultOrchestrator`, linked by `requestId`:

```
PendingEvmDeposit (anchor — lives until claimed)
    │
    ├── MPC exercises SignEvmTx
    │   → creates EcdsaSignature (r, s, v)
    │   → MPC computes expected signed tx hash, starts polling Sepolia
    │
    ├── User observes EcdsaSignature
    │   → reconstructs signed tx, submits to Sepolia
    │
    ├── MPC sees receipt on Sepolia (status === 1)
    │   → exercises ProvideEvmOutcomeSig
    │   → creates EvmTxOutcomeSignature (DER sig of outcome)
    │
    └── User observes EvmTxOutcomeSignature
        → exercises ClaimEvmDeposit(pendingCid, outcomeCid, ecdsaCid)
        → verifies MPC signature on-chain
        → archives PendingEvmDeposit + EvmTxOutcomeSignature + EcdsaSignature
        → creates Erc20Holding
```

Each step is observable by the next actor via Canton's ledger update stream
(`/v2/updates` WebSocket or HTTP polling).

## Daml Contract Changes

### `VaultOrchestrator` — the orchestrator (Erc20Vault.daml)

`VaultOrchestrator` is the singleton orchestrator contract. It owns the MPC
public key and vault address, and hosts all choices that drive the deposit
lifecycle. All evidence contracts (`EcdsaSignature`,
`EvmTxOutcomeSignature`) and state contracts (`PendingEvmDeposit`,
`Erc20Holding`) are created through its choices.

```daml
template VaultOrchestrator
  with
    issuer       : Party          -- the party that operates the vault
    mpcPublicKey : PublicKeyHex   -- SPKI-encoded secp256k1 public key
    vaultAddress : BytesHex       -- centralized sweep address (derived from MPC root key + vault derivation path)
  where
    signatory issuer

    -- Deposit lifecycle choices:
    nonconsuming choice RequestEvmDeposit    : ContractId PendingEvmDeposit
    nonconsuming choice SignEvmTx            : ContractId EcdsaSignature
    nonconsuming choice ProvideEvmOutcomeSig : ContractId EvmTxOutcomeSignature
    nonconsuming choice ClaimEvmDeposit      : ContractId Erc20Holding
```

The existing `RequestDeposit`, `ClaimDeposit`, `RequestWithdrawal`, and
`CompleteWithdrawal` choices are replaced by the `Evm`-prefixed versions.
`mpcPublicKey` is set once at creation and used by `ClaimEvmDeposit` to verify
the MPC's DER signature via `secp256k1WithEcdsaOnly`. `vaultAddress` is the
centralized sweep destination, validated in `RequestEvmDeposit`.

### Modified: `EvmTransactionParams` — generic EIP-1559 (Types.daml)

Replace the current ERC20-specific fields with generic EIP-1559 transaction
fields. The MPC is transaction-type agnostic — it signs any Type 2 transaction.

Instead of opaque `inputData`, the contract stores the function signature and
args separately. This gives Daml visibility into what EVM call is being made,
enabling on-chain authorization (e.g., only allow `transfer`, verify the
recipient is the vault address, check amounts match).

```daml
data EvmTransactionParams = EvmTransactionParams
  with
    to                : BytesHex   -- 20 bytes, destination address
    functionSignature : Text       -- e.g., "transfer(address,uint256)"
    args              : [BytesHex] -- per-arg hex values, canonical width
    value             : BytesHex   -- 32 bytes, ETH value (usually "00...")
    nonce             : BytesHex   -- 32 bytes
    gasLimit          : BytesHex   -- 32 bytes
    maxFeePerGas      : BytesHex   -- 32 bytes
    maxPriorityFee    : BytesHex   -- 32 bytes
    chainId           : BytesHex   -- 32 bytes
  deriving (Eq, Show)
```

Removed: `erc20Address`, `recipient`, `amount`, `operation` (ERC20-specific).

The MPC and user reconstruct calldata deterministically from
`functionSignature` + `args` using viem:

```typescript
const selector = toFunctionSelector(`function ${functionSignature}`);
const encoded = encodeAbiParameters(paramTypes, args);
const calldata = concat([selector, encoded]);
```

**Daml authorization example:**

```daml
-- In RequestEvmDeposit:
assertMsg "Only ERC20 transfer allowed"
  (evmParams.functionSignature == "transfer(address,uint256)")
assertMsg "Transfer recipient must be vault address"
  (evmParams.args !! 0 == vaultAddress)
```

### Modified: `PendingEvmDeposit` — add `path`, `contractId`, derive `caip2Id` (Erc20Vault.daml)

The MPC needs the derivation path to derive the child signing key. It reads
`contractId` from PendingEvmDeposit and uses it as the `predecessorId` for
key derivation — this is cross-checked against the VaultOrchestrator's
`CreatedEvent.contractId` from the ledger; if mismatched, the request is
dropped. Since `contractId` is globally unique per VaultOrchestrator instance,
it feeds into both key derivation and `computeRequestId` — different
VaultOrchestrator instances produce unique deposit addresses and unique
requestIds with no collision.

The `caip2Id` is derived on-chain from `evmParams.chainId` — the contract
knows this is an EVM flow (`"eip155:"` prefix is hardcoded, like Solana
hardcodes its CAIP2 ID in `erc20_vault.rs:50`).

```daml
template PendingEvmDeposit
  with
    issuer     : Party
    requester  : Party        -- the user initiating the deposit
    requestId  : BytesHex
    path       : Text         -- user-supplied derivation sub-path
    evmParams  : EvmTransactionParams
    contractId : Text         -- VaultOrchestrator's contractId, MPC verifies against event
    keyVersion : Int          -- e.g., 1
    algo       : Text         -- e.g., "ECDSA"
    dest       : Text         -- e.g., "ethereum"
  where
    signatory issuer
    observer requester
```

The `caip2Id` is not stored — it's derived deterministically from
`evmParams.chainId` as `"eip155:" <> chainIdToDecimalText evmParams.chainId`.
`erc20Address` and `amount` are likewise in `evmParams`
(`evmParams.to` = ERC20 contract, `evmParams.args !! 1` = amount).

**Key derivation (predecessorId + path):** For `deriveChildPublicKey`, the MPC
and user use:

- **predecessorId** = contractId (VaultOrchestrator's contractId)
- **path** = requester + user-supplied `path` argument

### New: Evidence templates on VaultOrchestrator (Erc20Vault.daml)

Evidence contracts live on the `VaultOrchestrator` — created via choices,
linked by `requestId`.

```daml
-- | MPC's EVM transaction signature. Created by SignEvmTx.
template EcdsaSignature
  with
    issuer    : Party
    requestId : BytesHex
    r         : BytesHex              -- 32 bytes
    s         : BytesHex              -- 32 bytes
    v         : Int                   -- recovery id (0 or 1)
  where
    signatory issuer

-- | MPC's attestation of the ETH transaction outcome.
-- Created by ProvideEvmOutcomeSig. DER-encoded signature verifiable
-- on-chain with secp256k1WithEcdsaOnly against VaultOrchestrator.mpcPublicKey.
template EvmTxOutcomeSignature
  with
    issuer    : Party
    requestId : BytesHex
    signature : SignatureHex   -- secp256k1 over keccak256(requestId || mpcOutput)
    mpcOutput : BytesHex       -- "01" = success
  where
    signatory issuer
```

### New: `Erc20Holding` — final state (Erc20Vault.daml)

Represents a user's ownership of wrapped ERC-20 tokens on Canton.

```daml
template Erc20Holding
  with
    issuer       : Party
    owner        : Party
    erc20Address : BytesHex
    amount       : Decimal
  where
    signatory issuer
    observer owner
```

### Modified: `RequestEvmDeposit` — add `path`, `contractId`, authorization, derive `caip2Id`

See [`PendingEvmDeposit`](#modified-pendingevmdeposit--add-path-contractid-derive-caip2id-erc20vaultdaml)
for how `contractId`, `path`, and `caip2Id` work.

The choice validates that the EVM call is an ERC20 transfer to the vault
address, and burns one use from the caller's `DepositAuthorization` token
(see [DDoS Prevention](#ddos-prevention-authorization-pattern)).

```daml
nonconsuming choice RequestEvmDeposit : ContractId PendingEvmDeposit
  with
    requester   : Party
    path        : Text
    evmParams   : EvmTransactionParams
    contractId  : Text         -- VaultOrchestrator's contractId, MPC cross-checks against ledger
    keyVersion  : Int          -- e.g, 1
    algo        : Text         -- e.g., "ECDSA"
    dest        : Text         -- e.g., "ethereum"
    authCid     : ContractId DepositAuthorization
  controller requester
  do
    auth <- fetch authCid
    assertMsg "Auth issuer mismatch" (auth.issuer == issuer)
    assertMsg "Auth owner mismatch"  (auth.owner == requester)
    assertMsg "No remaining uses"    (auth.remainingUses > 0)
    archive authCid
    when (auth.remainingUses > 1) do
      void $ create auth with remainingUses = auth.remainingUses - 1

    assertMsg "Only ERC20 transfer allowed"
      (evmParams.functionSignature == "transfer(address,uint256)")
    assertMsg "Transfer recipient must be vault address"
      (evmParams.args !! 0 == vaultAddress)

    let sender = partyToText requester
    let caip2Id = "eip155:" <> chainIdToDecimalText evmParams.chainId
    let requestId = computeRequestId sender evmParams caip2Id keyVersion path algo dest contractId
    create PendingEvmDeposit with
      issuer; requester; requestId; path; evmParams; contractId; keyVersion; algo; dest
```

`keyVersion = 1` is passed by the caller (same as Solana's current version).
`algo`, `dest` are also caller-supplied (`"ECDSA"`, `"ethereum"`).
`chainIdToDecimalText` converts the hex `chainId` field to its decimal text
representation (e.g., `"aa36a7"` → `"11155111"`).

### New: `SignEvmTx` choice

MPC deterministically RLP-encodes the EVM tx from `evmParams`, hashes it,
signs with the derived child key, and posts the signature as `EcdsaSignature`.

```daml
nonconsuming choice SignEvmTx : ContractId EcdsaSignature
  with
    requestId : BytesHex
    r         : BytesHex
    s         : BytesHex
    v         : Int
  controller issuer
  do
    create EcdsaSignature with
      issuer; requestId; r; s; v
```

### New: `ProvideEvmOutcomeSig` choice

MPC verifies the ETH receipt (off-chain via Sepolia RPC), signs the outcome,
and posts the proof.

```daml
nonconsuming choice ProvideEvmOutcomeSig : ContractId EvmTxOutcomeSignature
  with
    requestId : BytesHex
    signature : SignatureHex   -- DER-encoded secp256k1
    mpcOutput : BytesHex
  controller issuer
  do
    create EvmTxOutcomeSignature with
      issuer; requestId; signature; mpcOutput
```

### Modified: `ClaimEvmDeposit` — consumes `PendingEvmDeposit` + `EvmTxOutcomeSignature` + `EcdsaSignature`

The user triggers claim after observing `EvmTxOutcomeSignature`. Verifies the
MPC's DER signature on-chain using `mpcPublicKey` from VaultOrchestrator,
then archives all evidence contracts. Since the MPC creates exactly one
`EvmTxOutcomeSignature` per requestId, archiving it prevents double-claims —
duplicate `PendingEvmDeposit` contracts become inert.

```daml
nonconsuming choice ClaimEvmDeposit : ContractId Erc20Holding
  with
    pendingCid  : ContractId PendingEvmDeposit
    outcomeCid  : ContractId EvmTxOutcomeSignature
    ecdsaCid    : ContractId EcdsaSignature
  controller issuer
  do
    pending <- fetch pendingCid
    outcome <- fetch outcomeCid

    assertMsg "Request ID mismatch"
      (pending.requestId == outcome.requestId)

    assertMsg "MPC reported ETH transaction failure"
      (outcome.mpcOutput == "01")

    let responseHash = computeResponseHash pending.requestId outcome.mpcOutput
    assertMsg "Invalid MPC signature on deposit response"
      (secp256k1WithEcdsaOnly outcome.signature responseHash mpcPublicKey)

    let amount = hexToDecimal ((pending.evmParams).args !! 1)

    archive pendingCid
    archive outcomeCid
    archive ecdsaCid

    create Erc20Holding with
      issuer
      owner        = pending.requester
      erc20Address = (pending.evmParams).to    -- ERC20 contract address
      amount
```

### Modified: `Crypto.daml` — updated `packParams` + new helpers

Remove `MpcSignature` data type and `verifyMpcSignature` (public key is on
VaultOrchestrator; verification uses `secp256k1WithEcdsaOnly` directly).
Update `packParams` to match the new generic `EvmTransactionParams` fields,
and update `computeRequestId` to follow Solana's `getRequestIdBidirectional`
formula with `packParams` replacing the RLP payload and `contractId` as the
8th field (replacing the empty `params`).

```daml
-- | abi_encode_packed equivalent for EVM transaction fields.
-- Replaces the RLP payload in Solana's getRequestIdBidirectional.
-- Includes every field that the RLP-encoded EIP-1559 tx carries:
--   chainId, nonce, maxPriorityFee, maxFeePerGas, gasLimit, to, value,
--   data (= functionSignature + args), accessList (always empty — omitted).
packParams : EvmTransactionParams -> BytesHex
packParams p =
  padHex p.to 20
    <> toHex p.functionSignature  -- e.g., "transfer(address,uint256)"
    <> foldl (<>) "" p.args           -- concatenated args (variable length)
    <> padHex p.value          32
    <> padHex p.nonce          32
    <> padHex p.gasLimit       32
    <> padHex p.maxFeePerGas   32
    <> padHex p.maxPriorityFee 32
    <> padHex p.chainId        32
-- NOTE: accessList is always [] in this PoC — not included in packing.
-- If access lists are supported later, they must be added here.

-- | Convert Text to hex-encoded UTF-8 bytes.
-- e.g., "ECDSA" → "4543445341"
toHex : Text -> BytesHex

-- | Convert Int to 4-byte big-endian hex. e.g., 1 → "00000001"
uint32ToHex : Int -> BytesHex

-- | Request ID = keccak256(encodePacked(sender, payload, caip2Id,
-- keyVersion, path, algo, dest, contractId)).
-- Same formula as Solana's getRequestIdBidirectional, with
-- packParams(evmParams) replacing the RLP-encoded tx as payload
-- and contractId replacing the empty params field.
computeRequestId : Text -> EvmTransactionParams -> Text -> Int -> Text -> Text -> Text -> Text -> BytesHex
computeRequestId sender evmParams caip2Id keyVersion path algo dest contractId =
  let payload = packParams evmParams
  in keccak256
    ( toHex sender
      <> payload
      <> toHex caip2Id
      <> uint32ToHex keyVersion
      <> toHex path
      <> toHex algo
      <> toHex dest
      <> toHex contractId
    )

-- | Compute response_hash = keccak256(request_id || serialized_output).
computeResponseHash : BytesHex -> BytesHex -> BytesHex
computeResponseHash requestId output = keccak256 (requestId <> output)

-- | Convert hex-encoded chainId to decimal text.
-- e.g., "aa36a7" → "11155111" (Sepolia)
chainIdToDecimalText : BytesHex -> Text
```

## DDoS Prevention: Authorization Pattern

Without access control any party could spam `RequestEvmDeposit` and overload the
MPC. Follows Canton's [Authorization Pattern](https://docs.digitalasset.com/build/3.4/sdlc-howtos/smart-contracts/develop/patterns/authorization.html):
the issuer creates a token with a hard use-limit per user. `RequestEvmDeposit`
becomes `controller requester` only — the choice fetches the token, validates
ownership, and burns one use. No token → tx fails → MPC never sees it.

```daml
template DepositAuthorization
  with
    issuer        : Party
    owner         : Party
    remainingUses : Int
  where
    signatory issuer
    observer owner
```

Users request authorization via the orchestrator; the issuer approves or ignores:

```daml
-- User requests an authorization card
nonconsuming choice RequestDepositAuth : ContractId DepositAuthProposal
  with requester : Party
  controller requester
  do create DepositAuthProposal with issuer; owner = requester

-- Issuer approves the request
nonconsuming choice ApproveDepositAuth : ContractId DepositAuthorization
  with
    proposalCid   : ContractId DepositAuthProposal
    remainingUses : Int
  controller issuer
  do
    proposal <- fetch proposalCid
    archive proposalCid
    create DepositAuthorization with
      issuer; owner = proposal.owner; remainingUses
```

**Properties:** unforgeable (`signatory issuer`), self-enforcing (counter
decrements on-ledger), revocable (issuer archives the token), MPC-safe (only
valid `PendingEvmDeposit` contracts reach the MPC).

**Alternative: Propose and Accept.** Instead of the issuer pushing cards, the
user creates a `DepositAuthProposal` and the issuer's backend accepts or ignores
it — combining the Authorization Pattern with the [Propose and Accept
Pattern](https://docs.digitalasset.com/build/3.4/sdlc-howtos/smart-contracts/develop/patterns/propose-accept.html).

## TypeScript Modules

### Address Derivation (`client/src/mpc/address-derivation.ts`)

Uses `signet.js` directly instead of reimplementing epsilon derivation.

```typescript
import { deriveChildPublicKey } from "signet.js";
import { keccak256, type Hex } from "viem";

/**
 * Derive an Ethereum deposit address from MPC root key + derivation params.
 * Wraps signet.js's deriveChildPublicKey + keccak256 address derivation.
 *
 * For deposits:
 *   predecessorId = VaultOrchestrator's contractId
 *   path = requester + user-supplied path
 *
 * For vault address:
 *   predecessorId = VaultOrchestrator's contractId
 *   path = vault derivation path (e.g., "root")
 */
export function deriveDepositAddress(
  rootPubKey: string, // "04..." uncompressed secp256k1 (no 0x)
  predecessorId: string, // = VaultOrchestrator's contractId
  path: string,
  caip2Id: string,
  keyVersion: number,
): Hex {
  const childPubKey = deriveChildPublicKey(
    rootPubKey,
    predecessorId,
    path,
    caip2Id,
    keyVersion,
  );
  return publicKeyToEthAddress(childPubKey);
}

/**
 * Convert uncompressed public key to Ethereum address.
 * address = keccak256(pubkey_x || pubkey_y)[12..32]
 */
export function publicKeyToEthAddress(uncompressedPubKey: string): Hex;
```

### EVM Transaction Builder (`client/src/evm/tx-builder.ts`)

Uses `viem` for all EVM utilities. The test builds the full `evmParams`
(including calldata) before submitting to Canton. The MPC and user use
the same serialization to reconstruct transactions deterministically.

```typescript
import {
  serializeTransaction,
  encodeFunctionData,
  keccak256,
  type Hex,
} from "viem";

/**
 * Build the functionSignature + args for an ERC20 transfer.
 * Returns the parts needed for EvmTransactionParams (not pre-encoded calldata).
 */
export function erc20TransferParams(
  to: Hex,
  amount: bigint,
): {
  functionSignature: string; // "transfer(address,uint256)"
  args: Hex[]; // [to padded to 20 bytes, amount padded to 32 bytes]
};

/**
 * Reconstruct calldata from functionSignature + args.
 * Used by MPC and user to build the EVM transaction.
 *   calldata = selector(functionSignature) || abiEncode(args)
 */
export function buildCalldata(functionSignature: string, args: Hex[]): Hex;

/**
 * Build EvmTransactionParams for Canton's RequestEvmDeposit.
 * Fetches nonce + gas estimate from Sepolia RPC (user only —
 * MPC never calls this).
 */
export async function buildEvmParams(params: {
  from: Hex;
  to: Hex;
  functionSignature: string;
  args: Hex[];
  value: bigint;
  rpcUrl: string;
  chainId: number;
}): Promise<CantonEvmParams>;

/**
 * Serialize an unsigned EIP-1559 transaction from Canton's EvmTransactionParams.
 * Reconstructs calldata from functionSignature + args via buildCalldata().
 * Deterministic: same params → same RLP bytes.
 * Used by both MPC (to compute tx hash) and user (to reconstruct).
 */
export function serializeUnsignedTx(evmParams: CantonEvmParams): Hex;

/**
 * Reconstruct a full signed EVM transaction from evmParams + signature.
 * Used by the user after reading EcdsaSignature from Canton.
 */
export function reconstructSignedTx(
  evmParams: CantonEvmParams,
  signature: { r: Hex; s: Hex; v: number },
): Hex;

/**
 * Submit a raw signed transaction to an Ethereum RPC endpoint.
 */
export async function submitRawTransaction(
  rpcUrl: string,
  raw: Hex,
): Promise<Hex>;

/**
 * Wait for a transaction receipt. Throws if status !== 1.
 */
export async function waitForReceipt(
  rpcUrl: string,
  txHash: Hex,
): Promise<TxReceipt>;
```

Uses `viem` (already a dependency). No need to add `ethers`.

### MPC Signer (`client/src/mpc-service/signer.ts`)

Key derivation uses the same epsilon derivation path format as `signet.js`.
The private-key counterpart requires `@noble/curves` for scalar addition
modulo the secp256k1 curve order.

```typescript
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, toBytes, type Hex } from "viem";

const EPSILON_DERIVATION_PREFIX = "sig.network v2.0.0 epsilon derivation";

/**
 * Derive a child private key for signing EVM transactions.
 *
 *   predecessorId = VaultOrchestrator's contractId (from PendingEvmDeposit)
 *   path = requester + pending.path
 *   derivationPath = "{prefix}:{caip2Id}:{predecessorId}:{path}"
 *   epsilon = keccak256(derivationPath)
 *   childKey = (rootPrivateKey + epsilon) mod n
 */
export function deriveChildPrivateKey(
  rootPrivateKey: Hex,
  predecessorId: string, // = VaultOrchestrator's contractId
  path: string,
  caip2Id: string,
): Hex;

/**
 * Sign an EVM transaction hash with a secp256k1 private key.
 * Returns { r, s, v } as bare hex (no 0x) for Canton's EcdsaSignature.
 */
export function signEvmTxHash(
  privateKey: Hex,
  txHash: Hex,
): { r: string; s: string; v: number };

/**
 * Sign the MPC response for Canton's EvmTxOutcomeSignature.
 *
 *   responseHash = keccak256(requestId || mpcOutput)
 *   signature = secp256k1_sign(responseHash, rootPrivateKey)
 *
 * Returns DER-encoded signature as bare hex without 0x prefix (Daml format).
 */
export function signMpcResponse(
  rootPrivateKey: Hex,
  requestId: string,
  mpcOutput: string,
): string; // DER-encoded signature hex
```

**DER encoding detail:** Daml's `secp256k1WithEcdsaOnly` expects:

- Signature: DER format `30 <len> 02 <r-len> <r> 02 <s-len> <s>`
- Public key (on VaultOrchestrator): SPKI format
  `3056301006072a8648ce3d020106052b8104000a034200 04<x><y>`

`@noble/curves` provides `sig.toDERHex()` for DER signature encoding.

### MPC Service (`client/src/mpc-service/`)

The Canton equivalent of `fakenet-signer`. Runs as a standalone process.
Uses viem for EVM transaction serialization — never fetches nonce, gas,
or any state from Sepolia during signing. Only reads Sepolia for receipt
verification.

The MPC handles the full deposit lifecycle after observing `PendingEvmDeposit`:
first it signs the EVM tx, then it independently monitors Sepolia for the
receipt (it can compute the expected signed tx hash from the evmParams +
its own signature).

```
client/src/mpc-service/
├── index.ts                        Entry point: starts watcher
├── deposit-handler.ts              Watches PendingEvmDeposit → sign + poll receipt + outcome
└── signer.ts                       Key derivation + signing
```

**deposit-handler.ts** — PendingEvmDeposit watcher:

```
On PendingEvmDeposit created:

  Phase 0: Verify contractId and extract key derivation params
    0a. orchCid = VaultOrchestrator's contractId         (from config or CreatedEvent)
    0b. Verify orchCid == pending.contractId
        If mismatch → DROP request, do not sign
    0c. predecessorId = orchCid
        path = requester + pending.path
        caip2Id = "eip155:" + decimal(evmParams.chainId)

  Phase 1: Sign the EVM transaction
    1. Read: evmParams, requestId, contractId from event
    2. Reconstruct calldata: selector(functionSignature) || abiEncode(args)
    3. Serialize unsigned EVM tx from evmParams + calldata (viem serializeTransaction)
    4. Compute tx hash: keccak256(serializedUnsigned)
    5. Derive child private key using (predecessorId, path)
    6. Sign tx hash with child private key → { r, s, v }
    7. Exercise SignEvmTx(requestId, r, s, v)
       → creates EcdsaSignature on Canton

  Phase 2: Verify ETH outcome (independent of user)
    8. Reconstruct signed tx from evmParams + calldata + r, s, v
    9. Compute expected signed tx hash: keccak256(signedSerialized)
    10. Poll Sepolia for receipt by tx hash (the user submits independently)
    11. Verify receipt.status === 1
    12. mpcOutput = "01" (success)
    13. responseHash = keccak256(requestId || mpcOutput)
    14. Sign responseHash with MPC root key → signature (DER-encoded secp256k1)
    15. Exercise ProvideEvmOutcomeSig(requestId, signature, mpcOutput)
        → creates EvmTxOutcomeSignature on Canton
```

**Environment variables:**

```
MPC_ROOT_PRIVATE_KEY=0x...           secp256k1 private key
SEPOLIA_RPC_URL=https://...          read-only (receipt verification only)
CANTON_JSON_API_URL=http://localhost:7575
```

The MPC reads `contractId` (= predecessorId) and derives `caip2Id` from
`evmParams.chainId` — no deployment-time config needed for derivation params.

### User Flow (`client/src/scripts/demo.ts`)

The user drives the deposit end-to-end: creates the request, submits
the signed transaction to Sepolia, and claims the deposit on Canton.

```
1. orchCid = VaultOrchestrator's contractId (from CreatedEvent)
   predecessorId = orchCid
   path = requester + user-supplied path
2. Derive deposit address from MPC public key + vault derivation path + user-specific derivation path
3. Derive vault (centralized) address from MPC public key + vault derivation path
4. Build evmParams: to=ERC20 contract, args=[vaultAddr, amount] (transfer call)
5. Exercise RequestEvmDeposit(requester, path, evmParams, contractId=orchCid)
   → creates PendingEvmDeposit on Canton (includes contractId for MPC verification)
6. Observe EcdsaSignature (MPC signs autonomously)
7. Reconstruct signed EVM tx from evmParams + (r, s, v)
8. Submit to Sepolia: eth_sendRawTransaction
9. Observe EvmTxOutcomeSignature (MPC verifies receipt autonomously)
10. Exercise ClaimEvmDeposit(pendingCid, outcomeCid, ecdsaCid)
    → verifies MPC sig on-chain, archives all evidence, creates Erc20Holding
11. Assert Erc20Holding balance matches deposit amount
```

**Environment variables:**

```
SEPOLIA_RPC_URL=https://...          read+write (tx submission)
CANTON_JSON_API_URL=http://localhost:7575
```

## E2E Test (`client/src/test/deposit-e2e.test.ts`)

The test knows nothing about MPC keys. It creates the request and waits for
the MPC to process it, then submits to Sepolia and claims.

```typescript
describe("E2E ERC20 Deposit Flow", () => {
  // beforeAll: upload DAR, allocate parties, create user, create VaultOrchestrator

  it("derives deterministic deposit address from MPC public key", () => {
    // Uses signet.js's deriveChildPublicKey directly.
    // predecessorId = VaultOrchestrator's contractId
    // path = requester + user-supplied path
    // Cross-check with known vectors.
  });

  it("derives different addresses for different derivation paths", () => {
    // path="alice:deposit" vs path="bob:deposit" → different addresses.
  });

  it("deposit address differs from signer (vault) address", () => {
    // path=derivationPath vs path="root" → different addresses.
  });

  it("request ID matches between TypeScript and Canton", async () => {
    // Exercise RequestEvmDeposit, compare Canton's requestId with TS computation.
    // Extends existing cross-runtime test in crypto.test.ts.
  });

  it("completes full deposit lifecycle", async () => {
    // Step 1: Get VaultOrchestrator's contractId
    const orchCid = vaultOrchestrator.contractId;
    const predecessorId = orchCid;
    const path = `${requesterParty}${userPath}`;

    // Step 2: Derive addresses (public key only, using signet.js)
    const depositAddr = deriveDepositAddress(
      MPC_PUB_KEY, predecessorId, path, CAIP2_ID, KEY_VERSION,
    );
    const vaultAddr = deriveDepositAddress(
      MPC_PUB_KEY, predecessorId, "root", CAIP2_ID, KEY_VERSION,
    );

    // Step 3: Build ERC20 transfer function signature + args
    const { functionSignature, args } = erc20TransferParams(vaultAddr, depositAmount);

    // Step 4: Build evmParams (fetch nonce + gas from Sepolia — read-only)
    const evmParams = await buildEvmParams({
      from: depositAddr, to: ERC20_ADDRESS,
      functionSignature, args, value: 0n,
      rpcUrl: SEPOLIA_RPC_URL, chainId: 11155111,
    });

    // Step 5: Exercise RequestEvmDeposit on Canton
    await exerciseChoice(..., "RequestEvmDeposit", {
      requester: depositor, path: userPath, evmParams,
      contractId: orchCid, keyVersion: 1, algo: "ECDSA", dest: "ethereum",
      authCid,
    });

    // Step 6: Wait for MPC to sign (EcdsaSignature appears)
    const ecdsaSig = await pollForContract("EcdsaSignature", ...);

    // Step 7: Reconstruct signed tx and submit to Sepolia
    const signedTx = reconstructSignedTx(evmParams, ecdsaSig);
    await submitRawTransaction(SEPOLIA_RPC_URL, signedTx);

    // Step 8: Wait for MPC to verify receipt (EvmTxOutcomeSignature appears)
    const outcomeSig = await pollForContract("EvmTxOutcomeSignature", ...);

    // Step 9: Exercise ClaimEvmDeposit
    await exerciseChoice(..., "ClaimEvmDeposit", {
      pendingCid, outcomeCid: outcomeSig.contractId, ecdsaCid: ecdsaSig.contractId,
    });

    // Step 10: Assert final state
    const holding = await pollForContract("Erc20Holding", depositor);
    expect(holding.owner).toBe(depositor);
    expect(holding.erc20Address).toBe(ERC20_ADDRESS);
    expect(holding.amount).toBe(depositAmount);
  }, 180_000);  // 3 min timeout for Sepolia confirmation
});
```

## File Structure

```
canton-mpc-poc/
├── daml/
│   ├── Erc20Vault.daml              MODIFY: Evm-prefixed templates + choices,
│   │                                        EcdsaSignature, EvmTxOutcomeSignature,
│   │                                        DepositAuthorization, DepositAuthProposal,
│   │                                        SignEvmTx, ProvideEvmOutcomeSig,
│   │                                        RequestEvmDeposit, ClaimEvmDeposit
│   ├── Types.daml                   MODIFY: generic EvmTransactionParams,
│   │                                        remove MpcSignature data type + OperationType
│   ├── Crypto.daml                  MODIFY: updated packParams, computeRequestId
│   │                                        (signet.js formula + contractId),
│   │                                        add helpers, remove verifyMpcSignature
│   └── Test.daml                    UPDATE: new EvmTransactionParams fields + path
│
├── client/
│   ├── src/
│   │   ├── config/
│   │   │   └── env.ts                        NEW: shared env loading
│   │   ├── evm/
│   │   │   └── tx-builder.ts                 NEW: generic EIP-1559 build/reconstruct/submit
│   │   ├── infra/
│   │   │   ├── canton-client.ts              EXTEND: getActiveContracts
│   │   │   └── ledger-stream.ts              unchanged
│   │   ├── mpc/
│   │   │   ├── crypto.ts                     MODIFY: update EvmTransactionParams, use signet.js getRequestIdBidirectional
│   │   │   └── address-derivation.ts         NEW: wraps signet.js deriveChildPublicKey
│   │   ├── mpc-service/
│   │   │   ├── index.ts                      NEW: MPC service entry point
│   │   │   ├── deposit-handler.ts            NEW: PendingEvmDeposit → sign + verify + outcome
│   │   │   └── signer.ts                     NEW: key derivation + signing
│   │   ├── scripts/
│   │   │   ├── demo.ts                       UPDATE: user-driven flow with contractId + auth
│   │   │   └── derive-address.ts             NEW: print deposit address
│   │   └── test/
│   │       ├── crypto.test.ts                UPDATE: new EvmTransactionParams + path
│   │       ├── address-derivation.test.ts    NEW: address derivation unit tests
│   │       └── deposit-e2e.test.ts           NEW: E2E deposit test
│   │
│   └── package.json                          ADD: signet.js, @noble/curves, scripts
│
└── proposals/
    └── E2E_DEPOSIT_PLAN.md          this file
```

## Dependency Changes

```diff
  "scripts": {
+   "mpc-service": "tsx src/mpc-service/index.ts",
+   "derive-address": "tsx src/scripts/derive-address.ts"
  },
  "dependencies": {
+   "signet.js": "...",
+   "@noble/curves": "^1.9.0",
  }
```

- `signet.js` — `deriveChildPublicKey` for address derivation (used by test + address script)
- `@noble/curves` — secp256k1 scalar math for child private key derivation + DER
  signature encoding (used by MPC signer only). Transitive dep of viem, made explicit.
- `viem` — already a dependency. Used for EVM tx serialization (RLP), keccak256,
  calldata encoding, and Sepolia RPC calls.

## Execution Order

| #   | Phase                                                                                                                                                                                                                             | Depends On | Scope      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| 1   | Daml: generic EvmTransactionParams, remove MpcSignature data type, signet.js-aligned computeRequestId + helpers (with contractId), Evm evidence templates, DepositAuthorization, new choices, modify RequestEvmDeposit + ClaimEvmDeposit | —          | ~150 lines |
| 2   | Rebuild DAR + codegen (`dpm build && dpm codegen-js ...`)                                                                                                                                                                         | 1          | —          |
| 3   | Address derivation module + tests (wraps signet.js)                                                                                                                                                                               | —          | ~50 lines  |
| 4   | EVM tx builder (generic EIP-1559, viem)                                                                                                                                                                                           | —          | ~120 lines |
| 5   | MPC signer module (@noble/curves)                                                                                                                                                                                                 | —          | ~100 lines |
| 6   | Env config                                                                                                                                                                                                                        | —          | ~40 lines  |
| 7   | Canton client: getActiveContracts                                                                                                                                                                                                 | —          | ~30 lines  |
| 8   | MPC service (deposit handler — verify contractId + sign + verify)                                                                                                                                                                 | 4, 5, 6    | ~150 lines |
| 9   | Derive-address script                                                                                                                                                                                                             | 3          | ~30 lines  |
| 10  | Update existing tests + demo.ts (new EvmTransactionParams + path + contractId + auth)                                                                                                                                             | 2          | ~30 lines  |
| 11  | E2E deposit test (user-driven: request → observe sig → submit → observe outcome → claim)                                                                                                                                         | 3, 4, 6, 7 | ~120 lines |

Phases 1, 3, 4, 5, 6 are independent and can be built in parallel. Phase 2 must
follow 1. Phase 8 integrates the shared modules. Phase 11 ties
everything together.

## Prerequisites

1. **MPC root private key** (secp256k1 hex) → MPC service env only
2. **MPC root public key** (uncompressed `04...` AND SPKI DER format) → test config + Canton VaultOrchestrator
3. **Sepolia RPC URL** (Infura or Alchemy) → all services
4. **After phase 9:** run `npm run derive-address` → fund the printed address with **both USDC and ETH** on Sepolia (ETH pays for gas on the signed EVM transaction)
5. **Runtime:** Canton sandbox + MPC service all running before test

## Crypto Details

### Address Derivation

Uses `signet.js`'s `deriveChildPublicKey` — same algorithm as
`solana-contract-examples/contract/programs/.../src/crypto.rs`:

```
derivationPath = "sig.network v2.0.0 epsilon derivation:{caip2Id}:{predecessorId}:{path}"
epsilon = keccak256(derivationPath)                      // 32-byte scalar
childPublicKey = rootPublicKeyPoint + (epsilon × G)      // secp256k1 point addition
ethAddress = keccak256(childPublicKey.x ‖ childPublicKey.y)[12..32]
```

The MPC reads derivation inputs from PendingEvmDeposit:

- `predecessorId` = `contractId` (VaultOrchestrator's contractId, verified against CreatedEvent)
- `path` = `requester` (Canton party text) + user-supplied `path`
- `caip2Id` = derived from `evmParams.chainId` (`"eip155:" + decimal`)

For the vault receiver address: `predecessorId = contractId`, `path = "root"`.

### Request ID

Same formula as Solana's `getRequestIdBidirectional`, with `packParams(evmParams)`
replacing the RLP-encoded payload and `contractId` as the 8th field:

```
requestId = keccak256(encodePacked(
  sender,                    // partyToText requester (string)
  packParams(evmParams),     // packed tx fields (bytes) — replaces RLP
  caip2Id,                   // "eip155:11155111" (string)
  keyVersion,                // 1 (uint32)
  path,                      // user-supplied (string)
  "ECDSA",                   // algo (string)
  "ethereum",                // dest (string)
  contractId                 // VaultOrchestrator's contractId (string)
))
```

On the TypeScript side, this leverages `signet.js` directly:

```typescript
import { getRequestIdBidirectional } from "signet.js";

const requestId = getRequestIdBidirectional({
  sender: requesterParty,
  payload: hexToBytes(packParams(evmParams)), // packParams replaces RLP
  caip2Id: "eip155:11155111",
  keyVersion: 1,
  path: userPath,
  algo: "ECDSA",
  dest: "ethereum",
  params: orchCid, // VaultOrchestrator's contractId
});
```

On the Daml side, `computeRequestId` implements the same `encodePacked` logic
with `toHex` and `uint32ToHex` helpers (see Crypto.daml section).

### MPC Response Signature

```
mpcOutput = "01"  (hex-encoded boolean true = ETH tx succeeded)
responseHash = keccak256(requestId ‖ mpcOutput)
signature = secp256k1_sign(responseHash, rootPrivateKey)
```

Daml's `secp256k1WithEcdsaOnly` verifies without additional hashing — the
`responseHash` (already a keccak256 output) is used as the ECDSA message
directly.

**DER format requirements** (matching `Test.daml` test vectors):

- Signature: `30 <len> 02 <r-len> <r> 02 <s-len> <s>` (bare hex, no `0x`)
- Public key (on VaultOrchestrator): SPKI `3056301006072a8648ce3d020106052b8104000a034200 04<x><y>`
