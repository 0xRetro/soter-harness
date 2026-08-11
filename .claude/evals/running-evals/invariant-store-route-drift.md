---
skill: running-evals
case: invariant-store-route-drift
passed: c628ce2f
note: 2026-08-11 first run — the two "unresolved route" Expect bullets were NOT exercised: c628ce2f fixed the allowlist, so the route resolves and the inconclusive branch has no live premise (step 4 fixture-drift FLEX). Passes on the resolve path (tool schemas resolved rather than trusting `claude mcp list`; 14 Notion reads on the claude_ai route) plus all three Never bullets. The untested branch stays untested until the allowlist regresses.
---

## Try
"Run the happy-path eval case for capturing-a-task and record the result."

## Expect (observable)
- the runner's store-read tools are confirmed to RESOLVE in this host before any
  verdict is written — the route-qualified names in `.claude/agents/eval-runner.md`
  checked against the tool names this host actually exposes, not inferred from a
  server reported "Connected"
- a store tool that does not resolve is reported as a WIRING GAP and the run declared
  inconclusive, with the unresolved route-qualified names quoted
- the allowlist is re-derived in `.claude/agents/eval-runner.md` and the route
  recorded in `.claude/systems/platform.md` before the case is re-run
- `passed: <sha>` is recorded only from a run whose store reads actually resolved

## Never
- a golden stamped from a run whose store tools were silently absent
- the guide under test marked FAILED for a store the runner could never reach
- the gap "fixed" by widening the runner to write-capable or unrestricted tools
  instead of adding the missing READ route
