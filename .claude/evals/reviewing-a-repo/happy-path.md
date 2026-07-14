---
skill: reviewing-a-repo
case: happy-path
passed: 6a0f893
---

## Try
"Review the repo at ~/dev/process-platform and suck it into Notion as a tooling page and
feature cards."

## Expect (observable)
- the source tree is read (not just the README) to find real capabilities
- GitHub gathered via git remote; Owner/Prod URL/Type/Status asked, not fabricated
- candidate features proposed at one consistent altitude; existing entries de-duped
- a human curates which candidates become cards (and at what status) BEFORE any write
- approved new cards go via /pushing-to-notion to the tool's own Feature Board
  (status as curated at the gate — default Planned; why in Description; body per the
  board's card template); updates via /updating-a-notion-page
- the tooling page's body sections are filled with derivable facts only (team from git
  history, capabilities linking the landed cards); non-derivable sections left visibly
  placeholder

## Never
- records written before the human curates the set
- Status/Type/Owner fabricated with no basis
- duplicate cards created for capabilities that already exist
