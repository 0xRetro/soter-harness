# ADR-0020: The checker reads git history for golden freshness (GOLDEN_STALE)

- **Status:** Accepted
- **Date:** 2026-07-13

## Context
Goldens (`passed: <sha>` on eval cases) are regression evidence about a guide as of
one commit; the moment the guide's steps change, that evidence silently proves
nothing. The gap was hit in practice the day this was written: a guide was edited and
nearly merged with its eval evidence stale, caught only by a human question. A prose
rule ("re-run affected evals after editing") was added, but prose relies on
discipline. Making staleness mechanically visible requires answering "did the guide
change after this sha" — which only git history can answer, and the checker had
deliberately been pure-filesystem until now.

## Decision
The checker gains its one git coupling: a warn-level `GOLDEN_STALE` rule that flags
any eval case whose golden predates the last change (committed or working-tree) to
its guide's SKILL.md. Fail-open when git cannot answer (no repo, shallow clone,
unknown sha) — a missed warning is recoverable at the gate; spurious warnings on
every run are not. CI fetches full history (`fetch-depth: 0`) so the rule is live
there.

## Consequences
Stale evidence becomes visible instead of remembered: editing a guide makes its
goldens warn until the cases are re-run and re-stamped. Warn-level means it never
blocks a merge by itself — the human gate decides. The checker is no longer
dependency-free; any future rule wanting git history cites this ADR rather than
re-deciding the coupling. Revisit trigger: if fail-open ever hides a real regression
at the gate, escalate the rule to error-level with an explicit git-availability check
(silence would then need evidence, per ADR-0003).
