---
name: targets
layer: automation
system: publishing
kind: component
mold: singleton
---

# Notion push targets

Named targets so a push doesn't re-specify the database id and property types every
time. `/pushing-to-notion` resolves a target by name and uses its schema to type each
property. Database ids are NOT secrets (they come from the database URL) — the API key
is, and it stays in `NOTION_API_KEY`, never here.

These are the real Ozone HQ databases (verified live 2026-07-12). Re-fetch the schema
before a push if the board may have changed (a property added/renamed).

## Targets

### tooling-pages  *(the [DB] Tooling database — one page per tool/product)*
- **data_source_id:** `ed2e2463-6963-472e-951d-95582e681e56` *(live-verified 2026-07-12)*
- **properties:**
  - `Name` → title
  - `Description` → text
  - `Owner` → person           <!-- limit 1 -->
  - `Status` → status          <!-- Not started · In Development · Active · Deprecated -->
  - `Type` → select            <!-- Bot · Tool · Platform · Dashboard · Content (Library removed 2026-07-14) -->
  - `GitHub` → url
  - `Prod URL` → url
- Every tooling entry EMBEDS its own Feature Board — the `feature-cards` target below
  is resolved through this database, never stored as a fixed id.
- **page template:** `[New Product Template]` (page `316d79b5de38801cbbeacdb847136f96`,
  the DB's registered default). A new tooling page's body STARTS from it — the embedded
  🔧 Feature Board plus Vision / Use Cases / How it works / Capabilities by area / Team /
  Related Resources sections. Apply it exactly once and poll the async task
  (`writing-records-to-notion` has the async rules); fill sections with derivable facts
  only, leave the rest visibly placeholder.

### feature-cards  *(a tooling entry's embedded Feature Board — PER ENTRY, no fixed id)*
There is no global feature board. Each tooling page embeds its own board (duplicated
from [DB] Tooling's new-product page template in Notion), and a card belongs to a tool
by living in that tool's board (containment). Resolve the id fresh each time:
1. find the tool's page in `tooling-pages` (create it first if it doesn't exist);
2. fetch that page and read the `data_source_id` of its embedded 🔧 Feature Board —
   the first inline database on the page. A page can embed OTHER databases too
   (e.g. a glossary), so don't grab just any embedded database.
Board titles are unreliable in BOTH directions (live survey 2026-07-13, 6 entries):
most keep the duplicated title "Feature Board Template"; some are renamed ("Txn Keeper
Features"). Identify a board only by the tooling page that embeds it.
- **properties** — the shared core, observed on every surveyed board:
  - `Name` → title
  - `Description` → text        <!-- holds the WHY: the value it creates / problem it removes -->
  - `Status` → status          <!-- Planned · Up Next · In Development · Completed · Canceled -->
- Boards MAY add per-tool properties beyond the core (Process Platform's adds `Area` /
  `Priority` / `Type` selects) — always fetch the SPECIFIC board's live schema before
  writing; fill extras only when the value is clear and matches a live option.
- **card template:** every board carries its own `[Feature Template]` page — read the
  board data source's `default_page_template`; card bodies follow THAT template's
  sections (live over assumed, ADR-0016 — the Soter Notion board's differs entirely:
  Feature Description / User Story / Acceptance Criteria / Technical Notes / Decision
  Log). Boards on the template-era default use the harness spine: Summary · Behavior /
  Acceptance · Current state in code · Relationships · Decisions & open questions, with
  section 2 swapped by card Type — the mapping lives in `capturing-a-feature` step 4.
  Write the body at create; NEVER `apply_template` onto an existing card — the
  template's default properties (Status=Planned · Priority=Next · Type=Feature) clobber
  real values.

### tasks  *(the [DB] Tasks database — actionable items)*
- **data_source_id:** `2abd79b5-de38-80f8-9470-000b7181b18d` *(live-verified 2026-07-14)*
- **policy standard:** `Tasks` in the `policy-standards` registry — rules, D1 (Context), lifecycle
- **properties:**
  - `Name` → title
  - `Status` → status          <!-- Backlog · To Do · Blocked · In Progress · Cancelled · Done · Archived -->
  - `Context` → select         <!-- Internal · Service · Project · Client; assign per the policy's D1 -->
  - `Prime Agent` → select     <!-- DEPRECATED (dupe of the Project/Org links) — never set on new tasks -->
  - `Assigned To` → person
  - `Client Contact` → person
  - `Next Action` → date
  - `Project` · `Related Docs` → relation   <!-- resolve the TARGET page id first -->
  - `Related Org` → rollup     <!-- READ-ONLY: derived via Project; never written -->
  <!-- No Priority/Tag/Summary/Due — the March Standards page listed those; the live DB doesn't have them. -->
- Registered templates: the DB default "New task" + "LEGAL TASK TEMPLATE". A template-shaped
  ROW ("[Task Template - DO NOT CHANGE]") also lives in the live data — skip it when querying.

### projects  *(the [DB] Projects database — client/internal engagements)*
- **data_source_id:** `721bfb88-e8d5-4934-ac26-cc82e1afc7a0` *(live-verified 2026-07-14)*
- **policy standard:** `Projects` in the `policy-standards` registry — rules, D1 (Type), lifecycle
- **properties:**
  - `Name` → title
  - `Type` → select            <!-- Project · Ongoing · Deal; assign per the policy's D1 -->
  - `Status` → status          <!-- Not Started · Active · On Hold · Complete · Cancelled -->
  - `Start Date` · `Target End Date` → date
  - `PM` · `Client Contact` → person
  - `Organization` · `Tasks` · `Docs` · `Opportunity` · `Service` → relation   <!-- resolve target page ids first -->
- Registered templates: the DB default plus "[Template] - Deal: [name]" for Deal-type entries.

### process-inventory  *(the [DB] Process Inventory database — one entry per repeatable process)*
- **data_source_id:** `31ad79b5-de38-8031-b789-000b661de83f` *(live-verified 2026-07-14, post Soter Involvement + Related Service property removals; Related Policies added per ADR-0038)*
- **properties:**
  - `Name` → title
  - `Status` → status          <!-- lifecycle: Backlog · Up Next · Draft · In Review · Active · Retired -->
  - `ProcessOS` → select       <!-- platform adoption: Not Ready · Ready · Live (empty = Not Ready) -->
  - `Category` → select        <!-- 18 options (Governance · Operations — <team> · NFAT - <product>) — fetch live for the full list -->
  - `Frequency` → select       <!-- Daily · Weekly · Bi-Weekly · Monthly · Quarterly · Per-Event · One-Time -->
  - `Tags` → multi_select      <!-- large set (Governance · Risk · MSC · CRM · Finance · Operations · …) — fetch live -->
  - `Prio` → number            <!-- 0 = highest priority; priority never encoded in Status -->
  - `Related Atlas Section` → url
  - `Process Logic Owner` → text   <!-- free text: person, agent name, multiple, or unknown -->
  - `Related Policies` → relation  <!-- → [DB] Policy Standards (dual: Governs Processes); the process↔policy linkage, ADR-0038 -->
  - `Related Roles` → relation     <!-- → [DB] Roles (dual: the directory's Processes); mirrors the body Roles table, ADR-0043 -->
- New entries start from the DB's default body template (page `cb0744051c564c4a91be9891af30b12a`);
  shape the body per the `shaping-a-process` standard (steps + work-items), not free-form.

### policy-standards  *(the [DB] Policy Standards database — one rules-first policy standard per subject)*
- **data_source_id:** `39dd79b5-de38-8042-9d47-000b9293ab47` *(live-verified 2026-07-14)*
- **properties:**
  - `Name` → title             <!-- the subject's name; the policy lives in the doc body -->
- New entries start from the DB's registered page template ("Policy Standard Template",
  page `2243621d7eec4ceabe35342970b66644`) — the live skeleton. Shape the body per the
  `shaping-a-policy-standard` standard (rules-first); one doc per subject, so search for
  an existing doc before creating.

### orgs  *(the [DB] Orgs database — organizations)*
- **data_source_id:** `2b2d79b5-de38-817a-981e-000b27e5575b` *(live-verified 2026-07-14)*
- **properties:**
  - `Name` → title
  - `Type` → select        <!-- Ecosystem DAO · Facilitator Team · Foundation · Prime Agent · Executor Agent · DevCo · GovOps · Halo Agent · Core Devs · Ecosystem Actor -->
  - `Tags` → multi_select  <!-- 24 options (Prospect · Priority · Vendor · CRM-ONLY · Terminated · …) — fetch live for the full list -->
  - `Website` · `Twitter` → url
  - `🫂 Contacts` · `Projects` · `📅 Meetings` · `📜 Docs` · `🔮 Associated Opps` · `Offerings Table` → relation
  <!-- emoji-prefixed property names are LITERAL — use them exactly; resolve target page ids first -->

### contacts  *(the [DB] Contacts database — people)*
- **data_source_id:** `2b2d79b5-de38-81d0-852e-000bc3fdf8d2` *(live-verified 2026-07-14)*
- **properties:**
  - `Name` → title
  - `Email` → email
  - `Role` → select        <!-- 19 options (Founder · COO · BD · Facilitator · …) — fetch live, don't invent -->
  - `Status` → select      <!-- Active · Inactive -->
  - `Disposition` → select <!-- Detractor · Neutral · Coach · Champion -->
  - `Authority` → multi_select   <!-- Technical Buyer · Economic Buyer · User Buyer -->
  - `Tags` → multi_select  <!-- Nerd · redline · Services -->
  - `Telegram` · `Signal` · `Discord ID` · `Github` · `Timezone (UTC)` · `Source` · `Sky Forum` → text
  - `Schedule appointment` → url
  - `Org` → relation       <!-- resolve to the [DB] Orgs page id -->

### process-runs  *(the [DB] Process Runs database — one row per execution of a process)*
- **data_source_id:** `39dd79b5-de38-80b5-be73-000be2ef2b91` *(live-verified 2026-07-14)*
- **properties:**
  - `Name` → title             <!-- D2 naming: [Process name] — [context or counterparty] — [start date] -->
  - `Process` → relation       <!-- → [DB] Process Inventory; resolve the process page id -->
  - `Roles` → text             <!-- one line per role: Role — @-mention of the [DB] Contacts record -->
  - `Inputs` → text            <!-- one line per input declared at Initialization; @-mention records where they exist -->
  - `Started` · `Completed` → date
  - `State` → select           <!-- In Progress · Closed -->
  - `Outcome` → select         <!-- Success · Failed · Aborted (set at close) -->
  - `Post Run Summary Report` → text   <!-- one line per field the process's Post Run Summary Report section declares -->
  - `Run ID` → auto-increment  <!-- system-assigned; do not set -->
- New rows start from the registered page template ("[Run Template]", page
  `39dd79b5de3880ed8f4bdaeef412b5ff`) — body = Run · Inputs · Outputs & Proof.

### channels  *(the [DB] Channels database — communication venues)*
- **data_source_id:** `39dd79b5-de38-806e-995f-000b75fc3ed7` *(live-verified 2026-07-14)*
- **properties:**
  - `Name` → title
  - `Platform` → select        <!-- Telegram · Slack · Discord · Email · Forum · Other -->
  - `Link` → url
  - `Related Orgs` · `Members` → relation   <!-- Members → [DB] Contacts; resolve page ids -->
  - `Status` → select          <!-- Active · Archived -->
  - `Notes` → text

### addresses  *(the [DB] Addresses database — blockchain accounts)*
- **data_source_id:** `39dd79b5-de38-8091-8617-000bd102afaa` *(live-verified 2026-07-14)*
- **properties:**
  - `Address` → title          <!-- full address verbatim, never truncated -->
  - `Internal Label` → text    <!-- [Org] [Program] per Addresses policy D3 -->
  - `Network` → select         <!-- ETH -->
  - `Function(s)` → multi_select   <!-- IB Partner Payment · Ops Sending -->
  - `Type` → select            <!-- EOA · SafeProxy · Contract (assigned per D1) -->
  - `Address Source` → file    <!-- intake evidence; external addresses only -->
  - `Related Org` → relation   <!-- → [DB] Orgs; resolve or create first -->
  - `Verification Process` → relation   <!-- → [DB] Process Runs; the link IS verification -->
  - `Verified` → checkbox      <!-- explicit flag; checked by the closing role only with a linked Closed·Success run (Addresses policy v0.11) -->

### roles  *(the [DB] Roles database — the role directory)*
- **data_source_id:** `680b7ad4-f703-4de5-a71c-324f9fc8eb88` *(live-verified 2026-07-14)*
- **properties:**
  - `Name` → title
  - `Definition` · `Requirements` · `Training` → text
  - `Capabilities` → multi_select   <!-- Safe Signer · Onchain TX Verification · TX Executor · Ops & Comms; defined in the Processes policy -->
  - `Held by` → relation       <!-- → [DB] Contacts -->
  - `Processes` → relation      <!-- → [DB] Process Inventory -->
  - `Status` → select          <!-- Active · Retired -->
### resources  *(the [DB] Resources database — external accounts, platforms, shared assets)*
- **data_source_id:** `315d79b5-de38-80a0-8940-000b21386424` *(live-verified 2026-07-14)*
- **properties:**
  - `Name` → title          <!-- named per the Resources policy standard's D1 -->
  - `Description` → text
  - `Type` → select         <!-- Publishing · Communication · Group Email · Development · Infrastructure · Workspace · Content · Tracker · Finance -->
  - `Access` → select       <!-- Ask Admin for Access · Ask for Invite Code/Email · Managed by Shared Email · Managed by Sky ProSec · Details in Resource Page -->
  - `URL` → url             <!-- property name is literally "URL" (userDefined) ; expected empty for Group Email -->
  - `Admin` → person        <!-- may be several people -->
  - `Last Verified` → date  <!-- stamped only on actual verification -->
- **page template:** `[Resource Template]` (page `39dd79b5de388039993bfb1b4a7a8d8b`,
  registered on the DB). Body shape (per the Resources policy standard): Access ·
  Subscription & Billing (as applicable; org billing defaults live in the policy
  standard; the tier name lives in the BODY — no Plan property) · Configuration ·
  Members (as applicable; member + role) · Security (as
  applicable; workspace-level settings like 2FA-required, never per-individual) ·
  Notes. Unknowns stay bare `not defined` — they are the worklist. NO SECRETS ever —
  credential locations only; standing invite links only by explicit admin decision.

> **Relations:** the create/update bindings write a relation as the TARGET page's id.
> Resolve it (search the related DB by name) before writing, or leave the relation empty
> and link it in a follow-up. Don't fabricate a page id.
> **Select/multi_select:** the value must be an EXISTING option — fetch the live schema
> and match; never invent an option name (a wrong one is rejected or silently creates junk).
