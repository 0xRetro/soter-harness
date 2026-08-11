# ADR-0060: The hard gate is scoped by irreversibility

- **Status:** Accepted
- **Date:** 2026-08-11

## Context
The rule that external writes need explicit human confirmation lived only in prose an
agent follows. ADR-0010 scopes the checker to catching honest drift by cooperative
authors, not to defending against a determined editor — which reads as an argument
against any hard block. But a hard block already exists: `guardAdrVerdict` refuses
edits to Accepted ADRs, and `guardBashVerdict` closes the shell route around it. The
question was what principle separates the thing that earns a block from the thing that
only earns review.

## Decision
A hard block is scoped to the irreversible. An external record write has no undo and
is gated: a PreToolUse hook refuses any Notion mutation that no approved proposal
covers. A local file edit is reversible through git and is not blocked — it gets
reflex plus review. The harness owns the gate; the Soter plugin is only its surface,
holding no credential and making no judgment.

## Consequences
The two guards stop looking inconsistent: freezing an Accepted ADR and gating a Notion
write are the same test applied twice, while leaving ordinary file edits alone.

This gate fails CLOSED — an unreadable hook event is refused — unlike the checker's
guards, which fail open so they can never wedge a session. Standing in front of an
irreversible action inverts that trade.

It stays inside ADR-0010: removing the hook, or editing the checker, still defeats it.
It catches an honest skip, not a deliberate one; the human reading the diff remains
the real gate.

Costs: enforcement is Claude Code only, since `settings.json` hooks are its feature and
bb runs other providers. It is workspace-scoped, so it applies in this repo — which
makes ops running here load-bearing rather than incidental. And the hook must be
mirrored in `.claude/hooks/hooks.json`, or an install of this harness enforces less
than its source (ADR-0034; the checker's `HOOK_PARITY` caught exactly that here).

Revisit if enforcement is needed across providers, which a hook cannot give: that
means moving the gate to a capability boundary — withholding the raw write tools and
routing writes through a plugin-owned tool — and that would end the plugin's
no-credential constraint, so it is its own decision.
