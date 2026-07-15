---
name: onchain
layer: context
system: onchain
kind: component
mold: system-card
---

# System: onchain

## Promise
The org's onchain footprint — **addresses**, wallets and safes, and the rules for
operating them — is tracked in the live [DB] Addresses and governed by the Addresses
and Onchain Operations policy standards (Notion). Decreed by ADR-0050, ahead of its
pieces. Boundary: the process system owns verification processes and runs (an
address's Verification Process relation points there); onchain owns the account
records and the operational rules. Consumers: the team; the process system; the
publishing bindings. Mirrors the LIVE [DB] Addresses schema — fetch live, never an
assumed one (ADR-0016).

## Mechanisms
- None of its own — decreed ahead of pieces (ADR-0050). The Addresses and Onchain
  Operations policy standards (Notion) and the `addresses` target registration are
  live; a capture guide is forged ONLY if its baseline fails (the resources/docs
  precedent). Writes go through the publishing bindings.

## Components
- None of its own. The Notion target `addresses` (live schema mirror) lives in the
  publishing binding's `targets.md`; the rules live in the Addresses and Onchain
  Operations policy standards (Notion, one doc per subject per ADR-0021).

## Concepts
address

## Invariants
- addresses records are shaped to the live [DB] Addresses schema, never an assumed one — enforcer: (gate) + publishing's live schema fetch
- no credential value, seed, or key material ever enters a record — enforcer: (gate) + the Addresses policy + the bindings' confirm
- Verified is checked only with a linked Closed·Success verification run — enforcer: (gate) + the Addresses policy
- records reach Notion through the publishing bindings (the canonical rule; see the publishing card) — enforcer: (gate) + publishing
