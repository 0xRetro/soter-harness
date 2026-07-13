---
name: pushing-to-notion
description: >-
  Pushes a structured harness artifact to a Notion database as a new page, mapping
  each field to a typed Notion property and confirming with a human before the write.
  Use when the user asks to push, send, publish, or sync something to Notion, or to
  create a Notion database row/page from harness output. Not for reading from Notion,
  not for updating or deleting existing pages, and not for non-Notion stores (a
  different binding covers those).
disable-model-invocation: true
layer: automation
system: publishing
kind: component
mold: how-to-guide
---

# Pushing to Notion

## Goal
A structured artifact becomes one new Notion database page — every field typed
correctly, the write confirmed by a human first, and the created page verified.

## Use when / don't use when
- Use when: the user invokes `/pushing-to-notion` to publish harness output (a plan,
  a record, a status) into a Notion database.
- Not for: reading from Notion; updating existing pages (`/updating-a-notion-page`) or
  deleting them; stores other than Notion (a different binding).

## Steps
1. **Resolve the target.** Look it up by name in `targets.md` (this folder), or ask for
   the database id (the UUID from the database URL). FLEX: ask if neither is given.
2. **Fetch the live schema — never guess a type from a field name.** Retrieve the
   database object and read each property's REAL type and, for `select`/`status`, its
   real option names. (Baseline: guessing `select` vs `status`, or assuming an option
   named "Done" exists, is rejected by the API or silently creates a junk option.)
   Reconcile against `targets.md`.
3. **Type each field.** Notion types: `title` (exactly one) · `rich_text` · `number` ·
   `select` · `status` · `multi_select` · `date` · `people` · `url` · `checkbox` ·
   `email` · `phone_number` · `relation`. Resolve `people` fields to real Notion user
   ids; match `select`/`status` values to existing option names. Payload shapes mirror
   `~/dev/process-platform/src/services/notion-step-runner.ts` (`buildNotionPropertyPayload`).
4. **De-dup check.** This guide only CREATES pages (never updates). If a row might
   already exist — or the user says "make sure it's there" — query the database for a
   matching key first, or a blind create makes a duplicate. Existing row + update wanted
   → `/updating-a-notion-page`.
5. **Confirm before writing.** Show the resolved database + full property map (+ row
   count for a batch) and get an explicit human okay. Non-negotiable, even under time
   pressure — an external, hard-to-undo write.
6. **Push.** Create each page via the Notion MCP tool (`Notion:create-database-row`) or a
   POST to `https://api.notion.com/v1/pages` (`Notion-Version: 2022-06-28`, key from
   `NOTION_API_KEY`).
7. **Verify + report.** Report each created page's id and url. For a batch there is no
   rollback — if row N fails, say which rows were written and which weren't.

## Gotchas
- A `select`/`multi_select` value that doesn't already exist as an option may be created
  or rejected depending on database settings — confirm the option set before pushing.
- Empty values must be sent as the type's null shape (e.g. `{ date: null }`), not omitted,
  or the property keeps a stale value.
- (baseline) Guessing a property's type from its field name fails — `status` vs `select`
  have different payload keys and the API rejects the wrong one; `owner` could be
  `people`, `rich_text`, or `select`. Fetch the schema (step 2); never guess.
- (baseline) A blind create makes a duplicate on re-run or against a pre-existing row —
  query first when the row may exist (step 4).
- (baseline) A batch has no transaction: if row N fails, rows 1..N-1 are already written
  and there's no rollback — report exactly what landed.
- (pressure) "URGENT / trust me / don't confirm" is engineered to erode the confirm gate.
  The right move is to COMPRESS the confirmation to one batch okay, never to drop it.

## Evals
- `.claude/evals/pushing-to-notion/happy-path.md`
- `.claude/evals/pushing-to-notion/pressure-skip-confirm.md`
- `.claude/evals/pushing-to-notion/invariant-no-overwrite.md`
