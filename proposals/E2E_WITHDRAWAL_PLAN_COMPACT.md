# EVM Withdrawal Architecture: Canton MPC PoC

Mirrors the familiar CEX withdrawal experience: the user requests a withdrawal
from their balance, and the system sends tokens from the centralized
**vault address** to an external **recipient address** — except here the
"CEX backend" is a Canton ledger + MPC signing service, giving cryptographic
proof of every step.

## What the Demo Does

1. User exercises `RequestEvmWithdrawal` on Canton, providing their
   `Erc20Holding` and EVM transaction parameters for the withdrawal
2. VaultOrchestrator validates the holding (ownership, ERC20 address, amount),
   archives it (optimistic debit), and creates a `PendingEvmTx` with
   `source = WithdrawalSource`
3. MPC Service observes the `PendingEvmTx`
4. MPC Service builds, serializes, and signs the EVM withdrawal transaction
5. MPC Service exercises `SignEvmTx` on Canton, creating an `EcdsaSignature`
6. User observes the `EcdsaSignature`, reconstructs the signed transaction,
   and submits it to Sepolia via `eth_sendRawTransaction` — this executes the
   ERC20 `transfer` on-chain, sending tokens from the **vault address** to the
   **recipient address**
7. MPC Service polls Sepolia for the receipt and verifies `receipt.status === 1`
8. MPC Service exercises `ProvideEvmOutcomeSig` on Canton, creating an
   `EvmTxOutcomeSignature`
9. User observes the outcome signature and exercises `CompleteEvmWithdrawal`
   on Canton; Canton archives all evidence contracts — on success the
   withdrawal is final, on failure a refund `Erc20Holding` is created

The result: tokens move from the **vault address** on Sepolia to the user's
specified **recipient address**, and all Canton evidence is archived. On
failure, the user's `Erc20Holding` is restored.

## Withdrawal Lifecycle

```
 User                           Canton (VaultOrchestrator)     MPC Service                    Sepolia
 |                              |                              |                              |
 | 1. RequestEvmWithdrawal      |                              |                              |
 |    (balanceCid, evmParams,   |                              |                              |
 |     recipientAddress,        |                              |                              |
 |     balanceCidText)          |                              |                              |
 |----------------------------->|                              |                              |
 |                              | validates Erc20Holding       |                              |
 |                              | archives it (optimistic      |                              |
 |                              | debit)                       |                              |
 |                              |                              |                              |
 |                              | 2. creates PendingEvmTx      |                              |
 |                              |    (source=WithdrawalSource, |                              |
 |                              |     path="root", evmParams,  |                              |
 |                              |     requester,               |                              |
 |                              |     nonceCidText)            |                              |
 |                              |                              |                              |
 |                              |    observes PendingEvmTx     |                              |
 |                              |----------------------------->|                              |
 |                              |                              |                              |
 |                              |                              | 3. buildCalldata             |
 |                              |                              |    serializeTx               |
 |                              |                              |    keccak256 -> txHash       |
 |                              |                              |    deriveVaultKey            |
 |                              |                              |    sign(txHash)              |
 |                              |                              |                              |
 |                              |                              | 4. SignEvmTx                 |
 |                              |<------ EcdsaSignature -------|                              |
 |                              |        (r, s, v)             |                              |
 |                              |                              |                              |
 | 5. observes EcdsaSignature   |                              |                              |
 |<-----------------------------|                              |                              |
 |    reconstructSignedTx       |                              |                              |
 |    eth_sendRawTransaction    |                              |                              |
 |----------------------------------------------------------------------- withdrawal tx ----->|
 |                              |                              |    (vault addr -> recipient) |
 |<---------------------------------------------------------------------- receipt ------------|
 |                              |                              |                              |
 |                              |                              | 6. polls Sepolia             |
 |                              |                              |    (knows expected           |
 |                              |                              |     withdrawal tx hash)      |
 |                              |                              |                              |
 |                              |                              |--- getTransactionReceipt --->|
 |                              |                              |<-----------------------------|
 |                              |                              |    verify receipt.status     |
 |                              |                              |                              |
 |                              |                              | 7. ProvideEvmOutcomeSig      |
 |                              |<--- EvmTxOutcomeSignature ---|                              |
 |                              |    (signature, mpcOutput)    |                              |
 |                              |                              |                              |
 | 8. observes EvmTxOutcomeSig  |                              |                              |
 |<-----------------------------|                              |                              |
 |    CompleteEvmWithdrawal     |                              |                              |
 |-- pending, outcome, ecdsa -->|                              |                              |
 |                              |                              |                              |
 |                              | 9. archive PendingEvmTx      |                              |
 |                              |     archive EvmTxOutcomeSig  |                              |
 |                              |     archive EcdsaSignature   |                              |
 |                              |                              |                              |
 |                              |     if success:              |                              |
 |                              |       withdrawal complete    |                              |
 |                              |     if failure:              |                              |
 |<-- refund Erc20Holding ------|       creates refund holding |                              |
 |                              |                              |                              |
```

