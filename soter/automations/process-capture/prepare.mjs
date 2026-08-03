import path from 'node:path';

import { invokeCapability } from '../../core/capabilities.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import {
  derivedReviewContentFingerprint,
  derivedReviewItemFingerprint
} from '../../core/review-projections.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';
import {
  assertProcessCapturePolicySelection,
  assertProcessSchema,
  buildCapturedProcessBody,
  exactCurrentProcessOption,
  loadProcessCapturePolicy
} from '../../contexts/process/process-capture.mjs';

const AUTOMATION_ID = 'automation.process-capture';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inputInvalid(message) {
  const error = new Error(message);
  error.code = 'PREPARATION_INPUT_INVALID';
  throw error;
}

function derivedReviewDefinition(root) {
  const definition = readJson(path.join(root, 'soter', 'automations', 'process-capture', 'derived-review.json'));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'process-capture-derived-review') {
    throw new Error('Process Capture derived review definition drifted from its Automation-owned contract.');
  }
  return definition;
}

function authority(lock, role, subject) {
  const matches = lock.authorities.filter((item) => item.role === role && item.subject === subject);
  if (matches.length !== 1) {
    throw new Error('Process Capture requires one exact ' + role + ' authority for ' + subject + '.');
  }
  return matches[0].id;
}

function policySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === 'process-capture-policy';
  }));
  if (matches.length !== 1) {
    throw new Error('Process Capture requires exactly one configured process-capture-policy source.');
  }
  const source = matches[0];
  if (source.capability !== 'process.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)) {
    throw new Error('Process Capture policy source must be one exact typed definition-authority read.');
  }
  return source;
}

async function readFixture({ root, lock, capability, authorityId, input, effectId, at }) {
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
    throw new Error('Process Capture contained read did not pass: ' + effectId + '.');
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
    'context.process-capture.policy': 'Load exact process-capture policy selection',
    'context.process-capture.schema': 'Read current configured Process schema',
    'context.process-capture.candidates': 'Inspect bounded exact-name process candidates',
    'context.process-capture.roles': 'Resolve every exact process role identity',
    'context.process-capture.service': 'Resolve the optional related service identity'
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
    limitation: 'This typed fixture read does not establish connected identity, reachability, permission, provider conformance, write verification, readiness, or health.'
  };
}

function privateField(id, label, type, reviewValue) {
  return { id, label, type, fingerprint: fingerprintJson(reviewValue), reviewValue };
}

