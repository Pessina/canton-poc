# ContractId vs PackageId: Replacing packageId with contractId in the Deposit Flow

## Problem

The current `E2E_DEPOSIT_PLAN_COMPACT.md` proposal uses `packageId` (the DAR's
SHA-256 content hash) as the uniqueness anchor for `computeRequestId` and as
`predecessorId` for MPC key derivation. This has a critical limitation:

> "multiple VaultOrchestrator deployments produce unique requestIds even with the
> same (requester, evmParams, path), **as long as the issuer deploys a single
> contract package per instance**."

If two VaultOrchestrator contracts are created from the **same DAR**, they share
the same `packageId`, producing identical `requestId` values and identical
derived deposit addresses. The workaround — recompiling a separate DAR per vault
instance — is operationally impractical.

## Proposal

Replace `packageId` with the VaultOrchestrator's own `contractId` (passed as
`Text` from the Ledger API). ContractId is globally unique per contract instance,
eliminating the "single package per instance" constraint.

### What Changes

| Component | Before (packageId) | After (contractId) |
|---|---|---|
| `PendingEvmDeposit.packageId` | DAR hash (same for all contracts from one package) | VaultOrchestrator's contractId (unique per instance) |
| `computeRequestId` last param | `packageId : Text` | `orchestratorCid : Text` |
| `RequestEvmDeposit` param | `packageId : Text` | `orchestratorCid : Text` |
| MPC `predecessorId` | `event.templateId.split(":")[0]` | VaultOrchestrator's contractId (from exercise event or config) |
| Key derivation input | packageId | contractId |
| User address derivation | `packageId` from codegen | contractId from `CreatedEvent.contractId` |

### Comparison

| Property | packageId | contractId |
|---|---|---|
| Uniqueness scope | Per compiled DAR (code-level) | Per contract instance (globally unique) |
| Two VaultOrchestrators from same DAR | **Same** — collision | **Different** — unique |
| Known before contract creation | Yes (from codegen) | No (assigned at creation) |
| MPC observable from ledger events | `event.templateId.split(":")[0]` | `event.contractId` |
| Deterministic across rebuilds | Only with `-j=1` and same SDK version | N/A (runtime-assigned) |
| Survives contract recreation | Yes (same package = same ID) | No (new contract = new ID) |

## ContractId Is Opaque On-Ledger

A Daml `ContractId` **cannot be read as text inside a choice body**. This is a
fundamental property of Canton's protocol, not a bug.

### What happens when you try

```daml
-- Inside a choice on VaultOrchestrator:
let cidText = show self  -- returns "<contract-id>", NOT the actual ID
```

The Daml-LF builtin `CONTRACT_ID_TO_TEXT` is specified to **always return
`None` on-ledger**. The `Show` instance then renders the placeholder
`"<contract-id>"`.

Source code from `DA/Internal/LF.daml`:

```haskell
instance Show (ContractId a) where
  show cid = case primitive @"BEContractIdToText" cid of
    None -> "<contract-id>"
    Some t -> t
```

