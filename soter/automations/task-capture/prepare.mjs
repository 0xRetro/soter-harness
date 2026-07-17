import { invokeCapability } from '../../core/capabilities.mjs';
import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';

const AUTOMATION_ID = 'automation.task-capture';

function authority(lock, role) {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === 'crm.records';
  });
  if (matches.length !== 1) {
    throw new Error('Task Capture requires one exact ' + role + ' CRM authority.');
  }
  return matches[0].id;
}

function policySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === 'task-capture-policy';
  }));
  if (matches.length !== 1) {
    throw new Error('Task Capture requires exactly one configured task-capture-policy source.');
  }
  const source = matches[0];
  if (source.capability !== 'crm.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || fingerprintJson(source.input.recordTypes) !== fingerprintJson(['task-capture-policy'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 1) {
    throw new Error('Task Capture policy source must be one exact typed definition-authority record read.');
  }
  return source;
}

async function readFixture({ root, lock, authorityId, input, effectId, at }) {
  const result = await invokeCapability({
    root,
    lock,
    capability: 'crm.records.read',
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

function exactPolicy(result) {
  const records = result.output.records.filter((record) => record.type === 'task-capture-policy');
  if (records.length !== 1) {
    throw new Error('Task Capture requires one exact normalized task-capture-policy record.');
  }
  const policy = records[0];
  const fields = policy.fields;
  if (fields.name !== 'Tasks'
    || fields.createRequiresConfirmation !== true
    || !Number.isInteger(fields.duplicateCandidateLimit)
    || fields.duplicateCandidateLimit < 1
    || fields.duplicateCandidateLimit > 25
    || fingerprintJson(fields.duplicateKeyFields) !== fingerprintJson(['title'])
    || typeof fields.defaultStatus !== 'string'
    || !fields.defaultStatus.trim()
    || !Array.isArray(fields.allowedContexts)
    || !fields.allowedContexts.includes('Project')
    || new Set(fields.allowedContexts).size !== fields.allowedContexts.length
    || fields.projectRequired !== true) {
    throw new Error('Task Capture policy is missing the exact bounded create rules required by the Automation.');
  }
  return policy;
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

function taskPreview({ input, policy, project, duplicateIds }) {
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
    ...(input.assignee ? { assigneeIds: [input.assignee] } : {}),
    ...(input.nextActionOn ? { nextActionOn: input.nextActionOn } : {})
  };
  const taskFingerprint = fingerprintJson({ recordType: 'task', fields: taskFields });
  const proposedChanges = contradictions.length ? [] : [{
    id: 'change.task-capture.create',
    recordId: 'new:task:' + taskFingerprint.slice('sha256:'.length, 'sha256:'.length + 16),
    effect: 'crm.records.create',
    beforeFingerprint: null,
    afterFingerprint: taskFingerprint
  }];
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
      label: 'Assignee reference bound',
      value: Boolean(input.assignee),
      state: input.assignee ? 'supported' : 'unavailable',
      basisIds: ['context.task-capture.policy']
    }
  ];
  const collections = [];
  const privateReview = {
    state: 'unavailable', kind: null, contractId: null,
    contractFingerprint: null, contentFingerprint: null
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
  return { preview, taskFingerprint };
}

export async function prepareTaskCaptureRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt
}) {
  const definitionAuthority = authority(lock, 'definition');
  const instanceAuthority = authority(lock, 'instance');
  const source = policySource(lock, definitionAuthority);
  const runId = 'run.' + workId.slice('work.'.length);
  const snapshotId = 'context.' + workId.slice('work.'.length);
  const envelope = prepareRunEnvelope({
    root,
    lock,
    lockPath,
    scenarioPath: null,
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
  const policy = exactPolicy(policyResult);
  const projectResult = await readFixture({
    root,
    lock,
    authorityId: instanceAuthority,
    input: { recordTypes: ['project'], ids: [input.project], limit: 2 },
    effectId: 'effect.task-capture.preparation.project.fixture',
    at: createdAt
  });
  const projects = projectResult.output.records.filter((record) => record.type === 'project');
  if (projects.length !== 1 || projects[0].id !== input.project) {
    throw new Error('Task Capture requires one exact project record matching the operator reference.');
  }
  const duplicateResult = await readFixture({
    root,
    lock,
    authorityId: instanceAuthority,
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
        subject: 'crm.records.task-capture-policy',
        authorityId: definitionAuthority,
        role: 'definition',
        result: policyResult
      })
    },
    {
      result: projectResult,
      entry: snapshotEntry({
        id: 'context.task-capture.project',
        subject: 'crm.records.project',
        authorityId: instanceAuthority,
        role: 'instance',
        result: projectResult
      })
    },
    {
      result: duplicateResult,
      entry: snapshotEntry({
        id: 'context.task-capture.duplicates',
        subject: 'crm.records.task-candidates',
        authorityId: instanceAuthority,
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

  const { preview } = taskPreview({ input, policy, project: projects[0], duplicateIds });
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
        limitation: 'The fixture supplies normalized policy facts; the connected Notion policy body is not yet a trusted structured projection.'
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
          ? 'This is a fingerprint-only property preview. A later exact operation batch requires separate approval and connected verification.'
          : 'A context conflict or duplicate candidate prevents a task-create proposal.'
      }
    ],
    preview
  };
}
