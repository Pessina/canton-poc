# E2E Deposit Test Plan: Solana → Canton Port

Port the ERC20 deposit E2E test from the Solana contract examples into Canton,
preserving the same actor separation: test creates the request, MPC signs
autonomously, relayer submits to Ethereum, MPC verifies and claims.

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

Canton mirrors this with intermediate contracts instead of events:

```
Test              Canton              MPC Service         Relayer           Sepolia
 │                  │                     │                  │                │
 ├─RequestDeposit──►│                     │                  │                │
 │                  ├─PendingDeposit──────►│                  │                │
 │                  │                     │                  │                │
 │                  │    ProvideSignature  │                  │                │
 │                  │◄───(r, s, v)────────┤                  │                │
 │                  ├─SignedDeposit───────────────────────────►│                │
 │                  │                     │                  │                │
 │                  │                     │                  ├─sendRawTx─────►│
 │                  │                     │                  │◄──receipt──────┤
 │                  │    ReportSubmission  │                  │                │
 │                  │◄───(ethTxHash)──────────────────────────┤                │
 │                  ├─SubmittedDeposit────►│                  │                │
 │                  │                     │                  │                │
 │                  │                     ├──getReceipt──────────────────────►│
 │                  │                     │◄─────────────────────────────────┤
 │                  │                     │                  │                │
 │                  │     ClaimDeposit    │                  │                │
 │                  │◄───(mpcSig)─────────┤                  │                │
 │                  ├─Erc20Holding        │                  │                │
 │                  │                     │                  │                │
 │◄─poll───────────┤                     │                  │                │
 │  assert balance  │                     │                  │                │
```

### Actor Responsibilities

| Actor | Holds | Observes on Canton | Does | Writes to Canton |
|-------|-------|-------------------|------|-----------------|
| **Test** | MPC public key, Sepolia RPC (read-only) | Erc20Holding (polls at end) | Derives addresses, builds evmParams, fetches nonce/gas | PendingDeposit (via RequestDeposit) |
| **MPC** | MPC root private key, Sepolia RPC (read-only) | PendingDeposit, SubmittedDeposit | Signs EVM tx, verifies ETH receipt, signs response | SignedDeposit (via ProvideSignature), Erc20Holding (via ClaimDeposit) |
| **Relayer** | Sepolia RPC (read+write) | SignedDeposit | Builds full signed tx from signature + params, submits to Sepolia | SubmittedDeposit (via ReportSubmission) |

The MPC **reads** Sepolia (to verify the ETH tx result) but **never writes** to
it. Only the relayer submits transactions to Ethereum. The relayer holds **no
private keys** — it reconstructs the signed tx from the MPC's on-chain
signature.

### Mapping Solana → Canton

| Solana concept | Canton equivalent |
|----------------|-------------------|
| `deposit_erc20` instruction + CPI to Chain Signatures | `RequestDeposit` choice → creates `PendingDeposit` |
| `signatureRespondedEvent` (MPC signature on-chain) | `SignedDeposit` contract (created by `ProvideSignature`) |
| Relayer picks up signature, submits to ETH | Relayer observes `SignedDeposit`, submits to ETH, creates `SubmittedDeposit` |
| `respondBidirectionalEvent` (MPC response on-chain) | MPC observes `SubmittedDeposit`, verifies, exercises `ClaimDeposit` |
| `claim_erc20` instruction (secp256k1_recover) | `ClaimDeposit` choice (secp256k1WithEcdsaOnly) |
| `UserErc20Balance` PDA account | `Erc20Holding` contract |
| vault_authority PDA as predecessorId | Fixed string (e.g., `"canton-vault"`) or issuer party |
| user's Solana pubkey as derivation path | Caller-supplied `path` field on `RequestDeposit` |

## Deposit State Machine

```
PendingDeposit
    │  MPC exercises ProvideSignature (signs EVM tx, writes r/s/v)
    ▼
SignedDeposit
    │  Relayer exercises ReportSubmission (submits to ETH, writes tx hash)
    ▼
SubmittedDeposit
    │  MPC exercises ClaimDeposit (verifies ETH receipt, signs response)
    ▼
Erc20Holding
```

