import path from 'node:path';

import { invokeCapability } from '../../core/capabilities.mjs';
import { exactRequestedContextRecord } from '../../core/context-records.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import {
  derivedReviewContentFingerprint,
  derivedReviewItemFingerprint
} from '../../core/review-projections.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';
import {
  assertTaskWorkPolicySelection,
  loadTaskWorkPolicyDefinition
} from '../../contexts/tasks/task-work-policy.mjs';

const AUTOMATION_ID = 'automation.task-capture';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';

function exactDerivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'task-capture',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'task-capture-derived-review') {
    throw new Error('Task Capture derived review definition drifted from its Automation-owned contract.');
  }
  return definition;
}

function authority(lock, role, subject = 'tasks.records') {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error(
      'Task Capture requires one exact ' + role + ' authority for ' + subject + '.'
    );
  }
  return matches[0].id;
}

function policySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === 'task-work-policy';
  }));
  if (matches.length !== 1) {
    throw new Error('Task Capture requires exactly one configured task-work-policy source.');
  }
  const source = matches[0];
  if (source.capability !== 'tasks.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || fingerprintJson(source.input.recordTypes) !== fingerprintJson(['task-work-policy'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 1) {
    throw new Error('Task Capture policy source must be one exact typed definition-authority record read.');
  }
  return source;
}

async function readFixture({
  root,
  lock,
  capability = 'tasks.records.read',
  authorityId,
  input,
  effectId,
  at
}) {
  const result = await invokeCapability({
    root,
    lock,
    capability,
    authority: authorityId,
    containment: 'fixture',
    input,
    effectId,
    at
  });
  if (result.invocation.state !== 'passed') {
    throw new Error('Task Capture contained read did not pass: ' + effectId + '.');
  }
  return result;
}

function snapshotEntry({ id, subject, authorityId, role, result, value = result.output }) {
  return {
    id,
    subject,
    authority: authorityId,
    role,
    capability: result.invocation.capability,
    providerPack: result.invocation.providerPack,
    providerImplementation: result.invocation.providerImplementation,
    providerVersion: result.invocation.providerVersion,
    observedAt: result.output.observedAt,
    freshness: 'passed',
    provenance: result.output.provenance,
    valueFingerprint: fingerprintJson(value),
    value
  };
}

