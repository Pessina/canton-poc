# EVM Deposit Architecture: Canton MPC PoC

ERC20 deposit flow from an EVM chain (Sepolia) into Canton, with two actors:
the user (initiator + submitter) and the MPC service (Sig Network signer).
The MPC never writes to Ethereum.

## What the Demo Does

1. User deposits ERC20 tokens into a **Sig Network controlled deposit address**
   (derived from the MPC root public key + user-specific derivation path)
2. User triggers a Canton request to **move funds from the deposit address to a
   centralized vault address** via an ERC20 `transfer` call
3. The **Sig Network (MPC) observes** the request on Canton, signs the EVM
   transaction, and independently verifies the Sepolia outcome
4. User submits the signed transaction to Sepolia and claims the deposit on
   Canton once the MPC confirms success

The result: an `Erc20Holding` contract on Canton representing the user's
wrapped ERC-20 balance.

## Deposit Lifecycle

```
 User                           Canton                         MPC Service                    Sepolia
 |                              |                              |                              |
 | RequestEvmDeposit            |                              |                              |
 | (evmParams, path)            |                              |                              |
 |----------------------------->|                              |                              |
 |                              |                              |                              |
 |                              | creates PendingEvmDeposit    |                              |
 |                              | (path, evmParams,            |                              |
 |                              |  requester = predecessorId)  |                              |
 |                              |                              |                              |
 |                              | observes PendingEvmDeposit   |                              |
 |                              |----------------------------->|                              |
 |                              |                              |                              |
 |                              |                              | buildCalldata                |
 |                              |                              | serializeTx                  |
 |                              |                              | keccak256 -> txHash          |
 |                              |                              | deriveChildKey               |
 |                              |                              | sign(txHash)                 |
 |                              |                              |                              |
 |                              | SignEvmTx                    |                              |
 |                              |<------ EcdsaSignature -------|                              |
 |                              | (r, s, v)                    |                              |
 |                              |                              |                              |
 | observes EcdsaSignature      |                              |                              |
 |<-----------------------------|                              |                              |
 |                              |                              |                              |
 | reconstructSignedTx          |                              |                              |
 |--------------------------------- eth_sendRawTransaction ---------------------------------->|
 |<----------------------------------------- receipt -----------------------------------------|
 |                              |                              |                              |
 |                              |                              | polls Sepolia                |
 |                              |                              | (knows expected              |
 |                              |                              |  signed tx hash)             |
 |                              |                              |                              |
 |                              |                              |--- getTransactionReceipt --->|
 |                              |                              |<-----------------------------|
 |                              |                              |                              |
 |                              |                              | verify receipt.status        |
 |                              |                              | sign outcome                 |
 |                              |                              |                              |
 |                              | ProvideEvmOutcomeSig         |                              |
 |                              |<--- EvmTxOutcomeSignature ---|                              |
 |                              | (DER signature, mpcOutput)   |                              |
 |                              |                              |                              |
 | observes EvmTxOutcomeSig     |                              |                              |
 |<-----------------------------|                              |                              |
 |                              |                              |                              |
 | ClaimEvmDeposit              |                              |                              |
 |-- pending, outcome, ecdsa ->|                              |                              |
 |                              |                              |                              |
 |                              | verify MPC signature         |                              |
 |                              | archive PendingEvmDeposit    |                              |
 |                              | archive EvmTxOutcomeSig      |                              |
 |                              | archive EcdsaSignature       |                              |
 |                              |                              |                              |
 |                              | creates Erc20Holding         |                              |
 |                              |                              |                              |
 |<------- Erc20Holding --------|                              |                              |
 | assert balance               |                              |                              |
 |                              |                              |                              |
```

## Daml Contracts

### `VaultOrchestrator` (Erc20Vault.daml)

Singleton orchestrator contract. Owns the MPC public key and hosts all choices
that drive the deposit lifecycle. All evidence contracts (`EcdsaSignature`,
`EvmTxOutcomeSignature`) and state contracts (`PendingEvmDeposit`,
`Erc20Holding`) are created through its choices.

```daml
template VaultOrchestrator
  with
    issuer       : Party          -- the party that operates the vault
    mpcPublicKey : PublicKeyHex   -- SPKI-encoded secp256k1 public key
    vaultAddress : BytesHex       -- centralized sweep address (derived from MPC root key + "root" path)
  where
    signatory issuer

    nonconsuming choice RequestEvmDeposit    : ContractId PendingEvmDeposit
    nonconsuming choice SignEvmTx            : ContractId EcdsaSignature
    nonconsuming choice ProvideEvmOutcomeSig : ContractId EvmTxOutcomeSignature
    nonconsuming choice ClaimEvmDeposit      : ContractId Erc20Holding
```

