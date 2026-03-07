# EVM Deposit Architecture: Canton MPC PoC

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

## Deposit Lifecycle

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

## Daml Contracts

### `VaultOrchestrator` (Erc20Vault.daml)

Singleton orchestrator contract. Hosts all choices that drive the deposit
lifecycle. All evidence contracts (`EcdsaSignature`,
`EvmTxOutcomeSignature`) and state contracts (`PendingEvmDeposit`,
`Erc20Holding`) are created through its choices.

```daml
template VaultOrchestrator
  with
    issuer       : Party          -- the party that operates the vault
    mpcPublicKey : PublicKeyHex   -- MPC root public key for signature verification
    vaultAddress : BytesHex       -- centralized sweep address (derived from MPC root key + vault derivation path)
  where
    signatory issuer

    nonconsuming choice RequestEvmDeposit    : ContractId PendingEvmDeposit
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

### `PendingEvmDeposit` (Erc20Vault.daml)

Anchor contract for the deposit lifecycle.

```daml
template PendingEvmDeposit
  with
    issuer     : Party        -- the party that operates the vault
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

### `EcdsaSignature` (Erc20Vault.daml)

MPC's EVM transaction signature.

```daml
template EcdsaSignature
  with
    issuer    : Party
    requestId : BytesHex
    r         : BytesHex              -- 32 bytes
    s         : BytesHex              -- 32 bytes
    v         : Int                   -- recovery id (0 or 1)
  where
    signatory issuer
```

### `EvmTxOutcomeSignature` (Erc20Vault.daml)

MPC's attestation of the ETH transaction outcome. Contains a
`secp256k1` signature over `keccak256(requestId || mpcOutput)` — verified
cryptographically against `mpcPublicKey` in the `ClaimEvmDeposit` choice.

```daml
template EvmTxOutcomeSignature
  with
    issuer    : Party
    requestId : BytesHex
    signature : SignatureHex   -- secp256k1 over keccak256(requestId || mpcOutput)
    mpcOutput : BytesHex       -- "01" = success
  where
    signatory issuer
```

### `Erc20Holding` (Erc20Vault.daml)

Final state — represents a user's ownership of wrapped ERC-20 tokens on Canton.

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

### Choices on `VaultOrchestrator`

**`RequestEvmDeposit`** — user creates a deposit request.

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
  controller issuer, requester
  do
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

The MPC
cross-checks the user-supplied `contractId` against the VaultOrchestrator's
`CreatedEvent.contractId` from the ledger; if mismatched, the request is
dropped. Since `contractId` is globally unique per VaultOrchestrator instance,
it feeds into both key derivation and `computeRequestId` — different
VaultOrchestrator instances produce unique deposit
addresses and unique requestIds with no collision.
**Key derivation (predecessorId + path):** For `deriveChildPublicKey`, the MPC
and user use:

- **predecessorId** = contractId (VaultOrchestrator's contractId)
- **path** = requester + user-supplied `path` argument

**`SignEvmTx`** — MPC posts its EVM transaction signature.

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

**`ProvideEvmOutcomeSig`** — MPC posts the ETH receipt verification proof.

```daml
nonconsuming choice ProvideEvmOutcomeSig : ContractId EvmTxOutcomeSignature
  with
    requestId : BytesHex
    signature : SignatureHex
    mpcOutput : BytesHex
  controller issuer
  do
    create EvmTxOutcomeSignature with
      issuer; requestId; signature; mpcOutput
```

**`ClaimEvmDeposit`** — user triggers claim after observing the outcome
signature. Archives all evidence contracts (`PendingEvmDeposit`,
`EvmTxOutcomeSignature`, `EcdsaSignature`). Since the MPC creates exactly one
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
      erc20Address = (pending.evmParams).to
      amount
```

### Crypto Functions (Crypto.daml)

```daml
-- | abi_encode_packed equivalent for EVM transaction fields.
packParams : EvmTransactionParams -> BytesHex
packParams p =
  padHex p.to 20
    <> toHex p.functionSignature
    <> foldl (<>) "" p.args
    <> padHex p.value          32
    <> padHex p.nonce          32
    <> padHex p.gasLimit       32
    <> padHex p.maxFeePerGas   32
    <> padHex p.maxPriorityFee 32
    <> padHex p.chainId        32

-- | Request ID = keccak256(encodePacked(sender, payload, caip2Id,
-- keyVersion, path, algo, dest, contractId)).
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
```

## TypeScript Services

### MPC Service (`client/src/mpc-service/`)

Canton equivalent of Solana's `fakenet-signer`. Runs as a standalone process.
Uses viem for EVM transaction serialization — never fetches nonce, gas, or any
state from Sepolia during signing. Only reads Sepolia for receipt verification.

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
    6. Sign tx hash with child private key -> { r, s, v }
    7. Exercise SignEvmTx(requestId, r, s, v)
       -> creates EcdsaSignature on Canton

  Phase 2: Verify ETH outcome (independent of user)
    8. Reconstruct signed tx from evmParams + calldata + r, s, v
    9. Compute expected signed tx hash: keccak256(signedSerialized)
    10. Poll Sepolia for receipt by tx hash (the user submits independently)
    11. Verify receipt.status === 1
    12. mpcOutput = "01" (success)
    13. responseHash = keccak256(requestId || mpcOutput)
    14. Sign responseHash with MPC root key -> signature (DER-encoded secp256k1)
    15. Exercise ProvideEvmOutcomeSig(requestId, signature, mpcOutput)
        -> creates EvmTxOutcomeSignature on Canton
```

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
   -> creates PendingEvmDeposit on Canton (includes contractId for MPC verification)
6. Observe EcdsaSignature (MPC signs autonomously)
7. Reconstruct signed EVM tx from evmParams + (r, s, v)
8. Submit to Sepolia: eth_sendRawTransaction
9. Observe EvmTxOutcomeSignature (MPC verifies receipt autonomously)
10. Exercise ClaimEvmDeposit(pendingCid, outcomeCid, ecdsaCid)
    -> verifies MPC sig on-chain, archives all evidence, creates Erc20Holding
11. Assert Erc20Holding balance matches deposit amount
```

## Design Decisions

### DDoS Prevention: Authorization Pattern

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

`RequestEvmDeposit` validates and burns one use:

```daml
nonconsuming choice RequestEvmDeposit : ContractId PendingEvmDeposit
  with
    requester  : Party
    path       : Text
    evmParams  : EvmTransactionParams
    contractId : Text
    keyVersion : Int
    algo       : Text
    dest       : Text
    authCid    : ContractId DepositAuthorization
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

    let caip2Id = "eip155:" <> chainIdToDecimalText evmParams.chainId
    let requestId = computeRequestId (partyToText requester) evmParams caip2Id keyVersion path algo dest contractId
    create PendingEvmDeposit with issuer; requester; requestId; path; evmParams; contractId; keyVersion; algo; dest
```

**Alternative: Propose and Accept.** Instead of the issuer pushing cards, the
user creates a `DepositAuthProposal` and the issuer's backend accepts or ignores
it — combining the Authorization Pattern with the [Propose and Accept
Pattern](https://docs.digitalasset.com/build/3.4/sdlc-howtos/smart-contracts/develop/patterns/propose-accept.html).

**Properties:** unforgeable (`signatory issuer`), self-enforcing (counter
decrements on-ledger), revocable (issuer archives the token), MPC-safe (only
valid `PendingEvmDeposit` contracts reach the MPC).
