# ADR-0030: The org–harness boundary is bidirectional

- **Status:** Proposed
- **Date:** 2026-07-14

## Context
The same boundary failed in both directions in one day. First, harness upkeep (a schema
audit sweep) was nearly registered in the org's Process Inventory as if it were org work
(rejected; ADR-0029). Then the corrective fix nearly wrote harness vocabulary and an ADR
reference into the org's Processes policy doc — an org-facing document operators read,
which should not expose the machinery that maintains it. The boundary existed only in
the human's head; nothing written stated either direction.

## Decision
The boundary holds both ways. Harness self-maintenance never enters org registries
(ADR-0029). Org-facing external content — records, policy docs, process bodies — speaks
the org's language: no ADR numbers, checker codes, guide or file names, or harness
vocabulary, unless the human explicitly allows it for that doc's purpose. Boundary and
machinery rules are recorded in the harness (standards, rules, ADRs), never in org docs;
where an org doc needs an exclusion, it is phrased in org terms.

## Consequences
The Processes policy needs no harness-flavored scope line; an org-language exclusion
(e.g. internal tooling routines are not registered) remains available, human-gated.
Existing docs that already name harness pieces (a Linked Processes entry reading
"capturing-a-task (harness guide)") are a cleanup worklist reconciled through the normal
gates. Cost: Enforced-by lines in policy docs must name org-visible channels, which can
mean vaguer wording than a harness reference. Revisit trigger: the org adopting the
harness as an org-visible system of record — then references may be explicitly allowed
per doc.
