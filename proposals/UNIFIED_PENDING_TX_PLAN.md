# Unified PendingEvmTx Proposal

Merges `PendingEvmDeposit` and `PendingEvmWithdrawal` into a single
`PendingEvmTx` template with a variant discriminator. Reduces template count,
simplifies MPC observation, and preserves type-safe provenance.

## Motivation

The two pending contracts are ~90% structurally identical. The only real
difference is the **typed nonce CID** — one points to a `DepositAuthorization`,
the other to an `Erc20Holding`. Everything else (party fields, requestId, path,
evmParams, vaultId, keyVersion, algo, dest) is shared.

The MPC service doesn't care about deposit vs withdrawal — it reads `evmParams`,
`path`, `vaultId`, `issuer`, derives the key, and signs. Having two observation
targets is unnecessary complexity.

Evidence contracts (`EcdsaSignature`, `EvmTxOutcomeSignature`) are already
flow-agnostic, linked only by `requestId`. The pending contract is the last
asymmetry.

## Structural Diff

| Field | `PendingEvmDeposit` | `PendingEvmWithdrawal` | Same? |
|---|---|---|---|
| issuer, requester, mpc | Party | Party | Yes |
| requestId | BytesHex | BytesHex | Yes |
| path | `sender + "," + userPath` | `"root"` | Value differs, type same |
| evmParams | EvmTransactionParams | EvmTransactionParams | Yes |
| vaultId | Text | Text | Yes |
| nonce text | `authCidText` | `balanceCidText` | Same purpose, different name |
| nonce CID | `ContractId DepositAuthorization` | `ContractId Erc20Holding` | **Different type** |
| keyVersion, algo, dest | Int, Text, Text | Int, Text, Text | Yes |

## Design

### New Variant: `TxSource`

A Daml variant that doubles as **type discriminator** and **provenance CID**:

```daml
data TxSource
  = DepositSource (ContractId DepositAuthorization)
  | WithdrawalSource (ContractId Erc20Holding)
  deriving (Eq, Show)
```

### Unified Template: `PendingEvmTx`

Replaces both `PendingEvmDeposit` and `PendingEvmWithdrawal`.

```daml
template PendingEvmTx
  with
    issuer       : Party
    requester    : Party
    mpc          : Party
    requestId    : BytesHex
    path         : Text            -- deposit: sender + "," + userPath; withdrawal: "root"
    evmParams    : EvmTransactionParams
    vaultId      : Text
    nonceCidText : Text            -- replaces authCidText / balanceCidText
    source       : TxSource        -- discriminator + typed provenance CID
    keyVersion   : Int
    algo         : Text
    dest         : Text
  where
    signatory issuer
    observer mpc, requester
```

- `nonceCidText` — the text form of the consumed contract ID, input to
  `computeRequestId`. Globally unique per use, guaranteeing `requestId`
  uniqueness.
- `source` — carries the typed CID for on-ledger provenance and tells
  finalization choices which flow this belongs to.

### What Changes

| Component | Change |
|---|---|
| `PendingEvmDeposit` + `PendingEvmWithdrawal` | **Merged** into `PendingEvmTx` |
| `TxSource` variant (Types.daml) | **New** |
| `RequestEvmDeposit` | Returns `ContractId PendingEvmTx` |
| `RequestEvmWithdrawal` | Returns `ContractId PendingEvmTx` |
| `ClaimEvmDeposit` | Takes `ContractId PendingEvmTx`, asserts `DepositSource` |
| `CompleteEvmWithdrawal` | Takes `ContractId PendingEvmTx`, asserts `WithdrawalSource` |
| MPC service | **Simplified** — observes one contract type |
| `SignEvmTx`, `ProvideEvmOutcomeSig` | **Unchanged** |
| `EcdsaSignature`, `EvmTxOutcomeSignature` | **Unchanged** |
| `computeRequestId`, `computeResponseHash` | **Unchanged** |
| `DepositAuthorization`, `Erc20Holding` | **Unchanged** |

### What Stays Separate (and Why)

**Request choices** — `RequestEvmDeposit` and `RequestEvmWithdrawal` remain
distinct. Their validation logic is fundamentally different:

- **Deposit**: validates auth card, burns a use, asserts `transfer` recipient =
  vault address, computes path as `sender + "," + userPath`
- **Withdrawal**: validates holding ownership, archives holding (optimistic
  debit), asserts ERC20 address + amount match, sets path = `"root"`

Both create a `PendingEvmTx` at the end (with the appropriate `TxSource`
variant), but everything before that diverges.

