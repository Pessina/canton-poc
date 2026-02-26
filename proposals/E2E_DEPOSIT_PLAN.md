# E2E Deposit Test Plan: Solana → Canton Port

Port the ERC20 deposit E2E test from the Solana contract examples into Canton,
preserving the same actor separation: test creates the request, MPC signs
autonomously, relayer submits to Ethereum and triggers claim.

## Reference Files (solana-contract-examples)

| File | What it does |
|------|-------------|
| `contract/tests/sign-respond-erc20.ts` | E2E deposit test — the source of truth we're porting |
| `contract/programs/.../src/instructions/erc20_vault.rs` | On-chain deposit + claim logic |
| `contract/programs/.../src/crypto.rs` | Address derivation (epsilon * G) + signature verification |
| `contract/programs/.../src/state/erc20.rs` | PendingErc20Deposit, UserErc20Balance state types |
| `contract/utils/envConfig.ts` | Environment config + fakenet constants |
| `frontend/lib/services/cross-chain-orchestrator.ts` | Shows the actor separation: MPC signs, relayer submits to ETH |
| `frontend/lib/relayer/embedded-signer.ts` | Fakenet-signer lifecycle (start/shutdown) |
| `frontend/lib/evm/tx-builder.ts` | ERC20 transfer tx construction |
| `frontend/lib/relayer/handlers.ts` | Server-side deposit handler (await MPC, submit, claim) |

Key `signet.js` internals (in `contract/node_modules/signet.js/dist/index.js`):
- `deriveChildPublicKey` (line ~144) — epsilon derivation + point addition
- `getRequestIdBidirectional` (line ~2833) — `keccak256(encodePacked(...))` request ID

## Architecture: Who Does What

In Solana, the MPC (fakenet-signer) signs and returns signatures **on-chain**
as events. It **never** submits to Ethereum. A relayer/frontend picks up the
signature, builds the full signed tx, and submits to Sepolia on its own. After
Ethereum confirms, the MPC reads the receipt and signs a response proving
success. The relayer picks up that response and calls claim.

Canton mirrors this with **evidence contracts** on the `VaultOrchestrator`.
`PendingDeposit` stays as the anchor contract throughout the lifecycle.
The MPC posts signatures to separate templates; the relayer submits to
Ethereum and triggers the final claim:

```
Test                 Canton                   MPC Service                  Relayer                  Sepolia
  │                    │                          │                          │                        │
  │  RequestDeposit    │                          │                          │                        │
  ├───(evmParams,─────►│                          │                          │                        │
  │    path, caip2Id)  │                          │                          │                        │
  │                    │                          │                          │                        │
  │                    │  PendingDeposit           │                          │                        │
  │                    │  (path, caip2Id,          │                          │                        │
  │                    │   requester=predId)       │                          │                        │
  │                    │                          │                          │                        │
  │                    │                          │                          │                        │
  │                    │          observes Pending │                          │                        │
  │                    │─────────────────────────►│                          │                        │
  │                    │                          │                          │                        │
  │                    │                          │  buildCalldata(sig, args) │                        │
  │                    │                          │  serializeTx(evmParams)   │                        │
  │                    │                          │  → keccak256 → txHash    │                        │
  │                    │                          │  deriveChildKey(requester,│                        │
  │                    │                          │    path, caip2Id)         │                        │
  │                    │                          │  sign(txHash, childKey)   │                        │
  │                    │                          │                          │                        │
  │                    │              SignEvmTx    │                          │                        │
  │                    │◄─── MpcSignature(r,s,v) ─┤                          │                        │
  │                    │                          │                          │                        │
  │                    │                          │                          │                        │
  │                    │                          │          observes MpcSig  │                        │
  │                    │──────────────────────────┼─────────────────────────►│                        │
  │                    │                          │                          │                        │
  │                    │                          │                          │  reconstructSignedTx    │
  │                    │                          │                          ├──── sendRawTx ────────►│
  │                    │                          │                          │◄──── receipt ─────────┤
  │                    │                          │                          │                        │
  │                    │                          │                          │                        │
  │                    │                          │  polls Sepolia for the    │                        │
  │                    │                          │  signed tx it produced    │                        │
  │                    │                          │  (knows expected hash)    │                        │
  │                    │                          │                          │                        │
  │                    │                          ├───────── getReceipt ─────┼───────────────────────►│
  │                    │                          │◄────────────────────────┼────────────────────────┤
  │                    │                          │                          │                        │
  │                    │                          │  verify receipt.status    │                        │
  │                    │                          │  sign outcome (DER)       │                        │
  │                    │                          │                          │                        │
  │                    │        ProvideOutcomeSig  │                          │                        │
  │                    │◄── TxOutcomeSignature ───┤                          │                        │
  │                    │        (DER sig, output)  │                          │                        │
  │                    │                          │                          │                        │
  │                    │                          │                          │                        │
  │                    │                          │        observes Outcome   │                        │
  │                    │──────────────────────────┼─────────────────────────►│                        │
  │                    │                          │                          │                        │
  │                    │                          │  ClaimDeposit             │                        │
  │                    │◄─────────────────────────┼── (pendingCid, outCid) ──┤                        │
  │                    │                          │                          │                        │
  │                    │  verify MPC sig on-chain  │                          │                        │
  │                    │  archive Pending + Outcome│                          │                        │
  │                    │                          │                          │                        │
  │                    ├─ Erc20Holding             │                          │                        │
  │                    │                          │                          │                        │
  │◄── poll ──────────┤                          │                          │                        │
  │    assert balance  │                          │                          │                        │
  │                    │                          │                          │                        │
```

