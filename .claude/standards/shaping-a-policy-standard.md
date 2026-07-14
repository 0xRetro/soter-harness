---
name: shaping-a-policy-standard
layer: core
system: policy
kind: component
mold: standard
---

# Shaping a policy standard

## The model
A policy standard is **rules-first** (ADR-0021): what the subject IS and what must HOLD
come before any field list. Ten sections, in order (the workspace's Policy Standard
Template page is the live skeleton; this standard is the shape it must keep):

1. **Definition** — what the subject is + what makes one instance unique (identity).
2. **Scope** — in AND out; an empty out-of-scope is a gap, not a default.
3. **Classifications** — one sub-section per dimension, all the same shape:
   **Requirement** (required/optional · single/multi · mutually-exclusive/overlap-allowed) ·
   **Classifies** · **Proven by** (→ a §4 determination rule, or a one-line method inline) ·
   **Values** (each defined, with a **Basis** where externally grounded). Lifecycle state is
   never a classification — §5 owns it. Extension criteria live in §9, not here.
4. **Rules** — bucketed by what they govern, so every rule has exactly one home:
   **Data** (what a valid record is) · **Operating** (who may act, on what, through which
   channel) · **Determination** (how a value is assigned, step by step). Every rule is one
   imperative sentence naming its **Enforced by** (a field, state, or process); external
   grounding is a **Basis**. Evolution rules go to §9, never here.
5. **Lifecycle & States** — a state table; no silent transitions, every move names its gate.
6. **Fields** — the policy→schema bridge; every field names what it **Implements**; flag any
   rule the schema cannot yet express.
7. **Relations & Cross-references** — links to other subjects, each governed (e.g.
   resolve-or-create); the other subject's own policy standard governs its fields —
   reference, never restate.
8. **Linked Processes** — the processes that read/write this subject, and at which step.
9. **Change Control** — always last before the log: one extension entry per §3
   classification, plus who may amend rules and the standard itself.
10. **Change Log** — newest first.

**Coverage is derived, not optional** — a miss is marked `not defined — gap`, never
silently absent:
- every §3 classification → a §4 determination rule (or inline one-liner) AND a §9 extension entry;
- every §5 transition → a §4 operating rule naming its actor and gate;
- every integrity constraint on a §6 field or §7 relation → a §4 data rule naming its Enforced-by.

One policy standard per subject; the live database stays the source of truth over §6
(ADR-0016). Observed failure this shape counters: a draft generated from the bare skeleton
silently DROPPED the step-by-step determination logic ("proven by on-chain evidence", no
how-to) and left extension criteria undefined without marking them — the coverage lines and
the explicit gap marker exist to catch exactly that.

## Use when / don't
- Applies when: shaping or reviewing a policy standard (a [DB] Policy Standards doc
  governing one subject).
- Doesn't apply when: shaping a process body (`shaping-a-process`); the Notion write
  mechanics (`writing-records-to-notion`); auditing a doc against its live DB
  (`auditing-a-schema-doc`); the quality bar for harness pieces (`.claude/RUBRIC.md`, the
  kernel standards system).
