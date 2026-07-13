---
name: updating-a-notion-page
description: >-
  Updates an existing Notion page safely — fetch-merge-write so nothing already there is
  clobbered, only the named properties touched, and a human confirms before the write.
  Use when the user wants to update, edit, change a field on, or append to an existing
  Notion page or database card. Not for creating new pages (that is /pushing-to-notion),
  not for deleting pages, and not for non-Notion stores.
disable-model-invocation: true
layer: automation
system: publishing
kind: component
mold: how-to-guide
---

# Updating a Notion page

## Goal
An existing Notion page changes exactly as intended — the target fields updated,
everything else preserved byte-for-byte, and the write confirmed by a human first.

## Use when / don't use when
- Use when: the user wants to edit/append to an existing Notion page or card.
- Not for: creating pages (`/pushing-to-notion`); deleting pages; non-Notion stores.

## Steps
1. **Identify the page + the change.** Get the page id/url and exactly which properties
   change (or what to append). FLEX: ask if unclear.
2. **Fetch current state first — never blind-write, even for a straight overwrite.**
   Fetch the page and read the CURRENT value of every field you'll change. Notion's
   update REPLACES a property's whole value, so an append or edit must start from the
   existing value (baseline: a blind write silently destroys what's there). A plain
   overwrite still requires this fetch — to make the change reviewable and to resolve
   the surface. Resolve at fetch time whether the field is a **rich_text property**
   (update via the page-update call) or the **page body** (blocks — a different,
   append-block call). Tell: if the field is in the page's `properties` map it's a
   property; if it appears only in the page body it's blocks. They are not interchangeable.
3. **Merge locally.** For an append: new value = existing value + separator + addition.
   Watch the rich_text ~2000-char per-segment limit; split into segments if needed.
4. **Scope the payload to only what changes.** Include ONLY the properties you are
   changing; Notion leaves unlisted properties untouched. Never resend Name/Status/etc.
   unless you are deliberately changing them.
5. **Guard idempotency.** An append run twice double-appends — before appending, check
   the current value doesn't already contain the addition.
6. **Confirm before writing.** Show before → after for each changed field, state which
   fields stay untouched, and get an explicit human okay. Non-negotiable — an external,
   hard-to-undo write. Urgency never waives this: "I'm in a hurry, skip it" is exactly
   when to hold the gate.
7. **Write.** `Notion:notion-update-page` for a property change, or the append-block call
   for body content (key from `NOTION_API_KEY` if using REST).
8. **Verify.** Re-fetch; confirm the change landed AND nothing else moved.

## Gotchas
- (baseline) Notion replaces a property's WHOLE value on update — always fetch-merge,
  never blind-write, or you destroy the existing content.
- (baseline) A field like "Description" may be a rich_text PROPERTY or the page BODY
  (blocks) — resolve which at fetch time; the wrong surface means the wrong API call.
- (baseline) Append is not idempotent — a retry double-appends; check before appending.
- (baseline) Send only the properties you change; unlisted ones are preserved — don't
  echo Status/Name back or you risk clobbering them with a stale value.

## Evals
- `.claude/evals/updating-a-notion-page/happy-path.md`
- `.claude/evals/updating-a-notion-page/pressure-blind-write.md`
- `.claude/evals/updating-a-notion-page/invariant-preserve.md`