### Actor Responsibilities

| Actor | Holds | Observes on Canton | Does | Writes to Canton |
|-------|-------|-------------------|------|--------------------|
| **Test** | MPC public key, Sepolia RPC (read-only) | Erc20Holding (polls at end) | Derives addresses (signet.js), builds calldata + evmParams, fetches nonce/gas from Sepolia | PendingDeposit (via RequestDeposit) |
| **MPC** | MPC root private key, Sepolia RPC (read-only) | PendingDeposit | Reads requester (= predecessorId) + path + caip2Id from PendingDeposit, derives child key, signs EVM tx, polls Sepolia for receipt, signs outcome | MpcSignature (via SignEvmTx), TxOutcomeSignature (via ProvideOutcomeSig) |
| **Relayer** | Sepolia RPC (read+write) | MpcSignature, TxOutcomeSignature | Reconstructs signed tx from signature + evmParams, submits to Sepolia, triggers claim | Erc20Holding (via ClaimDeposit) |

The MPC **reads** Sepolia (to verify the ETH tx result) but **never writes** to
it. Only the relayer submits transactions to Ethereum. The relayer holds **no
private keys** — it reconstructs the signed tx from the MPC's on-chain
signature.

### Mapping Solana → Canton

| Solana concept | Canton equivalent |
|----------------|-------------------|
| `deposit_erc20` instruction + CPI to Chain Signatures | `RequestDeposit` choice → creates `PendingDeposit` |
| `signatureRespondedEvent` (MPC EVM signature) | `MpcSignature` contract (created by `SignEvmTx`) |
| Relayer picks up signature, submits to ETH | Relayer observes `MpcSignature`, submits to ETH |
| `respondBidirectionalEvent` (MPC response) | `TxOutcomeSignature` contract (created by `ProvideOutcomeSig`) |
| `claim_erc20` instruction (secp256k1_recover) | `ClaimDeposit` choice — relayer triggers, `secp256k1WithEcdsaOnly` verifies |
| `UserErc20Balance` PDA account | `Erc20Holding` contract |
| vault_authority PDA as predecessorId | `requester` party ID (read by MPC from PendingDeposit) |
| user's Solana pubkey as derivation path | User-supplied `path` field on `RequestDeposit` |

### Key Divergences from Solana

