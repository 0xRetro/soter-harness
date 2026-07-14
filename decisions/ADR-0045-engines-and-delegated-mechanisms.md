# ADR-0045: Engines and delegated mechanisms

- **Status:** Proposed
- **Date:** 2026-07-14

## Context

The README systems-inventory work exposed that several systems' behaviors run inside
other systems' machinery, and every card described this differently ("None — data
only", "realized today as a forge step", an informal "engine" on the enforcement
card). The owns-vs-executes split is real and load-bearing — the one-checker rule and
the one-authoring-loop rule force it — but it had no vocabulary, so each card
apologized in ad-hoc prose and overview tables inherited the confusion (a bare "—"
reads as a gap when it isn't one).

## Decision

Two registry terms, owned by lexicon. An **engine** is a component whose execution
runs other systems' delegated mechanisms on its own trigger — today the checker
(enforcement's), the forge loop (authoring's), and the human gate (governance's),
each itself a self-run mechanism of its owning system. A **delegated mechanism** is a
mechanism whose owning system delegates execution to an engine: ownership stays with
the system, the trigger with the engine. Cards for systems with only delegated
mechanisms keep the "None of its own" convention, reworded to use the term.

## Consequences

One grammar for the pattern ("X — delegated to the checker") across cards and
overview tables; check rules and forge steps are delegated mechanisms by definition —
this names their behavior, it does not change it. "Engine" becomes a reserved word:
informal uses that don't match the definition are reworded (the README's "Notion
intake engine"). A new engine is a registry-level event, never a prose aside.
Revisit trigger: delegation grammar being used to justify per-rule machinery (what
the one-engine rule forbids), or a fourth engine appearing and blurring the term.
