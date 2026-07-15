# ADR-0049: Private-workspace docs — the docs system's second tier

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

The docs system's promise is anchored to [DB] Docs, but part of what the team writes
lives in restricted workspace collections (leadership meeting logs, agendas) that must
not surface in the org library or the repo. A first attempt routed a private meeting
log into [DB] Docs as a Reference/Dashboard row; the user reversed it — discoverability
in the shared library is itself a leak. The harness is wanted for exactly this work
(generating recurring entries, keeping doc shape), and the SFF <> GovOps meeting log
became the worked example: its in-collection template page now carries the shape AND
the generation chores as a checklist.

## Decision

The docs system owns a second tier: **private-workspace docs** — docs in restricted
collections, each governed by a template page living in the collection itself (shape +
generation-chores checklist) and served by the harness in place. They never become
[DB] Docs rows, and their content, agendas, and page ids never enter harness pieces,
evals, gotchas, org databases, or memory — the harness learns the pattern, never the
instance. The Docs policy standard's scope excludes them.

## Consequences

The harness can do recurring private doc work (duplicate the template, execute its
checklist) with no standing trace outside the collection; the in-collection template
page is the entire mechanism — proven, not hoped: the generation baseline ran
2026-07-15 (fresh agent, user-shaped request only, dry-run) and FULLY COMPLIED —
located the collection by search, read the template callout as the procedure,
produced a faithful entry with all follow-up chores, surfaced its unknowns as
questions instead of guesses, and held at the write gate. No guide is authored
(capturing-a-doc's GREEN verdict is the sibling precedent — the teaching layer
keeps winning). Cost, accepted deliberately:
private docs are invisible to the governed library. Revisit triggers: a private doc
needing org-visible discoverability (it graduates into [DB] Docs by explicit decision,
never automatically), or a private-doc generation baseline failing (forge a guide).
