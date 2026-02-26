# EVM Deposit Architecture: Canton MPC PoC

ERC20 deposit flow from an EVM chain (Sepolia) into Canton, with three
autonomous actors: the test (initiator), MPC service (signer), and relayer
(submitter). The MPC never writes to Ethereum; the relayer holds no private
keys.

## Deposit Lifecycle

```
 Test                Canton                   MPC Service                Relayer                Sepolia
  │                    │                           │                       │                       │
  │ RequestEvmDeposit  │                           │                       │                       │
  │ (evmParams, path)  │                           │                       │                       │
  ├───────────────────►│                           │                       │                       │
  │                    │                           │                       │                       │
  │                    │ PendingEvmDeposit         │                       │                       │
  │                    │ (path, evmParams,         │                       │                       │
  │                    │  requester=predId)        │                       │                       │
  │                    │                           │                       │                       │
  │                    │     observes Pending      │                       │                       │
  │                    │──────────────────────────►│                       │                       │
  │                    │                           │                       │                       │
  │                    │                           │ buildCalldata         │                       │
  │                    │                           │ serializeTx           │                       │
  │                    │                           │ keccak256→txHash      │                       │
  │                    │                           │ deriveChildKey        │                       │
  │                    │                           │ sign(txHash)          │                       │
  │                    │                           │                       │                       │
  │                    │        SignEvmTx          │                       │                       │
  │                    │◄──── EcdsaSignature ──────┤                       │                       │
  │                    │      (r, s, v)            │                       │                       │
  │                    │                           │                       │                       │
  │                    │   observes EcdsaSignature │                       │                       │
  │                    │──────────────────────────►├──────────────────────►│                       │
  │                    │                           │                       │                       │
  │                    │                           │                       │ reconstructTx         │
  │                    │                           │                       ├──── sendRawTx ───────►│
  │                    │                           │                       │◄──── receipt ─────────┤
  │                    │                           │                       │                       │
  │                    │                           │ polls Sepolia         │                       │
  │                    │                           │ (knows expected       │                       │
  │                    │                           │  signed tx hash)      │                       │
  │                    │                           │                       │                       │
  │                    │                           ├───── getReceipt ──────┼──────────────────────►│
  │                    │                           │◄──────────────────────┼───────────────────────┤
  │                    │                           │                       │                       │
  │                    │                           │ verify status         │                       │
  │                    │                           │ sign outcome          │                       │
  │                    │                           │                       │                       │
  │                    │   ProvideEvmOutcomeSig    │                       │                       │
  │                    │◄──── TxOutcomeSig ────────┤                       │                       │
  │                    │     (DER sig, output)     │                       │                       │
  │                    │                           │                       │                       │
  │                    │ observes EvmTxOutcomeSig  │                       │                       │
  │                    │──────────────────────────►├──────────────────────►│                       │
  │                    │                           │                       │                       │
  │                    │                           │   ClaimEvmDeposit     │                       │
  │                    │◄──────────────────────────┼── (pendCid,outCid) ───┤                       │
  │                    │                           │                       │                       │
  │                    │ verify MPC sig            │                       │                       │
  │                    │ archive Pending           │                       │                       │
  │                    │ archive OutcomeSig        │                       │                       │
  │                    │                           │                       │                       │
  │                    ├── Erc20Holding            │                       │                       │
  │                    │                           │                       │                       │
  │─── poll ──────────►│                           │                       │                       │
  │◄── Erc20Holding ───┤                           │                       │                       │
  │  assert balance    │                           │                       │                       │
  │                    │                           │                       │                       │
```

### State Machine

`PendingEvmDeposit` is the anchor contract — it lives from request creation
until claim. The MPC posts evidence contracts on the `VaultOrchestrator`,
linked by `requestId`:

```
PendingEvmDeposit (anchor — lives until claimed)
    │
    ├── MPC exercises SignEvmTx
    │   → creates EcdsaSignature (r, s, v)
    │   → MPC computes expected signed tx hash, starts polling Sepolia
    │
    ├── Relayer observes EcdsaSignature
    │   → reconstructs signed tx, submits to Sepolia
    │
    ├── MPC sees receipt on Sepolia (status === 1)
    │   → exercises ProvideEvmOutcomeSig
    │   → creates EvmTxOutcomeSignature (DER sig of outcome)
    │
    └── Relayer observes EvmTxOutcomeSignature
        → exercises ClaimEvmDeposit(pendingCid, outcomeSigCid)
        → verifies MPC signature on-chain
        → archives PendingEvmDeposit + EvmTxOutcomeSignature
        → creates Erc20Holding
```

Each step is observable by the next actor via Canton's ledger update stream
(`/v2/updates` WebSocket or HTTP polling).

### Actor Responsibilities

