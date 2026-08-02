import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import {
  automationProposalFingerprint,
  automationProposalMaterialFingerprint,
  commitDurableAutomationProposal,
  getExactDurableAutomationProposal,
  loadAutomationProposalDeclaration
} from '../../core/automation-proposals.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  assertAutomationReviewProjection,
  derivedReviewContentFingerprint,
  derivedReviewItemFingerprint
} from '../../core/review-projections.mjs';
import {
  hasAutomationProposalState,
  readAutomationProposalState
} from '../../core/runtime-state.mjs';
import { assertMeetingIntakeDecision, loadMeetingIntakeDecision } from './decision.mjs';

const AUTOMATION_ID = 'automation.meeting-intake';
const PROPOSAL_TYPE = 'meeting-intake.review-proposal';
const REVIEW_KIND = 'meeting-intake-review';
const SUMMARY_ACTION = 'action.meeting-intake.summary-create';
const TASK_ACTION = 'action.meeting-intake.task-fold';
const COMPLETE_READBACK_UNAVAILABLE = 'COMPLETE_MEETING_READBACK_UNAVAILABLE';
const ZERO_FINGERPRINT = 'sha256:' + '0'.repeat(64);
const REQUIRED_ACTIONS = [SUMMARY_ACTION, TASK_ACTION];
const LIMITATIONS = [
  'This private review proposal creates no approval, confirmation, continuation, provider call, write, proof, maturity, or migration authority.',
  'Only exact normalized transcript segments ground this review. Provider action-item interpretations and calendar-participant pairings are excluded and cannot create commitments, tasks, or identity links.',
  'The current v2 scope prepares one grounded summary and one exact existing-task fold for private review. Meeting-row updates, new tasks, project-body updates, provider-created summary back-links, and AI Inbox digest writes are deliberately unavailable.',
  'The complete summary-and-task group remains held because Core cannot yet verify every mapped summary field and the complete summary body in one exact read-back criterion. No proposed change can be selected into a connected batch.'
];