Each transition is controlled by `issuer` and is observable by the next actor
via Canton's ledger update stream (`/v2/updates` WebSocket or HTTP polling).

## Daml Contract Changes

### New Type: `EvmSignature` (Types.daml)

```daml
data EvmSignature = EvmSignature
  with
    r : BytesHex   -- 32 bytes
    s : BytesHex   -- 32 bytes
    v : Int        -- recovery id (0 or 1)
  deriving (Eq, Show)
```

### Modified: `PendingDeposit` — add `path` field

The relayer/MPC needs to know the derivation path that was used. In Solana,
the path is derived on-chain (`requester.to_string()` in `erc20_vault.rs:29`).
For Canton, the caller supplies it and it's stored for the MPC to read.

```daml
template PendingDeposit
  with
    issuer       : Party
    requester    : Party
    erc20Address : BytesHex
    amount       : Decimal
    requestId    : BytesHex
    path         : Text             -- NEW: MPC key derivation path
    evmParams    : EvmTransactionParams
  where
    signatory issuer
    observer requester
```

### New: `SignedDeposit` template

Created by `ProvideSignature`. Holds the EVM transaction signature so the
relayer can build the full signed transaction.

```daml
template SignedDeposit
  with
    issuer       : Party
    requester    : Party
    erc20Address : BytesHex
    amount       : Decimal
    requestId    : BytesHex
    path         : Text
    evmParams    : EvmTransactionParams
    evmSignature : EvmSignature
  where
    signatory issuer
    observer requester
```

### New: `SubmittedDeposit` template

Created by `ReportSubmission`. Holds the Ethereum tx hash so the MPC can
verify the receipt.

```daml
template SubmittedDeposit
  with
    issuer       : Party
    requester    : Party
    erc20Address : BytesHex
    amount       : Decimal
    requestId    : BytesHex
    ethTxHash    : BytesHex
  where
    signatory issuer
    observer requester
```

### Modified: `RequestDeposit` choice — add `path` parameter

```daml
nonconsuming choice RequestDeposit : ContractId PendingDeposit
  with
    requester    : Party
    erc20Address : BytesHex
    amount       : Decimal
    path         : Text             -- NEW
    evmParams    : EvmTransactionParams
  controller issuer, requester
  do
    let requestId = computeRequestId evmParams
    create PendingDeposit with
      issuer; requester; erc20Address; amount; requestId; path; evmParams
```

### New: `ProvideSignature` choice

MPC signs the EVM tx and transitions PendingDeposit → SignedDeposit.

```daml
nonconsuming choice ProvideSignature : ContractId SignedDeposit
  with
    pendingCid   : ContractId PendingDeposit
    evmSignature : EvmSignature
  controller issuer
  do
    pending <- fetch pendingCid
    archive pendingCid
    create SignedDeposit with
      issuer
      requester    = pending.requester
      erc20Address = pending.erc20Address
      amount       = pending.amount
      requestId    = pending.requestId
      path         = pending.path
      evmParams    = pending.evmParams
      evmSignature
```

### New: `ReportSubmission` choice

Relayer reports Ethereum confirmation. Transitions SignedDeposit → SubmittedDeposit.

```daml
nonconsuming choice ReportSubmission : ContractId SubmittedDeposit
  with
    signedCid : ContractId SignedDeposit
    ethTxHash : BytesHex
  controller issuer
  do
    signed <- fetch signedCid
    archive signedCid
    create SubmittedDeposit with
      issuer
      requester    = signed.requester
      erc20Address = signed.erc20Address
      amount       = signed.amount
      requestId    = signed.requestId
      ethTxHash
```

### Modified: `ClaimDeposit` choice — consume `SubmittedDeposit`

Now takes a `SubmittedDeposit` contract ID (not `PendingDeposit`).

