# EVM Deposit Architecture: Canton MPC PoC

Mirrors the familiar CEX deposit experience: the user sends tokens to a
personal **deposit address**, and the system automatically sweeps them into a
centralized vault — except here the "CEX backend" is a Canton ledger + MPC
signing service, giving cryptographic proof of every step.

## What the Demo Does

1. User exercises `RequestDepositAuth` on Canton, creating a `DepositAuthProposal`
   (Daml Propose and Accept pattern)
2. Issuer approves via `ApproveDepositAuth`, archiving the proposal and creating
   a `DepositAuthorization` (auth card) with a hard use-limit
3. User sends ERC20 tokens to a **deposit address** on Sepolia
   (derived from MPC root public key, predecessorId=vaultId+issuer, path=sender+userPath)
4. User exercises `RequestEvmDeposit` on Canton to request a **sweep from the deposit address to the
   vault address**
   (derived from MPC root public key, predecessorId=vaultId+issuer, path="root")
   via an ERC20 `transfer` call. The choice validates the `DepositAuthorization`, burns one
   use, and creates a `PendingEvmTx` with `source = DepositSource`.
5. MPC Service observes the `PendingEvmTx`
6. MPC Service builds, serializes, and signs the EVM sweep transaction
7. MPC Service exercises `SignEvmTx` on Canton, creating an `EcdsaSignature`
8. User observes the `EcdsaSignature`, reconstructs the signed transaction,
   and submits it to Sepolia via `eth_sendRawTransaction` — this executes the
   ERC20 `transfer` on-chain, sweeping tokens from the **deposit address** to the
   **vault address**
9. MPC Service polls Sepolia for the receipt and verifies `receipt.status === 1`
10. MPC Service exercises `ProvideEvmOutcomeSig` on Canton, creating an
    `EvmTxOutcomeSignature`
11. User observes the outcome signature and exercises `ClaimEvmDeposit` on Canton
12. Canton archives all evidence contracts and creates an `Erc20Holding`

The result: an `Erc20Holding` contract on Canton representing the user's
wrapped ERC-20 balance.

## Deposit Lifecycle

```
 User                           Canton (VaultOrchestrator)     MPC Service                    Sepolia
 |                              |                              |                              |
 | 1. RequestDepositAuth        |                              |                              |
 |----------------------------->|                              |                              |
 |                              | creates DepositAuthProposal  |                              |
 |                              |                              |                              |
 | 2. Issuer: ApproveDepositAuth|                              |                              |
 |                              | archives DepositAuthProposal |                              |
 |                              | creates DepositAuthorization |                              |
 |<---- DepositAuthorization ---|  (remainingUses=N)           |                              |
 |                              |                              |                              |
 | 3. ERC20 transfer            |                              |                              |
 |                              |                              |                              |
 |----------------------------------------------------------------------------- transfer ---->|
 |                              |                              |        (user → deposit addr) |
 |<---------------------------------------------------------------------------- receipt ------|
 |                              |                              |                              |
 | 4. RequestEvmDeposit         |                              |                              |
 |    (evmParams, path,         |                              |                              |
 |     authCidText, authCid)    |                              |                              |
 |----------------------------->|                              |                              |
 |                              | validates auth card,         |                              |
 |                              | burns one use                |                              |
 |                              |                              |                              |
 |                              | 5. creates PendingEvmTx      |                              |
 |                              |    (source=DepositSource,    |                              |
 |                              |     path, evmParams,         |                              |
 |                              |     requester,               |                              |
 |                              |     nonceCidText)            |                              |
 |                              |                              |                              |
 |                              |    observes PendingEvmTx     |                              |
 |                              |----------------------------->|                              |
 |                              |                              |                              |
 |                              |                              | 6. buildCalldata             |
 |                              |                              |    serializeTx               |
 |                              |                              |    keccak256 -> txHash       |
 |                              |                              |    deriveChildKey            |
 |                              |                              |    sign(txHash)              |
 |                              |                              |                              |
 |                              |                              | 7. SignEvmTx                 |
 |                              |<------ EcdsaSignature -------|                              |
 |                              |        (r, s, v)             |                              |
 |                              |                              |                              |
 | 8. observes EcdsaSignature   |                              |                              |
 |<-----------------------------|                              |                              |
 |    reconstructSignedTx       |                              |                              |
 |    eth_sendRawTransaction    |                              |                              |
 |----------------------------------------------------------------------------- sweep tx ---->|
 |                              |                              |  (deposit addr → vault addr) |
 |<---------------------------------------------------------------------------- receipt ------|
 |                              |                              |                              |
 |                              |                              | 9. polls Sepolia             |
 |                              |                              |    (knows expected           |
 |                              |                              |     sweep tx hash)           |
 |                              |                              |                              |
 |                              |                              |--- getTransactionReceipt --->|
 |                              |                              |<-----------------------------|
 |                              |                              |    verify receipt.status     |
 |                              |                              |                              |
 |                              |                              | 10. ProvideEvmOutcomeSig     |
 |                              |<--- EvmTxOutcomeSignature ---|                              |
 |                              |    (signature, mpcOutput)    |                              |
 |                              |                              |                              |
 | 11. observes EvmTxOutcomeSig |                              |                              |
 |<-----------------------------|                              |                              |
 |    ClaimEvmDeposit           |                              |                              |
 |-- pending, outcome, ecdsa -->|                              |                              |
 |                              |                              |                              |
 |                              | 12. archive PendingEvmTx     |                              |
 |                              |     archive EvmTxOutcomeSig  |                              |
 |                              |     archive EcdsaSignature   |                              |
 |                              |                              |                              |
 |                              |     creates Erc20Holding     |                              |
 |                              |                              |                              |
 |<------- Erc20Holding --------|                              |                              |
 |                              |                              |                              |
```