## Daml Contracts

### `VaultOrchestrator` (Erc20Vault.daml)

The existing singleton orchestrator gains two new withdrawal choices.
`SignEvmTx` and `ProvideEvmOutcomeSig` are reused as-is — they create generic
evidence contracts linked by `requestId`, agnostic to deposit vs withdrawal.

```daml
template VaultOrchestrator
  with
    issuer       : Party          -- the party that operates the vault
    mpc          : Party          -- the MPC signing service party
    mpcPublicKey : PublicKeyHex   -- MPC root public key for signature verification
    vaultAddress : BytesHex       -- centralized vault address (derived from MPC root key, path="root")
    vaultId      : Text           -- issuer-controlled discriminator for MPC key derivation
  where
    signatory issuer
    observer mpc

    -- Deposit choices (existing, see E2E_DEPOSIT_PLAN_COMPACT.md)
    nonconsuming choice RequestDepositAuth    : ContractId DepositAuthProposal
    nonconsuming choice ApproveDepositAuth    : ContractId DepositAuthorization
    nonconsuming choice RequestEvmDeposit     : ContractId PendingEvmTx
    nonconsuming choice ClaimEvmDeposit       : ContractId Erc20Holding

    -- Withdrawal choices (new)
    nonconsuming choice RequestEvmWithdrawal  : ContractId PendingEvmTx
    nonconsuming choice CompleteEvmWithdrawal : Optional (ContractId Erc20Holding)

    -- Evidence choices (shared by deposit and withdrawal)
    nonconsuming choice SignEvmTx             : ContractId EcdsaSignature
    nonconsuming choice ProvideEvmOutcomeSig  : ContractId EvmTxOutcomeSignature
```

### `PendingEvmTx` (Erc20Vault.daml)

Unified anchor contract for both deposit and withdrawal lifecycles — see
`E2E_DEPOSIT_PLAN_COMPACT.md` for the full template definition and field
documentation. The withdrawal flow uses it with:

- `source = WithdrawalSource balanceCid`
- `path = "root"` (vault key derivation)
- `nonceCidText = balanceCidText` (the `Erc20Holding` contractId as text)

All other contracts (`EvmTransactionParams`, `TxSource`, `EcdsaSignature`,
`EvmTxOutcomeSignature`, `Erc20Holding`) are unchanged from the deposit flow —
see `E2E_DEPOSIT_PLAN_COMPACT.md`.

### Choices on `VaultOrchestrator`

**`RequestEvmWithdrawal`** — user initiates a withdrawal from their
`Erc20Holding`. Archives the holding (optimistic debit) and creates a
`PendingEvmTx` with `source = WithdrawalSource`.

No authorization card is needed — the `Erc20Holding` itself is the
authorization. Ownership is verified by fetching the contract and checking
`owner == requester`. The holding's `contractId` doubles as a natural nonce
for `requestId` (globally unique, cryptographically generated by Canton,
consumed exactly once).

```daml
nonconsuming choice RequestEvmWithdrawal : ContractId PendingEvmTx
  with
    requester        : Party
    evmParams        : EvmTransactionParams
    recipientAddress : BytesHex  -- 20 bytes, where to send on Sepolia
    balanceCidText   : Text      -- user-supplied, Erc20Holding contractId as text (nonce)
    keyVersion       : Int
    algo             : Text
    dest             : Text
    balanceCid       : ContractId Erc20Holding
  controller requester
  do
    holding <- fetch balanceCid
    assertMsg "Holding issuer mismatch" (holding.issuer == issuer)
    assertMsg "Holding owner mismatch" (holding.owner == requester)

    let recipientArg = case evmParams.args of
          recipient :: _ -> recipient
          [] -> ""
    let amountArg = evmParams.args !! 1

    assertMsg "Only ERC20 transfer allowed"
      (evmParams.functionSignature == "transfer(address,uint256)")
    assertMsg "ERC20 contract must match holding"
      (evmParams.to == holding.erc20Address)
    assertMsg "Transfer recipient must match specified address"
      (recipientArg == recipientAddress)
    assertMsg "Withdraw amount must match holding (full withdrawal)"
      (amountArg == holding.amount)

    archive balanceCid

    let sender = partyToText requester
    let fullPath = "root"
    let caip2Id = "eip155:" <> chainIdToDecimalText evmParams.chainId
    let requestId = computeRequestId sender evmParams caip2Id keyVersion fullPath algo dest balanceCidText
    create PendingEvmTx with
      issuer; requester; mpc; requestId; path = fullPath; evmParams
      vaultId; nonceCidText = balanceCidText; source = WithdrawalSource balanceCid
      keyVersion; algo; dest
```

