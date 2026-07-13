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
- Not for: reading from Notion; updating or deleting existing pages (destructive —
  needs its own guide); stores other than Notion (a different binding).

## Steps
1. **Identify the target.** Get the Notion database id (the UUID from the database URL)
   and confirm access. FLEX: ask the user if the target isn't given.
2. **Map fields to typed properties.** For each field, pick its Notion type from:
   `title · rich_text · number · select · multi_select · date · url · checkbox ·
   email · phone_number`. Exactly one `title` property per page. Fragile: a type
   mismatch is rejected by the API — mirror the payload shapes in
   `~/dev/process-platform/src/services/notion-step-runner.ts` (`buildNotionPropertyPayload`).
3. **Build the page payload.** `parent = { database_id }`, `properties = { <name>: <typed value> }`.
4. **Confirm before writing.** Show the resolved database + the property map and get an
   explicit human okay. This step is non-negotiable — it is an external, hard-to-undo write.
5. **Push.** Create the page via the Notion MCP tool (`Notion:create-database-row`) or a
   POST to `https://api.notion.com/v1/pages` (`Notion-Version: 2022-06-28`, key from
   `NOTION_API_KEY`).
6. **Verify.** Report the created page's id and url; confirm the properties read back as intended.

## Gotchas
- A `select`/`multi_select` value that doesn't already exist as an option may be created
  or rejected depending on database settings — confirm the option set before pushing.
- Empty values must be sent as the type's null shape (e.g. `{ date: null }`), not omitted,
  or the property keeps a stale value.

## Evals
- `.claude/evals/pushing-to-notion/happy-path.md`
- `.claude/evals/pushing-to-notion/pressure-skip-confirm.md`
- `.claude/evals/pushing-to-notion/invariant-no-overwrite.md`
