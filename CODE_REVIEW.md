# Canton MPC PoC — Code Review

> Reviewed 2026-02-20 against Daml 3.x best practices.

## Critical

### 1. Nonconsuming choices on VaultOrchestrator allow concurrent execution

**Files**: `daml/Erc20Vault.daml:63-78`

All 4 orchestrator choices (`RequestDeposit`, `ClaimDeposit`, `RequestWithdrawal`, `CompleteWithdrawal`) are `nonconsuming`. The inner `fetch + archive` on pending contracts provides per-contract protection, but there's no deduplication mechanism preventing the same deposit parameters from being submitted multiple times.

**Recommendation**: For production, move `ClaimDeposit` and `CompleteWithdrawal` to be consuming choices on `PendingDeposit` and `PendingWithdrawal` directly, or add contract-key-based deduplication.

### 2. No authorization tests (submitMustFail)

**File**: `daml/Test.daml`

Zero negative tests. Nothing verifies that:
- A non-operator can't create `VaultOrchestrator`
- A depositor can't exercise `ClaimDeposit` (operator-only)
- A random party can't exercise `CompleteWithdrawal`
- A user can't create `UserErc20Balance` directly (bypassing orchestrator)

**Recommendation**: Add `submitMustFail` tests:

```daml
testUnauthorizedCreate : Script ()
testUnauthorizedCreate = do
  hacker <- allocateParty "Hacker"
  submitMustFail hacker do
    createCmd VaultOrchestrator with
      operator = hacker
      mpcPublicKey = testPubKeyHex

testUnauthorizedClaim : Script ()
testUnauthorizedClaim = do
  operator  <- allocateParty "Operator"
  depositor <- allocateParty "Depositor"
  hacker    <- allocateParty "Hacker"
  -- setup orchestrator + pending deposit...
  submitMustFail hacker do
    exerciseCmd orchCid ClaimDeposit with
      pendingCid = pendingCid
      mpcSignature = badSig
      mpcOutput = "aa"
```

---

## Warnings

### 3. `VaultConfig` template declared but never used

**File**: `daml/Erc20Vault.daml:9-14`

`VaultConfig` exists but is never created, referenced, or tested. `VaultOrchestrator` duplicates its fields.

**Recommendation**: Remove `VaultConfig` or consolidate — use it as the source of truth and have `VaultOrchestrator` reference it via `ContractId VaultConfig`.

### 4. `UserErc20Balance` can be freely minted by operator

**File**: `daml/Erc20Vault.daml:18-25`

`signatory operator` only. Any operator can create arbitrary balances for any user without going through the deposit flow. Test 6 exploits this by directly creating a balance.

**Recommendation**: For production, balance creation should only happen through `ClaimDeposit`. Consider making the balance require both operator and owner as signatories, or gate creation through a choice that requires deposit proof.

### 5. Non-null assertions (`!`) in TypeScript without guards

**File**: `ts-tests/src/canton-client.ts:27`

```typescript
return data!.partyDetails!.party!;
```

Triple `!` assertion. If the API returns 200 with null fields, this silently produces `undefined`.

**Recommendation**:

```typescript
const party = data?.partyDetails?.party;
if (!party) throw new Error("allocateParty returned no party");
return party;
```

Apply the same pattern to other `!` usages in `submitAndWait` (line 97).

### 6. Tests rely on event array ordering

**File**: `ts-tests/src/crypto.test.ts:127,201,243,257`

Tests assume `events[0]` is the target contract:

```typescript
const orchCid = orchResult.transaction.events[0].CreatedEvent!.contractId;
```

Canton doesn't guarantee event ordering within a transaction.

**Recommendation**: Use `.find()` consistently (already done for PendingDeposit/PendingWithdrawal but not for VaultOrchestrator/UserErc20Balance):

```typescript
const orchEvent = orchResult.transaction.events.find(
  e => e.CreatedEvent?.templateId?.includes("VaultOrchestrator")
);
const orchCid = orchEvent!.CreatedEvent!.contractId;
```

### 7. TypeScript `EvmTransactionParams` missing `operation` field

**File**: `ts-tests/src/crypto.ts:3-13`

The TS interface omits `operation` which exists in the Daml type. The test file works around this by defining `damlEvmParams` separately with `operation` added ad-hoc.

**Recommendation**:

```typescript
export type OperationType = "Erc20Transfer" | "Erc20Approve";

export interface EvmTransactionParams {
  erc20Address: Hex;
  recipient: Hex;
  amount: Hex;
  nonce: Hex;
  gasLimit: Hex;
  maxFeePerGas: Hex;
  maxPriorityFee: Hex;
  chainId: Hex;
  value: Hex;
  operation: OperationType;
}
```

### 8. `daml.yaml` missing codegen configuration

**File**: `daml.yaml`

Codegen is only run via CLI. The command and its options aren't captured in config.

**Recommendation**:

```yaml
codegen:
  js:
    output-directory: ts-tests/generated/model
    npm-scope: daml.js
```

---

## Info

### 9. `packParams` doesn't include `operation` in the hash

**Files**: `daml/Crypto.daml:19-29`, `ts-tests/src/crypto.ts:27-39`

Two requests with different operation types (Transfer vs Approve) but identical EVM params produce the same `requestId`. This may be intentional since `operation` isn't an EVM-level field, but if the MPC needs to distinguish types, include it.

### 10. Stale DAR in `.daml/dist/`

`daml.yaml` version is `0.1.0` but `.daml/dist/` contains both `0.1.0` and `0.2.0` DARs. Clean stale artifacts:

```bash
rm .daml/dist/canton-mpc-poc-0.2.0.dar
```

### 11. No `.gitignore`

Missing `.gitignore` means build artifacts would be committed. Add:

```
.daml/
node_modules/
ts-tests/generated/
ts-tests/dist/
log/
*.dar
```

### 12. `package.json` missing codegen scripts

**File**: `ts-tests/package.json`

Only has `test` and `test:watch`. Add:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "codegen:api": "curl http://localhost:7575/docs/openapi -o openapi.yaml && npx openapi-typescript openapi.yaml -o generated/api/ledger-api.ts",
  "codegen:daml": "dpm codegen-js ../../.daml/dist/canton-mpc-poc-0.1.0.dar -o generated/model -s daml.js"
}
```

### 13. Test 5 doesn't complete the full deposit lifecycle

**File**: `daml/Test.daml:112-150`

Creates a deposit and verifies PendingDeposit but never exercises `ClaimDeposit`. Only verifies that a bad signature fails — never tests the happy path of a successful claim.

**Recommendation**: Add a full happy-path claim test with a real MPC signature over the correct response hash (generate test vectors offline with openssl).

---

## Priority Actions

| # | Action | Severity | Effort |
|---|--------|----------|--------|
| 1 | Add `submitMustFail` authorization tests | Critical | Low |
| 2 | Remove unused `VaultConfig` | Warning | Trivial |
| 3 | Fix event ordering assumptions in TS tests | Warning | Low |
| 4 | Add `.gitignore` | Info | Trivial |
| 5 | Add codegen scripts to `package.json` | Info | Trivial |
| 6 | Guard non-null assertions in canton-client.ts | Warning | Low |
| 7 | Add `operation` to TS `EvmTransactionParams` | Warning | Low |
| 8 | Add happy-path `ClaimDeposit` test | Info | Medium |