```daml
nonconsuming choice ClaimDeposit : ContractId Erc20Holding
  with
    submittedCid : ContractId SubmittedDeposit
    mpcSignature : MpcSignature
    mpcOutput    : BytesHex
  controller issuer
  do
    submitted <- fetch submittedCid
    archive submittedCid

    assertMsg "MPC public key mismatch"
      (mpcSignature.publicKey == mpcPublicKey)

    let responseHash = computeResponseHash submitted.requestId mpcOutput
    assertMsg "Invalid MPC signature on deposit response"
      (verifyMpcSignature mpcSignature responseHash)

    create Erc20Holding with
      issuer
      owner        = submitted.requester
      erc20Address = submitted.erc20Address
      amount       = submitted.amount
```

## TypeScript Modules

### Address Derivation (`client/src/mpc/address-derivation.ts`)

Ports `deriveChildPublicKey` from `signet.js` (see
`contract/node_modules/signet.js/dist/index.js:144-157`).

```typescript
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, type Hex } from "viem";

const EPSILON_DERIVATION_PREFIX = "sig.network v2.0.0 epsilon derivation";

/**
 * Derive a child public key from an MPC root key + derivation params.
 *
 * Algorithm (from signet.js):
 *   derivationPath = "{prefix}:{caip2Id}:{predecessorId}:{path}"
 *   epsilon = keccak256(derivationPath)
 *   childPublicKey = rootPublicKeyPoint + (epsilon × G)
 *
 * Reference: solana-contract-examples/contract/programs/.../src/crypto.rs:15-48
 */
export function deriveChildPublicKey(
  rootPubKey: Hex,       // "0x04..." uncompressed secp256k1 (65 bytes)
  predecessorId: string,
  path: string,
  caip2Id: string,
  keyVersion: number,
): Hex

/**
 * Convert uncompressed public key to Ethereum address.
 * address = keccak256(pubkey_x || pubkey_y)[12..32]
 *
 * Reference: solana-contract-examples/contract/programs/.../src/crypto.rs:40-48
 */
export function publicKeyToEthAddress(uncompressedPubKey: Hex): Hex
```

Dependency: `@noble/curves` (transitive dep of `viem`, made explicit).

### EVM Transaction Builder (`client/src/evm/tx-builder.ts`)

Mirrors `solana-contract-examples/contract/tests/sign-respond-erc20.ts:44-105`
(the `EthereumUtils.buildTransferTransaction` method) and
`solana-contract-examples/frontend/lib/evm/tx-builder.ts`.

```typescript
/**
 * Build an unsigned EIP-1559 ERC20 transfer transaction.
 * Fetches nonce + gas estimate from Sepolia RPC.
 *
 * Returns:
 * - unsignedTx: structured fields for reconstruction
 * - serializedUnsigned: RLP-encoded for signing (tx hash input)
 * - evmParams: hex fields formatted for Canton's RequestDeposit
 */
export async function buildErc20TransferTx(params: {
  from: Hex;
  to: Hex;
  erc20Address: Hex;
  amount: bigint;
  rpcUrl: string;
}): Promise<{
  unsignedTx: UnsignedErc20Transfer;
  serializedUnsigned: Hex;
  evmParams: CantonEvmParams;
}>

/**
 * Reconstruct a full signed EVM transaction from unsigned params + signature.
 * Used by the relayer after reading SignedDeposit from Canton.
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

Combines the key derivation from `signet.js` with the signing that
`fakenet-signer`'s `ChainSignatureServer` performs internally.

```typescript
/**
 * Derive a child private key for signing EVM transactions.
 *
 *   epsilon = keccak256(derivationPath)
 *   childKey = (rootPrivateKey + epsilon) mod n
 *
 * This is the private-key counterpart to deriveChildPublicKey.
 * Reference: solana-contract-examples contract/node_modules/signet.js/dist/index.js
 */
export function deriveChildPrivateKey(
  rootPrivateKey: Hex,
  predecessorId: string,
  path: string,
  caip2Id: string,
): Hex

/**
 * Sign an EVM transaction hash with a secp256k1 private key.
 * Returns { r, s, v } components for Canton's EvmSignature type.
 *
 * Reference: what fakenet-signer does internally when processing
 * a SignBidirectionalEvent from the Chain Signatures program.
 */
