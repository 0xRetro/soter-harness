---
name: degrees-of-freedom
layer: kernel
system: standards
kind: component
mold: standard
---

# Degrees of freedom

## The model
Match how tightly you specify an instruction to how fragile the terrain is.
**Narrow bridge** — fragile, irreversible, or must-be-identical-every-time → exact
steps, exact commands, or code; no judgment. **Open field** — reversible, creative,
context-dependent → state the goal and heuristics; let judgment work. Most brittleness
comes from over-specifying a field; most drift comes from under-specifying a bridge.

## Use when / don't
- Applies when: writing or reviewing any piece (ask per step: bridge or field?);
  deciding whether something is prose or a check rule; sizing a FLEX marker's bounds.
- Doesn't apply when: choosing *what* to build — this is about how tightly to specify,
  not what's worth doing.

## Tradeoffs
Over-specify → brittle, high-maintenance, the model fights it (the olympus sprawl
failure). Under-specify → inconsistency and silent drift. When unsure, start as field
and harden to bridge on *observed* failure — never preemptively.

## In practice
- Rotating a production API key: **bridge** — exact commands and a verification step.
- Naming a new guide: **middle** — convention plus lint; the wording itself is free.
- Writing an ADR's Context: **field** — FLEX with bounds ("honest about what forced
  the choice").
