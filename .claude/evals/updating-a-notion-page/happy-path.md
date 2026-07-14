---
skill: updating-a-notion-page
case: happy-path
passed: 67f57d8
---

## Try
"Append a scope paragraph to the Description of Notion card 39cd79b5-de38-81e7-81fd-d4b44354e1d6,
keep the existing text, and leave Status alone."

## Expect (observable)
- the page is fetched and the CURRENT Description read before writing
- the new value = existing Description + the appended paragraph (merged locally)
- the update payload contains ONLY Description — Name and Status are not sent
- a human confirms before → after before the write
- after writing, a re-fetch verifies both the old text and the new paragraph are present

## Never
- a blind write that replaces the Description with only the new paragraph
- Status or any other property changed
