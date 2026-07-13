# ADR-0006: Evals are kernel substrate; cases are data, the runner is replaceable

- **Status:** Accepted
- **Date:** 2026-07-12

## Context
For self-extending systems the evidence converges hard on eval-first ("create
evaluations before writing documentation"; "no skill without a failing test
first"): without a watched baseline failure you cannot know an added instruction
does anything, so unverified additions compound. Evals-later is defensible only
when "good" is still undefined — not our case.

## Decision
The eval system is kernel. Every guide ships ≥3 artifact-level cases (Try / Expect
/ Never) including one pressure case — realistic stakes tempting a shortcut,
because polite tests lie. The forge runs a baseline (RED) before drafting and a
fresh-context pressure-test before the gate. Cases are data; any runner may execute
them — an automated runner is deferred until CI + remote exist.

## Consequences
Untested pieces cannot merge (checker enforces counts and the pressure case).
Verdicts come from artifacts and the event log, never an agent's self-report.
Revisit the deferred runner once a remote exists and manual runs become the
bottleneck.