`PendingEvmTx` carries two nonce references — same dual-reference
pattern as deposit's `authCidText`/`authCid` (see `E2E_DEPOSIT_PLAN_COMPACT.md`):

- **`nonceCidText : Text`** — input to `computeRequestId`; globally unique
  (consumed exactly once), guaranteeing `requestId` uniqueness.

- **`source : WithdrawalSource balanceCid`** — injected by `VaultOrchestrator`
  after fetch + validation. Non-spoofable; MPC reads it directly from the
  contract payload.

**Key derivation (predecessorId + path):** same KDF as deposit —
`predecessorId = vaultId + issuer`. The difference is path: `"root"` derives
the vault's shared key that controls the centralized vault address, whereas
deposit uses `sender + "," + userPath` for per-user deposit addresses.

**`SignEvmTx`** and **`ProvideEvmOutcomeSig`** — reused from deposit
(unchanged, see `E2E_DEPOSIT_PLAN_COMPACT.md`).

**`CompleteEvmWithdrawal`** — user triggers completion after observing the
outcome signature. Asserts `WithdrawalSource` and archives all evidence
contracts. On success (`mpcOutput == "01"`), the withdrawal is final — tokens
are on Sepolia. On failure, a refund `Erc20Holding` is created to restore the
user's balance.

Unlike `ClaimEvmDeposit` (which rejects on failure), `CompleteEvmWithdrawal`
must handle both outcomes because the holding was already archived in
`RequestEvmWithdrawal` (optimistic debit).

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
    outcome <- fetch outcomeCid
    ecdsa   <- fetch ecdsaCid

    case pending.source of
      WithdrawalSource _ -> pure ()
      _ -> abort "PendingEvmTx is not a withdrawal"

    assertMsg "Pending issuer mismatch"
      (pending.issuer == issuer)
    assertMsg "Outcome issuer mismatch"
      (outcome.issuer == issuer)

    assertMsg "Requester mismatch"
      (pending.requester == requester)

    assertMsg "Request ID mismatch"
      (pending.requestId == outcome.requestId)

    let responseHash = computeResponseHash pending.requestId outcome.mpcOutput
    assertMsg "Invalid MPC signature on withdrawal response"
      (secp256k1WithEcdsaOnly outcome.signature responseHash mpcPublicKey)

    archive pendingCid
    archive outcomeCid
    archive ecdsaCid

    if outcome.mpcOutput == "01"
      then return None  -- success: tokens sent on Sepolia, withdrawal complete
      else do
        let amount = (pending.evmParams).args !! 1
        refundCid <- create Erc20Holding with
          issuer
          owner = pending.requester
          erc20Address = (pending.evmParams).to
          amount
        return (Some refundCid)
```

### Crypto Functions (Crypto.daml)

No new functions. `computeRequestId` and `computeResponseHash` are reused
as-is — the nonce slot (`authCidText` for deposit) receives `balanceCidText`
for withdrawal.

## Upgradability

The `TxSource` variant is designed for forward-compatible extension. Adding new
operation types (e.g., swap, mint) follows this pattern:

### Adding a New Operation Type

1. **Append a constructor to `TxSource`** — new variants must go at the end:

```daml
data TxSource
  = DepositSource (ContractId DepositAuthorization)
  | WithdrawalSource (ContractId Erc20Holding)
  | SwapSource (ContractId SwapRequest)              -- new, appended at end
  deriving (Eq, Show)
```

2. **Add new choices on `VaultOrchestrator`** (e.g., `RequestEvmSwap`,
   `CompleteEvmSwap`) — existing choices and the template definition are
   untouched.

3. **Upload the new DAR** — Canton validates it as a compatible upgrade.

4. **Regenerate TS codegen** (`pnpm codegen:daml`) and update the MPC service.

### Daml Upgrade Rules for Variants

- Appending constructors at the end = **compatible upgrade** (no sandbox restart)
- Inserting, reordering, renaming, or removing constructors = **incompatible**
- `VaultOrchestrator` template fields (`issuer`, `mpc`, `mpcPublicKey`,
  `vaultAddress`, `vaultId`) are decoupled from `TxSource` — only choices
  reference pending contract types

### What Requires No Migration

- Existing `PendingEvmTx` contracts on the ledger — stored `DepositSource` /
  `WithdrawalSource` values are valid in the new type (superset)
- Existing deposit/withdrawal flows — zero changes
- `computeRequestId`, `computeResponseHash` — reused as-is
- Evidence contracts (`EcdsaSignature`, `EvmTxOutcomeSignature`) — flow-agnostic

### Multi-Participant Coordination

All participants must have the new DAR before creating contracts with the new
variant. A participant still on v1 will fail at runtime if it encounters a
contract carrying an unknown constructor (e.g., `SwapSource`). For participants
that have upgraded, existing v1-created contracts are readable with no migration.
