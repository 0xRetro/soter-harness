import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import {
  commitDurableAutomationDecision,
  getExactDurableAutomationDecision,
  getExactDurableContextSnapshot
} from '../../core/service.mjs';
import { fingerprintJson, readJson, resolveRepoPath } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  hasAutomationDecisionState,
  readAutomationDecisionState,
  readContextSnapshotState
} from '../../core/runtime-state.mjs';

const AUTOMATION_ID = 'automation.meeting-intake';
const DECISION_TYPE = 'meeting-intake.grounded-outcome';

function validate(root, value, schemaPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw new Error(
      label + ' does not satisfy its contract: '
        + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

function decisionFingerprint(decision) {
  const value = structuredClone(decision);
  delete value.decisionFingerprint;
  return fingerprintJson(value);
}

function selectedAutomation(lock) {
  const matches = lock.packs.filter((pack) => {
    return pack.id === AUTOMATION_ID && pack.layer === 'automation';
  });
  if (matches.length !== 1) {
    throw new Error('Meeting-intake decision requires one selected ' + AUTOMATION_ID + ' pack.');
  }
  return matches[0];
}

function snapshotRecords(snapshot, recordType) {
  return snapshot.entries.flatMap((entry) => {
    return (entry.value?.records || []).filter((record) => record.type === recordType);
  });
}

function exactTranscriptEntry(snapshot) {
  const entries = snapshot.entries.filter((entry) => {
    return entry.subject === 'meeting.transcript'
      && Array.isArray(entry.value?.segments)
      && Array.isArray(entry.value?.speakers);
  });
  if (entries.length !== 1 || entries[0].value.segments.length < 1) {
    throw new Error(
      'Meeting-intake decision requires exactly one non-empty bounded transcript entry; found '
        + entries.length + '.'
    );
  }
  return entries[0];
}

function applicablePolicyEntries(snapshot) {
  return snapshot.entries.filter((entry) => entry.applicability?.state === 'applicable');
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(label + ' must be an array.');
  return value;
}

function requireText(value, label, minimum = 1) {
  if (typeof value !== 'string' || value.trim().length < minimum) {
    throw new Error(label + ' must contain at least ' + minimum + ' characters.');
  }
  return value.trim();
}

function uniqueIntegers(value, label) {
  const indexes = requireArray(value, label);
  if (indexes.some((index) => !Number.isInteger(index) || index < 0)
    || new Set(indexes).size !== indexes.length) {
    throw new Error(label + ' must contain unique non-negative integer indexes.');
  }
  return indexes;
}

function segmentReferences(indexes, transcript, label) {
  return uniqueIntegers(indexes, label).map((index) => {
    const segment = transcript.value.segments[index];
    if (!segment) throw new Error(label + ' references missing transcript segment ' + index + '.');
    return { index, segmentFingerprint: fingerprintJson(segment) };
  });
}

function exactRecord(records, id, label) {
  const matches = records.filter((record) => record.id === id);
  if (matches.length !== 1) {
    throw new Error(label + ' must identify exactly one bounded record; found ' + matches.length + '.');
  }
  return matches[0];
}

function candidateDecisionMap(inputs, key, label) {
  const values = requireArray(inputs, label);
  const ids = values.map((item) => item?.[key]);
  if (ids.some((id) => typeof id !== 'string' || !id)
    || new Set(ids).size !== ids.length) {
    throw new Error(label + ' must identify each candidate exactly once.');
  }
  return new Map(values.map((item) => [item[key], item]));
}

function buildDecision({ lock, snapshot, id, createdAt, producer, input }) {
  const automation = selectedAutomation(lock);
  if (!producer
    || !['host', 'user', 'fixture'].includes(producer.kind)
    || typeof producer.id !== 'string'
    || !producer.id.trim()
    || (producer.kind === 'host'
      ? (typeof producer.host !== 'string' || !producer.host)
      : producer.host !== null)) {
    throw new Error('Meeting-intake decision producer must have an exact kind, identity, and host binding.');
  }
  if (snapshot.configurationLockFingerprint !== fingerprintLock(lock)
    || snapshot.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Meeting-intake decision context does not match the exact lock and graph.');
  }
  if (!['ready', 'needs-input'].includes(input?.state)) {
    throw new Error('Meeting-intake decision state must be ready or needs-input.');
  }
  const issues = requireArray(input.issues, 'Meeting-intake decision issues')
    .map((issue, index) => requireText(issue, 'Decision issue ' + index, 12));
  const limitations = requireArray(input.limitations, 'Meeting-intake decision limitations')
    .map((item, index) => requireText(item, 'Decision limitation ' + index, 12));
  if (new Set(issues).size !== issues.length || new Set(limitations).size !== limitations.length) {
    throw new Error('Meeting-intake decision issues and limitations must be unique.');
  }

  const meetings = snapshotRecords(snapshot, 'meeting');
  if (meetings.length !== 1) {
    throw new Error(
      'Meeting-intake decision requires exactly one bounded meeting record; found '
        + meetings.length + '.'
    );
  }
  const meeting = exactRecord(
    meetings,
    requireText(input.meetingRecordId, 'Meeting record ID'),
    'Meeting selection'
  );
  const transcript = exactTranscriptEntry(snapshot);
  const summaryReferences = segmentReferences(
    input.summarySegmentIndexes,
    transcript,
    'Summary segment indexes'
  );

  const taskCandidates = snapshotRecords(snapshot, 'task');
  if (new Set(taskCandidates.map((record) => record.id)).size !== taskCandidates.length) {
    throw new Error('Bounded meeting-intake task candidates contain duplicate record identities.');
  }
  const taskInputs = candidateDecisionMap(
    input.tasks,
    'recordId',
    'Meeting-intake task decisions'
  );
  const candidateIds = taskCandidates.map((record) => record.id).sort();
  const decisionIds = [...taskInputs.keys()].sort();
  if (fingerprintJson(candidateIds) !== fingerprintJson(decisionIds)) {
    throw new Error('Meeting-intake task decisions must cover every and only bounded task candidate.');
  }
  const tasks = taskCandidates.map((record) => {
    const task = taskInputs.get(record.id);
    if (!['fold', 'ignore', 'review'].includes(task.disposition)) {
      throw new Error('Task ' + record.id + ' has an unsupported disposition.');
    }
    return {
      recordId: record.id,
      recordFingerprint: fingerprintJson(record),
      disposition: task.disposition,
      reason: requireText(task.reason, 'Task decision reason for ' + record.id, 20),
      segmentReferences: segmentReferences(
        task.segmentIndexes,
        transcript,
        'Task segment indexes for ' + record.id
      )
    };
  });

  const policyEntries = applicablePolicyEntries(snapshot);
  const policyInputs = candidateDecisionMap(
    input.policies,
    'contextEntryId',
    'Meeting-intake policy decisions'
  );
  const policyEntryIds = policyEntries.map((entry) => entry.id).sort();
  const policyDecisionIds = [...policyInputs.keys()].sort();
  if (fingerprintJson(policyEntryIds) !== fingerprintJson(policyDecisionIds)) {
    throw new Error(
      'Meeting-intake policy decisions must cover every and only explicitly applicable policy entry.'
    );
  }
  const policies = policyEntries.map((entry) => {
    const policy = policyInputs.get(entry.id);
    if (!['allow', 'block', 'review'].includes(policy.outcome)) {
      throw new Error('Policy ' + entry.id + ' has an unsupported outcome.');
    }
    const body = entry.value?.document?.body;
    if (typeof body !== 'string' || !body.trim()) {
      throw new Error('Applicable policy ' + entry.id + ' has no bounded body to interpret.');
    }
    const citations = requireArray(policy.citations, 'Policy citations for ' + entry.id)
      .map((quote, index) => {
        const exactQuote = requireText(quote, 'Policy citation ' + index + ' for ' + entry.id, 3);
        if (!body.includes(exactQuote)) {
          throw new Error('Policy citation for ' + entry.id + ' is not an exact substring of its body.');
        }
        return { quote: exactQuote, quoteFingerprint: fingerprintJson(exactQuote) };
      });
    if (new Set(citations.map((citation) => citation.quote)).size !== citations.length) {
      throw new Error('Policy citations for ' + entry.id + ' must be unique.');
    }
    return {
      contextEntryId: entry.id,
      entryFingerprint: entry.valueFingerprint,
      sourceId: entry.applicability.sourceId,
      outcome: policy.outcome,
      reason: requireText(policy.reason, 'Policy decision reason for ' + entry.id, 20),
      citations
    };
  });

  if (input.state === 'ready') {
    const folded = tasks.filter((task) => task.disposition === 'fold');
    if (issues.length
      || summaryReferences.length < 1
      || taskCandidates.length < 1
      || folded.length !== 1
      || tasks.some((task) => task.disposition === 'review'
        || task.segmentReferences.length < 1)
      || policies.some((policy) => policy.outcome !== 'allow'
        || policy.citations.length < 1)
      || (snapshot.containment === 'connected' && policies.length < 1)) {
      throw new Error(
        'A ready meeting-intake decision requires no issues, grounded summary segments, exactly one folded task, resolved cited task decisions, and cited allow outcomes for every connected policy.'
      );
    }
  } else if (issues.length < 1) {
    throw new Error('A needs-input meeting-intake decision must state at least one issue.');
  }

  const decision = {
    $contract: 'soter://contracts/automation-decision/v1',
    contractVersion: '1.0.0',
    id,
    automation: { id: AUTOMATION_ID, version: automation.version },
    runId: snapshot.runId,
    createdAt,
    configurationLockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint,
    context: {
      snapshotId: snapshot.id,
      snapshotFingerprint: fingerprintJson(snapshot)
    },
    producer: { ...structuredClone(producer), id: producer.id.trim() },
    state: input.state,
    decisionType: DECISION_TYPE,
    payload: {
      meeting: {
        recordId: meeting.id,
        recordFingerprint: fingerprintJson(meeting)
      },
      transcript: {
        contextEntryId: transcript.id,
        entryFingerprint: transcript.valueFingerprint
      },
      summary: {
        title: meeting.fields.title + ' summary',
        segmentReferences: summaryReferences
      },
      tasks,
      policies,
      limitations
    },
    issues,
    privacy: {
      scope: 'private',
      redactions: [
        'Provider credentials, secret references, and raw host responses are excluded.',
        'Only exact bounded record identities, transcript segment fingerprints, and cited policy excerpts are retained.'
      ]
    },
    decisionFingerprint: fingerprintJson(null)
  };
  decision.decisionFingerprint = decisionFingerprint(decision);
  return decision;
}

function inputFromDecision(decision) {
  return {
    state: decision.state,
    meetingRecordId: decision.payload.meeting.recordId,
    summarySegmentIndexes: decision.payload.summary.segmentReferences.map((item) => item.index),
    tasks: decision.payload.tasks.map((task) => ({
      recordId: task.recordId,
      disposition: task.disposition,
      reason: task.reason,
      segmentIndexes: task.segmentReferences.map((item) => item.index)
    })),
    policies: decision.payload.policies.map((policy) => ({
      contextEntryId: policy.contextEntryId,
      outcome: policy.outcome,
      reason: policy.reason,
      citations: policy.citations.map((citation) => citation.quote)
    })),
    issues: structuredClone(decision.issues),
    limitations: structuredClone(decision.payload.limitations)
  };
}

export function createMeetingIntakeDecision(args) {
  const resolvedRoot = path.resolve(args.root);
  const decision = buildDecision(args);
  validate(
    resolvedRoot,
    decision,
    'soter/contracts/automation-decision.schema.json',
    'Automation decision'
  );
  validate(
    resolvedRoot,
    decision,
    'soter/automations/meeting-intake/decision.schema.json',
    'Meeting-intake decision'
  );
  return decision;
}

export function inspectMeetingIntakeDecisionContext({
  root,
  lockPath,
  snapshotId,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const exact = getExactDurableContextSnapshot({
    root: resolvedRoot,
    lockPath,
    snapshotId,
    expectedHost
  });
  const lock = exact.lock;
  selectedAutomation(lock);
  const snapshot = exact.snapshot;
  const meetings = snapshotRecords(snapshot, 'meeting');
  if (meetings.length !== 1) {
    throw new Error(
      'Meeting-intake decision inspection requires exactly one bounded meeting; found '
        + meetings.length + '.'
    );
  }
  const transcript = exactTranscriptEntry(snapshot);
  const tasks = snapshotRecords(snapshot, 'task');
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new Error('Meeting-intake decision inspection found duplicate bounded task identities.');
  }
  const policies = applicablePolicyEntries(snapshot);
  return {
    snapshot,
    inputTemplate: {
      state: 'needs-input',
      meetingRecordId: meetings[0].id,
      summarySegmentIndexes: [],
      tasks: tasks.map((task) => ({
        recordId: task.id,
        disposition: 'review',
        reason: 'No grounded disposition has been supplied for this bounded task candidate.',
        segmentIndexes: []
      })),
      policies: policies.map((entry) => ({
        contextEntryId: entry.id,
        outcome: 'review',
        reason: 'No cited interpretation has been supplied for this explicitly applicable policy.',
        citations: []
      })),
      issues: [
        'Host or user judgment must cite the transcript and every applicable policy before this decision can become ready.'
      ],
      limitations: [
        'This template enumerates bounded inputs but does not interpret transcript or policy content.'
      ]
    },
    counts: {
      transcriptSegments: transcript.value.segments.length,
      taskCandidates: tasks.length,
      applicablePolicies: policies.length
    }
  };
}

export function assertMeetingIntakeDecision({ root, lock, snapshot, decision }) {
  const resolvedRoot = path.resolve(root);
  validate(
    resolvedRoot,
    decision,
    'soter/contracts/automation-decision.schema.json',
    'Automation decision'
  );
  validate(
    resolvedRoot,
    decision,
    'soter/automations/meeting-intake/decision.schema.json',
    'Meeting-intake decision'
  );
  const expected = buildDecision({
    lock,
    snapshot,
    id: decision.id,
    createdAt: decision.createdAt,
    producer: decision.producer,
    input: inputFromDecision(decision)
  });
  if (fingerprintJson(expected) !== fingerprintJson(decision)
    || decision.decisionFingerprint !== decisionFingerprint(decision)) {
    throw new Error(
      'Meeting-intake decision does not match the exact context records, transcript segments, policy excerpts, and decision fingerprint.'
    );
  }
  return true;
}

export function commitMeetingIntakeDecision({
  root,
  lockPath,
  snapshotId,
  id,
  input,
  producer,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const lock = readJson(resolveRepoPath(resolvedRoot, lockPath));
  const snapshot = readContextSnapshotState(resolvedRoot, snapshotId).snapshot;
  const existing = hasAutomationDecisionState(resolvedRoot, id)
    ? readAutomationDecisionState(resolvedRoot, id).decision
    : null;
  const decision = createMeetingIntakeDecision({
    root: resolvedRoot,
    lock,
    snapshot,
    id,
    createdAt: existing?.createdAt || at || new Date().toISOString(),
    producer,
    input
  });
  if (existing && fingerprintJson(existing) !== fingerprintJson(decision)) {
    throw new Error('Meeting-intake decision input conflicts with existing durable state.');
  }
  assertMeetingIntakeDecision({ root: resolvedRoot, lock, snapshot, decision });
  return commitDurableAutomationDecision({
    root: resolvedRoot,
    lockPath,
    decision,
    expectedHost
  });
}

export function loadMeetingIntakeDecision({ root, lockPath, decisionId, expectedHost }) {
  const exact = getExactDurableAutomationDecision({
    root,
    lockPath,
    decisionId,
    expectedHost
  });
  assertMeetingIntakeDecision({
    root,
    lock: exact.lock,
    snapshot: exact.snapshot,
    decision: exact.decision
  });
  return exact;
}
