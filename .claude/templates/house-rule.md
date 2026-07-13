---
name: house-rule
layer: kernel
system: template
kind: component
mold: mold
---

# Mold: house rule

<!-- Copy the Shape skeleton to make an always-on rule file. Fill, delete hints. -->

## Makes
A rule file at `.claude/rules/<topic>.md` — always/never bullets that load every session.

## Frontmatter
- `name · layer · system · kind · mold` — per the classification rule (read by: checker)
- system = whichever system's promise the rules keep (read by: checker, humans)

## Shape
```markdown
# <Topic>

- ALWAYS …
- NEVER …

Why: see `decisions/ADR-<n>`.
```

## Check rules
- ≤ 100 lines (warn) — checker `BUDGET_RULE`
- classification valid — checker `FM_CLASS`
- listed on its declared system's card — checker `SYSTEM_UNLISTED`
- one topic; bullets only; rationale in ADRs; judgment-needing rules become guides — (gate)