export function signEvmTxHash(
  privateKey: Hex,
  txHash: Hex,
): { r: string; s: string; v: number }  // bare hex, no 0x (Daml format)

/**
 * Sign the MPC response for Canton's ClaimDeposit.
 *
 *   responseHash = keccak256(requestId || mpcOutput)
 *   signature = secp256k1_sign(responseHash, rootPrivateKey)
 *
 * Returns DER-encoded signature + SPKI-encoded public key (Daml format).
 * Both are bare hex without 0x prefix.
 *
 * Reference: solana-contract-examples/contract/programs/.../src/crypto.rs
 * (verify_signature_from_address, hash_message)
 */
export function signMpcResponse(
  rootPrivateKey: Hex,
  requestId: string,   // bare hex from Canton
  mpcOutput: string,   // bare hex, e.g. "01" for success
): { signature: string; publicKey: string }
```

**DER encoding detail:** Daml's `secp256k1WithEcdsaOnly` expects:
- Signature: DER format `30 <len> 02 <r-len> <r> 02 <s-len> <s>`
- Public key: SubjectPublicKeyInfo format
  `3056301006072a8648ce3d020106052b8104000a034200 04<x><y>`

`@noble/curves` provides `sig.toDERHex()` for signature encoding. The SPKI
prefix for secp256k1 is a fixed 26-byte header (see the `TEST_PUB_KEY` in
`client/src/test/crypto.test.ts:82-83`).

### MPC Service (`client/src/mpc-service/`)

The Canton equivalent of `fakenet-signer`. Runs as a standalone process.

```
client/src/mpc-service/
├── index.ts                        Entry point: starts both watchers
├── pending-deposit-handler.ts      Watches PendingDeposit → ProvideSignature
├── submitted-deposit-handler.ts    Watches SubmittedDeposit → ClaimDeposit
└── signer.ts                       Key derivation + signing
```

**pending-deposit-handler.ts** — PendingDeposit watcher:
```
On PendingDeposit created:
  1. Read: path, evmParams, requestId, contractId
  2. Build unsigned EVM tx from evmParams → compute tx hash
  3. Derive child private key: epsilon = keccak256(derivationPath),
     childKey = (rootPrivateKey + epsilon) mod n
  4. Sign tx hash with child private key → { r, s, v }
  5. Exercise ProvideSignature(pendingCid, evmSignature)
     → creates SignedDeposit on Canton
```

**submitted-deposit-handler.ts** — SubmittedDeposit watcher:
```
On SubmittedDeposit created:
  1. Read: ethTxHash, requestId, contractId
  2. Fetch ETH receipt from Sepolia RPC (read-only)
  3. Verify receipt.status === 1
  4. mpcOutput = "01" (success)
  5. responseHash = keccak256(requestId || mpcOutput)
  6. Sign responseHash with root private key → DER signature
  7. Exercise ClaimDeposit(submittedCid, mpcSignature, mpcOutput)
     → creates Erc20Holding on Canton
