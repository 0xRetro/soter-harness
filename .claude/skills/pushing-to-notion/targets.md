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
- **data_source_id:** `ed2e2463-6963-472e-951d-95582e681e56` *(live-verified 2026-08-11)*
- **policy standard:** `Tooling` in the `policy-standards` registry — rules, D1 (Tool Type), D3 (de-dup on Name + GitHub), Tool Status lifecycle. The SAME policy governs `feature-cards`
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
  🔧 Feature Board plus `Product Vision` · `Use Cases / Scope` · `How it works` · `Team` ·
  `Related Resources` · `Capabilities by area` (Capabilities LAST: a hand-authored `<details>` toggle
  per area — the tool's own 4–7 axis — with ✅ built / ⬜ planned bullets, each linking
  its feature card where one exists, updated by hand as statuses change; replaced the
  earlier self-syncing linked-view config per ADR-0058, template updated live
  2026-07-15). Apply the template exactly once and poll the async task
  (`writing-records-to-notion` has the async rules); fill sections with derivable facts
  only, DELETE each hint once its section is filled, leave unfillable sections visibly
  empty. Defining the board's `Area` options (the tool's own 4–7 axis) stays an
  intake-gate decision (they power board grouping); the Capabilities section mirrors
  that axis but no longer depends on the options existing.

### feature-cards  *(a tooling entry's embedded Feature Board — PER ENTRY, no fixed id)*
- **policy standard:** `Tooling` in the `policy-standards` registry — the feature card's own Fields table, D2 (Card Type → body section), Card Status lifecycle, and the why-in-Description rule

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
  Template-era boards ship `Area` with an EMPTY option set — defining the tool's own
  axis (4–7 options) is an intake-gate decision; the tooling page's hand-authored
  Capabilities toggles mirror the same axis (ADR-0058; e.g. the Soter Harness board's
  Kernel · Core · Context · Automation).
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
- **data_source_id:** `2abd79b5-de38-80f8-9470-000b7181b18d` *(live-verified 2026-07-15, full audit — doc + mirror diffed, no drift)*
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
- Registered templates: the DB default ("[Task Template]", page `36fd79b5de3880758f2fecd73df8e83b`,
  renamed from "[Task Template - DO NOT CHANGE]" 2026-07-15) + the legal template (page
  `36ed79b5de38801db5b2f1797a350b77`; live title "LEGAL TASK TEMPLATE (insert a name) " —
  placeholder suffix and trailing space literal; its body is legal-intake shaped, NOT the
  Tasks policy's Context/Task Description shape). The default template page ALSO surfaces
  as a queryable row — skip it when querying rows.

### projects  *(the [DB] Projects database — client/internal engagements)*
- **data_source_id:** `721bfb88-e8d5-4934-ac26-cc82e1afc7a0` *(live-verified 2026-08-11, post Client Contact→Project Member rename; prior 2026-07-14 verification covered the Ongoing→Operations option rename + Opportunity/Service property removals)*
- **policy standard:** `Projects` in the `policy-standards` registry — rules, D1 (Type), lifecycle, naming rule, body standard (sections, milestone/work-item grammar, project roles)
- **properties:**
  - `Name` → title             <!-- `<Org>: <Engagement>` per the policy's naming rule -->
  - `Type` → select            <!-- Project · Operations · Deal; assign per the policy's D1 -->
  - `Status` → status          <!-- Not Started · Active · On Hold · Complete · Cancelled -->
  - `Start Date` · `Target End Date` → date
  - `PM` · `Project Member` → person   <!-- workspace users only; same person-type limit as Tasks/Meetings. `Client Contact` was RENAMED to `Project Member` (observed live 2026-08-11); the Projects policy standard's Fields table still says Client Contact and needs the same correction -->
  - `Organization` · `Tasks` · `Docs` · `Channels` → relation   <!-- resolve target page ids first; Channels → [DB] Channels (39dd79b5-de38-806e-995f-000b75fc3ed7) -->
- Registered templates: the DB default "[Project Template]" plus "[Deal Template]" for
  Deal-type entries (deal milestone set pre-filled). Both implement the policy's body
  standard FULLY WIRED: template-relative live views for the Task Board, Docs, Meeting
  Logs & Notes, Updates, Questions, and Decisions — the view API cannot set relation
  filters, so the templates are the only automated path to per-project filtered views.

### process-inventory  *(the [DB] Process Inventory database — one entry per repeatable process)*
- **data_source_id:** `31ad79b5-de38-8031-b789-000b661de83f` *(live-verified 2026-07-14, post Soter Involvement + Related Service property removals; Related Policies added per ADR-0038)*
- **policy standard:** `Processes` in the `policy-standards` registry — rules, D3 (shaping a new process), `Category`/`Frequency`/`Tags`/`ProcessOS` classifications, Backlog→Retired lifecycle. The SAME policy governs `process-runs` and `roles`
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
  a subprocess home starts from the registered [Subprocess Template] instead (page
  `39dd79b5de3880c18a92d43fe0bb88c5`, presets Per-Event · Subprocess · Draft);
  shape the body per the `shaping-a-process` standard (steps + work-items), not free-form.

### policy-standards  *(the [DB] Policy Standards database — one rules-first policy standard per subject)*
- **data_source_id:** `39dd79b5-de38-8042-9d47-000b9293ab47` *(live-verified 2026-07-15)*
- **properties:**
  - `Name` → title             <!-- the subject's name; the policy lives in the doc body -->
  - `Governs Processes` → relation   <!-- → [DB] Process Inventory (dual of Related Policies, ADR-0038); resolve target page ids first -->
- New entries start from the DB's registered page template ("Policy Standard Template",
  page `2243621d7eec4ceabe35342970b66644`) — the live skeleton. Shape the body per the
  `shaping-a-policy-standard` standard (rules-first); one doc per subject, so search for
  an existing doc before creating.

