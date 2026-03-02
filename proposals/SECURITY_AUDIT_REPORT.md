# Canton MPC PoC — Consolidated Security Audit Report

**Target:** `canton-mpc-poc` deposit architecture (Daml + TypeScript + Sepolia)
**Scope:** Protocol design, Daml contracts, cryptographic constructions, EVM integration, attack simulation
**Assumption:** MPC service is trusted and secure
**Auditors:** 5-agent parallel team (protocol, daml, crypto, evm, red-team)

---

## Executive Summary

The architecture demonstrates strong fundamentals — Canton's ledger model prevents double-spending, the cryptographic primitives are correctly implemented, and the lifecycle ordering is sound. However, the audit identified **3 critical**, **3 high**, **2 medium**, and **3 low** severity findings. The most impactful cluster of vulnerabilities centers around **insufficient on-chain validation of user-supplied EVM parameters**, which allows a malicious user to inflate their `Erc20Holding` balance or execute unauthorized EVM operations.

## Critical Findings

### C-1: No `functionSignature` Validation — Arbitrary EVM Call Execution

**Confirmed by:** Protocol, Daml, EVM, Red-Team (Attack #3)
**Location:** `Erc20Vault.daml:55-66` (`RequestEvmDeposit`)

The `RequestEvmDeposit` choice accepts any `functionSignature` and `args` without validation. The plan document shows an authorization example (`assertMsg "Only ERC20 transfer allowed"`), but this check **does not exist in the actual contract code**. A malicious user can submit:

- `approve(address,uint256)` — grant the vault's token allowance to an attacker address
- `transferFrom(address,address,uint256)` — move tokens from the vault to an attacker
- Any arbitrary function call on any contract address (`evmParams.to` is also unvalidated)

**Attack flow:**

1. User calls `RequestEvmDeposit` with `functionSignature: "approve(address,uint256)"` targeting the ERC20 contract, with `args[0] = attacker_address`
2. MPC signs the transaction (it signs any valid `PendingEvmDeposit`)
3. User submits to Sepolia — the vault's deposit address now approves the attacker
4. Attacker drains the deposit address via `transferFrom`

**Impact:** Complete loss of funds from any MPC-controlled deposit address.

**Recommendation:**

```daml
-- Add to RequestEvmDeposit choice body:
assertMsg "Only ERC20 transfer allowed"
  (evmParams.functionSignature == "transfer(address,uint256)")
assertMsg "Transfer must target vault address"
  (evmParams.to == expectedErc20Address)
```

---

### C-2: No `evmParams.to` Validation — Funds Sent to Arbitrary Contracts

**Confirmed by:** EVM, Red-Team (Attack #9), Daml
**Location:** `Erc20Vault.daml:55-66, 115`

The `to` field in `EvmTransactionParams` is the ERC20 contract address the `transfer` call targets. It is **not validated** against any expected value. Combined with C-1 (no `functionSignature` validation), a user can construct a transaction targeting any contract with any function.

`evmParams.to` becomes `erc20Address` in `Erc20Holding`. A user can point to their own fake token contract that always returns `true`, mint `Erc20Holding` for a worthless token. Combined with C-1, ANY contract at ANY address can be called.

Even with `functionSignature` validation (C-1 fix), without `to` validation, a user could call `transfer` on a **different ERC20 contract** than the one the vault is supposed to manage.

**Impact:** Funds misdirection, unauthorized contract interaction, fake token minting.

**Recommendation:** Validate `evmParams.to` against an expected ERC20 contract address stored in `VaultOrchestrator` or maintain a whitelist of approved token addresses.

---

### C-3: Duplicate `PendingEvmDeposit` — Multi-Mint from Single Deposit

**Confirmed by:** Protocol (Finding 1), Daml (Finding 4), manual verification
**Location:** `Erc20Vault.daml:55-66, 79-87, 89-117`

`RequestEvmDeposit` (line 55) is a `nonconsuming` choice with no uniqueness enforcement. A user can call it N times with identical parameters, creating N `PendingEvmDeposit` contracts with the **same `requestId`** (deterministic from inputs, line 64). Similarly, `ProvideEvmOutcomeSig` (line 79) is `nonconsuming` with no uniqueness guard — if the MPC processes the same deposit event multiple times (e.g., due to ledger stream reconnection/replay), it creates N `EvmTxOutcomeSignature` contracts with the same `requestId`.

`ClaimEvmDeposit` (line 89) archives one `PendingEvmDeposit` + one `EvmTxOutcomeSignature` per call (lines 109-110), but if N pairs exist, N separate `ClaimEvmDeposit` calls succeed — each minting an `Erc20Holding`.

**Attack flow:**
1. User calls `RequestEvmDeposit` 3 times with identical params → 3 `PendingEvmDeposit` contracts (same `requestId`)
2. MPC observes 3 `PendingEvmDeposit` events, processes each independently → 3 `EvmTxOutcomeSignature` contracts (only one EVM tx actually succeeds; the others time out with `mpcOutput = "00"`, but if the MPC processes the first event's success and creates the outcome before the second event is processed, race conditions apply)
3. Even with just 1 successful outcome, if `ProvideEvmOutcomeSig` is called multiple times for the same `requestId` with the same valid signature, N outcome contracts exist
4. Relayer calls `ClaimEvmDeposit` N times, each with a different `(pendingCid, outcomeCid)` pair → N `Erc20Holding` contracts minted for a single on-chain deposit

**Impact:** Multi-mint of `Erc20Holding` from a single EVM deposit. Unbacked token minting.

**Recommendation:** Add a contract key `(issuer, requestId)` to `PendingEvmDeposit` **and** `EvmTxOutcomeSignature` so Canton enforces uniqueness at the ledger level. This makes duplicate creation fail immediately.

---

## High Findings

### H-1: `EcdsaSignature` and `EvmTxOutcomeSignature` Invisible to Requester

**Confirmed by:** Daml (Finding 1), Protocol
**Location:** `Erc20Vault.daml:29-46`

Both `EcdsaSignature` and `EvmTxOutcomeSignature` templates have `signatory issuer` with **no observer**. In Canton's privacy model, only stakeholders (signatories + observers) can see contracts. The `requester` (user) cannot directly observe these contracts.

This breaks the plan's claim that "user observes EcdsaSignature." The system relies entirely on the relayer (running as `issuer`) to act on these contracts.

**Impact:** Liveness dependency on the relayer; user cannot self-service claims.

**Recommendation:** Add `observer requester` to both templates (requires adding `requester` as a field on these templates).

---

### H-2: `ClaimEvmDeposit` Controller Is `issuer` Only

**Confirmed by:** Daml (Finding 6 analysis)
**Location:** `Erc20Vault.daml:89-116`

`ClaimEvmDeposit` has `controller issuer`. The user (requester) cannot exercise this choice — only the `issuer` party (via the relayer) can. This contradicts the plan document which states "User submits the signed transaction to Sepolia and claims the deposit on Canton once the MPC confirms success."

**Impact:** User depends entirely on the relayer for the final claim step. If the relayer is compromised or down, completed deposits cannot be finalized.

**Recommendation:** Change controller to `controller issuer, requester` or add `requester` as an authorized controller.

---

### H-3: Transfer Recipient (`args[0]`) Not Validated as Vault Address

**Confirmed by:** EVM (H1), Red-Team
**Location:** `Erc20Vault.daml:55-66`

Nobody verifies that `evmParams.args[0]` is the expected vault address. A user could set it to their own address (self-transfer) and still get an `Erc20Holding` minted, since the MPC only checks `receipt.status === 1`.

**Impact:** Tokens not actually deposited to vault, but `Erc20Holding` minted regardless.

**Recommendation:** Validate `args[0]` against the expected vault address in `RequestEvmDeposit`.

---

## Medium Findings

### M-1: `abi_encode_packed` Hash Collision Vectors in `computeRequestId`

**Confirmed by:** Crypto (Findings 1 & 2)
**Location:** `Crypto.daml:39-64`, `client/src/mpc/crypto.ts:36-95`

`computeRequestId` concatenates multiple variable-length `textToHex` fields without length prefixes:

```text
keccak256(
  textToHex(sender)         // variable length
  || packParams(evmParams)  // contains variable-length subfields
  || textToHex(caip2Id)     // variable length
  || uint32ToHex(keyVersion) // FIXED 4 bytes
  || textToHex(path)        // variable length
  || textToHex("ECDSA")     // constant
  || textToHex("ethereum")  // constant
)
```

The boundary between adjacent variable-length text fields is ambiguous. Different inputs could theoretically produce the same hash. Practical risk is low because `packParams` contains fixed-width fields that act as implicit delimiters, and party names are controlled by Canton allocation.

**Impact:** Theoretical hash collision between different deposit requests. Low practical exploitability.

**Recommendation:** Use length-prefixed encoding for variable-length fields, or hash each variable-length field individually before concatenation.

---

### M-2: DER Signature Malleability

**Confirmed by:** Crypto (Finding 4)
**Location:** `signer.ts:63-80`, `Erc20Vault.daml:106-107`

DER-encoded ECDSA signatures can have S-value malleability. `@noble/curves` produces low-S signatures by default, but it's unverified whether Daml's `secp256k1WithEcdsaOnly` enforces low-S (BIP-62). If it doesn't, two valid signature encodings exist per signing operation.

**Impact:** Low practical risk since only `issuer` can submit signatures via `ProvideEvmOutcomeSig`.

**Recommendation:** Verify that Daml's `secp256k1WithEcdsaOnly` enforces low-S normalization.

---

## Low Findings

### L-1: `EcdsaSignature` Contracts Never Archived

**Confirmed by:** Protocol (Finding 3, 10)
**Location:** `Erc20Vault.daml:89-117`

`ClaimEvmDeposit` archives `PendingEvmDeposit` and `EvmTxOutcomeSignature` but NOT `EcdsaSignature`. Over time, `EcdsaSignature` contracts accumulate on the ledger.

**Recommendation:** Archive `EcdsaSignature` in `ClaimEvmDeposit`.

---

### L-2: Response Hash Lacks Domain Separation

**Confirmed by:** Crypto (Finding 3)
**Location:** `Crypto.daml:67-68`

`computeResponseHash` is `keccak256(requestId || mpcOutput)` with no domain separator. If a future extension uses a similar hash construction, cross-protocol collisions become possible.

**Recommendation:** Add a domain tag: `keccak256("canton-mpc-poc:response:" || requestId || mpcOutput)`.

---

### L-3: Key Derivation Colon-Delimiter Ambiguity

**Confirmed by:** Crypto (Finding 5)
**Location:** `signer.ts:15-29`

The epsilon derivation uses `:` as delimiter: `"prefix:caip2Id:predecessorId:path"`. If any field contains `:`, ambiguity arises (e.g., `caip2Id = "eip155:1"` already contains a colon).

**Recommendation:** Use length-prefixed fields or validate that `predecessorId` and `path` do not contain `:`.

---

## STRIDE Threat Model

| Category                   | Threat                              | Relevant Attacks                   | Severity    |
| -------------------------- | ----------------------------------- | ---------------------------------- | ----------- |
| **S**poofing               | Fake VaultOrchestrator / issuer     | #7                                 | Low         |
| **T**ampering              | Modify functionSignature/to/amount  | #3, #9, #1                         | Critical    |
| **R**epudiation            | User denies deposit request         | N/A (Canton provides auditability) | None        |
| **I**nformation Disclosure | Signed tx visible before submission | #6                                 | Low         |
| **D**enial of Service      | Stale nonce, withheld submission    | #4, #8                             | Medium-High |
| **E**levation of Privilege | User mints arbitrary Erc20Holding   | #3, #9                             | Critical    |

---

## Risk Matrix

| Attack                  | Likelihood | Impact   | Risk         |
| ----------------------- | ---------- | -------- | ------------ |
| #1 Inflate amount       | Medium     | High     | **High**     |
| #2 Double claim         | None       | Critical | **None**     |
| #3 Fake function        | High       | Critical | **Critical** |
| #4 Withhold submission  | Medium     | Medium   | **Medium**   |
| #5 Wrong chain          | None       | Critical | **None**     |
| #6 Front-run            | Low        | Low      | **Low**      |
| #7 Contract spoof       | Low        | Medium   | **Low**      |
| #8 Nonce manipulation   | High       | Low      | **Medium**   |
| #9 Deposit to self      | High       | High     | **Critical** |
| #10 Concurrent deposits | Low        | Low      | **Low**      |

---

## What the System Gets Right

All 5 auditors independently confirmed these strengths:

- **Double-spend prevention** via Canton's `archive` semantics is sound
- **EIP-1559 chain binding** prevents cross-chain replay
- **Cryptographic implementations** use correct libraries (`@noble/curves`, `viem`)
- **Request ID determinism** is verified by integration tests (TypeScript matches Daml)
- **MPC signature verification** (`secp256k1WithEcdsaOnly`) is correctly wired
- **Key derivation** uses sound additive scheme with domain-separated epsilon
- **Controller/signatory model** is correctly applied in Daml
- **Canton privacy model** correctly limits contract visibility to stakeholders

---

## Priority Fix List

| Priority | Fix                                                                                           | Closes   | Effort    |
| -------- | --------------------------------------------------------------------------------------------- | -------- | --------- |
| 1        | Validate `functionSignature == "transfer(address,uint256)"` in `RequestEvmDeposit`            | C-1      | Daml-only |
| 2        | Validate `evmParams.to` against whitelist in `VaultOrchestrator`                              | C-2, H-3 | Daml-only |
| 3        | Add contract key `(issuer, requestId)` to `PendingEvmDeposit` and `EvmTxOutcomeSignature`     | C-3      | Daml-only |
| 4        | Add `observer requester` to `EcdsaSignature` and `EvmTxOutcomeSignature`                      | H-1      | Daml-only |
| 5        | Add `requester` as co-controller on `ClaimEvmDeposit`                                         | H-2      | Daml-only |
| 6        | Use length-prefixed encoding in `computeRequestId`                                            | M-1      | Daml + TS |

**Fixes 1-3 are the most impactful** — they close all critical vulnerabilities and can be implemented as Daml-only changes with no TypeScript modifications needed.
