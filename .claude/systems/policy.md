---
name: policy
layer: core
system: policy
kind: component
mold: system-card
---

# System: policy

## Promise
Every governed subject — a record type (an address, an org, a process run), a concept, or
a mechanism — has exactly one **policy standard**: a rules-first doc stating what it is,
how it's classified (with explicit overlap rules), the rules it obeys, and its lifecycle,
before any field list (ADR-0021). Consumers: operators writing and reading records; the
process system (a write work-item points at the subject's policy standard instead of
restating fields); schema-audit (audits a policy standard's representation against the
live DB). Distinct from the kernel `standards` system, which sets the quality bar for
harness pieces — this system governs operational subjects.

## Mechanisms
- **authoring-a-policy-standard** — reads: a subject + the rules gathered from the human
  and named sources · produces: that subject's one policy standard in the org's registry
  (created from the registered skeleton, or expanded fetch-merge-write), gaps as bare
  `not defined`, inventions only as confirmed `(proposed)` items, with a change-log row ·
  runs-when: a user invokes `/authoring-a-policy-standard` · invariants: one doc per
  subject; rules are gathered or explicitly confirmed, never silently invented; relations
  resolved live; writes go through the publishing bindings.
- Further mechanisms (e.g. mechanically auditing a doc's coverage lines) forged as needed;
  the org's policy docs themselves live in Notion, not here (ADR-0021).

## Components
- `.claude/standards/shaping-a-policy-standard.md` — the ten-section rules-first shape a
  policy standard keeps, with its derived coverage rules and gap-marker convention.
- `.claude/skills/authoring-a-policy-standard/SKILL.md` — the authoring guide (staged).
  The org's registry ids live with the publishing `policy-standards` target.

## Concepts
policy standard · subject

## Invariants
- one policy standard per subject; policies and processes reference a subject's policy standard, never restate it — enforcer: (gate) + the forge's territory check
- rules before representation: definition, classifications, rules, and lifecycle precede any field table — enforcer: (gate) + shaping-a-policy-standard
- the live database is the source of truth; a policy standard's representation is audited against it, never trusted over it (ADR-0016) — enforcer: (gate) + schema-audit
