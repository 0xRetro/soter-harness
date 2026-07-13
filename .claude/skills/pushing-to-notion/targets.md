# Notion push targets

Named targets so a push doesn't re-specify the database id and property types every
time. `/pushing-to-notion` resolves a target by name and uses its schema to type each
property. Database ids are NOT secrets (they come from the database URL) — the API key
is, and it stays in `NOTION_API_KEY`, never here.

These are the real Ozone HQ databases (verified live 2026-07-12). Re-fetch the schema
before a push if the board may have changed (a property added/renamed).

## Targets

### feature-cards  *(a tool's Feature Board — feature records)*
Feature boards are PER TOOLING ENTRY — the board a card lives in is its link to that
project. The id below is Soter Notion's board; resolve the right tool's board id when
capturing a feature for a different tool (fetch the tooling page, read its embedded
Feature Board's data_source_id).
- **data_source_id:** `318d79b5-de38-809b-a1e6-000b2d709d33`  *(Soter Notion's board)*
- **properties:**
  - `Name` → title
  - `Description` → text        <!-- holds the WHY: the value it creates / problem it removes -->
  - `Status` → status          <!-- Planned · Up Next · In Development · Completed · Canceled -->

### tooling-pages  *(the [DB] Tooling database — one page per tool/product)*
- **data_source_id:** `ed2e2463-6963-472e-951d-95582e681e56`
- **properties:**
  - `Name` → title
  - `Description` → text
  - `Owner` → person           <!-- limit 1 -->
  - `Status` → status          <!-- Not started · In Development · Active · Deprecated -->
  - `Type` → select            <!-- Bot · Tool · Platform · Library · Dashboard -->
  - `GitHub` → url
  - `Prod URL` → url

### tasks  *(the [DB] Tasks database — actionable work items)*
- **data_source_id:** `2abd79b5-de38-80f8-9470-000b7181b18d`
- **properties:**
  - `Task Name` → title
  - `Status` → status          <!-- Not started · In progress · Done -->
  - `Priority` → select        <!-- Low · Medium · High · Urgent -->
  - `Tag` → multi_select       <!-- Bug · Feature · Improvement · Research · Documentation · Operations · Client · Internal · Blocked -->
  - `Assignee` → person
  - `Due` → date
  - `Summary` → text
  - `Project` · `Org` · `Parent task` → relation   <!-- relations need the TARGET page id; resolve/search first -->

### projects  *(the [DB] Projects database — client/internal engagements)*
- **data_source_id:** `721bfb88-e8d5-4934-ac26-cc82e1afc7a0`
- **properties:**
  - `Project Name` → title
  - `Type` → select            <!-- Client · Internal · Research · Pilot -->
  - `Status` → status          <!-- Not started · In progress · Done -->
  - `Start Date` · `Target End Date` → date
  - `Description` → text
  - `Code` → text
  - `Organization` · `Primary Contact` · `Tasks` → relation   <!-- resolve target page ids first -->

### orgs  *(the [DB] Orgs database — organizations)*
- **data_source_id:** `2b2d79b5-de38-817a-981e-000b27e5575b`
- **properties:**
  - `Name` → title
  - `Type` → select        <!-- Ecosystem DAO · Facilitator Team · Foundation · Prime/Executor Agent · DevCo · GovOps · … -->
  - `Tags` → multi_select  <!-- large set (Prospect · Priority · Vendor · CRM-ONLY · …) — fetch live for the full list -->
  - `Website` · `Twitter` → url
  - `Contacts` · `Projects` → relation   <!-- resolve target page ids -->

### contacts  *(the [DB] Contacts database — people)*
- **data_source_id:** `2b2d79b5-de38-81d0-852e-000bc3fdf8d2`
- **properties:**
  - `Name` → title
  - `Email` → email
  - `Role` → select        <!-- ~26 options (Founder · COO · BD · Facilitator · …) — fetch live, don't invent -->
  - `Status` → select      <!-- Active · Inactive -->
  - `Disposition` → select <!-- Detractor · Neutral · Coach · Champion -->
  - `Authority` → multi_select   <!-- Technical Buyer · Economic Buyer · User Buyer -->
  - `Tags` → multi_select  <!-- Nerd · redline · Services -->
  - `Telegram` · `Signal` · `Discord ID` · `Github` · `Timezone (UTC)` · `Source` → text
  - `Org` → relation       <!-- resolve to the [DB] Orgs page id -->

> **Relations:** the create/update bindings write a relation as the TARGET page's id.
> Resolve it (search the related DB by name) before writing, or leave the relation empty
> and link it in a follow-up. Don't fabricate a page id.
> **Select/multi_select:** the value must be an EXISTING option — fetch the live schema
> and match; never invent an option name (a wrong one is rejected or silently creates junk).
