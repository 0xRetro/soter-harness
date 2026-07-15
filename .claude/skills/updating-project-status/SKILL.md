---
name: updating-project-status
description: >-
  Writes a project's status update — progress computed from its real tasks and
  milestones, landed as a typed Status row in [DB] Update Feed related to the project,
  with milestone health tags synced in the same pass, confirmed before the write. Use
  when the user asks for a status update, weekly update, project status, or health
  check on a [DB] Projects page. Not for capturing tasks (/capturing-a-task), the
  write mechanics (/pushing-to-notion, /updating-a-notion-page), or process run logs.
disable-model-invocation: true
layer: context
system: project-management
kind: component
mold: how-to-guide
---

# Updating project status

## Goal
A dated, honest `Status` row in [DB] Update Feed, related to the project — progress
grounded in the page's real tasks and milestones, health stated as a judgment, the
milestone tags synced to match — written only after the human confirms. The page's
Updates section shows it through its live view of the feed.

## Use when / don't use when
- Use when: writing a status, weekly, or health update for a [DB] Projects page.
- Not for: capturing or advancing tasks (`/capturing-a-task`); the Notion write
  mechanics (`/updating-a-notion-page`); process run logs (the run body owns those).

## Steps
Follow the **`writing-records-to-notion`** standard (`.claude/standards/writing-records-to-notion.md`) for the write spine.
Status-specific:
1. **Fetch the page AND the Projects policy standard.** The policy's Body section
   governs the format — Updates is a dated log, NEWEST FIRST; milestones carry
   separate progress and health tags. Never compose from the page alone.
2. **Ground every claim.** Progress is computed on read: query the project's promoted
   tasks ([DB] Tasks rows whose Project relation is this page) for done/blocked
   counts; read the milestone checklist for work-item state; pull specifics from the
   page's linked docs when the update needs them. No claim that isn't derivable from
   real data — an update never invents.
3. **Compose the row**: title = a one-line headline carrying the health call;
   `Summary` = short plain-prose lines; `Date` = the day the update covers;
   `Category` = `Status`; `Visibility` per audience. FLEX: the Summary's line labels
   (Done / In progress / At risk / Next) may flex with the project's rhythm; the
   headline, org language (never harness internals), and an honest health call may not.
4. **Sync milestone tags in the same pass.** First promoted task started → that
   milestone is `in progress`; all its tasks Done → propose checking its box (the
   human confirms); a blocked task or slipped date → health tag `at risk` or
   `off track` on that milestone line. Prose that says at-risk while the milestone
   line says nothing is a contradiction — fix both or neither.
5. **Confirm, then write.** Show the row and every tag diff; on the okay, create the
   `Status` row in [DB] Update Feed (target `update-feed`, the project relation
   resolved) via `/pushing-to-notion`, apply the tag diffs via
   `/updating-a-notion-page`, and verify both. Never hand-write an entry into the
   page's Updates section — it is a live view of the feed, not prose.

## Gotchas
- (baseline 2026-07-15) A fresh agent composed a near-perfect update but skipped the
  Projects policy fetch and planned to APPEND the entry — violating the newest-first
  rule it never read. Counter: step 1.
- (baseline 2026-07-15) The same run declared a milestone at risk in prose while the
  milestone's health tag stayed empty — status prose and milestone tags drifted apart
  at birth. Counter: step 4.
- Recurring use pairs this guide with `/loop` or a scheduled routine: the cadence
  lives in the scheduler, the how lives here — never baked into a cron prompt.

## Evals
- `.claude/evals/updating-project-status/happy-path.md`
- `.claude/evals/updating-project-status/pressure-just-say-on-track.md`
- `.claude/evals/updating-project-status/invariant-no-invented-progress.md`
