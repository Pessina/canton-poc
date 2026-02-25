# client

TypeScript integration tests and scripts for the Canton MPC PoC.

## Prerequisites

- Java 21 and DPM installed (see [LOCAL_SETUP.md](../proposals/LOCAL_SETUP.md))
- DAR built: `dpm build` (from project root)
- Canton sandbox running: `dpm sandbox --json-api-port 7575 --dar .daml/dist/canton-mpc-poc-0.0.1.dar`
- Dependencies installed: `npm install`

## Scripts

| Command                                                      | Description                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `npm test`                                                   | Cross-runtime integration tests (vitest) against a running sandbox        |
| `npm run test:watch`                                         | Tests in watch mode                                                       |
| `npm run demo`                                               | Self-contained demo: sets up ledger, triggers deposit, polls for result   |
| `npm run deposit -- <issuer> <depositor> <orchCid> <userId>` | Trigger a deposit against an existing orchestrator                        |
| `npm run observe`                                            | Stream `PendingDeposit` events indefinitely (pair with `npm run deposit`) |

## Structure

```
src/
├── infra/
│   ├── canton-client.ts    # JSON Ledger API v2 client (openapi-fetch)
│   └── ledger-stream.ts    # WebSocket update stream with HTTP fallback
├── mpc/
│   ├── crypto.ts           # keccak256, computeRequestId (mirrors Daml Crypto)
│   └── observer.ts         # Ledger observer (npm run observe)
├── scripts/
│   ├── demo.ts             # End-to-end demo (npm run demo)
│   └── trigger-deposit.ts  # CLI deposit trigger (npm run deposit)
└── test/
    └── crypto.test.ts      # Integration tests (npm test)
generated/
├── api/                    # OpenAPI-generated types for Canton JSON API
└── model/                  # Daml codegen output (dpm codegen-js)
```

## Regenerating Codegen

```bash
# From project root — after changing Daml templates
dpm build
dpm codegen-js .daml/dist/canton-mpc-poc-0.0.1.dar -o client/generated/model -s daml.js
```

Canton JSON API is hardcoded to `http://localhost:7575` in `src/infra/canton-client.ts`.
