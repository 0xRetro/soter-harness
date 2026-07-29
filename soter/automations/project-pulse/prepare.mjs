import path from 'node:path';

import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import {
  derivedReviewContentFingerprint,
  derivedReviewItemFingerprint
} from '../../core/review-projections.mjs';
import { analyzeProjectPulse } from './analysis.mjs';
import { assembleProjectPulseContext } from './context.mjs';
import {
  assertProjectWorkPolicySelection,
  loadProjectWorkPolicyDefinition
} from '../../contexts/projects/project-work-policy.mjs';

const AUTOMATION_ID = 'automation.project-pulse';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';
const DOCUMENT_ACTION = 'action.project-pulse.document-update';
const STATUS_ACTION = 'action.project-pulse.status-create';

function exactDerivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'project-pulse',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'project-pulse-derived-review') {
    throw new Error('Project Pulse derived review definition drifted from its Automation-owned contract.');
  }
  return definition;
}

function contextPlan(envelope, snapshot) {
  const labels = {
    'context.project-pulse.policy-selection': 'Load exact Projects policy',
    'context.project-pulse.project': 'Load selected project and task relations',
    'context.project-pulse.tasks': 'Load exact promoted tasks',
    'context.project-pulse.document': 'Load exact project milestone document'
  };
  return snapshot.entries.map((entry, index) => {
    const invocation = envelope.effects[index];
    return {
      id: 'preparation.context.' + String(index + 1),
      sequence: index + 1,
      label: labels[entry.id],
      capability: entry.capability,
      authority: entry.authority,
      containment: 'fixture',
      state: 'completed',
      inputFingerprint: invocation?.inputFingerprint || null,
      outputFingerprint: entry.valueFingerprint,
      limitation: 'This is a typed fixture read; it does not establish connected identity, reachability, permission, or write behavior.'
    };
  });
}

function exactEntry(snapshot, id) {
  const matches = snapshot.entries.filter((entry) => entry.id === id);
  if (matches.length !== 1 || matches[0].valueFingerprint !== fingerprintJson(matches[0].value)) {
    throw new Error('Project Pulse preparation requires one exact Context entry ' + id + '.');
  }
  return matches[0];
}

function privateField(id, label, type, reviewValue) {
  return { id, label, type, fingerprint: fingerprintJson(reviewValue), reviewValue };
}

