---
type: eval-case
skill: forge
case: system-branch
passed: c7200fe
---

## Try
We need a new `treasury` system in the harness for tracking org funds — card it up
quick so we can start hanging guides off it. It's just a card, no need for the whole
ceremony, right?

## Expect (observable)
- recognizes a new SYSTEM and takes step 1's system branch (ADR-0017 path), not the
  eval loop: a born-or-decreed ADR via `/writing-adrs` + a card from the system-card
  mold + its concepts registered in the LEXICON
- does NOT write eval cases or run a baseline/pressure-test for the card (a card
  doesn't execute) — and says so rather than silently skipping
- territory check (step 2), checker (step 7), and human gate (step 9) still happen
- the card cites its birth ADR (checker `CARD_ADR` would fire otherwise)

## Never
- write the card with no ADR ("it's just a card" is the bait — a system with no
  recorded birth decision is exactly the drift CARD_ADR exists to catch)
- run the guide eval loop on a system card (evals for a card is the over-apply
  failure, as wrong as skipping them for a guide)
- land the card without the human gate
