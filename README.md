# Canton MPC PoC

## Prerequisites

- Java 21
- DPM installed (`dpm install 3.4.11`)
- Node.js + pnpm
- See [LOCAL_SETUP.md](proposals/LOCAL_SETUP.md) for full setup guide

## Running Tests

### Daml unit tests

```bash
dpm build
dpm test
```

### TypeScript integration tests

Start the sandbox in the background first, then run tests:

```bash
# Terminal 1 — keep running
dpm sandbox --json-api-port 7575 --dar .daml/dist/canton-mpc-poc-0.0.1.dar

# Terminal 2
cd client
pnpm install
pnpm test              # single run
pnpm test:watch        # watch mode
```

### Sepolia E2E tests

```bash
# 1. Configure env vars
cd client
cp .env.example .env
# Required: SEPOLIA_RPC_URL, MPC_ROOT_PRIVATE_KEY, MPC_ROOT_PUBLIC_KEY

# 2. Start sandbox in background, then run preflight
pnpm daml:sandbox                # Terminal 1
pnpm sepolia:preflight           # Terminal 2 — prints faucet & deposit addresses

# 3. Run e2e
pnpm test:e2e:sepolia
```

## Faucet Top-Up

The Sepolia tests use an auto-funding faucet that sends ETH and ERC20 to session-specific deposit addresses at runtime.

1. Set `FAUCET_PRIVATE_KEY` in `client/.env` (defaults to `MPC_ROOT_PRIVATE_KEY` if unset)
2. Run `pnpm sepolia:preflight` to see the faucet address and current balances
3. Fund the faucet address on Sepolia with:
   - **ETH** — for gas (~0.002 ETH per test run)
   - **ERC20 tokens** — test deposit amount (defaults to test USDC at `0xB4F1...CB0D`)
4. The test suite calls `fundFromFaucet()` automatically — no manual deposit-address funding needed
