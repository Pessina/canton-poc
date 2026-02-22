# Daml 3.x Language Reference

Comprehensive reference for writing Daml smart contracts on Canton. Covers syntax, semantics, type system, and standard library.

---

## Module System

Every Daml file defines a module. The module name must match the file path relative to the `daml/` source directory.

```daml
module MyModule where
```

### Imports

```daml
-- Import entire module
import DA.Optional

-- Import specific names
import DA.Optional (fromSome, isSome, isNone, fromOptional)

-- Import crypto utilities (requires build-options flag)
import DA.Crypto.Text (BytesHex, keccak256, secp256k1WithEcdsaOnly, packHexBytes, byteCount)

-- Import testing utilities
import Daml.Script
```

### Qualified Imports

```daml
import DA.Map qualified as Map
import DA.Set qualified as Set

-- Usage: Map.fromList, Set.member, etc.
```

### Module Hierarchy

File at `daml/Signet/Erc20/Balance.daml` must declare:

```daml
module Signet.Erc20.Balance where
```

---

## Data Types

### Records

Records are product types with named fields. Use `with` to define fields.

```daml
data EvmTransactionParams = EvmTransactionParams with
  erc20Address   : BytesHex
  recipient      : BytesHex
  amount         : BytesHex
  operation      : OperationType
  deriving (Eq, Show)
```

#### Accessing Fields

```daml
let addr = params.erc20Address
let op = params.operation
```

#### Updating Records

```daml
let updated = params with amount = newAmount
let multi = params with amount = newAmount, recipient = newRecipient
```

#### Nested Record Access

```daml
let inner = outer.nested.field
let updated = outer with nested = outer.nested with field = newValue
```

### Variants (Sum Types)

Variants represent one of several possible values.

```daml
data OperationType
  = Erc20Transfer
  | Erc20Approve
  deriving (Eq, Show)
```

#### Variants with Payloads

```daml
data TransactionResult
  = Success with txHash : BytesHex
  | Failure with reason : Text
  | Pending
  deriving (Eq, Show)
```

### Type Aliases

Type aliases create a new name for an existing type. They are interchangeable with the original type.

```daml
type Amount = Int
type Address = BytesHex
type KeyPair = (Party, Text)
```

### Newtypes

For a distinct type (not interchangeable), use a single-constructor single-field record:

```daml
data TokenAmount = TokenAmount with unTokenAmount : Int
  deriving (Eq, Show, Ord)
```

### Enums

Variants with no payloads act as enums:

```daml
data Status
  = Active
  | Suspended
  | Closed
  deriving (Eq, Show, Ord)
```

---

## Type System Reference

Complete mapping of Daml types to their descriptions and TypeScript equivalents (for JSON API / Daml-to-TS codegen):

| Daml Type | Description | TS Equivalent |
|-----------|-------------|---------------|
| `Text` | UTF-8 string | `string` |
| `Int` | 64-bit signed integer | `string` (avoids JS precision loss) |
| `Decimal` | Fixed-point decimal (10 integer + 28 fractional digits) | `string` |
| `Bool` | Boolean value | `boolean` |
| `Party` | Ledger party identifier | `string` |
| `ContractId a` | Reference to a contract of template `a` | `string` |
| `Time` | UTC timestamp with microsecond precision | `string` (ISO 8601) |
| `Date` | Calendar date (no time component) | `string` |
| `Optional a` | Nullable value, either `Some a` or `None` | `a \| null` |
| `[a]` | List (linked list) | `a[]` |
| `TextMap a` | String-keyed map | `{ [key: string]: a }` |
| `Map k v` | Ordered map with any comparable key | `Array<[k, v]>` |
| `Set a` | Ordered set of comparable values | `a[]` |
| `(a, b)` | Tuple | `{ _1: a, _2: b }` |
| `(a, b, c)` | Triple | `{ _1: a, _2: b, _3: c }` |
| `BytesHex` | Hex-encoded bytes (from `DA.Crypto.Text`) | `string` |

### Numeric Precision Notes

