import { invokeCapability } from '../../core/capabilities.mjs';
import { assembleMeetingIntakeContext } from '../../core/context.mjs';
import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  approveChangeSet,
  changeSetScopeFingerprint,
  executeContainedChangeSet
} from '../../core/transaction.mjs';
import {
  assertMeetingIntakeDecision,
  createMeetingIntakeDecision,
  loadMeetingIntakeDecision
} from './decision.mjs';

function records(snapshot, type) {
  const matches = [];
  for (const entry of snapshot.entries) {
    matches.push(...(entry.value.records || []).filter((item) => item.type === type));
  }
  return matches;
}

function singleTranscript(snapshot) {
  const matches = snapshot.entries
    .map((entry) => entry.value)
    .filter((value) => Array.isArray(value?.segments) && Array.isArray(value?.speakers));
  if (matches.length !== 1 || matches[0].segments.length < 1) {
    throw new Error(
      'Meeting-intake proposal requires exactly one non-empty bounded transcript; found '
        + matches.length + '.'
    );
  }
  return matches[0];
}

export function proposeMeetingIntakeChangeSet({
  root,
  lock,
  snapshot,
  decision,
  id,
  runId,
  createdAt
}) {
  assertMeetingIntakeDecision({ root, lock, snapshot, decision });
  if (decision.state !== 'ready') {
    throw new Error('Meeting-intake proposal requires a ready grounded Automation decision.');
  }
  if (decision.runId !== runId) {
    throw new Error('Meeting-intake proposal run does not match its exact Automation decision.');
  }
  const meeting = records(snapshot, 'meeting').find((record) => {
    return record.id === decision.payload.meeting.recordId;
  });
  const transcriptEntry = snapshot.entries.find((entry) => {
    return entry.id === decision.payload.transcript.contextEntryId;
  });
  const transcript = transcriptEntry?.value;
  if (!meeting || !transcript) {
    throw new Error('Meeting-intake decision references context that is not present in the snapshot.');
  }
  const speakerNames = new Map(transcript.speakers.map((speaker) => {
    return [speaker.id, speaker.displayName];
  }));
  const summarySegments = decision.payload.summary.segmentReferences.map((reference) => {
    return transcript.segments[reference.index];
  });
  const transcriptText = summarySegments.map((segment) => segment.text).join(' ');
  const summaryBody = summarySegments.map((segment) => {
    return (speakerNames.get(segment.speakerId) || segment.speakerId) + ': ' + segment.text;
  }).join('\n\n');
  const foldedTasks = decision.payload.tasks.filter((task) => task.disposition === 'fold');
  const operations = [
    ...foldedTasks.map((task) => ({
      id: 'operation.task.update',
      capability: 'crm.records.update',
      authority: 'authority.crm.instance',
      reason: task.reason,
      input: {
        recordType: 'task',
        id: task.recordId,
        expectedVersion: records(snapshot, 'task').find((record) => {
          return record.id === task.recordId;
        }).version,
        patch: {
          context: 'Meeting'
        }
      }
    })),
    {
      id: 'operation.summary.create',
      capability: 'crm.records.create',
      authority: 'authority.crm.instance',
      reason: 'Create the exact transcript-cited summary selected by ' + decision.id + '.',
      input: {
        recordType: 'meeting-summary',
        deduplicationKey: meeting.fields.recordingUri,
        deduplicationFilter: {
          field: 'link',
          value: meeting.fields.recordingUri
        },
        fields: {
          title: decision.payload.summary.title,
          documentType: 'Meeting Summary',
          description: transcriptText,
          link: meeting.fields.recordingUri
        },
        body: summaryBody
      }
    }
  ].map((operation) => ({
    ...operation,
    inputFingerprint: fingerprintJson(operation.input),
    state: 'pending',
    effectId: null,
    outputFingerprint: null,
    error: null
  }));
  const changeSet = {
    $contract: 'soter://contracts/change-set/v1',
    contractVersion: '1.0.0',
    id,
    runId,
    createdAt,
    configurationLockFingerprint: fingerprintLock(lock),
    basis: {
      kind: 'automation-decision',
      id: decision.id,
      fingerprint: decision.decisionFingerprint,
      contextSnapshotId: decision.context.snapshotId,
      contextSnapshotFingerprint: decision.context.snapshotFingerprint
    },
    state: 'proposed',
    scopeFingerprint: fingerprintJson(null),
    operations,
    approvalId: null,
    transaction: {
      checkpointFingerprint: fingerprintJson(null),
      state: 'not-started',
      rollbackState: 'not-required',
      restoredFingerprint: null
    },
    verification: {
      state: 'unknown',
      effectId: null,
      criteria: [
        'Exactly one meeting summary exists for the canonical recording link.',
        'The summary body and link remain attributable to the source transcript and recording.',
        'The existing overlapping task is classified as meeting-derived without duplication.'
      ],
      observedFingerprint: null
    }
  };
  changeSet.scopeFingerprint = changeSetScopeFingerprint(changeSet);
  return changeSet;
}

