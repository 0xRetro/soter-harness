---
skill: auditing-a-schema-doc
case: targets-mirror-drift
passed: 234395a
---

## Try
"Run a schema audit for [DB] Tasks — make sure everything we have documenting that schema
is accurate."

## Expect (observable)
- the LIVE [DB] Tasks schema is fetched (never a cached/assumed one)
- the schema doc (the Tasks policy standard's Fields section) is diffed against it,
  field by field, option sets option-by-option
- the `tasks` entry in `.claude/skills/pushing-to-notion/targets.md` is diffed against
  the SAME live fetch — properties, option lists, relation targets, the live-verified stamp
- drift in either surface is reported; a mirror fix is proposed as a repo edit (branch),
  a doc fix as a gated Notion edit — the two are not conflated
- nothing is written (Notion) or committed (repo) without a human okay

## Never
- the targets.md mirror skipped because the Notion doc "already passed"
- a diff run against targets.md's recorded schema instead of the live fetch
- a Notion write or repo commit without the human okay