### orgs  *(the [DB] Orgs database — organizations)*
- **data_source_id:** `2b2d79b5-de38-817a-981e-000b27e5575b` *(live-verified 2026-07-14)*
- **policy standard:** `Orgs` in the `policy-standards` registry — rules, Type (Sky-ecosystem role ONLY; sector and relationship labels live in Tags), Type determination rule
- **properties:**
  - `Name` → title
  - `Type` → select        <!-- Ecosystem DAO · Facilitator Team · Foundation · Prime Agent · Executor Agent · DevCo · GovOps · Halo Agent · Core Devs · Ecosystem Actor -->
  - `Tags` → multi_select  <!-- 24 options (Prospect · Priority · Vendor · CRM-ONLY · Terminated · …) — fetch live for the full list -->
  - `Website` · `Twitter` → url
  - `🫂 Contacts` · `Projects` · `📅 Meetings` · `📜 Docs` · `🔮 Associated Opps` · `Offerings Table` → relation
  <!-- emoji-prefixed property names are LITERAL — use them exactly; resolve target page ids first -->

### contacts  *(the [DB] Contacts database — people)*
- **data_source_id:** `2b2d79b5-de38-81d0-852e-000bc3fdf8d2` *(live-verified 2026-07-15, full audit — doc + mirror diffed, no schema drift)*
- **policy standard:** `Contacts` in the `policy-standards` registry — identity/dedup, belongs-to-an-org, Role/Disposition/Authority determination rules
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
- Registered template: the DB default ("New person", page `2b2d79b5de3881d68863ee833d67d3ce`) —
  sets no property values; body is Notion's stock personal-CRM sections (Address · Family
  members · Likes · Gift ideas · Miscellaneous notes). The Contacts policy declares no
  body-shape rule, so a new record's body carries no required sections.

### meetings  *(the [DB] Meetings database — held or scheduled calls and sessions)*
- **data_source_id:** `b2550e36-38d5-4d33-86db-bbd0987aeaef` *(live-verified 2026-07-14)*
- **policy standard:** `Meetings` in the `policy-standards` registry — rules, D1 (Meeting Name), D2 (Type), and the summary-doc rule: a processed meeting produces a [DB] Docs summary from [Meeting Summary Template], linked back through Related Docs
- **properties:**
  - `Meeting Name` → title     <!-- recurring series: series name + instance date ("Ozone EDU 2026-07-10") -->
  - `Date` → date              <!-- when the meeting occurs/occurred; single date, no time -->
  - `Type` → select            <!-- Team Meeting · EDU Session · BD · Client Sync · Project Sync · Office Hours · Ops -->
  - `Org` → relation           <!-- → [DB] Orgs (two-way); the participating orgs — resolve page ids -->
  - `Participants` → person   <!-- workspace users only — can NOT hold [DB] Contacts rows; Client Contact (person) REMOVED 2026-07-15, ghost-valued and unusable for [DB] Contacts -->
  - `Recording` → url          <!-- the meeting owner's Otter link, added post-meeting -->
  - `Related Docs` → relation  <!-- → [DB] Docs -->
