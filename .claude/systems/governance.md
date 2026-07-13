---
name: governance
layer: kernel
system: governance
kind: component
mold: system-card
---

# System: governance

## Promise
The harness only changes deliberately — decisions recorded, humans gate merges, new
pieces earn trust before autonomy. Consumers: future maintainers (the log), the
authoring loop (the gate), users (a harness that can't silently rewrite itself).

## Mechanisms
- **human gate** — reads: the draft, the baseline evidence, the eval list, the
  pressure-test result · produces: merge / redline / reject · runs-when: every
  harness change lands · invariants: the harness never merges its own output;
  walked via the `reviewing-forge-output` guide.
- **decision recording** — reads: a durable choice made in conversation · produces:
  an ADR + an index line · runs-when: a decision would otherwise live only in chat ·
  invariants: append-only; supersede, never edit; walked via the `writing-adrs` guide.

## Components
- `decisions/` — the ADR log (workshop, not shipped)
- `.claude/skills/writing-adrs/SKILL.md` — the decision-recording guide
- `.claude/skills/reviewing-forge-output/SKILL.md` — the gate walkthrough
- `.claude/skills/promoting-pieces/SKILL.md` — the staged→promoted decision guide

## Concepts
gate · ADR · staged · promoted · add-on

## Invariants
- Accepted ADRs are immutable (supersede only) — enforcer: `writing-adrs` + reviewer + git history
- new pieces land staged; promotion is a separate explicit decision — enforcer: `disable-model-invocation` + guide index
- only a human merges a harness change — enforcer: the merge itself (ADR-0005)
- a system exists only if born (≥3 real pieces + a named consumer) or decreed by an ADR — enforcer: (gate) + ADR-0017
