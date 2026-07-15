# ADR-0051: Meeting processing — official Otter MCP, summary-doc intermediate, project attribution

- **Status:** Accepted
- **Date:** 2026-07-15

## Context
Meetings live in [DB] Meetings with Otter recording links, but transcripts were
programmatically unreachable and action items never flowed into tasks or projects.
Research plus live validation (2026-07-15) established: the official Otter MCP server
(`https://mcp.otter.ai/mcp`, OAuth) works on the team's Business plan and returns full
transcripts by the Recording URL's trailing id; Notion's native meeting-note blocks are
readable ONLY through the Notion MCP (the REST API rejects the block type); and the
extraction literature converges on quote-grounding, a review gate before writes, and an
open-items ledger for recurring series. A full worked example (Osero x Ozone Weekly
2026-07-14) ran the pipeline end to end by hand.

## Decision
Transcripts are read through the OFFICIAL Otter MCP only — reverse-engineered wrappers
are rejected (ToS exposure, fragility). A processed meeting produces a summary doc in
[DB] Docs from the registered [Meeting Summary Template]: plain prose, no timestamps,
every topic naming its Related project or deal. Tasks and project updates derive from
the summary — grounded by `From:` lines carrying an @-mention and quote — and every
gated batch of writes is digested to the user's AI Inbox page (append-only review feed,
target `ai-inbox`).

## Consequences
Every pipeline artifact is linked to its source (meeting ↔ summary ↔ tasks/updates ↔
inbox), so provenance is traversable both ways. The quality bar lives in the policy
registry (Tasks v0.3–v0.5: D2 naming, grounding, Context+Task Description body shape,
belongs-to-a-project; Meetings v0.4: summary-doc rule; Docs v0.4: summary Reports in
scope), which every write inherits through the shared write discipline's policy fetch
(ADR-0021) — no new guide was needed for capture. A `processing-a-meeting` guide is
forged only after a second worked example on the Notion-native source, per the forge
baseline discipline. The Otter MCP registration is per-user local config for now; a
checked-in `.mcp.json` is a separate decision. Revisit triggers: the Otter MCP breaking
or being plan-regated, or the pipeline moving to its automation tier (scheduled polling
digests).