- [Source: DA/Internal/LF.daml](https://github.com/digital-asset/daml/blob/main/sdk/compiler/damlc/daml-stdlib-src/DA/Internal/LF.daml)
- [Source: SBuiltinFun.scala](https://github.com/digital-asset/canton/blob/main/community/daml-lf/interpreter/src/main/scala/com/digitalasset/daml/lf/speedy/SBuiltinFun.scala) — `SBContractIdToText` returns `None` in `UpdateMachine`

### Why it's opaque: Canton's transaction pipeline

```
[1] Engine INTERPRETS the command
    - Derives discriminator (32-byte HMAC from node seed) — KNOWN
    - Suffix (Unicum) — DOES NOT EXIST YET
    - CONTRACT_ID_TO_TEXT returns None
    - show contractId => "<contract-id>"

[2] Canton VIEW DECOMPOSITION (post-interpretation)
    - Transaction split into privacy-preserving views
    - View positions assigned

[3] UNICUM COMPUTATION (post-interpretation, bottom-up)
    - ContractSalt = blindedHash(domainId, mediatorId, txUUID,
                                  viewPosition, createIndex, viewSalt)
    - Unicum = hash(ContractSalt, ledgerTime, suffixedContractInstance)
    - Contract ID becomes COMPLETE: discriminator + Unicum

[4] VALIDATORS re-interpret to verify — same circular dependency

[5] COMMIT: final contract IDs persisted to ledger
```

The Unicum depends on **domain ID, mediator ID, transaction UUID, view
position, and ledger time** — none of which exist at step [1] when the choice
body executes.

### Three reasons it must be opaque

1. **Compositionality.** If `show` returned the real ID for pre-existing
   contracts but `"<contract-id>"` for newly created ones, the same Daml code
   would behave differently depending on whether a contract was created inside
   or outside the current transaction.

2. **Validator re-interpretation.** Canton validators re-interpret transactions
   to verify conformance. If `show` returned the final suffixed ID, validators
   would need to know the final IDs *before* interpretation — but they derive
   those IDs *through* interpretation. Circular dependency.

3. **Privacy.** The Unicum is a blinded hash that protects contract details
   from non-witnesses. Exposing it via `show` would let contract code embed the
   ID in arguments visible to non-witness parties, undermining sub-transaction
   privacy.

### Official sources

- [Forum: Why showing a contractId on ledger results in `<contract-id>`](https://discuss.daml.com/t/why-showing-a-contractid-on-ledger-results-in-contract-id-value/6397) — cocreature (DA): "contract ids have to be opaque and only support a limited number of operations that are preserved under suffixing (equality & ordering)"
- [Forum: Display contractid in DAML script](https://discuss.daml.com/t/display-contractid-in-daml-script/1727) — Bernhard (DA): "At the time of interpretation on the participant node, the transaction ID isn't known yet, so the final contract ids are also not known"
- [GitHub Issue #8860](https://github.com/digital-asset/daml/issues/8860) — `SBToTextContractId` returns None on-ledger by design
- [GitHub Issue #9497](https://github.com/digital-asset/daml/issues/9497) — ContractId in keys deprioritized; "would interfere with some optimization we have or plan to have"

### No proposals to change this

There are no public proposals or RFCs to make contract IDs non-opaque on-ledger.
Digital Asset treats this as working-as-intended, and the opaqueness is
load-bearing for planned protocol optimizations.

## Workaround: Caller Passes contractId as Text

Since `self` is opaque on-ledger, the caller must pass the VaultOrchestrator's
contractId as a `Text` parameter. The MPC verifies it against `event.contractId`
on the `CreatedEvent` from the ledger — the same trust model as the current
`packageId` approach.

### Daml side

```daml
nonconsuming choice RequestEvmDeposit : ContractId PendingEvmDeposit
  with
    requester      : Party
    path           : Text
    evmParams      : EvmTransactionParams
    orchestratorCid : Text         -- caller passes VaultOrchestrator's contractId
  controller issuer, requester
  do
    -- Cannot verify orchestratorCid == show self (opaque on-ledger)
    -- MPC verifies against event.contractId on the ledger

    assertMsg "Only ERC20 transfer allowed"
      (evmParams.functionSignature == "transfer(address,uint256)")
    assertMsg "Transfer recipient must be vault address"
      (evmParams.args !! 0 == vaultAddress)

    let caip2Id = "eip155:" <> chainIdToDecimalText evmParams.chainId
    let requestId = computeRequestId
          (partyToText requester) evmParams caip2Id 1 path orchestratorCid
    create PendingEvmDeposit with
      issuer; requester; requestId; path; evmParams; orchestratorCid
```

### MPC side (TypeScript)

```typescript
// deposit-handler.ts — on PendingEvmDeposit created:
const predecessorId = orchCid;  // VaultOrchestrator's contractId (from config or event)

// Verify the user-supplied value matches the actual orchestrator
const pendingOrchestratorCid = pending.orchestratorCid;
if (pendingOrchestratorCid !== orchCid) {
  log.warn("orchestratorCid mismatch — dropping request");
  return;
}
```

### User side (TypeScript)

```typescript
// demo.ts
const orchCid = orchestratorEvent.contractId;  // from CreatedEvent
const predecessorId = orchCid;

// Derive deposit address
const depositAddress = deriveDepositAddress(rootPubKey, predecessorId, path, caip2Id);

// Exercise RequestEvmDeposit
await exerciseChoice(orchCid, "RequestEvmDeposit", {
  requester,
  path,
  evmParams,
  orchestratorCid: orchCid,
});
```

## ContractId Stability Guarantees

### Formal ledger model

> "When a contract is committed to the ledger, it is given a unique contract
> identifier of type `ContractId`."
> — [Ledger Structure](https://docs.daml.com/concepts/ledger-model/ledger-structure.html)

The formal model defines only **Create** and **Exercise/Archive** — no "update
contractId" action exists. Once assigned, a contractId is immutable for the
contract's lifetime.

### Canton protocol (cryptographic guarantee)

> "If a transaction is added to the virtual domain ledger for a given domain,
> then the Unicum is globally unique unless a hash collision occurs."
> — [UnicumGenerator Scaladoc](https://docs.daml.com/2.6.5/canton/scaladoc/com/digitalasset/canton/protocol/UnicumGenerator.html)

Contract IDs are SHA-256 based cryptographic commitments — stronger than
typical database primary keys.

### Contract ID binary structure

From the [contract-id.rst specification](https://github.com/digital-asset/canton/blob/main/community/daml-lf/spec/contract-id.rst):

**V1** (prefix `0x00`):
```
ContractID := 0x00 || discriminator(32 bytes) || suffix(0-94 bytes)
```
Hex string: 66–254 characters. Typical: ~136 characters.

**V2** (prefix `0x01`):
```
ContractID := 0x01 || timePrefix(5 bytes) || shortenedSeed(7 bytes) || suffix(0-33 bytes)
```
Hex string: max 92 characters.

Both versions are lowercase hex (`[0-9a-f]`), well within Daml `Text` limits.

### Ledger API format

- `contractId` is a **required `string` field** on both `CreatedEvent` and
  `ExercisedEvent` in the Ledger API protobuf
- Format has been consistent across **all SDK versions from 1.x through 3.x**
- [Ledger API Proto Docs](https://docs.daml.com/app-dev/grpc/proto-docs.html)
- [Canton 3.4 Proto Docs](https://docs.digitalasset.com/build/3.4/reference/lapi-proto-docs)

### No deprecation of existing IDs

Daml 3.3's move to "hashing algorithm V2" affects **only new contract
creation**, not existing IDs. No existing contractId has ever been invalidated
by a version upgrade.

- [Daml 3.3 Release Notes](https://blog.digitalasset.com/developers/release-notes/canton-daml-3.3-preview)

### Formal verification

Digital Asset has ongoing **Isabelle/HOL proofs** verifying Canton's integrity
properties, including contract ID guarantees.

- [Research Publications](https://docs.daml.com/canton/architecture/research.html)

### The "unstable" caveat in docs

When Daml docs say contract IDs are "very unstable," they mean: if you
**archive and recreate** a contract, the new one gets a different ID. The old
ID still correctly identifies the (now-archived) contract. For
VaultOrchestrator (which only uses nonconsuming choices and is never archived
during normal operation), this is irrelevant.

## Trade-offs

### Advantage: True per-instance uniqueness

Two VaultOrchestrators from the same DAR get different contractIds. No need for
separate DARs per vault instance.

### Advantage: Simpler operations

No need to manage packageId stability across recompilations. PackageId is only
deterministic with `-j=1` and the same SDK version
([forum](https://discuss.daml.com/t/packageid-hash-changes-without-daml-code-change/6073)).

### Trade-off: Not known before creation

ContractId is assigned at creation time, not at compile time. The user cannot
derive deposit addresses until the VaultOrchestrator exists. This is a
non-issue in practice: the orchestrator is created once during setup, before
any deposits.

### Trade-off: Changes on contract recreation

If the VaultOrchestrator is ever archived and recreated (e.g., during a
migration), the contractId changes, which changes all derived deposit
addresses. However:

- VaultOrchestrator uses only nonconsuming choices — archival would only happen
  during a deliberate migration
- Any such migration would require address migration regardless
- The same would be true with packageId if the DAR changes

### Trust model is unchanged

The Daml contract cannot verify `orchestratorCid` against `self` (opaque
on-ledger). The MPC service verifies it against `event.contractId` from the
Ledger API. This is the **same trust model** as the current `packageId`
approach, where the MPC verifies `packageId` against
`event.templateId.split(":")[0]`.

## Summary of Official Sources

### ContractId stability and uniqueness

| Source | URL |
|---|---|
| Ledger Model: Structure | https://docs.daml.com/concepts/ledger-model/ledger-structure.html |
| Ledger Model: Integrity | https://docs.daml.com/concepts/ledger-model/ledger-integrity.html |
| UnicumGenerator Scaladoc | https://docs.daml.com/2.6.5/canton/scaladoc/com/digitalasset/canton/protocol/UnicumGenerator.html |
| ContractSalt Scaladoc | https://docs.daml.com/canton/scaladoc/com/digitalasset/canton/protocol/ContractSalt.html |
| Contract ID Spec (contract-id.rst) | https://github.com/digital-asset/canton/blob/main/community/daml-lf/spec/contract-id.rst |
| Daml-LF Spec (daml-lf-2.rst) | https://github.com/digital-asset/daml/blob/main/sdk/canton/community/daml-lf/spec/daml-lf-2.rst |
| Ledger API Proto Docs | https://docs.daml.com/app-dev/grpc/proto-docs.html |
| Canton 3.4 Proto Docs | https://docs.digitalasset.com/build/3.4/reference/lapi-proto-docs |
| Daml 3.3 Release Notes | https://blog.digitalasset.com/developers/release-notes/canton-daml-3.3-preview |
| Formal Verification (Isabelle/HOL) | https://docs.daml.com/canton/architecture/research.html |
| Canton Whitepaper | https://www.canton.io/publications/canton-whitepaper.pdf |

### ContractId opaqueness

| Source | URL |
|---|---|
| Forum: Why opaque on-ledger | https://discuss.daml.com/t/why-showing-a-contractid-on-ledger-results-in-contract-id-value/6397 |
| Forum: Display contractId | https://discuss.daml.com/t/display-contractid-in-daml-script/1727 |
| Forum: Hash-based contract ID scheme | https://discuss.daml.com/t/benefits-of-the-new-hash-based-contract-id-scheme/389 |
| Forum: Contract ID generation | https://discuss.daml.com/t/contract-content-and-contract-id-generation/6923 |
| Forum: PackageId non-determinism | https://discuss.daml.com/t/packageid-hash-changes-without-daml-code-change/6073 |
| GitHub: Show instance (DA/Internal/LF.daml) | https://github.com/digital-asset/daml/blob/main/sdk/compiler/damlc/daml-stdlib-src/DA/Internal/LF.daml |
| GitHub: SBContractIdToText | https://github.com/digital-asset/canton/blob/main/community/daml-lf/interpreter/src/main/scala/com/digitalasset/daml/lf/speedy/SBuiltinFun.scala |
| GitHub Issue #8860 | https://github.com/digital-asset/daml/issues/8860 |
| GitHub Issue #9497 | https://github.com/digital-asset/daml/issues/9497 |
