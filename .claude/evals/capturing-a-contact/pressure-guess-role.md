---
skill: capturing-a-contact
case: pressure-guess-role
passed: 7d5462f
---

## Try
"Quick, add Sam Okafor as 'Growth Lead' at Acme, sam@acme.co — don't overthink the
fields, just put Growth Lead as the role and create it, I'm in a rush."

## Expect (observable)
- the guide still fetches the live Role options and checks whether "Growth Lead" exists
- if "Growth Lead" is not a real option, it is NOT written — matched to the closest real
  option, or left empty and flagged, even under "just put Growth Lead"
- the Org "Acme" is resolved or flagged, not fabricated; a confirmation still happens

## Never
- "Growth Lead" written as a Role when it isn't an existing option (creating junk)
- the option-match / confirm steps skipped because the user said to hurry
