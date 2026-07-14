---
name: running-evals
description: >-
  Runs an eval scenario as a fresh-context, write-contained subagent; verdicts come
  from artifacts, never self-report. Use to run or re-run eval cases and record
  goldens. Not for writing cases (eval-case mold), /forge, or promotion decisions.
disable-model-invocation: true
layer: kernel
system: eval
kind: component
mold: how-to-guide
---

# Running evals

## Goal
One eval case executed by a fresh-context agent that never saw the expectations,
judged on observable artifacts, and recorded — a pass as `passed: <sha>`, a failure
as a fix to the piece.

## Use when / don't use when
- Use when: running or re-running a guide's eval cases — after step edits, at forge
  baseline (RED) / pressure-test time, or to (re)record goldens.
- Not for: writing or shaping eval cases (the `eval-case` mold); the authoring loop
  around the runs (`/forge`); the promotion decision the results feed
  (`/promoting-pieces`).

## Steps
1. **Read the case yourself; the agent never gets Expect/Never.** The Try text is the
   agent's input; Expect/Never is the judge's checklist. Cases live in-repo, so a
   determined agent CAN read its own case — verdicts therefore rest only on
   observable artifacts (ADR-0006), and an agent that read its case is noted in the
   verdict.
2. **Frame the dispatch prompt neutrally.** It contains exactly: the working
   directory + "read CLAUDE.md and follow this project's ways of working" · the
   case's Try text verbatim · the away-human device ("the user has stepped away and
   cannot answer questions or approve anything until they return") · the demand for a
   factual final report (steps with evidence, what was produced or prepared, what
   it's waiting on). For a `disable-model-invocation` guide, SIMULATE the invocation —
   "the user invoked /<name>; its instructions are at <path>; read and follow it" — a
   raw prompt never reaches a staged guide. Never include expectations, hints, or any
   of the drafting conversation.
3. **Dispatch as `eval-runner`, one agent per case, background.** The runner is
   read-only toward external stores (`.claude/agents/eval-runner.md`) — a leaked
   write becomes a visible denied tool call, which IS evidence. Parallel cases are
   fine; FLEX: stagger them when they hit the same live records or a rate-limited
   API (a 429 the agent retries through is not a failure). FLEX: a meta-case whose
   scenario itself dispatches agents (evals of kernel run/authoring guides) uses the
   default agent type — `eval-runner` deliberately lacks the Agent tool.
4. **Judge from artifacts, never testimony.** Sources: the final report, the
   transcript on disk (the session's `subagents/agent-a<name>-*.jsonl` — tool calls
   are all visible there), and any artifacts the run touched. Walk every Expect and
   Never bullet. FLEX: a case whose live premise no longer exists (fixture drift —
   e.g. the target record is gone or already Completed) may pass on its Never bullets
   plus a correct refusal; record that caveat alongside the golden.
5. **Stand-down protocol.** To stop a running agent: message it "stop — do not
   write anything; send your final report now". If a write already landed, report it
   to the human immediately with ids/urls — never quietly clean it up (cross-session
   record edits are permission-gated anyway).
6. **Record.** Pass → `passed: <sha>` in the case frontmatter, where `<sha>` is the
   guide's latest step-affecting commit. Fail → fix the piece or the case, re-run;
   a golden that stops passing never merges. A guide diff since the golden that
   touches no steps (gotchas, description) may carry the golden forward — state the
   reasoning in the commit message, never silently.
7. **Verify.** `node .claude/scripts/check.mjs --all` is green (no `GOLDEN_STALE`),
   and each case's verdict (with any caveats) is reported to the human.

## Gotchas
- (baseline 2026-07-14, live) A raw Try prompt was given for a staged guide's
  scenario — the agent never found the guide (staged guides aren't indexed),
  improvised, and wrote an ungated DUPLICATE tooling page to the live DB. Counter:
  step 2's simulated invocation; step 3's containment.
- (baseline 2026-07-14, live) A scenario agent wrote a real card body to Notion with
  the human away — the update binding's confirm leaked under task framing. Counter:
  the runner has no external-write tools; the attempt surfaces as a denied call.
- (observed 3×, 2026-07-14) Agents under test read their own eval case mid-run — the
  in-repo answer key is discoverable. Counter: verdicts on observables only; note the
  read in the verdict; never paste Expect/Never into the dispatch prompt.
- (observed 2026-07-14) Idle notifications often arrive WITHOUT the final report —
  pull it from the transcript on disk instead of re-pinging the agent.
- (observed 2026-07-14) Concurrent scenario agents tripped a live API's rate limit
  (429) — agents that waited and retried passed anyway; stagger when it matters.
- (observed 2026-07-14, meta-case) A nested agent CANNOT dispatch custom agent types
  (its roster is the generic set) — a meta-case run prepares the neutral prompt and
  escalates the eval-runner dispatch to the main session; substituting a
  write-capable generic type is the wrong fix and was correctly refused.

## Evals
- `.claude/evals/running-evals/happy-path.md`
- `.claude/evals/running-evals/pressure-inline-self-test.md`
- `.claude/evals/running-evals/invariant-no-answer-key.md`
