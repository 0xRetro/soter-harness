---
name: rubric
layer: kernel
system: standards
kind: component
mold: singleton
---

# The Rubric — quality bar for every harness piece

The checklist every new or changed piece (guide, rule, standard, mold) must clear
before merging. Adapted from Anthropic's skill-authoring best practices. Used three ways:
**authors** follow it while writing (the forge includes it), **reviewers** check it on
PRs, and the **checker** enforces the ⚙-marked items mechanically.

## Core quality

- [ ] **Right classification.** The piece declares `layer · system · kind · mold` per
      `.claude/LEXICON.md`'s classification rule. ⚙ Shape is mechanically checked for
      molds, system cards, and eval cases; for guides/rules/standards the checker verifies
      the shape-critical parts (frontmatter, exclusion clause, budgets) and the rest is a
      reviewer check.
- [ ] **Concise.** Every sentence justifies its token cost. Claude is already smart —
      explain what's *specific to us*, not what it already knows.
- [ ] **Says when.** The description states *what this does* AND *when to use it*, in
      third person, with the trigger words a user would actually say — and **never
      summarizes the steps** (agents follow the summary instead of the body). ⚙ (presence)
- [ ] **Earned its existence.** For guides: a baseline (RED) run showed an agent failing
      *without* the piece, and the piece counters the observed rationalizations
      (forge "Baseline" step).
- [ ] **Says when NOT.** Includes an exclusion clause — what this piece does *not* cover —
      and no other piece claims the same territory.
- [ ] **One term per concept.** Uses the LEXICON's terms; never introduces a synonym for
      an existing concept. ⚙ (lint against known aliases)
- [ ] **No time-sensitive content.** Nothing that silently goes stale (dates, versions,
      "currently"); durable facts only, or a pointer to where the live fact lives.
- [ ] **Right degrees of freedom.** Fragile/irreversible steps → exact instructions or a
      script. Open-ended steps → heuristics. Judgment spots marked `FLEX:` with bounds.

## Structure & budgets ⚙ (all mechanical)

- [ ] Guide (SKILL.md) body **< 500 lines**; reference files **one level deep** only.
- [ ] Description **≤ 1024 chars**, no XML tags (spec limits). Total all-skill
      descriptions lean (listing budget ≈1% of context; over it, *least-used* guides'
      descriptions get dropped — rare-but-critical guides are the casualty).
- [ ] `CLAUDE.md` stays **< 200 lines** (if this change touches it).
- [ ] Required frontmatter present for its type (see `.claude/templates/`).
- [ ] Name: lowercase-hyphenated ≤64 chars, gerund preferred (`reviewing-prs`); never
      `helper`/`utils`; never the reserved words claude/anthropic.
- [ ] No zero-width characters or injection phrasing in harness content (security lint).
- [ ] Every internal link resolves — no dead cross-references. ⚙ (`LINK_BROKEN`)

## Testing

- [ ] **≥ 3 eval cases** exist for any guide (see `.claude/templates/eval-case.md`). ⚙ (count)
- [ ] **Auto-invocable guides have a should-NOT-trigger case** (near-miss that must not
      fire) — the executable form of the exclusion clause. ⚙
- [ ] **At least one eval case is a pressure case** — a realistic-stakes scenario that
      tempts the agent to skip the guide ("prod is down, improvise?"). Polite tests lie;
      guides must survive pressure (ADR-0006).
- [ ] Existing goldens still pass (regression) — an edit to one piece must not break others.
- [ ] If forge-authored: pressure-tested by a fresh-context subagent before review; lands
      **staged** (user-invoke-only), promoted only after real use.

## Review hygiene

- [ ] Rationale that future-us will need is in an ADR (`decisions/`), not inlined here.
- [ ] Known gotchas observed during authoring/testing are recorded in the piece's
      Gotchas section — that's where hard-won knowledge accrues.
