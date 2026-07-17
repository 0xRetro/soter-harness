---
name: filing-a-drive-artifact
description: >-
  Files one artifact — a file or shortcut — into the org's shared Google Drives per
  the live Storage policy: home determined, placement prepared (or executed with
  confirmation where tools allow), moves left to humans, and the [DB] Docs index row
  created through the bindings. Use to file, save, shortcut, index, or archive
  something into Drive, or to triage drive-root strays. Not for choosing what the org
  keeps (the human's call), bulk drive reorganization (human moves), the Notion write
  mechanics (/pushing-to-notion, /updating-a-notion-page), or shaping doc records
  (the Docs policy governs those).
disable-model-invocation: true
layer: automation
system: publishing
kind: component
mold: how-to-guide
---

# Filing a drive artifact

## Goal
One artifact sits in its policy-determined home (or the human holds exact move
instructions), with one [DB] Docs index row linking it — placement per the live
Storage policy, every external write human-confirmed, nothing moved, renamed, or
deleted by automation.

## Use when / don't use when
- Use when: filing a file or shortcut into the org's shared drives — a new artifact,
  a shared-with-me item worth keeping, or a stray found where it doesn't belong.
- Not for: deciding what the org keeps or discards (the human's call); bulk drive
  reorganization (human moves, planned in chat); the Notion write mechanics
  (`/pushing-to-notion`, `/updating-a-notion-page`); shaping the doc record itself
  (the Docs policy standard governs it); non-Drive stores (a different binding).

## Steps
1. **Fetch the governing rules live.** The Storage policy standard (registry target
   `policy-standards`) and the `drive` section of the target registry (`targets.md`,
   drive + folder ids). Never place from a remembered taxonomy — the live policy and
   registry are the source of truth.
2. **Establish the artifact.** What it is (file · folder · shortcut), where it lives
   now, who owns it (org or external), and what it is about. An artifact the org
   isn't keeping is not filed — discard/ignore is the human's call, outside this guide.
3. **Determine the home — the policy's D1.** Drive by audience; top-level folder by
   the subject-area ↔ [DB] Docs `Category` correspondence; the workstream (`NN.N`) or
   Prime-skeleton subfolder when the material is specific. FLEX: the subject-area
   judgment — bounded by: defensible from the policy's D1 and the registered
   structure guide, alternatives flagged at the gate; genuinely unclear → the
   registered inbox folder, never a new or improvised folder.
4. **Determine the form — the policy's D2.** Externally-owned → a shortcut into the
   home (the shortcut IS the filed presence; the original stays put). A copy only
   when a frozen snapshot matters (signed, settled, submitted). Org-owned new
   content → the file itself in the home.
5. **Split the acts.** Automation may PLACE — create, copy, or shortcut into the
   home, each write human-confirmed. Moving, renaming, or deleting an existing
   artifact is a HUMAN act: prepare exact instructions (source, destination folder
   name + id, any rename) instead of acting. Never simulate a move — copy-then-abandon
   breaks the one-home rule and leaves the original violation standing.
6. **Prepare the index row.** One [DB] Docs row per kept artifact (the Storage
   policy's index rule), shaped per the Docs policy through
   `writing-records-to-notion`: de-dup on Link + Name first; Link = the Drive URL;
   Org resolved to a real page id; Owner is required-but-human — evidence it or flag
   it, never guess; `Type` and `Category` matched to live options with gaps flagged,
   never invented; Related Projects only when evidenced.
7. **One gate, then write.** Present the complete filing plan — placements,
   human-move instructions, index rows — for one explicit okay (a batch compresses
   to one confirm, never to zero). Writes go through the bindings; then the
   `ai-inbox` digest per `writing-records-to-notion`.
8. **Verify.** The artifact is in its home (name the folder id) or the human holds
   the exact move instructions; the Docs row exists with Link set (name the page id);
   no duplicate row. Residue — unindexed siblings, taxonomy gaps — is reported as
   follow-up work, never written in this run.

## Gotchas
- (baseline 2026-07-15, GREEN) A fresh unguided agent filed both live root-strays
  correctly from the Notion policy alone — D1 placement with alternatives flagged,
  D2 form, the human-move split quoted, spine-compliant rows, all writes held. This
  guide landed anyway by explicit user decision (the email-wave precedent; a sixth
  green refusal was the alternative) to codify the spine as the drive binding grows
  toward automation-side placement. Promotion must weigh that GREEN.
- (live 2026-07-15) The Drive toolset has create/copy/read but NO move, rename,
  delete, or permission writes — a "move" is only ever prepared for a human; working
  around it with copy-then-abandon duplicates the artifact and violates one-home
  (step 5 exists for this temptation).
- (live 2026-07-15) Root drift is real — two shortcuts sat at the Sky drive root
  within a week of its reorg. Filing triage recurs; shortcuts are never deleted in
  the process (a Storage policy data rule).

## Evals
- `.claude/evals/filing-a-drive-artifact/happy-path.md`
- `.claude/evals/filing-a-drive-artifact/pressure-urgent-move.md`
- `.claude/evals/filing-a-drive-artifact/invariant-no-invented-home.md`
