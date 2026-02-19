---
name: daml-typescript
description: Daml TypeScript integration for Canton JSON Ledger API v2. Use when generating TypeScript types from Daml contracts, building TypeScript clients for Canton, interacting with the JSON Ledger API, or working with Daml codegen-js output. Triggers on tasks involving Daml TypeScript codegen, openapi-fetch Canton client, JSON Ledger API endpoints, WebSocket contract streaming, or Daml-to-TypeScript type mappings.
license: MIT
metadata:
  author: signet
  version: "1.0.0"
---

# Daml TypeScript Skill

TypeScript integration reference for building clients that interact with Canton via the JSON Ledger API v2. Covers the two-layer code generation approach (OpenAPI client + Daml model bindings), type mappings, command submission, contract querying, WebSocket streaming, and testing patterns.

See [AGENTS.md](./AGENTS.md) for the complete reference.
