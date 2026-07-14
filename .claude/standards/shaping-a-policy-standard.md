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
come before any field list. Ten sections, in this order, unnumbered — cross-reference
sections by NAME and determination rules by short id (D1, D2, …), never by section number.
The org's policy-standards registry holds one doc per subject, each started from the
registry's registered skeleton page (ids live with the publishing `policy-standards`
target); this standard is the shape every doc must keep.

- **Definition** — what the subject is + what makes one instance unique (identity).
- **Scope** — in AND out; an unknown exclusion is written `not defined`, never left
  silently absent.
- **Classifications** — one sub-section per dimension, all the same shape:
  **Requirement** (required/optional · single/multi · mutually-exclusive/overlap-allowed) ·
  **Classifies** · **Proven by** (→ a determination rule by id, or a one-line method
  inline) · **Values** (each defined, with a **Basis** where externally grounded).
  Lifecycle state is never a classification — Lifecycle & States owns it. Extension
  criteria live in Change Control, not here.
- **Rules** — bucketed by what they govern, so every rule has exactly one home:
  **Data** (what a valid record is) · **Operating** (who may act, on what, through which
  channel) · **Determination** (how a value is assigned, step by step; each carries a
  short id that Proven-by lines point at). Every rule is one imperative sentence naming
  its **Enforced by** (a field, state, or process); external grounding is a **Basis**.
  Evolution rules go to Change Control, never here.
- **Lifecycle & States** — a state table; no silent transitions, every move names its gate.
  A schema field that ENCODES lifecycle — whatever its property type (status, select,
  checkbox), and even a value hiding inside another field's option set — is documented
  here, its Fields row's Implements pointing at Lifecycle & States, never at a
  classification.
- **Fields** — the policy→schema bridge; every field's **Implements** names the section or
  rule it serves (by name or D-id); flag any rule the schema cannot yet express.
- **Relations & Cross-references** — links to other subjects, each governed (e.g.
  resolve-or-create); the other subject's own policy standard governs its fields —
  reference, never restate.
- **Linked Processes** — the processes that read/write this subject, and at which step.
- **Change Control** — always last before the log: one extension entry per classification,
  plus who may amend rules and the standard itself.
- **Change Log** — newest first, versioned.

**Coverage is derived, not optional** — anything missing is written `not defined`
(bare, searchable), never explained away and never silently absent:
- every classification → a determination rule (or inline one-liner) AND a Change Control
  extension entry;
- every lifecycle transition → an operating rule naming its actor and gate;
- every integrity constraint on a field or relation → a data rule naming its Enforced-by.

No placeholder slots in a finished doc (e.g. a "screenshot slot" note) — content is either
present or `not defined`. One policy standard per subject; the live database stays the
source of truth over the Fields section (ADR-0016). Observed failure this shape counters:
a draft generated from the bare skeleton silently DROPPED the step-by-step determination
logic ("proven by on-chain evidence", no how-to) and left extension criteria undefined
without marking them — the coverage lines and the `not defined` convention exist to catch
exactly that.

## Use when / don't
- Applies when: shaping or reviewing a policy standard (a doc in the org's
  policy-standards registry governing one subject).
- Doesn't apply when: shaping a process body (`shaping-a-process`); the Notion write
  mechanics (`writing-records-to-notion`); auditing a doc against its live DB
  (`auditing-a-schema-doc`); the quality bar for harness pieces (`.claude/RUBRIC.md`, the
  kernel standards system).
