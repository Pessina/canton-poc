---
name: daml-language
description: Daml 3.x language syntax and semantics reference. Use when writing Daml smart contracts, defining templates, choices, data types, or working with the Daml type system. Triggers on tasks involving .daml files, template definitions, choice implementations, Daml data types, contract keys, interfaces, or Daml standard library usage.
license: MIT
metadata:
  author: signet
  version: "1.0.0"
---

# Daml Language Skill

Comprehensive Daml 3.x language reference for writing smart contracts on Canton.

See [AGENTS.md](./AGENTS.md) for the full language reference including:

- Module system and imports
- Data types (records, variants, type aliases)
- Complete type system reference with TypeScript equivalents
- Template syntax (signatory, observer, key, maintainer)
- Choice syntax (consuming, nonconsuming, controller patterns)
- The Update monad (create, fetch, archive, exercise, assertions)
- DA.Crypto.Text module (BytesHex, keccak256, secp256k1WithEcdsaOnly)
- Interfaces and interface instances
- Contract keys (lookupByKey, fetchByKey, exerciseByKey)
- Standard library highlights (DA.Optional, DA.List, DA.Map, DA.Set, etc.)
- Pattern matching and common patterns
