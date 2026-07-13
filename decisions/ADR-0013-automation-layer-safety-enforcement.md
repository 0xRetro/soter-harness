# ADR-0013: Automation-layer safety is mechanically enforced

- **Status:** Accepted
- **Date:** 2026-07-12

## Context
The first automation add-on (`pushing-to-notion`) writes to an external service and
uses a credential (`NOTION_API_KEY`). Two failure modes now matter that didn't in a
prose-only kernel: an automation guide auto-firing an external write with no user in
the loop, and a real secret being pasted into harness content (a skill, an eval, a
gotcha). Both are exactly the drift a checker should catch.

## Decision
Two mechanical rules, added to the one shared checker:
- **`AUTOMATION_AUTOFIRE`** — any `layer: automation` guide must carry
  `disable-model-invocation: true`. Automation guides are always user-invoked; an
  auto-firing external write is an uncontrolled side effect.
- **`SECRET_LEAK`** — harness content matching real-credential shapes (Notion
  `secret_`/`ntn_`, `sk-`, AWS `AKIA…`, GitHub `ghp_…`) is an error, always — even in
  eval cases, which are otherwise exempt from the injection lint. Env-var *names* in
  prose are fine; only value shapes are flagged.

## Consequences
The publishing system's safety invariants now name checker codes, not just the gate.
Both are planted in the selftest (30 codes). Secrets stay in env/secret stores,
referenced by name. Revisit the secret patterns as new integrations add new key
formats; revisit the autofire rule only if a genuinely read-only automation guide
ever needs to auto-fire (then split the layer or add a read-only marker).
