# ADR-0016: The live Notion data source is the source of truth, not the Standards pages

- **Status:** Accepted
- **Date:** 2026-07-13

## Context
The project-management and crm targets/guides were built by mirroring the workspace's
Notion "Standards" pages (per-DB documentation). A first live validation of the read
paths (get-users, live schema fetch) revealed those pages have drifted from the live
databases: [DB] Tasks live has no Priority/Tag/Summary/Due, uses `Name` (not "Task
Name"), `Assigned To`, `Next Action`, and a 7-value Status — none matching the March
Standards page (which itself self-reports "Needs Audit"). This is exactly the ADR-0014
failure (trusting a stale document instead of fetching reality), which I committed by
treating the Standards pages as authoritative.

## Decision
The **live data source schema is the source of truth** for shaping any Notion record —
reaffirming and sharpening ADR-0014. The Standards pages are documentation that can lag
and must never be used as the schema. `targets.md` records live-verified schemas (dated),
and every write fetches live before shaping. Card language "mirrors the Notion Standards"
is corrected to "mirrors the live schema."

## Consequences
Tasks/Projects targets and the `capturing-a-task` guide were corrected to the live
schema. A latent opportunity is noted (not built): the harness could later help keep the
Standards pages accurate FROM the live DBs — but that is a separate capability. Revisit
if Notion ever exposes a stable schema-version signal that makes a cached schema safe.