## Daml Contracts

### `VaultOrchestrator` (Erc20Vault.daml)

Singleton orchestrator contract. Hosts all choices that drive the deposit
lifecycle. All evidence contracts (`EcdsaSignature`,
`EvmTxOutcomeSignature`) and state contracts (`PendingEvmTx`,
`Erc20Holding`) are created through its choices. Its `created_event_blob`
is disclosed off-chain so that users can attach it to command submissions

```daml
template VaultOrchestrator
  with
    issuer       : Party          -- the party that operates the vault
    mpc          : Party          -- the MPC signing service party
    mpcPublicKey : PublicKeyHex   -- MPC root public key for signature verification
    vaultAddress : BytesHex       -- centralized sweep address (derived from MPC root key + vault derivation path)
    vaultId      : Text           -- issuer-controlled discriminator for MPC key derivation
  where
    signatory issuer
    observer mpc

    nonconsuming choice RequestDepositAuth   : ContractId DepositAuthProposal
    nonconsuming choice ApproveDepositAuth   : ContractId DepositAuthorization
    nonconsuming choice RequestEvmDeposit    : ContractId PendingEvmTx
    nonconsuming choice SignEvmTx            : ContractId EcdsaSignature
    nonconsuming choice ProvideEvmOutcomeSig : ContractId EvmTxOutcomeSignature
    nonconsuming choice ClaimEvmDeposit      : ContractId Erc20Holding
```

### `EvmTransactionParams` (Types.daml)

Generic EIP-1559 transaction parameters. The MPC is transaction-type agnostic
— it signs any Type 2 transaction. The contract stores the function signature
and args separately, giving Daml visibility into the EVM call for on-chain
authorization.

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

The MPC reconstruct calldata deterministically from
`functionSignature` + `args`.

### `DepositAuthProposal` (Erc20Vault.daml)

User's request for an authorization card — the "propose" half of Daml's
Propose and Accept pattern. The issuer approves or ignores it.

```daml
template DepositAuthProposal
  with
    issuer : Party
    owner  : Party
  where
    signatory issuer
    observer owner
```

### `DepositAuthorization` (Erc20Vault.daml)

