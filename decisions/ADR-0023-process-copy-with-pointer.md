# ADR-0023: Process bodies carry the operator-facing how — copy-with-pointer

- **Status:** Accepted
- **Date:** 2026-07-13

## Context
ADR-0021 set reference-never-restate between processes and policy standards. Working the
first real process (Wallet Penny Test) end-to-end showed the strict form fails the
operator: a run must not require hopping docs mid-work — the SOP has to be usable from one
page. But naked copying recreates exactly the drift ADR-0021 exists to prevent, and the
policy layer's value collapses if processes silently fork the rules.

## Decision
A process body carries the **operator-facing how** inline — imperatives, the current value
list, determinations, naming conventions — so a run needs only the process doc. Every
copied **expanding set** (a naming convention, a function list) carries one pointer line
naming the subject's policy standard as where the set is managed. The policy remains the
law: rules, rationale, basis, and extension criteria are never copied into a process body.
Reference-never-restate (ADR-0021) still governs the law; the how is copy-with-pointer.

## Consequences
SOP usability wins at the cost of a bounded sync surface — the copied hows. The pointer on
every copy makes drift findable, and a future audit mechanism can walk a process's copies
against their policies (the same shape as schema-audit). New values land policy-first,
then in the processes that use them. Revisit trigger: copied hows drifting faster than
they're caught — then tighten to transclusion (synced blocks) or back to strict reference.
