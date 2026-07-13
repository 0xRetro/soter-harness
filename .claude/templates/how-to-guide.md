---
name: how-to-guide
layer: kernel
system: template
kind: component
mold: mold
---

# Mold: how-to guide

<!-- Copy the Shape skeleton to make a new guide (a skill). Fill, delete hints. -->

## Makes
A guide at `.claude/skills/<name>/SKILL.md` — steps the model loads on demand.

## Frontmatter
- `name` — matches the folder, lowercase-hyphenated (read by: platform, checker)
- `description` — ≤1024 chars, third person: WHAT it does, WHEN to use it (the words
  a user would say), what it does NOT cover; never a summary of the steps
  (read by: platform triggering, checker)
- `disable-model-invocation: true` — required while staged, and forever for
  side-effecting guides (read by: platform)
- `layer · system · kind · mold` — per the classification rule (read by: checker)

## Shape
```markdown
# <Doing the thing>

## Goal
<!-- 1-2 sentences: what "done" looks like. -->

## Use when / don't use when
- Use when: …
- Not for: … (use `other-guide` instead)   <!-- the exclusion clause -->

## Steps
1. …
2. … — FLEX: <what may vary, and its bounds>
3. Verify: <observable check that it worked>

## Gotchas
<!-- Failure modes actually observed, each with its counter. Seed from the
     baseline (RED) run's rationalizations. -->

## Evals
- .claude/evals/<name>/…   <!-- ≥3 cases incl. one pressure case -->
```

## Check rules
- body < 500 lines; refs one level deep — checker `BUDGET_SKILL` + `REF_DEPTH`
- description ≤ 1024 chars, no XML; exclusion clause present — checker `DESC_LEN` + `DESC_XML` + `EXCLUSION_MISSING`
- ≥3 evals incl. pressure; auto-invocable adds a no-trigger case — checker `EVALS_MIN` + `PRESSURE_MISSING` + `TRIGGER_EVAL_MISSING`
- classification valid; no hints remain — checker `FM_CLASS` + `PLACEHOLDER`