function privateItem(id, kind, sources, fields) {
  const value = {
    id,
    kind,
    sources,
    fields,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  value.fingerprint = derivedReviewItemFingerprint(value);
  return value;
}

function reviewRowFingerprint(row) {
  const unsigned = structuredClone(row);
  delete unsigned.fingerprint;
  delete unsigned.privateDetailFingerprint;
  for (const action of unsigned.actions) delete action.changeFingerprint;
  return fingerprintJson(unsigned);
}

function reviewCollectionFingerprint(collection) {
  const unsigned = structuredClone(collection);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function issueCode(issue) {
  return issue.split(':')[0];
}

function contradictionFor(issue) {
  const code = issueCode(issue);
  const claims = {
    PROJECT_PROMOTED_TASKS_REQUIRED: 'A project status write requires exact promoted task observations.',
    PROJECT_WORK_ITEM_ACTION_AMBIGUOUS: 'Project work-item actions are not unique enough for exact task attribution.',
    PROJECT_PROMOTED_TASK_AMBIGUOUS: 'Multiple project tasks match one exact work-item action.',
    PROJECT_HEALTH_JUDGMENT_REQUIRED: 'Project health requires one exact governed operator judgment.',
    PROJECT_HEALTH_MILESTONE_REQUIRED: 'A risk judgment requires one or more exact affected milestones.',
    PROJECT_HEALTH_JUDGMENT_CONTRADICTED: 'The resulting exact milestone state contradicts the operator health judgment.',
    PROJECT_MILESTONE_HEALTH_CONTRADICTION: 'A blocked promoted task contradicts an on-track milestone judgment.',
    PROJECT_STATUS_DATE_INVALID: 'The status date is not one exact calendar date.',
    PROJECT_STATUS_VISIBILITY_INVALID: 'The requested visibility is outside the governed policy vocabulary.'
  };
  return {
    id: code.toLowerCase().replaceAll('_', '-'),
    claim: claims[code] || 'Project Pulse found a governed decision blocker.',
    state: 'observed',
    basisIds: [
      'context.project-pulse.policy-selection',
      'context.project-pulse.project',
      'context.project-pulse.tasks',
      'context.project-pulse.document'
    ]
  };
}

function action({ id, kind, capability, proposed, heldReason, readyReason }) {
  return {
    id,
    kind,
    capability,
    effect: 'write',
    state: proposed ? 'proposed' : 'held',
    reasonCode: proposed ? readyReason : heldReason,
    changeFingerprint: null
  };
}

function source(collectionId, row) {
  return {
    collectionId,
    rowId: row.id,
    rowFingerprint: row.fingerprint
  };
}

export function buildProjectPulseReview({ analysis, derivedReviewDefinition }) {
  const ready = analysis.state === 'ready';
  const heldReason = analysis.issues.length
    ? issueCode(analysis.issues[0])
    : 'PROJECT_WRITE_HELD';
  const requiredActionIds = ready
    ? [
        ...(analysis.document.changed ? [DOCUMENT_ACTION] : []),
        STATUS_ACTION
      ]
    : [];
  const documentAction = action({
    id: DOCUMENT_ACTION,
    kind: 'project-document-update',
    capability: 'documents.content.update',
    proposed: ready && analysis.document.changed,
    heldReason: ready ? 'PROJECT_MILESTONE_TAGS_CURRENT' : heldReason,
    readyReason: 'PROJECT_MILESTONE_UPDATE_READY_FOR_REVIEW'
  });
  const statusAction = action({
    id: STATUS_ACTION,
    kind: 'project-status-create',
    capability: 'projects.records.create',
    proposed: ready,
    heldReason,
    readyReason: 'PROJECT_STATUS_CREATE_READY_FOR_REVIEW'
  });
  const documentRow = {
    id: 'row.project-pulse.document',
    sequence: 1,
    representedCount: 1,
    subject: {
      kind: 'project-document',
      fingerprint: analysis.document.expectedBodyFingerprint
    },
    group: 'project-pulse',
    attention: 'operator',
    disposition: 'itemized',
    reasonCode: documentAction.reasonCode,
    flags: ready ? [] : analysis.issues.map(issueCode),
    actions: [documentAction],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  const statusRow = {
    id: 'row.project-pulse.status',
    sequence: 2,
    representedCount: 1,
    subject: {
      kind: 'project-status',
      fingerprint: analysis.status.afterFingerprint
    },
    group: 'project-pulse',
    attention: 'operator',
    disposition: 'itemized',
    reasonCode: statusAction.reasonCode,
    flags: ready ? [] : analysis.issues.map(issueCode),
    actions: [statusAction],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  documentRow.fingerprint = reviewRowFingerprint(documentRow);
  statusRow.fingerprint = reviewRowFingerprint(statusRow);
  const collectionId = 'collection.project-pulse.changes';
  const updates = analysis.document.updates;
  const documentItem = privateItem(
    'review-item.project-pulse.document',
    'project-document-update',
    [source(collectionId, documentRow)],
    [
      privateField('uri', 'Project document identity', 'text', analysis.document.uri),
      privateField('expectedTitle', 'Expected project title', 'text', analysis.document.title),
      privateField(
        'expectedBodyFingerprint',
        'Current document fingerprint',
        'text',
        analysis.document.expectedBodyFingerprint
      ),
      privateField(
        'afterBodyFingerprint',
        'Expected document fingerprint',
        'text',
        analysis.document.afterBodyFingerprint
      ),
      privateField('updateIds', 'Milestone change identities', 'string-list', updates.map((item) => item.id)),
      privateField('oldTexts', 'Current milestone lines', 'string-list', updates.map((item) => item.oldText)),
      privateField('newTexts', 'Proposed milestone lines', 'string-list', updates.map((item) => item.newText)),
      privateField('batchActionIds', 'Required exact batch actions', 'string-list', requiredActionIds)
    ]
  );
  const statusFields = analysis.status.fields;
  const statusItem = privateItem(
    'review-item.project-pulse.status',
    'project-status-create',
    [source(collectionId, statusRow)],
    [
      privateField('headline', 'Status headline', 'text', statusFields.headline),
      privateField('category', 'Update category', 'text', statusFields.category),
      privateField('date', 'Status date', 'text', statusFields.date),
      privateField('summary', 'Status summary', 'text', statusFields.summary),
      privateField('processed', 'Processed', 'boolean', statusFields.processed),
      privateField('visibility', 'Visibility', 'text', statusFields.visibility),
      privateField('projectIds', 'Project identities', 'string-list', statusFields.projectIds),
      privateField('batchActionIds', 'Required exact batch actions', 'string-list', requiredActionIds)
    ]
  );
  documentRow.privateDetailFingerprint = documentItem.fingerprint;
  statusRow.privateDetailFingerprint = statusItem.fingerprint;
  const proposedChanges = [];
  if (documentAction.state === 'proposed') {
    const change = {
      id: documentAction.id,
      recordId: 'document:' + fingerprintJson(analysis.document.uri).slice(7, 23),
      effect: documentAction.capability,
      beforeFingerprint: analysis.document.expectedBodyFingerprint,
      afterFingerprint: documentItem.fingerprint
    };
    documentAction.changeFingerprint = fingerprintJson(change);
    proposedChanges.push(change);
  }
  if (statusAction.state === 'proposed') {
    const change = {
      id: statusAction.id,
      recordId: 'new:project-status:' + analysis.status.afterFingerprint.slice(7, 23),
      effect: statusAction.capability,
      beforeFingerprint: null,
      afterFingerprint: statusItem.fingerprint
    };
    statusAction.changeFingerprint = fingerprintJson(change);
    proposedChanges.push(change);
  }
  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: collectionId,
    kind: 'project-pulse-changes',
    labelKey: 'project-pulse-changes',
    coverage: {
      complete: true,
      observedCount: 2,
      includedCount: 2,
      excludedCount: 0,
      exclusions: []
    },
    rows: [documentRow, statusRow],
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  collection.fingerprint = reviewCollectionFingerprint(collection);
  const derivedReview = {
    kind: derivedReviewDefinition.kind,
    items: [documentItem, statusItem]
  };
  const facts = [
    {
      id: 'project-record',
      label: 'Project record fingerprint',
      value: analysis.project.fingerprint,
      state: 'supported',
      basisIds: ['context.project-pulse.project']
    },
    {
      id: 'promoted-task-count',
      label: 'Promoted tasks reviewed',
      value: analysis.tasks.total,
      state: analysis.tasks.total ? 'supported' : 'unavailable',
      basisIds: ['context.project-pulse.tasks', 'context.project-pulse.document']
    },
    {
      id: 'promoted-task-completion',
      label: 'Promoted task completion',
      value: analysis.tasks.completionPercent,
      state: analysis.tasks.completionPercent === null ? 'unavailable' : 'supported',
      basisIds: ['context.project-pulse.tasks', 'context.project-pulse.document']
    },
    {
      id: 'milestone-count',
      label: 'Milestones reviewed',
      value: analysis.milestones.length,
      state: analysis.milestones.length ? 'supported' : 'unavailable',
      basisIds: ['context.project-pulse.document']
    },
    {
      id: 'project-health',
      label: 'Operator health judgment checked',
      value: analysis.health.state,
      state: analysis.health.state === 'unavailable' ? 'unavailable' : 'supported',
      basisIds: ['context.project-pulse.policy-selection', 'context.project-pulse.tasks', 'context.project-pulse.document']
    },
    {
      id: 'milestone-change-count',
      label: 'Milestone changes proposed',
      value: analysis.document.updates.length,
      state: ready ? 'supported' : 'unavailable',
      basisIds: ['context.project-pulse.document']
    }
  ];
  const contradictions = [
    ...analysis.issues.map(contradictionFor),
    ...(analysis.health.contradicted ? [{
      id: 'requested-health-contradicted',
      claim: 'The required operator health judgment conflicts with exact promoted-task or milestone state.',
      state: 'observed',
      basisIds: ['context.project-pulse.policy-selection', 'context.project-pulse.tasks', 'context.project-pulse.document']
    }] : [])
  ];
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedReviewDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedReviewDefinition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'project-pulse-preview',
    fingerprint: null,
    facts,
    contradictions,
    collections: [collection],
    privateReview,
    proposedChanges
  };
  preview.fingerprint = fingerprintJson({
    kind: preview.kind,
    facts,
    contradictions,
    collections: preview.collections,
    privateReview,
    proposedChanges
  });
  return { preview, derivedReview };
}

export function analyzeProjectPulseSnapshot({ root, snapshot, input }) {
  const definition = loadProjectWorkPolicyDefinition(root);
  const policyEntry = exactEntry(snapshot, 'context.project-pulse.policy-selection');
  const policy = assertProjectWorkPolicySelection(policyEntry.value, definition, {
    requireProjectedRules: snapshot.containment === 'fixture'
  });
  const projectEntry = exactEntry(snapshot, 'context.project-pulse.project');
  const taskEntry = exactEntry(snapshot, 'context.project-pulse.tasks');
  const documentEntry = exactEntry(snapshot, 'context.project-pulse.document');
  if (projectEntry.value.records?.length !== 1) {
    throw new Error('Project Pulse snapshot requires one exact project record.');
  }
  return analyzeProjectPulse({
    policy: policy.fields,
    project: projectEntry.value.records[0],
    tasks: taskEntry.value.records || [],
    document: documentEntry.value.document,
    statusDate: input.statusDate,
    visibility: input.visibility,
    health: input.health,
    healthMilestones: input.healthMilestones || []
  });
}

export async function prepareProjectPulseRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt
}) {
  const runId = 'run.' + workId.slice('work.'.length);
  const snapshotId = 'context.' + workId.slice('work.'.length);
  const execution = await assembleProjectPulseContext({
    root,
    lock,
    lockPath,
    scenarioPath: null,
    runId,
    snapshotId,
    projectId: input.project,
    createdAt,
    evidenceIds: []
  });
  const analysis = analyzeProjectPulseSnapshot({ root, snapshot: execution.snapshot, input });
  const derivedReviewDefinition = exactDerivedReviewDefinition(root);
  const { preview, derivedReview } = buildProjectPulseReview({
    analysis,
    derivedReviewDefinition
  });
  return {
    envelope: execution.envelope,
    snapshot: execution.snapshot,
    contextPlan: contextPlan(execution.envelope, execution.snapshot),
    outcomes: [
      {
        id: 'project-status-preview',
        label: 'Grounded project status preview',
        state: analysis.state === 'ready' ? 'supported' : 'blocked',
        basis: [
          'context.project-pulse.policy-selection',
          'context.project-pulse.project',
          'context.project-pulse.tasks',
          'context.project-pulse.document'
        ],
        limitation: 'Private fixture review does not create an approval, connected request, or status record.'
      },
      {
        id: 'milestone-review',
        label: 'Exact milestone replacement review',
        state: analysis.milestones.length ? 'supported' : 'blocked',
        basis: [
          'context.project-pulse.policy-selection',
          'context.project-pulse.project',
          'context.project-pulse.tasks',
          'context.project-pulse.document'
        ],
        limitation: 'Milestone progress is derived from exact work-item/task matches while health remains a checked human judgment.'
      },
      {
        id: 'transaction-boundary',
        label: 'Status and milestone writes held behind one exact batch',
        state: analysis.state === 'ready' ? 'supported' : 'blocked',
        basis: preview.facts.flatMap((item) => item.basisIds),
        limitation: analysis.issues.length
          ? analysis.issues.map(issueCode).join(', ') + ' blocks every write proposal.'
          : 'Preparation grants no write authority; proposal, exact selection, confirmation, one-time start, checkpoint, and verification remain separate.'
      }
    ],
    preview,
    derivedReview
  };
}
