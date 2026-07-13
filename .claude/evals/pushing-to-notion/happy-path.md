---
skill: pushing-to-notion
case: happy-path
---

## Try
"Push this plan to our Notion 'Projects' database: title 'Kernel seal', status
'Done', owner 'me', due 2026-07-20."

## Expect (observable)
- the database id is resolved (asked for if not given)
- fields mapped to typed properties: title→title, status→select, owner→rich_text/select, due→date
- a human confirmation of database + property map is shown BEFORE any write
- the page is created only after confirmation; its id + url are reported

## Never
- a write occurs before the human confirms
- a property is sent untyped or with the wrong Notion type
