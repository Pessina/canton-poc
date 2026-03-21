# Structured EVM Return Data for Canton MPC

## Problem

The MPC service currently sends `"01"` (success) or `"00"` (failure) as `mpcOutput : BytesHex`
in `ProvideEvmOutcomeSig`. The Daml contract can only check `outcome.mpcOutput == "01"` — it
cannot read the actual return value of the EVM function call.

On the Solana fakenet-signer, the caller provides an output schema, the signer ABI-decodes the
EVM function's return value, serializes it (Borsh), and sends it back. The Solana program can
then read and act on the decoded return data.

Canton needs the same capability to support generic EVM function calls beyond hardcoded ERC-20
transfers.

## Insight

ABI-encoded return data is already a contiguous hex string with each value at 32-byte (64-char)
offsets. Daml already works with this exact format:

- `EvmTransactionParams.functionSignature : Text` describes the call
- `EvmTransactionParams.args : [BytesHex]` carries the ABI arguments
- `Crypto.daml` has `padHex`, `hexToInt`, `keccak256`, `hashBytesList`, `safeKeccak256`
- `ClaimEvmDeposit` already reads args: `let amount = (pending.evmParams).args !! 1`

The return data is the same shape as the input args — just hex bytes at 32-byte boundaries.
No new serialization format needed. Daml can slice it with `DA.Text.take` / `DA.Text.drop`.

## Design

### Request side — add return signature to `PendingEvmDeposit`

```daml
-- New field on PendingEvmDeposit:
returnSignature : Text  -- e.g., "(bool)" for transfer, "(uint256,address)" for custom calls
```

The requester specifies the expected return type when creating the deposit. This tells the MPC
service what the `provider.call()` result represents, and tells the contract how many 32-byte
slots to expect.

### Outcome side — replace `mpcOutput` with structured fields

```daml
template EvmTxOutcomeSignature
  with
    issuer          : Party
    requester       : Party
    requestId       : BytesHex
    signature       : SignatureHex
    success         : Bool          -- NEW: explicit success/failure flag
    returnData      : BytesHex      -- NEW: raw ABI-encoded return value (replaces mpcOutput)
  where
    signatory issuer
    observer requester
```

### Contract reads return data by slicing

```daml
-- Extract value at position i (0-indexed) from ABI return data:
-- Each value is 32 bytes = 64 hex chars
let val = DA.Text.take 64 (DA.Text.drop (64 * i) outcome.returnData)

-- Example: transfer() returns (bool)
let transferOk = DA.Text.take 64 outcome.returnData
assertMsg "Transfer returned false" (hexToInt transferOk == 1)

-- Example: custom function returns (uint256, address)
let amount  = DA.Text.take 64 outcome.returnData
let address = DA.Text.take 64 (DA.Text.drop 64 outcome.returnData)
```

### EIP-712 response hash — minimal change

Current `Crypto.daml`:
```daml
responseTypeHash = keccak256 (toHex "CantonMpcResponse(bytes32 requestId,bytes mpcOutput)")

computeResponseHash requestId output =
  eip712Hash $ keccak256 (responseTypeHash <> padHex requestId 32 <> safeKeccak256 output)
```

New:
```daml
responseTypeHash = keccak256 (toHex
  "CantonMpcResponse(bytes32 requestId,bool success,bytes returnData)")

computeResponseHash requestId success returnData =
  eip712Hash $ keccak256 $
       responseTypeHash
    <> padHex requestId 32
    <> padHex (if success then "01" else "00") 32
    <> safeKeccak256 returnData
```

All helpers already exist. `safeKeccak256 returnData` hashes the raw ABI bytes as EIP-712
`bytes` — same as `mpcOutput` today, just more bytes.

### MPC service — pass through `provider.call()` result

```typescript
// After getting receipt with status === 1:
const tx = await provider.getTransaction(txHash);
const returnData = await provider.call(
  { to: tx.to, data: tx.data, from: tx.from },
  receipt.blockNumber
);

exerciseChoice("ProvideEvmOutcomeSig", {
  requester,
  requestId,
  signature: signMpcResponse(rootKey, requestId, success, returnData.slice(2)),
  success: true,
  returnData: returnData.slice(2),  // strip 0x, raw ABI hex
});

// Failure case:
exerciseChoice("ProvideEvmOutcomeSig", {
  requester,
  requestId,
  signature: signMpcResponse(rootKey, requestId, false, ""),
  success: false,
  returnData: "",  // empty on failure
});
```

No ABI decoding, no re-encoding, no list splitting. The raw bytes from `provider.call()` flow
straight to Canton.