Authorization card with a hard use-limit, following the Daml Authorization
Pattern with an archive-and-recreate counter — each deposit consumes the card
and recreates it with decremented uses, providing application-level rate
limiting for nonconsuming choices on `VaultOrchestrator`. The consumed card's
`contractId` doubles as a natural nonce for `requestId` (globally unique,
cryptographically generated by Canton, consumed exactly once). The issuer can
issue multiple cards to the same user enabling higher throughput; each is an
independent contract.

```daml
template DepositAuthorization
  with
    issuer        : Party
    mpc           : Party
    owner         : Party
    remainingUses : Int
  where
    signatory issuer
    observer mpc, owner
```

### `TxSource` (Types.daml)

Variant that doubles as **type discriminator** and **provenance CID** for
`PendingEvmTx`. Tells finalization choices which flow the transaction belongs
to, while preserving a type-safe reference to the consumed source contract.

```daml
data TxSource
  = DepositSource (ContractId DepositAuthorization)
  | WithdrawalSource (ContractId Erc20Holding)
  deriving (Eq, Show)
```

### `PendingEvmTx` (Erc20Vault.daml)

Anchor contract for both deposit and withdrawal lifecycles. The MPC service
observes this single template regardless of flow — it reads `evmParams`,
`path`, `vaultId`, `issuer` and signs.

```daml
template PendingEvmTx
  with
    issuer       : Party        -- the party that operates the vault
    requester    : Party        -- the user initiating the transaction
    mpc          : Party        -- the MPC signing service party
    requestId    : BytesHex
    path         : Text         -- deposit: sender + "," + userPath; withdrawal: "root"
    evmParams    : EvmTransactionParams
    vaultId      : Text         -- issuer-controlled discriminator (from VaultOrchestrator)
    nonceCidText : Text         -- user-supplied, source contractId as text (nonce for requestId)
    source       : TxSource     -- discriminator + typed provenance CID
    keyVersion   : Int          -- e.g., 1
    algo         : Text         -- e.g., "ECDSA"
    dest         : Text         -- e.g., "ethereum"
  where
    signatory issuer
    observer mpc, requester
```

`PendingEvmTx` carries two nonce references:

- **`nonceCidText : Text`** — user-supplied string form of the consumed
  contract ID (`DepositAuthorization` for deposits, `Erc20Holding` for
  withdrawals). Input to `computeRequestId`; globally unique per use
  (archive + recreate), guaranteeing `requestId` uniqueness.

- **`source : TxSource`** — variant carrying the typed `ContractId`,
  injected by `VaultOrchestrator` after fetch + validation. Non-spoofable;
  MPC reads it directly from the contract payload.

**Key derivation (predecessorId + path):** `predecessorId = vaultId + issuer`
(`vaultId` is the issuer-controlled discriminator, concatenated with the issuer
party identifier). This ensures different vaults never control the same EVM
address via the MPC KDF. The MPC reads both `vaultId` and `issuer` directly
from the `PendingEvmTx` payload.
The `vaultId` is set once on `VaultOrchestrator` at deployment and is immutable,
allowing the same issuer to run multiple independent vaults with different
keyspaces.

- **Vault address**: path = `"root"`
- **Deposit address**: path = `sender + "," + user-supplied path argument`

### `EcdsaSignature` (Erc20Vault.daml)

MPC's EVM transaction signature.

```daml
template EcdsaSignature
  with
    issuer    : Party
    requester : Party
    requestId : BytesHex
    r         : BytesHex              -- 32 bytes
    s         : BytesHex              -- 32 bytes
    v         : Int                   -- recovery id (0 or 1)
  where
    signatory issuer
    observer requester
```

### `EvmTxOutcomeSignature` (Erc20Vault.daml)

MPC's attestation of the ETH transaction outcome. Contains a
`secp256k1` signature over the EIP-712 response hash of `(requestId, mpcOutput)`
— verified cryptographically against `mpcPublicKey` in the `ClaimEvmDeposit` choice.

