---
name: authoring
layer: kernel
system: authoring
kind: component
mold: house-rule
---

# Authoring harness pieces

Applies whenever creating or editing rules, guides, standards, molds, or evals.

- ALWAYS fill every required section of the mold; delete all hints from the
  finished piece.
- ALWAYS declare classification frontmatter (`layer · system · kind · mold`) on
  durable content pieces.
- ALWAYS write descriptions in third person stating what it does AND when to use it,
  with the trigger words a user would actually say; NEVER summarize the piece's steps
  in the description (agents follow the summary instead of reading the body).
- ALWAYS mark judgment spots in steps with `FLEX:` and state the bounds; make
  fragile/irreversible steps exact (commands or check rules, not prose).
- ALWAYS check neighboring guides' exclusion clauses — no two pieces may both claim
  (or both reject) the same territory.
- ALWAYS record failure modes you actually observed in the piece's Gotchas section.
- ALWAYS land a human correction as a durable artifact an agent will re-encounter (a
  gotcha, a policy scope line, a check rule, or an ADR) — an uncaptured correction recurs.
- NEVER include time-sensitive content (dates, versions, "currently") in a piece;
  point to where the live fact lives instead. Provenance stamps are the exception —
  a gotcha's or live-verification's date marks its EVIDENCE, not the content.
- NEVER name a piece `helper`, `utils`, or another vague word; use lowercase-hyphenated,
  gerund-preferred names (`reviewing-prs`).
- NEVER put a real credential (API key, token, secret) in any piece — reference the env
  var NAME instead (e.g. `NOTION_API_KEY`). Credentials live in env/secret stores only,
  never in git. Enforced by the checker's `SECRET_LEAK`.
- Forge-authored pieces ALWAYS land staged first — user-invoke-only until promoted
  (guide-index entry; auto-invocation only ever for read-only guides) after real use
  (ADR-0005, `/promoting-pieces`).
- A staged piece still governs when the user explicitly asks for its work: read its
  SKILL.md and follow it. The flag gates auto-invocation, not user-requested work —
  the Skill tool refusing a `disable-model-invocation` piece is by design, not a
  dead end (observed: sessions hitting the refusal re-derived this or improvised).
- Guides ALWAYS include at least one pressure eval case (realistic stakes; ADR-0006).
- ALWAYS re-run a guide's affected eval cases after editing its steps and record the
  new pass (`passed: <sha>`) — goldens are the regression baseline; a golden that
  stops passing never merges.
- NEVER document an external system's shape from a template or a single example —
  survey several live instances first (live is the source of truth, ADR-0016; a
  template shows the starting shape, not what instances became).

Why: see `decisions/ADR-0002`, `ADR-0003`, `ADR-0005`, `ADR-0006`, `ADR-0016` and `.claude/RUBRIC.md`.
