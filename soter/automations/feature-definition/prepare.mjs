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
  assertFeatureSchema,
  assertFeatureWorkflowPolicySelection,
  buildDefinedFeatureBody,
  loadFeatureWorkflowPolicy
} from '../../contexts/product/feature-workflow.mjs';

const AUTOMATION_ID = 'automation.feature-definition';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';

function derivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'feature-definition',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'feature-definition-derived-review') {
    throw new Error('Feature Definition derived review definition drifted from its Automation-owned contract.');
  }
  return definition;
}

function authority(lock, role, subject) {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error('Feature Definition requires one exact ' + role + ' authority for ' + subject + '.');
  }
  return matches[0].id;
}

function policySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === 'feature-workflow-policy';
  }));
  if (matches.length !== 1) {
    throw new Error('Feature Definition requires exactly one configured feature-workflow-policy source.');
  }
  const source = matches[0];
  if (source.capability !== 'product.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)) {
    throw new Error('Feature Definition policy source must be one exact typed definition-authority read.');
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
    throw new Error('Feature Definition contained read did not pass: ' + effectId + '.');
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
    'context.feature-definition.policy': 'Load exact feature workflow policy selection',
    'context.feature-definition.schema': 'Read current configured feature board schema',
    'context.feature-definition.record': 'Resolve exact existing feature record',
    'context.feature-definition.body': 'Read exact current feature page body'
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

export function buildFeatureDefinitionPreview({
  input,
  policy,
  feature,
  document,
  bodyResult,
  derivedDefinition
}) {
  const flags = [];
  const contradictions = [];
  if (feature.fields.status !== policy.defaultStatus) {
    flags.push('FEATURE_NOT_PLANNED');
    contradictions.push(contradiction(
      'feature-not-planned',
      'Feature Definition applies only to an exact existing Planned feature and cannot change lifecycle state.',
      ['context.feature-definition.record']
    ));
  }
  if (!bodyResult.compatible) {
    flags.push(bodyResult.reasonCode);
    contradictions.push(contradiction(
      'feature-body-template-unsupported',
      'The exact current body does not match the governed deterministic template and cannot be safely replaced.',
      ['context.feature-definition.body', 'context.feature-definition.policy']
    ));
  }
  if (input.statusChangeRequested) {
    flags.push('FEATURE_STATUS_CHANGE_EXCLUDED_FROM_DEFINITION');
    contradictions.push(contradiction(
      'feature-status-change-excluded',
      'A requested lifecycle transition is surfaced as separate work and is not included in Feature Definition.',
      ['context.feature-definition.record', 'context.feature-definition.policy']
    ));
  }
  const stableFlags = [...new Set(flags)].sort();
  const blocking = stableFlags.filter((flag) => {
    return flag !== 'FEATURE_STATUS_CHANGE_EXCLUDED_FROM_DEFINITION';
  });
  const ready = blocking.length === 0;
  const reasonCode = ready
    ? 'FEATURE_DEFINITION_READY_FOR_REVIEW'
    : 'FEATURE_DEFINITION_HELD_FOR_EXACT_REVIEW';
  const action = {
    id: 'action.feature-definition.body-update',
    kind: 'feature-definition',
    capability: 'documents.content.update',
    effect: 'write',
    state: ready ? 'proposed' : 'held',
    reasonCode,
    changeFingerprint: null
  };
  const currentBodyFingerprint = document.bodyFingerprint;
  const proposedBodyFingerprint = bodyResult.body ? fingerprintJson(bodyResult.body) : null;
  const row = {
    id: 'row.feature-definition.feature',
    sequence: 1,
    representedCount: 1,
    subject: { kind: 'feature', fingerprint: fingerprintJson({ id: feature.id, version: feature.version }) },
    group: 'feature-definition',
    attention: 'operator',
    disposition: 'itemized',
    reasonCode,
    flags: stableFlags,
    actions: [action],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  row.fingerprint = rowFingerprint(row);
  const collectionId = 'collection.feature-definition.review';
  const item = privateItem(
    'review-item.feature-definition.feature',
    'feature-definition',
    [{ collectionId, rowId: row.id, rowFingerprint: row.fingerprint }],
    [
      privateField('featureId', 'Feature identity', 'text', feature.id),
      privateField('name', 'Feature name', 'text', feature.fields.name),
      privateField('description', 'Preserved why', 'text', feature.fields.description),
      privateField('status', 'Preserved lifecycle status', 'text', feature.fields.status),
      privateField('featureType', 'Card type', 'text', feature.fields.featureType || 'Feature'),
      privateField('currentBody', 'Current body', 'text', document.body),
      privateField('proposedBody', 'Proposed body', 'text', bodyResult.body || document.body),
      privateField('scopeIn', 'In scope', 'string-list', input.scopeIn),
      privateField('scopeOut', 'Out of scope', 'string-list', input.scopeOut),
      privateField('doneWhen', 'Done when', 'string-list', input.doneWhen),
      privateField('openQuestions', 'Open questions', 'string-list', input.openQuestions || []),
      privateField('statusChangeRequested', 'Status change requested', 'boolean', input.statusChangeRequested)
    ]
  );
  row.privateDetailFingerprint = item.fingerprint;
  const proposedChanges = [];
  if (ready) {
    const change = {
      id: action.id,
      recordId: feature.id,
      effect: 'documents.content.update',
      beforeFingerprint: currentBodyFingerprint,
      afterFingerprint: item.fingerprint
    };
    action.changeFingerprint = fingerprintJson(change);
    proposedChanges.push(change);
  }
  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: collectionId,
    kind: 'feature-definition-review',
    labelKey: 'feature-definition-review',
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
  collection.fingerprint = collectionFingerprint(collection);
  const derivedReview = { kind: derivedDefinition.kind, items: [item] };
  const facts = [
    { id: 'feature-record-resolved', label: 'Exact feature record resolved', value: true, state: 'supported', basisIds: ['context.feature-definition.record'] },
    { id: 'feature-current-status', label: 'Current feature status', value: feature.fields.status, state: feature.fields.status === policy.defaultStatus ? 'supported' : 'contradicted', basisIds: ['context.feature-definition.record'] },
    { id: 'feature-description-change-count', label: 'Description field changes', value: 0, state: 'supported', basisIds: ['context.feature-definition.record'] },
    { id: 'feature-status-change-count', label: 'Status field changes', value: 0, state: 'supported', basisIds: ['context.feature-definition.record'] },
    { id: 'feature-body-template-compatible', label: 'Feature body template compatible', value: bodyResult.compatible, state: bodyResult.compatible ? 'supported' : 'contradicted', basisIds: ['context.feature-definition.body', 'context.feature-definition.policy'] },
    { id: 'feature-proposed-write-count', label: 'Feature body updates proposed', value: proposedChanges.length, state: ready ? 'supported' : 'unavailable', basisIds: ['context.feature-definition.record', 'context.feature-definition.body'] },
    { id: 'feature-proposed-body-fingerprint', label: 'Proposed body fingerprint available', value: proposedBodyFingerprint !== null, state: proposedBodyFingerprint ? 'supported' : 'unavailable', basisIds: ['context.feature-definition.body'] }
  ];
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedDefinition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'feature-definition-preview',
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
  return { preview, derivedReview, ready };
}

export async function prepareFeatureDefinitionRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  const derivedDefinition = derivedReviewDefinition(root);
  const policy = loadFeatureWorkflowPolicy(root);
  const definitionAuthority = authority(lock, 'definition', 'product.records');
  const instanceAuthority = authority(lock, 'instance', 'product.records');
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
    requestedOutcome: 'Prepare one exact existing Planned feature body definition while preserving Description and Status, then stop before approval or provider writes.',
    evidenceIds: []
  });
  const policyResult = await readFixture({
    root,
    lock,
    capability: 'product.records.read',
    authorityId: definitionAuthority,
    input: source.input,
    effectId: 'effect.feature-definition.preparation.policy.fixture',
    at: createdAt
  });
  const selection = assertFeatureWorkflowPolicySelection(policyResult.output, policy);
  const schemaResult = await readFixture({
    root,
    lock,
    capability: 'product.schema.read',
    authorityId: instanceAuthority,
    input: { recordType: 'feature' },
    effectId: 'effect.feature-definition.preparation.schema.fixture',
    at: createdAt
  });
  assertFeatureSchema(schemaResult.output, policy);
  const recordResult = await readFixture({
    root,
    lock,
    capability: 'product.records.read',
    authorityId: instanceAuthority,
    input: { recordTypes: ['feature'], ids: [input.feature], limit: 2 },
    effectId: 'effect.feature-definition.preparation.record.fixture',
    at: createdAt
  });
  const feature = exactRequestedContextRecord(recordResult.output, {
    recordType: 'feature',
    requestedId: input.feature
  });
  for (const field of ['name', 'description', 'status']) {
    if (typeof feature.fields[field] !== 'string' || !feature.fields[field].trim()) {
      throw new Error('Feature Definition existing record is missing required ' + field + ' meaning.');
    }
  }
  const featureType = feature.fields.featureType || 'Feature';
  if (!policy.allowedTypes.includes(featureType)) {
    throw new Error('Feature Definition existing feature type is outside the governed Product vocabulary.');
  }
  const bodyRead = await readFixture({
    root,
    lock,
    capability: 'documents.content.read',
    authorityId: instanceAuthority,
    input: { uri: feature.id, expectedTitle: feature.fields.name },
    effectId: 'effect.feature-definition.preparation.body.fixture',
    at: createdAt
  });
  const document = bodyRead.output.document;
  if (document.uri !== feature.id || document.title !== feature.fields.name) {
    throw new Error('Feature Definition document identity does not match the exact feature record.');
  }
  const bodyResult = buildDefinedFeatureBody({
    policy,
    currentBody: document.body,
    featureType,
    whatItIs: input.whatItIs,
    scopeIn: input.scopeIn,
    scopeOut: input.scopeOut,
    doneWhen: input.doneWhen,
    openQuestions: input.openQuestions || []
  });
  const acquired = [
    {
      result: policyResult,
      entry: snapshotEntry({
        id: 'context.feature-definition.policy',
        subject: 'product.records.feature-workflow-policy',
        authorityId: definitionAuthority,
        role: 'definition',
        result: policyResult,
        value: { record: selection.record, definitionFingerprint: selection.definitionFingerprint }
      })
    },
    {
      result: schemaResult,
      entry: snapshotEntry({
        id: 'context.feature-definition.schema',
        subject: 'product.records.feature-schema',
        authorityId: instanceAuthority,
        role: 'instance',
        result: schemaResult
      })
    },
    {
      result: recordResult,
      entry: snapshotEntry({
        id: 'context.feature-definition.record',
        subject: 'product.records.feature',
        authorityId: instanceAuthority,
        role: 'instance',
        result: recordResult
      })
    },
    {
      result: bodyRead,
      entry: snapshotEntry({
        id: 'context.feature-definition.body',
        subject: 'product.records.feature-body',
        authorityId: instanceAuthority,
        role: 'instance',
        result: bodyRead
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
        'Feature name, why, current and proposed body text, definition inputs, provider target identity, native responses, and credentials are excluded from general inspection.'
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
    { id: 'feature-definition-review-grounded', state: 'passed', details: 'The exact policy, current schema, existing feature fields, and current page body were loaded.' },
    { id: 'write-boundary-held', state: 'passed', details: 'No change set, approval request, continuation request, status transition, provider write, or canonical write was issued.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;
  const result = buildFeatureDefinitionPreview({
    input,
    policy,
    feature,
    document,
    bodyResult,
    derivedDefinition
  });
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      { id: 'feature-policy-grounded', label: 'Exact Product feature workflow policy grounded', state: 'supported', basis: ['context.feature-definition.policy'], limitation: 'The contained policy selection does not establish connected provider state.' },
      { id: 'feature-record-grounded', label: 'Exact existing feature and lifecycle fields grounded', state: 'supported', basis: ['context.feature-definition.record'], limitation: 'The contained record does not establish connected currentness or permission.' },
      { id: 'feature-body-grounded', label: 'Exact current feature body grounded', state: 'supported', basis: ['context.feature-definition.body'], limitation: 'Only the governed deterministic template is supported; custom board templates remain unavailable.' },
      { id: 'feature-definition-review', label: 'Feature body definition prepared with why and status preserved', state: result.ready ? 'proposed' : 'blocked', basis: entries.map((entry) => entry.id), limitation: result.ready ? 'The fingerprint-only proposal grants no approval or execution authority; connected update is unavailable in this migration slice.' : 'The body update remains held until exact lifecycle and template blockers are resolved.' },
      { id: 'external-write-boundary', label: 'All external writes held behind separate authority', state: 'supported', basis: entries.map((entry) => entry.id), limitation: 'Preparation performs no provider write and declares no connected compiler.' }
    ],
    preview: result.preview,
    derivedReview: result.derivedReview
  };
}