```daml
template EvmTxOutcomeSignature
  with
    issuer    : Party
    requester : Party
    requestId : BytesHex
    signature : SignatureHex   -- secp256k1 over EIP-712 response hash of (requestId, mpcOutput)
    mpcOutput : BytesHex       -- "01" = success
  where
    signatory issuer
    observer requester
```

### `Erc20Holding` (Erc20Vault.daml)

Final state — represents a user's ownership of wrapped ERC-20 tokens on Canton.

```daml
template Erc20Holding
  with
    issuer       : Party
    owner        : Party
    erc20Address : BytesHex
    amount       : BytesHex    -- raw uint256, e.g. 1e18 base units
  where
    signatory issuer
    observer owner
```

### Choices on `VaultOrchestrator`

**`RequestDepositAuth`** — user requests an authorization card.

```daml
nonconsuming choice RequestDepositAuth : ContractId DepositAuthProposal
  with requester : Party
  controller requester
  do create DepositAuthProposal with issuer; owner = requester
```

**`ApproveDepositAuth`** — issuer approves the request, creating an auth card
with a hard use-limit.

```daml
nonconsuming choice ApproveDepositAuth : ContractId DepositAuthorization
  with
    proposalCid   : ContractId DepositAuthProposal
    remainingUses : Int
  controller issuer
  do
    proposal <- fetch proposalCid
    assertMsg "Proposal issuer mismatch" (proposal.issuer == issuer)
    archive proposalCid
    create DepositAuthorization with
      issuer; mpc; owner = proposal.owner; remainingUses
```

**`RequestEvmDeposit`** — user creates a deposit request.

```daml
nonconsuming choice RequestEvmDeposit : ContractId PendingEvmTx
  with
    requester      : Party
    path           : Text
    evmParams      : EvmTransactionParams
    authCidText    : Text       -- user-supplied, DepositAuthorization contractId as text (nonce)
    keyVersion     : Int
    algo           : Text
    dest           : Text
    authCid        : ContractId DepositAuthorization
  controller requester
  do
    auth <- fetch authCid
    assertMsg "Auth card issuer mismatch" (auth.issuer == issuer)
    assertMsg "Auth card owner mismatch" (auth.owner == requester)
    assertMsg "Auth card has no remaining uses" (auth.remainingUses > 0)
    archive authCid
    when (auth.remainingUses > 1) do
      void $ create auth with remainingUses = auth.remainingUses - 1

    let recipientArg = case evmParams.args of
          recipient :: _ -> recipient
          [] -> ""

    assertMsg "Only ERC20 transfer allowed"
      (evmParams.functionSignature == "transfer(address,uint256)")
    assertMsg "Transfer recipient must be vault address"
      (recipientArg == vaultAddress)

    let sender = partyToText requester
    let fullPath = sender <> "," <> path
    let caip2Id = "eip155:" <> chainIdToDecimalText evmParams.chainId
    let requestId = computeRequestId sender evmParams caip2Id keyVersion fullPath algo dest authCidText
    create PendingEvmTx with
      issuer; requester; mpc; requestId; path = fullPath; evmParams
      vaultId; nonceCidText = authCidText; source = DepositSource authCid
      keyVersion; algo; dest
```

**`SignEvmTx`** — MPC posts its EVM transaction signature.

```daml
nonconsuming choice SignEvmTx : ContractId EcdsaSignature
  with
    requester : Party
    requestId : BytesHex
    r         : BytesHex
    s         : BytesHex
    v         : Int
  controller issuer
  do
    create EcdsaSignature with
      issuer; requester; requestId; r; s; v
```

**`ProvideEvmOutcomeSig`** — MPC posts the ETH receipt verification proof.

```daml
nonconsuming choice ProvideEvmOutcomeSig : ContractId EvmTxOutcomeSignature
  with
    requester : Party
    requestId : BytesHex
    signature : SignatureHex
    mpcOutput : BytesHex
  controller issuer
  do
    create EvmTxOutcomeSignature with
      issuer; requester; requestId; signature; mpcOutput
```

