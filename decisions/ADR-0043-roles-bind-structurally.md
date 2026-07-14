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
what the role owns in that process, as capability-keyed dash-lines
(**Capability** — responsibility; unkeyed where no formal capability
applies) — each responsibility names the capability it leverages. The
role's capability LIST is never restated in the table; a capability name
appears only as such a key. A subprocess home carries capability-bound
SLOTS, not directory roles: its Roles section defines each slot's required
capabilities and the calling process's Roles table binds them — the
directory holds only standing roles.

## Consequences
Roles bind by reference, not name-matching: a rename propagates, a missing
directory row is impossible to hide, and each role row lists every process
that binds it. Applied same-day: [DB] Roles relation dualized; the penny
test table restructured and capability-keyed; Transaction Verification's
Roles section became slot definitions (Proposer/Executor slot rows were
tried as directory entries and removed the same day — the user trimmed the
directory to standing roles only); [Process Template] and Processes policy
v0.14–0.16 updated, `shaping-a-process` in this change. Cost: the relation is set per process alongside the table —
review checks both agree. Revisit if the two-column table proves too thin
for a process with many per-role constraints.
