# Canton MPC PoC

## Testing

### Daml tests

```bash
dpm build
dpm test
```

### TypeScript tests (unit + e2e)

The sandbox must be running before tests. The e2e test (sepolia-e2e) needs it; unit tests (crypto, signer, address-derivation) pass without it.

```bash
# 1. Build DAR and regenerate codegen (required after Daml changes)
dpm build
cd client && pnpm codegen:daml

# 2. Start sandbox in a separate terminal (keep running)
cd client && pnpm daml:sandbox

# 3. Run all tests (unit + e2e)
cd client && pnpm test
```

### Sepolia E2E tests

Requires `.env` with `SEPOLIA_RPC_URL`, `MPC_ROOT_PRIVATE_KEY`, `MPC_ROOT_PUBLIC_KEY`, and a funded faucet.

```bash
# Start sandbox in background first, then:
cd client
pnpm sepolia:preflight    # verify faucet balances
pnpm test:e2e:sepolia
```
