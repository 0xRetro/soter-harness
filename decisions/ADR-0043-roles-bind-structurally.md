# ADR-0043: Roles bind structurally — @-mentioned directory rows, dual relation

- **Status:** Proposed
- **Date:** 2026-07-14

## Context
ADR-0038 moved the process↔policy linkage from body prose to a row relation.
The Roles table had the same disease in a different shape: a Who column and
per-cell capability lists restating what the [DB] Roles directory already
owns (capabilities, definition, held-by), and the table's role names bound to
the directory only by matching text. Transaction Verification's Proposer and
Executor didn't exist in the directory at all — the roles-bind-to-directory
rule held by luck, not structure.

## Decision
The existing [DB] Roles → Process Inventory relation becomes dual: processes
carry `Related Roles` (synced with the directory's `Processes`). A process
body's Roles table is two columns — Role · Responsibility — where the Role
cell @-mentions the directory row and the Responsibility cell carries only
what the role owns in that process. Role-level facts are never restated in
the table. Capability-bound subprocess slots (Proposer, Executor) are
directory rows like any role — unheld, bound by the calling process.

## Consequences
Roles bind by reference, not name-matching: a rename propagates, a missing
directory row is impossible to hide, and each role row lists every process
that binds it. Applied same-day: [DB] Roles relation dualized, Proposer +
Executor added, penny test + Transaction Verification tables restructured,
[Process Template] and Processes policy v0.14 updated, `shaping-a-process`
in this change. Cost: the relation is set per process alongside the table —
review checks both agree. Revisit if the two-column table proves too thin
for a process with many per-role constraints.
