# ADR-0012: The harness holds all four layers; genericness is per-piece

- **Status:** Accepted
- **Date:** 2026-07-12

## Context
The founding rule said "NEVER add org- or tool-specific content to this repo — it
stays generic; specifics live in a downstream overlay." But the goal is a modular
system that is expandable and integrates across layers: context (org-specific) and
automation (vendor-specific, e.g. pushing to Notion) pieces that stack on the kernel
and reuse the same classification, molds, checker, and lexicon. Splitting them into a
separate disconnected repo breaks that integration.

## Decision
The harness holds all four layers in one repo. Genericness is a property of each
**piece** (its `layer`), not of the whole repo: kernel and core pieces are generic;
context and automation pieces may be org- or vendor-specific. They are **add-ons** —
modular bundles that reuse the kernel's molds, frontmatter, checker, and lexicon, so
adding one grows the lexicon the same way a kernel piece does. Only kernel + core
pieces export as the generic plugin; context + automation are extractable later.

## Consequences
Supersedes the "no org-specific content here" stance in CLAUDE.md (reworded to
"generic pieces stay generic; specifics are declared `layer: context|automation`").
The checker already accepts all four layer values, so cross-layer pieces validate
today. The generic-export boundary (which pieces ship in the base plugin) becomes a
packaging concern for the deferred distribution decision. Revisit if a context/
automation add-on ever needs to physically live in its own repo.