- `Int` is 64-bit signed: range is -2^63 to 2^63-1
- `Decimal` has 38 digits total: 10 integer + 28 fractional
- For token amounts, prefer `Int` (whole units or smallest denomination)
- In JSON API, `Int` and `Decimal` are both serialized as strings to avoid JavaScript precision loss

### Deriving Clauses

```daml
deriving (Eq)          -- Equality comparison (==, /=)
deriving (Show)        -- Convert to Text via show
deriving (Ord)         -- Ordering comparison (<, >, <=, >=)
deriving (Eq, Show)    -- Multiple derivations
```

---

## Template Syntax

Templates define contract types on the ledger. They specify the contract payload, authorization rules, and available operations (choices).

```daml
template UserErc20Balance
  with
    operator     : Party
    owner        : Party
    erc20Address : BytesHex
    amount       : Int
  where
    signatory operator
    observer owner

    -- Contract key (optional)
    key (operator, owner, erc20Address) : (Party, Party, BytesHex)
    maintainer key._1
```

### Template Fields

Fields are defined in the `with` block. Each field has a name and a type.

```daml
template MyTemplate
  with
    field1 : Party
    field2 : Text
    field3 : Optional Int
    field4 : [ContractId OtherTemplate]
  where
    ...
```

### Signatory and Observer

- **Signatory**: Parties that must authorize creation and are stakeholders. A contract must have at least one signatory.
- **Observer**: Parties that can see the contract but did not authorize creation.

```daml
signatory operator              -- Single signatory
signatory operator, owner       -- Multiple signatories (ALL must authorize)
observer owner                  -- Single observer
observer owner, auditor         -- Multiple observers
```

### Ensure Clause

Precondition that must hold when the contract is created:

```daml
template PositiveBalance
  with
    owner  : Party
    amount : Int
  where
    signatory owner
    ensure amount > 0
```

### Agreement Text

Human-readable description of the contract:

```daml
template Iou
  with
    issuer : Party
    owner  : Party
    amount : Decimal
  where
    signatory issuer
    observer owner
    agreement show issuer <> " owes " <> show owner <> " " <> show amount
```

---

## Choice Syntax

Choices define operations that can be performed on a contract.

### Consuming Choice (Default)

A consuming choice **archives** (consumes) the contract when exercised. The contract can no longer be used after.

```daml
    choice Transfer : ContractId UserErc20Balance
      with
        newOwner : Party
      controller operator
      do
        create this with owner = newOwner
```

Structure:
- `choice ChoiceName : ReturnType` -- name and return type
- `with` block -- choice arguments (can be empty if no args)
- `controller` -- who can exercise this choice
- `do` block -- the Update action to perform

### Nonconsuming Choice

A nonconsuming choice does **NOT** archive the contract. The contract remains active.

```daml
    nonconsuming choice RequestDeposit : ContractId PendingDeposit
      with
        requester : Party
        amount    : Int
      controller operator, requester
      do
        create PendingDeposit with ..
```

### Preconsuming Choice

Archives the contract **before** executing the body. Useful when the body might fail and you want to ensure the contract is consumed regardless.

```daml
    preconsuming choice Settle : ()
      with
        settler : Party
      controller settler
      do
        -- contract is already archived at this point
        ...
```

### Postconsuming Choice

Archives the contract **after** executing the body. The body sees the contract as still active.

```daml
    postconsuming choice Finalize : ()
      controller operator
      do
        -- contract is still active here
        ...
        -- archived after do block completes
```

### Controller Patterns

```daml
controller operator               -- Single party controls
controller operator, requester    -- Multiple parties (ALL must authorize)
```

When multiple controllers are listed, **all** of them must submit/authorize the transaction.

### Choice Without Arguments

```daml
    choice Archive_ : ()
      controller operator
      do
        pure ()
```

### Choice Returning Multiple Values

```daml
    choice Split : (ContractId UserErc20Balance, ContractId UserErc20Balance)
      with
        splitAmount : Int
      controller operator
      do
        cid1 <- create this with amount = splitAmount
        cid2 <- create this with amount = amount - splitAmount
        pure (cid1, cid2)
```

---

## The Update Monad

Inside choice bodies, you operate in the `Update` monad. All ledger operations are performed here.

### Create a Contract

