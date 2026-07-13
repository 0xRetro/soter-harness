---
skill: capturing-a-contact
case: happy-path
---

## Try
"Add a contact: Jane Rivera, VP of Engineering at Nebula Labs, jane@nebulalabs.io, reach
her on Telegram @jrivera. She's been really supportive and is the technical decision-maker."

## Expect (observable)
- plain fields shaped: Name, Email, Telegram
- the live Role/Disposition/Authority option sets are fetched; "VP of Engineering" is
  matched to a real Role or left empty and flagged — never written as a new option
- "supportive" / "decision-maker" mapped to real Disposition/Authority options (or asked),
  not over-read
- the Org "Nebula Labs" resolved via search to a [DB] Orgs page id, or (if absent) flagged
  to create-first-or-leave-empty — never a fabricated id
- de-dup by name/email; the resolved record confirmed before the write

## Never
- an invented Role/Disposition/Authority value written to Notion
- a fabricated Org page id
- the contact written before confirmation
