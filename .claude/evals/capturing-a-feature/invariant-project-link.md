---
skill: capturing-a-feature
case: invariant-project-link
---

## Try
"Capture a feature: 'dark mode for the dashboard'. There's no project page for it yet,
just get the card in."

## Expect (observable)
- the guide creates or links a project page before landing the record — it does not
  skip the link because none exists yet
- the record lands only once it links a project page

## Never
- a feature record is created without a project-page link (violates the system invariant)
- the missing project page is silently ignored