| Area | Solana | Canton |
|------|--------|--------|
| EVM params | Builds ERC20 calldata on-chain | Generic EIP-1559 — caller pre-builds calldata off-chain |
| Deposit lifecycle | PendingErc20Deposit consumed at claim | PendingDeposit stays as anchor; MPC posts signatures to separate templates |
| Response key | Verified against derived address (vault PDA + "solana response key") | Verified against MPC root public key |
| predecessorId | vault_authority PDA (derived from user's Solana pubkey) | `requester` Canton party ID (authenticated by `controller` requirement) |
| ETH submission tracking | Relayer posts tx hash on-chain | No on-chain record — MPC monitors Sepolia independently (it knows the expected tx hash from its own signature) |
| Request ID | `keccak256(encodePacked(sender, rlpTx, caip2Id, ...))` | Same formula — `packParams(evmParams)` replaces RLP as payload, other fields identical |

## Deposit State Machine

`PendingDeposit` is the anchor contract — it lives from request creation until
claim. The MPC posts its outputs as evidence contracts on the
`VaultOrchestrator`, linked by `requestId`:

```
PendingDeposit (anchor — lives until claimed)
    │
    ├── MPC exercises SignEvmTx
    │   → creates MpcSignature (r, s, v + evmParams copy)
    │   → MPC computes expected signed tx hash, starts polling Sepolia
    │
    ├── Relayer observes MpcSignature
    │   → reconstructs signed tx, submits to Sepolia
    │
    ├── MPC sees receipt on Sepolia (status === 1)
    │   → exercises ProvideOutcomeSig
    │   → creates TxOutcomeSignature (DER sig of outcome)
    │
    └── Relayer observes TxOutcomeSignature
        → exercises ClaimDeposit(pendingCid, outcomeSigCid)
        → verifies MPC signature on-chain
        → archives PendingDeposit + TxOutcomeSignature
        → creates Erc20Holding
```

Each step is observable by the next actor via Canton's ledger update stream
(`/v2/updates` WebSocket or HTTP polling).

## Daml Contract Changes

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

The MPC and relayer reconstruct calldata deterministically from
`functionSignature` + `args` using viem:
```typescript
const selector = toFunctionSelector(`function ${functionSignature}`);
const encoded = encodeAbiParameters(paramTypes, args);
const calldata = concat([selector, encoded]);
```

**Daml authorization example:**
```daml
-- In RequestDeposit (or a dedicated authorization check):
assertMsg "Only ERC20 transfer allowed"
  (evmParams.functionSignature == "transfer(address,uint256)")
-- Inspect individual args:
let recipientArg = evmParams.args !! 0   -- vault address
let amountArg    = evmParams.args !! 1   -- transfer amount
```

### Renamed: `MpcSignature` type → `EcdsaSignature` (Types.daml)

The existing `MpcSignature` data type (DER sig + SPKI pubkey) is renamed to
`EcdsaSignature` to avoid collision with the new `MpcSignature` template.
This type represents a Daml-verifiable ECDSA signature in DER format.

```daml
data EcdsaSignature = EcdsaSignature
  with
    signature : SignatureHex   -- DER-encoded
    publicKey : PublicKeyHex   -- SPKI-encoded
  deriving (Eq, Show)
```

Removed: `OperationType` (no longer needed — generic EIP-1559 params).

### Modified: `PendingDeposit` — add `path` and `caip2Id` (Erc20Vault.daml)

The MPC needs the derivation path to derive the child signing key. It reads
`requester` from PendingDeposit and uses it as the `predecessorId` — this is
authenticated by Canton's `controller` requirement and cannot be spoofed.
In Solana, this role is filled by the vault_authority PDA derived from
`requester.to_string()` (`erc20_vault.rs:29`).

The `caip2Id` is caller-supplied and stored so the MPC knows which chain's
derivation to use (e.g., `"eip155:11155111"` for Sepolia).

```daml
template PendingDeposit
  with
    issuer    : Party
    requester : Party        -- MPC uses as predecessorId for key derivation
    requestId : BytesHex
    path      : Text         -- user-supplied derivation sub-path
    caip2Id   : Text         -- chain identifier (e.g., "eip155:11155111")
    evmParams : EvmTransactionParams
  where
    signatory issuer
    observer requester
```

`erc20Address` and `amount` are not stored — they're already in `evmParams`
(`evmParams.to` = ERC20 contract, `evmParams.args !! 1` = amount). The
`Erc20Holding` created at claim time extracts these from `evmParams`.

### New: Evidence templates on VaultOrchestrator (Erc20Vault.daml)

Evidence contracts live on the `VaultOrchestrator` — created via choices,
linked by `requestId`.

```daml
-- | MPC's EVM transaction signature. Created by SignEvmTx.
-- Carries evmParams so the relayer can reconstruct the signed tx
-- without needing to look up PendingDeposit separately.
template MpcSignature
  with
    issuer    : Party
    requestId : BytesHex
    evmParams : EvmTransactionParams  -- copied from PendingDeposit
    r         : BytesHex              -- 32 bytes
    s         : BytesHex              -- 32 bytes
    v         : Int                   -- recovery id (0 or 1)
  where
    signatory issuer

-- | MPC's attestation of the ETH transaction outcome.
-- Created by ProvideOutcomeSig. DER-encoded signature verifiable
-- on-chain with secp256k1WithEcdsaOnly.
template TxOutcomeSignature
  with
    issuer         : Party
    requestId      : BytesHex
    ecdsaSignature : EcdsaSignature   -- DER sig + SPKI pubkey
    mpcOutput      : BytesHex         -- "01" = success
  where
    signatory issuer
```

### Modified: `RequestDeposit` — add `path` and `caip2Id`

The caller supplies a `path` and `caip2Id`. The `requester` party is
authenticated by Canton's `controller issuer, requester` — both must sign.
The MPC reads `requester` from the created PendingDeposit and uses it
as the `predecessorId` for key derivation, ensuring each user gets unique
derived addresses.

```daml
nonconsuming choice RequestDeposit : ContractId PendingDeposit
  with
    requester : Party
    path      : Text
    caip2Id   : Text
    evmParams : EvmTransactionParams
  controller issuer, requester
  do
    let sender = partyToText requester
    let requestId = computeRequestId sender evmParams caip2Id 1 path
    create PendingDeposit with
      issuer; requester; requestId; path; caip2Id; evmParams
```

`keyVersion = 1` is hardcoded (same as Solana's current version). `algo`,
`dest`, `params` are hardcoded inside `computeRequestId` (`"ECDSA"`,
`"ethereum"`, `""`).

### New: `SignEvmTx` choice

MPC deterministically RLP-encodes the EVM tx from `evmParams`, hashes it,
signs with the derived child key, and posts the signature as `MpcSignature`.

```daml
nonconsuming choice SignEvmTx : ContractId MpcSignature
  with
    pendingCid : ContractId PendingDeposit
    r          : BytesHex
    s          : BytesHex
    v          : Int
  controller issuer
  do
    pending <- fetch pendingCid
    create MpcSignature with
      issuer
      requestId = pending.requestId
      evmParams = pending.evmParams
      r; s; v
```

### New: `ProvideOutcomeSig` choice

MPC verifies the ETH receipt (off-chain via Sepolia RPC), signs the outcome,
and posts the proof.

```daml
nonconsuming choice ProvideOutcomeSig : ContractId TxOutcomeSignature
  with
    requestId      : BytesHex
    ecdsaSignature : EcdsaSignature
    mpcOutput      : BytesHex
  controller issuer
  do
    create TxOutcomeSignature with
      issuer; requestId; ecdsaSignature; mpcOutput
```

### Modified: `ClaimDeposit` — consumes `PendingDeposit` + `TxOutcomeSignature`

The relayer triggers claim after observing `TxOutcomeSignature`. Verifies the
MPC's DER signature on-chain, then archives both the anchor and the proof.

```daml
nonconsuming choice ClaimDeposit : ContractId Erc20Holding
  with
    pendingCid  : ContractId PendingDeposit
    outcomeCid  : ContractId TxOutcomeSignature
    amount      : Decimal     -- caller provides (hex→Decimal conversion off-chain)
  controller issuer
  do
    pending <- fetch pendingCid
    outcome <- fetch outcomeCid

    assertMsg "Request ID mismatch"
      (pending.requestId == outcome.requestId)

    assertMsg "MPC public key mismatch"
      (outcome.ecdsaSignature.publicKey == mpcPublicKey)

    let responseHash = computeResponseHash pending.requestId outcome.mpcOutput
    assertMsg "Invalid MPC signature on deposit response"
      (verifyEcdsaSignature outcome.ecdsaSignature responseHash)

    archive pendingCid
    archive outcomeCid

    create Erc20Holding with
      issuer
      owner        = pending.requester
      erc20Address = (pending.evmParams).to    -- ERC20 contract address
      amount                                   -- from caller (matches args !! 1)
```

### Modified: `Crypto.daml` — updated types + `packParams`

Rename `MpcSignature` → `EcdsaSignature` throughout. Update `packParams`
to match the new generic `EvmTransactionParams` fields, and update
`computeRequestId` to follow Solana's `getRequestIdBidirectional` formula
with `packParams` replacing the RLP payload.

```daml
-- | abi_encode_packed equivalent for EVM transaction fields.
-- Replaces the RLP payload in Solana's getRequestIdBidirectional.
packParams : EvmTransactionParams -> BytesHex
packParams p =
  padHex p.to 20
    <> foldl (<>) "" p.args       -- concatenated args (variable length)
    <> padHex p.value          32
    <> padHex p.nonce          32
    <> padHex p.gasLimit       32
    <> padHex p.maxFeePerGas   32
    <> padHex p.maxPriorityFee 32
    <> padHex p.chainId        32

-- | Convert Text to hex-encoded UTF-8 bytes.
-- e.g., "ECDSA" → "4543445341"
textToHex : Text -> BytesHex

-- | Convert Int to 4-byte big-endian hex. e.g., 1 → "00000001"
uint32ToHex : Int -> BytesHex

-- | Request ID = keccak256(encodePacked(sender, payload, caip2Id,
-- keyVersion, path, algo, dest, params)).
-- Same formula as Solana's getRequestIdBidirectional, with
-- packParams(evmParams) replacing the RLP-encoded tx as payload.
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
      -- params = "" → empty bytes, nothing to append
    )

verifyEcdsaSignature : EcdsaSignature -> BytesHex -> Bool
verifyEcdsaSignature sig msg =
  secp256k1WithEcdsaOnly sig.signature msg sig.publicKey
```

## TypeScript Modules

### Address Derivation (`client/src/mpc/address-derivation.ts`)

Uses `signet.js` directly instead of reimplementing epsilon derivation.

```typescript
import { deriveChildPublicKey } from "signet.js";
import { keccak256, type Hex } from "viem";

/**
 * Derive an Ethereum deposit address from MPC root key + derivation params.
 * Wraps signet.js's deriveChildPublicKey + keccak256 address derivation.
 */
export function deriveDepositAddress(
  rootPubKey: string,        // "04..." uncompressed secp256k1 (no 0x)
  predecessorId: string,
  path: string,
  caip2Id: string,
  keyVersion: number,
): Hex {
  const childPubKey = deriveChildPublicKey(
    rootPubKey, predecessorId, path, caip2Id, keyVersion,
  );
  return publicKeyToEthAddress(childPubKey);
}

/**
 * Convert uncompressed public key to Ethereum address.
 * address = keccak256(pubkey_x || pubkey_y)[12..32]
 */
export function publicKeyToEthAddress(uncompressedPubKey: string): Hex
```

### EVM Transaction Builder (`client/src/evm/tx-builder.ts`)

Uses `viem` for all EVM utilities. The test builds the full `evmParams`
(including calldata) before submitting to Canton. The MPC and relayer use
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
export function erc20TransferParams(to: Hex, amount: bigint): {
  functionSignature: string;  // "transfer(address,uint256)"
  args: Hex[];                // [to padded to 20 bytes, amount padded to 32 bytes]
}

/**
 * Reconstruct calldata from functionSignature + args.
 * Used by MPC and relayer to build the EVM transaction.
 *   calldata = selector(functionSignature) || abiEncode(args)
 */
export function buildCalldata(functionSignature: string, args: Hex[]): Hex

/**
 * Build EvmTransactionParams for Canton's RequestDeposit.
 * Fetches nonce + gas estimate from Sepolia RPC (test/caller only —
 * MPC and relayer never call this).
 */
export async function buildEvmParams(params: {
  from: Hex;
  to: Hex;
  functionSignature: string;
  args: Hex[];
  value: bigint;
  rpcUrl: string;
  chainId: number;
}): Promise<CantonEvmParams>

/**
 * Serialize an unsigned EIP-1559 transaction from Canton's EvmTransactionParams.
 * Reconstructs calldata from functionSignature + args via buildCalldata().
 * Deterministic: same params → same RLP bytes.
 * Used by both MPC (to compute tx hash) and relayer (to reconstruct).
 */
export function serializeUnsignedTx(evmParams: CantonEvmParams): Hex

/**
 * Reconstruct a full signed EVM transaction from evmParams + signature.
 * Used by the relayer after reading MpcSignature from Canton.
 */
export function reconstructSignedTx(
  evmParams: CantonEvmParams,
  signature: { r: Hex; s: Hex; v: number },
): Hex

/**
 * Submit a raw signed transaction to an Ethereum RPC endpoint.
 */
export async function submitRawTransaction(rpcUrl: string, raw: Hex): Promise<Hex>

/**
 * Wait for a transaction receipt. Throws if status !== 1.
 */
export async function waitForReceipt(rpcUrl: string, txHash: Hex): Promise<TxReceipt>
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
 *   predecessorId = requester party ID (from PendingDeposit)
 *   derivationPath = "{prefix}:{caip2Id}:{predecessorId}:{path}"
 *   epsilon = keccak256(derivationPath)
 *   childKey = (rootPrivateKey + epsilon) mod n
 */
export function deriveChildPrivateKey(
  rootPrivateKey: Hex,
  predecessorId: string,  // = requester Canton party ID
  path: string,
  caip2Id: string,
): Hex

/**
 * Sign an EVM transaction hash with a secp256k1 private key.
 * Returns { r, s, v } as bare hex (no 0x) for Canton's MpcSignature.
 */
export function signEvmTxHash(
  privateKey: Hex,
  txHash: Hex,
): { r: string; s: string; v: number }

/**
 * Sign the MPC response for Canton's TxOutcomeSignature.
 *
 *   responseHash = keccak256(requestId || mpcOutput)
 *   signature = secp256k1_sign(responseHash, rootPrivateKey)
 *
 * Returns DER-encoded signature + SPKI-encoded public key.
 * Both are bare hex without 0x prefix (Daml format).
 */
export function signMpcResponse(
  rootPrivateKey: Hex,
  requestId: string,
  mpcOutput: string,
): { signature: string; publicKey: string }
```

**DER encoding detail:** Daml's `secp256k1WithEcdsaOnly` expects:
- Signature: DER format `30 <len> 02 <r-len> <r> 02 <s-len> <s>`
- Public key: SubjectPublicKeyInfo format
  `3056301006072a8648ce3d020106052b8104000a034200 04<x><y>`

`@noble/curves` provides `sig.toDERHex()` for signature encoding. The SPKI
prefix for secp256k1 is a fixed 26-byte header (see `TEST_PUB_KEY` in
`client/src/test/crypto.test.ts:82-83`).

### MPC Service (`client/src/mpc-service/`)

The Canton equivalent of `fakenet-signer`. Runs as a standalone process.
Uses viem for EVM transaction serialization — never fetches nonce, gas,
or any state from Sepolia during signing. Only reads Sepolia for receipt
verification.

The MPC handles the full deposit lifecycle after observing `PendingDeposit`:
first it signs the EVM tx, then it independently monitors Sepolia for the
receipt (it can compute the expected signed tx hash from the evmParams +
its own signature).

```
client/src/mpc-service/
├── index.ts                        Entry point: starts watcher
├── deposit-handler.ts              Watches PendingDeposit → sign + poll receipt + outcome
└── signer.ts                       Key derivation + signing
```

**deposit-handler.ts** — PendingDeposit watcher:
```
On PendingDeposit created:

  Phase 1: Sign the EVM transaction
    1. Read: requester, path, caip2Id, evmParams, requestId, contractId
    2. Reconstruct calldata: selector(functionSignature) || abiEncode(args)
    3. Serialize unsigned EVM tx from evmParams + calldata (viem serializeTransaction)
    4. Compute tx hash: keccak256(serializedUnsigned)
    5. Derive child private key:
       predecessorId = requester (Canton party ID)
       derivationPath = "{prefix}:{caip2Id}:{predecessorId}:{path}"
       epsilon = keccak256(derivationPath)
       childKey = (rootPrivateKey + epsilon) mod n
    6. Sign tx hash with child private key → { r, s, v }
    7. Exercise SignEvmTx(pendingCid, r, s, v)
       → creates MpcSignature on Canton

  Phase 2: Verify ETH outcome (independent of relayer)
    8. Reconstruct signed tx from evmParams + calldata + r, s, v
    9. Compute expected signed tx hash: keccak256(signedSerialized)
    10. Poll Sepolia for receipt by tx hash (the relayer submits independently)
    11. Verify receipt.status === 1
    12. mpcOutput = "01" (success)
    13. responseHash = keccak256(requestId || mpcOutput)
    14. Sign responseHash with root private key → DER signature
    15. Exercise ProvideOutcomeSig(requestId, ecdsaSignature, mpcOutput)
        → creates TxOutcomeSignature on Canton
```

**Environment variables:**
```
MPC_ROOT_PRIVATE_KEY=0x...           secp256k1 private key
SEPOLIA_RPC_URL=https://...          read-only (receipt verification only)
CANTON_JSON_API_URL=http://localhost:7575
```

The MPC reads `predecessorId` (= requester party) and `caip2Id` from each
PendingDeposit event — no deployment-time config needed for derivation params.

### Relayer Service (`client/src/relayer/`)

Separate process. Holds no private keys. Uses viem for EVM tx
reconstruction and submission.

```
client/src/relayer/
├── index.ts                            Entry point: starts watchers
├── mpc-signature-handler.ts            Watches MpcSignature → submit to ETH
└── tx-outcome-handler.ts               Watches TxOutcomeSignature → ClaimDeposit
```

**mpc-signature-handler.ts** — MpcSignature watcher:
```
On MpcSignature created:
  1. Read: evmParams, r, s, v, requestId
  2. Reconstruct signed EVM tx from evmParams + signature (viem)
  3. Submit to Sepolia: eth_sendRawTransaction
  4. Wait for receipt (poll every 3s, timeout 120s)
```

**tx-outcome-handler.ts** — TxOutcomeSignature watcher:
```
On TxOutcomeSignature created:
  1. Read: requestId, contractId
  2. Look up PendingDeposit by requestId (query active contracts)
  3. Decode amount from PendingDeposit's evmParams.args[1] (hex → Decimal)
  4. Exercise ClaimDeposit(pendingCid, outcomeCid, amount)
     → verifies MPC sig on-chain, creates Erc20Holding
```

**Environment variables:**
```
SEPOLIA_RPC_URL=https://...          read+write (tx submission)
CANTON_JSON_API_URL=http://localhost:7575
```

## E2E Test (`client/src/test/deposit-e2e.test.ts`)

The test knows nothing about MPC keys. It creates the request and waits for
the MPC + relayer to process it autonomously.

```typescript
describe("E2E ERC20 Deposit Flow", () => {
  // beforeAll: upload DAR, allocate parties, create user, create VaultOrchestrator

  it("derives deterministic deposit address from MPC public key", () => {
    // Uses signet.js's deriveChildPublicKey directly.
    // Cross-check with known vectors.
  });

  it("derives different addresses for different derivation paths", () => {
    // path="alice:deposit" vs path="bob:deposit" → different addresses.
  });

  it("deposit address differs from signer (vault) address", () => {
    // path=derivationPath vs path="root" → different addresses.
  });

  it("request ID matches between TypeScript and Canton", async () => {
    // Exercise RequestDeposit, compare Canton's requestId with TS computation.
    // Extends existing cross-runtime test in crypto.test.ts.
  });

  it("completes full deposit lifecycle", async () => {
    // Step 1: Derive addresses (public key only, using signet.js)
    const depositAddr = deriveDepositAddress(
      MPC_PUB_KEY, PREDECESSOR_ID, derivationPath, CAIP2_ID, KEY_VERSION,
    );
    const vaultAddr = deriveDepositAddress(
      MPC_PUB_KEY, PREDECESSOR_ID, "root", CAIP2_ID, KEY_VERSION,
    );

    // Step 2: Build ERC20 transfer function signature + args
    const { functionSignature, args } = erc20TransferParams(vaultAddr, depositAmount);

    // Step 3: Build evmParams (fetch nonce + gas from Sepolia — read-only)
    const evmParams = await buildEvmParams({
      from: depositAddr, to: ERC20_ADDRESS,
      functionSignature, args, value: 0n,
      rpcUrl: SEPOLIA_RPC_URL, chainId: 11155111,
    });

    // Step 4: Exercise RequestDeposit on Canton
    await exerciseChoice(..., "RequestDeposit", {
      requester: depositor, path: userPath,
      caip2Id: "eip155:11155111", evmParams,
    });

    // Step 5: Wait for MPC + Relayer to process autonomously
    //   PendingDeposit → MpcSignature → relayer submits
    //                  → TxOutcomeSignature → ClaimDeposit → Erc20Holding
    const holding = await pollForContract("Erc20Holding", depositor, 180_000);

    // Step 6: Assert final state
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
│   ├── Erc20Vault.daml              MODIFY: add derivationPath, MpcSignature,
│   │                                        TxOutcomeSignature,
│   │                                        SignEvmTx, ProvideOutcomeSig,
│   │                                        modify RequestDeposit + ClaimDeposit
│   ├── Types.daml                   MODIFY: generic EvmTransactionParams,
│   │                                        rename MpcSignature → EcdsaSignature,
│   │                                        remove OperationType
│   ├── Crypto.daml                  MODIFY: updated packParams, computeRequestId
│   │                                        (signet.js formula), rename, add helpers
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
│   │   │   ├── deposit-handler.ts            NEW: PendingDeposit → sign + verify + outcome
│   │   │   └── signer.ts                     NEW: key derivation + signing
│   │   ├── relayer/
│   │   │   ├── index.ts                      NEW: Relayer entry point
│   │   │   ├── mpc-signature-handler.ts      NEW: MpcSignature → submit to ETH
│   │   │   └── tx-outcome-handler.ts         NEW: TxOutcomeSignature → ClaimDeposit
│   │   ├── scripts/
│   │   │   ├── demo.ts                       UPDATE: add path + new EvmTransactionParams fields
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
+   "relayer": "tsx src/relayer/index.ts",
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

| # | Phase | Depends On | Scope |
|---|-------|-----------|-------|
| 1 | Daml: generic EvmTransactionParams, EcdsaSignature rename, signet.js-aligned computeRequestId + helpers, evidence templates, new choices, modify RequestDeposit + ClaimDeposit | — | ~120 lines |
| 2 | Rebuild DAR + codegen (`dpm build && dpm codegen-js ...`) | 1 | — |
| 3 | Address derivation module + tests (wraps signet.js) | — | ~50 lines |
| 4 | EVM tx builder (generic EIP-1559, viem) | — | ~120 lines |
| 5 | MPC signer module (@noble/curves) | — | ~100 lines |
| 6 | Env config | — | ~40 lines |
| 7 | Canton client: getActiveContracts | — | ~30 lines |
| 8 | MPC service (deposit handler — sign + verify) | 4, 5, 6 | ~150 lines |
| 9 | Relayer service (two watchers — submit + claim) | 4, 6, 7 | ~120 lines |
| 10 | Derive-address script | 3 | ~30 lines |
| 11 | Update existing tests + demo.ts (new EvmTransactionParams + path) | 2 | ~30 lines |
| 12 | E2E deposit test | 3, 4, 6, 7 | ~120 lines |

Phases 1, 3, 4, 5, 6 are independent and can be built in parallel. Phase 2 must
follow 1. Phases 8 and 9 integrate the shared modules. Phase 12 ties
everything together.

## Prerequisites

1. **MPC root private key** (secp256k1 hex) → MPC service env only
2. **MPC root public key** (uncompressed `04...` AND SPKI DER format) → test config + Canton VaultOrchestrator
3. **Sepolia RPC URL** (Infura or Alchemy) → all services
4. **After phase 10:** run `npm run derive-address` → fund the printed address with **both USDC and ETH** on Sepolia (ETH pays for gas on the signed EVM transaction)
5. **Runtime:** Canton sandbox + MPC service + relayer all running before test

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

The MPC reads derivation inputs from PendingDeposit:
- `predecessorId` = `requester` party (authenticated by Canton's controller)
- `path` = user-supplied (stored in PendingDeposit)
- `caip2Id` = caller-supplied (stored in PendingDeposit)

For the vault receiver address: `predecessorId = requester`, `path = "root"`.

### EVM Transaction Signing (MPC)

The MPC is EVM-type agnostic — it signs any EIP-1559 transaction
deterministically from the on-chain `evmParams`:

```
calldata = buildCalldata(functionSignature, args)     // selector + abiEncode
unsignedTx = serializeTransaction({                   // viem — deterministic RLP
  type: 'eip1559',
  chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
  gas, to, value, data: calldata, accessList: []
})
txHash = keccak256(unsignedTx)
childPrivateKey = (rootPrivateKey + epsilon) mod n
{r, s, v} = secp256k1_sign(txHash, childPrivateKey)
```

The MPC never fetches nonce, gas, or any state from Sepolia for signing.
After signing, it computes the expected signed tx hash and polls Sepolia
for the receipt independently — no on-chain record of the ETH submission
is needed.

The relayer reconstructs the same unsigned tx from `evmParams`, attaches the
signature, and submits via `eth_sendRawTransaction`.

### Request ID

Same formula as Solana's `getRequestIdBidirectional`, with `packParams(evmParams)`
replacing the RLP-encoded payload:

```
requestId = keccak256(encodePacked(
  sender,                    // partyToText requester (string)
  packParams(evmParams),     // packed tx fields (bytes) — replaces RLP
  caip2Id,                   // "eip155:11155111" (string)
  keyVersion,                // 1 (uint32)
  path,                      // user-supplied (string)
  "ECDSA",                   // algo (string)
  "ethereum",                // dest (string)
  ""                         // params (string, empty)
))
```

On the TypeScript side, this leverages `signet.js` directly:
```typescript
import { getRequestIdBidirectional } from "signet.js";

const requestId = getRequestIdBidirectional({
  sender: requesterParty,
  payload: hexToBytes(packParams(evmParams)),  // packParams replaces RLP
  caip2Id: "eip155:11155111",
  keyVersion: 1,
  path: userPath,
  algo: "ECDSA",
  dest: "ethereum",
  params: "",
});
```

On the Daml side, `computeRequestId` implements the same `encodePacked` logic
with `textToHex` and `uint32ToHex` helpers (see Crypto.daml section).

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
- Signature: `30 <len> 02 <r-len> <r> 02 <s-len> <s>`
- Public key (SPKI): `3056301006072a8648ce3d020106052b8104000a034200 04<x><y>`
- Both bare hex without `0x` prefix (Daml convention)

## Design Decisions

### Derivation parameters — on-chain, not env vars

- **`predecessorId`** = `requester` Canton party ID. Read by the MPC from
  each PendingDeposit event. Authenticated by Canton's `controller` requirement
  — cannot be spoofed. Unique per user, so each user gets distinct derived
  addresses.
- **`caip2Id`** = caller-supplied, stored on PendingDeposit. Allows the same
  contract to support multiple chains.
- **`path`** = caller-supplied, stored on PendingDeposit. Allows a user to
  have multiple deposit addresses (e.g., `"deposit-1"`, `"deposit-2"`).

No derivation config lives in MPC env vars — everything comes from the ledger.

## Existing Tests Impact

### `crypto.test.ts` — update `EvmTransactionParams` + add `path`

The three existing test suites need to use the new generic `EvmTransactionParams`
fields and pass `path` in `RequestDeposit` calls:

```diff
- const damlEvmParams = {
-   erc20Address: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
-   recipient: "d8da6bf26964af9d7eed9e03e53415d37aa96045",
-   amount: "0000000000000000000000000000000000000000000000000000000005f5e100",
-   ...
-   operation: "Erc20Transfer",
- };
+ const damlEvmParams = {
+   to: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
+   functionSignature: "transfer(address,uint256)",
+   args: [
+     "000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045",
+     "0000000000000000000000000000000000000000000000000000000005f5e100",
+   ],
+   value: "0000000000000000000000000000000000000000000000000000000000000000",
+   ...
+ };
```

```diff
  "RequestDeposit",
  {
    requester: depositor,
-   erc20Address: damlEvmParams.erc20Address,
-   amount: "100000000",
+   path: "test-depositor",
+   caip2Id: "eip155:11155111",
    evmParams: damlEvmParams,
  },
```

### `demo.ts` — same field changes

The demo script also exercises `RequestDeposit` and uses the old
`EvmTransactionParams` format. Needs the same updates as the tests.
