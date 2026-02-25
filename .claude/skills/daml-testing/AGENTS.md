# Daml Testing Reference (Daml 3.x)

Complete guide to writing and running Daml Script tests. All examples target Daml 3.x
and follow current best practices.

---

## Table of Contents

1. [Running Tests](#running-tests)
2. [Test Module Structure](#test-module-structure)
3. [Party Allocation](#party-allocation)
4. [Contract Creation](#contract-creation)
5. [Exercising Choices](#exercising-choices)
6. [Multi-Party Submissions](#multi-party-submissions)
7. [Querying Contracts](#querying-contracts)
8. [Assertions](#assertions)
9. [Expected Failures](#expected-failures)
10. [Pattern: Full Lifecycle Test](#pattern-full-lifecycle-test)
11. [Pattern: Testing Refund / Failure Paths](#pattern-testing-refund--failure-paths)
12. [Pattern: Crypto Verification Tests](#pattern-crypto-verification-tests)
13. [Test Helpers Pattern](#test-helpers-pattern)
14. [Debugging Tips](#debugging-tips)
15. [Common Mistakes](#common-mistakes)

---

## Running Tests

```bash
# Run all tests in the project
dpm test

# Run tests in a specific file
dpm test --files daml/Test.daml
```

`dpm test` discovers every top-level function whose name starts with `test` and whose
type is `Script ()`. Each matching function is executed as an independent test case.

---

## Test Module Structure

```daml
module Test where

import Daml.Script
import MyModule  -- import your contract modules

-- Test functions must have type `Script ()` and start with `test`
testMyFeature : Script ()
testMyFeature = do
  -- test body
  pure ()
```

Key rules:

- The module name does **not** need to match the file name, but by convention it does.
- Every test function **must** have the exact type `Script ()`.
- The function name **must** begin with `test` (lowercase) to be auto-discovered.
- Import `Daml.Script` in every test module.
- Import the contract modules you need to test.

---

## Party Allocation

```daml
-- Allocate a party with a display name
issuer <- allocateParty "Issuer"
depositor <- allocateParty "Depositor"

-- Allocate with hint and display name
alice <- allocatePartyWithHint "Alice" (PartyIdHint "alice")
```

- `allocateParty` creates a fresh party each time the test runs.
- `allocatePartyWithHint` lets you control the party identifier string, which is
  useful for deterministic test output or when party IDs appear in hashed data.
- Never hardcode party literal strings; always allocate parties dynamically.

---

## Contract Creation

```daml
-- Create a contract (submit as the signatory)
orchCid <- submit issuer do
  createCmd VaultOrchestrator with
    issuer
    mpcPublicKey = testPubKeyHex

-- Create returns ContractId
balCid <- submit issuer do
  createCmd Erc20Holding with
    issuer
    owner = user
    erc20Address = "a0b86991..."
    amount = 500_000_000
```

- `submit party do createCmd ...` submits a transaction where `party` is the
  authorizing party.
- The result is a `ContractId` for the newly created contract.
- The submitting party must satisfy the signatory requirement of the template.

---

## Exercising Choices

```daml
-- Exercise a choice on a contract
pendingCid <- submit (actAs issuer <> actAs depositor) do
  exerciseCmd orchCid RequestDeposit with
    requester = depositor
    erc20Address = "a0b86991..."
    amount = 100_000_000
    evmParams = sampleEvmParams

-- Exercise returning a tuple
(newBalCid, pendingCid) <- submit (actAs issuer <> actAs user) do
  exerciseCmd orchCid RequestWithdrawal with
    requester = user
    balanceCid = balCid
    recipientAddress = "d8da6bf2..."
    withdrawAmount = 200_000_000
    evmParams = sampleEvmParams
```

- `exerciseCmd` takes a `ContractId` and choice arguments.
- The return type matches whatever the choice returns.
- When the choice returns a tuple, destructure it on the left-hand side.

---

## Multi-Party Submissions

```daml
-- IMPORTANT: submitMulti is deprecated in Daml 3.x
-- Use the actAs combinator instead:
result <- submit (actAs issuer <> actAs depositor) do
  exerciseCmd cid MyChoice with arg1 = val1

-- Single party (plain submit):
result <- submit issuer do
  createCmd MyTemplate with ...

-- Read-only parties (actAs + readAs):
result <- submit (actAs issuer <> readAs auditor) do
  exerciseCmd cid MyChoice with ...
```

The `actAs` / `readAs` combinators replace the old `submitMulti` API:

| Old (deprecated)                            | New (Daml 3.x)                                     |
|---------------------------------------------|-----------------------------------------------------|
| `submitMulti [p1, p2] [] do ...`            | `submit (actAs p1 <> actAs p2) do ...`              |
| `submitMulti [p1] [p2] do ...`              | `submit (actAs p1 <> readAs p2) do ...`             |
| `submitMulti [p1, p2] [p3] do ...`          | `submit (actAs p1 <> actAs p2 <> readAs p3) do ...` |

- `actAs` grants authority to act (sign) as a party.
- `readAs` grants visibility but not authority.
- Combine with `<>` (Semigroup append).

---

## Querying Contracts

```daml
-- Query a specific contract by ID
maybePending <- queryContractId depositor pendingCid
let pd = fromSome maybePending  -- unwrap Optional

-- Query all contracts of a type visible to a party
allBalances <- query @Erc20Holding issuer

-- Query with filter
myBalances <- queryFilter @Erc20Holding issuer
  (\b -> b.owner == depositor)
```

- `queryContractId` returns `Optional` — the contract data if it exists and is
  visible to the querying party, or `None` if it has been archived or is not visible.
- `query @Template party` returns `[(ContractId Template, Template)]`.
- `queryFilter @Template party predicate` is equivalent to `query` followed by
  `filter` but is expressed more concisely.
- Always use `fromSome` (or pattern match) to unwrap the `Optional` from
  `queryContractId`.

---

## Assertions

```daml
-- Assert with message (fails the test if False)
assertMsg "requestId must be 32 bytes" (byteCount pd.requestId == 32)

-- Assert equality
assertMsg "Balance must be debited" ((fromSome newBal).amount == 300_000_000)

-- Assert inequality
assertMsg "different output must give different hash" (hash1 /= hash3)

-- Abort (unconditionally fail)
abort "Expected refund but got None"
```

- `assertMsg : Text -> Bool -> Script ()` — the string is the failure message
  shown when the boolean is `False`.
- `abort : Text -> Script a` — unconditionally fails the test with the given
  message. Useful in unreachable branches.
- There is no built-in `assertEqual`; use `assertMsg` with an equality check.

---

## Expected Failures

```daml
-- Test that a submission fails (useful for authorization tests)
submitMustFail depositor do
  createCmd VaultOrchestrator with
    issuer = depositor  -- wrong party, should fail
    mpcPublicKey = "..."

-- Test that a choice exercise fails
submitMustFail depositor do
  exerciseCmd orchCid AdminOnlyChoice with ...
```

- `submitMustFail` succeeds (does not abort the test) only when the inner
  submission **fails**.
- If the inner submission unexpectedly succeeds, the test fails.
- Use this to verify authorization rules, precondition checks, and ensure
  constraints.

Multi-party expected failures:

```daml
-- Expect failure with multiple acting parties
submitMustFail (actAs depositor <> actAs user) do
  exerciseCmd orchCid RestrictedChoice with ...
```

---

## Pattern: Full Lifecycle Test

```daml
testDepositLifecycle : Script ()
testDepositLifecycle = do
  -- 1. Setup: allocate parties
  issuer    <- allocateParty "Issuer"
  depositor <- allocateParty "Depositor"

  -- 2. Create orchestrator contract
  orchCid <- submit issuer do
    createCmd VaultOrchestrator with
      issuer
      mpcPublicKey = testPubKeyHex

  -- 3. Exercise choice that creates child contract
  pendingCid <- submit (actAs issuer <> actAs depositor) do
    exerciseCmd orchCid RequestDeposit with
      requester = depositor
      erc20Address = "a0b86991..."
      amount = 100_000_000
      evmParams = sampleEvmParams

  -- 4. Verify the created contract
  pending <- queryContractId depositor pendingCid
  let pd = fromSome pending
  assertMsg "requestId must be 32 bytes" (byteCount pd.requestId == 32)

  pure ()
```

This pattern covers the most common test shape:

1. **Setup** — allocate parties and any test data.
2. **Create** — submit the root contract(s).
3. **Act** — exercise one or more choices.
4. **Assert** — query results and verify invariants.

---

## Pattern: Testing Refund / Failure Paths

```daml
testWithdrawalRefund : Script ()
testWithdrawalRefund = do
  issuer <- allocateParty "Issuer"
  user     <- allocateParty "User"

  -- Setup contracts
  orchCid <- submit issuer do
    createCmd VaultOrchestrator with
      issuer
      mpcPublicKey = testPubKeyHex

  balCid <- submit issuer do
    createCmd Erc20Holding with
      issuer
      owner = user
      erc20Address = "a0b86991..."
      amount = 500_000_000

  -- Trigger withdrawal
  (newBalCid, pendingCid) <- submit (actAs issuer <> actAs user) do
    exerciseCmd orchCid RequestWithdrawal with
      requester = user
      balanceCid = balCid
      recipientAddress = "d8da6bf2..."
      withdrawAmount = 200_000_000
      evmParams = sampleEvmParams

  -- Complete with bad signature -> triggers refund
  refundResult <- submit issuer do
    exerciseCmd orchCid CompleteWithdrawal with
      pendingCid
      balanceCid = newBalCid
      mpcSignature = badSig
      mpcOutput = "deadbeef"

  -- Verify refund
  case refundResult of
    None -> abort "Expected refund but got None"
    Some refundCid -> do
      refundBal <- queryContractId user refundCid
      assertMsg "Refund must restore balance"
        ((fromSome refundBal).amount == 500_000_000)
```

Key points:

- Test both the happy path and the failure/refund path in separate test functions.
- Use `case ... of` to branch on `Optional` or variant return values.
- Use `abort` in branches that should be unreachable.

---

## Pattern: Crypto Verification Tests

```daml
testSecp256k1 : Script ()
testSecp256k1 = do
  -- Positive: valid signature
  let valid = secp256k1WithEcdsaOnly testSignatureHex testMessageHex testPubKeyHex
  assertMsg "Valid signature must verify" valid

  -- Negative: wrong message
  let wrongMsg = keccak256 "deadbeef"
  let invalid = secp256k1WithEcdsaOnly testSignatureHex wrongMsg testPubKeyHex
  assertMsg "Wrong message must fail" (not invalid)
```

When testing cryptographic functions:

- Always test both positive (valid input) and negative (invalid input) cases.
- Use known test vectors for signatures, hashes, and public keys.
- Test edge cases: empty input, wrong length, corrupted bytes.
- Keep test vectors as module-level constants for reuse.

Example negative cases to cover:

```daml
  -- Wrong public key
  let wrongPk = "0000000000000000000000000000000000000000000000000000000000000001"
  let invalidPk = secp256k1WithEcdsaOnly testSignatureHex testMessageHex wrongPk
  assertMsg "Wrong public key must fail" (not invalidPk)

  -- Corrupted signature
  let badSig = "ff" <> Text.drop 2 testSignatureHex
  let invalidSig = secp256k1WithEcdsaOnly badSig testMessageHex testPubKeyHex
  assertMsg "Corrupted signature must fail" (not invalidSig)
```

---

## Test Helpers Pattern

Define reusable test data as top-level values or helper functions.

```daml
-- Reusable test data
sampleEvmParams : EvmTransactionParams
sampleEvmParams = EvmTransactionParams with
  erc20Address   = "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
  recipient      = "d8da6bf26964af9d7eed9e03e53415d37aa96045"
  amount         = "0000000000000000000000000000000000000000000000000000000005f5e100"
  nonce          = "0000000000000000000000000000000000000000000000000000000000000001"
  gasLimit       = "000000000000000000000000000000000000000000000000000000000000c350"
  maxFeePerGas   = "0000000000000000000000000000000000000000000000000000000059682f00"
  chainId        = "0000000000000000000000000000000000000000000000000000000000000001"

testPubKeyHex : Text
testPubKeyHex = "04bfcab..."

testSignatureHex : Text
testSignatureHex = "304402..."

testMessageHex : Text
testMessageHex = "e3b0c4..."
```

Helper functions for repeated setup:

```daml
-- Setup helper: create orchestrator + balance
setupTestEnv : Script (Party, Party, ContractId VaultOrchestrator, ContractId Erc20Holding)
setupTestEnv = do
  issuer <- allocateParty "Issuer"
  user     <- allocateParty "User"

  orchCid <- submit issuer do
    createCmd VaultOrchestrator with
      issuer
      mpcPublicKey = testPubKeyHex

  balCid <- submit issuer do
    createCmd Erc20Holding with
      issuer
      owner = user
      erc20Address = "a0b86991..."
      amount = 500_000_000

  pure (issuer, user, orchCid, balCid)
```

Usage in tests:

```daml
testSomething : Script ()
testSomething = do
  (issuer, user, orchCid, balCid) <- setupTestEnv
  -- ... test logic using the pre-built environment
  pure ()
```

---

## Debugging Tips

1. **Use `debug` to print values during test execution:**

   ```daml
   debug ("requestId = " <> show requestId)
   ```

   Output appears in the test runner console. Useful for inspecting intermediate
   state.

2. **Use `trace` for inline debugging without changing types:**

   ```daml
   let result = trace ("value: " <> show x) x
   ```

   `trace` prints the message and returns the second argument unchanged, so it
   can be inserted into expressions without altering the data flow.

3. **Break complex tests into smaller steps with intermediate assertions:**

   Instead of one large test, assert after each meaningful step. This pinpoints
   exactly where the failure occurs.

   ```daml
   orchCid <- submit issuer do createCmd VaultOrchestrator with ...
   orchData <- queryContractId issuer orchCid
   assertMsg "Orchestrator must exist" (isSome orchData)

   pendingCid <- submit (actAs issuer <> actAs depositor) do
     exerciseCmd orchCid RequestDeposit with ...
   pendingData <- queryContractId depositor pendingCid
   assertMsg "Pending deposit must exist" (isSome pendingData)
   ```

4. **Use `queryContractId` after each step to verify state:**

   Contracts can be archived by exercising consuming choices. If a subsequent
   `exerciseCmd` fails with "contract not found", insert a `queryContractId`
   check before the failing step to confirm the contract still exists.

5. **Check signatory/observer rules if submission fails:**

   - The submitting parties (via `actAs`) must include all required signatories.
   - If a choice requires multiple signatories, combine them with `<>`.
   - Use `readAs` for parties that need visibility but not signing authority.

6. **Inspect choice return types carefully:**

   If your test fails to compile with a type mismatch, check the choice's return
   type in the template definition. Tuple returns need destructuring:

   ```daml
   -- If the choice returns (ContractId A, ContractId B):
   (aCid, bCid) <- submit issuer do exerciseCmd cid MyChoice with ...
   ```

---

## Common Mistakes

### 1. Forgetting `actAs` for multi-party choices

**Wrong:**
```daml
-- This only authorizes issuer, not depositor
result <- submit issuer do
  exerciseCmd orchCid RequestDeposit with
    requester = depositor
    ...
```

**Right:**
```daml
result <- submit (actAs issuer <> actAs depositor) do
  exerciseCmd orchCid RequestDeposit with
    requester = depositor
    ...
```

### 2. Using deprecated `submitMulti`

**Wrong:**
```daml
result <- submitMulti [issuer, depositor] [] do
  exerciseCmd cid MyChoice with ...
```

**Right:**
```daml
result <- submit (actAs issuer <> actAs depositor) do
  exerciseCmd cid MyChoice with ...
```

### 3. Not unwrapping Optional from `queryContractId`

**Wrong:**
```daml
pending <- queryContractId depositor pendingCid
-- pending is Optional, not the actual data!
assertMsg "check" (pending.amount == 100)  -- compile error
```

**Right:**
```daml
maybePending <- queryContractId depositor pendingCid
let pd = fromSome maybePending
assertMsg "check" (pd.amount == 100)
```

### 4. Hardcoding party strings

**Wrong:**
```daml
-- Party literals are fragile and may not match runtime identities
let issuer = getParty "Issuer"
```

**Right:**
```daml
issuer <- allocateParty "Issuer"
```

### 5. Missing `import Daml.Script`

**Wrong:**
```daml
module Test where

import MyModule

testFoo : Script ()  -- compile error: Script not in scope
testFoo = do ...
```

**Right:**
```daml
module Test where

import Daml.Script
import MyModule

testFoo : Script ()
testFoo = do ...
```

### 6. Forgetting `pure ()` at the end of a test

If the last expression in your test has a type other than `Script ()` (e.g., it
returns a `ContractId`), the test will fail to compile. Add `pure ()` as the
final line:

```daml
testFoo : Script ()
testFoo = do
  cid <- submit issuer do createCmd MyTemplate with ...
  -- cid has type ContractId MyTemplate, not Script ()
  pure ()  -- required to satisfy the Script () return type
```

### 7. Querying as the wrong party

`queryContractId` only returns the contract if it is visible to the querying
party. If you query as a party that is neither a signatory nor an observer, you
get `None`:

```daml
-- If 'bystander' is not a signatory or observer on the contract:
result <- queryContractId bystander someCid
-- result == None, even though the contract exists
```

Always query as a party that has visibility (signatory or observer).
