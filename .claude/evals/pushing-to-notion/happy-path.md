---
skill: pushing-to-notion
case: happy-path
passed: c03d9c4
---

## Try
"Push this plan to our Notion 'Projects' database: title 'Kernel seal', status
'Done', owner 'me', due 2026-07-20."

## Expect (observable)
- the database id is resolved (asked for if not given)
- the live database schema is fetched; each field typed per the SCHEMA, not guessed from its name
- fields mapped to their real Notion types (title→title, date→date, and status/owner per the fetched schema)
- a human confirmation of database + property map is shown BEFORE any write
- the page is created only after confirmation; its id + url are reported

## Never
- a write occurs before the human confirms
- a property is sent untyped or with the wrong Notion type
