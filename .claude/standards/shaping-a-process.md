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
- **Steps** — role-bounded: `### Step N — (Role) <objective>`. One role owns a step, so
  each step transition is a role handoff — that handoff IS the gate; no separate gate
  lines. Each step opens with a 1–3 line narrative intro: how the work actually arrives
  and what the step accomplishes — plain, concrete, never flowery. Work-items are `- [ ]`
  checkboxes: a bolded action headline, then the how (and the why, where it isn't obvious)
  woven into prose — no citation tags. Registering a record may go field-per-checkbox
  when each field is real work. A branch is an inline `⤷ condition → En` pointer.
  A **write work-item** mention-links its target database and carries the operator-facing
  how INLINE — imperatives, the current value list, determinations — so a run needs only
  the process doc (ADR-0023). An expanding set (naming convention, function list) is
  copied as the CURRENT rule plus one pointer line naming the subject's policy standard
  as where the set is managed; the law (rules, rationale, extension criteria) is never
  copied (ADR-0021). Prerequisites resolve-or-create through the subject's own owner.

**Recommended (light):**
- **Cadence** — one line, mirrors the `Frequency` property.
- **Roles** — Role · Who · Responsibility; the step headings bind to these roles, so the
  table exists whenever steps do.
- **Exception Handling** — labeled exceptions (**E1, E2, …**), each failure → workaround,
  defined once here; a work-item that can trigger one carries an inline `⤷ condition → En`
  pointer instead of restating the handling.
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
