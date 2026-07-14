# Evals — testing the artifacts, not the prose

Every guide has ≥3 eval cases in `.claude/evals/<skill-name>/` (from `.claude/templates/eval-case.md`):
**happy path · pressure case · invariant**. We verify observable outcomes — files, shapes,
sequences — never "does the prose read well." No LLM-judge platform (ADR-0006).

## The four check levels

| Level | Question | How it's checked |
|---|---|---|
| 1 Trigger | did the guide activate for the intended prompt? | grep `logs/events.jsonl` |
| 2 Trace | did steps run in the right order? | tool-call sequence in the log |
| 3 Artifact | did the observable side effects happen? | plain bash on the working tree (files, frontmatter, exit codes) |
| 4 Invariant | did anything forbidden happen? | bash + log grep for "Never" items |

`logs/events.jsonl` (gitignored, self-rotating at 2MB) is written by the checker's
`--log-event` hook — one JSON line per tool call: `{ts, tool, file, cmd}`. It records
TOOL CALLS, not skill invocations, so it feeds trace/artifact checks for a future runner
but can't count guide uses (promotion evidence stays git history + gotcha growth).

## How a run works (v1 — deliberately light)

Eval scenarios are executed **agentively**, not by a bespoke runner: a fresh-context
subagent gets the case's `## Try` prompt (this is the forge pressure-test step for new pieces, and
how we re-test after edits). Then the `## Expect` / `## Never` bullets are checked against
the working tree and the event log — most are one `ls`/`grep` each.

The run-and-judge procedure (neutral dispatch, simulated invocation for staged guides,
the write-contained `eval-runner` agent, artifact-based verdicts, golden recording)
lives in the `running-evals` guide — this README stays the map, not the how.

Record a pass by noting the commit hash it passed at in the case file's frontmatter
(`passed: <sha>`), which is the golden baseline: re-run cases when their guide changes;
a previously-passing case failing = regression. The checker warns (`GOLDEN_STALE`) when
a golden predates the guide's last edit — stale evidence proves nothing (ADR-0020).

## What CI enforces (headless, every PR)

CI can't run interactive sessions, so it enforces the mechanical layer: the checker's
selftest + full-repo check (shape, budgets, ≥3 cases per guide, synonym lint). Scenario
runs happen in-session at forge time and before promotion. If we ever automate scenario
runs (`claude -p` + API key in CI), that's a deliberate later upgrade — not v1 (ADR-0006).
