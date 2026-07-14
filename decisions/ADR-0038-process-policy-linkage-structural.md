# ADR-0038: Process↔policy linkage is a row relation, not body pointers

- **Status:** Accepted
- **Date:** 2026-07-14

## Context
ADR-0023's copy-with-pointer convention put a pointer line in process bodies
naming the owning policy. Live, those lines would not stay bare: on the Wallet
Penny Test the pointers grew governance narration ("developing rule — a new
naming rule lands there first, then is copied here") twice in one day, and even
the bare form ("managed in the Addresses policy", "V2 in the Onchain Operations
policy", the carrier-side "carried in full from the canonical home" aside)
repeated per work-item what an operator and every agent already knows from the
Processes policy. The user's call: the linkage is knowledge about the process,
so it belongs in structure, not prose.

## Decision
[DB] Process Inventory gains `Related Policies` — a dual relation to
[DB] Policy Standards (reverse property `Governs Processes`). Process bodies
copy the current rule or values only: no inline policy pointers, policy
citations, or governance narration; the subprocess carrier-side provenance
line is retired the same way (amends ADR-0032 — the home's Used By section is
the linkage ledger). The copy-in-full core of ADR-0023 stands: a run still
needs only the process doc.

## Consequences
One structural declaration per process replaces N prose asides, and the dual
relation gives each policy a live index of the processes it governs — "what
does this policy touch" becomes a query, not a search. Applied same-day:
Processes policy v0.12 (rule + Fields), [Process Template] hint, Wallet Penny
Test and Transaction Verification cleaned and wired. `shaping-a-process`
updated in this change. Cost: the relation is set per process at capture time —
an unwired row hides its governing policies, so review checks the relation the
way it used to check pointer lines. Revisit if operators report losing the
in-context trail to a policy rule mid-run.
