# ADR-0001: Port the sky-harness kernel; soter is its successor

- **Status:** Accepted
- **Date:** 2026-07-12

## Context
sky-harness built and self-tested a working kernel (molds, rubric, one checker,
artifact evals, forge, human gate) but its structure encodes an older model — three
flat kinds, systems as docs-only commentary. Rebuilding from scratch would redo
proven work; retrofitting sky in place would fight its own history and name.

## Decision
Copy sky-harness's kernel machinery into this repo wholesale and retrofit the soter
classification onto it. sky-harness's ADRs and research remain the design substrate
(read them there); soter's log starts fresh here.

## Consequences
Proven machinery (checker with plant-and-assert selftest, forge loop, eval
discipline) survives intact; sky's ADR numbers referenced in ported prose are
renumbered to soter's. Sky's "light, not heavy" doctrine carries over: prose over
code, one checker, meta-maintenance time is the failure signal. Revisit if the two
repos ever need to converge.