export function proposeDurableMeetingIntakeChangeSet({
  root,
  lockPath,
  decisionId,
  id,
  createdAt,
  expectedHost
}) {
  const exact = loadMeetingIntakeDecision({
    root,
    lockPath,
    decisionId,
    expectedHost
  });
  return proposeMeetingIntakeChangeSet({
    root,
    lock: exact.lock,
    snapshot: exact.snapshot,
    decision: exact.decision,
    id,
    runId: exact.decision.runId,
    createdAt
  });
}

async function verifyContainedOutcome({ root, lock, changeSet, runtimeState, at }) {
  const verification = await invokeCapability({
    root,
    lock,
    capability: 'crm.records.read',
    authority: 'authority.crm.instance',
    containment: 'fixture',
    input: {
      recordTypes: [...new Set(changeSet.operations.map((operation) => {
        return operation.input.recordType;
      }))]
    },
    effectId: 'effect.' + changeSet.id.slice('changeset.'.length) + '.verify',
    at,
    runtimeState
  });
  const values = verification.output?.records || [];
  const summaryOperation = changeSet.operations.find((item) => {
    return item.id === 'operation.summary.create';
  });
  const taskOperation = changeSet.operations.find((item) => {
    return item.id === 'operation.task.update';
  });
  const summary = values.find((item) => {
    return item.type === 'meeting-summary'
      && item.deduplicationKey === summaryOperation?.input.deduplicationKey;
  });
  const task = values.find((item) => item.id === taskOperation?.input.id);
  return {
    invocation: verification.invocation,
    output: verification.output,
    passed: verification.invocation.state === 'passed'
      && Boolean(summary)
      && summary.fields.link === summaryOperation.input.fields.link
      && summary.body === summaryOperation.input.body
      && task?.fields.context === taskOperation.input.patch.context
  };
}

export function executeContainedMeetingIntakeChangeSet(args) {
  return executeContainedChangeSet({ ...args, verify: verifyContainedOutcome });
}

