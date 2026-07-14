---
name: capturing-a-task
description: >-
  Captures an actionable item as a [DB] Tasks row — shaped to the real schema, relations
  resolved to real ids (never fabricated), dates pinned, de-duped, and confirmed before
  the write. Use when the user wants to capture, log, add, or create a task. Not for
  creating a project, the write mechanics (/pushing-to-notion), or feature cards
  (/capturing-a-feature).
disable-model-invocation: true
layer: context
system: project-management
kind: component
mold: how-to-guide
---

# Capturing a task

## Goal
An actionable item becomes a [DB] Tasks row shaped to the real schema — its relations
resolved to real ids, its date concrete, de-duped and confirmed — at Status = To Do.

## Use when / don't use when
- Use when: turning a described actionable item into a tracked task.
- Not for: creating a project; the Notion write mechanics (`/pushing-to-notion`); feature
  cards (`/capturing-a-feature`).

## Steps
Follow the **`writing-records-to-notion`** standard (`.claude/standards/writing-records-to-notion.md`) for the shared
spine — fetch schema · resolve relations (never fabricate) · match options · pin dates ·
de-dup · confirm · publish via the binding. Task-specific:
1. **Shape (live schema):** `Name` (title) · `Status` = `To Do` (at capture) · `Context`
   (select — Internal/Service/Project/Client, only if clear). The live board has NO
   Priority/Tag/Summary/Due field — don't try to set them (see Gotchas; the Standards
   page lags, targets.md records the live-verified schema).
2. **Resolve:** `Assigned To` (and `Client Contact` if named) via `Notion:notion-get-users`
   ("me" → the user's email → their id); `Project` via search; `Next Action` is the date
   field — pin relative dates. Target `tasks`.

## Gotchas
Shared write-discipline gotchas live in the `writing-records-to-notion` standard;
task-specific ones only:
- (live 2026-07-13) The live [DB] Tasks schema differs from the March Standards page
  (no Priority/Tag/Summary/Due; `Name` not "Task Name"; `Assigned To`; `Next Action` date;
  Status starts at To Do). Fetch live; never trust the Standards page as the schema.
- (baseline) "next Friday" is ambiguous (nearest vs following week) — pin `Next Action` to
  a concrete date and confirm when it's close; never store a relative phrase.
- (pressure) `get-users` may return multiple people or a bot — email→id isn't always 1:1;
  confirm the right person before using an id, don't grab the first match.

## Evals
- `.claude/evals/capturing-a-task/happy-path.md`
- `.claude/evals/capturing-a-task/pressure-skip-resolve.md`
- `.claude/evals/capturing-a-task/invariant-no-fabricated-id.md`
