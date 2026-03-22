# EIP-712 Implementation Improvements

## Code Quality

### 1. Remove duplicated `safeKeccak256`
- **Where:** `RequestId.daml:64` redefines `safeKeccak256` locally inside `computeResponseHash`
- **Fix:** Import `safeKeccak256` from `Crypto` module instead of redefining it
- **Risk:** Maintenance — if the logic diverges between the two copies

### 2. Split `padHex` into `padLeft` / `padRight`
- **Where:** `Crypto.daml:18-19`
- **Why:** `padHex` always left-pads, which is correct for `uint`, `int`, `address` but **wrong** for `bytes1`–`bytes31` (must be right-padded per EIP-712 spec [ED-8/ED-8a])
- **Fix:** Rename to `padLeft` or create both `padLeft`/`padRight`. Makes padding direction explicit and prevents silent bugs if `bytesN` types are added later

### 3. Validate `bytes32` input length
- **Where:** `RequestId.daml:62` — `padHex requestId 32`
- **Why:** A shorter-than-32-byte `requestId` would be silently left-padded, which is semantically wrong for a `bytes32` field (should be right-padded or rejected)
- **Fix:** Add an assertion that `byteCount requestId == 32` before use

## Test Coverage

### 4. Add official EIP-712 spec test vectors (Mail/Person example)
- **Why:** Current tests use viem as oracle. The spec includes canonical vectors that prove encoding correctness independent of any library
- **Vectors to add:**

| Computation | Expected |
|---|---|
| `encodeType('Mail')` | `"Mail(Person from,Person to,string contents)Person(string name,address wallet)"` |
| `typeHash('Mail')` | `0xa0cedeb2dc280ba39b857546d74f5549c3a1d7bdc2dd96bf881f76108e23dac2` |
| `hashStruct(mail)` | `0xc52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e` |
| `domainSeparator` | `0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f` |
| `signHash` | `0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2` |

- **Domain:** `{name: "Ether Mail", version: "1", chainId: 1, verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"}`
- **Message:** `Mail{from: Person{name: "Cow", wallet: 0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826}, to: Person{name: "Bob", wallet: 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB}, contents: "Hello, Bob!"}`

### 5. Add vector-based assertions to existing Daml tests
- **Where:** `TestRequestId.daml` tests for `testHashText`, `testHashBytesList`, `testHashEvmParams`, etc.
- **Why:** These tests only check determinism, length, and uniqueness — they would pass with a broken-but-consistent hash function
- **Fix:** Add expected hex value assertions (hardcoded from viem) alongside the property checks

### 6. Add empty array vector test
- **Where:** `TestRequestId.daml`
- **Why:** `hashBytesList []` returns `keccak256Empty` — verify this matches `keccak256("")` = `c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470` explicitly

## Future Generalization (if needed)

### 7. Build a general `encodeType` function
- **Why:** Type strings are hardcoded. A general function would take type name + fields + referenced types and produce the string with correct alphabetical ordering of referenced types
- **When:** Only needed if you add more struct types beyond the current three

### 8. Add missing EIP-712 type encodings
- `bool` — `false` = `uint256(0)`, `true` = `uint256(1)`
- `intN` — sign-extend to 256 bits (two's complement)
- `bytesN` (N < 32) — right-pad to 32 bytes
- Fixed-size arrays `Type[n]` — encode like struct with N members, then keccak256
- Struct arrays — `hashStruct` each element, concatenate, keccak256
- **When:** Only needed if your domain types expand to use these

### 9. Support full domain separator fields
- Add optional `chainId` (`uint256`), `verifyingContract` (`address`), `salt` (`bytes32`)
- **When:** Only needed if signature verification moves on-chain or cross-domain