```daml
cid <- create MyTemplate with
  field1 = val1
  field2 = val2
```

Returns `ContractId MyTemplate`.

### Fetch a Contract by ID

```daml
contract <- fetch someContractId
-- contract is now the payload (e.g., MyTemplate with ...)
let value = contract.someField
```

### Archive (Consume) a Contract

```daml
archive someContractId
```

Equivalent to exercising the built-in `Archive` choice.

### Exercise a Choice on Another Contract

```daml
result <- exercise otherCid SomeChoice with arg1 = val1
```

### Exercise by Key

```daml
result <- exerciseByKey @MyTemplate myKey SomeChoice with arg1 = val1
```

The `@MyTemplate` type application specifies which template to look up.

### Fetch by Key

```daml
(cid, contract) <- fetchByKey @MyTemplate (owner, name)
```

Returns a tuple of `(ContractId MyTemplate, MyTemplate)`.

### Lookup by Key

```daml
optCid <- lookupByKey @MyTemplate (owner, name)
-- optCid : Optional (ContractId MyTemplate)
```

Returns `None` if no active contract with that key exists, `Some cid` otherwise.

### Assertions

```daml
assertMsg "Balance must be positive" (amount > 0)
```

Fails the transaction with the given message if the condition is `False`.

### Abort

```daml
abort "Something went wrong"
```

Unconditionally fails the transaction with the given message.

### Return a Value

```daml
pure result
-- or
return result
```

`pure` is preferred in modern Daml.

### Get Current Time

```daml
now <- getTime
```

Returns `Time` (ledger effective time).

### Bind and Sequencing

```daml
do
  -- Bind result to a name
  cid <- create MyTemplate with ...

  -- Sequence without binding (discard result)
  archive oldCid

  -- Let binding (pure computation, no <-)
  let newAmount = amount + deposit

  -- Return
  pure cid
```

### Combining Multiple Actions

```daml
do
  cid1 <- create Template1 with ...
  cid2 <- create Template2 with ...
  result <- exercise cid1 DoSomething with ...
  archive cid2
  pure result
```

---

## DA.Crypto.Text Module

Provides cryptographic primitives for hex-encoded data. **Requires** the following in `daml.yaml`:

```yaml
build-options:
  - --ghc-option=-Wno-crypto-text-is-alpha
```

### Imports

```daml
import DA.Crypto.Text
  ( BytesHex        -- Hex-encoded bytes, no 0x prefix
  , PublicKeyHex    -- DER-encoded public key in hex
  , SignatureHex    -- DER-encoded signature in hex
  , keccak256       -- BytesHex -> BytesHex (Keccak-256 hash)
  , secp256k1WithEcdsaOnly
      -- SignatureHex -> BytesHex -> PublicKeyHex -> Bool
      -- NOTE: does NOT hash input (unlike secp256k1)
  , packHexBytes    -- BytesHex -> Int -> Optional BytesHex
  , byteCount       -- BytesHex -> Int
  )
```

### Key Behaviors

- **All hex values are bare hex** (no `0x` prefix) in Daml.
- `keccak256` takes hex input and returns hex output (both without `0x`).
- `secp256k1WithEcdsaOnly` performs raw ECDSA verification. It does **NOT** hash the message internally (unlike `secp256k1` which hashes first). You must hash the message yourself before calling this function.
- `packHexBytes targetBytes hexInput` left-pads with zeroes (or right-truncates) to the target byte width. Returns `None` if invalid hex.
- `byteCount` returns the number of bytes represented by the hex string (i.e., `length hex / 2`).

### Usage Example: EVM-style Signature Verification

```daml
verifyEvmSignature : SignatureHex -> BytesHex -> PublicKeyHex -> Bool
verifyEvmSignature signature messageHash publicKey =
  let
    -- Ensure the message hash is exactly 32 bytes
    paddedHash = fromSome (packHexBytes 32 messageHash)
  in
    secp256k1WithEcdsaOnly signature paddedHash publicKey
```

### Building a Keccak Hash of Encoded Data

