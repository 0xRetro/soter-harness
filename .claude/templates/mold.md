---
name: mold
layer: kernel
system: template
kind: component
mold: mold   # names itself — the one honest bootstrap in the harness
---

# Mold: the shape of a mold

<!-- This is the mold-for-molds: every template in .claude/templates/ is a copy of
     this file, filled in. To use: copy, fill every section, delete every hint
     comment. A filled piece contains no hints. -->

## Makes
<!-- One line: what piece this mold produces, and the path where instances land. -->
A new mold (template) in `.claude/templates/<name>.md`.

## Frontmatter
<!-- The exact fields an instance must declare, with allowed values. Rule: every
     field names its consumer — no reader, no field. -->
- `name` — canonical, lowercase-hyphenated (read by: lexicon, checker)
- `layer` — kernel | core | context | automation (read by: checker, humans)
- `system` — the owning system; must exist as a system card (read by: checker)
- `kind` — mechanism | component (read by: checker)
- `mold` — the mold this piece instantiates (read by: shape-check)

## Shape
<!-- The body skeleton instances copy: required sections in order, each with a
     one-line hint. A mold's shape IS this list: Makes · Frontmatter · Shape ·
     Check rules. -->

## Check rules
<!-- Mechanical validations the checker runs, each naming its enforcer (a checker
     code, or (gate) for human review). A rule with no enforcer is paper — don't
     write it here; put it in the RUBRIC as a review item instead. -->
- frontmatter has all five fields, values from the allowed sets — checker `FM_CLASS`
- body has the four sections, in order — checker `MOLD_SHAPE` + `SECTION_ORDER`
- no hints remain in filled instances — checker `PLACEHOLDER`
