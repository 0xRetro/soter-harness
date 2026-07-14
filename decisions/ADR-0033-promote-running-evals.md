# ADR-0033: Promote running-evals to the guide index

- **Status:** Proposed
- **Date:** 2026-07-14

## Context
`running-evals` (eval) landed staged with the multi-agent operating model
(ADR-0027, commit 2f26d9c). Evidence per the promoting-pieces floor (≥3 real uses
across ≥2 sessions, zero pending redlines), gathered from artifacts:

- **Git history across distinct sessions**: step-hardening commits 24051ad
  (meta-case FLEX + description trim), 869c302 (escalated-dispatch gotcha from the
  contained capturing-a-task end-to-end run), 2e8086c (terminology unification),
  c64a9d9 (goldens re-recorded through it) — each an artifact of the guide being
  run, not merely edited.
- **Eight dated gotcha entries**, all provenance-stamped 2026-07-14 live/observed —
  real use grows dated gotchas (ungated duplicate write, confirm leak, agents
  reading their own case ×3, idle-notification gap, 429 stagger, contained runners
  pushing real PRs ×3, meta-case dispatch escalation).
- **The golden wave (PR #13, commits e06f690/76bec09)**: fourteen fresh-context
  eval-runner dispatches framed, judged from artifacts, and stamped in one session —
  taking the checker from seven golden warnings to zero. A separate session
  independently followed the guide the same day for the re-run request that seeded
  that wave.

## Decision
Promote `running-evals`: one guide-index entry in CLAUDE.md. It is side-effecting
(dispatches agents, stamps goldens, commits), so it keeps
`disable-model-invocation` permanently — indexed, never auto-firing.

## Consequences
Eval running becomes discoverable from the index — sessions asked to run or re-run
cases find the guide instead of improvising a raw dispatch (the exact failure its
own baseline gotcha records). The remaining staged guides are evaluated separately
as their evidence accrues — one piece per decision; evidence never transfers.
Demotion or retirement, if ever, is its own ADR.
