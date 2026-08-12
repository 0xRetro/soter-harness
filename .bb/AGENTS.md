# Soter Harness — instructions for every provider

bb injects this file into every session in this workspace, whatever the provider.
It holds no rules of its own — it points at the ones that already exist, so there
is nothing here to keep in sync.

Before doing any work in this repo, read:

- `CLAUDE.md` — the Always/Never list, the guide index, and the layout. The entry
  point: read it first and in full.
- `.claude/rules/` — the always-on rules (`authoring.md`, `parallel-sessions.md`).
  They govern every session, not only claude-code ones.
- `.claude/RUBRIC.md` — the quality bar every new or changed piece must pass.

Check anything with `node .claude/scripts/check.mjs --all`.
