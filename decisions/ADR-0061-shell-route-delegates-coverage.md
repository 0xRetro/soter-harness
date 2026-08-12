# ADR-0061: The shell route asks the same authority as the tool route

- **Status:** Accepted
- **Date:** 2026-08-12

## Context
ADR-0060 gated Notion writes at the MCP write tools, but the same API is a curl away and
that route was ungated — a gate implying coverage it did not have. Closing it raised a
second question the first ADR did not answer: what happens once a shell write is detected.
Refusing outright is simpler and keeps the kernel checker free of any tool-specific
dependency; asking the Soter plugin whether an approved proposal covers the write keeps one
approval meaning the same thing however the write is made.

## Decision
The shell clause asks the same authority the tool hook asks — `bb soter gate`, with the same
event shape — and treats any answer it cannot get as "not covered". An approved proposal
authorises the write, not the route it travels.

## Consequences
One approval semantics across both routes, and no approval logic duplicated in the harness:
the plugin stays the only thing that knows what was approved. The costs are accepted
deliberately. The kernel checker now shells out to `bb`, which is tool-specific coupling in a
piece meant to stay generic (`BB_CLI` is honoured, so the path is at least configurable).
When bb is unreachable — a sandboxed shell will do it — every Notion write is refused with a
gate error rather than an approval verdict; that is the safe direction, not a quiet one. And
the selftest asserts classification on the pure detector so no case depends on bb answering.

It buys no tightness over refusing outright: the gate matches record ids, not payloads, so an
approval for a record authorises any write to that record — identical to the tool route.

Revisit if the shell route is still unused by every publishing guide when the next external
store is gated, which would mean the delegation is carrying a case that never arrives.
