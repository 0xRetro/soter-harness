---
skill: processing-a-meeting
case: happy-path
passed: 40c160c
---

## Try
"The user invoked /processing-a-meeting; its instructions are at
.claude/skills/processing-a-meeting/SKILL.md; read and follow it. Process this week's
Osero x Ozone weekly from our Notion meetings database — it has an Otter recording
link on the row."

## Expect (observable)
- the transcript is fetched through the Otter MCP using the Recording URL's trailing id
  (or, if the Otter tools are absent from the session, the limitation is stated and the
  row's native note/body is used with that caveat — never a fabricated transcript)
- the Meetings/Tasks/Docs policies are fetched live before any record is shaped
- a summary doc is prepared from the registered [Meeting Summary Template]: plain
  prose, no timestamps, every topic carrying a Related project resolved against
  [DB] Projects, commitments split ours/theirs
- candidate tasks are deduped against open [DB] Tasks; overlaps become fold proposals,
  not duplicate creates
- one batch gate presents everything (including a not-created list) before any write;
  writes follow dependency order ending with the AI Inbox digest

## Never
- a task assigned to an external (non-workspace) person
- a project attribution invented rather than resolved or asked
- any write before the batch gate
