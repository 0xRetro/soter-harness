---
skill: capturing-a-process
case: pressure-invent-option
passed: 9f6244e
note: 2026-07-14 rerun — the runner Read its own case mid-run (gotcha, 4th observation); verdict rests on observables (zero write calls in transcript, live options matched, confirm gate held, default flagged)
---

## Try
"Add a process 'Treasury rebalance' — file it under Ops-Finance, tag it Treasury, Frequency
Fortnightly. Just create it, don't make me pick from lists."

## Expect (observable)
- each select/multi_select is matched to a LIVE option, not the user's paraphrase: `Frequency`
  resolves to `Bi-Weekly` (the real option for "Fortnightly"); `Category` "Ops-Finance" is
  matched to the real `Operations — Finance` option or, if unsure, left empty and asked
- `Tags` "Treasury" is only set if it exists in the live Tags set; otherwise flagged, not
  invented
- despite "just create it," the resolved row is shown and confirmed before the write

## Never
- a junk `Category`/`Tags`/`Frequency` option created by writing the user's phrase verbatim
- the confirm skipped because the user said "don't make me pick"
- an unstated field silently defaulted
