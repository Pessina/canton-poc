# Daml/Canton Design Findings

Research findings on idiomatic patterns for token balance management and contract architecture on Canton.

---

## 1. Balance Model: UTXO, Not Account

Canton uses a **UTXO (Unspent Transaction Output) model**, not an account-based model like EVM.

**Example:** User has 20 USDC from 3 deposits (4, 10, 6):
- **Idiomatic (UTXO):** 3 separate `Holding` contracts with amounts 4, 10, 6
- **Anti-pattern (Account):** 1 contract with `amount = 20`

A user's balance is the **sum of their active holding contracts**, computed off-ledger by querying the active contract set.

### Why UTXO

| Concern | UTXO Model | Account Model |
|---|---|---|
| **Privacy** | Transfer only reveals the specific holding being spent | Reveals full balance to counterparty |
| **Contention** | Parallel operations on independent holdings | Single contract = bottleneck for concurrent txs |
| **Scalability** | Holdings can be split/merged as needed | All operations serialize on one contract |

### UTXO Management Guidelines

- Keep **UTXOs per user below ~10** on average (storage/compute cost consideration)
- Use `MergeDelegation` contracts for automatic background consolidation by wallet providers
- Token implementations (e.g., Canton Coin) enforce a **max of 100 input contracts per transfer**
- Standard operations: **Split** (break 1 holding into 2) and **Merge** (combine N holdings into 1)

### Contract Keys and UTXO

In a UTXO model, multiple `Erc20Holding` contracts can exist for the same `(issuer, owner, erc20Address)` tuple. This means holdings are **intentionally keyless** — a contract key enforces uniqueness, which contradicts UTXO semantics.

Contract keys are appropriate for singleton contracts like `VaultOrchestrator` or `PendingDeposit` (where deduplication by `requestId` is useful), but not for balance holdings.

### CIP-56: Canton Token Standard

The Canton equivalent of ERC-20. Defines standardized interfaces for token creation, transfer, and management. Based on the `Holding` interface.

---

## 2. Contract Architecture: Layered Separation of Concerns

The idiomatic approach separates responsibilities across layers. Not everything on the vault, not everything on the holding.

### Daml Finance Layers

| Layer | Responsibility | Examples |
|---|---|---|
| **Core (Holding)** | Ownership, custody, fungibility | Split, Merge, Transfer choices on the holding |
| **Asset (Instrument)** | Economic terms, contractual semantics | Token metadata, cash flow definitions |
| **Settlement (Workflow)** | Multi-party transaction coordination | Batch, Instruction contracts; deposit/withdraw flows |
| **Lifecycle** | Instrument evolution over time | Contractual events, elections |

### Where Choices Should Live

**On the Holding template (asset-level):**
- `Split` — break one holding into two
- `Merge` — combine two holdings into one
- `Transfer` — change ownership

These are exposed via Daml Finance interfaces: `Fungible` and `Transferable`.

**On the Orchestrator/Workflow contract:**
- Deposit flow (MPC verification -> credit holding)
- Withdrawal flow (debit holding -> MPC execution -> confirm/refund)
- Settlement coordination (Batch + Instruction pattern)
- Any business logic that coordinates multiple contracts

The orchestrator **exercises choices on holdings**, not the other way around.

**On the Account contract:**
- Access control: who can send/receive holdings
- Incoming/outgoing transfer controllers

### Authorization Model for Holding Choices

The controller of Split/Merge/Transfer is a critical design decision that depends on the template's signatory structure.

**Current state:** `Erc20Holding` has `signatory issuer` and `observer owner`. The owner has read-only visibility — no authority to exercise consuming choices.

**Option 1: Issuer-controlled choices** (preserves current auth model)

```daml
choice Split : (ContractId Erc20Holding, ContractId Erc20Holding)
  with splitAmount : Int
  controller issuer
  do
    assertMsg "Split amount must be positive" (splitAmount > 0)
    assertMsg "Split amount must be less than total" (splitAmount < amount)
    cid1 <- create this with amount = splitAmount
    cid2 <- create this with amount = amount - splitAmount
    pure (cid1, cid2)
```

Pros: No signatory changes. Cons: User cannot self-serve UTXO management.

