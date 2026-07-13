# ADR-0014: Product-development mirrors the live Notion schema; reality is the source of truth

- **Status:** Accepted
- **Date:** 2026-07-12

## Context
The product-development system and the `capturing-a-feature` guide were authored against
an *assumed* feature-record schema (Name/Use-case/Owner/Status/Project link) and an
invented lifecycle (capture → define → build → review → ship). The first live push to
the real Ozone HQ workspace exposed the truth: the Feature Board has only
`Name` / `Description` / `Status`, its statuses are Planned → Up Next → In Development →
Completed → Canceled, and owner/type/links live on the [DB] Tooling project page, not
the card.

## Decision
The live Notion boards are the source of truth for product-development shapes. The
harness mirrors them: feature records carry Name + the why (in `Description`) + Status;
the feature lifecycle is the board's real statuses; owner and the owning tool live on
the project page. Assumed fields that don't exist on the board are removed from the
guide, the system card, and `targets.md`. Before a push, re-fetch the schema rather than
trust a stored assumption.

## Consequences
The capture→publish pipeline is verified end-to-end against the real workspace (a live
card was created). The guide got simpler, matching the "lightweight" intent.
`targets.md` now holds real data-source ids (not secrets). Revisit whenever the boards
change shape — the fix is to re-fetch and update `targets.md`, not to guess.