`mpcPublicKey` is set once at creation and used by `ClaimEvmDeposit` to verify
the MPC's DER signature via `secp256k1WithEcdsaOnly`. `vaultAddress` is the
centralized sweep address (derived from MPC root key + `"root"` path) —
`RequestEvmDeposit` validates that the transfer recipient (`args[0]`) matches
this address, ensuring all deposits are swept to the vault.

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

The MPC and user reconstruct calldata deterministically from
`functionSignature` + `args`. `RequestEvmDeposit` validates the function
signature and that the transfer recipient (`args[0]`) is the vault sweep
address (see choice below).

### `PendingEvmDeposit` (Erc20Vault.daml)

Anchor contract for the deposit lifecycle. The MPC reads `requester` and uses
it as the `predecessorId` for key derivation — authenticated by Canton's
`controller` requirement and cannot be spoofed.

The `caip2Id` is derived on-chain from `evmParams.chainId` as
`"eip155:" <> chainIdToDecimalText evmParams.chainId`.

```daml
template PendingEvmDeposit
  with
    issuer    : Party
    requester : Party        -- MPC uses as predecessorId for key derivation
    requestId : BytesHex
    path      : Text         -- user-supplied derivation sub-path
    evmParams : EvmTransactionParams
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

MPC's attestation of the ETH transaction outcome. DER-encoded signature
verifiable on-chain with `secp256k1WithEcdsaOnly` against
`VaultOrchestrator.mpcPublicKey`.

```daml
template EvmTxOutcomeSignature
  with
    issuer    : Party
    requestId : BytesHex
    signature : SignatureHex   -- DER-encoded secp256k1
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
    requester : Party
    path      : Text
    evmParams : EvmTransactionParams
  controller issuer, requester
  do
    assertMsg "Only ERC20 transfer allowed"
      (evmParams.functionSignature == "transfer(address,uint256)")
    assertMsg "Transfer recipient must be vault address"
      (evmParams.args !! 0 == vaultAddress)

    let sender = partyToText requester
    let caip2Id = "eip155:" <> chainIdToDecimalText evmParams.chainId
    let requestId = computeRequestId sender evmParams caip2Id 1 path
    create PendingEvmDeposit with
      issuer; requester; requestId; path; evmParams
```

`keyVersion = 1` is hardcoded. `algo`, `dest`, `params` are hardcoded inside
`computeRequestId` (`"ECDSA"`, `"ethereum"`, `""`).

**PackageId in the derivation path:** The `sender` used above is `partyToText
requester`. In production, both the user and MPC prepend the packageId:
`sender = "{packageId}:{partyId}"`. The packageId is not accessible inside Daml
(no built-in function exists), but every Canton ledger event includes it in the
`templateId` field (`"{packageId}:{module}:{template}"`). Both sides extract it
from the `PendingEvmDeposit` created event via `event.templateId.split(":")[0]`
and inject it into the predecessorId automatically — no Daml contract changes
needed. Validated in `PackageIdPoc.daml` and `package-id-poc.test.ts`.

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

The MPC computes `requestId` itself via the same derivation formula.

**`ProvideEvmOutcomeSig`** — MPC posts the ETH receipt verification proof.

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

**`ClaimEvmDeposit`** — user triggers claim after observing the outcome
signature. Also archives `EcdsaSignature` for ledger cleanup.

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
    <> textToHex p.functionSignature
    <> foldl (<>) "" p.args
    <> padHex p.value          32
    <> padHex p.nonce          32
    <> padHex p.gasLimit       32
    <> padHex p.maxFeePerGas   32
    <> padHex p.maxPriorityFee 32
    <> padHex p.chainId        32

-- | Request ID = keccak256(encodePacked(sender, payload, caip2Id,
-- keyVersion, path, algo, dest, params)).
computeRequestId : Text -> EvmTransactionParams -> Text -> Int -> Text -> BytesHex
computeRequestId sender evmParams caip2Id keyVersion path =
  let payload = packParams evmParams
  in keccak256
    ( textToHex sender
      <> payload
      <> textToHex caip2Id
      <> uint32ToHex keyVersion
      <> textToHex path
      <> textToHex "ECDSA"
      <> textToHex "ethereum"
    )
```

## TypeScript Services

### MPC Service (`client/src/mpc-service/`)

Canton equivalent of Solana's `fakenet-signer`. Runs as a standalone process.
Uses viem for EVM transaction serialization — never fetches nonce, gas, or any
state from Sepolia during signing. Only reads Sepolia for receipt verification.

**deposit-handler.ts** — PendingEvmDeposit watcher:

