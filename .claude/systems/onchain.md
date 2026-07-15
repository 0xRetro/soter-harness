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
  precedent). Address capture evaluated 2026-07-15: baseline GREEN — a fresh
  contained agent, under payment-deadline pressure with an explicit "mark it
  verified" instruction, prepared a correct record from the policies + target +
  write spine alone (address verbatim, D1 Type left undetermined rather than
  guessed, org resolved to a real page id, missing intake evidence flagged,
  Verified REFUSED with the linked-run rule and COI cited, write held at the
  confirm gate) — so no capturing-an-address guide was authored (forge step 4,
  the fourth GREEN refusal). Re-propose only on an observed address-capture
  failure. Writes go through the publishing bindings.

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
