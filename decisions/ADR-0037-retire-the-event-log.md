# ADR-0037: Retire the event log — hooks cannot attribute skill use; native telemetry can

- **Status:** Proposed
- **Date:** 2026-07-14

## Context

The event log (`--log-event`, a wildcard PostToolUse hook appending `{ts, tool,
file, cmd}` lines to `.claude/evals/logs/events.jsonl`) was kept as tool-trace
evidence for a future eval runner, with the hope it could someday count guide use
for the promotion floor. Platform facts close that path: user-typed skill
invocations are command expansion — they fire no hook and carry no name a hook
could log (a heavy multi-guide day produced 4,115 log lines containing two
anonymous `Skill` entries). Claude Code's native OpenTelemetry meanwhile ships
`claude_code.skill_activated` with `skill.name` and `invocation_trigger`
(including `user-slash`) — exactly the instrument the log could never become. Its
two declared consumers had already demoted it: `promoting-pieces` to
"corroboration, not proof" (its gotcha admits the log can't establish the use
floor), and the evals README's "grep events.jsonl" trigger check cannot attribute
a guide. Keeping it cost a node spawn on every tool call in every session plus a
standing claims-vs-reality drift.

## Decision

Retire the event log: remove the wildcard PostToolUse wiring from both
`settings.json` and the plugin's `hooks.json` (parity per ADR-0034 is maintained —
the shipped set shrinks identically on both sides), delete the `--log-event` mode,
and update every doc claim. Artifact verdicts rest on transcripts, produced files,
and git history — as `running-evals` already practices.

## Consequences

- One fewer process spawn per tool call in every session; no orphan file; the
  trigger-check and promotion-evidence claims now say what is true.
- Historical mentions in Accepted ADRs (0006, 0027, 0034) stand as history —
  superseded in effect by this record, not edited.
- Revisit trigger: a real telemetry consumer materializes (automated eval runs,
  promotion-floor counting, org dashboards) — adopt native OTel
  (`claude_code.skill_activated`, `OTEL_LOG_TOOL_DETAILS=1`), never a hook log.