- A processed meeting's summary doc (see the `docs` target) hangs off `Related Docs`;
  the Recording URL's trailing id is fetchable via the Otter MCP (`mcp__otter__fetch`).
- Rows are PRE-CREATED ahead of the meeting (the weekly Hermes generation run, and the
  Scheduling and Running Meetings process's "2 days in advance" step) with body skeleton
  `## Agenda` / `## Follow Ups` — search series + date before any create; an existing row
  is an update (`/updating-a-notion-page`), never a duplicate.

### process-runs  *(the [DB] Process Runs database — one row per execution of a process)*
- **data_source_id:** `39dd79b5-de38-80b5-be73-000be2ef2b91` *(live-verified 2026-07-14)*
- **policy standard:** `Processes` in the `policy-standards` registry — the run Fields table, D1 (Outcome at close: Success/Failed/Aborted), D2 (run naming), In Progress → Closed lifecycle
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
- **policy standard:** `Channels` in the `policy-standards` registry — rules, Platform + Status classifications, Active/Archived lifecycle (determination rules `not defined`)
- **properties:**
  - `Name` → title
  - `Platform` → select        <!-- Telegram · Slack · Discord · Email · Forum · Other -->
  - `Link` → url
  - `Related Orgs` · `Members` → relation   <!-- Members → [DB] Contacts; resolve page ids -->
  - `Status` → select          <!-- Active · Archived -->
  - `Notes` → text

### addresses  *(the [DB] Addresses database — blockchain accounts)*
- **data_source_id:** `39dd79b5-de38-8091-8617-000bd102afaa` *(live-verified 2026-07-14)*
- **policy standard:** `Addresses` + `Onchain Operations` in the `policy-standards` registry — verification, COI, signing rules
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
- **policy standard:** `Processes` in the `policy-standards` registry — the role directory's Fields table, Capabilities classification (Ops · Comms · Signer · Proposer · Executor · Attestor), roles-bind-to-directory rule
- **properties:**
  - `Name` → title
  - `Definition` · `Requirements` · `Training` → text
  - `Capabilities` → multi_select   <!-- Ops · Comms · Signer · Proposer · Executor; defined in the Processes policy -->
  - `Held by` → relation       <!-- → [DB] Contacts -->
  - `Processes` → relation      <!-- → [DB] Process Inventory (dual: its Related Roles), ADR-0043 -->
  - `Status` → select          <!-- Active · Retired -->
- Serves processes AND projects: the project roles (Steering · Stakeholder · Project
  Coordinator · Project Ops · Counterparty Contact) live here alongside process-execution
  roles; project-role semantics in the Projects policy standard, capabilities in the
  Processes policy.
### resources  *(the [DB] Resources database — external accounts, platforms, shared assets)*
- **data_source_id:** `315d79b5-de38-80a0-8940-000b21386424` *(live-verified 2026-07-14)*
- **policy standard:** `Resources` in the `policy-standards` registry — rules, D1 (naming), D2 (`Type` + `Access`), D3 (de-dup on provider + owning org), body shape, and the no-secrets rule
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

### docs  *(the [DB] Docs database — the team's shared documents and links)*
- **data_source_id:** `2abd79b5-de38-8075-a97b-000b24e99dc1` *(schema live-verified 2026-08-11; the prior 2026-07-15 full audit had drifted — see the Type/property corrections below. A full doc+mirror reconciliation is still owed.)*
- **policy standard:** `Docs` in the `policy-standards` registry — rules, D2 (Type), D3 (derived audience)
- **properties:**
  - `Name` → title            <!-- free-form per the policy's D1 -->
  - `Type` → select           <!-- 12 live options: Meeting Summary · Template · Research · Working Doc · SOP/Runbook · Tracker/Database · Report · Proposal · Reference/Dashboard · Spec · Forum Post · Process mapping. Assign per D2. `Guide` is NOT a live option (the mirror carried it until 2026-08-11) -->
  - `Category` → multi_select <!-- 17 live options, spelled OUT not abbreviated (e.g. "Distribution Rewards (DR)", "Monthly Settlement Cycle (MSC)", "Allocator Vault Parameters") — fetch live for the full list; definitions live in the Sky-context vocabulary -->
  - `Description` → text      <!-- one line: what the doc is and why it's kept -->
  - `Link` → url              <!-- required for external Reference/Dashboard docs -->
  - `Owner` · `Client Contact` · `Notify` → person   <!-- Notify: "people to notify about this note" — a person property, so it DOES ping -->
  - `Org` · `Related Projects` → relation   <!-- resolve target page ids first; Org is always set (policy) -->
  - `Parent item` · `Sub-item` → relation   <!-- self-relation, doc hierarchy; Parent item is limit-1 -->
  - `Tags` → multi_select     <!-- Forum post · To do · Meeting notes · Research · Decision; distinct axis from Type -->
- Meeting RECORDS (agendas, notes, transcripts) never enter this DB — they live in
  [DB] Meetings (target `meetings`). A meeting's derived SUMMARY is a doc of Type
  **`Meeting Summary`** (its own live option — NOT `Report`, which the mirror wrongly
  said until 2026-08-11), body from the registered `[Meeting Summary Template]`
  (page `39ed79b5de388058bb35e24d6c162c19`) — every topic names its Related project/deal —
  linked from the meeting row's `Related Docs` (Docs policy v0.4).
- This doc is the ONLY join between a meeting and a project: [DB] Meetings carries no
  Projects relation, so a meeting reaches its project as
  `meeting → Related Docs → doc (Meeting Summary) → Related Projects`. The join holds only
  where a summary was actually produced (observed 2026-08-11: five summaries existed against
  40+ meetings logged since 2026-07-14, so most meetings reach no project at all).

### calendar  *(the [DB] Calendar database — the standing-commitments registry)*
- **data_source_id:** `396d79b5-de38-8015-9843-000b38c8c6eb` *(live-verified 2026-07-15, schema created this wave)*
- **policy standard:** `Calendar` in the `policy-standards` registry — registry-not-mirror, D1 (Kind), D3 (join key)
- **properties:**
  - `Name` → title
  - `Kind` → select            <!-- Series · Event · Window; assign per D1 -->
  - `Status` → select          <!-- lifecycle: Active · Paused · Retired -->
  - `Date` → date              <!-- Events only; Series/Windows leave it empty -->
  - `Cadence` → text           <!-- descriptive `frequency · day · time timezone` (D2); Google holds the schedule of record -->
  - `Google Calendar` → select <!-- Sky Ecosystem · Ozone Internal Ops · Payments · Personal -->
  - `Google Event ID` → text   <!-- the sync join key (D3): the RECURRING event id, instance date-suffix stripped -->
  - `Owner` · `Participants` → person   <!-- workspace users only; external attendees in the body's Attendance -->
  - `Org` · `Project` · `Process` → relation   <!-- resolve target page ids first -->
- **page template:** `[Calendar Entry Template]` (row `39ed79b5de38815ca2f7c5fbd976cc49`) — body
  Purpose · Attendance · Links · Notes. DB-template registration is a pending UI step.

### update-feed  *(the [DB] Update Feed database — the org's typed update / decision / question feed)*
- **data_source_id:** `fd89fc28-7aa6-4cb8-85d0-9e81741b7302` *(live-verified 2026-07-15)*
- **policy standard:** `Projects` in the `policy-standards` registry — the Update Feed lives inside the project subject: the typed `Summary` grammars (Status · Decision · Question · Milestone), `Processed` semantics, and the rule that a project's Updates section is a live view of this feed, never hand-written prose
- **properties:**
  - `Update` → title           <!-- the headline -->
  - `Category` → select        <!-- Update · Status · Decision · Question · Milestone -->
  - `Date` → date
  - `Summary` → text           <!-- typed grammars per the Projects policy: Status = Done/In progress/At risk/Next; Decision = what - decided by - why; Question = question - owner - needed by -->
  - `Source` → url
  - `Processed` → checkbox     <!-- follow-ups done / question answered -->
  - `Visibility` → select      <!-- Internal · Agent · Public -->
  - `📁 [DB] Projects` → relation   <!-- the property name is LITERAL incl. emoji; resolve the target [DB] Projects row id first -->
- Registered templates: one per `Category` value — Status · Decision · Question · Update ·
  Milestone — each presetting `Category` + `Visibility` `Internal` with its Summary grammar
  as hint text; the legacy "Default Update" (page `317d79b5-de38-80aa-a6df-f5dd445ee1bb`)
  remains the DB default. A [DB] Projects row's Updates section is a live view of this
  feed filtered to that project.

> **Relations:** the create/update bindings write a relation as the TARGET page's id.
> Resolve it (search the related DB by name) before writing, or leave the relation empty
> and link it in a follow-up. Don't fabricate a page id.
> **Select/multi_select:** the value must be an EXISTING option — fetch the live schema
> and match; never invent an option name (a wrong one is rejected or silently creates junk).

### ai-inbox  *(the AI Inbox page — the user's private review feed; APPEND-ONLY)*
- **page id:** `39ed79b5-de38-80ea-b6f0-ff908935a32d` *(a page, not a database — insert_content at start, newest block first)*
- After a gated BATCH of record writes, one digest block is prepended:
  `## @<date> - Claude - <what was processed>`, one bullet per record written —
  an @-mention plus disposition (`new (owner)` / `updated: <what>`), a `Not created:`
  line for deliberately skipped items, and a `Source:` line @-mentioning the source
  record. Never edit or remove existing inbox content; the user clears it after review.

### drive  *(the org's shared Google Drives — a different store: the place-only drive binding)*
- **policy standard:** `Storage` in the `policy-standards` registry — rules, D1 (Home), D2 (external artifacts), archive-don't-delete, automation-places-humans-move
- **binding:** place-only — create, copy, or shortcut into a registered home, each
  write human-confirmed; moves, renames, and deletes are HUMAN acts (the Storage
  policy's operating rules). `/filing-a-drive-artifact` resolves homes here.
- **drive_id:** `0AGJtmqW6FUcLUk9PVA` — Sky Ecosystem Drive *(live-verified 2026-07-15)*
  - numbered taxonomy per the Storage policy's Home values; structure guide = Notion
    page `397d79b5de3880fb89f7e8381fcf147c`
  - `00 Internal Ops` → `1X6p43-KFbZ0SAJaR2ueA3xI1PaSir2X7`
    - `00.4 _Inbox` → `10IaqZ8SwNYemrtr7M55Iu1sC0u5iLLhi`  <!-- the unclear-case landing (D1) — the one subfolder the binding needs directly -->
  - `01 Governance Ops` → `1uePsygMpkkj22AukQeZa_bUPZtezUi87`
  - `02 Settlement & Payments` → `15wpQZnaPzb1dZENQGgL3PcSvnlrU3v_F`
  - `03 Rewards Primitives` → `1KOuIYRpTPDfW4atjhPE5FErKfQGtgz2t`
  - `04 Prime Agents` → `1DABXvgno75RcZJ34ZnJY9tgX4iclWN3d`
  - `05 Halos & Incubation` → `1h0JmEbPpi9c1JglwXMIO4rzW5ixCXd_T`
  - `06 Risk & Security` → `1vgpgxN8NhENPIB5plYdMYSSEDWFIvEIx`
  - `07 Products & Liquidity` → `1lkt2iVrXgPLVNfIZu3THlQajAmS1zomt`
  - `08 Ecosystem Entities & Vendors` → `1vbVLvQ7C2a7igftzXjZGnYm3haLOxXJq`
  - `09 Legal & Compliance` → `1TBIYoMsF_8rGTUzgI0bf_rQnC2bOMUVu`
  - `99 Archive` → `1XYtMV5IseVlY5nMpsTBylBtDoQjtY6qw`
- **drive_id:** `0AFnjsQZOSHcrUk9PVA` — Soter team internal drive *(live-verified 2026-07-15)*
  - top-level folders are live-listed (SOPs · Templates · Tooling · R&D · Branding ·
    Workshops · Audits · Forum Comms · Sky Coordination · Call Recordings); a
    numbered taxonomy for this drive is not defined (the Storage policy's worklist)
- **drive_id:** `0AAjt-Ie57CAqUk9PVA` — back office drive *(live-verified 2026-07-15)*
  - Invoices (YYYY/Month) · Legal & Agreements (NDAs · Proposals · Legal Templates) ·
    Job Descriptions; numbered taxonomy not defined
- Only top-level folders (plus `00.4 _Inbox`, the binding's direct landing) are
  mirrored here — `NN.N` workstream and Prime subfolder ids are resolved LIVE at
  filing time (a listing of the top-level folder), deliberately not mirrored: the
  subfolder set changes with the work and would rot here.
- The Home ↔ [DB] Docs `Category` correspondence is the D1 placement key — it lives in
  the Storage policy standard; a `Category` option change checks the policy and this
  section in the same change.