```daml
buildTransferHash : BytesHex -> BytesHex -> BytesHex -> BytesHex
buildTransferHash erc20Address recipient amount =
  let
    paddedAddress   = fromSome (packHexBytes 32 erc20Address)
    paddedRecipient = fromSome (packHexBytes 32 recipient)
    paddedAmount    = fromSome (packHexBytes 32 amount)
    encoded         = paddedAddress <> paddedRecipient <> paddedAmount
  in
    keccak256 encoded
```

---

## Interfaces

Interfaces define abstract contract behaviors that multiple templates can implement.

### Defining an Interface

```daml
interface Token where
  viewtype TokenView
  getOwner : Party
  transfer : Party -> Update (ContractId Token)

data TokenView = TokenView with
  owner : Party
```

### Implementing an Interface

```daml
template MyToken
  with
    tokenOwner : Party
    issuer     : Party
  where
    signatory issuer
    observer tokenOwner

    interface instance Token for MyToken where
      view = TokenView tokenOwner
      getOwner = tokenOwner
      transfer newOwner = do
        cid <- create this with tokenOwner = newOwner
        pure (toInterfaceContractId cid)
```

### Using Interface Contracts

```daml
-- Exercise via interface
exerciseResult <- exercise (toInterfaceContractId @Token myCid) (Transfer newOwner)

-- Fetch via interface and get the view
tokenView <- view <$> fetch (toInterfaceContractId @Token myCid)
let owner = tokenView.owner
```

### Interface Requires

An interface can require another interface:

```daml
interface TransferableToken requires Token where
  viewtype TransferableTokenView
  canTransfer : Party -> Bool
```

---

## Contract Keys

Contract keys provide a way to look up contracts by a unique identifier rather than by contract ID.

### Defining a Key

```daml
template NamedContract
  with
    owner : Party
    name  : Text
  where
    signatory owner

    key (owner, name) : (Party, Text)
    maintainer key._1
```

- **key**: The key expression and its type. Must be a function of the contract fields.
- **maintainer**: A party (or parties) derived from the key who is responsible for ensuring key uniqueness. Must be a signatory.

### Key Operations

```daml
-- Lookup: returns Optional (ContractId a)
optCid <- lookupByKey @NamedContract (owner, "myName")

-- Fetch: returns (ContractId a, a) -- fails if not found
(cid, contract) <- fetchByKey @NamedContract (owner, "myName")

-- Exercise by key
result <- exerciseByKey @NamedContract (owner, "myName") MyChoice with arg = val
```

### Key Constraints

- The key type must contain at least one `Party` (the maintainer).
- The maintainer must be a signatory of the template.
- At most one active contract can exist for any given key value.
- `lookupByKey` returns `None` if no active contract matches.
- `fetchByKey` aborts the transaction if no active contract matches.

### Composite Keys

```daml
key (operator, owner, erc20Address) : (Party, Party, BytesHex)
maintainer key._1
```

Access tuple elements with `._1`, `._2`, `._3`, etc.

---

## Standard Library Highlights

### DA.Optional

```daml
import DA.Optional (fromSome, isSome, isNone, fromOptional, catOptionals, mapOptional)

fromSome : Optional a -> a                -- Extracts value, crashes on None
isSome   : Optional a -> Bool             -- True if Some
isNone   : Optional a -> Bool             -- True if None
fromOptional : a -> Optional a -> a       -- Default if None
catOptionals : [Optional a] -> [a]        -- Filter out None values
```

### DA.List

```daml
import DA.List (head, tail, last, init, sort, sortBy, sortOn, nub, dedup, zip, unzip, groupBy, partition)

head : [a] -> a                           -- First element (crashes on empty)
tail : [a] -> [a]                         -- All but first (crashes on empty)
sort : Ord a => [a] -> [a]               -- Sort ascending
nub  : Eq a => [a] -> [a]               -- Remove duplicates (keeps first)
dedup : Ord a => [a] -> [a]             -- Remove duplicates (more efficient)
zip  : [a] -> [b] -> [(a, b)]           -- Pair up elements
```

### DA.Text

