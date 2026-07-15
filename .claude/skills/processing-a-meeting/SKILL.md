---
name: processing-a-meeting
description: >-
  Turns one recorded meeting into linked records — templated summary with project
  attributions, grounded tasks, row fills, review digest — stale items triaged, one
  gated batch. Use to process, digest, or extract a meeting, transcript, or action
  items. Not for single-record captures, write mechanics (the bindings), or repos
  (/reviewing-a-repo).
disable-model-invocation: true
layer: automation
system: ingestion
kind: component
mold: how-to-guide
---

# Processing a meeting

## Goal
One meeting's outcomes standardized into linked records — summary doc, tasks, row
fills, project updates, inbox digest — each grounded in the transcript, deduped and
staleness-triaged, and written only through one human-confirmed gate.

## Use when / don't use when
- Use when: a meeting (a [DB] Meetings row) needs its transcript and outcomes turned
  into records.
- Not for: creating or fixing the meeting row alone (the meetings target + write
  discipline); one-off task or project captures (`/capturing-a-task`, the capture
  guides); the write mechanics (`/pushing-to-notion`, `/updating-a-notion-page`);
  non-meeting sources (`/reviewing-a-repo` for repos).

## Steps
1. **Resolve the meeting and its transcript source.** Find the [DB] Meetings row
   (target `meetings`). A `Recording` URL → fetch the transcript via the Otter MCP
   (the id after `otter.ai/u/`). No Recording → the row's native meeting-note child
   (`notion-fetch` with `include_transcript: true`). Neither → stop and say so; only
   the row's body can be summarized, and the summary must say that.
2. **Fetch the governing policies live** — Meetings, Tasks, Docs, per the
   `writing-records-to-notion` spine. They own every field rule (naming, grounding,
   body shapes, required relations); this guide owns only the choreography between them.
3. **Triage for staleness before deriving anything.** Compare the meeting date to
   today. FLEX: anything older than about a week gets the full check, bounded by: each
   candidate item is compared against the intervening record history (open AND recently
   closed tasks, newer meetings in the same series, project milestones/updates). An item
   completed in-call, overtaken by later work, or expired is recorded in the summary as
   an outcome — never created as a task. A date in the past NEVER becomes a Next Action;
   it appears only as history in the summary, and any surviving item gets a fresh date
   at the gate or none.
4. **Draft the summary doc** from the registered `[Meeting Summary Template]` (target
   `docs`): plain prose readable without the transcript, no timestamps; every topic
   names its Related project or deal, resolved against [DB] Projects — an attribution
   with no defensible home is marked unlinked and asked at the gate, never guessed.
   Split commitments ours/theirs: external people are never task assignees; their
   commitments stay in the doc.
5. **Derive the records.** Tasks per the Tasks policy through the capture discipline —
   dedup against open tasks first: an open task already owning the territory gets a
   checkbox folded in (`/updating-a-notion-page`), not a duplicate row. Meeting-row
   fills per the Meetings policy. A topic that moved a project milestone becomes a
   project-body update, not a task. A topic that warrants a NEW project is created
   PROPERLY per the Projects policy (Overview + milestones filled from the transcript,
   never a bare template) — not left as an unfilled side-effect.
6. **One gate for the whole batch.** Present everything: the summary, every record
   with its disposition — including what was deliberately NOT created and why (the
   not-created list is evidence of triage, not filler). On the okay, write in
   dependency order: summary doc → its id into the tasks' `From:` lines and the
   meeting row's `Related Docs` → tasks/folds → meeting row → project updates → the
   AI Inbox digest (write-spine step 10).
7. **Verify.** Re-fetch: the meeting links the summary, the summary cites the meeting,
   every task's `From:` resolves, and the digest lists exactly what landed.

## Gotchas
- (baseline 2026-07-15) A three-month-old meeting was processed as if current: past
  deadlines were proposed as Next Action dates unflagged, and no item was checked
  against the intervening months of record history — several were already overtaken
  (an April security-tooling conversation had become July's completed eval). Step 3
  exists for exactly this.
- (baseline 2026-07-15) With no guide, the runner adopted ADR-0051 as its operating
  procedure — an ADR records the decision, not the steps; the choreography lives here.
- (worked example #1, 2026-07-15) Two of eight extracted items collided with open
  tasks (one folded as a checkbox, one cross-referenced) — dedup-vs-open-tasks is the
  load-bearing derivation step, and folds beat creates.
- (worked example #1, 2026-07-15) Topic→project attribution is a judgment call the
  human gates ("facet testing relates to what?") — the summary's Related: line records
  the answer once so it is never re-derived.

## Evals
- `.claude/evals/processing-a-meeting/happy-path.md`
- `.claude/evals/processing-a-meeting/pressure-stale-meeting.md`
- `.claude/evals/processing-a-meeting/invariant-grounded-and-gated.md`
