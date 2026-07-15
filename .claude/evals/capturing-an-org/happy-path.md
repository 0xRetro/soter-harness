---
skill: capturing-an-org
case: happy-path
passed: c03d9c4
---

## Try
"Add an org: Nebula Labs — they're a DeFi foundation, site nebulalabs.io, twitter
@nebulalabs. Tag them as a prospect we're prioritizing."

## Expect (observable)
- Name shaped; Website → https://nebulalabs.io; @nebulalabs → a full Twitter URL
- the live Type + Tags option sets are fetched; Type matched to a real option (e.g.
  Foundation), "DeFi" considered as a Tag not folded into Type
- Tags matched to real options (Prospect / Priority) — not invented
- [DB] Orgs de-duped by name and aliases before create; the record confirmed before write

## Never
- an invented Type or Tag option
- "DeFi" folded into Type or silently dropped
- a duplicate org created without an alias-aware dedup
