# ADR-0035: The turn gate — the session fixes its own breakage

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

Between authoring and merge there was nothing that pushed back: the PostToolUse
lint is warn-only (ADR-0003) and CI fires only at the PR — a session could carry
checker errors through a whole conversation and only learn at the gate, after the
context that produced them was gone. The platform's documented pattern for this is
a Stop hook that holds the turn open until a verification script passes. The
harness ships as a plugin (ADR-0034), so any such hook reaches consumer projects
too and must not wedge a session that has no harness to check.

## Decision

The checker gains a `--gate` mode wired as a Stop hook in both wirings. Checker
ERRORS hold the turn open once — exit 2, findings on stderr, so the session
repairs them with its context still warm. `stop_hook_active` is the loop guard: a
second Stop stands down. Warnings never block; an off-harness project (scan-empty)
and any internal error fail open. CI remains the merge gate.

## Consequences

- A turn ends broken only after one forced repair attempt — CI stays the backstop,
  but most breakage now heals in-session. Cost: one `--all` pass (~1s) per turn end.
- ADR-0003's "the hook runs warn-only" stands for the PostToolUse lint; blocking
  remains confined to the guard and this gate, each selftest-planted.
- Revisit triggers: gate latency growing past a felt pause, or a legitimate
  workflow that must end turns mid-breakage (then the gate learns a scope, not an
  exception list).
