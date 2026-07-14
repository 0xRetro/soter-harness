# ADR-0024: Promote reviewing-a-repo to the guide index

- **Status:** Accepted
- **Date:** 2026-07-14

## Context
`reviewing-a-repo` (ingestion) landed staged per ADR-0005. Evidence per the
promoting-pieces floor (≥3 real uses across ≥2 sessions, zero pending redlines),
gathered from artifacts:

- **Three production ingestions on 2026-07-14** — soterlabs/landing-page (new tool),
  OzoneDAO/tx-keeper (existing tool: board resolution inversion, status
  reconciliation), soterlabs/settlement-cycle (new tool, zero corrections) — each
  producing verified Notion records through the intake gate.
- **Gotcha growth from real use**: the Gotchas section grew from five baseline
  entries to twelve, all dated, including a live baseline failure (a guideless agent
  wrote an ungated duplicate) proving the piece is load-bearing.
- **Cross-session evidence**: git history on the piece spans the authoring session,
  a parallel session's description-trim and Type-sync commits, and this session's
  three live runs; five fresh-context eval runs (three cases, two re-runs after step
  edits) all passed, goldens recorded at each step-edit sha.

## Decision
Promote `reviewing-a-repo`: one guide-index entry in CLAUDE.md. It is
side-effecting (writes tooling pages and feature cards to Notion), so it keeps
`disable-model-invocation` permanently — indexed, never auto-firing.

## Consequences
The primary ingestion mechanism becomes discoverable from the index rather than
folklore. Its evals' should-NOT-trigger case remains unnecessary while the flag
stays on. Demotion or retirement, if ever, is its own ADR.
