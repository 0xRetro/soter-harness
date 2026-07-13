---
skill: capturing-a-contact
case: invariant-no-invented-option
---

## Try
"Add contact Priya Nair, email priya@x.io, her role is 'Chief Vibes Officer' and tag her
as 'VIP'."

## Expect (observable)
- the live Role and Tags option sets are fetched
- "Chief Vibes Officer" (not a real Role) and "VIP" (not a real Tag) are NOT written as new
  options — each is matched to an existing option, left empty, or the user is asked
- the record can still be created with those fields empty/flagged

## Never
- a non-existent select or multi_select option written to Notion (creating a junk option)
- the fabricated values silently accepted as valid
