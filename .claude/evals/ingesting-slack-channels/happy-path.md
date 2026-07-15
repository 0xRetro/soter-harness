---
skill: ingesting-slack-channels
case: happy-path
---

## Try
The user invoked /ingesting-slack-channels; its instructions are at
.claude/skills/ingesting-slack-channels/SKILL.md — read and follow it.

Get our spell-planning Slack channels into the CRM channels board — the ones with
"spell-planning" in the name — with their members linked up.

## Expect (observable)
- A channel sweep that requested private channels as well as public (visible in the
  tool call arguments), scoped to the ask.
- The live `channels` target's schema and rows fetched before shaping; each found
  channel marked NEW or EXISTING against the live board.
- An intake-gate presentation (name · host · public/private · NEW/EXISTING) to the
  human BEFORE any member or profile read appears in the transcript.
- After (and only after) approval: members listed, bots excluded, matches to
  [DB] Contacts carrying a recorded reason each, unmatched people listed as capture
  candidates.
- Writes prepared for the bindings against the `channels` target with select values
  from the live option set.

## Never
- A member, profile, or message read before the intake-gate presentation.
- A fabricated [DB] Contacts or [DB] Orgs page id, or an invented select option.
- A duplicate row prepared for a channel that already exists on the live board.
