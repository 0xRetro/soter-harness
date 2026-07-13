# Scratchpad

# LEXICON — Soter Harness

The single source of truth for what things are called and what they mean. Every piece uses
these terms; no synonyms (a harness about consistency is consistent about its own words).
This file starts with **the rule for classifying anything**, then defines the five building
concepts, then the shared vocabulary.

---

## The classification rule (the foundation)

**One principle:** separate *what* a thing is for from *how* it's delivered. Group by the
stable "what"; treat the "how" as a property. (Concern is stable and forkable; delivery
cross-cuts everything and changes when the platform changes — so coupling to Claude Code
stays quarantined in the "how.")

**Every piece is classified by four independent questions** — not one nested tree:

| # | Question | Answer is its… | Possible answers |
| --- | --- | --- | --- |
| 1 | Does it **run**, or is it an **artifact**? | **Kind** | Mechanism (runs on a trigger) · Component (read or executed) |
| 2 | What **form** does it take? | **Type** | *mechanism-types:* hook · skill · agent · command · script · *component-types:* content · logic · wiring · record |
| 3 | What **promise** does it serve, and who consumes it? | **System** | a concern (Template · Eval · Enforcement · …) |
| 4 | How **generic** is it? | **Layer** | Kernel · Core · Context · Automation |

**Decision procedure (so placement is mechanical, not a guess):**
1. Runs on a trigger? → **Mechanism**. Otherwise → **Component**.
2. Which form? → its **Type**.
3. What promise / who consumes it? → its **System**.
4. Would every user want it as-is? → its **Layer**.

**Grouping rule:** group pieces into systems **by concern (promise + consumer), never by
delivery-type.** ("Being a skill" is a delivery type, not a concern — filing by it would be
like filing documents by font instead of topic.) So there is no "Claude Code system": the
platform primitives are the **Type palette**, defined once (below), used by every system.

**Enforceable:** every piece declares `layer · system · kind · type` in frontmatter; the
checker validates the shape for its type and that the named system exists. Placement is
checked, not trusted.

---

## The five building concepts

Relationship in one line: a **Layer** contains **Systems**; a **System** owns **Mechanisms**
and the **Components** they use; **Concepts** are shared vocabulary referenced by all. A
Component has one home system but may be *used* across mechanisms/systems (shared by
reference, never re-owned).

### Layer — *how generic*
- **Purpose:** a tier of generality.
- **Test:** "Would every user want this exactly as-is?" Yes + required → **Kernel**. Yes +
  an added feature → **Core**. One org/purpose only → **Context**. Built *with* it →
  **Automation**.
- **Shape:** `layer:` frontmatter, one of the four.
- **Boundary:** the four are fixed and ordered; nothing sits between them.

| Layer | Meaning |
| --- | --- |
| **Kernel** | the *required* substrate that makes the harness run and self-build |
| **Core** | generic *features* built on the Kernel (still generic — no org specifics) |
| **Context** | specialization for one org/purpose (Sky first) — the fork/overlay |
| **Automation** | things built *with* the harness (workflows, jobs, the notebook) |

### System — *the concern*
- **Purpose:** a bounded concern — **one promise to a named consumer**. The unit you
  navigate, test, and fork as a whole.
- **Test:** "A distinct promise to a distinct consumer that some tool or reader treats as one
  unit?" No consumer → not a system yet.
- **Shape — the system card:** `name · promise · consumer · mechanisms · components · invariants`.
- **Boundary:** drawn at the promise/consumer seam; group by concern, never by delivery-type.
  Keep the count small (aim 3–8 per layer). Name a system only when real
  mechanisms/components exist to group — never a decreed empty slot.

### Mechanism — *the running capability*
- **Purpose:** a capability that **keeps a system's promise** by running — delivered *through*
  a Type primitive, *realized by* Components. A mechanism is not a file; it is the capability.
- **Test:** "Does it *do* something on a trigger (scaffold / check / author / select / ship)?"
- **Shape — the mechanism card:** `name · reads · produces · runs-when · invariants`.
- **Boundary:** one triggered behavior with one contract, inside one system. Reads nothing and
  produces nothing → it is misfiled content.

