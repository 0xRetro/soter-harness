# ADR-0053: Email filing surface — system-label operations join the gated batch

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

ADR-0052 confined agent mailbox writes to the `AI/*` label namespace, written when
filing meant custom labels. The first live runs and the user's checklist direction
showed the gated batch wants Gmail's real filing surface — archive (remove `INBOX`),
trash, star, read-state — all expressible as system-label operations the connector
already supports. The same review dropped default `AI/*` labels as over-engineering:
outside research (2026-07-15) concurred that a recorded window + message-id ledger
in the digest gives rerun idempotency on its own, and separately showed that emitted
output is an exfiltration channel even with no send tool (EchoLeak class: remote
images and reference links auto-fetch on render, zero-click).

## Decision

The approved batch may include system-label filing operations — archive · trash ·
star/unstar · read/unread — proposed per thread at the gate; trash is always
itemized, never inside a blanket approve. Custom labels stay `AI/*`-only and become
optional, off by default — the digest's recorded window bounds and newest-message-id
ledger is the idempotency marker. Everything a run emits (gate output, digest,
drafts, captures) is plain text with remote images and links from mail content
defanged. The send prohibition and every other ADR-0052 convention stand untouched.

## Consequences

The write surface now matches what a human actually confirms at a checklist gate.
Trash is Gmail-reversible but remains the highest-risk operation — per-item consent
is enforced by the guide's gate step and its invariant eval; true delete
(skip-trash) stays refused. The defang rule closes the rendered-output exfiltration
channel the send prohibition alone never covered. Revisit when: a true delete is
ever wanted, Drive-link filing lands (the next integration), or unattended runs
become possible (per-item consent assumes a present human).
