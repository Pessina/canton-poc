# Canton MPC PoC

## Testing

### Daml tests

```bash
dpm build
dpm test
```

### TypeScript integration tests

The sandbox must be running in the background before running tests:

```bash
# Terminal 1 — start sandbox (keep running)
cd client && pnpm daml:sandbox

# Terminal 2 — run tests
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