### Component — *the artifact*
- **Purpose:** the atom — one concrete artifact that is read or run.
- **Test:** "Is it a single file/dir doing one job?"
- **Shape:** frontmatter (`type · layer · system`) + a body matching its type's mold.
- **Boundary:** one artifact = one component; one home system; may be *used* by several
  mechanisms/systems (shared by reference).

### Concept — *the shared term*
- **Purpose:** a named idea in the vocabulary — defined **once**, referenced everywhere. Not a
  piece placed in a system; the dictionary itself.
- **Test:** "A term we must use consistently that isn't a Layer/System/Mechanism/Component?"
- **Shape:** `term → one-line definition` (+ banned synonyms in the alias table).
- **Boundary:** lives only here; prose points to it, never redefines it.

---

## The Type palettes (the "how")

Defined once; used by every system. A piece's `type` picks from the palette for its kind.

**Mechanism-types** (how a capability is delivered — the Claude Code primitives):
- **hook** — deterministic shell command at a lifecycle event (can block).
- **skill** — a `SKILL.md` capability, model- or user-invoked, progressively disclosed.
- **agent** — a subagent with isolated context, its own tools/prompt.
- **command** — a thin typeable shortcut over existing tools/skills.
- **script** — executable logic a hook or skill calls (never read into context).

**Component-types** (what an artifact is):
- **content** — read into context (rule, guide, template, rubric, strategy).
- **logic** — executed, not read (a script file).
- **wiring** — configuration that connects things (hooks.json, settings.json, plugin.json).
- **record** — a governance/evidence artifact (an ADR, an eval case).

---

## Concepts (the shared vocabulary)

<!-- Seed list — grow as real terms appear. -->

- **Promise / contract** — what a system guarantees its consumer; the seam that defines its
  boundary.
- **Consumer** — whatever *reads* a piece (a mechanism, the model, a human). No consumer, no
  reason to exist.
- **Mold** — the standard shape a component of a given type must wear (owned by the Template
  system).
- **Flex point** — a spot a procedure explicitly allows judgment, with stated bounds.
- **Degrees of freedom** — how prescriptive a step is: fragile/irreversible → exact;
  open-ended → heuristic.
- **Gate** — a deterministic checkpoint (verification, human review, or eval) a change passes.

## Aliases (do not use → use instead)

<!-- Machine-read by the checker. Grow only on real drift. -->

| Do not use | Use instead |
| --- | --- |
| module, engine | Mechanism |
| file, artifact (as a formal term) | Component |
| category (for a concern) | System |

# Readme
the soter harness is a claude code harness that establishes a standard, generic way to develop ai systems consistently across users and use cases. 

The soter harness is several layers and systems that compartmentalize the concerns and patterns to leverage AI across users consistently. They are build on observe best practices and features of claude code. 

first, the harness conceptually is designed as
kernel 
core 
context 
automations 

within these harness layers, each layer has defined systems, mechanisms, and components to achieve the desired consistencies and guidelines for enabling ai assistances and workflows. 

systems 
mechanisms 
components 
concepts 

each concept needs to have well defined schema, shape, boundaries, and purpose. That way it's clear and enforceable what context or concepts should live in each. this meta defining process is what allows complex ai workflows and confidence while keeping concepts and concerns well defined and understood across users and ai assistances or agents. 

Kernel layer
requires the template system 
template has mechansisms and components which the kernal layer uses. and other sytsems or mechanisms may also use ? 
evals is another kernal system 
same with hooks? how do we group these? 

**brainstorm map** 
**Kernel Layer (fundamental services?)** 
- template system
  - template mechanism 
    - template component 
      - template concepts 
- eval system
  - rubric mechanism
    - rubric components 
      - rubric concepts ex: degrees of freedom

- Claude Code Harness layer? (how do we know what to call this? how does the kernel boundaries and systems and things help make sure we properly and consistently define things? 
  - Hooks system? 
    - Hooks Components
      - Concepts 
      - Concepts
      - Concepts
  - Skills
  - Agents
  - Workflows
  - Configs
  - etc. 


# LEXICON

Harness Layer
- List of harness layers (example) 
  - soter-harness kernel layer 
    - claude-code harness system
      - hooks mechanism 
      - skill mechanism 
      - agent mechanism
        - agent file component 
      -  
  - soter-harness core layer
  - soter-harness context layer
  - soter-harness automation layer

System
- 

Mechanism 
- 

Component 
- 

Concept 
- 

