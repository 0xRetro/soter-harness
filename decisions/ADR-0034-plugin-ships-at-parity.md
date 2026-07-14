# ADR-0034: The plugin ships the harness at parity

- **Status:** Proposed
- **Date:** 2026-07-14

## Context

The `.claude/` directory is both this repo's live wiring and the plugin other
installs receive — but the two hook wirings drifted: `.claude/settings.json` ran
three hooks (Bash guard, checker lint, event log) while the plugin's
`hooks/hooks.json` shipped only the lint. An install therefore got weaker
enforcement than the source repo and produced no event log, which the eval
system's trace verdicts read. Separately, `plugin.json` pinned `version: 0.1.0`
and never bumped it; the platform caches by that field, so installers could sit
on a stale snapshot silently (omitting the field makes every commit a version).

## Decision

The plugin ships the harness at full strength. `hooks/hooks.json` mirrors
`settings.json` exactly — same hooks both directions, enforced by the checker's
`HOOK_PARITY` rule. The plugin manifest carries no `version` field while the
harness is internal and active: every commit ships.

## Consequences

- Installs get the same guard, lint, and event log this repo runs; evals' trace
  evidence exists wherever the harness is installed. The event log is fail-open
  and rotation-bounded, so consumer projects only gain a small local trace file.
- A hook can't be added to one wiring without the other — the checker blocks the
  merge until it ships in both or is consciously removed from both.
- No version bookkeeping until distribution goes public. Revisit trigger: either
  a hook that must NOT ship with the plugin (dev-only wiring), or a public
  release channel needing pinned versions — each supersedes this ADR.