function privateItem(id, kind, sources, fields) {
  const value = { id, kind, sources, fields, fingerprint: 'sha256:' + '0'.repeat(64) };
  value.fingerprint = derivedReviewItemFingerprint(value);
  return value;
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

function contradiction(id, claim, basisIds) {
  return { id, claim, state: 'observed', basisIds };
}

function syntheticId(fingerprint) {
  return 'new:process:' + fingerprint.slice('sha256:'.length, 'sha256:'.length + 16);
}

function exactMatches(records, type, names) {
  const matches = new Map();
  for (const name of names) {
    const normalized = name.trim().toLocaleLowerCase('en');
    const candidates = records.filter((record) => {
      return record.type === type
        && typeof record.fields?.name === 'string'
        && record.fields.name.trim().toLocaleLowerCase('en') === normalized;
    });
    matches.set(name, candidates);
  }
  return matches;
}

function validateParallelInput(input, policy) {
  const count = input.stepObjectives.length;
  for (const [label, values] of [
    ['stepRoles', input.stepRoles],
    ['stepCapabilities', input.stepCapabilities],
    ['workItems', input.workItems]
  ]) {
    if (values.length !== count) inputInvalid(label + ' must match stepObjectives length.');
  }
  if (input.triggerKinds.length !== input.triggers.length) {
    inputInvalid('triggerKinds must match triggers length.');
  }
  if (count > policy.maximumSteps) inputInvalid('Process input exceeds the governed maximum step count.');
}

export function buildProcessCapturePreview({
  input,
  policy,
  schemaState,
  duplicateIds,
  roleMatches,
  serviceMatches,
  derivedDefinition
}) {
  const frequency = exactCurrentProcessOption(input.frequency, schemaState.byId.get('frequency'), policy.frequencyAliases);
  const category = input.category
    ? exactCurrentProcessOption(input.category, schemaState.byId.get('category'), policy.categoryAliases)
    : null;
  const tags = (input.tags || []).map((tag) => exactCurrentProcessOption(tag, schemaState.byId.get('tags')));
  const status = exactCurrentProcessOption(policy.defaultStatus, schemaState.byId.get('status'));
  const requestedRoles = [...new Set([input.processLogicOwner, ...input.stepRoles])];
  const resolvedRoleRecords = requestedRoles.map((name) => roleMatches.get(name) || []);
  const rolesResolved = resolvedRoleRecords.every((records) => records.length === 1);
  const roleUris = rolesResolved
    ? [...new Set(resolvedRoleRecords.map((records) => records[0].id))].sort(compareCodepoint)
    : [];
  const ownerRecords = roleMatches.get(input.processLogicOwner) || [];
  const ownerUris = ownerRecords.length === 1 ? [ownerRecords[0].id] : [];
  const serviceUris = input.relatedService && serviceMatches.length === 1
    ? [serviceMatches[0].id]
    : [];
  const flags = [];
  const contradictions = [];
  if (!status || !frequency) {
    flags.push('PROCESS_REQUIRED_OPTION_NOT_IN_CURRENT_SCHEMA');
    contradictions.push(contradiction(
      'process-required-option-unavailable',
      'The default Status or requested Frequency does not resolve to one exact current schema option.',
      ['context.process-capture.schema']
    ));
  }
  if (input.category && !category) {
    flags.push('PROCESS_CATEGORY_NOT_IN_CURRENT_SCHEMA');
    contradictions.push(contradiction(
      'process-category-unavailable',
      'The requested Category does not resolve through governed aliases to one exact current schema option.',
      ['context.process-capture.schema']
    ));
  }
  if (tags.some((tag) => !tag)) {
    flags.push('PROCESS_TAG_NOT_IN_CURRENT_SCHEMA');
    contradictions.push(contradiction(
      'process-tag-unavailable',
      'At least one requested Tag is absent from the exact current schema option set.',
      ['context.process-capture.schema']
    ));
  }
  if (!rolesResolved || ownerUris.length !== 1) {
    flags.push('PROCESS_ROLE_IDENTITY_UNRESOLVED');
    contradictions.push(contradiction(
      'process-role-unresolved',
      'Every process role, including the logic owner, must resolve to exactly one existing role resource identity.',
      ['context.process-capture.roles']
    ));
  }
  if (input.relatedService && serviceMatches.length !== 1) {
    flags.push('PROCESS_SERVICE_IDENTITY_UNRESOLVED');
    contradictions.push(contradiction(
      'process-service-unresolved',
      'The requested related service must resolve to exactly one existing service resource identity.',
      ['context.process-capture.service']
    ));
  }
  if (duplicateIds.length) {
    flags.push('PROCESS_DUPLICATE_CANDIDATE_OBSERVED');
    contradictions.push(contradiction(
      'process-duplicate-candidate-observed',
      'An exact-name process definition exists and must be reviewed instead of creating a duplicate.',
      ['context.process-capture.candidates']
    ));
  }
  if (input.spawnTasks === true) {
    flags.push('PROCESS_TASK_SPAWN_DECLINED');
    contradictions.push(contradiction(
      'process-task-spawn-declined',
      'Definition work-items are not Task records; only a later process run may emit separately reviewed Task Capture inputs.',
      ['context.process-capture.policy']
    ));
  }
  const blockingFlags = flags.filter((flag) => flag !== 'PROCESS_TASK_SPAWN_DECLINED');
  const ready = blockingFlags.length === 0;
  const body = buildCapturedProcessBody({
    policy,
    name: input.name,
    purpose: input.purpose,
    triggerKinds: input.triggerKinds,
    triggers: input.triggers,
    frequency: frequency || input.frequency,
    stepRoles: input.stepRoles,
    stepCapabilities: input.stepCapabilities,
    stepObjectives: input.stepObjectives,
    workItems: input.workItems,
    exceptionHandling: input.exceptionHandling || [],
    postRunSummaryFields: input.postRunSummaryFields,
    processLogicOwner: input.processLogicOwner
  });
  const fields = {
    name: input.name,
    status: status || policy.defaultStatus,
    frequency: frequency || input.frequency,
    ...(category ? { category } : {}),
    ...(!tags.some((tag) => !tag) && tags.length ? { tags } : {}),
    processLogicOwnerUris: ownerUris,
    relatedServiceUris: serviceUris,
    relatedRoleUris: roleUris
  };
  const recordFingerprint = fingerprintJson({ recordType: 'process', fields, body });
  const reasonCode = ready
    ? input.spawnTasks === true
      ? 'PROCESS_CREATE_READY_TASK_SPAWN_DECLINED'
      : 'PROCESS_CREATE_READY_FOR_REVIEW'
    : duplicateIds.length
      ? 'PROCESS_CREATE_HELD_FOR_DUPLICATE_REVIEW'
      : 'PROCESS_CREATE_HELD_FOR_COMPLETE_REVIEW';
  const action = {
    id: 'action.process-capture.create',
    kind: 'process-create',
    capability: 'process.records.create',
    effect: 'write',
    state: ready ? 'proposed' : 'held',
    reasonCode,
    changeFingerprint: null
  };
  const row = {
    id: 'row.process-capture.process',
    sequence: 1,
    representedCount: 1,
    subject: { kind: 'process', fingerprint: recordFingerprint },
    group: 'process-capture',
    attention: 'operator',
    disposition: 'itemized',
    reasonCode,
    flags: [...new Set(flags)].sort(compareCodepoint),
    actions: [action],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  row.fingerprint = rowFingerprint(row);
  const collectionId = 'collection.process-capture.review';
  const item = privateItem(
    'review-item.process-capture.process',
    'process-create',
    [{ collectionId, rowId: row.id, rowFingerprint: row.fingerprint }],
    [
      privateField('name', 'Process name', 'text', input.name),
      privateField('status', 'Definition status', 'text', fields.status),
      privateField('frequency', 'Frequency', 'text', fields.frequency),
      privateField('category', 'Category', 'string-list', category ? [category] : []),
      privateField('tags', 'Tags', 'string-list', tags.filter(Boolean)),
      privateField('processLogicOwnerUris', 'Process logic owner identities', 'string-list', ownerUris),
      privateField('relatedServiceUris', 'Related service identities', 'string-list', serviceUris),
      privateField('relatedRoleUris', 'Related role identities', 'string-list', roleUris),
      privateField('body', 'Complete process body', 'text', body),
      privateField('duplicateCandidateIds', 'Exact duplicate candidates', 'string-list', duplicateIds),
      privateField('taskSpawnDisposition', 'Task spawn disposition', 'text', input.spawnTasks === true
        ? 'declined-definition-work-items-are-not-tasks'
        : 'not-requested')
    ]
  );
  row.privateDetailFingerprint = item.fingerprint;
  const proposedChanges = [];
  if (ready) {
    const change = {
      id: action.id,
      recordId: syntheticId(recordFingerprint),
      effect: 'process.records.create',
      beforeFingerprint: null,
      afterFingerprint: item.fingerprint
    };
    action.changeFingerprint = fingerprintJson(change);
    proposedChanges.push(change);
  }
  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: collectionId,
    kind: 'process-capture-review',
    labelKey: 'process-capture-review',
    coverage: { complete: true, observedCount: 1, includedCount: 1, excludedCount: 0, exclusions: [] },
    rows: [row],
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  collection.fingerprint = collectionFingerprint(collection);
  const derivedReview = { kind: derivedDefinition.kind, items: [item] };
  const facts = [
    { id: 'process-policy-grounded', label: 'Process capture policy grounded', value: true, state: 'supported', basisIds: ['context.process-capture.policy'] },
    { id: 'process-schema-compatible', label: 'Process schema compatible', value: Boolean(status && frequency) && (!input.category || Boolean(category)) && !tags.some((tag) => !tag), state: Boolean(status && frequency) && (!input.category || Boolean(category)) && !tags.some((tag) => !tag) ? 'supported' : 'contradicted', basisIds: ['context.process-capture.schema'] },
    { id: 'process-duplicate-count', label: 'Exact-name duplicate candidates', value: duplicateIds.length, state: duplicateIds.length ? 'contradicted' : 'supported', basisIds: ['context.process-capture.candidates'] },
    { id: 'process-role-count', label: 'Exact role identities resolved', value: roleUris.length, state: rolesResolved ? 'supported' : 'contradicted', basisIds: ['context.process-capture.roles'] },
    { id: 'process-default-status', label: 'Governed default definition status', value: policy.defaultStatus, state: status ? 'supported' : 'contradicted', basisIds: ['context.process-capture.policy', 'context.process-capture.schema'] },
    { id: 'process-task-spawn-requested', label: 'Task-record spawn requested', value: input.spawnTasks === true, state: input.spawnTasks === true ? 'contradicted' : 'supported', basisIds: ['context.process-capture.policy'] },
    { id: 'process-proposed-write-count', label: 'Process creates proposed', value: proposedChanges.length, state: ready ? 'supported' : 'unavailable', basisIds: ['context.process-capture.policy', 'context.process-capture.schema', 'context.process-capture.candidates', 'context.process-capture.roles'] }
  ];
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedDefinition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'process-capture-preview',
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
  return { preview, derivedReview, ready, body, fields };
}

export async function prepareProcessCaptureRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  const derivedDefinition = derivedReviewDefinition(root);
  const policy = loadProcessCapturePolicy(root);
  validateParallelInput(input, policy);
  const definitionAuthority = authority(lock, 'definition', 'process.records');
  const instanceAuthority = authority(lock, 'instance', 'process.records');
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
    requestedOutcome: 'Prepare one exact schema-current process definition with deterministic body and real relations, then stop before approval, task creation, or provider writes.',
    evidenceIds: []
  });
  const policyResult = await readFixture({
    root,
    lock,
    capability: 'process.records.read',
    authorityId: definitionAuthority,
    input: source.input,
    effectId: 'effect.process-capture.preparation.policy.fixture',
    at: createdAt
  });
  const selection = assertProcessCapturePolicySelection(policyResult.output, policy);
  const schemaResult = await readFixture({
    root,
    lock,
    capability: 'process.schema.read',
    authorityId: instanceAuthority,
    input: { recordType: 'process' },
    effectId: 'effect.process-capture.preparation.schema.fixture',
    at: createdAt
  });
  const schemaState = assertProcessSchema(schemaResult.output, policy);
  const duplicateResult = await readFixture({
    root,
    lock,
    capability: 'process.records.read',
    authorityId: instanceAuthority,
    input: { recordTypes: ['process'], filters: { name: input.name }, limit: policy.duplicateCandidateLimit },
    effectId: 'effect.process-capture.preparation.candidates.fixture',
    at: createdAt
  });
  const duplicateIds = duplicateResult.output.records
    .filter((record) => record.type === 'process')
    .map((record) => record.id)
    .sort(compareCodepoint);
  const roleNames = [...new Set([input.processLogicOwner, ...input.stepRoles])];
  const roleResult = await readFixture({
    root,
    lock,
    capability: 'process.records.read',
    authorityId: instanceAuthority,
    input: {
      recordTypes: ['role'],
      filtersAny: roleNames.map((name) => ({ name })),
      limit: Math.min(roleNames.length * 2, 100)
    },
    effectId: 'effect.process-capture.preparation.roles.fixture',
    at: createdAt
  });
  const roleMatches = exactMatches(roleResult.output.records, 'role', roleNames);
  const serviceResult = await readFixture({
    root,
    lock,
    capability: 'process.records.read',
    authorityId: instanceAuthority,
    input: input.relatedService
      ? { recordTypes: ['service'], filters: { name: input.relatedService }, limit: 2 }
      : { recordTypes: ['service'], ids: ['soter-fixture://process/service/__none__'], limit: 1 },
    effectId: 'effect.process-capture.preparation.service.fixture',
    at: createdAt
  });
  const serviceMatches = input.relatedService
    ? (exactMatches(serviceResult.output.records, 'service', [input.relatedService]).get(input.relatedService) || [])
    : [];
  const acquired = [
    {
      result: policyResult,
      entry: snapshotEntry({
        id: 'context.process-capture.policy',
        subject: 'process.records.process-capture-policy',
        authorityId: definitionAuthority,
        role: 'definition',
        result: policyResult,
        value: { record: selection.record, definitionFingerprint: selection.definitionFingerprint }
      })
    },
    {
      result: schemaResult,
      entry: snapshotEntry({
        id: 'context.process-capture.schema',
        subject: 'process.records.process-schema',
        authorityId: instanceAuthority,
        role: 'instance',
        result: schemaResult
      })
    },
    {
      result: duplicateResult,
      entry: snapshotEntry({
        id: 'context.process-capture.candidates',
        subject: 'process.records.process-candidates',
        authorityId: instanceAuthority,
        role: 'instance',
        result: duplicateResult,
        value: { candidateCount: duplicateIds.length, candidateIds: duplicateIds, providerOutputFingerprint: duplicateResult.invocation.outputFingerprint }
      })
    },
    {
      result: roleResult,
      entry: snapshotEntry({
        id: 'context.process-capture.roles',
        subject: 'process.records.roles',
        authorityId: instanceAuthority,
        role: 'instance',
        result: roleResult,
        value: {
          requestedCount: roleNames.length,
          candidateIds: roleResult.output.records.filter((record) => record.type === 'role').map((record) => record.id).sort(compareCodepoint),
          providerOutputFingerprint: roleResult.invocation.outputFingerprint
        }
      })
    },
    {
      result: serviceResult,
      entry: snapshotEntry({
        id: 'context.process-capture.service',
        subject: 'process.records.service',
        authorityId: instanceAuthority,
        role: 'instance',
        result: serviceResult,
        value: {
          requested: Boolean(input.relatedService),
          candidateIds: serviceResult.output.records.filter((record) => record.type === 'service').map((record) => record.id).sort(compareCodepoint),
          providerOutputFingerprint: serviceResult.invocation.outputFingerprint
        }
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
        'Process name, purpose, triggers, roles, capabilities, steps, work-items, body, requested options, relation names, provider targets, native responses, and credentials are excluded from general inspection.'
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
    return fingerprints ? {
      ...item,
      status: 'loaded',
      provenance: 'fixture:' + fingerprintJson(fingerprints),
      freshness: 'passed'
    } : item;
  });
  envelope.lifecycleState = 'paused';
  envelope.checkpoints = [
    { id: 'effects-established', state: 'passed', details: 'Read and disclosure policies were evaluated before every contained context invocation.' },
    { id: 'process-capture-review-grounded', state: 'passed', details: 'The exact policy, current schema, duplicates, roles, and optional service were loaded.' },
    { id: 'task-boundary-held', state: 'passed', details: 'Definition work-items created no Task records or Task Capture authority.' },
    { id: 'write-boundary-held', state: 'passed', details: 'No change set, approval request, continuation request, provider write, or canonical write was issued.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;
  const result = buildProcessCapturePreview({
    input,
    policy,
    schemaState,
    duplicateIds,
    roleMatches,
    serviceMatches,
    derivedDefinition
  });
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      { id: 'process-policy-grounded', label: 'Exact Process capture policy grounded', state: 'supported', basis: ['context.process-capture.policy'], limitation: 'The contained selection does not establish connected provider state.' },
      { id: 'process-schema-grounded', label: 'Current configured Process schema grounded', state: 'supported', basis: ['context.process-capture.schema'], limitation: 'One contained schema observation does not establish future compatibility, permission, or readiness.' },
      { id: 'process-relations-grounded', label: 'Exact role and optional service identities reviewed', state: 'supported', basis: ['context.process-capture.roles', 'context.process-capture.service'], limitation: 'Contained resource identities do not establish connected relation-write permission.' },
      { id: 'process-create-review', label: 'Complete process create prepared', state: result.ready ? 'proposed' : 'blocked', basis: entries.map((entry) => entry.id), limitation: result.ready ? 'The fingerprint-only proposal grants no approval or execution authority; connected create is unavailable for this workflow.' : 'The create remains held until every surfaced option, relation, and duplicate blocker is resolved.' },
      { id: 'external-write-boundary', label: 'Task and provider writes held behind separate authority', state: 'supported', basis: entries.map((entry) => entry.id), limitation: 'Preparation performs no provider write, creates no Task records, and declares no connected compiler.' }
    ],
    preview: result.preview,
    derivedReview: result.derivedReview
  };
}
