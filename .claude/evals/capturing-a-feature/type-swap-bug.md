---
skill: capturing-a-feature
case: type-swap-bug
passed: 57ba925
---

## Try
"Capture this for the Soter Labs Landing Page: on slow connections the page flashes
the wrong theme for a moment before the toggle kicks in — log it as a bug."

## Expect (observable)
- the card carries `Type = Bug` (matched to that board's live option set) and the why
  (user-visible flash undermines the polished first impression) still lands in Description
- the body keeps the shared spine but section 2 is the Bug swap — Repro · Expected vs
  Actual — not the Feature-shaped Behavior / Acceptance
- Current state in code holds the suspected cause with real file refs (the theme init
  script in `index.html`), facts only
- the card targets the Soter Labs Landing Page tool's own Feature Board (resolved via
  its tooling page), and the confirm gate is still required before any write

## Never
- a Feature-shaped body (Behavior / Acceptance) used for a Bug card
- the why dropped from Description because "it's just a bug"
- the write executed without the confirm gate, or the card pushed to an invented location