function contextStep(entry, invocation, sequence) {
  const labels = {
    'context.task-capture.policy': 'Load exact task-capture policy',
    'context.task-capture.project': 'Resolve exact project',
    'context.task-capture.identity': 'Resolve authenticated current-user identity',
    'context.task-capture.duplicates': 'Inspect bounded duplicate candidates'
  };
  return {
    id: 'preparation.context.' + String(sequence),
    sequence,
    label: labels[entry.id],
    capability: entry.capability,
    authority: entry.authority,
    containment: 'fixture',
    state: 'completed',
    inputFingerprint: invocation.inputFingerprint,
    outputFingerprint: entry.valueFingerprint,
    limitation: 'This is a typed fixture read; it does not establish connected identity, reachability, permission, or write behavior.'
  };
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

export function buildTaskCapturePreview({
  input,
  policy,
  project,
  assigneeIds,
  duplicateIds,
  derivedReviewDefinition
}) {
  const selectedContext = input.context || 'Project';
  const contradictions = [];
  if (selectedContext !== 'Project') {
    contradictions.push({
      id: 'project-context-conflict',
      claim: 'A task linked to the resolved project must use the Project context classification.',
      state: 'observed',
      basisIds: ['context.task-capture.policy', 'context.task-capture.project']
    });
  }
  if (duplicateIds.length) {
    contradictions.push({
      id: 'duplicate-candidates-observed',
      claim: 'An exact-title task candidate exists and must be reviewed instead of silently creating a duplicate.',
      state: 'observed',
      basisIds: ['context.task-capture.duplicates']
    });
  }
  const taskFields = {
    title: input.title,
    status: policy.fields.defaultStatus,
    context: selectedContext,
    projectUris: [project.id],
    ...(assigneeIds.length ? { assigneeIds } : {}),
    ...(input.nextActionOn ? { nextActionOn: input.nextActionOn } : {})
  };
  const taskFingerprint = fingerprintJson({ recordType: 'task', fields: taskFields });
  const flags = [];
  if (selectedContext !== 'Project') flags.push('TASK_PROJECT_CONTEXT_REQUIRED');
  if (duplicateIds.length) flags.push('TASK_DUPLICATE_CANDIDATE_OBSERVED');
  const proposed = contradictions.length === 0;
  const reasonCode = proposed
    ? 'TASK_CREATE_READY_FOR_REVIEW'
    : duplicateIds.length
      ? 'TASK_CREATE_HELD_FOR_DUPLICATE_REVIEW'
      : 'TASK_CREATE_HELD_FOR_CONTEXT_REVIEW';
  const action = {
    id: 'action.task-capture.create',
    kind: 'task-create',
    capability: 'tasks.records.create',
    effect: 'write',
    state: proposed ? 'proposed' : 'held',
    reasonCode,
    changeFingerprint: null
  };
  const row = {
    id: 'row.task-capture.task',
    sequence: 1,
    representedCount: 1,
    subject: {
      kind: 'crm-task',
      fingerprint: taskFingerprint
    },
    group: 'task-capture',
    attention: 'operator',
    disposition: 'itemized',
    reasonCode,
    flags,
    actions: [action],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  row.fingerprint = reviewRowFingerprint(row);
  const source = {
    collectionId: 'collection.task-capture.task',
    rowId: row.id,
    rowFingerprint: row.fingerprint
  };
  const taskItem = privateItem(
    'review-item.task-capture.task',
    'task-create',
    [source],
    [
      privateField('title', 'Task title', 'text', taskFields.title),
      privateField('status', 'Task status', 'text', taskFields.status),
      privateField('context', 'Task context', 'text', taskFields.context),
      privateField('projectUris', 'Project identities', 'string-list', taskFields.projectUris),
      privateField('assigneeIds', 'Assignee identities', 'string-list', taskFields.assigneeIds || []),
      privateField(
        'nextActionOn',
        'Next action date',
        'string-list',
        taskFields.nextActionOn ? [taskFields.nextActionOn] : []
      )
    ]
  );
  row.privateDetailFingerprint = taskItem.fingerprint;
  const proposedChanges = [];
  if (proposed) {
    const change = {
      id: action.id,
      recordId: 'new:task:' + taskFingerprint.slice('sha256:'.length, 'sha256:'.length + 16),
      effect: 'tasks.records.create',
      beforeFingerprint: null,
      afterFingerprint: taskItem.fingerprint
    };
    action.changeFingerprint = fingerprintJson(change);
    proposedChanges.push(change);
  }
  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: source.collectionId,
    kind: 'task-capture-task',
    labelKey: 'task-capture-task',
    coverage: {
      complete: true,
      observedCount: 1,
      includedCount: 1,
      excludedCount: 0,
      exclusions: []
    },
    rows: [row],
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  collection.fingerprint = reviewCollectionFingerprint(collection);
  const derivedReview = {
    kind: derivedReviewDefinition.kind,
    items: [taskItem]
  };
  const facts = [
    {
      id: 'policy-identity',
      label: 'Task policy',
      value: policy.fields.name,
      state: 'supported',
      basisIds: ['context.task-capture.policy']
    },
    {
      id: 'project-identity',
      label: 'Resolved project',
      value: project.id,
      state: 'supported',
      basisIds: ['context.task-capture.project']
    },
    {
      id: 'default-status',
      label: 'Create status',
      value: policy.fields.defaultStatus,
      state: 'supported',
      basisIds: ['context.task-capture.policy']
    },
    {
      id: 'task-context',
      label: 'Task context',
      value: selectedContext,
      state: selectedContext === 'Project' ? 'supported' : 'contradicted',
      basisIds: ['context.task-capture.policy', 'context.task-capture.project']
    },
    {
      id: 'duplicate-candidate-count',
      label: 'Duplicate candidates',
      value: duplicateIds.length,
      state: duplicateIds.length ? 'contradicted' : 'supported',
      basisIds: ['context.task-capture.duplicates']
    },
    {
      id: 'next-action-pinned',
      label: 'Next action pinned',
      value: Boolean(input.nextActionOn),
      state: 'supported',
      basisIds: ['context.task-capture.policy']
    },
    {
      id: 'assignee-reference-bound',
      label: 'Assignee identity resolved',
      value: assigneeIds.length === 1,
      state: assigneeIds.length ? 'supported' : 'unavailable',
      basisIds: assigneeIds.length
        ? ['context.task-capture.policy', 'context.task-capture.identity']
        : ['context.task-capture.policy']
    }
  ];
  const collections = [collection];
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedReviewDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedReviewDefinition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'task-capture-preview',
    fingerprint: null,
    facts,
    contradictions,
    collections,
    privateReview,
    proposedChanges
  };
  preview.fingerprint = fingerprintJson({
    kind: preview.kind,
    facts,
    contradictions,
    collections,
    privateReview,
    proposedChanges
  });
  return { preview, derivedReview, taskFingerprint };
}

export async function prepareTaskCaptureRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  const derivedReviewDefinition = exactDerivedReviewDefinition(root);
  const taskPolicyDefinition = loadTaskWorkPolicyDefinition(root);
  if (input.assignee !== undefined && input.assignee !== 'self') {
    throw new Error(
      'Task Capture assignee must be omitted or resolved from the authenticated current user.'
    );
  }
  const definitionAuthority = authority(lock, 'definition');
  const taskAuthority = authority(lock, 'instance');
  const projectAuthority = authority(lock, 'instance', 'projects.records');
  const providerAuthority = authority(lock, 'provider', 'notion.workspace');
  const source = policySource(lock, definitionAuthority);
  const runId = 'run.' + workId.slice('work.'.length);
  const snapshotId = 'context.' + workId.slice('work.'.length);
  const envelope = prepareRunEnvelope({
    root,
    lock,
    lockPath,
    scenarioPath,
    automationId: AUTOMATION_ID,
    runId,
    createdAt,
    requestedOutcome: 'Prepare one exact task-create review and stop before change-set issuance, approval, or provider writes.',
    evidenceIds: []
  });

  const policyResult = await readFixture({
    root,
    lock,
    authorityId: definitionAuthority,
    input: source.input,
    effectId: 'effect.task-capture.preparation.policy.fixture',
    at: createdAt
  });
  const policy = assertTaskWorkPolicySelection(
    policyResult.output,
    taskPolicyDefinition,
    { requireProjectedRules: true }
  );
  const projectResult = await readFixture({
    root,
    lock,
    capability: 'projects.records.read',
    authorityId: projectAuthority,
    input: { recordTypes: ['project'], ids: [input.project], limit: 2 },
    effectId: 'effect.task-capture.preparation.project.fixture',
    at: createdAt
  });
  const project = exactRequestedContextRecord(projectResult.output, {
    recordType: 'project',
    requestedId: input.project
  });
  const identityResult = input.assignee === 'self'
    ? await readFixture({
      root,
      lock,
      capability: 'workspace.identity.read',
      authorityId: providerAuthority,
      input: { identity: 'current-user' },
      effectId: 'effect.task-capture.preparation.identity.fixture',
      at: createdAt
    })
    : null;
  const assigneeIds = identityResult
    ? [identityResult.output.identity.providerPersonId]
    : [];
  const duplicateResult = await readFixture({
    root,
    lock,
    authorityId: taskAuthority,
    input: {
      recordTypes: ['task'],
      filters: { title: input.title },
      limit: policy.fields.duplicateCandidateLimit
    },
    effectId: 'effect.task-capture.preparation.duplicates.fixture',
    at: createdAt
  });
  const duplicateIds = duplicateResult.output.records
    .filter((record) => record.type === 'task')
    .map((record) => record.id)
    .sort();
  const duplicateValue = {
    candidateCount: duplicateIds.length,
    candidateIds: duplicateIds,
    providerOutputFingerprint: duplicateResult.invocation.outputFingerprint
  };
  const acquired = [
    {
      result: policyResult,
      entry: snapshotEntry({
        id: 'context.task-capture.policy',
        subject: 'tasks.records.task-work-policy',
        authorityId: definitionAuthority,
        role: 'definition',
        result: policyResult
      })
    },
    {
      result: projectResult,
      entry: snapshotEntry({
        id: 'context.task-capture.project',
        subject: 'projects.records.project',
        authorityId: projectAuthority,
        role: 'instance',
        result: projectResult
      })
    },
    ...(identityResult ? [{
      result: identityResult,
      entry: snapshotEntry({
        id: 'context.task-capture.identity',
        subject: 'notion.workspace.current-user',
        authorityId: providerAuthority,
        role: 'provider',
        result: identityResult
      })
    }] : []),
    {
      result: duplicateResult,
      entry: snapshotEntry({
        id: 'context.task-capture.duplicates',
        subject: 'tasks.records.task-candidates',
        authorityId: taskAuthority,
        role: 'instance',
        result: duplicateResult,
        value: duplicateValue
      })
    }
  ];
  const entries = acquired.map((item) => item.entry);
  const effects = acquired.map((item) => item.result.invocation);
  const snapshot = {
    $contract: 'soter://contracts/context-snapshot/v1',
    contractVersion: '1.0.0',
    id: snapshotId,
    runId,
    createdAt,
    configurationLockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint,
    containment: 'fixture',
    entries,
    effectIds: effects.map((effect) => effect.id),
    privacy: {
      scope: 'private',
      redactions: [
        'Provider credentials, raw private inputs, and duplicate candidate field values are excluded.'
      ]
    }
  };
  const grouped = new Map();
  for (const entry of entries) {
    const current = grouped.get(entry.authority) || [];
    current.push(entry.valueFingerprint);
    grouped.set(entry.authority, current);
  }
  envelope.context = envelope.context.map((item) => {
    const fingerprints = grouped.get(item.authority);
    if (!fingerprints) return item;
    return {
      ...item,
      status: 'loaded',
      provenance: 'fixture:' + fingerprintJson(fingerprints),
      freshness: 'passed'
    };
  });
  envelope.lifecycleState = 'paused';
  envelope.checkpoints = [
    { id: 'effects-established', state: 'passed', details: 'Read and disclosure policies were evaluated before each fixture invocation.' },
    { id: 'task-create-review-grounded', state: 'passed', details: 'The exact policy, project, and bounded duplicate candidates were loaded without retaining raw private input values.' },
    { id: 'write-boundary-held', state: 'passed', details: 'No change set, approval request, continuation request, provider call, or canonical write was issued.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;

  const { preview, derivedReview } = buildTaskCapturePreview({
    input,
    policy,
    project,
    assigneeIds,
    duplicateIds,
    derivedReviewDefinition
  });
  const proposed = preview.proposedChanges.length === 1;
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      {
        id: 'task-policy-grounded',
        label: 'Exact task-capture policy grounded',
        state: 'supported',
        basis: ['context.task-capture.policy'],
        limitation: 'The external policy identity matches one governed Context definition; this fixture does not establish connected provider conformance.'
      },
      {
        id: 'task-project-resolved',
        label: 'Exact project relation resolved',
        state: 'supported',
        basis: ['context.task-capture.project'],
        limitation: 'Fixture identity does not establish connected access to the provider record.'
      },
      {
        id: 'task-create-preview',
        label: 'Task create scope prepared for review',
        state: proposed ? 'proposed' : 'blocked',
        basis: ['context.task-capture.policy', 'context.task-capture.project', 'context.task-capture.duplicates'],
        limitation: proposed
          ? 'This is a fingerprint-only preview. A selected private review can compile an authority-free review-only candidate preview, but approval, execution, and connected verification remain separate.'
          : 'A context conflict or duplicate candidate prevents a task-create proposal.'
      }
    ],
    preview,
    derivedReview
  };
}
