---
name: platform
layer: kernel
system: platform
kind: component
mold: system-card
---

# System: platform

## Promise
The platform's (claude-code's) primitives are understood and used ONE way, and all
platform coupling is quarantined here — every other system stays portable.
Consumers: mechanism authors (which form to use), any future platform swap (the
coupling inventory).

## Mechanisms
None yet — this system defines forms and owns wiring; concrete hooks/skills/agents
are mechanisms OF the systems that use them.

## Components
- `.claude/settings.json` — in-repo wiring (Bash guard + Write|Edit ADR-immutability
  guard + checker hook + turn gate + post-compaction re-grounding (SessionStart,
  matcher `compact`, ADR-0055) + the checker-command permissions allow; event log
  retired, ADR-0037)
- `.claude/hooks/hooks.json` — plugin-shipped wiring, always at parity with
  settings.json: same guards, checker hook, turn gate, and re-grounding (ADR-0034)
- `.claude/.claude-plugin/plugin.json` — the plugin manifest (the `.claude/` dir IS the
  plugin); carries no version while the harness is internal — every commit ships (ADR-0034).
  Declares plugin DEPENDENCIES for MCP servers that have an official plugin (notion, slack
  @ claude-plugins-official) — depending, not bundling, keeps tool names stable
  (`mcp__plugin_Notion_notion__*`); cross-marketplace resolution needs an
  `allowCrossMarketplaceDependenciesOn` entry when a marketplace exists (distribution work).
- `.claude/.mcp.json` — plugin-shipped MCP servers with NO official plugin (otter:
  `https://mcp.otter.ai/mcp`, per-user OAuth at first use — no credential ships; the
  meeting pipeline depends on it, ADR-0051).
  **MCP coupling inventory** — every MCP server the harness leans on, and where its
  wiring lives: notion (publishing bindings · ingestion · schema-audit · every capture
  flow) and slack (ingesting-slack-channels · eval-runner reads) via plugin
  dependencies; otter (meeting transcripts) via `.mcp.json`. The pattern for adding
  one: official plugin exists → declare a dependency; otherwise → add to `.mcp.json`;
  either way it is listed HERE. Route-qualified tool names
  (`mcp__plugin_<plugin>_<server>__<tool>`) may appear ONLY in agent allowlists
  (eval-runner) and permission rules — never in guide or standard prose — and must be
  re-derived if a server's delivery route changes (allowlists fail closed).
  One server may arrive by MORE THAN ONE route depending on the host embedding
  claude-code: a plugin dependency delivers `mcp__plugin_<plugin>_<server>__*`, a
  claude.ai connector delivers `mcp__claude_ai_<Server>__*`. An allowlist therefore
  enumerates EVERY route it must work under, not the route of the host that authored
  it (observed 2026-08-11: eval-runner listed the plugin route only and was silently
  store-blind under a host delivering the connector route — `claude mcp list` showed
  the server "Connected", which is about the SERVER, not about the tool name an
  allowlist has to match).
- `.claude/rules/parallel-sessions.md` — the multi-session operating rule: one
  environment = one branch holding at most one WRITING session; dispatched agents
  get their own; root checkout parked on main; plus the shared-live-state half —
  compare-and-set token where a store offers one, fetch-merge-write where it does
  not, claim-and-search on append-only queues (ADR-0027, ADR-0030, ADR-0062)
- `.bb/AGENTS.md` — the provider-neutral instruction pointer bb injects into every
  thread in this workspace (`<workspace>/.bb/AGENTS.md`, all providers, tracked so
  fresh worktrees carry it). Holds no rules of its own; points at CLAUDE.md,
  `.claude/rules/` and the RUBRIC, so a codex session reaches them (ADR-0062)
- per-primitive usage standards — authored via the forge ONLY on an observed RED
  baseline. Hooks evaluated 2026-07-14: baseline GREEN — a fresh agent wired a new
  guard correctly from the existing rules, cards, and checker precedents alone, so
  no standard was authored (forge step 4; the baseline's product landed as the ADR
  immutability guard, ADR-0044). Re-propose only on an observed hook-authoring failure.

## Concepts
hook · skill · agent · command · script · worktree · environment · subagent ·
session · guide

## Invariants
- physical layout is platform-shaped (`.claude/skills/` etc.); a piece's system is
  declared in frontmatter, never implied by its folder — enforcer: checker `FM_CLASS`
- wiring changes pass `claude plugin validate` — enforcer: CI plugin job
- plugin wiring ships every in-repo hook and nothing more — enforcer: checker `HOOK_PARITY`
- no other system's content references claude-code specifics beyond the type names —
  enforcer: checker `PLATFORM_COUPLING` (token scan of every non-platform piece;
  exemption by declared `system: platform`, never by folder)
