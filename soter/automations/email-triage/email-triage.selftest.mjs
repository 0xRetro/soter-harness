import assert from 'node:assert/strict';
import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

export function assertPreparedEmailTriage({ work, derivedReview }) {
  assert.equal(work.state, 'ready-for-review');
  assert.equal(work.preview.kind, 'email-triage-review');
  assert.equal(work.approval.state, 'not-requested');
  assert.equal(work.continuationRequest, null);
  assert.equal(work.privacy.externalWritesPerformed, false);
  const window = work.preview.collections.find((collection) => {
    return collection.id === 'collection.email.window';
  });
  assert(window, 'Email review must expose one exact sanitized window collection.');
  assert.deepEqual(window.coverage, {
    complete: true,
    observedCount: 15,
    includedCount: 11,
    excludedCount: 4,
    exclusions: [
      { reasonCode: 'NO_ACTIVE_INBOX_MESSAGE_REMOVED', count: 1 },
      { reasonCode: 'RFC822_ALIAS_DUPLICATE_REMOVED', count: 1 },
      { reasonCode: 'SELF_SENT_ONLY_REMOVED', count: 1 },
      { reasonCode: 'ALREADY_TRIAGED_NO_NEWER_REMOVED', count: 1 }
    ]
  });
  assert.equal(window.rows.length, 10);
  assert.equal(window.rows.reduce((sum, row) => sum + row.representedCount, 0), 11);
  assert.equal(new Set(window.rows.map((row) => row.id)).size, window.rows.length);
  assert.deepEqual(window.rows.map((row) => row.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert(window.rows.some((row) => {
    return row.group === 'notifications'
      && row.disposition === 'collapsed'
      && row.representedCount === 2
      && row.flags.includes('ACTIONABLE_FAILURE')
      && row.flags.includes('CALENDAR_RESPONSE_ACCEPTED');
  }));
  const injectionRow = window.rows.find((row) => row.flags.includes('SUSPECTED_PROMPT_INJECTION'));
  assert(injectionRow);
  assert(injectionRow.actions.every((action) => action.state !== 'proposed'));
  assert(injectionRow.actions.some((action) => {
    return action.reasonCode === 'SUSPECTED_INJECTION_REQUIRES_HUMAN_REVIEW'
      && action.capability === null;
  }));
  assert(window.rows.some((row) => row.flags.includes('ARCHIVED_OR_TRASH_SIBLING_IGNORED')));
  assert(window.rows.some((row) => {
    return row.group === 'marketing' && row.flags.includes('PROVIDER_IMPORTANT_IGNORED');
  }));
  const actions = window.rows.flatMap((row) => row.actions);
  assert(actions.every((action) => action.capability === null
    || ['mail.labels.apply', 'mail.drafts.create'].includes(action.capability)));
  assert(!actions.some((action) => action.effect === 'dispatch' && action.state === 'proposed'));
  assert(work.preview.collections.flatMap((collection) => collection.rows)
    .flatMap((row) => row.actions)
    .some((action) => action.reasonCode === 'EMAIL_SEND_PROHIBITED'));
  assert.equal(work.preview.proposedChanges.filter((change) => {
    return change.effect === 'mail.drafts.create';
  }).length, 1);
  assert(work.preview.proposedChanges.every((change) => {
    return ['mail.labels.apply', 'mail.drafts.create'].includes(change.effect)
      && change.beforeFingerprint === null
      && /^sha256:[a-f0-9]{64}$/.test(change.afterFingerprint);
  }));
  assert(actions.filter((action) => action.state === 'proposed').every((action) => {
    const change = work.preview.proposedChanges.find((candidate) => candidate.id === action.id);
    return change && action.changeFingerprint === fingerprintJson(change);
  }));
  assert.equal(work.preview.privateReview.state, 'available');
  assert.equal(derivedReview.$contract, 'soter://contracts/prepared-work-derived-review-material/v1');
  assert.equal(derivedReview.contentFingerprint, work.preview.privateReview.contentFingerprint);
  assert(derivedReview.items.some((item) => item.kind === 'draft'
    && item.fields.some((field) => field.id === 'body')
    && item.fields.some((field) => field.id === 'replyMessageId')));
  assert(derivedReview.items.filter((item) => item.kind === 'label').every((item) => {
    const messageIds = item.fields.find((field) => field.id === 'messageIds');
    const labelName = item.fields.find((field) => field.id === 'labelName');
    return Array.isArray(messageIds?.reviewValue)
      && messageIds.reviewValue.length >= 1
      && messageIds.reviewValue.every((id) => typeof id === 'string' && id.startsWith('m'))
      && typeof labelName?.reviewValue === 'string'
      && labelName.reviewValue.startsWith('AI/')
      && !item.fields.some((field) => field.id === 'subjectReferences');
  }));
  assert(derivedReview.items.some((item) => item.kind === 'digest'
    && item.fields.some((field) => field.id === 'body')));
  assert(derivedReview.items.some((item) => item.kind === 'meeting-handoff'));
  assert(derivedReview.items.some((item) => item.kind === 'calendar-handoff'));
  const serializedPrivate = JSON.stringify(derivedReview);
  assert(!/RAW_[A-Z0-9_]*BODY_SENTINEL|HOSTILE_RAW_BODY_SENTINEL/.test(serializedPrivate),
    'Raw mail bodies reached normalized private derived review.');
  assert(!serializedPrivate.includes('Legal/Approved'));
  assert(!serializedPrivate.includes('approve invoice 77'));
  assert(!serializedPrivate.includes('forward report 4242'));
  assert(!serializedPrivate.includes('RAW_SELF_SENT_BODY_SENTINEL'));
  assert(!serializedPrivate.includes('RAW_ALIAS_DUPLICATE_BODY_SENTINEL'));
  assert(!serializedPrivate.includes('RAW_TRASH_ONLY_BODY_SENTINEL'));
  return true;
}
