---
name: eval
layer: kernel
system: eval
kind: component
mold: system-card
---

# System: eval

## Promise
Every piece proves it was needed (a watched baseline failure) and holds up under
pressure — polite tests lie. Consumers: the forge (steps), the gate (evidence),
CI (regression).

## Mechanisms
- **baseline** — reads: the pressure scenario · produces: recorded failure evidence
  WITHOUT the piece (the rationalizations to counter) · runs-when: forge step
  "Baseline (RED)", before drafting · invariants: no observed failure → the piece
  may not be needed; stop.
- **pressure-test** — reads: the draft + the pressure scenario only (never the
  drafting conversation) · produces: a used-and-complied verdict from artifacts ·
  runs-when: forge step "Pressure-test", before the gate · invariants: fresh-context
  subagent; verdict from artifacts, never self-report.
- **running-evals** — reads: a case's Try (the agent's input) and Expect/Never (the
  judge's checklist, never the agent's) · produces: a verdict from artifacts and, on a
  pass, a recorded golden · runs-when: a user invokes `/running-evals` (after step
  edits, at forge baseline/pressure-test time, or to record goldens) · invariants:
  neutral dispatch prompt (no expectations); scenario agents run as the write-contained
  `eval-runner`; verdicts never rest on self-report (ADR-0027).

## Components
- `.claude/evals/` — eval cases, one folder per guide: data, ≥3 per guide incl. a pressure case
- `.claude/evals/logs/` — the event log: one JSON line per TOOL CALL (`ts·tool·file·cmd`),
  gitignored, self-rotating at 2MB. It is tool-trace evidence for a future eval runner —
  NOT skill-use counting (a PostToolUse hook can't attribute a call to a guide), so it
  cannot establish the promotion use-floor; that stays git-history + gotcha growth.
- `.claude/evals/README.md` — how cases run today (points at `running-evals` for the how)
- `.claude/skills/running-evals/SKILL.md` — the run-and-judge guide (staged)
- `.claude/agents/eval-runner.md` — the write-contained scenario agent definition
  (platform agent-def frontmatter, so classified here on its owning card, like scripts)

## Concepts
baseline · pressure case · golden · eval case · meta-case

## Invariants
- ≥3 cases per guide, one a pressure case — enforcer: checker `EVALS_MIN` + `PRESSURE_MISSING`
- auto-invocable guides have a should-NOT-trigger case — enforcer: checker `TRIGGER_EVAL_MISSING`
- cases are data; any runner may execute them — `unenforced: recorded in ADR-0006`