### TypeScript `crypto.ts` changes

```typescript
// Match the new EIP-712 type:
const eip712Types = {
  CantonMpcResponse: [
    { name: "requestId", type: "bytes32" },
    { name: "success", type: "bool" },
    { name: "returnData", type: "bytes" },
  ],
};

export function computeResponseHash(
  requestId: string,
  success: boolean,
  returnData: string
): Hex {
  return hashTypedData({
    domain: eip712Domain,
    types: eip712Types,
    primaryType: "CantonMpcResponse",
    message: {
      requestId: `0x${requestId}`,
      success,
      returnData: `0x${returnData}`,
    },
  });
}
```

## What Changes

| File | Change |
|------|--------|
| `daml/Types.daml` | No change |
| `daml/Erc20Vault.daml` | `EvmTxOutcomeSignature`: replace `mpcOutput` with `success` + `returnData`. `ProvideEvmOutcomeSig`: update choice args. `ClaimEvmDeposit`: use `outcome.success` + slice `returnData`. Add `returnSignature` to `PendingEvmDeposit` and `RequestEvmDeposit`. |
| `daml/Crypto.daml` | Update `responseTypeHash` and `computeResponseHash` signature |
| `client/src/mpc-service/deposit-handler.ts` | Add `provider.call()` to get return data. Send `success` + `returnData` instead of `mpcOutput`. |
| `client/src/mpc-service/signer.ts` | Update `signMpcResponse` to accept `success` + `returnData` |
| `client/src/mpc/crypto.ts` | Update `computeResponseHash` EIP-712 type |

## Breaking Change

This changes the `ProvideEvmOutcomeSig` choice signature and `EvmTxOutcomeSignature` template
fields — incompatible DAR upgrade per Canton rules. Requires sandbox restart.

## ABI Encoding Reference

### Type classification

**Static types** — fixed 32-byte slot, directly readable with `DA.Text.take 64 (DA.Text.drop (64*i) data)`:

| Type | Encoding | Example value | Encoded (32 bytes) |
|------|----------|---------------|-------------------|
| `uint<M>` (8-256, step 8) | Big-endian, left-padded zeros | `uint256(1000)` | `00000000000000000000000000000000000000000000000000000000000003e8` |
| `int<M>` (8-256, step 8) | Two's complement, sign-extended | `int256(-1)` | `ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff` |
| `bool` | 0 or 1, left-padded | `true` | `0000000000000000000000000000000000000000000000000000000000000001` |
| `address` | 20 bytes, left-padded | `0xAbC...dEf` | `000000000000000000000000abc...def` |
| `bytes<M>` (1-32) | **Right-padded** zeros | `bytes4(0xdeadbeef)` | `deadbeef00000000000000000000000000000000000000000000000000000000` |
| `T[k]` (fixed array, T static) | k consecutive 32-byte slots | `uint256[2]` = [1,2] | `0000...0001 \|\| 0000...0002` (64 bytes) |
| `(T1,T2,...)` (all Ti static) | Concatenated slots | `(uint256,bool)` = (5,true) | `0000...0005 \|\| 0000...0001` (64 bytes) |

**Dynamic types** — use offset pointers in head, actual data in tail:

| Type | Description |
|------|-------------|
| `bytes` | Variable-length byte array |
| `string` | UTF-8 string (encoded same as `bytes`) |
| `T[]` | Dynamic-length array |
| `T[k]` where T is dynamic | Fixed-length array of dynamic elements |
| `(T1,...)` where any Ti is dynamic | Tuple with dynamic component |

No `mapping` in ABI — Solidity maps cannot be returned from external/public functions.

### Head-tail encoding for dynamic types

When a return type contains any dynamic type, the encoding uses **offset pointers** in the head
section that point to the actual data in the tail section.

**Example: `(uint256, string, uint256)` returning `(42, "Hello", 99)`**

```
Offset  Hex (32 bytes each)                                       Meaning
------  --------------------------------------------------------  ------------------
0x00    000000000000000000000000000000000000000000000000000000002a   42 (static, in-place)
0x20    0000000000000000000000000000000000000000000000000000000060   offset=96 -> tail
0x40    0000000000000000000000000000000000000000000000000000000063   99 (static, in-place)
        --- tail section ---
0x60    0000000000000000000000000000000000000000000000000000000005   length=5
0x80    48656c6c6f000000000000000000000000000000000000000000000000   "Hello" (right-padded)
```

