# External Signing: Unique Transaction Identifier for MPC Verification

Canton's Interactive Submission Service provides a unique, globally stable
identifier (`preparedTransactionHash` / `externalTransactionHash`) that enables
the same "user provides, MPC verifies" pattern used today with `packageId`.

This document covers the mechanism, trust model, setup requirements, and how it
integrates into the existing deposit flow.

## Problem

The deposit flow needs a Canton-sourced unique identifier per
`PendingEvmDeposit` instance that:

1. The user knows **before** transaction execution
2. Is **globally unique**
3. The MPC can **observe from committed transaction logs**
4. Both sides can **independently verify** the same value

Today's `requestId` (keccak256 of user-supplied inputs) satisfies 1-3 but is
derived from user inputs, not Canton infrastructure. The `packageId` pattern
works because it binds to Canton ledger metadata — we want the same for a
per-transaction identifier.

## Solution: `preparedTransactionHash` via Interactive Submission

Canton 3.3+ provides the
[Interactive Submission Service](https://docs.digitalasset.com/build/3.4/explanations/external-signing/external_signing_overview.html)
which splits command submission into **prepare** and **execute** steps. The
prepare step returns a cryptographic hash of the entire transaction
(`preparedTransactionHash`) that becomes `externalTransactionHash` on the
committed transaction — visible to all observers.

### Identifier Lifecycle

```
 User                         Canton Participant              MPC Service
 |                            |                               |
 | PrepareSubmission          |                               |
 | (RequestEvmDeposit cmd)    |                               |
 |--------------------------->|                               |
 |                            |                               |
 |<--- preparedTransaction ---|                               |
 |<--- preparedTransactionHash|                               |
 |<--- transaction_uuid       |                               |
 |                            |                               |
 | (inspect tx, recompute     |                               |
 |  hash if PPN untrusted)    |                               |
 |                            |                               |
 | sign(preparedTxHash)       |                               |
 | ExecuteSubmission           |                               |
 |--------------------------->|                               |
 |                            |                               |
 |                            | commit transaction            |
 |                            |                               |
 |                            | Transaction committed         |
 |                            | externalTransactionHash =     |
 |                            |   preparedTransactionHash     |
 |                            |                               |
 |                            |------- update stream -------->|
 |                            |                               |
 |                            |              reads externalTransactionHash
 |                            |              from committed Transaction
 |                            |                               |
 |                            |              verifies:
 |                            |              user-provided hash ==
 |                            |              externalTransactionHash
 |                            |                               |
```

### Correlation Guarantee

The Canton conformance test suite directly asserts equality:

```scala
// InteractiveSubmissionServiceIT.scala (Canton source)
assert(transaction.externalTransactionHash.contains(prepareResponse.preparedTransactionHash))
```

And the integration test confirms:

```scala
// InteractiveSubmissionIntegrationTest.scala (Canton source)
transaction.externalTransactionHash shouldBe Some(prepared.preparedTransactionHash)
```

**Source**: [Canton GitHub — digital-asset/canton](https://github.com/digital-asset/canton),
`InteractiveSubmissionServiceIT.scala` and `InteractiveSubmissionIntegrationTest.scala`

## What's Inside the Hash

The hash is computed using Canton's deterministic hashing scheme (V2/V3):

```
SHA256(
  hash_purpose (0x00000030) ||
  hashing_scheme_version    ||
  transaction_hash          ||     ← hash of all Daml ledger effects (creates, exercises, fetches)
  metadata_hash                    ← hash of submission metadata
)
```

The **metadata hash** includes:

| Field | Description |
|---|---|
| `act_as` | Submitting parties |
| `command_id` | User-provided command identifier |
| `transaction_uuid` | **Randomly generated per prepare call** — ensures global uniqueness |
| `mediator_group` | Which mediator group processes the transaction |
| `synchronizer_id` | Target synchronizer |
| `preparation_time` | Timestamp of preparation |
| `input_contracts` | Contracts read during interpretation |
| `min/max_ledger_effective_time` | Ledger time bounds |

Because `transaction_uuid` is randomly generated per `prepare` call, two
preparations of the same command produce **different hashes**. However, once a
`preparedTransaction` blob is returned, the hash is **fully deterministic** and
**stable through commit**.

**Source**: [External Signing Hashing Algorithm](https://docs.digitalasset.com/build/3.5/explanations/external-signing/external_signing_hashing_algorithm.html)

## Stability: Pre vs Post Commit

| Question | Answer |
|---|---|
| Same command prepared twice = same hash? | **No** — `transaction_uuid` and `preparation_time` differ per call |
| Same `preparedTransaction` blob recomputed = same hash? | **Yes** — fully deterministic |
| `preparedTransactionHash` == `externalTransactionHash`? | **Yes** — confirmed by Canton tests |
| Can hash change between prepare and commit? | **No** — all inputs are fixed at prepare time |
| Is `externalTransactionHash` always populated? | **No** — only for externally signed transactions |

## MPC Visibility

`externalTransactionHash` is visible to **all observers** of the transaction,
not just the submitting party.

From the Canton source (`UpdateToDbDto.scala`), the hash is written to every
event row (creates, exercises) without party filtering. Compare this with
`commandId`, which IS filtered to only return to submitters. The
`externalTransactionHash` has no such restriction.

The Canton integration tests confirm this by reading the transaction stream as
an **observing party** and filtering by `externalTransactionHash`:

```scala
// BaseInteractiveSubmissionTest.scala (Canton source)
protected def findTransactionInStream(
    observingPartyE: ExternalParty,    // ← observer, not submitter
    beginOffset: Long = 0L,
    hash: ByteString,
    confirmingParticipant: ParticipantReference,
): Transaction = {
    val transactions =
      confirmingParticipant.ledger_api.updates.transactions(
        Set(observingPartyE.partyId),
        ...
        resultFilter = {
          case TransactionWrapper(transaction)
              if transaction.externalTransactionHash.contains(hash) =>
            true
```

**Source**: [Canton GitHub — `BaseInteractiveSubmissionTest.scala`](https://github.com/digital-asset/canton)

## Trust Model

The Interactive Submission Service defines three node roles with explicit trust
boundaries:

### PPN (Preparing Participant Node) — UNTRUSTED

Any participant node with the Daml packages uploaded. Does **not** need to host
the submitting party. The documentation states:

> "The user does not trust the PPN."

A malicious PPN can return a correct-looking transaction paired with a hash of a
different, malicious transaction. The defense:

> "Only provided for convenience, clients MUST recompute the hash from the raw
> transaction if the preparing participant is not trusted."

In practice: decode `preparedTransaction`, inspect it, then independently
compute the hash using the V2 hashing algorithm.

**Source**: [Submit Externally Signed Transactions](https://docs.digitalasset.com/build/3.4/tutorials/app-dev/external_signing_submission.html)

### EPN (Executing Participant Node) — MINIMALLY TRUSTED

Trusted only for command completions and TTL enforcement. Cannot forge
transactions or signatures.

### CPN (Confirming Participant Node) — THRESHOLD TRUSTED

Each CPN independently re-interprets the transaction, **recomputes the hash from
scratch**, verifies the external signature, and only then confirms. The hash
stored as `externalTransactionHash` is computed locally by each participant —
not blindly replicated.

```scala
// AuthenticationValidator.scala (Canton source)
def computeHashAndVerifyExternalSignature(
    externalAuthorization: ExternalAuthorization
): FutureUnlessShutdown[Either[AuthenticationError, Option[Hash]]] =
  reInterpretationET.value.value.flatMap {
    case Right(reInterpretedTopLevelView) =>
      reInterpretedTopLevelView.computeHash(
        hashingSchemeVersion = externalAuthorization.hashingSchemeVersion,
        actAs = submitterMetadata.actAs,
        commandId = submitterMetadata.commandId.unwrap,
        transactionUUID = viewTree.transactionUuid,
        ...
      )
      .flatMap { hash =>
        verifyExternalSignaturesForActAs(hash, externalAuthorization, submitterMetadata.actAs)
        ...
        .map(_.toLeft(Some(hash)))
      }
  }
```

**Source**: [Local and External Parties](https://docs.digitalasset.com/overview/3.4/explanations/canton/external-party.html),
[Canton GitHub — `AuthenticationValidator.scala`](https://github.com/digital-asset/canton)

## User Access: Retail User Can Call Prepare

Any client application with Ledger API access can call `PrepareSubmission`.
The PPN does not need to host the submitting party. The user only needs
`readAs` authorization scope.

The flow supports **offline signing**: one entity prepares online, passes the
hash to an air-gapped signing device, gets the signature back, and submits.
The private key never touches the network.

**Source**: [Preparing and Signing Transactions Using External Party](https://docs.digitalasset.com/integrate/devnet/preparing-and-signing-transactions/index.html),
[External Signing Overview](https://docs.digitalasset.com/build/3.4/explanations/external-signing/external_signing_overview.html)

## Setup Requirements: External Party Keys

The Interactive Submission Service requires parties with **external keys**.
The default sandbox setup uses internal keys (participant manages signing),
which is why `execute` fails with:

```
FAILED_TO_EXECUTE_TRANSACTION: The following actAs parties did not
provide an external signature
```

### Party Onboarding

External parties register their public key via topology transactions:

1. **NamespaceDelegation** — creates the party identity
2. **PartyToKeyMapping** — registers signing public key(s) and threshold
3. **PartyToParticipantMapping** — associates the party with confirming nodes

Canton 3.5 simplifies this to a single API call:

```
POST /v2/parties/external/generate-topology
POST /v2/parties/external/allocate
```

Supported key types: **Ed25519** or **ECDSA P-256**. Multi-key threshold
signing (e.g., 2-of-3) is supported.

**Source**: [Onboard External Party — Admin API](https://docs.digitalasset.com/build/3.4/tutorials/app-dev/external_signing_onboarding.html),
[Onboard External Party — Ledger API (3.5)](https://docs.digitalasset.com/build/3.5/tutorials/app-dev/external_signing_onboarding_lapi.html)

### Current Limitation: Single Party Submissions

The Interactive Submission Service currently supports **single party**
submissions only. The `PartySignatures` message accepts multiple
`SinglePartySignatures` entries, but the documentation notes:

> "Note that currently, only single party submissions are supported."

For multi-party choices (e.g., `controller issuer, requester`), only the
submitting party's signature goes through the interactive submission. The other
party's participant confirms via Canton's standard confirmation protocol.

**Source**: [Submit Externally Signed Transactions](https://docs.digitalasset.com/build/3.4/tutorials/app-dev/external_signing_submission.html)

## Integration with Deposit Flow

### Modified `PendingEvmDeposit`

Add `externalTxHash` field to store the user-provided hash:

```daml
template PendingEvmDeposit
  with
    issuer        : Party
    requester     : Party
    requestId     : BytesHex
    path          : Text
    evmParams     : EvmTransactionParams
    packageId     : Text
    externalTxHash : Text    -- preparedTransactionHash from prepare step
  where
    signatory issuer
    observer requester
```

### Modified `RequestEvmDeposit`

User passes `externalTxHash` as a choice argument:

```daml
nonconsuming choice RequestEvmDeposit : ContractId PendingEvmDeposit
  with
    requester      : Party
    path           : Text
    evmParams      : EvmTransactionParams
    packageId      : Text
    externalTxHash : Text
  controller issuer, requester
  do
    -- existing validations...
    create PendingEvmDeposit with
      issuer; requester; requestId; path; evmParams; packageId; externalTxHash
```

### MPC Verification (deposit-handler.ts)

The MPC reads `externalTxHash` from the contract AND `externalTransactionHash`
from the transaction metadata, then cross-checks:

```typescript
// In handlePendingEvmDeposit:
const contractExternalTxHash = args.externalTxHash as string;

// Read from the Transaction metadata (available on the update stream)
const txExternalHash = transaction.externalTransactionHash;

// Cross-check: user-provided value must match Canton metadata
if (contractExternalTxHash !== txExternalHash) {
  throw new Error(
    `externalTxHash mismatch: contract=${contractExternalTxHash} tx=${txExternalHash}`
  );
}
```

This mirrors the existing `packageId` pattern:
- **User provides** `externalTxHash` as a choice argument (stored on contract)
- **MPC reads** `externalTransactionHash` from the committed Transaction metadata
- **MPC cross-checks** the two values match

### User Flow (Updated)

```
1. Build evmParams, derive addresses (unchanged)
2. PrepareSubmission(RequestEvmDeposit command)
   -> get preparedTransactionHash
3. Sign preparedTransactionHash with external party key
4. ExecuteSubmission(preparedTransaction, signature)
   -> RequestEvmDeposit executes, creates PendingEvmDeposit with externalTxHash
5. MPC observes PendingEvmDeposit + Transaction metadata
   -> verifies externalTxHash == externalTransactionHash
   -> proceeds with signing flow
```

## PoC Status

The PoC at `client/src/scripts/tx-uuid-poc.ts` (`pnpm tx-uuid-poc`) confirmed:

- `prepare` succeeds and returns `preparedTransactionHash` + `transaction_uuid`
- `execute` fails because sandbox parties have internal keys
- `externalTransactionHash` is `null` when using normal `submit-and-wait`
- The fallback flow shows all available Transaction metadata fields

**Next step**: Configure external party keys on the sandbox to test the full
prepare -> sign -> execute -> observe -> verify flow end-to-end.

## Identifier Comparison

| Identifier | Source | Known Before Execution | Globally Unique | MPC Observable | Canton Metadata |
|---|---|---|---|---|---|
| `requestId` | User-computed keccak256 | Yes | Yes (if EVM nonce unique) | Yes (contract field) | No |
| `packageId` | Daml codegen | Yes | Per-package | Yes (event.templateId) | Yes |
| `preparedTransactionHash` | Canton prepare | Yes | Yes (contains random UUID) | Yes (`externalTransactionHash`) | Yes |
| `contractId` | Canton runtime | No (post-creation) | Yes | Yes | Yes |
| `updateId` | Canton runtime | No (post-commit) | Yes | Yes | Yes |
| `transaction_uuid` | Canton prepare | Yes (in blob) | Yes | No (not on Transaction) | Internal only |

## Official Documentation Links

- [External Signing Overview](https://docs.digitalasset.com/build/3.4/explanations/external-signing/external_signing_overview.html)
- [External Signing Hashing Algorithm](https://docs.digitalasset.com/build/3.5/explanations/external-signing/external_signing_hashing_algorithm.html)
- [Submit Externally Signed Transactions](https://docs.digitalasset.com/build/3.4/tutorials/app-dev/external_signing_submission.html)
- [Preparing and Signing Transactions](https://docs.digitalasset.com/integrate/devnet/preparing-and-signing-transactions/index.html)
- [Local and External Parties](https://docs.digitalasset.com/overview/3.4/explanations/canton/external-party.html)
- [Onboard External Party — Admin API](https://docs.digitalasset.com/build/3.4/tutorials/app-dev/external_signing_onboarding.html)
- [Onboard External Party — Ledger API (3.5)](https://docs.digitalasset.com/build/3.5/tutorials/app-dev/external_signing_onboarding_lapi.html)
- [Externally Signed Topology Transactions](https://docs.digitalasset.com/build/3.5/tutorials/app-dev/external_signing_topology_transaction.html)
- [Multi-Hosted External Party Onboarding](https://docs.digitalasset.com/build/3.4/tutorials/app-dev/external_signing_onboarding_multihosted.html)
- [gRPC Ledger API Services](https://docs.digitalasset.com/build/3.5/explanations/ledger-api-services.html)
- [Canton GitHub Repository](https://github.com/digital-asset/canton)
