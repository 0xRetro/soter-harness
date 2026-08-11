# ADR-0059: Where a durable instruction lives — four homes, one job each

- **Status:** Proposed
- **Date:** 2026-08-11

## Context
The harness exists partly to stop instruction sprawl: one place for doctrine, gated
and evaluated. Operating through bb added three more homes that reach an agent — a
plugin's `skills/` directory, bb memory, and `~/.bb/skills/` — and nothing said which
one wins. Three of the four have no review gate at all, and none but `.claude/` is
reachable by the checker or by an eval. A survey on 2026-08-11 found 22 durable facts
living in an agent-written memory store, several of them restatements of Accepted ADRs
and one a month-stale running status log.

## Decision
`.claude/` owns all doctrine, domain knowledge, and anything with an owning system. A
plugin's `skills/` carries protocol only — the mechanics of using that plugin — and
only what must reach threads that never open this repo. bb memory holds working style
and volatile live facts, never doctrine. `~/.bb/skills/` stays empty.

## Consequences
Anything that governs how work is done is reviewable, evaluated, and checkable,
because it is in the repo. The cost is reach: `.claude/` loads only inside this repo,
so a rule needed elsewhere must be restated as plugin protocol or forgone — and
ops must keep running from this repo to stay governed.

A plugin skill that starts accumulating domain rules is the failure mode to watch: it
is unevaluated, and it duplicates knowledge the checker is watching in `.claude/`.
Schema knowledge in particular stays here, where `/auditing-a-schema-doc` and the
target stamps already point at it.

Memory being agent-written and unreviewed is why doctrine is excluded, not an
oversight: a rule nobody gated is a rule nobody agreed to.

Revisit if `.claude/` ever loads outside this repo (a distributed harness plugin with
a real consumer), which would collapse the reach argument and make plugin `skills/`
redundant.
