# ADR-0015: The Notion write-discipline lives in one shared standard; domain guides reference it

- **Status:** Accepted
- **Date:** 2026-07-13

## Context
Three `capturing-*` guides plus `reviewing-a-repo` and the two bindings had each restated
the same write spine longhand — fetch live schema, resolve relations (never fabricate),
match select options (never invent), de-dup, confirm before an external write. A
design-audit flagged this as the start of the predecessor's "16 near-identical clones"
trajectory: every future `capturing-an-org/project/meeting` would clone it again.

## Decision
The shared write-discipline lives once in `.claude/standards/writing-records-to-notion.md`
(owned by the publishing system). Every domain guide that writes a Notion record
**references** that standard for the spine and states only its genuine nuance (feature =
why-first; task = date pinning + assignee resolution; contact = fuzzy-option caution).
`reviewing-a-repo` delegates per-card shaping to `/capturing-a-feature` rather than
re-implementing it — `capturing-a-feature` is the single card-shaping authority. New
record types add a target + a thin guide, never a re-cloned spine.

## Consequences
Guides shrink to their nuance; the discipline is fixed in one place; the clone smell is
arrested before it compounds. Also disambiguated the overloaded term "gate": `intake gate`
(ingestion — what enters) is now distinct from the merge gate (governance) and per-write
confirm. Revisit if a domain genuinely can't express itself as standard + nuance — that
would signal the spine is wrong, not the domain.
