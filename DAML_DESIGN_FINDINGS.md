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
- `Split` — owner breaks one holding into two
- `Merge` — owner combines two holdings into one
- `Transfer` — change ownership (controlled by account controllers)

These are exposed via Daml Finance interfaces: `Fungible` and `Transferable`.

```daml
-- On the holding, via Fungible interface
choice Split : (ContractId Holding, ContractId Holding)
  with splitQuantity : Decimal
  controller owner

choice Merge : ContractId Holding
  with otherCid : ContractId Holding
  controller owner
```

**On the Orchestrator/Workflow contract:**
- Deposit flow (MPC verification -> credit holding)
- Withdrawal flow (debit holding -> MPC execution -> confirm/refund)
- Settlement coordination (Batch + Instruction pattern)
- Any business logic that coordinates multiple contracts

The orchestrator **exercises choices on holdings**, not the other way around.

**On the Account contract:**
- Access control: who can send/receive holdings
- Incoming/outgoing transfer controllers

### Key Design Patterns

**Delegation Pattern:** Allows the vault/orchestrator to exercise choices on holdings without requiring the owner to co-sign every operation. The owner creates a delegation contract granting specific rights.

**Propose-Accept Pattern:** For one-off authorization workflows where two parties cannot sign together in one step.

**Locking Pattern:** Prevents holdings from being transferred while locked (e.g., during pending withdrawal).

---

## 3. Current State vs Idiomatic

### What we have (`Erc20Vault.daml`)

| Concern | Current Location | Idiomatic Location |
|---|---|---|
| Split / Merge | Missing entirely | `UserErc20Balance` (owner-controlled) |
| Transfer | Missing entirely | `UserErc20Balance` (via Transferable) |
| Deposit workflow | `VaultOrchestrator` | `VaultOrchestrator` (correct) |
| Withdrawal workflow | `VaultOrchestrator` | `VaultOrchestrator` (correct) |
| MPC verification | `VaultOrchestrator` | `VaultOrchestrator` (correct) |

### Gaps to Address

1. **Add `Split` and `Merge` choices to `UserErc20Balance`** — enables UTXO management
2. **Add `Transfer` choice to `UserErc20Balance`** — enables peer-to-peer transfers
3. **Multi-UTXO withdrawal** — `RequestWithdrawal` currently takes a single `balanceCid`; a user with [4, 10, 6] can't withdraw 15 without first merging
4. **Delegation contracts** — allow the vault to act on holdings without owner co-sign on every internal step
5. **Consider Daml Finance interfaces** — implementing `Fungible` and `Transferable` interfaces for interop with the broader Canton ecosystem

---

## 4. Template Extension and Interface Reuse

### Daml Has No Template Inheritance

Daml does **not** support template inheritance or extension. You cannot write `template MyHolding extends TransferableFungible`. This is a deliberate design choice — templates are sealed, immutable contract definitions.

The official alternative is **interfaces** — Daml's equivalent of traits/protocols.

### How Interfaces Work (Daml 3.x)

A template can **implement multiple interfaces**, gaining their choices and behavior. This is the mechanism for reuse:

```daml
-- 1. Define or import an interface
interface Fungible where
  viewtype FungibleView
  split : Decimal -> Update (ContractId Fungible, ContractId Fungible)
  merge : ContractId Fungible -> Update (ContractId Fungible)

-- 2. Your template implements it
template UserErc20Balance
  with
    operator : Party
    owner : Party
    erc20Address : BytesHex
    amount : Int
  where
    signatory operator
    observer owner

    -- Implement the Fungible interface
    interface instance Fungible for UserErc20Balance where
      view = FungibleView { amount }
      split splitAmount = do
        cid1 <- create this with amount = splitAmount
        cid2 <- create this with amount = amount - splitAmount
        pure (toInterfaceContractId cid1, toInterfaceContractId cid2)
      merge otherCid = do
        other <- fetch (fromInterfaceContractId @UserErc20Balance otherCid)
        archive otherCid
        cid <- create this with amount = amount + other.amount
        pure (toInterfaceContractId cid)
```

Key points:
- A template can implement **multiple interfaces** (e.g., both `Fungible` and `Transferable`)
- Each interface requires its own `interface instance ... for ... where` block
- The `view` method is mandatory — it returns a read-only projection of the contract
- Interfaces can **require other interfaces** via the `requires` keyword (interface inheritance)

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
- Must import the `splice-api-token-holding-v1` DAR as a dependency
- More upfront work to satisfy the full interface

#### Option B: Implement Daml Finance Interfaces (V4)

The Daml Finance library defines interfaces in `Daml.Finance.Interface.Holding.V4`:
- `Holding.I` — base holding
- `Fungible.I` — split/merge
- `Transferable.I` — ownership transfer

**Important: Daml Finance (V4) is built for SDK 2.10.x / LF 1.17.** It is not confirmed available for SDK 3.4.x via dpm. The Splice Token Standard (CIP-56) is the Daml 3.x / Canton Network path forward.

#### Option C: Define Your Own Interfaces (Current Pragmatic Path)

Define minimal `Fungible` and `Transferable` interfaces in your own project. Your `UserErc20Balance` implements them. No external dependencies needed.

**Pros:**
- Zero dependency overhead — works with your current `daml.yaml`
- Full control, easy to understand
- Can migrate to CIP-56 interfaces later

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

### Recommended Approach for This Project

Given SDK 3.4.11 and the current scope (MPC vault PoC):

1. **Start with Option C** — define minimal `Fungible` and `Transferable` interfaces in-project
2. **Have `UserErc20Balance` implement them** — gains Split, Merge, Transfer choices
3. **Keep `VaultOrchestrator` as the workflow layer** — it exercises choices on holdings
4. **When moving to production**, migrate to CIP-56 (`Splice.Api.Token.HoldingV1`) for Canton Network interop

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