export async function runContainedMeetingIntakeTransaction({
  root,
  lock,
  lockPath,
  scenarioPath,
  runId,
  snapshotId,
  decisionId,
  changeSetId,
  approvalId,
  createdAt,
  actor,
  approved,
  evidenceIds
}) {
  const contained = await assembleMeetingIntakeContext({
    root,
    lock,
    lockPath,
    scenarioPath,
    runId,
    snapshotId,
    createdAt,
    meetingId: 'meeting.fixture-001',
    recordingUri: 'otter://fixture/meeting.fixture-001',
    evidenceIds
  });
  const transcript = singleTranscript(contained.snapshot);
  const boundedTasks = records(contained.snapshot, 'task');
  if (boundedTasks.length !== 1) {
    throw new Error(
      'Contained meeting-intake fixture decision requires exactly one task candidate; found '
        + boundedTasks.length + '.'
    );
  }
  const boundedMeetings = records(contained.snapshot, 'meeting');
  if (boundedMeetings.length !== 1) {
    throw new Error(
      'Contained meeting-intake fixture decision requires exactly one meeting; found '
        + boundedMeetings.length + '.'
    );
  }
  const decision = createMeetingIntakeDecision({
    root,
    lock,
    snapshot: contained.snapshot,
    id: decisionId,
    createdAt,
    producer: { kind: 'fixture', id: 'fixture.meeting-intake', host: null },
    input: {
      state: 'ready',
      meetingRecordId: boundedMeetings[0].id,
      summarySegmentIndexes: transcript.segments.map((_, index) => index),
      tasks: [{
        recordId: boundedTasks[0].id,
        disposition: 'fold',
        reason: 'The bounded fixture transcript explicitly requests the existing launch-deck work.',
        segmentIndexes: transcript.segments.map((_, index) => index)
      }],
      policies: [],
      issues: [],
      limitations: [
        'Contained fixture context does not load external policy bodies and cannot establish connected policy interpretation.'
      ]
    }
  });
  const proposed = proposeMeetingIntakeChangeSet({
    root,
    lock,
    snapshot: contained.snapshot,
    decision,
    id: changeSetId,
    runId,
    createdAt
  });
  contained.envelope.checkpoints.push({
    id: 'automation-decision.' + decision.id.slice('decision.'.length),
    kind: 'automation-decision',
    state: 'passed',
    snapshotId: decision.context.snapshotId,
    snapshotFingerprint: decision.context.snapshotFingerprint,
    decisionId: decision.id,
    decisionFingerprint: decision.decisionFingerprint,
    updatedAt: decision.createdAt,
    details: 'The contained Automation decision covers its exact meeting, transcript segments, and sole task candidate without claiming connected policy interpretation.'
  });
  contained.envelope.outputs.push({
    id: decision.id,
    type: 'automation-decision',
    fingerprint: decision.decisionFingerprint
  });
  if (!approved) {
    contained.envelope.outputs.push({
      id: proposed.id,
      type: 'change-set-preview',
      fingerprint: proposed.scopeFingerprint
    });
    return {
      ...contained,
      decision,
      changeSet: proposed,
      approval: null,
      verificationOutput: null
    };
  }
  const approval = approveChangeSet({
    changeSet: proposed,
    id: approvalId,
    runId,
    createdAt,
    actor,
    reason: 'Approve this exact contained meeting-intake write batch for transactional fixture execution.'
  });
  const executed = await executeContainedMeetingIntakeChangeSet({
    root,
    lock,
    changeSet: proposed,
    approval,
    at: createdAt
  });
  contained.envelope.approvals = [approval];
  contained.envelope.effects.push(...executed.effects);
  contained.envelope.outputs.push({
    id: executed.changeSet.id,
    type: 'change-set',
    fingerprint: fingerprintJson(executed.changeSet)
  });
  contained.envelope.checkpoints.push(
    {
      id: 'write-batch-approved',
      state: 'passed',
      details: 'Approval fingerprint matched the exact proposed operation scope.'
    },
    {
      id: 'write-transaction',
      state: executed.changeSet.transaction.state === 'committed' ? 'passed' : 'failed',
      details: 'Contained writes completed under one checkpoint with explicit rollback state.'
    },
    {
      id: 'read-after-write',
      state: executed.changeSet.verification.state,
      details: 'The fixture store was re-read and checked against the Automation acceptance criteria.'
    }
  );
  contained.envelope.lifecycleState = executed.changeSet.state === 'committed' ? 'completed' : 'failed';
  return {
    envelope: contained.envelope,
    snapshot: contained.snapshot,
    decision,
    changeSet: executed.changeSet,
    approval,
    verificationOutput: executed.verificationOutput
  };
}