**`ClaimEvmDeposit`** — user triggers claim after observing the outcome
signature. Asserts `DepositSource` and archives all evidence contracts
(`PendingEvmTx`, `EvmTxOutcomeSignature`, `EcdsaSignature`).

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
    outcome <- fetch outcomeCid
    ecdsa   <- fetch ecdsaCid

    case pending.source of
      DepositSource _ -> pure ()
      _ -> abort "PendingEvmTx is not a deposit"

    assertMsg "Pending issuer mismatch"
      (pending.issuer == issuer)
    assertMsg "Outcome issuer mismatch"
      (outcome.issuer == issuer)

    assertMsg "Requester mismatch"
      (pending.requester == requester)

    assertMsg "Request ID mismatch"
      (pending.requestId == outcome.requestId)

    assertMsg "MPC reported ETH transaction failure"
      (outcome.mpcOutput == "01")

    let responseHash = computeResponseHash pending.requestId outcome.mpcOutput
    assertMsg "Invalid MPC signature on deposit response"
      (secp256k1WithEcdsaOnly outcome.signature responseHash mpcPublicKey)

    let amount = (pending.evmParams).args !! 1

    archive pendingCid
    archive outcomeCid
    archive ecdsaCid

    create Erc20Holding with
      issuer
      owner = pending.requester
      erc20Address = (pending.evmParams).to
      amount
```

### Crypto Functions (Crypto.daml)

All hashing uses EIP-712 typed data (domain `"CantonMpc"`, version `"1"`).

```daml
hashEvmParams : EvmTransactionParams -> BytesHex
hashEvmParams p =
  keccak256 $
       evmParamsTypeHash
    <> padHex p.to 32
    <> hashText p.functionSignature
    <> hashBytesList p.args
    <> padHex p.value          32
    <> padHex p.nonce          32
    <> padHex p.gasLimit       32
    <> padHex p.maxFeePerGas   32
    <> padHex p.maxPriorityFee 32
    <> padHex p.chainId        32

computeRequestId : Text -> EvmTransactionParams -> Text -> Int -> Text -> Text -> Text -> Text -> BytesHex
computeRequestId sender evmParams caip2Id keyVersion path algo dest authCidText =
  eip712Hash $ keccak256 $
       requestTypeHash
    <> hashText sender
    <> hashEvmParams evmParams
    <> hashText caip2Id
    <> padHex (toHex keyVersion) 32
    <> hashText path
    <> hashText algo
    <> hashText dest
    <> hashText authCidText

computeResponseHash : BytesHex -> BytesHex -> BytesHex
computeResponseHash requestId output =
  eip712Hash $ keccak256 (responseTypeHash <> padHex requestId 32 <> safeKeccak256 output)
```

## Open Questions

1. **Signatory / observer roles per choice — can the user act independently?**
   Can the user request and claim on their own (i.e., `controller requester`
   without `issuer` as co-controller)?

2. **VaultOrchestrator signatory model — single party or multi-party?**
   Should `VaultOrchestrator` remain a single-signatory template (`signatory issuer`)
   or become multi-party (e.g., `signatory issuer, mpc`)? A multi-party signatory
   would require both parties to agree on creation and any consuming choices,
   adding stronger trust guarantees but increasing coordination overhead.

3. **ERC20 `transfer` only, or other EVM call types?**
   The current design restricts `RequestEvmDeposit` to `transfer(address,uint256)`
   and treats `mpcOutput` as a simple status byte (`"01"` = success). Supporting
   other function signatures (e.g., `swap`, `mint`, arbitrary contract calls)
   would require Daml to interpret structured return values — which means either
   an ABI decoder in Daml or EIP-712-style hashing of the decoded output fields
   (see `computeRequestId` for the existing pattern). Is ERC20 transfer
   sufficient for the foreseeable scope, and if not, when are other call types
   expected?

4. **Expected throughput per second on foreign chains?**
   What is the target transaction throughput per second on external chains
   (e.g., Sepolia / Ethereum mainnet)?