```
On PendingEvmDeposit created:

  Phase 1: Sign the EVM transaction
    1. Read: requester, path, evmParams, requestId, contractId
       Derive: caip2Id = "eip155:" + decimal(evmParams.chainId)
    2. Reconstruct calldata: selector(functionSignature) || abiEncode(args)
    3. Serialize unsigned EVM tx from evmParams + calldata (viem serializeTransaction)
    4. Compute tx hash: keccak256(serializedUnsigned)
    5. Derive child private key
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
    14. Sign responseHash with root private key -> DER signature
    15. Exercise ProvideEvmOutcomeSig(requestId, signature, mpcOutput)
        -> creates EvmTxOutcomeSignature on Canton
```

### User Flow (`client/src/scripts/demo.ts`)

The user drives the deposit end-to-end: creates the request, submits
the signed transaction to Sepolia, and claims the deposit on Canton.

```
1. Derive deposit address from MPC public key + user path
2. Derive vault (centralized) address from MPC public key + "root" path
3. Build evmParams: to=ERC20 contract, args=[vaultAddr, amount] (transfer call)
4. Exercise RequestEvmDeposit(requester, path, evmParams)
   -> creates PendingEvmDeposit on Canton
5. Observe EcdsaSignature (MPC signs autonomously)
6. Reconstruct signed EVM tx from evmParams + (r, s, v)
7. Submit to Sepolia: eth_sendRawTransaction
8. Observe EvmTxOutcomeSignature (MPC verifies receipt autonomously)
9. Exercise ClaimEvmDeposit(pendingCid, outcomeCid, ecdsaCid)
   -> verifies MPC sig on-chain, archives all evidence, creates Erc20Holding
10. Assert Erc20Holding balance matches deposit amount
```

## Design Decisions

### requestId Uniqueness / Double-Claim Prevention

Without unique `requestId`s, a user can create duplicate `PendingEvmDeposit`
contracts (same requester, path, evmParams). The MPC would sign once, but
additional outcome signatures could be issued for the remaining pendings,
minting more `Erc20Holding` than was actually deposited on-chain.

Daml contract IDs are opaque (not serializable) and Daml provides no randomness,
so neither can serve as a uniqueness source. Two approaches:

**Option A: Nonce on VaultOrchestrator (MPC stays off-chain)**

Add a `nonce : Int` to `VaultOrchestrator`. `RequestEvmDeposit` becomes
consuming — atomically increments the nonce, includes it in `requestId`, and
recreates the orchestrator. Multiple orchestrator instances can exist for
throughput (each with its own nonce space). Other choices remain nonconsuming.

```daml
template VaultOrchestrator
  with
    issuer : Party; mpcPublicKey : PublicKeyHex
    vaultAddress : BytesHex; nonce : Int
  where signatory issuer

    choice RequestEvmDeposit : (ContractId VaultOrchestrator, ContractId PendingEvmDeposit)
      with requester : Party; path : Text; evmParams : EvmTransactionParams
      controller issuer, requester
      do -- ... validation, requestId includes nonce ...
         pendingCid <- create PendingEvmDeposit with ...
         orchCid <- create this with nonce = nonce + 1
         pure (orchCid, pendingCid)
    -- SignEvmTx, ProvideEvmOutcomeSig, ClaimEvmDeposit remain nonconsuming
```

- **Pro:** MPC stays off-chain. On-chain sig verification via
  `secp256k1WithEcdsaOnly`.
- **Con:** Consuming choice serializes requests per orchestrator instance.

**Option B: MPC as External Party**

MPC becomes a Canton "external party" that signs Canton transactions directly.
No `secp256k1WithEcdsaOnly` needed in Daml — Canton validates the MPC's identity
through its transaction signature. Simpler Daml, but MPC must handle Canton
transaction serialization and manage Canton party keys alongside secp256k1 keys.

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
    requester : Party
    path      : Text
    evmParams : EvmTransactionParams
    authCid   : ContractId DepositAuthorization
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
    let requestId = computeRequestId (partyToText requester) evmParams caip2Id 1 path
    create PendingEvmDeposit with issuer; requester; requestId; path; evmParams
```

**Alternative: Propose and Accept.** Instead of the issuer pushing cards, the
user creates a `DepositAuthProposal` and the issuer's backend accepts or ignores
it — combining the Authorization Pattern with the [Propose and Accept
Pattern](https://docs.digitalasset.com/build/3.4/sdlc-howtos/smart-contracts/develop/patterns/propose-accept.html).

**Properties:** unforgeable (`signatory issuer`), self-enforcing (counter
decrements on-ledger), revocable (issuer archives the token), MPC-safe (only
valid `PendingEvmDeposit` contracts reach the MPC).
