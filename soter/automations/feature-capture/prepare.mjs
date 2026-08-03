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
  assertFeatureSchema,
  assertFeatureWorkflowPolicySelection,
  buildCapturedFeatureBody,
  exactCurrentFeatureOption,
  loadFeatureWorkflowPolicy
} from '../../contexts/product/feature-workflow.mjs';

const AUTOMATION_ID = 'automation.feature-capture';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function derivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'feature-capture',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'feature-capture-derived-review') {
    throw new Error('Feature Capture derived review definition drifted from its Automation-owned contract.');
  }
  return definition;
}

function authority(lock, role, subject) {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error('Feature Capture requires one exact ' + role + ' authority for ' + subject + '.');
  }
  return matches[0].id;
}

function policySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === 'feature-workflow-policy';
  }));
  if (matches.length !== 1) {
    throw new Error('Feature Capture requires exactly one configured feature-workflow-policy source.');
  }
  const source = matches[0];
  if (source.capability !== 'product.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)) {
    throw new Error('Feature Capture policy source must be one exact typed definition-authority read.');
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
    throw new Error('Feature Capture contained read did not pass: ' + effectId + '.');
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
    'context.feature-capture.policy': 'Load exact feature workflow policy selection',
    'context.feature-capture.schema': 'Read current configured feature board schema',
    'context.feature-capture.candidates': 'Inspect bounded exact-name feature candidates'
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
  return 'new:feature:' + fingerprint.slice('sha256:'.length, 'sha256:'.length + 16);
}

