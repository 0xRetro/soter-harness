---
name: capturing-a-process
description: >-
  Captures a repeatable process as a [DB] Process Inventory entry — row shaped to the
  live schema, body shaped into role-bounded steps and work-items per the process shape
  standard, de-duped and confirmed before the write. Use when the user wants to capture,
  document, add, or define a process. Not for tasks (/capturing-a-task), features
  (/capturing-a-feature), write mechanics (/pushing-to-notion), or schema-doc audits
  (/auditing-a-schema-doc).
disable-model-invocation: true
layer: context
system: process
kind: component
mold: how-to-guide
---

# Capturing a process

## Goal
A described process becomes one [DB] Process Inventory entry — its row shaped to the live
schema (options matched, Related Service resolved or empty), its body shaped into steps and
work-items per `shaping-a-process`, de-duped and confirmed — at Status = Draft (unless told
otherwise).

## Use when / don't use when
- Use when: turning a described repeatable process into a documented Process Inventory entry.
- Not for: capturing a task (`/capturing-a-task`) or feature (`/capturing-a-feature`); the
  Notion write mechanics (`/pushing-to-notion`); auditing a schema doc
  (`/auditing-a-schema-doc`). The body *shape* is defined in `shaping-a-process`; this guide
  captures an entry to that shape.

## Steps
Follow the **`writing-records-to-notion`** standard
(`.claude/standards/writing-records-to-notion.md`) for the shared spine — fetch schema ·
resolve relations (never fabricate) · match options · de-dup · confirm · publish via the
binding. Process-specific:
1. **Shape the row from the live schema** — the property registry lives with the
   `process-inventory` target, not here. `Status` defaults to `Draft` at capture unless the
   user states otherwise. Set only fields the user gives; match every select/multi_select
   to a LIVE option (`Category` and `Tags` have large sets — fetch live, never invent).
   Don't silently default a field — flag any you propose.
2. **Resolve `Related Service`** by searching the Services Catalog for the named service →
   its page id; if not found, ask (leave empty vs create-first) — never fabricate an id.
3. **Shape the body per `shaping-a-process`** (`.claude/standards/shaping-a-process.md`):
   fetch the live default template body first, then follow the standard — Purpose · Trigger ·
   role-bounded **Steps** (a narrative intro; work-items as `- [ ]` headline + prose how,
   with `⤷ condition → En` branch pointers) · plus the recommended Cadence · Roles ·
   Exception Handling · Post Run Summary. FLEX: which recommended sections apply to a given
   process — but Purpose, Steps, and their work-items are always present.
4. **De-dup:** search [DB] Process Inventory by name before creating; an existing entry is
   updated (`/updating-a-notion-page`), not duplicated.
5. **Confirm** the resolved row (matched options, resolved-or-empty Related Service, flagged
   defaults) + the step/work-item outline, then create via `/pushing-to-notion`. Verify the
   entry exists with the shaped body.

## Gotchas
Shared write-discipline gotchas live in the `writing-records-to-notion` standard;
process-specific ones only:
- (live 2026-07-13) `Status` and `Maturity` are TWO separate fields that BOTH contain a
  "Draft" option — they are not the same field; set each from its own option set, don't
  collapse them.
- (convergence) Source bodies and older docs label the stage grouping with a different word;
  the canonical shape is **steps** holding **work-items** (ADR-0019) — normalize to steps,
  don't copy the source's label.
- (invariant) Work-items are body checkboxes, NOT [DB] Tasks rows — capturing a process never
  creates tasks. A run's work-items become [DB] Tasks later via `/capturing-a-task` (the
  run→tasks seam); don't fabricate task ids here.
- (pressure) `Category` / `Tags` are large live option sets — a value that only *sounds*
  right (e.g. "Ops") is rejected or makes a junk option; match the live option exactly or
  leave it empty and ask.

## Evals
- `.claude/evals/capturing-a-process/happy-path.md`
- `.claude/evals/capturing-a-process/pressure-invent-option.md`
- `.claude/evals/capturing-a-process/invariant-no-task-spawn.md`
