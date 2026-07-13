# ADR-0002: Systems-first classification — four declared fields

- **Status:** Accepted
- **Date:** 2026-07-12

## Context
sky grouped pieces into three kinds with systems as unenforced commentary; nothing
read the system boundaries, so they couldn't hold weight across users. No surveyed
harness has a taxonomy above the skill level — coherence rests on one maintainer's
taste, which does not transfer.

## Decision
Every durable content piece declares `layer · system · kind · mold` in frontmatter.
Systems are first-class: one card each in `.claude/systems/` (promise · mechanisms ·
components · concepts · invariants), grouped by concern — never by delivery-form.
The checker validates all four fields, that the named system's card exists, and
that the named mold exists.

## Consequences
Placement is mechanical (the four questions in `.claude/LEXICON.md`); structure is
checked, not trusted. This is deliberately past current ecosystem practice — the
guard against over-modeling is the consumer rule: every field is read by the
checker, the model, or a human, and a shape nothing reads gets deleted. Revisit if
cards rot into structure nothing consults.
