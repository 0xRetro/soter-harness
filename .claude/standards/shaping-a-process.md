---
name: shaping-a-process
layer: context
system: process
kind: component
mold: standard
---

# Shaping a process

## The model
A process definition is one [DB] Process Inventory entry: its metadata lives in the **row**,
its runbook in the **body**. Keep the body lean — the essentials needed to run it — and add
heavier sections only when a real process forces them (ADR-0019; minimum viable, grows).

**Row** — set the known [DB] Process Inventory properties (`Name` · `Status` · `Maturity` ·
`Category` · `Frequency` · `Source` · `Soter Involvement` · `Tags` · `Prio` ·
`Process Logic Owner` · `Related Service`), each matched to a live option (the
`process-inventory` target).

**Body — the lean core (always):**
- **Purpose** — what the process produces or verifies, and why (1–3 lines).
- **Trigger** — what starts a run: `<kind>: <condition>` (Request · Event · Schedule ·
  Emergency).
- **Steps** — ordered `### Step N: <name>`; each is a set of **work-items** as `- [ ]`
  checkboxes. A work-item MAY carry `Rationale / Expected / Branches / Notes` lines beneath it
  when the process needs that rigor (security, capital); otherwise a plain checkbox.

**Recommended (light):**
- **Cadence** — one line, mirrors the `Frequency` property.
- **Roles** — Role · Who · Responsibility (only when more than one actor).
- **Exception Handling** — failure → workaround (when the process really has failure modes).
- **Post Run Summary** — a short template for the post-run report (outcome · proof/artifacts
  produced · deviations · improvements), filled in after each run. A run's work-items are
  tracked as [DB] Tasks (the run→tasks seam).

**Add later, as the process firms up (not needed for a first version):** Prerequisites ·
Resources · Inputs & Outputs · Sub-process rules · Connections · Improvement opportunities ·
Notes · Change Log.

Vocabulary: **steps** (never `phases`), **work-items** (never `tasks` — a [DB] Tasks task is
a run's tracked copy of a work-item). Fetch the live default template body before shaping —
don't invent the section set (ADR-0016).

## Use when / don't
- Applies when: shaping or reviewing the *body* of a [DB] Process Inventory entry.
- Doesn't apply when: the Notion *write mechanics* (`writing-records-to-notion` +
  `/pushing-to-notion`); the entry's row *properties* and option sets (the `process-inventory`
  target in `targets.md`); auditing a schema *doc* against its live DB
  (`auditing-a-schema-doc`); capturing a task or a feature (their own guides).