export function buildFeatureCapturePreview({
  input,
  policy,
  schemaState,
  duplicateIds,
  derivedDefinition
}) {
  const type = exactCurrentFeatureOption(input.featureType, schemaState.byId.get('featureType'));
  const area = input.area
    ? exactCurrentFeatureOption(input.area, schemaState.byId.get('area'), { optionalField: true })
    : null;
  const priority = input.priority
    ? exactCurrentFeatureOption(input.priority, schemaState.byId.get('priority'), { optionalField: true })
    : null;
  const flags = [];
  const contradictions = [];
  if (input.whyState !== 'confirmed') {
    flags.push('FEATURE_WHY_PROVISIONAL_CONFIRM_REQUIRED');
    contradictions.push(contradiction(
      'feature-why-provisional',
      'The why is explicitly provisional and must be confirmed before any create can proceed.',
      ['context.feature-capture.policy']
    ));
  }
  if (!type) {
    flags.push('FEATURE_TYPE_NOT_IN_CURRENT_SCHEMA');
    contradictions.push(contradiction(
      'feature-type-unavailable',
      'The requested card type does not exactly match the current configured board schema.',
      ['context.feature-capture.schema']
    ));
  }
  if (input.area && !area) {
    flags.push('FEATURE_AREA_NOT_IN_CURRENT_SCHEMA');
    contradictions.push(contradiction(
      'feature-area-unavailable',
      'The requested Area does not exactly match the current configured board schema.',
      ['context.feature-capture.schema']
    ));
  }
  if (input.priority && !priority) {
    flags.push('FEATURE_PRIORITY_NOT_IN_CURRENT_SCHEMA');
    contradictions.push(contradiction(
      'feature-priority-unavailable',
      'The requested Priority does not exactly match the current configured board schema.',
      ['context.feature-capture.schema']
    ));
  }
  if (duplicateIds.length) {
    flags.push('FEATURE_DUPLICATE_CANDIDATE_OBSERVED');
    contradictions.push(contradiction(
      'feature-duplicate-candidate-observed',
      'An exact-name feature candidate exists on the configured board and must be reviewed instead of creating a duplicate.',
      ['context.feature-capture.candidates']
    ));
  }
  const stableFlags = [...new Set(flags)].sort(compareCodepoint);
  const ready = stableFlags.length === 0;
  const body = buildCapturedFeatureBody({
    policy,
    name: input.name,
    featureType: input.featureType,
    summary: input.summary,
    sectionTwo: input.sectionTwo,
    currentState: input.currentState || '',
    relationships: input.relationships || [],
    openQuestions: input.openQuestions || []
  });
  const fields = {
    name: input.name,
    description: input.why,
    status: policy.defaultStatus,
    ...(type ? { featureType: type } : {}),
    ...(area ? { area } : {}),
    ...(priority ? { priority } : {})
  };
  const recordFingerprint = fingerprintJson({ recordType: 'feature', fields, body });
  const reasonCode = ready
    ? 'FEATURE_CREATE_READY_FOR_REVIEW'
    : duplicateIds.length
      ? 'FEATURE_CREATE_HELD_FOR_DUPLICATE_REVIEW'
      : 'FEATURE_CREATE_HELD_FOR_COMPLETE_REVIEW';
  const action = {
    id: 'action.feature-capture.create',
    kind: 'feature-create',
    capability: 'product.records.create',
    effect: 'write',
    state: ready ? 'proposed' : 'held',
    reasonCode,
    changeFingerprint: null
  };
  const row = {
    id: 'row.feature-capture.feature',
    sequence: 1,
    representedCount: 1,
    subject: { kind: 'feature', fingerprint: recordFingerprint },
    group: 'feature-capture',
    attention: 'operator',
    disposition: 'itemized',
    reasonCode,
    flags: stableFlags,
    actions: [action],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  row.fingerprint = rowFingerprint(row);
  const collectionId = 'collection.feature-capture.review';
  const item = privateItem(
    'review-item.feature-capture.feature',
    'feature-create',
    [{ collectionId, rowId: row.id, rowFingerprint: row.fingerprint }],
    [
      privateField('name', 'Feature name', 'text', input.name),
      privateField('why', 'Why', 'text', input.why),
      privateField('whyState', 'Why confidence', 'text', input.whyState),
      privateField('status', 'Lifecycle status', 'text', policy.defaultStatus),
      privateField('featureType', 'Card type', 'text', type || input.featureType),
      privateField('area', 'Area', 'string-list', area ? [area] : []),
      privateField('priority', 'Priority', 'string-list', priority ? [priority] : []),
      privateField('body', 'Complete card body', 'text', body),
      privateField('duplicateCandidateIds', 'Exact duplicate candidates', 'string-list', duplicateIds)
    ]
  );
  row.privateDetailFingerprint = item.fingerprint;
  const proposedChanges = [];
  if (ready) {
    const change = {
      id: action.id,
      recordId: syntheticId(recordFingerprint),
      effect: 'product.records.create',
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
    kind: 'feature-capture-review',
    labelKey: 'feature-capture-review',
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
    { id: 'feature-policy-grounded', label: 'Feature workflow policy grounded', value: true, state: 'supported', basisIds: ['context.feature-capture.policy'] },
    { id: 'feature-schema-compatible', label: 'Feature board schema compatible', value: Boolean(type) && (!input.area || Boolean(area)) && (!input.priority || Boolean(priority)), state: Boolean(type) && (!input.area || Boolean(area)) && (!input.priority || Boolean(priority)) ? 'supported' : 'contradicted', basisIds: ['context.feature-capture.schema'] },
    { id: 'feature-duplicate-count', label: 'Exact-name duplicate candidates', value: duplicateIds.length, state: duplicateIds.length ? 'contradicted' : 'supported', basisIds: ['context.feature-capture.candidates'] },
    { id: 'feature-why-state', label: 'Why confidence', value: input.whyState, state: input.whyState === 'confirmed' ? 'supported' : 'unavailable', basisIds: ['context.feature-capture.policy'] },
    { id: 'feature-proposed-write-count', label: 'Feature creates proposed', value: proposedChanges.length, state: ready ? 'supported' : 'unavailable', basisIds: ['context.feature-capture.policy', 'context.feature-capture.schema', 'context.feature-capture.candidates'] }
  ];
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedDefinition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'feature-capture-preview',
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

export async function prepareFeatureCaptureRun({
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
    requestedOutcome: 'Prepare one exact configured-board feature create with its why and complete deterministic body, then stop before approval or provider writes.',
    evidenceIds: []
  });
  const policyResult = await readFixture({
    root,
    lock,
    capability: 'product.records.read',
    authorityId: definitionAuthority,
    input: source.input,
    effectId: 'effect.feature-capture.preparation.policy.fixture',
    at: createdAt
  });
  const selection = assertFeatureWorkflowPolicySelection(policyResult.output, policy);
  const schemaResult = await readFixture({
    root,
    lock,
    capability: 'product.schema.read',
    authorityId: instanceAuthority,
    input: { recordType: 'feature' },
    effectId: 'effect.feature-capture.preparation.schema.fixture',
    at: createdAt
  });
  const schemaState = assertFeatureSchema(schemaResult.output, policy);
  const duplicateResult = await readFixture({
    root,
    lock,
    capability: 'product.records.read',
    authorityId: instanceAuthority,
    input: {
      recordTypes: ['feature'],
      filters: { name: input.name },
      limit: policy.duplicateCandidateLimit
    },
    effectId: 'effect.feature-capture.preparation.candidates.fixture',
    at: createdAt
  });
  const duplicateIds = duplicateResult.output.records
    .filter((record) => record.type === 'feature')
    .map((record) => record.id)
    .sort(compareCodepoint);
  const acquired = [
    {
      result: policyResult,
      entry: snapshotEntry({
        id: 'context.feature-capture.policy',
        subject: 'product.records.feature-workflow-policy',
        authorityId: definitionAuthority,
        role: 'definition',
        result: policyResult,
        value: {
          record: selection.record,
          definitionFingerprint: selection.definitionFingerprint
        }
      })
    },
    {
      result: schemaResult,
      entry: snapshotEntry({
        id: 'context.feature-capture.schema',
        subject: 'product.records.feature-schema',
        authorityId: instanceAuthority,
        role: 'instance',
        result: schemaResult
      })
    },
    {
      result: duplicateResult,
      entry: snapshotEntry({
        id: 'context.feature-capture.candidates',
        subject: 'product.records.feature-candidates',
        authorityId: instanceAuthority,
        role: 'instance',
        result: duplicateResult,
        value: {
          candidateCount: duplicateIds.length,
          candidateIds: duplicateIds,
          providerOutputFingerprint: duplicateResult.invocation.outputFingerprint
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
        'Feature name, why, body text, requested options, provider target identity, candidate values, native responses, and credentials are excluded from general inspection.'
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
    { id: 'feature-capture-review-grounded', state: 'passed', details: 'The exact policy, current configured board schema, and bounded exact-name candidates were loaded.' },
    { id: 'write-boundary-held', state: 'passed', details: 'No change set, approval request, continuation request, provider write, board discovery, or canonical write was issued.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;
  const result = buildFeatureCapturePreview({
    input,
    policy,
    schemaState,
    duplicateIds,
    derivedDefinition
  });
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      { id: 'feature-policy-grounded', label: 'Exact Product feature workflow policy grounded', state: 'supported', basis: ['context.feature-capture.policy'], limitation: 'The policy selection and contained definition do not establish connected provider state.' },
      { id: 'feature-schema-grounded', label: 'Current configured feature board schema grounded', state: 'supported', basis: ['context.feature-capture.schema'], limitation: 'One contained schema observation does not establish future compatibility, permission, or readiness.' },
      { id: 'feature-create-review', label: 'Complete feature create prepared', state: result.ready ? 'proposed' : 'blocked', basis: entries.map((entry) => entry.id), limitation: result.ready ? 'The fingerprint-only proposal grants no approval or execution authority; connected create is unavailable for this workflow.' : 'The create remains held until every surfaced why, option, and duplicate blocker is resolved.' },
      { id: 'external-write-boundary', label: 'All external writes held behind separate authority', state: 'supported', basis: entries.map((entry) => entry.id), limitation: 'Preparation performs no provider write and declares no connected compiler.' }
    ],
    preview: result.preview,
    derivedReview: result.derivedReview
  };
}