function codedError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function validate(root, value, schemaPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw new Error(
      label + ' does not satisfy its contract: '
        + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

function assertInput(input, schemaPath) {
  const failures = validateJsonSchema(input, readJson(schemaPath));
  if (failures.length) {
    throw new Error(
      'Meeting Intake proposal input does not satisfy its closed contract: '
        + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

function snapshotRecords(snapshot, type) {
  return snapshot.entries.flatMap((entry) => {
    return (entry.value?.records || []).filter((record) => record.type === type);
  });
}

function exactRecord(snapshot, type, id) {
  const matches = snapshotRecords(snapshot, type).filter((record) => record.id === id);
  if (matches.length !== 1) {
    throw new Error('Meeting Intake proposal requires one exact bounded ' + type + ' record.');
  }
  return matches[0];
}

function exactTranscript(snapshot) {
  const matches = snapshot.entries.filter((entry) => {
    return entry.subject === 'meeting.transcript'
      && Array.isArray(entry.value?.speakers)
      && Array.isArray(entry.value?.segments);
  });
  if (matches.length !== 1) {
    throw new Error('Meeting Intake proposal requires one exact bounded transcript.');
  }
  return matches[0].value;
}

function privateField(id, label, type, reviewValue) {
  return { id, label, type, fingerprint: fingerprintJson(reviewValue), reviewValue };
}

function privateItem(id, kind, sources, fields) {
  const item = { id, kind, sources, fields, fingerprint: ZERO_FINGERPRINT };
  item.fingerprint = derivedReviewItemFingerprint(item);
  return item;
}

function rowFingerprint(row) {
  const unsigned = structuredClone(row);
  delete unsigned.fingerprint;
  delete unsigned.privateDetailFingerprint;
  for (const action of unsigned.actions) delete action.changeFingerprint;
  return fingerprintJson(unsigned);
}

function collectionFingerprint(collection) {
  const unsigned = structuredClone(collection);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function source(collectionId, row) {
  return { collectionId, rowId: row.id, rowFingerprint: row.fingerprint };
}

function heldBoundaryAction(id, kind) {
  return {
    id,
    kind,
    capability: null,
    effect: null,
    state: 'held',
    reasonCode: COMPLETE_READBACK_UNAVAILABLE
  };
}

function transcriptMaterial(decision, snapshot) {
  const transcript = exactTranscript(snapshot);
  const speakers = new Map(transcript.speakers.map((speaker) => [speaker.id, speaker]));
  const indexes = decision.payload.summary.segmentReferences.map((reference) => reference.index);
  const segments = indexes.map((index) => {
    const segment = transcript.segments[index];
    const speaker = speakers.get(segment?.speakerId);
    if (!segment || !speaker) {
      throw new Error('Meeting Intake proposal summary references an unavailable transcript segment.');
    }
    return { ...segment, displayName: speaker.displayName };
  });
  const ourIds = new Set(decision.payload.summary.ourSpeakerIds);
  return {
    segments,
    ours: segments.filter((segment) => ourIds.has(segment.speakerId))
      .map((segment) => segment.displayName + ': ' + segment.text),
    theirs: segments.filter((segment) => !ourIds.has(segment.speakerId))
      .map((segment) => segment.displayName + ': ' + segment.text)
  };
}

function summaryValue(decision, snapshot) {
  const meeting = exactRecord(snapshot, 'meeting', decision.payload.meeting.recordId);
  const project = exactRecord(snapshot, 'project', decision.payload.summary.project.recordId);
  const transcript = transcriptMaterial(decision, snapshot);
  const discussion = transcript.segments.map((segment) => {
    return segment.displayName + ': ' + segment.text;
  });
  const section = (title, lines) => '## ' + title + '\n\n'
    + (lines.length ? lines.map((line) => '- ' + line).join('\n') : '- None recorded.');
  const body = [
    '# ' + decision.payload.summary.title,
    'Related project: ' + project.fields.name,
    'Source meeting: ' + meeting.fields.title,
    section('Discussion', discussion),
    section('Our commitments', transcript.ours),
    section('Their commitments', transcript.theirs)
  ].join('\n\n');
  return {
    fields: {
      title: decision.payload.summary.title,
      documentType: 'Meeting Summary',
      description: transcript.segments.map((segment) => segment.text).join(' '),
      link: meeting.fields.recordingUri
    },
    body,
    projectIds: [project.id],
    ourCommitments: transcript.ours,
    theirCommitments: transcript.theirs
  };
}

function foldedTaskValue(decision, snapshot, summary) {
  const folded = decision.payload.tasks.filter((task) => task.disposition === 'fold');
  if (folded.length !== 1) {
    throw new Error('Meeting Intake proposal requires exactly one grounded existing-task fold.');
  }
  const meeting = exactRecord(snapshot, 'meeting', decision.payload.meeting.recordId);
  const task = exactRecord(snapshot, 'task', folded[0].recordId);
  const transcript = exactTranscript(snapshot);
  const quotes = folded[0].segmentReferences.map((reference) => {
    const segment = transcript.segments[reference.index];
    if (!segment || fingerprintJson(segment) !== reference.segmentFingerprint) {
      throw new Error('Meeting Intake task fold references stale transcript material.');
    }
    return segment.text;
  });
  const patch = {
    sourceMeetingUris: [meeting.id],
    sourceQuotes: quotes,
    sourceSummaryFingerprints: [fingerprintJson(summary.body)]
  };
  return { task, patch };
}

export function buildMeetingIntakeReview({ decision, snapshot, derivedReviewDefinition }) {
  if (decision.state !== 'ready' || decision.payload.meeting.ageState !== 'current') {
    throw new Error('Meeting Intake proposal requires one exact ready current-meeting decision.');
  }
  const summary = summaryValue(decision, snapshot);
  const folded = foldedTaskValue(decision, snapshot, summary);
  const notCreated = [
    'External-participant commitments remain in the summary and never become internally assigned tasks.',
    'New task creation is unavailable in this v2 slice; only one exact existing overlap is folded.',
    'Meeting-row links, project-body updates, provider-created summary back-links, and AI Inbox digest writes are unavailable.',
    'The task fold binds the source meeting and summary content fingerprint rather than guessing a provider-created summary identity.',
    'The complete summary-and-task group is reviewable but cannot enter approval or execution until one exact verification criterion can prove every mapped summary field and the complete summary body.'
  ];
  const summaryAction = heldBoundaryAction(
    SUMMARY_ACTION,
    'meeting-summary-create'
  );
  const taskAction = heldBoundaryAction(
    TASK_ACTION,
    'meeting-task-fold'
  );
  const boundaryAction = {
    id: 'action.meeting-intake.unsupported-effects',
    kind: 'meeting-intake-boundary',
    capability: null,
    effect: null,
    state: 'held',
    reasonCode: 'MEETING_LEGACY_EFFECTS_UNAVAILABLE'
  };
  const rows = [
    {
      id: 'row.meeting-intake.summary', sequence: 1, representedCount: 1,
      subject: { kind: 'meeting-summary', fingerprint: fingerprintJson(summary) },
      group: 'meeting-intake', attention: 'operator', disposition: 'itemized',
      reasonCode: summaryAction.reasonCode, flags: [COMPLETE_READBACK_UNAVAILABLE],
      actions: [summaryAction],
      privateDetailFingerprint: null, fingerprint: ZERO_FINGERPRINT
    },
    {
      id: 'row.meeting-intake.task-fold', sequence: 2, representedCount: 1,
      subject: { kind: 'meeting-task', fingerprint: fingerprintJson(folded.task) },
      group: 'meeting-intake', attention: 'operator', disposition: 'itemized',
      reasonCode: taskAction.reasonCode, flags: [COMPLETE_READBACK_UNAVAILABLE],
      actions: [taskAction],
      privateDetailFingerprint: null, fingerprint: ZERO_FINGERPRINT
    },
    {
      id: 'row.meeting-intake.boundary', sequence: 3, representedCount: 1,
      subject: { kind: 'meeting-intake-boundary', fingerprint: fingerprintJson(notCreated) },
      group: 'meeting-intake', attention: 'operator', disposition: 'itemized',
      reasonCode: boundaryAction.reasonCode, flags: ['MEETING_LEGACY_EFFECTS_UNAVAILABLE'],
      actions: [boundaryAction], privateDetailFingerprint: null, fingerprint: ZERO_FINGERPRINT
    }
  ];
  rows.forEach((row) => { row.fingerprint = rowFingerprint(row); });
  const collectionId = 'collection.meeting-intake.changes';
  const summaryItem = privateItem(
    'review-item.meeting-intake.summary',
    'meeting-summary-create',
    [source(collectionId, rows[0])],
    [
      privateField('title', 'Summary title', 'text', summary.fields.title),
      privateField('documentType', 'Document type', 'text', summary.fields.documentType),
      privateField('description', 'Summary description', 'text', summary.fields.description),
      privateField('link', 'Source recording', 'text', summary.fields.link),
      privateField('body', 'Complete summary body', 'text', summary.body),
      privateField('projectIds', 'Related project identities', 'string-list', summary.projectIds),
      privateField('ourCommitments', 'Our commitments', 'string-list', summary.ourCommitments),
      privateField('theirCommitments', 'Their commitments', 'string-list', summary.theirCommitments),
      privateField(
        'completeGroupActionIds',
        'Exact complete-group action identities',
        'string-list',
        REQUIRED_ACTIONS
      )
    ]
  );
  const taskFields = folded.task.fields;
  const taskItem = privateItem(
    'review-item.meeting-intake.task-fold',
    'meeting-task-fold',
    [source(collectionId, rows[1])],
    [
      privateField('recordId', 'Existing task identity', 'text', folded.task.id),
      privateField('expectedVersion', 'Expected task version', 'text', folded.task.version),
      privateField('title', 'Task title', 'text', taskFields.title),
      privateField('status', 'Task status', 'text', taskFields.status),
      privateField('context', 'Task context', 'text', taskFields.context || ''),
      privateField('projectUris', 'Project identities', 'string-list', taskFields.projectUris || []),
      privateField('assigneeIds', 'Assignee identities', 'string-list', taskFields.assigneeIds || []),
      privateField('nextActionOn', 'Next action date', 'text', taskFields.nextActionOn || ''),
      privateField('sourceMeetingUris', 'Source meeting identities', 'string-list', folded.patch.sourceMeetingUris),
      privateField('sourceQuotes', 'Exact grounding excerpts', 'string-list', folded.patch.sourceQuotes),
      privateField('sourceSummaryFingerprints', 'Grounded summary fingerprints', 'string-list', folded.patch.sourceSummaryFingerprints),
      privateField(
        'completeGroupActionIds',
        'Exact complete-group action identities',
        'string-list',
        REQUIRED_ACTIONS
      )
    ]
  );
  const boundaryItem = privateItem(
    'review-item.meeting-intake.boundary',
    'meeting-intake-boundary',
    [source(collectionId, rows[2])],
    [privateField('notCreated', 'Deliberately not created', 'string-list', notCreated)]
  );
  rows[0].privateDetailFingerprint = summaryItem.fingerprint;
  rows[1].privateDetailFingerprint = taskItem.fingerprint;
  rows[2].privateDetailFingerprint = boundaryItem.fingerprint;
  const proposedChanges = [];
  const collection = {
    $contract: 'soter://contracts/prepared-work-review-collection/v1',
    contractVersion: '1.0.0',
    id: collectionId,
    kind: 'meeting-intake-changes',
    labelKey: 'meeting-intake-changes',
    coverage: {
      complete: true,
      observedCount: 3,
      includedCount: 3,
      excludedCount: 0,
      exclusions: []
    },
    rows,
    fingerprint: ZERO_FINGERPRINT
  };
  collection.fingerprint = collectionFingerprint(collection);
  const derivedReview = {
    kind: derivedReviewDefinition.kind,
    items: [summaryItem, taskItem, boundaryItem]
  };
  const facts = [
    { id: 'meeting-record', label: 'Source meeting fingerprint', value: decision.payload.meeting.recordFingerprint, state: 'supported', basisIds: [decision.context.snapshotId] },
    { id: 'meeting-age', label: 'Meeting age in days', value: decision.payload.meeting.ageDays, state: 'supported', basisIds: [decision.context.snapshotId] },
    { id: 'summary-segments', label: 'Grounded summary segments', value: decision.payload.summary.segmentReferences.length, state: 'supported', basisIds: [decision.payload.transcript.contextEntryId] },
    { id: 'project-attribution', label: 'Related project fingerprint', value: decision.payload.summary.project.recordFingerprint, state: 'supported', basisIds: [decision.context.snapshotId] },
    { id: 'existing-task-folds', label: 'Existing task folds', value: 1, state: 'supported', basisIds: [decision.context.snapshotId] }
  ];
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedReviewDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedReviewDefinition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const review = {
    $contract: 'soter://contracts/automation-review/v1',
    contractVersion: '1.0.0',
    kind: REVIEW_KIND,
    fingerprint: ZERO_FINGERPRINT,
    facts,
    contradictions: [],
    collections: [collection],
    privateReview,
    proposedChanges
  };
  const unsigned = structuredClone(review);
  delete unsigned.fingerprint;
  review.fingerprint = fingerprintJson(unsigned);
  return { review, derivedReview };
}

export function createMeetingIntakeProposal({
  root,
  lock,
  snapshot,
  run,
  decision,
  id,
  createdAt,
  producer,
  input = {}
}) {
  const resolvedRoot = path.resolve(root);
  assertMeetingIntakeDecision({ root: resolvedRoot, lock, snapshot, run, decision });
  if (decision.state !== 'ready') {
    throw new Error('Meeting Intake proposal requires one exact ready grounded decision.');
  }
  const declaration = loadAutomationProposalDeclaration(resolvedRoot, lock, AUTOMATION_ID);
  if (declaration.declaration.export !== 'createMeetingIntakeProposal') {
    throw codedError(
      'AUTOMATION_PROPOSAL_ADAPTER_INVALID',
      'Meeting Intake manifest does not select the exact pack-owned proposal builder.'
    );
  }
  assertInput(input, declaration.inputSchemaPath);
  const { review, derivedReview } = buildMeetingIntakeReview({
    decision,
    snapshot,
    derivedReviewDefinition: declaration.derivedReviewDefinition
  });
  const proposal = {
    $contract: 'soter://contracts/automation-proposal/v1',
    contractVersion: '1.0.0',
    id,
    automation: structuredClone(decision.automation),
    runId: decision.runId,
    createdAt: new Date(createdAt).toISOString(),
    configurationLockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint,
    decision: {
      id: decision.id,
      fingerprint: decision.decisionFingerprint,
      decisionType: decision.decisionType,
      contextSnapshotId: decision.context.snapshotId,
      contextSnapshotFingerprint: decision.context.snapshotFingerprint
    },
    producer: structuredClone(producer),
    state: 'ready-for-review',
    proposalType: PROPOSAL_TYPE,
    review,
    limitations: structuredClone(LIMITATIONS),
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_PROPOSAL_REVIEW_ONLY',
      permittedNextAction: 'inspect-private-proposal-material'
    },
    privacy: {
      scope: 'private-sanitized-proposal',
      rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false,
      privateValuesIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsWritten: false,
      externalWritesPerformed: false
    },
    proposalFingerprint: ZERO_FINGERPRINT
  };
  proposal.proposalFingerprint = automationProposalFingerprint(proposal);
  const material = {
    $contract: 'soter://contracts/automation-proposal-material/v1',
    contractVersion: '1.0.0',
    createdAt: proposal.createdAt,
    proposal: { id: proposal.id, fingerprint: proposal.proposalFingerprint },
    decision: { id: decision.id, fingerprint: decision.decisionFingerprint },
    automation: structuredClone(proposal.automation),
    configuration: {
      name: lock.configuration.name,
      lockFingerprint: proposal.configurationLockFingerprint,
      graphFingerprint: proposal.graphFingerprint
    },
    reviewContractId: declaration.derivedReviewDefinition.$contract,
    reviewContractFingerprint: fingerprintJson(declaration.derivedReviewDefinition),
    applicability: 'current',
    kind: derivedReview.kind,
    contentFingerprint: derivedReviewContentFingerprint(derivedReview),
    items: structuredClone(derivedReview.items),
    authority: { state: 'none', reasonCode: 'AUTOMATION_PROPOSAL_MATERIAL_REVIEW_ONLY' },
    privacy: {
      scope: 'private-local-automation-proposal',
      projection: 'selected-proposal-only',
      rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsIncluded: false
    },
    fingerprint: ZERO_FINGERPRINT
  };
  material.fingerprint = automationProposalMaterialFingerprint(material);
  validate(resolvedRoot, review, 'soter/contracts/automation-review.schema.json', 'Meeting Intake proposal review');
  validate(resolvedRoot, proposal, 'soter/contracts/automation-proposal.schema.json', 'Automation proposal');
  validate(resolvedRoot, proposal, declaration.declaration.schema, 'Meeting Intake proposal');
  validate(resolvedRoot, material, 'soter/contracts/automation-proposal-material.schema.json', 'Automation proposal material');
  assertAutomationReviewProjection({
    preview: review,
    derivedReview,
    automationPack: declaration.manifest,
    lock,
    derivedReviewDefinition: declaration.derivedReviewDefinition,
    invalid: (message) => codedError('AUTOMATION_PROPOSAL_BINDING_INVALID', message),
    materialInvalid: (code, message) => codedError('AUTOMATION_PROPOSAL_MATERIAL_' + code, message)
  });
  return { proposal, material };
}

export function inspectMeetingIntakeProposalDecision({ root, lockPath, decisionId, expectedHost }) {
  const exact = loadMeetingIntakeDecision({ root, lockPath, decisionId, expectedHost });
  if (exact.decision.state !== 'ready') {
    throw new Error('Meeting Intake proposal inspection requires a ready grounded decision.');
  }
  return {
    decision: {
      id: exact.decision.id,
      fingerprint: exact.decision.decisionFingerprint,
      state: exact.decision.state,
      ageState: exact.decision.payload.meeting.ageState,
      summarySegmentCount: exact.decision.payload.summary.segmentReferences.length,
      foldedTaskCount: exact.decision.payload.tasks.filter((task) => task.disposition === 'fold').length
    },
    inputTemplate: {},
    authority: { state: 'none', reasonCode: 'AUTOMATION_PROPOSAL_NOT_COMMITTED' }
  };
}

export function commitMeetingIntakeProposal({
  root,
  lockPath,
  decisionId,
  id,
  input = {},
  producer,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const exact = loadMeetingIntakeDecision({ root: resolvedRoot, lockPath, decisionId, expectedHost });
  const existing = hasAutomationProposalState(resolvedRoot, id)
    ? readAutomationProposalState(resolvedRoot, id).proposal
    : null;
  const { proposal, material } = createMeetingIntakeProposal({
    root: resolvedRoot,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    decision: exact.decision,
    id,
    createdAt: existing?.createdAt || at || new Date().toISOString(),
    producer,
    input
  });
  return commitDurableAutomationProposal({
    root: resolvedRoot,
    lockPath,
    decisionId,
    proposal,
    material,
    expectedHost
  });
}

export function loadMeetingIntakeProposal({ root, lockPath, proposalId, expectedHost }) {
  const exact = getExactDurableAutomationProposal({ root, lockPath, proposalId, expectedHost });
  if (exact.proposal.automation.id !== AUTOMATION_ID
    || exact.proposal.proposalType !== PROPOSAL_TYPE
    || exact.proposal.review.kind !== REVIEW_KIND) {
    throw codedError('AUTOMATION_PROPOSAL_BINDING_INVALID', 'Durable proposal is not a Meeting Intake proposal.');
  }
  let expected;
  try {
    expected = createMeetingIntakeProposal({
      root: path.resolve(root),
      lock: exact.lock,
      snapshot: exact.snapshot,
      run: exact.run,
      decision: exact.decision,
      id: exact.proposal.id,
      createdAt: exact.proposal.createdAt,
      producer: exact.proposal.producer,
      input: {}
    });
  } catch (error) {
    if (error?.code?.startsWith('AUTOMATION_PROPOSAL_')) throw error;
    throw codedError(
      'AUTOMATION_PROPOSAL_BINDING_INVALID',
      'Durable Meeting Intake proposal could not be reconstructed from its exact bindings.',
      error
    );
  }
  if (fingerprintJson(expected.proposal) !== fingerprintJson(exact.proposal)
    || fingerprintJson(expected.material) !== fingerprintJson(exact.material)) {
    throw codedError(
      'AUTOMATION_PROPOSAL_BINDING_INVALID',
      'Durable Meeting Intake proposal does not match its deterministic reconstruction.'
    );
  }
  return exact;
}

export function inspectMeetingIntakeProposalMaterial({ root, lockPath, proposalId, expectedHost }) {
  return structuredClone(loadMeetingIntakeProposal({ root, lockPath, proposalId, expectedHost }).material);
}