| Actor       | Holds                                         | Observes on Canton                    | Does                                                                                                                                                                               | Writes to Canton                                                                 |
| ----------- | --------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Test**    | MPC public key, Sepolia RPC (read-only)       | Erc20Holding (polls at end)           | Derives addresses (signet.js), builds calldata + evmParams, fetches nonce/gas from Sepolia                                                                                         | PendingEvmDeposit (via RequestEvmDeposit)                                        |
| **MPC**     | MPC root private key, Sepolia RPC (read-only) | PendingEvmDeposit                     | Reads requester (= predecessorId), path, evmParams from PendingEvmDeposit; derives caip2Id from chainId; derives child key, signs EVM tx, polls Sepolia for receipt, signs outcome | EcdsaSignature (via SignEvmTx), EvmTxOutcomeSignature (via ProvideEvmOutcomeSig) |
| **Relayer** | Sepolia RPC (read+write)                      | EcdsaSignature, EvmTxOutcomeSignature | Fetches PendingEvmDeposit by requestId, reconstructs signed tx from evmParams + signature, submits to Sepolia, triggers claim                                                      | Erc20Holding (via ClaimEvmDeposit)                                               |

The MPC **reads** Sepolia (to verify the ETH tx result) but **never writes** to
it. Only the relayer submits transactions to Ethereum. The relayer holds **no
private keys** — it reconstructs the signed tx from the MPC's on-chain
signature.

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

```typescript
const selector = toFunctionSelector(`function ${functionSignature}`);
const encoded = encodeAbiParameters(paramTypes, args);
const calldata = concat([selector, encoded]);
```

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
`"eip155:" <> chainIdToDecimalText evmParams.chainId` (not stored).

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

`erc20Address` and `amount` are embedded in `evmParams`
(`evmParams.to` = ERC20 contract, `evmParams.args !! 1` = amount).

### `EcdsaSignature` (Erc20Vault.daml)

MPC's EVM transaction signature. The relayer fetches `evmParams` from
`PendingEvmDeposit` via `requestId` to reconstruct the signed transaction.

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
`computeRequestId` (`"ECDSA"`, `"ethereum"`, `""`). `chainIdToDecimalText`
converts hex chainId to decimal text (e.g., `"aa36a7"` to `"11155111"`).

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

The MPC computes `requestId` itself via the same derivation formula — it does
not read it from `PendingEvmDeposit`.

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
    amount      : Decimal     -- caller provides (hex→Decimal conversion off-chain)
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

-- | Response hash for MPC outcome verification.
computeResponseHash : BytesHex -> BytesHex -> BytesHex
-- computeResponseHash requestId mpcOutput = keccak256(requestId <> mpcOutput)

-- | Left-pad hex to target byte width.
padHex : BytesHex -> Int -> BytesHex

-- | Convert Text to hex-encoded UTF-8 bytes. "ECDSA" → "4543445341"
textToHex : Text -> BytesHex

-- | Convert Int to 4-byte big-endian hex. 1 → "00000001"
uint32ToHex : Int -> BytesHex

-- | Convert hex chainId to decimal text. "aa36a7" → "11155111"
chainIdToDecimalText : BytesHex -> Text
```

## TypeScript Services

### MPC Service (`client/src/mpc-service/`)

Canton equivalent of Solana's `fakenet-signer`. Runs as a standalone process.
Uses viem for EVM transaction serialization — never fetches nonce, gas, or any
state from Sepolia during signing. Only reads Sepolia for receipt verification.

```
client/src/mpc-service/
├── index.ts                        Entry point: starts watcher
├── deposit-handler.ts              Watches PendingEvmDeposit → sign + poll receipt + outcome
└── signer.ts                       Key derivation + signing
```

**deposit-handler.ts** — PendingEvmDeposit watcher:

```
On PendingEvmDeposit created:

  Phase 1: Sign the EVM transaction
    1. Read: requester, path, evmParams, requestId, contractId
       Derive: caip2Id = "eip155:" + decimal(evmParams.chainId)
    2. Reconstruct calldata: selector(functionSignature) || abiEncode(args)
    3. Serialize unsigned EVM tx from evmParams + calldata (viem serializeTransaction)
    4. Compute tx hash: keccak256(serializedUnsigned)
    5. Derive child private key:
       predecessorId = requester (Canton party ID)
       derivationPath = "{prefix}:{caip2Id}:{predecessorId}:{path}"
       epsilon = keccak256(derivationPath)
       childKey = (rootPrivateKey + epsilon) mod n
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

The MPC reads `predecessorId` (= requester party) and derives `caip2Id` from
`evmParams.chainId` — no deployment-time config needed for derivation params.

**Environment variables:**

```
MPC_ROOT_PRIVATE_KEY=0x...           secp256k1 private key
SEPOLIA_RPC_URL=https://...          read-only (receipt verification only)
CANTON_JSON_API_URL=http://localhost:7575
```

### Relayer Service (`client/src/relayer/`)

