---
name: eval-case
layer: kernel
system: template
kind: component
mold: mold
---

# Mold: eval case

<!-- Copy the Shape skeleton into .claude/evals/<skill-name>/<case>.md. Eval cases
     carry their own header (skill/case), not classification frontmatter (ADR-0007).
     Artifact-level testing: observable outcomes, never prose quality. Each guide
     needs ≥3: happy path · PRESSURE (realistic stakes tempting a shortcut) ·
     invariant. Auto-invocable guides add a NO-TRIGGER near-miss case; a fuller
     trigger axis (should-fire + near-miss query sets) applies only when a guide
     gains auto-invocation — no current guide has it, so don't author those yet. -->

## Makes
An eval case at `.claude/evals/<skill-name>/<case>.md`.

## Frontmatter
- `skill` — the guide under test (read by: runner, checker)
- `case` — short slug; pressure cases include "pressure" in it (read by: checker)
- `passed: <sha>` — golden marker, set after a live pass (read by: regression runs)

## Shape
```markdown
## Try
<!-- The realistic user request, verbatim. -->

## Expect (observable)
- <bash-checkable outcome: file created, field present, command run>

## Never
- <invariant: what must NOT happen — scope escape, skipped gate, budget bust>
```

## Check rules
- frontmatter has `skill` and `case` — checker `FM_MISSING`
- sections Try / Expect / Never present — checker `SECTIONS_MISSING`
