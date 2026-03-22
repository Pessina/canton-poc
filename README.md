# Canton MPC PoC

MPC-based ERC-20 custody on Canton. Daml smart contracts manage vault state (deposits, withdrawals, holdings) while a TypeScript MPC service signs EVM transactions using threshold-derived keys via [signet.js](https://github.com/aspect-build/signet.js).

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Java | 21+ | [Temurin](https://adoptium.net/) |
| Daml SDK (DPM) | 3.4.11 | `curl -sSL https://get.digitalasset.com/install/install.sh \| sh` |
| Node.js | 20+ | [nodejs.org](https://nodejs.org/) |
| pnpm | 10+ | `corepack enable && corepack prepare pnpm@latest --activate` |

After installing DPM, make sure `~/.dpm/bin` is on your `PATH`.

## Configuration

The TypeScript client reads `CANTON_JSON_API_URL` from the environment to connect to the Canton JSON Ledger API. Defaults to `http://localhost:7575` if unset.

```bash
# Point to a remote or non-default sandbox
export CANTON_JSON_API_URL=http://my-canton-node:7575
```

See `client/.env.example` for all available variables.

## Quick Start

### 1. Build the DAR and generate codegen

```bash
dpm build
cd client
pnpm run codegen:daml
pnpm install
```

### 2. Start the Canton sandbox

In a separate terminal (keep it running):

```bash
cd client
pnpm daml:sandbox
```

Wait until you see the JSON API listening on port 7575. You can verify with:

```bash
curl -sf http://localhost:7575/docs/openapi > /dev/null && echo "Ready"
```

### 3. Run tests

```bash
cd client
pnpm test          # single run (unit + integration)
pnpm test:watch    # watch mode
```

### One-liner rebuild

If you change Daml sources and need a full clean rebuild:

```bash
cd client && pnpm generate
```

This runs `clean -> daml:build -> codegen:daml -> install` in sequence.

## Daml Unit Tests

These don't need the sandbox:

```bash
dpm build
dpm test
```

## Sepolia E2E Tests

End-to-end tests that exercise the full deposit/withdrawal lifecycle against a live Sepolia RPC and the Canton sandbox.

### Setup

```bash
cd client
cp .env.example .env
```

Fill in the required values:

| Variable | Description |
|----------|-------------|
| `CANTON_JSON_API_URL` | (optional) Canton JSON API base URL (default `http://localhost:7575`) |
| `SEPOLIA_RPC_URL` | Sepolia JSON-RPC endpoint (Infura, Alchemy, etc.) |
| `MPC_ROOT_PRIVATE_KEY` | `0x`-prefixed secp256k1 private key (64 hex chars) |
| `MPC_ROOT_PUBLIC_KEY` | Uncompressed SEC1 public key (`04` + x + y, no `0x` prefix) |
| `VAULT_ID` | Vault discriminator for MPC key derivation |
| `FAUCET_PRIVATE_KEY` | (optional) Defaults to `MPC_ROOT_PRIVATE_KEY` |
| `ERC20_ADDRESS` | (optional) Defaults to test USDC on Sepolia |

### Fund the faucet

```bash
pnpm sepolia:preflight    # prints faucet address + current balances
```

Send to the faucet address:
- ~0.002 ETH for gas per test run
- ERC-20 tokens for the deposit amount

### Run

```bash
# Start sandbox in a separate terminal first, then:
pnpm test:e2e:sepolia
```

## Project Structure

```
daml/                       Daml smart contracts
  Erc20Vault.daml             Core templates: VaultOrchestrator, Erc20Holding, PendingEvmTx, ...
  Crypto.daml                 Hex utilities, EIP-712 domain separator
  RequestId.daml              EIP-712 struct hashing for EvmTransactionParams
  Abi.daml                    ABI encoding/decoding library
  HexCompare.daml             Unsigned/signed hex comparison
  Types.daml                  Shared data types (EvmTransactionParams)
  Test*.daml                  Daml Script tests

client/src/
  infra/                    Canton JSON Ledger API client + helpers
    canton-client.ts          Type-safe openapi-fetch wrapper
    canton-helpers.ts         Event extraction utilities
    ledger-stream.ts          WebSocket update stream with reconnect
  mpc/                      MPC cryptography
    address-derivation.ts     Deposit address derivation (signet.js)
    crypto.ts                 EIP-712 requestId / responseHash (mirrors Daml)
  mpc-service/              MPC signing service
    index.ts                  Entry point: DAR upload, party bootstrap, start server
    server.ts                 Ledger stream monitor for PendingEvmTx
    signer.ts                 Child key derivation + ECDSA signing
    tx-handler.ts             Sign -> submit -> confirm lifecycle
  evm/
    tx-builder.ts             EIP-1559 tx serialization via viem
  config/
    env.ts                    Zod-validated env config
  scripts/
    sepolia-preflight.ts      Check faucet balances and print deposit addresses
  test/                     Vitest test suite
    abi.test.ts               ABI encoding cross-language vectors (matches Daml)
    crypto.test.ts            EIP-712 requestId / responseHash
    signer.test.ts            MPC child key derivation + signing
    address-derivation.test.ts  Deposit address derivation
    visibility-permissions.test.ts  Canton contract visibility & permission checks
    sepolia-e2e.test.ts       Sepolia deposit lifecycle e2e
    sepolia-withdrawal-e2e.test.ts  Sepolia withdrawal lifecycle e2e
    helpers/                  Shared e2e setup and Sepolia utilities
```

## Available Scripts

From `client/`:

| Script | Description |
|--------|-------------|
| `pnpm test` | Run all tests (unit + integration) |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm test:e2e:sepolia` | Run Sepolia deposit e2e test |
| `pnpm daml:build` | Build the DAR |
| `pnpm daml:test` | Run Daml Script tests |
| `pnpm daml:sandbox` | Start Canton sandbox with JSON API on :7575 |
| `pnpm codegen:daml` | Regenerate Daml JS codegen from built DAR |
| `pnpm codegen:api` | Regenerate OpenAPI types (requires running sandbox) |
| `pnpm generate` | Full clean rebuild: DAR + codegen + install |
| `pnpm mpc-service` | Start the MPC signing service |
| `pnpm sepolia:preflight` | Check faucet balances and print deposit addresses |
| `pnpm check` | Typecheck + lint + knip + format check |
| `pnpm fix` | Auto-fix lint + format |
