---
name: project-management
layer: context
system: project-management
kind: component
mold: system-card
---

# System: project-management

## Promise
Track delivery above the feature level: **projects** (client/internal engagements) and
the **tasks** that execute them, mirrored to the real Notion [DB] Projects and [DB] Tasks
databases. Consumers: the team
tracking what's being delivered, for whom, by when; ingestion (which can produce tasks
from a source); the publishing bindings that write them. Mirrors the LIVE [DB] Tasks /
[DB] Projects schemas (documentation can lag — fetch live, ADR-0016); task and project
semantics are governed by the subjects' policy standards in the org's registry
(ADR-0021). The project body standard — sections, milestone/work-item grammar, and the
project-role vocabulary drawn from the shared [DB] Roles directory — lives in the
Projects policy standard and is implemented by the live DB default template.
Decreed with the first add-on wave (ADR-0017).

## Mechanisms
- **capturing-a-task** — reads: a described actionable item · produces: a [DB] Tasks row
  (Name + Status = To Do, assignee/context/next-action as given, related to its
  project/org) · runs-when: a user invokes `/capturing-a-task` · invariants: relations
  (Project/Org/Assignee) are resolved to real page/user ids or left empty, never
  fabricated; relative dates pinned to concrete dates; status starts at To Do.
- **updating-project-status** — reads: a [DB] Projects page, its policy standard, and
  its promoted tasks · produces: a typed `Status` row in [DB] Update Feed related to
  the project, with the milestone progress/health tags synced in the same pass · runs-when:
  a user invokes `/updating-project-status` (recurring cadence via `/loop` or a
  scheduled routine, never a cron prompt) · invariants: every claim derivable from
  real data; status prose and milestone tags never contradict; the write is
  human-confirmed. Forged 2026-07-15 on an observed RED baseline (policy fetch
  skipped → append instead of newest-first; at-risk prose with unsynced tags).
- Further mechanisms (creating a project, advancing a task) forged as needed — ONLY on
  an observed RED baseline. Project capture evaluated 2026-07-14: baseline GREEN — a
  fresh contained agent shaped a correct [DB] Projects row from the
  `writing-records-to-notion` spine, the `projects` target, and the sibling task guide
  alone (Type per the policy's D1, PM/Organization resolved to real ids, de-dup caught
  a genuine possible duplicate, write held at the confirm gate with the user away), so
  no capturing-a-project guide was authored (forge step 4). Re-propose only on an
  observed project-capture failure. Feed-row logging (decisions/questions) evaluated
  2026-07-15: baseline GREEN — a fresh contained agent staged the full three-surface
  update unprompted (Decision row in grammar with the missing why refused-not-invented,
  the matching Question row's Processed flip, the milestone work-item check, health tag
  correctly left at-risk) and held the gate — no logging guide authored.
  Work-item→task promotion evaluated 2026-07-15:
  baseline GREEN — a fresh contained agent ran the full capture discipline unprompted
  (grammar parsed, policy applied, ids resolved, de-duped, held at the gate), so no
  promoting guide was authored; boundary noted the same day: not every work item is a
  task — promote only what needs tracked execution, a coordination ping is done in
  place (user correction, Projects-policy line pending). Writes go
  through the publishing bindings; source-driven task intake reuses the ingestion spine.

## Components
- `.claude/skills/capturing-a-task/SKILL.md` — the task-capture guide. Notion targets
  `tasks` and `projects` (with their real schemas + relations) live in the publishing
  binding's `targets.md`.
- `.claude/skills/updating-project-status/SKILL.md` — the status-update guide (staged).

## Concepts
project · task · milestone

## Invariants
- tasks and projects are shaped to the live [DB] Tasks / [DB] Projects schemas, never an assumed one — enforcer: (gate) + publishing's live schema fetch
- relations are resolved to real target page ids or left empty — enforcer: (gate) + the guide's resolve step
- records reach Notion through the publishing bindings (the canonical rule; see the publishing card) — enforcer: (gate) + publishing
- task and project semantics and lifecycle follow the subjects' policy standards (ADR-0021) — enforcer: (gate) + the write discipline's fetch-policy step
