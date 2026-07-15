---
name: process
layer: context
system: process
kind: component
mold: system-card
---

# System: process

## Promise
Repeatable work is defined once, consistently, in the live Notion [DB] Process Inventory:
a **process** (row + shaped body) made of **steps**, each holding **work-items**; steps bind
to **roles** defined once in the [DB] Roles directory. Consumers:
the team documenting how work gets done and converging the process-platform app + Merlin docs
+ Notion onto one definition (ADR-0019); project-management, which tracks a **process run**'s
work-items as [DB] Tasks. Mirrors the LIVE [DB] Process Inventory schema — fetch live, never
an assumed one (ADR-0016). Definitional only: it defines and captures processes, it is not a
runtime engine (ADR-0003, ADR-0019).

## Mechanisms
- **capturing-a-process** — reads: a described process (its purpose, trigger, steps and their
  work-items) · produces: a [DB] Process Inventory entry (Name + Status, other properties as
  given, body shaped per the standard) · runs-when: a user invokes `/capturing-a-process` ·
  invariants: shaped to the live schema; select/relation values resolved to real options/ids
  or left empty, never fabricated; work-items are definition-level checkboxes, never
  fabricated [DB] Tasks ids.
- **red-teaming** — reads: a documented process + its policies, live schemas, and runs ·
  produces: ranked verified findings (never silent fixes) · runs-when: a user invokes
  `/red-teaming-a-process` (the In Review → Active gate's mechanism) · invariants: the
  reviewing agent is read-only toward external systems; criticals are reproduced before
  reporting; fixes are decisions, not side effects.
- Further mechanisms (maintaining a process, spawning a run's tasks into [DB] Tasks) forged as
  needed. Writes go through the publishing bindings; a run's work-items reach [DB] Tasks
  through project-management's `capturing-a-task`, never a bespoke push.

## Components
- `.claude/standards/shaping-a-process.md` — the canonical body shape a process definition
  follows (steps + work-items), reconciled to the live [DB] Process Inventory template.
- `.claude/skills/capturing-a-process/SKILL.md` — the process-capture guide. The Notion
  target `process-inventory` (its real schema + relations) lives in the publishing binding's
  `targets.md`.
- `.claude/skills/red-teaming-a-process/SKILL.md` — the review-gate guide (staged).

## Concepts
process · step · work-item · process run · role · capability · subprocess · slot

## Invariants
- a process is shaped to the live [DB] Process Inventory schema, never an assumed one — enforcer: (gate) + publishing's live schema fetch
- select/relation values are resolved to real options/target ids or left empty — enforcer: (gate) + the guide's resolve step
- work-items stay definition-level; a run's tracking rows are created via project-management, never fabricated here — enforcer: (gate) + the run→tasks seam (ADR-0019)
- records reach Notion through the publishing bindings (the canonical rule; see the publishing card) — enforcer: (gate) + publishing
