# Migrate to ABI-Encoded Return Data (Fakenet Pattern)

Replace the hardcoded `"01"`/`"00"` `mpcOutput` with ABI-encoded EVM return data,
aligning Canton's MPC service with the pattern established in
`signet-solana-program/fakenet-signer`.

## Motivation

Today the MPC service reduces EVM execution results to a single boolean:
`"01"` (success) or `"00"` (failure). The Daml contract checks
`outcome.mpcOutput == "01"` and trusts it blindly — it never sees the actual
EVM return data.

The fakenet signer already solves this: after a transaction confirms, it
**re-simulates the call** to extract the ABI-encoded return value, posts it
back as `serialized_output`, and signs `keccak256(requestId || output)`. The
on-chain consumer then decodes and interprets the return data itself.

Canton should adopt this pattern because:

1. **Richer on-chain logic** — the Daml contract can inspect actual return
   values (e.g. `balanceOf` amounts, swap outputs, multi-return structs),
   not just pass/fail
2. **`Abi.daml` is already built** — the full ABI decoding library
   (`abiDecodeBool`, `abiDecodeUint`, `abiDecodeAddress`, dynamic types,
   etc.) is ready and tested
3. **Protocol alignment** — Canton's MPC service matches the same interface
   as the Solana fakenet, making it straightforward to swap in the real
   signet MPC network later
4. **Error prefix convention** — the `0xDEADBEEF` prefix used by fakenet
   provides an unambiguous failure signal that is cleaner than a magic
   hex string

## Current vs Proposed