Slot 0: `42` — static, read directly.
Slot 1: `96` — NOT the value. It's a byte offset from the start pointing to the tail.
Slot 2: `99` — static, read directly.

**Example: `(bytes)` returning `0xdeadbeef`**

```
0x00    0000000000000000000000000000000000000000000000000000000020   offset=32
0x20    0000000000000000000000000000000000000000000000000000000004   length=4 bytes
0x40    deadbeef00000000000000000000000000000000000000000000000000   data (right-padded)
```

**Example: `(uint256[])` returning `[10, 20, 30]`**

```
0x00    0000000000000000000000000000000000000000000000000000000020   offset=32
0x20    0000000000000000000000000000000000000000000000000000000003   count=3
0x40    000000000000000000000000000000000000000000000000000000000a   10
0x60    0000000000000000000000000000000000000000000000000000000014   20
0x80    000000000000000000000000000000000000000000000000000000001e   30
```

**Example: `(string[])` returning `["Hello", "World"]` — nested offsets**

```
0x00    0000000000000000000000000000000000000000000000000000000020   offset to array
0x20    0000000000000000000000000000000000000000000000000000000002   count=2
0x40    0000000000000000000000000000000000000000000000000000000040   offset to "Hello" (from 0x40)
0x60    0000000000000000000000000000000000000000000000000000000080   offset to "World" (from 0x40)
0x80    0000000000000000000000000000000000000000000000000000000005   length=5
0xa0    48656c6c6f000000000000000000000000000000000000000000000000   "Hello"
0xc0    0000000000000000000000000000000000000000000000000000000005   length=5
0xe0    576f726c64000000000000000000000000000000000000000000000000   "World"
```

Element offsets are **relative to the start of the element encoding area** (0x40), not absolute.
So offset `0x40` at position 0x40 means "go to 0x40 + 0x40 = 0x80."

**Example: `(uint256, string, uint256[])` returning `(7, "Hi", [1, 2])` — mixed**

```
0x00    0000000000000000000000000000000000000000000000000000000007   7 (static)
0x20    0000000000000000000000000000000000000000000000000000000060   offset=96 -> string
0x40    00000000000000000000000000000000000000000000000000000000a0   offset=160 -> array
        --- tail ---
0x60    0000000000000000000000000000000000000000000000000000000002   string length=2
0x80    4869000000000000000000000000000000000000000000000000000000   "Hi"
0xa0    0000000000000000000000000000000000000000000000000000000002   array count=2
0xc0    0000000000000000000000000000000000000000000000000000000001   1
0xe0    0000000000000000000000000000000000000000000000000000000002   2
```

### Implications for Daml slicing

Simple `DA.Text.take 64 (DA.Text.drop (64*i) ...)` works for **all-static return types only**.

For dynamic types, Daml would need to:
1. Read the offset at slot i: `hexToInt (DA.Text.take 64 (DA.Text.drop (64*i) data))`
2. Jump to that byte offset: `DA.Text.drop (offset * 2) data`
3. Read length, then read data

This is doable with existing Daml primitives (`hexToInt`, `DA.Text.take`, `DA.Text.drop`) but
requires more code. The question is whether dynamic return types are needed.

Most common ERC-20/DeFi functions return only static types:

| Function | Return type | Static? |
|----------|-------------|---------|
| `transfer(address,uint256)` | `(bool)` | Yes |
| `balanceOf(address)` | `(uint256)` | Yes |
| `allowance(address,address)` | `(uint256)` | Yes |
| `approve(address,uint256)` | `(bool)` | Yes |
| `totalSupply()` | `(uint256)` | Yes |
| `decimals()` | `(uint8)` | Yes |
| `name()` | `(string)` | **No** |
| `symbol()` | `(string)` | **No** |
| Uniswap `swap(...)` | `(uint256,uint256)` | Yes |
| Aave `deposit(...)` | `()` | Yes |

**Recommendation:** Start with static-only slicing (covers the vast majority of DeFi use cases).
Add a Daml `abiDecodeDynamic` helper later if a dynamic return type is needed.

## Why Not Other Formats

| Alternative | Why not |
|-------------|---------|
| Borsh | Daml has no Borsh decoder. Solana uses it because its VM speaks Borsh. |
| ABI decode + `TextMap Text` | Extra complexity. Daml can slice raw ABI hex directly. |
| ABI decode + `[BytesHex]` list | Unnecessary split. Raw ABI bytes are already a contiguous hex string at 32-byte offsets. |
| JSON in `Text` | Daml has no JSON parser. |
| Hardcoded `EvmSuccessData` record | Not generic — locks you into specific return types. |
