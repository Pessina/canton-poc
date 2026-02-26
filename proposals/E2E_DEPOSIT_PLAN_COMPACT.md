# EVM Deposit Architecture: Canton MPC PoC

ERC20 deposit flow from an EVM chain (Sepolia) into Canton, with three
autonomous actors: the test (initiator), MPC service (signer), and relayer
(submitter). The MPC never writes to Ethereum; the relayer holds no private
keys.

## Deposit Lifecycle

```
 Test                    Canton                        MPC Service                    Relayer                    Sepolia
  │                        │                               │                            │                          │
  │  RequestEvmDeposit     │                               │                            │                          │
  │  (evmParams, path)     │                               │                            │                          │
  ├───────────────────────►│                               │                            │                          │
  │                        │                               │                            │                          │
  │                        │ creates PendingEvmDeposit     │                            │                          │
  │                        │ (path, evmParams,             │                            │                          │
  │                        │  requester = predecessorId)   │                            │                          │
  │                        │                               │                            │                          │
  │                        │  observes PendingEvmDeposit   │                            │                          │
  │                        │──────────────────────────────►│                            │                          │
  │                        │                               │                            │                          │
  │                        │                               │ buildCalldata              │                          │
  │                        │                               │ serializeTx                │                          │
  │                        │                               │ keccak256 → txHash         │                          │
  │                        │                               │ deriveChildKey             │                          │
  │                        │                               │ sign(txHash)               │                          │
  │                        │                               │                            │                          │
  │                        │         SignEvmTx             │                            │                          │
  │                        │◄───── EcdsaSignature ─────────┤                            │                          │
  │                        │       (r, s, v)               │                            │                          │
  │                        │                               │                            │                          │
  │                        │    observes EcdsaSignature    │                            │                          │
  │                        │───────────────────────────────────────────────────────────►│                          │
  │                        │                               │                            │                          │
  │                        │                               │                            │ reconstructSignedTx      │
  │                        │                               │                            ├── eth_sendRawTx ────────►│
  │                        │                               │                            │◄── receipt ──────────────┤
  │                        │                               │                            │                          │
  │                        │                               │ polls Sepolia              │                          │
  │                        │                               │ (knows expected            │                          │
  │                        │                               │  signed tx hash)           │                          │
  │                        │                               │                            │                          │
  │                        │                               ├──── getTransactionReceipt ─┼─────────────────────────►│
  │                        │                               │◄───────────────────────────┼──────────────────────────┤
  │                        │                               │                            │                          │
  │                        │                               │ verify receipt.status      │                          │
  │                        │                               │ sign outcome               │                          │
  │                        │                               │                            │                          │
  │                        │  ProvideEvmOutcomeSig         │                            │                          │
  │                        │◄── EvmTxOutcomeSignature ─────┤                            │                          │
  │                        │    (DER signature, mpcOutput) │                            │                          │
  │                        │                               │                            │                          │
  │                        │ observes EvmTxOutcomeSignature│                            │                          │
  │                        │───────────────────────────────────────────────────────────►│                          │
  │                        │                               │                            │                          │
  │                        │                               │    ClaimEvmDeposit         │                          │
  │                        │◄──────────────────────────────┼── (pendingCid, outcomeCid)─┤                          │
  │                        │                               │                            │                          │
  │                        │ verify MPC signature          │                            │                          │
  │                        │ archive PendingEvmDeposit     │                            │                          │
  │                        │ archive EvmTxOutcomeSignature │                            │                          │
  │                        │                               │                            │                          │
  │                        ├── creates Erc20Holding        │                            │                          │
  │                        │                               │                            │                          │
  │── poll ───────────────►│                               │                            │                          │
  │◄── Erc20Holding ───────┤                               │                            │                          │
  │  assert balance        │                               │                            │                          │
  │                        │                               │                            │                          │
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
  where
    signatory issuer

    nonconsuming choice RequestEvmDeposit    : ContractId PendingEvmDeposit
    nonconsuming choice SignEvmTx            : ContractId EcdsaSignature
    nonconsuming choice ProvideEvmOutcomeSig : ContractId EvmTxOutcomeSignature
    nonconsuming choice ClaimEvmDeposit      : ContractId Erc20Holding
```

`mpcPublicKey` is set once at creation and used by `ClaimEvmDeposit` to verify
the MPC's DER signature via `secp256k1WithEcdsaOnly`.

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

The MPC and relayer reconstruct calldata deterministically from
`functionSignature` + `args`:

**Daml authorization example:**

```daml
assertMsg "Only ERC20 transfer allowed"
  (evmParams.functionSignature == "transfer(address,uint256)")
let recipientArg = evmParams.args !! 0   -- vault address
let amountArg    = evmParams.args !! 1   -- transfer amount
```

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

**`RequestEvmDeposit`** — initiator creates a deposit request.

```daml
nonconsuming choice RequestEvmDeposit : ContractId PendingEvmDeposit
  with
    requester : Party
    path      : Text
    evmParams : EvmTransactionParams
  controller issuer, requester
  do
    let sender = partyToText requester
    let caip2Id = "eip155:" <> chainIdToDecimalText evmParams.chainId
    let requestId = computeRequestId sender evmParams caip2Id 1 path
    create PendingEvmDeposit with
      issuer; requester; requestId; path; evmParams
```

`keyVersion = 1` is hardcoded. `algo`, `dest`, `params` are hardcoded inside
`computeRequestId` (`"ECDSA"`, `"ethereum"`, `""`).

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

**`ClaimEvmDeposit`** — relayer triggers claim after observing the outcome
signature.

```daml
nonconsuming choice ClaimEvmDeposit : ContractId Erc20Holding
  with
    pendingCid  : ContractId PendingEvmDeposit
    outcomeCid  : ContractId EvmTxOutcomeSignature
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
    6. Sign tx hash with child private key → { r, s, v }
    7. Exercise SignEvmTx(requestId, r, s, v)
       → creates EcdsaSignature on Canton

  Phase 2: Verify ETH outcome (independent of relayer)
    8. Reconstruct signed tx from evmParams + calldata + r, s, v
    9. Compute expected signed tx hash: keccak256(signedSerialized)
    10. Poll Sepolia for receipt by tx hash (the relayer submits independently)
    11. Verify receipt.status === 1
    12. mpcOutput = "01" (success)
    13. responseHash = keccak256(requestId || mpcOutput)
    14. Sign responseHash with root private key → DER signature
    15. Exercise ProvideEvmOutcomeSig(requestId, signature, mpcOutput)
        → creates EvmTxOutcomeSignature on Canton
```

### Relayer Service (`client/src/relayer/`)

Separate process. Holds no private keys. Uses viem for EVM tx reconstruction
and submission.

**mpc-signature-handler.ts** — EcdsaSignature watcher:

```
On EcdsaSignature created:
  1. Read: r, s, v, requestId
  2. Look up PendingEvmDeposit by requestId (query active contracts)
  3. Reconstruct signed EVM tx from evmParams + signature (viem)
  4. Submit to Sepolia: eth_sendRawTransaction
  5. Wait for receipt
```

**tx-outcome-handler.ts** — EvmTxOutcomeSignature watcher:

```
On EvmTxOutcomeSignature created:
  1. Read: requestId, contractId
  2. Look up PendingEvmDeposit by requestId (query active contracts)
  3. Exercise ClaimEvmDeposit(pendingCid, outcomeCid)
     → verifies MPC sig on-chain, creates Erc20Holding
```