| Aspect | Current | Proposed |
|--------|---------|----------|
| `mpcOutput` content | `"01"` or `"00"` | ABI-encoded return data (e.g. `0000...0001` for `bool true`) |
| Error signal | `mpcOutput == "00"` | 4-byte `deadbeef` prefix |
| Deposit claim check | `outcome.mpcOutput == "01"` | `abiDecodeBool mpcOutput 0 == True` |
| Withdrawal refund check | `outcome.mpcOutput /= "01"` | `hasErrorPrefix mpcOutput \|\| not (abiDecodeBool mpcOutput 0)` |
| Return data extraction | Not done — checks receipt status only | Re-simulate call at `blockNumber - 1`, ABI decode result |
| Schema system | None | `PendingEvmTx` carries two schemas: `outputDeserializationSchema` + `respondSerializationSchema` (JSON `[{name,type}]` arrays, same format as Solana's `sign_bidirectional`) |
| Response hash input | `keccak256(responseTypeHash \|\| requestId \|\| keccak256("01"))` | `keccak256(responseTypeHash \|\| requestId \|\| keccak256(abiEncodedOutput))` |

## Design

### Error Prefix Convention

Adopt the fakenet `0xDEADBEEF` prefix for error signaling:

```
Success: <ABI-encoded return data>        e.g. "0000...0001" (bool true)
Failure: "deadbeef" <> <ABI-encoded error>  e.g. "deadbeef0000...0001" ({ error: true })
```

The Daml contract checks `DA.Text.take 8 mpcOutput == "deadbeef"` before
attempting to decode the return value.

### Schema on PendingEvmTx

Add two schema fields to `PendingEvmTx`, matching the same two-schema
system used by `sign_bidirectional` on Solana:

```haskell
template PendingEvmTx
  with
    ...
    outputDeserializationSchema : Text  -- JSON ABI type array for decoding EVM return data
    respondSerializationSchema : Text   -- JSON ABI type array for re-encoding the response
  where ...
```

Both schemas use the **same JSON format** as the Solana program — an array
of `{name, type}` objects matching the `AbiSchemaField` type from fakenet:

```json
[{"name":"","type":"bool"}]
```

For ERC20 `transfer(address,uint256) returns (bool)`, both schemas are
`[{"name":"","type":"bool"}]`. They diverge for more complex returns — e.g.
a DEX swap might use:
- `outputDeserializationSchema`: `[{"name":"amountOut","type":"uint256"}]`
- `respondSerializationSchema`: `[{"name":"amountOut","type":"uint256"}]`

On Solana, the `respond_serialization_schema` uses Borsh format (since
Solana programs decode Borsh). Canton uses ABI for both schemas because
`Abi.daml` already handles ABI decoding on-ledger.

The MPC service reads `outputDeserializationSchema` from the `PendingEvmTx`
contract to know which ABI types to decode from the re-simulated call
result, then uses `respondSerializationSchema` to ABI-encode the response
posted back as `mpcOutput`.

**Serialization format selection**: The fakenet determines the response
encoding format from the CAIP-2 chain ID of the response destination
(Solana → Borsh format 0, EVM → ABI format 1). Canton's MPC service
always uses ABI (format 1) since the Daml ledger decodes ABI via
`Abi.daml`.

### Changes by Layer

#### 1. Daml — `Erc20Vault.daml`

**`PendingEvmTx`** — add `outputDeserializationSchema : Text` and `respondSerializationSchema : Text`

**`ClaimEvmDeposit`** — replace:
```haskell
-- before
assertMsg "MPC reported ETH transaction failure"
  (outcome.mpcOutput == "01")
```
with:
```haskell
-- after
assertMsg "MPC reported ETH transaction failure"
  (not (hasErrorPrefix outcome.mpcOutput))
let success = abiDecodeBool outcome.mpcOutput 0
assertMsg "ERC20 transfer returned false" success
```

**`CompleteEvmWithdrawal`** — replace:
```haskell
-- before
if outcome.mpcOutput == "01"
  then return None
  else do ...refund...
```
with:
```haskell
-- after
let shouldRefund =
      if hasErrorPrefix outcome.mpcOutput then True
      else not (abiDecodeBool outcome.mpcOutput 0)
if not shouldRefund
  then return None
  else do ...refund...
```

**`RequestEvmDeposit` / `RequestEvmWithdrawal`** — pass both schemas as
`[{"name":"","type":"bool"}]` when creating `PendingEvmTx`.

**New helper** (in `Abi.daml` or `Erc20Vault.daml`):
```haskell
hasErrorPrefix : BytesHex -> Bool
hasErrorPrefix hex = DA.Text.length hex >= 8 && DA.Text.take 8 hex == "deadbeef"

stripErrorPrefix : BytesHex -> BytesHex
stripErrorPrefix hex = DA.Text.drop 8 hex
```

#### 2. Daml — `RequestId.daml`

**No changes to response hash computation.** The `computeResponseHash`
function already hashes `keccak256(mpcOutput)` generically — it doesn't
care whether `mpcOutput` is `"01"` or a full ABI blob. The EIP-712
envelope remains the same:

```haskell
computeResponseHash requestId output =
  eip712Hash $ keccak256 (responseTypeHash <> assertBytes32 requestId <> safeKeccak256 output)
```

This works unchanged because the MPC service signs whatever `mpcOutput`
bytes it sends, and the Daml contract verifies the signature against the
same bytes.

#### 3. TypeScript — `tx-handler.ts` (MPC Service)

**`checkPendingTx`** — replace the boolean receipt check with return data
extraction:

```typescript
// current
if (receipt.status === "success" && hasTransferEvent) {
  mpcOutput = "01";
} else {
  mpcOutput = "00";
}
```

becomes:

```typescript
// proposed
if (receipt.status === "success") {
  const returnData = await extractReturnData(client, tx, receipt);
  mpcOutput = returnData; // ABI-encoded, e.g. "0000...0001"
} else {
  mpcOutput = "deadbeef" + AbiCoder.defaultAbiCoder()
    .encode(["bool"], [true]).slice(2); // error prefix + { error: true }
}
```

**New function `extractReturnData`** — re-simulate the call:

```typescript
async function extractReturnData(
  client: PublicClient,
  tx: PendingTx,
  receipt: TransactionReceipt,
): Promise<string> {
  // Re-simulate the call at the block before inclusion
  const result = await client.call({
    to: tx.evmParams.to,
    data: tx.calldata,
    account: tx.fromAddress,
    blockNumber: receipt.blockNumber - 1n,
  });
  // Return raw ABI-encoded output without 0x prefix
  return result.data!.slice(2);
}
```

This is the same technique fakenet uses in `EthereumMonitor.extractTransactionOutput`.

**Nonce-consumed-but-no-receipt** (tx replaced) — also use error prefix:

```typescript
mpcOutput = "deadbeef" + AbiCoder.defaultAbiCoder()
  .encode(["bool"], [true]).slice(2);
```

#### 4. TypeScript — `signer.ts`

**`signMpcResponse`** — no changes needed. It already signs
`computeResponseHash(requestId, mpcOutput)` where `mpcOutput` is an
arbitrary hex string. The function is agnostic to the content.

#### 5. TypeScript — `crypto.ts`

**`computeResponseHash`** — no changes needed. Same reasoning as Daml's
`computeResponseHash`: it hashes `mpcOutput` as opaque bytes.

#### 6. TypeScript — Tests

**`sepolia-e2e.test.ts`** — update assertions:
- Verify `mpcOutput` is 64 hex chars (one ABI-encoded `bool` slot) instead of `"01"`
- Verify `abiDecode(['bool'], '0x' + mpcOutput)[0] === true`

**New unit test** — `abi-return-data.test.ts`:
- Test `extractReturnData` with mocked `client.call` responses
- Test error prefix generation and parsing
- Test round-trip: TypeScript ABI-encodes → Daml `abiDecodeBool` decodes

### PendingTx Type Update

Add fields to track the original calldata (needed for re-simulation):

```typescript
export interface PendingTx {
  requestId: string;
  requester: string;
  signedTxHash: Hex;
  fromAddress: Hex;
  nonce: number;
  checkCount: number;
  evmParams: CantonEvmParams;  // NEW — needed for re-simulation
}
```

The `evmParams` are already available in `signAndEnqueue` from the
`PendingEvmTx` contract — just pass them through.

## Migration Path

This is a **breaking change** to the `mpcOutput` format. Since Canton
requires a sandbox restart for template field additions (`outputSchema`
on `PendingEvmTx`), the migration is straightforward:

1. Add `outputDeserializationSchema` and `respondSerializationSchema` to `PendingEvmTx`, `hasErrorPrefix` to `Abi.daml`
2. Update `ClaimEvmDeposit` and `CompleteEvmWithdrawal` to use ABI decoding
3. Update `RequestEvmDeposit` and `RequestEvmWithdrawal` to pass both schemas
4. Update MPC service `checkPendingTx` to extract return data
5. Update MPC service `signAndEnqueue` to carry `evmParams` on `PendingTx`
6. Restart sandbox, redeploy DAR
7. Update e2e tests

All changes ship together — no incremental rollout needed since this is
a PoC with sandbox restarts.

## Future Extensions

Once `mpcOutput` carries real ABI data, these become straightforward:

- **DEX swap results** — schemas = `[{"name":"amountOut","type":"uint256"}]`,
  Daml decodes `abiDecodeUint mpcOutput 0` to get the actual output amount
- **Multi-return functions** — schemas =
  `[{"name":"a","type":"uint256"},{"name":"b","type":"uint256"}]`,
  decode multiple slots
- **Batch operations** — schemas = `[{"name":"results","type":"bool[]"}]`,
  decode dynamic arrays using the existing `Abi.daml` array decoders
- **Arbitrary contract calls** — any Solidity function return type
  can be described in the `[{name,type}]` schema and decoded on-ledger

The schema fields on `PendingEvmTx` mean the Daml templates never need
to change — only the choice logic that interprets the decoded values.
