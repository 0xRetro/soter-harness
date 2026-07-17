# Soter development instructions

Read README.md, ARCHITECTURE.md, CONTRACTS.md, and soter/README.md before
changing the harness.

## Architecture

- Treat kernel, core, context, automation, and integration as responsibility
  layers. Codex, Claude, and future runtimes are hosts.
- Keep canonical definitions provider-neutral. Host files project resolved
  behavior; they do not become the source of truth.
- Put domain meaning and authority in context, outcomes and orchestration in
  automation, and provider transport and translation in integration.
- Treat MCP as a host transport beneath Soter capabilities. Automations never
  depend on host-qualified MCP tool names; Core emits exact, policy-bound
  host-tool requests and validates normalized results on resume.
- Make pack selection, dependencies, bindings, authorities, permissions, and
  effects explicit.

## Migration boundary

- The .claude tree is the working legacy implementation.
- The soter tree is the target implementation.
- Do not claim a mapped artifact is migrated, ready, or verified without the
  corresponding migration state and evidence.
- Preserve working legacy behavior until the target slice proves equivalent or
  intentionally changed behavior.
- The decisions directory is a historical archive. Do not create an ADR by
  default; normally keep rationale with contracts, scenarios, migration
  entries, verification evidence, and git history.

## Change discipline

- Work in a dedicated worktree and branch; leave the root checkout on main.
- Do not perform external writes, live migrations, or destructive actions
  without explicit user approval.
- Keep secrets outside desired configuration. Store references only.
- Treat fixture and contained provider evidence as local behavior proof only;
  it does not establish connected credentials, reachability, or live health.
- Treat provider probes as expiring private runtime state. They must bind the
  exact lock and implementation, contain references rather than secret values,
  and cannot establish write behavior or end-to-end health.
- Treat `.soter/state` as private, ignored runtime state. Rehydrate pending
  provider work by checkpoint ID; never stage, distribute, or reconstruct it
  from conversational memory.
- A declared MCP route is not proof of authentication, tool availability,
  provider authority, readiness, or behavior. Keep OAuth values out of repo
  configuration and require exact-lock connected evidence for those claims.
- Bind every confirmation to the exact change-set fingerprint. A changed
  operation batch requires a new approval; an approval is never a reusable
  permission token.
- Use apply_patch for edits and preserve unrelated user changes.
- A target change is incomplete if its machine-readable graph and human-facing
  explanation disagree.

## Verification

Run all applicable checks before handing work back:

    node .claude/scripts/check.mjs --all
    node soter/kernel/verify.mjs --selftest
    node soter/kernel/verify.mjs
    node soter/core/cli.mjs selftest
    node soter/core/cli.mjs fixtures --check
    node soter/core/cli.mjs doctor --lock soter/fixtures/meeting-intake/meeting-intake.lock.json

Use structured target output when another interface consumes verification:

    node soter/kernel/verify.mjs --json

A successful target verification may still report ready=unknown,
verified=unknown, or healthy=unknown. Do not collapse those states into a
generic green claim.
