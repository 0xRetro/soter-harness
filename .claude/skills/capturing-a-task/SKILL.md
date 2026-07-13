---
name: capturing-a-task
description: >-
  Captures an actionable work item as a [DB] Tasks row — shaped to the real schema, with
  the assignee and project/org relations resolved to real Notion ids (never fabricated),
  relative dates pinned to concrete dates, de-duped, and confirmed before the write. Use
  when the user wants to capture, log, add, or create a task. Not for creating a project
  (a different guide), not for the Notion write mechanics (/pushing-to-notion), and not
  for feature cards (/capturing-a-feature).
disable-model-invocation: true
layer: context
system: project-management
kind: component
mold: how-to-guide
---

# Capturing a task

## Goal
An actionable item becomes a [DB] Tasks row shaped to the real schema — its relations
resolved to real ids, its date concrete, de-duped and confirmed — at Status = Not started.

## Use when / don't use when
- Use when: turning a described work item into a tracked task.
- Not for: creating a project; the Notion write mechanics (`/pushing-to-notion`); feature
  cards (`/capturing-a-feature`).

## Steps
1. **Shape the given fields** (schema in `.claude/skills/pushing-to-notion/targets.md`):
   `Task Name` (title) · `Summary` (context) · `Priority` → Low/Medium/High/Urgent ·
   `Status` = `Not started` (always, at capture). Leave fields the user didn't give empty.
   Expressed urgency about the request ("I'm slammed", "ASAP") is NOT a stated `Priority`
   — don't set it from that.
2. **Resolve relations to real ids — never fabricate (the load-bearing step).**
   - Assignee/person: `Notion:notion-get-users` to map the person (e.g. "me" → the user's
     email → their user id). A person field needs the id, not a name.
   - `Project` / `Org` relations: `Notion:notion-search` or query the target DB by name →
     the real page id. If a named project/org is NOT found, distinguish unresolved from
     nonexistent: ask (wrong name? create it first? leave empty?) — never guess an id, and
     never leave it silently blank as if resolved.
3. **Pin relative dates to a concrete date.** "next `<weekday>`" = the nearest upcoming one
   (today is knowable); if it's only a few days out and could mean the following week,
   confirm which. Write `Due` as an ISO date, never a relative phrase.
4. **Tag (optional).** Set a `Tag` only if the work obviously maps (Bug/Feature/…);
   otherwise leave it — don't force a guess.
5. **De-dup.** Search [DB] Tasks by name for an existing matching task before creating.
6. **Confirm before writing.** Show the resolved record — resolved assignee/project names
   AND ids, the concrete date, and which relations are empty and why — and get an explicit
   okay. External, hard-to-undo write.
7. **Publish + verify.** Create via `/pushing-to-notion` (target `tasks`); report the
   created task url and confirm the relations linked.

## Gotchas
- (baseline) Never fabricate a page/user id — resolve via search/get-users, or leave the
  relation empty and flag it. The schema-shaping half is easy; the id half is the risk.
- (baseline) A named project/org may not exist — distinguish "unresolved" from "doesn't
  exist"; ask rather than silently blanking or inventing.
- (baseline) "next Friday" is ambiguous (nearest vs following week) — pin the convention
  and confirm when it's close; never store a relative phrase.
- (baseline) De-dup before create and confirm before write — a create isn't reversible.
- (pressure) `get-users` may return multiple people or a bot — email→id isn't always 1:1;
  confirm the right person before using an id, don't grab the first match.

## Evals
- `.claude/evals/capturing-a-task/happy-path.md`
- `.claude/evals/capturing-a-task/pressure-skip-resolve.md`
- `.claude/evals/capturing-a-task/invariant-no-fabricated-id.md`