**Finalization choices** — `ClaimEvmDeposit` and `CompleteEvmWithdrawal` remain
distinct:

- **Deposit**: rejects on failure (`assertMsg`) — tokens are still on the
  deposit address, nothing to refund on Canton
- **Withdrawal**: handles both outcomes — optimistic debit already happened, so
  failure means creating a refund `Erc20Holding`
- **Return types differ**: `ContractId Erc20Holding` vs
  `Optional (ContractId Erc20Holding)`
- **Auditability**: seeing `ClaimEvmDeposit` or `CompleteEvmWithdrawal` in the
  transaction tree is immediately meaningful; a generic `CompleteEvmTx` would
  require inspecting the pending contract

Both reference `ContractId PendingEvmTx` and assert the expected `TxSource`
variant at the start of execution.

## Updated Choice Signatures on VaultOrchestrator

```daml
template VaultOrchestrator
  with
    issuer       : Party
    mpc          : Party
    mpcPublicKey : PublicKeyHex
    vaultAddress : BytesHex
    vaultId      : Text
  where
    signatory issuer
    observer mpc

    -- Deposit auth (unchanged)
    nonconsuming choice RequestDepositAuth   : ContractId DepositAuthProposal
    nonconsuming choice ApproveDepositAuth   : ContractId DepositAuthorization

    -- Request choices (now both return PendingEvmTx)
    nonconsuming choice RequestEvmDeposit    : ContractId PendingEvmTx
    nonconsuming choice RequestEvmWithdrawal : ContractId PendingEvmTx

    -- Evidence choices (unchanged, shared)
    nonconsuming choice SignEvmTx            : ContractId EcdsaSignature
    nonconsuming choice ProvideEvmOutcomeSig : ContractId EvmTxOutcomeSignature

    -- Finalization choices (now both reference PendingEvmTx)
    nonconsuming choice ClaimEvmDeposit      : ContractId Erc20Holding
    nonconsuming choice CompleteEvmWithdrawal : Optional (ContractId Erc20Holding)
```

## Finalization Choice Updates

**`ClaimEvmDeposit`** — asserts `DepositSource` before proceeding:

```daml
nonconsuming choice ClaimEvmDeposit : ContractId Erc20Holding
  with
    requester   : Party
    pendingCid  : ContractId PendingEvmTx
    outcomeCid  : ContractId EvmTxOutcomeSignature
    ecdsaCid    : ContractId EcdsaSignature
  controller requester
  do
    pending <- fetch pendingCid
    -- ... existing validations ...

    case pending.source of
      DepositSource _ -> pure ()
      _ -> abort "PendingEvmTx is not a deposit"

    -- ... rest unchanged (assert mpcOutput == "01", create Erc20Holding) ...
```

**`CompleteEvmWithdrawal`** — asserts `WithdrawalSource` before proceeding:

```daml
nonconsuming choice CompleteEvmWithdrawal : Optional (ContractId Erc20Holding)
  with
    requester   : Party
    pendingCid  : ContractId PendingEvmTx
    outcomeCid  : ContractId EvmTxOutcomeSignature
    ecdsaCid    : ContractId EcdsaSignature
  controller requester
  do
    pending <- fetch pendingCid
    -- ... existing validations ...

    case pending.source of
      WithdrawalSource _ -> pure ()
      _ -> abort "PendingEvmTx is not a withdrawal"

    -- ... rest unchanged (success → None, failure → refund Erc20Holding) ...
```

## MPC Service Impact

Before:
```
observe PendingEvmDeposit    → sign → EcdsaSignature
observe PendingEvmWithdrawal → sign → EcdsaSignature
```

After:
```
observe PendingEvmTx → sign → EcdsaSignature
```

The MPC reads `evmParams`, `path`, `vaultId`, `issuer` from the contract
payload. All of these are present on `PendingEvmTx` regardless of flow. The
`source` variant is irrelevant to the MPC — it just signs whatever transaction
the contract describes.

## Tradeoffs

**Gained:**
- One fewer template (2 → 1)
- Simpler MPC observation (2 subscriptions → 1)
- Single source of truth for pending transaction shape
- Variant preserves type-safe provenance (no information lost)

**Lost:**
- Ledger-level type distinction — querying active contracts shows `PendingEvmTx`
  for both flows. Must inspect `source` to distinguish. Acceptable because the
  variant makes it explicit, and finalization choices retain separate names.

## Canton Upgrade Note

This is an **incompatible change** (template rename/removal). Requires sandbox
restart — cannot hot-swap the DAR.
