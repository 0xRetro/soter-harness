# Soter Harness

A **Claude Code harness** — a standard, generic way to develop AI systems and workflows
consistently across users and use cases. It turns the concerns and patterns of working with
AI into well-defined, enforceable pieces, built on Claude Code's native features.

## The shape

The harness is built in four **layers** of generality:

| Layer | What it is |
|---|---|
| **Kernel** | the required substrate that makes the harness run and self-build |
| **Core** | generic features built on the Kernel (still generic — no org specifics) |
| **Context** | specialization for one org/purpose (the fork/overlay) |
| **Automation** | things built *with* the harness (workflows, jobs) |

Within the layers, every piece is classified by four independent questions — its **Kind**
(Mechanism that runs vs Component that's read), **Type** (hook/skill/agent/… or
content/logic/…), **System** (the concern it serves), and **Layer** (how generic). The rule:
*group by concern, never by delivery.*

The full classification rule and vocabulary live in the **LEXICON** (currently in
[`scratchpad.md`](scratchpad.md) alongside working notes — to be split into proper docs as
we build).

## Status

Bootstrapping. Next up: the **Template system** — the molds every other piece is built from.
