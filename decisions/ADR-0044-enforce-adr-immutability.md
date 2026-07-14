# ADR-0044: Accepted ADRs are immutable by a guard, not just by convention

- **Status:** Proposed
- **Date:** 2026-07-14

## Context

"NEVER edit an Accepted ADR (supersede it)" (CLAUDE.md) and "Immutable once
Accepted — supersede, never edit" (the adr mold) were prose only. Nothing
mechanical stopped an agent from rewriting a decision the log records as settled;
the only backstop was a human noticing the change in a diff at the PR gate — and a
mid-session Write or a shell redirect lands long before that gate. The harness
already enforces its other session-level invariants (the parked root checkout,
force pushes, bulk staging) with a PreToolUse guard in the one shared checker that
sees the whole tool input rather than a prefix-matched permission rule (ADR-0036);
ADR immutability is the same shape of rule with no enforcer.

## Decision

The checker gains an ADR-immutability guard, wired at PreToolUse for Write|Edit
(`--guard-write`) with a companion clause in the existing Bash guard. Any edit to a
`decisions/ADR-*.md` file whose on-disk Status is Accepted is blocked (exit 2, before
the edit lands), with one exception: an in-place flip of that ADR's own Status line
from Accepted to "Superseded by ADR-<n>" — the sanctioned supersession transition —
is allowed. Proposed ADRs, brand-new ADR files, and non-ADR files are untouched. The
Bash clause blocks the shell bypass (redirect, `tee`, `sed -i`, `truncate` onto an
Accepted ADR) but stays conservative — a read like `cat` never trips it. The guard is
mirrored into both `settings.json` and `hooks.json` at parity (HOOK_PARITY, ADR-0034)
and plant-and-asserted in `--selftest`.

## Consequences

- The prose rule now fails closed the moment it is violated, in-session, instead of
  waiting on the human gate; the gate becomes the backstop, not the only line.
- Supersession still works: flipping the Status line is the one permitted edit, and
  the new superseding ADR is a fresh file the guard never touches.
- Best-effort by design, like the sibling guard: it reads the tool input the platform
  hands the hook and fails open on anything it cannot parse (a `cd`-relative shell
  path, an unusual write verb). The prose rule and the PR gate still stand behind it.
- Revisit trigger: if the Status-line format changes, or if a legitimate edit to an
  Accepted ADR is ever sanctioned beyond supersession, the allow-list widens here.
