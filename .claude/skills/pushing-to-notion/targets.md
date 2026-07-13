# Notion push targets

Named targets so a push doesn't re-specify the database id and property types every
time. `/pushing-to-notion` resolves a target by name and uses its schema to type each
property. Database ids are NOT secrets (they come from the database URL) — the API key
is, and it stays in `NOTION_API_KEY`, never here.

Add a target per database. Replace the example below with your real ones.

## Format
Per target: a name, the database id, and each property's Notion type.

## Targets

<!-- EXAMPLE — replace with your real database. -->
### projects  *(example — not a real database)*
- **database_id:** `00000000-0000-0000-0000-000000000000`
- **properties:**
  - `Name` → title
  - `Status` → select
  - `Owner` → rich_text
  - `Due` → date
  - `Link` → url
