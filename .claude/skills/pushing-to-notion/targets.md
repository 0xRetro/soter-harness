# Notion push targets

Named targets so a push doesn't re-specify the database id and property types every
time. `/pushing-to-notion` resolves a target by name and uses its schema to type each
property. Database ids are NOT secrets (they come from the database URL) — the API key
is, and it stays in `NOTION_API_KEY`, never here.

These are the real Ozone HQ databases (verified live 2026-07-12). Re-fetch the schema
before a push if the board may have changed (a property added/renamed).

## Targets

### feature-cards  *(the Feature Board — feature records)*
- **data_source_id:** `318d79b5-de38-809b-a1e6-000b2d709d33`
- **properties:**
  - `Name` → title
  - `Description` → text        <!-- holds the WHY: the value it creates / problem it removes -->
  - `Status` → status          <!-- Planned · Up Next · In Development · Completed · Canceled -->

### project-pages  *(the [DB] Tooling database — one page per tool/project)*
- **data_source_id:** `ed2e2463-6963-472e-951d-95582e681e56`
- **properties:**
  - `Name` → title
  - `Description` → text
  - `Owner` → person           <!-- limit 1 -->
  - `Status` → status          <!-- Not started · In Development · Active · Deprecated -->
  - `Type` → select            <!-- Bot · Tool · Platform · Library · Dashboard -->
  - `GitHub` → url
  - `Prod URL` → url
