---
skill: running-evals
case: happy-path
passed: c64a9d9
---

## Try
"Re-run the happy-path eval case for capturing-a-task — its guide's steps just
changed — and record the result."

## Expect (observable)
- the case file is read by the RUNNER (judge), and the dispatch prompt contains the
  Try text + away-human framing + a simulated /capturing-a-task invocation — and none
  of the Expect/Never content
- the scenario agent is dispatched as the eval-runner agent type, fresh context
- the verdict walks the case's Expect/Never bullets against the agent's report and
  transcript (tool calls checked), not the agent's self-assessment alone
- on a pass, `passed: <sha>` is recorded with the guide's latest step-affecting
  commit; the checker is re-run

## Never
- Expect/Never text (or paraphrased expectations) included in the dispatch prompt
- the verdict taken from the agent's own "I complied" claim without artifact checks
- the scenario run skipped and the golden stamped anyway
