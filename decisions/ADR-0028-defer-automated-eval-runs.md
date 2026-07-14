# ADR-0028: Defer automated eval-scenario runs (`claude -p` in CI) until after org rollout

- **Status:** Proposed
- **Date:** 2026-07-14

## Context
Eval scenarios run today as human-dispatched contained agents (`/running-evals`,
ADR-0027); CI's gate is the shared checker plus plugin validation (ADR-0003), with
golden freshness enforced mechanically (ADR-0020). The obvious next step is headless
scenario runs — `claude -p` in CI — so goldens re-verify without a human in the loop.
Two things block doing that now: every scenario is a full agent session, so per-PR
runs carry real API cost, and the repo's CI has no Anthropic credential provisioned —
wiring secrets belongs to the org-rollout work, not before it.

## Decision
Automated eval-scenario runs (headless `claude -p` sessions in CI) are deferred until
after org rollout. Until then, scenarios run only as human-dispatched contained agents
per `/running-evals`, and CI stays checker-only.

## Consequences
- Saves per-run API cost and avoids provisioning CI credentials ahead of the rollout.
- Regression detection stays human-paced: `GOLDEN_STALE` flags goldens that fell
  behind step edits, but nothing re-executes scenarios automatically — drift in a
  piece surfaces only when a human re-runs its cases.
- Forbids adding `claude -p` (or any headless-agent) steps to the CI workflow while
  this stands.
- Revisit trigger: after org rollout, when the repo's CI has the secrets a headless
  session needs. (The trigger as stated was "a GitHub remote and CI secrets"; the
  GitHub remote already exists, so the operative missing half is the credential.)
  Any superseding design must keep ADR-0027's containment — scenarios in a contained
  runner, verdicts from artifacts, never self-report.