```daml
import DA.Text (implode, explode, toLower, toUpper, strip, isPrefixOf, isSuffixOf, replace)

implode : [Text] -> Text                  -- Join list of single-char texts
explode : Text -> [Text]                  -- Split into single-char texts
toLower : Text -> Text                    -- Lowercase
toUpper : Text -> Text                    -- Uppercase
strip   : Text -> Text                    -- Trim whitespace
```

### DA.Map (Ordered Map)

```daml
import DA.Map qualified as Map

Map.fromList : [(k, v)] -> Map k v
Map.toList   : Map k v -> [(k, v)]
Map.lookup   : k -> Map k v -> Optional v
Map.insert   : k -> v -> Map k v -> Map k v
Map.delete   : k -> Map k v -> Map k v
Map.member   : k -> Map k v -> Bool
Map.empty    : Map k v
Map.size     : Map k v -> Int
Map.keys     : Map k v -> [k]
Map.values   : Map k v -> [v]
```

### DA.Set (Ordered Set)

```daml
import DA.Set qualified as Set

Set.fromList : [a] -> Set a
Set.toList   : Set a -> [a]
Set.member   : a -> Set a -> Bool
Set.insert   : a -> Set a -> Set a
Set.delete   : a -> Set a -> Set a
Set.empty    : Set a
Set.size     : Set a -> Int
Set.union    : Set a -> Set a -> Set a
Set.intersection : Set a -> Set a -> Set a
```

### DA.Foldable and DA.Traversable

```daml
import DA.Foldable (forA_, mapA_)
import DA.Traversable (forA, mapA)

-- forA_: traverse for side effects only (discards results)
forA_ parties $ \party -> create Notification with ..

-- mapA_: same as forA_ but with different argument order
mapA_ (\cid -> archive cid) contractIds

-- forA: traverse collecting results
cids <- forA amounts $ \amt -> create Token with amount = amt

-- mapA: same as forA but with different argument order
results <- mapA (\x -> exercise x DoSomething) contractIds
```

### DA.Action

```daml
import DA.Action (when, unless, void)

-- when: execute action only if condition is True
when (amount > 0) $ do
  create PositiveBalance with ..

-- unless: execute action only if condition is False
unless (isValid) $ abort "Invalid state"

-- void: discard the result of an action
void $ create SomeTemplate with ..
```

### DA.Time

```daml
import DA.Time (time, addRelTime, subTime, days, hours, minutes, seconds)

-- Construct a time
let t = time (date 2024 Jan 1) 12 0 0

-- Relative time arithmetic
let tomorrow = addRelTime now (days 1)
let anHourAgo = subTime now (hours 1)

-- Relative time constructors
days    : Int -> RelTime
hours   : Int -> RelTime
minutes : Int -> RelTime
seconds : Int -> RelTime
```

---

## Pattern Matching

### Case Expressions

```daml
case myOptional of
  Some value -> doSomething value
  None -> doDefault
```

```daml
case myVariant of
  Erc20Transfer -> handleTransfer
  Erc20Approve -> handleApproval
```

### Pattern Matching with Payloads

```daml
case result of
  Success txHash -> logSuccess txHash
  Failure reason -> abort reason
  Pending -> waitAndRetry
```

### Pattern Matching on Tuples

```daml
case fetchResult of
  (cid, contract) -> exercise cid DoSomething with owner = contract.owner
```

### Wildcard Pattern

```daml
case status of
  Active -> handleActive
  _ -> handleInactive   -- matches everything else
```

### Guards in Functions

```daml
classify : Int -> Text
classify amount
  | amount > 1000 = "large"
  | amount > 100  = "medium"
  | amount > 0    = "small"
  | otherwise     = "invalid"
```

---

## Common Patterns

### String Concatenation

```daml
let greeting = "hello" <> " " <> "world"
let msg = "Balance: " <> show amount
```

### Show (Convert to Text)

```daml
show 42        -- "42"
show True      -- "True"
show myRecord  -- shows all fields (requires deriving Show)
```

### Numeric Operations

```daml
let sum = a + b
let diff = a - b
let prod = a * b
let quotient = a / b     -- integer division for Int
let remainder = a % b    -- modulo
```

### List Operations