**Option 2: Co-signed choices** (issuer + owner must both authorize)

```daml
choice Split : (ContractId Erc20Holding, ContractId Erc20Holding)
  with splitAmount : Int
  controller issuer, owner
  do ...
```

Pros: User has agency. Cons: Requires multi-party submission (`submit (actAs issuer <> actAs owner) do ...`).

**Option 3: Delegation pattern** (recommended for production)

Owner pre-authorizes specific operations via a delegation contract. The issuer can then act on holdings within the delegated scope without requiring the owner to co-sign each time. See [Section 5](#5-delegation-pattern-design) for the full design.

### Key Design Patterns

**Delegation Pattern:** Allows the vault/orchestrator to exercise choices on holdings without requiring the owner to co-sign every operation. The owner creates a delegation contract granting specific rights.

**Propose-Accept Pattern:** For one-off authorization workflows where two parties cannot sign together in one step. Example: Transfer uses propose-accept when the recipient's account controller must approve incoming transfers.

**Locking Pattern:** Prevents holdings from being transferred while locked (e.g., during pending withdrawal). In our current design, UTXO consumption serves as an implicit lock — `RequestWithdrawal` archives the original balance, so it cannot be double-spent. This is sufficient for the PoC but a formal `Lock` mechanism (as in CIP-56's `HoldingV1`) would be needed for more complex locking scenarios (e.g., collateral holds, escrow).

---

## 3. Current State vs Idiomatic

### What we have (`Erc20Vault.daml`)

| Concern | Current Location | Idiomatic Location |
|---|---|---|
| Split / Merge | Missing entirely | `Erc20Holding` (issuer or co-signed) |
| Transfer | Missing entirely | `Erc20Holding` (via Transferable) |
| Balance invariant | No `ensure` clause | `ensure amount > 0` on `Erc20Holding` |
| Deposit workflow | `VaultOrchestrator` | `VaultOrchestrator` (correct) |
| Withdrawal workflow | `VaultOrchestrator` | `VaultOrchestrator` (correct) |
| MPC verification | `VaultOrchestrator` | `VaultOrchestrator` (correct) |
| EVM params encoding | `Crypto` module | `Crypto` module (correct) |

### Gaps to Address

1. **Add `ensure amount > 0` to `Erc20Holding`** — prevents zero or negative holdings from being created by buggy Split/Merge implementations. This is a defensive invariant that the ledger enforces at contract creation time.

2. **Add `Split` and `Merge` choices to `Erc20Holding`** — enables UTXO management. Controller must be decided (see Section 2 authorization model).

3. **Add `Transfer` choice to `Erc20Holding`** — enables peer-to-peer transfers. For a proper Transfer, the new owner needs to become an observer on the created contract, and account-level controllers (if introduced) should gate incoming transfers.

4. **Multi-UTXO withdrawal** — `RequestWithdrawal` currently takes a single `balanceCid`; a user with [4, 10, 6] can't withdraw 15 without first merging. See [Section 6](#6-multi-utxo-withdrawal-design) for proposed solutions.

5. **Delegation contracts** — allow the vault to act on holdings without owner co-sign on every internal step. See [Section 5](#5-delegation-pattern-design) for the design.

6. **Consider Daml Finance interfaces** — implementing `Fungible` and `Transferable` interfaces for interop with the broader Canton ecosystem.

7. **Withdrawal refund race condition** — `CompleteWithdrawal`'s refund path fetches and archives the debited balance, then creates a refunded one. If additional deposits credited new holdings between `RequestWithdrawal` and `CompleteWithdrawal`, the refund correctly adds back to the debited contract (not other holdings) because it operates on a specific `balanceCid`. However, if that specific `balanceCid` was consumed by another operation (e.g., a second withdrawal), the refund will fail. The UTXO model provides natural protection here — each contract ID is a unique reference — but the orchestrator should handle the case where `balanceCid` no longer exists.

---

## 4. Template Extension and Interface Reuse

### Daml Has No Template Inheritance

Daml does **not** support template inheritance or extension. You cannot write `template MyHolding extends TransferableFungible`. This is a deliberate design choice — templates are sealed, immutable contract definitions.

The official alternative is **interfaces** — Daml's equivalent of traits/protocols.

### How Interfaces Work (Daml 3.x)

A template can **implement multiple interfaces**, gaining their choices and behavior. This is the mechanism for reuse:

```daml
-- 1. Define an interface with a view type and method signatures
data FungibleView = FungibleView
  with
    owner : Party
    amount : Int
  deriving (Eq, Show)

interface Fungible where
  viewtype FungibleView
  getOwner : Party
  getAmount : Int
  split : Int -> Update (ContractId Fungible, ContractId Fungible)
  merge : ContractId Fungible -> Update (ContractId Fungible)

-- 2. Your template implements it
template Erc20Holding
  with
    issuer     : Party
    owner        : Party
    erc20Address : BytesHex
    amount       : Int
  where
    signatory issuer
    observer owner
    ensure amount > 0

    interface instance Fungible for Erc20Holding where
      view = FungibleView with
        owner
        amount
      getOwner = owner
      getAmount = amount
      split splitAmount = do
        assertMsg "Split amount must be positive" (splitAmount > 0)
        assertMsg "Split amount must be less than total" (splitAmount < amount)
        cid1 <- create this with amount = splitAmount
        cid2 <- create this with amount = amount - splitAmount
        pure (toInterfaceContractId cid1, toInterfaceContractId cid2)
      merge otherCid = do
        other <- fetch (fromInterfaceContractId @Erc20Holding otherCid)
        archive otherCid
        cid <- create this with amount = amount + other.amount
        pure (toInterfaceContractId cid)
```

Key points:
- A template can implement **multiple interfaces** (e.g., both `Fungible` and `Transferable`)
- Each interface requires its own `interface instance ... for ... where` block
- The `view` method is mandatory — it returns a read-only projection of the contract via a dedicated view data type
- `viewtype` in the interface declaration specifies the view's return type
- `toInterfaceContractId` / `fromInterfaceContractId` convert between concrete and interface contract IDs
- Interfaces can **require other interfaces** via the `requires` keyword (interface inheritance)
- Interface methods that modify state return `Update` actions; pure getters return values directly

### Interface Choices vs Template Choices

When a template implements an interface, the interface's methods become exercisable as choices. However, **the controller is not specified in the interface** — it's determined by how the choice is exercised:

- Interface choices are exercised via `exercise (toInterfaceContractId @Fungible cid) (Split 50)` where the submitting party must have the required authorization
- The signatory/observer rules of the template still apply — the submitting party must satisfy the authorization check

For our `Erc20Holding` where `signatory issuer`, only the issuer (or parties authorized via delegation) can exercise consuming choices.

### Two Paths for Standard Compliance

#### Option A: Implement Splice Token Standard Interfaces (CIP-56)

The Canton Network token standard (CIP-56) defines interfaces in the `Splice.Api.Token` namespace:
- `Splice.Api.Token.HoldingV1` — core holding with Lock, Unlock, Transfer, Split, Merge
- `Splice.Api.Token.TransferInstructionV1` — transfer workflow
- `Splice.Api.Token.MetadataV1` — token metadata

You write your own template and implement these interfaces. This gives you full ecosystem interop (wallets, registries, settlement).

**Pros:**
- Full Canton Network interoperability
- Wallet providers can discover and manage your holdings
- Standard Split/Merge/Transfer/Lock choices come "for free" via the interface contract
- You keep full control of your template fields and custom choices (MPC logic)

**Cons:**
- You must implement all required interface methods yourself
- Must import the `splice-api-token-holding-v1` DAR as a dependency in `daml.yaml`
- More upfront work to satisfy the full interface

#### Option B: Implement Daml Finance Interfaces (V4)

The Daml Finance library defines interfaces in `Daml.Finance.Interface.Holding.V4`:
- `Holding.I` — base holding
- `Fungible.I` — split/merge
- `Transferable.I` — ownership transfer

**Important: Daml Finance (V4) is built for SDK 2.10.x / LF 1.17.** It is not confirmed available for SDK 3.4.x via dpm. The Splice Token Standard (CIP-56) is the Daml 3.x / Canton Network path forward.

#### Option C: Define Your Own Interfaces (Current Pragmatic Path)

Define minimal `Fungible` and `Transferable` interfaces in your own project. Your `Erc20Holding` implements them. No external dependencies needed.

**Pros:**
- Zero dependency overhead — works with your current `daml.yaml`
- Full control, easy to understand
- Can migrate to CIP-56 interfaces later by adding the interface instances (Smart Contract Upgrades in Canton 3.3+)

**Cons:**
- No ecosystem interop out of the box
- Must write and maintain the interface definitions yourself

### What You Cannot Do

- **Extend an existing template** — no inheritance, period
- **Add choices to someone else's template** — retroactive interfaces were deprecated in Daml 2.10 and removed in Daml 3.x
- **Use Daml Finance V4 implementations directly on SDK 3.4** — not confirmed compatible; the Splice Token Standard is the 3.x equivalent

### Daml 3.x Specific Changes

- **Retroactive interfaces removed** — you can no longer add interface instances to templates you don't own (was deprecated in 2.10, gone in 3.x)
- **Smart Contract Upgrades (SCU)** replace retroactive interfaces — you can add new interface implementations to your own templates via package upgrades (Canton 3.3+)
- **dpm** replaces the old Daml Assistant — dependencies are specified as `.dar` file paths in `daml.yaml`
- **`submitMulti` is deprecated** — use `submit (actAs p1 <> actAs p2) do ...` instead of `submitMulti [p1, p2] [] do ...`
- **`Int` amounts** — our template uses `Int` for amounts. CIP-56 / Daml Finance typically use `Decimal`. This is a migration consideration if we adopt standard interfaces later. For the PoC, `Int` representing smallest denomination (e.g., wei, satoshis) is appropriate.

### Recommended Approach for This Project

Given SDK 3.4.11 and the current scope (MPC vault PoC):

1. **Start with Option C** — define minimal `Fungible` and `Transferable` interfaces in-project
2. **Have `Erc20Holding` implement them** — gains Split, Merge, Transfer choices
3. **Add `ensure amount > 0`** — defensive invariant on all holdings
4. **Use issuer-controlled choices for the PoC** — simplest auth model, no signatory changes needed
5. **Keep `VaultOrchestrator` as the workflow layer** — it exercises choices on holdings
6. **When moving to production**, migrate to CIP-56 (`Splice.Api.Token.HoldingV1`) for Canton Network interop, and switch to delegation-based authorization

---

## 5. Delegation Pattern Design

The delegation pattern allows the issuer to exercise choices on holdings without requiring the owner to co-sign every operation. The owner creates a one-time delegation contract granting specific rights.

### MergeDelegation

Allows the issuer (or a wallet provider) to consolidate a user's UTXOs in the background:

```daml
template MergeDelegation
  with
    issuer     : Party
    owner        : Party
    erc20Address : BytesHex
  where
    signatory issuer, owner
    -- Both must sign creation (via propose-accept or multi-party submit).
    -- This ensures the owner explicitly consents to delegation.

    nonconsuming choice ExecuteMerge : ContractId Erc20Holding
      with
        holdingCids : [ContractId Erc20Holding]
      controller issuer
      -- Only issuer can trigger, but owner's authority is
      -- inherited from the delegation contract's signatories.
      do
        assertMsg "Need at least 2 holdings to merge" (length holdingCids >= 2)
        -- Fetch all, verify they belong to the same owner/token, sum amounts
        holdings <- mapA fetch holdingCids
        let totalAmount = foldl (\acc h -> acc + h.amount) 0 holdings
        -- Verify all holdings match the delegation scope
        forA_ holdings $ \h -> do
          assertMsg "Owner mismatch" (h.owner == owner)
          assertMsg "Token mismatch" (h.erc20Address == erc20Address)
        -- Archive all inputs
        mapA_ archive holdingCids
        -- Create consolidated output
        create Erc20Holding with
          issuer
          owner
          erc20Address
          amount = totalAmount

    choice RevokeDelegation : ()
      controller owner
      -- Owner can revoke at any time by archiving this contract.
      -- Note: owner is a signatory, so they can exercise consuming choices.
      do pure ()
```

### Creating Delegation via Propose-Accept

Since the owner is not currently a signatory on `Erc20Holding`, we need a propose-accept pattern for creating the `MergeDelegation` (which requires both signatories):

```daml
template MergeDelegationProposal
  with
    issuer     : Party
    owner        : Party
    erc20Address : BytesHex
  where
    signatory issuer
    observer owner

    choice AcceptDelegation : ContractId MergeDelegation
      controller owner
      do
        create MergeDelegation with ..

    choice WithdrawProposal : ()
      controller issuer
      do pure ()
```

Workflow: Issuer creates `MergeDelegationProposal` -> Owner exercises `AcceptDelegation` -> `MergeDelegation` is created with both signatories.

### Testing Delegation

```daml
testMergeDelegation : Script ()
testMergeDelegation = do
  issuer <- allocateParty "Issuer"
  owner <- allocateParty "Owner"
  let erc20Addr = "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"

  -- Create multiple small holdings
  cid1 <- submit issuer do
    createCmd Erc20Holding with
      issuer; owner; erc20Address = erc20Addr; amount = 100
  cid2 <- submit issuer do
    createCmd Erc20Holding with
      issuer; owner; erc20Address = erc20Addr; amount = 250
  cid3 <- submit issuer do
    createCmd Erc20Holding with
      issuer; owner; erc20Address = erc20Addr; amount = 50

  -- Create delegation via propose-accept
  proposalCid <- submit issuer do
    createCmd MergeDelegationProposal with
      issuer; owner; erc20Address = erc20Addr
  delegationCid <- submit owner do
    exerciseCmd proposalCid AcceptDelegation

  -- Issuer merges all 3 holdings into 1
  mergedCid <- submit issuer do
    exerciseCmd delegationCid ExecuteMerge with
      holdingCids = [cid1, cid2, cid3]

  -- Verify consolidated balance
  merged <- queryContractId owner mergedCid
  assertMsg "Merged amount must equal sum"
    ((fromSome merged).amount == 400)

  pure ()
```

---

## 6. Multi-UTXO Withdrawal Design

`RequestWithdrawal` currently takes a single `balanceCid`. A user with holdings [4, 10, 6] can't withdraw 15 without first merging. Two approaches:

### Approach A: Merge-Then-Withdraw (Simpler)

User explicitly merges holdings first, then withdraws from the merged holding. This keeps `RequestWithdrawal` simple and delegates UTXO management to the user/client layer.

```
Client-side:
1. Query all Erc20Holding for (owner, erc20Address)
2. Select holdings that sum to >= withdrawAmount
3. If multiple selected, exercise Merge to consolidate
4. Exercise RequestWithdrawal with the single merged holding
```

**Pros:** No changes to `VaultOrchestrator`. Clean separation.
**Cons:** Requires 2 transactions (merge + withdraw). Client must handle UTXO selection.

### Approach B: Batch-Input Withdrawal (More Capable)

Modify `RequestWithdrawal` to accept a list of holding contract IDs:

```daml
nonconsuming choice RequestWithdrawal : (ContractId Erc20Holding, ContractId PendingWithdrawal)
  with
    requester        : Party
    balanceCids      : [ContractId Erc20Holding]  -- multiple inputs
    recipientAddress : BytesHex
    withdrawAmount   : Int
    evmParams        : EvmTransactionParams
  controller issuer, requester
  do
    assertMsg "Must provide at least one holding" (not (null balanceCids))
    -- Fetch and archive all inputs
    holdings <- mapA fetch balanceCids
    mapA_ archive balanceCids

    -- Verify all belong to requester and same token
    let erc20Addr = (head holdings).erc20Address
    forA_ holdings $ \h -> do
      assertMsg "Owner mismatch" (h.owner == requester)
      assertMsg "Token mismatch" (h.erc20Address == erc20Addr)

    let totalAvailable = foldl (\acc h -> acc + h.amount) 0 holdings
    assertMsg "Insufficient balance" (totalAvailable >= withdrawAmount)

    let requestId = computeRequestId evmParams
    let changeAmount = totalAvailable - withdrawAmount

    -- Create change output if needed
    newBalCid <- create Erc20Holding with
      issuer
      owner = requester
      erc20Address = erc20Addr
      amount = changeAmount

    pendingCid <- create PendingWithdrawal with
      issuer
      requester
      erc20Address = erc20Addr
      amount = withdrawAmount
      recipientAddress
      requestId
      evmParams

    pure (newBalCid, pendingCid)
```

**Pros:** Single atomic transaction. No separate merge step.
**Cons:** More complex choice. The `ensure amount > 0` on `Erc20Holding` will reject creation if `changeAmount == 0`, so the choice needs to handle the exact-amount case (skip creating change output or return `Optional (ContractId Erc20Holding)`).

### Recommendation

**Start with Approach A** (merge-then-withdraw) for the PoC. The client-side UTXO selection logic is needed regardless, and keeping `RequestWithdrawal` simple reduces contract complexity. Move to Approach B when withdrawal UX becomes a priority.

---

## 7. TypeScript Integration Notes

When building the TypeScript client layer for these contracts, key considerations from the Canton JSON Ledger API v2:

- **`Int` maps to `string` in TypeScript** — pass amounts as `"100000000"` not `100000000` to avoid precision loss
- **Hex encoding**: Daml uses bare hex (`"a0b86991..."`), TypeScript/viem uses `0x`-prefixed (`"0xa0b86991..."`). Strip/add prefix at the API boundary.
- **Template IDs**: Use `#packageName:ModuleName:TemplateName` format with `#` prefix for package-name resolution. Import from generated codegen bindings rather than hardcoding.
- **Command submission has double nesting**: `{ commands: { commands: [...], commandId, userId, actAs, readAs } }`
- **Response asymmetry**: Submit uses `createArguments` (plural), responses return `createArgument` (singular)
- **Multi-party submissions**: Include all required signatories in `actAs` and set `readAs` to at least the same parties

---

## References

- [Tokenization of RWAs on Canton vs EVM — Part 1](https://blog.digitalasset.com/blog/tokenization-of-rwas-on-canton-network-vs-evm-chains-part-1)
- [Daml Finance Asset Model](https://docs.daml.com/daml-finance/concepts/asset-model.html)
- [Canton Token Standard APIs (CIP-56)](https://docs.global.canton.network.sync.global/app_dev/token_standard/index.html)
- [Contention Techniques](https://docs.daml.com/daml/resource-management/contention-techniques.html)
- [Settlement Concepts](https://docs.daml.com/daml-finance/concepts/settlement.html)
- [Good Design Patterns](https://docs.daml.com/daml/patterns.html)
- [Delegation Pattern](https://docs.daml.com/daml/patterns/delegation.html)
- [Composing Choices](https://docs.daml.com/daml/intro/7_Composing.html)
- [A Deeper Look at Daml Finance](https://blog.digitalasset.com/blog/deeper-look-at-daml-finance)
- [Daml Finance Holding Interface](https://docs.daml.com/daml-finance/packages/interfaces/daml-finance-interface-holding.html)
- [Transfer Tutorial](https://docs.daml.com/daml-finance/tutorials/getting-started/transfer.html)
- [Daml Interfaces Reference](https://docs.daml.com/daml/reference/interfaces.html)
- [Daml 3.x Interfaces Reference](https://docs.digitalasset.com/build/3.3/reference/daml/interfaces.html)
- [Daml Interfaces Tutorial](https://docs.daml.com/daml/intro/13_Interfaces.html)
- [Inheritance in Daml (Community Discussion)](https://discuss.daml.com/t/how-can-we-implement-or-simulate-inheritance-in-daml/6082)
- [Interfaces in Daml 3 (Community Discussion)](https://discuss.daml.com/t/interfaces-in-daml-3/8093)
- [Splice Token Standard (CIP-56) Source](https://github.com/hyperledger-labs/splice/tree/main/token-standard)
- [Canton Token Standard APIs](https://docs.global.canton.network.sync.global/app_dev/token_standard/index.html)
- [Registry Holding Template (Production Example)](https://docs.digitalasset.com/utilities/mainnet/daml-api-reference/registry-holding-model/Utility-Registry-Holding-V0-Holding.html)
- [DPM Package Manager (Daml 3.x)](https://docs.digitalasset.com/build/3.4/dpm/dpm.html)
- [DPM Configuration](https://docs.digitalasset.com/build/3.4/dpm/configuration.html)
- [Daml Finance Holding Implementations](https://docs.daml.com/daml-finance/packages/implementations/daml-finance-holding.html)
