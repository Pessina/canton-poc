# Canton MPC PoC — Consolidated Security Audit Report

**Target:** `canton-mpc-poc` deposit architecture (Daml + TypeScript + Sepolia)
**Scope:** Protocol design, Daml contracts, cryptographic constructions, EVM integration, attack simulation
**Assumption:** MPC service is trusted and secure
**Auditors:** 5-agent parallel team (protocol, daml, crypto, evm, red-team)

---

## Executive Summary

The architecture demonstrates strong fundamentals — Canton's ledger model prevents double-spending, the cryptographic primitives are correctly implemented, and the lifecycle ordering is sound. However, the audit identified **3 critical**, **3 high**, **2 medium**, and **3 low** severity findings. The most impactful cluster of vulnerabilities centers around **insufficient on-chain validation of user-supplied EVM parameters**, which allows a malicious user to inflate their `Erc20Holding` balance or execute unauthorized EVM operations.

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