```daml
let combined = list1 ++ list2          -- concatenation
let len = length myList                -- length
let mapped = map (\x -> x + 1) myList  -- map
let filtered = filter (\x -> x > 0) myList  -- filter
let folded = foldl (\acc x -> acc + x) 0 myList  -- fold
```

### Optional Chaining

```daml
do
  optCid <- lookupByKey @MyTemplate myKey
  case optCid of
    None -> pure ()
    Some cid -> do
      contract <- fetch cid
      exercise cid DoSomething with ..
```

### Creating Multiple Contracts in a Loop

```daml
do
  cids <- forA recipients $ \recipient ->
    create Notification with
      sender = operator
      receiver = recipient
      message = "Hello"
  pure cids
```

### Conditional Logic in Choices

```daml
choice ProcessPayment : ContractId Receipt
  with
    paymentAmount : Int
  controller operator
  do
    assertMsg "Amount must be positive" (paymentAmount > 0)
    when (paymentAmount > 10000) $
      void $ create AuditLog with ..
    create Receipt with
      payer = owner
      amount = paymentAmount
```

### Record Spread with `..`

When creating a contract with fields that match names in scope:

```daml
let operator = someParty
let owner = someOtherParty
let amount = 100
create MyTemplate with ..   -- fills operator, owner, amount from scope
```

Partial spread:

```daml
create MyTemplate with
  amount = newAmount
  ..   -- fills remaining fields from scope
```

### This Reference in Choices

Inside a choice body, `this` refers to the current contract payload:

```daml
choice UpdateAmount : ContractId MyTemplate
  with
    newAmount : Int
  controller operator
  do
    create this with amount = newAmount
```

---

## Daml Script (Testing)

Daml Script is used for testing contracts locally.

```daml
import Daml.Script

testTransfer : Script ()
testTransfer = script do
  -- Allocate parties
  alice <- allocateParty "Alice"
  bob <- allocateParty "Bob"

  -- Create a contract
  cid <- submit alice do
    createCmd MyTemplate with
      owner = alice
      amount = 100

  -- Exercise a choice
  newCid <- submit alice do
    exerciseCmd cid Transfer with newOwner = bob

  -- Fetch and verify
  contract <- queryContractId bob newCid
  case contract of
    Some c -> assert (c.owner == bob)
    None -> abort "Contract not found"
```

### Script Commands

```daml
submit party do ...          -- Submit as single party (must be signatory)
submitMulti [p1, p2] [] do   -- Submit as multiple parties [signatories] [observers]
submitMustFail party do ...  -- Expect the submission to fail

createCmd template           -- Create a contract
exerciseCmd cid choice       -- Exercise a choice
exerciseByKeyCmd @T key choice  -- Exercise by key
queryContractId party cid    -- Fetch contract visible to party
query @Template party        -- Query all active contracts of a template visible to party
```

---

## Error Handling Patterns

### Assertions

```daml
assertMsg "Descriptive error message" boolCondition
```

### Abort

```daml
abort "Fatal error: cannot proceed"
```

### Conditional Abort

```daml
when (not isValid) $ abort "Validation failed"
unless isValid $ abort "Validation failed"
```

### Try-Catch (Daml Exceptions)

```daml
exception InsufficientFunds
  with
    required : Int
    available : Int
  where
    message "Insufficient funds: required " <> show required <> " but have " <> show available

-- Throwing
throw InsufficientFunds with required = 100, available = 50

-- Catching
try do
  exercise cid Withdraw with amount = 100
catch
  InsufficientFunds e -> handleInsufficientFunds e
```

---

## daml.yaml Configuration

The `daml.yaml` file at the project root configures the Daml project:

```yaml
sdk-version: 3.3.0
name: my-project
version: 1.0.0
source: daml
dependencies:
  - daml-prim
  - daml-stdlib
  - daml3-script
build-options:
  - --ghc-option=-Wno-crypto-text-is-alpha
```

### Key Fields

- `sdk-version`: The Daml SDK version to use.
- `source`: Directory containing `.daml` source files (default: `daml`).
- `dependencies`: Required packages. `daml-prim` and `daml-stdlib` are always needed.
- `build-options`: Compiler flags. The `-Wno-crypto-text-is-alpha` flag is required when using `DA.Crypto.Text`.
