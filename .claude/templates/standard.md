---
name: standard
layer: kernel
system: template
kind: component
mold: mold
---

# Mold: standard

<!-- Copy the Shape skeleton to make a standard — a way of judging or bounding work
     (the standards system's components). Not steps (guide) and not always/never
     bullets (house rule). Fill, delete hints. -->

## Makes
A standard at `.claude/standards/<name>.md`.

## Frontmatter
- `name · layer · system · kind · mold` — per the classification rule (read by: checker)

## Shape
```markdown
# <Name of the standard>

## The model
<!-- The bar or way of thinking, stated compactly. -->

## Use when / don't
- Applies when: …
- Doesn't apply when: …   <!-- the exclusion clause -->
```

## Check rules
- classification valid; exclusion clause present — checker `FM_CLASS` + `EXCLUSION_MISSING`
- no hints remain — checker `PLACEHOLDER`