```

Both watchers use `createLedgerStream` from `client/src/infra/ledger-stream.ts`
(WebSocket with HTTP polling fallback), the same mechanism demonstrated in
`client/src/scripts/demo.ts`.

**Environment variables:**
```
MPC_ROOT_PRIVATE_KEY=0x...           secp256k1 private key
SEPOLIA_RPC_URL=https://...          read-only (receipt verification)
PREDECESSOR_ID=canton-vault          fixed derivation predecessor
CAIP2_ID=eip155:11155111             Sepolia chain identifier
CANTON_JSON_API_URL=http://localhost:7575
```

### Relayer Service (`client/src/relayer/`)

Separate process. Holds no private keys.

```
client/src/relayer/
├── index.ts                        Entry point: starts watcher
└── signed-deposit-handler.ts       Watches SignedDeposit → ReportSubmission
```

**signed-deposit-handler.ts** — SignedDeposit watcher:
```
On SignedDeposit created:
  1. Read: evmParams, evmSignature (r, s, v), contractId
  2. Reconstruct full EVM tx from evmParams fields
  3. Attach signature → serialize signed tx
  4. Submit to Sepolia: eth_sendRawTransaction
  5. Wait for receipt (poll every 3s, timeout 120s)
  6. Exercise ReportSubmission(signedCid, ethTxHash)
     → creates SubmittedDeposit on Canton
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
    // Pure crypto — no Canton, no Sepolia.
    // Cross-check with signet.js known vectors.
  });

  it("derives different addresses for different paths", () => {
    // path="user-a" vs path="user-b" → different addresses.
  });

  it("deposit address differs from signer (vault) address", () => {
    // path=userPath vs path="root" → different addresses.
  });

  it("request ID matches between TypeScript and Canton", async () => {
    // Exercise RequestDeposit, compare Canton's requestId with TS computation.
    // Extends existing cross-runtime test in crypto.test.ts.
  });

  it("completes full deposit lifecycle", async () => {
    // Step 1: Derive addresses (public key only)
    const depositAddr = deriveDepositAddress(MPC_PUB_KEY, PREDECESSOR_ID, userPath);
    const signerAddr  = deriveDepositAddress(MPC_PUB_KEY, PREDECESSOR_ID, "root");

    // Step 2: Build evmParams (fetch nonce + gas from Sepolia — read-only)
    const { evmParams } = await buildErc20TransferTx({
      from: depositAddr, to: signerAddr,
      erc20Address: ERC20_ADDRESS, amount: depositAmount,
      rpcUrl: SEPOLIA_RPC_URL,
    });

    // Step 3: Exercise RequestDeposit on Canton
    await exerciseChoice(..., "RequestDeposit", {
      requester: depositor, erc20Address, amount, path: userPath, evmParams,
    });

    // Step 4: Wait for MPC + Relayer to process autonomously
    //   PendingDeposit → SignedDeposit → SubmittedDeposit → Erc20Holding
    const holding = await pollForContract("Erc20Holding", depositor, 180_000);

    // Step 5: Assert final state
    expect(holding.amount).toBe(depositAmount);
    expect(holding.owner).toBe(depositor);
    expect(holding.erc20Address).toBe(erc20Address);
  }, 180_000);  // 3 min timeout for Sepolia confirmation
});
```

## File Structure

```
canton-mpc-poc/
├── daml/
│   ├── Erc20Vault.daml              MODIFY: add path, SignedDeposit, SubmittedDeposit,
│   │                                        ProvideSignature, ReportSubmission,
│   │                                        modify ClaimDeposit
│   ├── Types.daml                   MODIFY: add EvmSignature
│   ├── Crypto.daml                  unchanged
│   └── Test.daml                    UPDATE: add path to test fixtures
│
├── client/
│   ├── src/
│   │   ├── config/
│   │   │   └── env.ts                        NEW: shared env loading
│   │   ├── evm/
│   │   │   └── tx-builder.ts                 NEW: build/reconstruct/submit EVM txs
│   │   ├── infra/
│   │   │   ├── canton-client.ts              EXTEND: getActiveContracts
│   │   │   └── ledger-stream.ts              unchanged
│   │   ├── mpc/
│   │   │   ├── crypto.ts                     unchanged
│   │   │   └── address-derivation.ts         NEW: deriveChildPublicKey
│   │   ├── mpc-service/
│   │   │   ├── index.ts                      NEW: MPC service entry point
│   │   │   ├── pending-deposit-handler.ts    NEW: PendingDeposit → ProvideSignature
│   │   │   ├── submitted-deposit-handler.ts  NEW: SubmittedDeposit → ClaimDeposit
│   │   │   └── signer.ts                     NEW: key derivation + signing
│   │   ├── relayer/
│   │   │   ├── index.ts                      NEW: Relayer entry point
│   │   │   └── signed-deposit-handler.ts     NEW: SignedDeposit → ReportSubmission
│   │   ├── scripts/
│   │   │   ├── demo.ts                       unchanged
│   │   │   └── derive-address.ts             NEW: print deposit address
│   │   └── test/
│   │       ├── crypto.test.ts                UPDATE: add path to RequestDeposit calls
│   │       ├── address-derivation.test.ts    NEW: address derivation unit tests
│   │       └── deposit-e2e.test.ts           NEW: E2E deposit test
│   │
│   └── package.json                          ADD: @noble/curves, scripts
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
+   "@noble/curves": "^1.9.0",
  }
