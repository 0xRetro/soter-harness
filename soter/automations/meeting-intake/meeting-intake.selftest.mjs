import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { buildMeetingIntakeReview } from './proposal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const crm = readJson(path.join(root, 'soter/fixtures/providers/notion/workspace-records.json')).data;
const transcript = readJson(path.join(root, 'soter/fixtures/providers/otter/transcripts.json'))
  .data.transcripts[0];
const meeting = crm.records.find((record) => record.type === 'meeting');
const project = crm.records.find((record) => record.id === 'soter-fixture://projects/project/launch');
const task = crm.records.find((record) => record.id === 'soter-fixture://tasks/task/existing-deck');
const derivedReviewDefinition = readJson(path.join(
  root,
  'soter/automations/meeting-intake/derived-review.json'
));
const untrustedActionItem = 'PROVIDER_ACTION_ITEM_MUST_NOT_CREATE_TASK_OR_COMMITMENT';
const untrustedParticipantEmail = 'provider-calendar-pairing-must-not-be-identity@example.test';

const snapshot = {
  entries: [
    {
      subject: 'meeting.transcript',
      value: {
        ...structuredClone(transcript),
        calendar_participants: [{ name: 'Wrongly paired participant', email: untrustedParticipantEmail }],
        action_items: [{ text: untrustedActionItem, assignee: 'Wrong participant' }]
      }
    },
    { value: { records: [meeting, project, task] } }
  ]
};
const decision = {
  state: 'ready',
  context: { snapshotId: 'context.meeting-intake.selftest' },
  payload: {
    meeting: { recordId: meeting.id, recordFingerprint: fingerprintJson(meeting), ageDays: 5, ageState: 'current' },
    transcript: { contextEntryId: 'context.meeting.transcript' },
    summary: {
      title: meeting.fields.title + ' summary',
      project: { recordId: project.id, recordFingerprint: fingerprintJson(project) },
      ourSpeakerIds: ['speaker.retro'],
      segmentReferences: transcript.segments.map((segment, index) => ({
        index,
        segmentFingerprint: fingerprintJson(segment)
      }))
    },
    tasks: [{
      recordId: task.id,
      disposition: 'fold',
      segmentReferences: transcript.segments.slice(0, 2).map((segment, index) => ({
        index,
        segmentFingerprint: fingerprintJson(segment)
      }))
    }]
  }
};

const review = buildMeetingIntakeReview({ decision, snapshot, derivedReviewDefinition });
assert.equal(review.preview, undefined);
assert.deepEqual(
  validateJsonSchema(
    review.review,
    readJson(path.join(root, 'soter/contracts/automation-review.schema.json'))
  ),
  []
);
assert.equal(review.review.kind, 'meeting-intake-review');
assert.equal(review.review.proposedChanges.length, 0);
assert.equal(review.review.collections[0].rows.length, 3);
assert.equal(review.review.collections[0].rows[2].actions[0].state, 'held');
const privateText = JSON.stringify(review.derivedReview);
const completeReviewText = JSON.stringify(review);
assert(!completeReviewText.includes(untrustedActionItem));
assert(!completeReviewText.includes(untrustedParticipantEmail));
assert.equal(
  review.derivedReview.items.filter((item) => item.kind === 'meeting-task-fold').length,
  1,
  'Provider action_items must not create an additional task review item.'
);
assert.equal(
  review.derivedReview.items.some((item) => item.kind === 'meeting-commitment'),
  false,
  'Provider action_items must not create a commitment review item.'
);
assert(privateText.includes('## Our commitments'));
assert(privateText.includes('## Their commitments'));
assert(privateText.includes('Maya Chen: I will send the integration reference after the meeting.'));
assert(privateText.includes('External-participant commitments remain in the summary'));

const actions = review.review.collections[0].rows
  .flatMap((row) => row.actions);
const heldGroupActions = actions.filter((action) => [
  'action.meeting-intake.summary-create',
  'action.meeting-intake.task-fold'
].includes(action.id));
assert.deepEqual(
  heldGroupActions.map((action) => action.id),
  ['action.meeting-intake.summary-create', 'action.meeting-intake.task-fold']
);
for (const action of heldGroupActions) {
  assert.equal(action.state, 'held');
  assert.equal(action.reasonCode, 'COMPLETE_MEETING_READBACK_UNAVAILABLE');
  assert.equal(action.capability, null);
  assert.equal(action.effect, null);
  assert.equal(Object.hasOwn(action, 'changeFingerprint'), false);
}
assert.equal(actions.some((action) => action.state === 'proposed'), false);
const taskItem = review.derivedReview.items.find((item) => item.kind === 'meeting-task-fold');
const sourceMeetingField = taskItem.fields.find((field) => field.id === 'sourceMeetingUris');
assert.deepEqual(sourceMeetingField.reviewValue, [meeting.id]);
assert.notEqual(
  sourceMeetingField.reviewValue[0],
  meeting.fields.recordingUri,
  'The Task relation must bind the portable Meeting record identity, never the recording URL.'
);
assert.deepEqual(
  taskItem.fields.find((field) => field.id === 'sourceQuotes').reviewValue,
  transcript.segments.slice(0, 2).map((segment) => segment.text)
);
const stale = structuredClone(decision);
stale.payload.meeting.ageState = 'stale';
assert.throws(
  () => buildMeetingIntakeReview({ decision: stale, snapshot, derivedReviewDefinition }),
  /ready current-meeting decision/
);

process.stdout.write('Meeting Intake held complete-group review and staleness selftest passed.\n');