Separate process. Holds no private keys. Uses viem for EVM tx reconstruction
and submission.

```
client/src/relayer/
├── index.ts                            Entry point: starts watchers
├── mpc-signature-handler.ts            Watches EcdsaSignature → submit to ETH
└── tx-outcome-handler.ts               Watches EvmTxOutcomeSignature → ClaimEvmDeposit
```

**mpc-signature-handler.ts** — EcdsaSignature watcher:

```
On EcdsaSignature created:
  1. Read: r, s, v, requestId
  2. Look up PendingEvmDeposit by requestId (query active contracts)
  3. Reconstruct signed EVM tx from evmParams + signature (viem)
  4. Submit to Sepolia: eth_sendRawTransaction
  5. Wait for receipt (poll every 3s, timeout 120s)
```

**tx-outcome-handler.ts** — EvmTxOutcomeSignature watcher:

```
On EvmTxOutcomeSignature created:
  1. Read: requestId, contractId
  2. Look up PendingEvmDeposit by requestId (query active contracts)
  3. Decode amount from PendingEvmDeposit's evmParams.args[1] (hex → Decimal)
  4. Exercise ClaimEvmDeposit(pendingCid, outcomeCid, amount)
     → verifies MPC sig on-chain, creates Erc20Holding
```

**Environment variables:**

```
SEPOLIA_RPC_URL=https://...          read+write (tx submission)
CANTON_JSON_API_URL=http://localhost:7575
```

### Address Derivation (`client/src/mpc/address-derivation.ts`)

Wraps `signet.js`'s `deriveChildPublicKey` for Ethereum address derivation.

```typescript
import { deriveChildPublicKey } from "signet.js";

export function deriveDepositAddress(
  rootPubKey: string, // "04..." uncompressed secp256k1 (no 0x)
  predecessorId: string,
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

// address = keccak256(pubkey_x || pubkey_y)[12..32]
export function publicKeyToEthAddress(uncompressedPubKey: string): Hex;
```

### MPC Signer (`client/src/mpc-service/signer.ts`)

Private-key counterpart of address derivation. Uses `@noble/curves` for
secp256k1 scalar addition modulo the curve order.

```typescript
import { secp256k1 } from "@noble/curves/secp256k1";

const EPSILON_DERIVATION_PREFIX = "sig.network v2.0.0 epsilon derivation";

// childKey = (rootPrivateKey + epsilon) mod n
// where epsilon = keccak256("{prefix}:{caip2Id}:{predecessorId}:{path}")
export function deriveChildPrivateKey(
  rootPrivateKey: Hex,
  predecessorId: string,
  path: string,
  caip2Id: string,
): Hex;

// Returns { r, s, v } as bare hex (no 0x) for Canton's EcdsaSignature.
export function signEvmTxHash(
  privateKey: Hex,
  txHash: Hex,
): { r: string; s: string; v: number };

// responseHash = keccak256(requestId || mpcOutput)
// Returns DER-encoded signature as bare hex (Daml format).
export function signMpcResponse(
  rootPrivateKey: Hex,
  requestId: string,
  mpcOutput: string,
): string;
```

### EVM Transaction Builder (`client/src/evm/tx-builder.ts`)

Generic EIP-1559 transaction construction using `viem`. The test builds the
full `evmParams` before submitting to Canton. The MPC and relayer use the same
serialization to reconstruct transactions deterministically.

```typescript
// Build functionSignature + args for an ERC20 transfer.
export function erc20TransferParams(
  to: Hex,
  amount: bigint,
): {
  functionSignature: string; // "transfer(address,uint256)"
  args: Hex[];
};

// Reconstruct calldata: selector(functionSignature) || abiEncode(args)
export function buildCalldata(functionSignature: string, args: Hex[]): Hex;

// Build EvmTransactionParams — fetches nonce + gas from Sepolia.
// Only called by the test/initiator, never by MPC or relayer.
export async function buildEvmParams(params: {
  from: Hex;
  to: Hex;
  functionSignature: string;
  args: Hex[];
  value: bigint;
  rpcUrl: string;
  chainId: number;
}): Promise<CantonEvmParams>;

// Serialize unsigned EIP-1559 tx. Deterministic: same params → same RLP bytes.
// Used by both MPC (to compute tx hash) and relayer (to reconstruct).
export function serializeUnsignedTx(evmParams: CantonEvmParams): Hex;

// Reconstruct full signed tx from evmParams + signature.
export function reconstructSignedTx(
  evmParams: CantonEvmParams,
  signature: { r: Hex; s: Hex; v: number },
): Hex;

// Submit raw signed tx to Ethereum RPC.
export async function submitRawTransaction(
  rpcUrl: string,
  raw: Hex,
): Promise<Hex>;

// Wait for receipt. Throws if status !== 1.
export async function waitForReceipt(
  rpcUrl: string,
  txHash: Hex,
): Promise<TxReceipt>;
```