```

`@noble/curves` is a transitive dep of `viem` but imported directly for
secp256k1 point math (`ProjectivePoint`) and DER signature encoding.

## Execution Order

| # | Phase | Depends On | Scope |
|---|-------|-----------|-------|
| 1 | Daml: add `path`, `EvmSignature`, `SignedDeposit`, `SubmittedDeposit`, new choices | — | ~60 lines |
| 2 | Rebuild DAR + codegen (`dpm build && dpm codegen-js ...`) | 1 | — |
| 3 | Address derivation module + tests | — | ~80 lines |
| 4 | EVM tx builder | — | ~120 lines |
| 5 | MPC signer module | 3 (shares epsilon) | ~100 lines |
| 6 | Env config | — | ~40 lines |
| 7 | Canton client: getActiveContracts | — | ~30 lines |
| 8 | MPC service (two watchers) | 4, 5, 6 | ~150 lines |
| 9 | Relayer service (one watcher) | 4, 6 | ~100 lines |
| 10 | Derive-address script | 3 | ~30 lines |
| 11 | Update existing tests (add `path`) | 2 | ~10 lines |
| 12 | E2E deposit test | 3, 4, 6, 7 | ~120 lines |

Phases 1, 3, 4, 6 are independent and can be built in parallel. Phase 2 must
follow 1. Phases 8 and 9 integrate the shared modules. Phase 12 ties
everything together.

## Prerequisites

1. **MPC root private key** (secp256k1 hex) → MPC service env only
2. **MPC root public key** (uncompressed `04...` AND SPKI DER format) → test config + Canton VaultOrchestrator
3. **Sepolia RPC URL** (Infura or Alchemy) → all services
4. **Agreed `predecessorId`** string (e.g., `"canton-vault"`)
5. **After phase 10:** run `npm run derive-address` → fund the printed address with USDC on Sepolia
6. **Runtime:** Canton sandbox + MPC service + relayer all running before test

## Crypto Details

### Address Derivation

Same algorithm as `signet.js` and `solana-contract-examples/contract/programs/.../src/crypto.rs`:

```
derivationPath = "sig.network v2.0.0 epsilon derivation:{caip2Id}:{predecessorId}:{path}"
epsilon = keccak256(derivationPath)                      // 32-byte scalar
childPublicKey = rootPublicKeyPoint + (epsilon × G)      // secp256k1 point addition
ethAddress = keccak256(childPublicKey.x ‖ childPublicKey.y)[12..32]
```

For deposits: `path = userPath` (caller-supplied, stored in PendingDeposit).
For the vault receiver: `path = "root"` (hardcoded).

### Request ID

Canton uses `keccak256(packParams(evmParams))` — simpler than Solana's
`keccak256(encodePacked(sender, rlpTx, caip2Id, keyVersion, path, ...))`.
This is sufficient because Canton's request ID only needs to be deterministic
and consistent between TypeScript and Daml (already verified by existing
cross-runtime tests in `crypto.test.ts`).

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

### EVM Transaction Signing

```
childPrivateKey = (rootPrivateKey + epsilon) mod n       // scalar addition
txHash = keccak256(serializedUnsignedTx)                 // EIP-1559 RLP
{r, s, v} = secp256k1_sign(txHash, childPrivateKey)
```

The relayer reconstructs: `signedTx = serialize(unsignedTx, {r, s, v})` and
submits via `eth_sendRawTransaction`.

## Existing Tests Impact

The three existing test suites in `crypto.test.ts` need a one-line update each
to pass the new `path` field in `RequestDeposit` calls:

```diff
  "RequestDeposit",
  {
    requester: depositor,
    erc20Address: damlEvmParams.erc20Address,
    amount: "100000000",
+   path: "test-depositor",
    evmParams: damlEvmParams,
  },
```
