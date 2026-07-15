# ADR-0055: Anti-drift hardening — divergence-to-eval norm, two lints, post-compaction re-grounding

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

The same audit that produced ADR-0054 cross-referenced every CLAUDE.md/rule
invariant against the checker and against published agent-reliability research. The
research converges on one point: written process alone does not hold agent behavior
over long horizons — deterministic guards plus measurement from real runs do.
Three gaps were concrete: goldens are a closed set (no path from an observed live
divergence back into the eval suite); two prose invariants were grep-able but
unenforced (time-sensitive content, exclusion-territory overlap); and nothing
re-grounds a session after a context compaction, exactly where summaries drift from
the written system.

## Decision

Three mechanisms, one per gap. (1) The authoring rule gains a norm: an observed
divergence — a session doing X where the written system says Y — becomes a new eval
case on the governing guide in the same change that lands the fix. (2) The checker
gains two warn-tier lints: `TIME_SENSITIVE` (dated/"currently" content outside
provenance-stamped lines, per the authoring rule's existing exception) and
`EXCLUSION_OVERLAP` (two guides whose descriptions claim near-identical trigger
territory). (3) The checker gains a `--session-start` mode that, wired to fire after
a compaction, injects where-am-I context: checkout vs worktree, branch, and the live
checker verdict — files over summaries.

## Consequences

The two lints start warn-tier: both judge prose, and a false positive that blocks a
merge would teach authors to game the lint rather than fix the piece; promote to
error only after observed precision. The re-grounding mode is fail-open everywhere
(a non-harness install must never be wedged) and stays inside the one shared
checker — no per-rule script. The divergence-to-eval norm is the seed of drift
MEASUREMENT: goldens regress what they cover, live failures are where new cases come
from. Revisit when: either lint false-positives in practice (tune or demote), or a
real-traffic sampling loop makes the manual norm obsolete.
