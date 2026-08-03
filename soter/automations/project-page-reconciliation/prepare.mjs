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
  assertProjectCapturePolicySelection,
  loadProjectCapturePolicyDefinition
} from '../../contexts/projects/project-capture-policy.mjs';

const AUTOMATION_ID = 'automation.project-page-reconciliation';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';
const PROPERTY_ACTION = 'action.project-page-reconciliation.properties';
const BODY_ACTION = 'action.project-page-reconciliation.body';

function preparationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sameJson(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function exactDerivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'project-page-reconciliation',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'project-page-reconciliation-derived-review') {
    throw preparationError(
      'PREPARATION_ADAPTER_INVALID',
      'Project page reconciliation derived-review declaration drifted.'
    );
  }
  return definition;
}

function exactAuthority(lock, role, subject = 'projects.records') {
  const matches = lock.authorities.filter((authority) => {
    return authority.role === role && authority.subject === subject;
  });
  if (matches.length !== 1) {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project page reconciliation requires one exact ' + role + ' authority for ' + subject + '.'
    );
  }
  return matches[0].id;
}

function exactPolicySource(lock, authority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === 'project-capture-policy';
  }));
  const source = matches[0];
  const expectedInput = {
    recordTypes: ['project-capture-policy'],
    ids: ['policy.project-capture'],
    limit: 2
  };
  if (matches.length !== 1
    || source.capability !== 'projects.records.read'
    || source.authority !== authority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || !sameJson(source.input, expectedInput)) {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project page reconciliation requires one exact configured Project policy source.'
    );
  }
  return source;
}

function validateInput(input) {
  const oldTextsPresent = Object.hasOwn(input, 'oldTexts');
  const newTextsPresent = Object.hasOwn(input, 'newTexts');
  if (!input
    || typeof input.project !== 'string'
    || input.project.length < 3
    || input.project.length > 500
    || oldTextsPresent !== newTextsPresent
    || (oldTextsPresent && (
      !Array.isArray(input.oldTexts)
      || !Array.isArray(input.newTexts)
      || input.oldTexts.length < 1
      || input.oldTexts.length > 20
      || input.oldTexts.length !== input.newTexts.length
      || new Set(input.oldTexts).size !== input.oldTexts.length
      || input.oldTexts.some((text, index) => {
        return typeof text !== 'string'
          || typeof input.newTexts[index] !== 'string'
          || !text
          || !input.newTexts[index]
          || text === input.newTexts[index];
      })
    ))
    || (!Object.hasOwn(input, 'projectType')
      && !Object.hasOwn(input, 'status')
      && !oldTextsPresent)) {
    throw preparationError(
      'PREPARATION_INPUT_INVALID',
      'Project page reconciliation requires one exact Project and at least one changing supported property or aligned one-match text replacement.'
    );
  }
}

async function readFixture({ root, lock, capability, authority, input, effectId, at }) {
  const result = await invokeCapability({
    root,
    lock,
    capability,
    authority,
    containment: 'fixture',
    input,
    effectId,
    at
  });
  if (result.invocation.state !== 'passed') {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project page reconciliation contained read failed for ' + capability + '.'
    );
  }
  return result;
}

function snapshotEntry({ id, role, authority, result }) {
  return {
    id,
    subject: 'projects.records',
    authority,
    role,
    capability: result.invocation.capability,
    providerPack: result.invocation.providerPack,
    providerImplementation: result.invocation.providerImplementation,
    providerVersion: result.invocation.providerVersion,
    observedAt: result.output.observedAt,
    freshness: 'passed',
    provenance: result.output.provenance,
    valueFingerprint: fingerprintJson(result.output),
    value: result.output
  };
}

function schemaField(schema, id, desired, allowedValues) {
  const matches = schema.fields.filter((field) => field.id === id);
  if (matches.length !== 1
    || matches[0].writable !== true
    || !Array.isArray(matches[0].options)
    || !matches[0].options.includes(desired)
    || !allowedValues.includes(desired)) {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'The requested Project ' + id + ' is not allowed by the exact current policy and schema.'
    );
  }
  return matches[0];
}

function applyExactReplacements(body, oldTexts, newTexts) {
  if (!oldTexts) return { body, updates: [] };
  if (oldTexts.some((oldText, index) => {
    return oldText === body || newTexts[index].includes(oldText);
  })) {
    throw preparationError(
      'PREPARATION_INPUT_INVALID',
      'Project page reconciliation permits bounded substitutions, not whole-page replacement or append-style extension.'
    );
  }
  const spans = oldTexts.map((oldText, index) => {
    const first = body.indexOf(oldText);
    const second = first < 0 ? -1 : body.indexOf(oldText, first + 1);
    if (first < 0 || second >= 0) {
      throw preparationError(
        'PREPARATION_INPUT_INVALID',
        'Every Project page replacement must match exactly one freshly observed text region.'
      );
    }
    return {
      index,
      start: first,
      end: first + oldText.length,
      oldText,
      newText: newTexts[index]
    };
  }).sort((left, right) => left.start - right.start);
  if (spans.some((span) => {
    return !body.slice(0, span.start).trim() && !body.slice(span.end).trim();
  })) {
    throw preparationError(
      'PREPARATION_INPUT_INVALID',
      'Project page reconciliation permits bounded substitutions, not whole-page replacement or append-style extension.'
    );
  }
  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index].start < spans[index - 1].end) {
      throw preparationError(
        'PREPARATION_INPUT_INVALID',
        'Project page replacement regions cannot overlap in the freshly observed body.'
      );
    }
  }
  const descending = [...spans].reverse();
  const updates = descending.map((span) => ({
    id: 'replacement.' + String(span.index + 1).padStart(3, '0'),
    oldText: span.oldText,
    newText: span.newText,
    replaceAllMatches: false
  }));
  let nextBody = body;
  for (const span of descending) {
    const first = nextBody.indexOf(span.oldText);
    const second = first < 0 ? -1 : nextBody.indexOf(span.oldText, first + 1);
    if (first !== span.start || second >= 0) {
      throw preparationError(
        'PREPARATION_INPUT_INVALID',
        'Project page replacements must remain exact and collision-free in execution order.'
      );
    }
    nextBody = nextBody.slice(0, span.start)
      + span.newText
      + nextBody.slice(span.end);
  }
  if (!nextBody.trim() || nextBody.length > 250000) {
    throw preparationError(
      'PREPARATION_INPUT_INVALID',
      'Project page reconciliation cannot create an empty or unbounded page body.'
    );
  }
  return { body: nextBody, updates };
}

function privateField(id, label, type, reviewValue) {
  return { id, label, type, fingerprint: fingerprintJson(reviewValue), reviewValue };
}

function privateItem(id, kind, source, fields) {
  const value = {
    id,
    kind,
    sources: [source],
    fields,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
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

function actionRow({ id, sequence, subjectKind, subjectFingerprint, kind, capability, reasonCode }) {
  const action = {
    id,
    kind,
    capability,
    effect: 'write',
    state: 'proposed',
    reasonCode,
    changeFingerprint: null
  };
  const row = {
    id: id.replace(/^action\./, 'row.'),
    sequence,
    representedCount: 1,
    subject: { kind: subjectKind, fingerprint: subjectFingerprint },
    group: 'project-page-reconciliation',
    attention: 'operator',
    disposition: 'itemized',
    reasonCode,
    flags: [],
    actions: [action],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  row.fingerprint = rowFingerprint(row);
  return { action, row };
}

export function buildProjectPageReconciliationReview({
  input,
  project,
  body,
  policy,
  schema,
  definition
}) {
  const beforeFields = structuredClone(project.fields);
  const patch = {};
  if (Object.hasOwn(input, 'projectType')) {
    schemaField(schema, 'projectType', input.projectType, policy.fields.allowedTypes);
    if (beforeFields.projectType !== input.projectType) patch.projectType = input.projectType;
  }
  if (Object.hasOwn(input, 'status')) {
    schemaField(schema, 'status', input.status, policy.fields.allowedStatuses);
    if (beforeFields.status !== input.status) patch.status = input.status;
  }
  const afterFields = { ...beforeFields, ...patch };
  const replacement = applyExactReplacements(body, input.oldTexts, input.newTexts);
  const propertyChanged = Object.keys(patch).length > 0;
  const bodyChanged = replacement.updates.length > 0
    && fingerprintJson(replacement.body) !== fingerprintJson(body);
  if (!propertyChanged && !bodyChanged) {
    throw preparationError(
      'PREPARATION_INPUT_INVALID',
      'The requested Project values already match the exact current state; no change can be proposed.'
    );
  }

  const collectionId = 'collection.project-page-reconciliation.changes';
  const rows = [];
  const items = [];
  const proposedChanges = [];
  const recordId = 'existing:project:'
    + fingerprintJson(project.id).slice('sha256:'.length, 'sha256:'.length + 16);

  if (propertyChanged) {
    const pair = actionRow({
      id: PROPERTY_ACTION,
      sequence: rows.length + 1,
      subjectKind: 'project-properties',
      subjectFingerprint: fingerprintJson({ id: project.id, version: project.version, fields: beforeFields }),
      kind: 'project-properties-update',
      capability: 'projects.records.update',
      reasonCode: 'PROJECT_PROPERTIES_UPDATE_READY_FOR_REVIEW'
    });
    const source = {
      collectionId,
      rowId: pair.row.id,
      rowFingerprint: pair.row.fingerprint
    };
    const item = privateItem(
      'review-item.project-page-reconciliation.properties',
      'project-properties-update',
      source,
      [
        privateField('projectId', 'Project identity', 'text', project.id),
        privateField('expectedTitle', 'Expected Project title', 'text', beforeFields.name),
        privateField('expectedVersion', 'Current Project version', 'text', project.version),
        privateField('beforeProjectType', 'Current Project type', 'string-list',
          typeof beforeFields.projectType === 'string' ? [beforeFields.projectType] : []),
        privateField('afterProjectType', 'Proposed Project type', 'string-list',
          typeof afterFields.projectType === 'string' ? [afterFields.projectType] : []),
        privateField('beforeStatus', 'Current Project status', 'string-list',
          typeof beforeFields.status === 'string' ? [beforeFields.status] : []),
        privateField('afterStatus', 'Proposed Project status', 'string-list',
          typeof afterFields.status === 'string' ? [afterFields.status] : []),
        privateField('patchFields', 'Exact changed property names', 'string-list', Object.keys(patch).sort()),
        privateField('beforeFieldsJson', 'Exact current Project fields', 'text', JSON.stringify(beforeFields)),
        privateField('afterFieldsJson', 'Exact proposed Project fields', 'text', JSON.stringify(afterFields)),
        privateField('bodyFingerprint', 'Preserved page-body fingerprint', 'text', fingerprintJson(body))
      ]
    );
    pair.row.privateDetailFingerprint = item.fingerprint;
    const change = {
      id: pair.action.id,
      recordId,
      effect: pair.action.capability,
      beforeFingerprint: fingerprintJson({ fields: beforeFields, version: project.version }),
      afterFingerprint: item.fingerprint
    };
    pair.action.changeFingerprint = fingerprintJson(change);
    rows.push(pair.row);
    items.push(item);
    proposedChanges.push(change);
  }

  if (bodyChanged) {
    const pair = actionRow({
      id: BODY_ACTION,
      sequence: rows.length + 1,
      subjectKind: 'project-page',
      subjectFingerprint: fingerprintJson({ id: project.id, body }),
      kind: 'project-body-update',
      capability: 'documents.content.update',
      reasonCode: 'PROJECT_BODY_UPDATE_READY_FOR_REVIEW'
    });
    const source = {
      collectionId,
      rowId: pair.row.id,
      rowFingerprint: pair.row.fingerprint
    };
    const item = privateItem(
      'review-item.project-page-reconciliation.body',
      'project-body-update',
      source,
      [
        privateField('projectId', 'Project identity', 'text', project.id),
        privateField('expectedTitle', 'Expected Project title', 'text', beforeFields.name),
        privateField('expectedBodyFingerprint', 'Current page-body fingerprint', 'text', fingerprintJson(body)),
        privateField('afterBodyFingerprint', 'Proposed page-body fingerprint', 'text', fingerprintJson(replacement.body)),
        privateField('beforeFieldsJson', 'Exact current Project fields', 'text', JSON.stringify(beforeFields)),
        privateField('afterFieldsJson', 'Exact proposed Project fields', 'text', JSON.stringify(afterFields)),
        privateField('updateIds', 'Exact replacement identities', 'string-list', replacement.updates.map((item) => item.id)),
        privateField('oldTexts', 'Exact current text regions', 'string-list', replacement.updates.map((item) => item.oldText)),
        privateField('newTexts', 'Exact replacement text regions', 'string-list', replacement.updates.map((item) => item.newText))
      ]
    );
    pair.row.privateDetailFingerprint = item.fingerprint;
    const change = {
      id: pair.action.id,
      recordId,
      effect: pair.action.capability,
      beforeFingerprint: fingerprintJson(body),
      afterFingerprint: item.fingerprint
    };
    pair.action.changeFingerprint = fingerprintJson(change);
    rows.push(pair.row);
    items.push(item);
    proposedChanges.push(change);
  }

  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: collectionId,
    kind: 'project-page-reconciliation-changes',
    labelKey: 'project-page-reconciliation-changes',
    coverage: {
      complete: true,
      observedCount: rows.length,
      includedCount: rows.length,
      excludedCount: 0,
      exclusions: []
    },
    rows,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  collection.fingerprint = collectionFingerprint(collection);
  const derivedReview = { kind: definition.kind, items };
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: definition.$contract,
    contractFingerprint: fingerprintJson(definition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const facts = [
    {
      id: 'project-exactly-observed',
      label: 'Exact Project current state observed',
      value: true,
      state: 'supported',
      basisIds: ['context.project-page-reconciliation.project-content']
    },
    {
      id: 'property-change-count',
      label: 'Exact Project properties proposed',
      value: Object.keys(patch).length,
      state: 'supported',
      basisIds: [
        'context.project-page-reconciliation.policy',
        'context.project-page-reconciliation.schema',
        'context.project-page-reconciliation.project-content'
      ]
    },
    {
      id: 'body-replacement-count',
      label: 'Exact one-match page replacements proposed',
      value: replacement.updates.length,
      state: 'supported',
      basisIds: ['context.project-page-reconciliation.project-content']
    },
    {
      id: 'combined-execution-atomicity',
      label: 'Combined execution boundary',
      value: propertyChanged && bodyChanged ? 'sequential-non-atomic' : 'single-operation',
      state: 'supported',
      basisIds: ['context.project-page-reconciliation.project-content']
    },
    {
      id: 'unsupported-transform-boundary',
      label: 'Dedicated append, empty deletion, whole-page, provider-structural, and reorder operations',
      value: 'unavailable',
      state: 'unavailable',
      basisIds: ['context.project-page-reconciliation.project-content']
    }
  ];
  const preview = {
    kind: 'project-page-reconciliation-preview',
    fingerprint: null,
    facts,
    contradictions: [],
    collections: [collection],
    privateReview,
    proposedChanges
  };
  preview.fingerprint = fingerprintJson({
    kind: preview.kind,
    facts,
    contradictions: [],
    collections: [collection],
    privateReview,
    proposedChanges
  });
  return { preview, derivedReview };
}

function contextStep(entry, invocation, sequence) {
  const labels = {
    'context.project-page-reconciliation.policy': 'Load exact portable Project policy',
    'context.project-page-reconciliation.schema': 'Observe current writable Project schema',
    'context.project-page-reconciliation.project': 'Load exact selected Project metadata',
    'context.project-page-reconciliation.project-content': 'Revalidate exact Project fields and mapped page body'
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
    limitation: 'This typed fixture read does not establish connected provider reachability, permission, execution, verification, or health.'
  };
}

export async function prepareProjectPageReconciliationRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  validateInput(input);
  const resolvedRoot = path.resolve(root);
  const definition = exactDerivedReviewDefinition(resolvedRoot);
  const policyDefinition = loadProjectCapturePolicyDefinition(resolvedRoot);
  const definitionAuthority = exactAuthority(lock, 'definition');
  const instanceAuthority = exactAuthority(lock, 'instance');
  const policySource = exactPolicySource(lock, definitionAuthority);
  const runId = 'run.' + workId.slice('work.'.length);
  const snapshotId = 'context.' + workId.slice('work.'.length);
  const envelope = prepareRunEnvelope({
    root: resolvedRoot,
    lock,
    lockPath,
    scenarioPath,
    automationId: AUTOMATION_ID,
    runId,
    createdAt,
    requestedOutcome: 'Prepare one exact bounded Project property and page-text reconciliation for private review, then stop before approval, start authorization, or provider writes.',
    evidenceIds: []
  });
  const policyResult = await readFixture({
    root: resolvedRoot,
    lock,
    capability: 'projects.records.read',
    authority: definitionAuthority,
    input: policySource.input,
    effectId: 'effect.project-page-reconciliation.policy.fixture',
    at: createdAt
  });
  const policy = assertProjectCapturePolicySelection(policyResult.output, policyDefinition);
  const schemaResult = await readFixture({
    root: resolvedRoot,
    lock,
    capability: 'projects.schema.read',
    authority: instanceAuthority,
    input: { recordType: 'project' },
    effectId: 'effect.project-page-reconciliation.schema.fixture',
    at: createdAt
  });
  const metadataResult = await readFixture({
    root: resolvedRoot,
    lock,
    capability: 'projects.records.read',
    authority: instanceAuthority,
    input: { recordTypes: ['project'], ids: [input.project], limit: 1 },
    effectId: 'effect.project-page-reconciliation.project.fixture',
    at: createdAt
  });
  const metadata = exactRequestedContextRecord(metadataResult.output, {
    recordType: 'project',
    requestedId: input.project
  });
  if (typeof metadata.fields?.name !== 'string' || !metadata.fields.name
    || typeof metadata.version !== 'string' || !metadata.version) {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project page reconciliation requires one exact named and versioned Project.'
    );
  }
  const contentResult = await readFixture({
    root: resolvedRoot,
    lock,
    capability: 'projects.records.read',
    authority: instanceAuthority,
    input: {
      recordTypes: ['project'],
      ids: [input.project],
      content: { expectedTitle: metadata.fields.name },
      limit: 1
    },
    effectId: 'effect.project-page-reconciliation.project-content.fixture',
    at: createdAt
  });
  const content = exactRequestedContextRecord(contentResult.output, {
    recordType: 'project',
    requestedId: input.project
  });
  if (!sameJson(content.fields, metadata.fields)
    || typeof content.body !== 'string'
    || !content.body.trim()) {
    throw preparationError(
      'PREPARATION_CONTEXT_UNAVAILABLE',
      'Project fields or mapped page body drifted during exact preparation.'
    );
  }
  const review = buildProjectPageReconciliationReview({
    input,
    project: metadata,
    body: content.body,
    policy,
    schema: schemaResult.output.schema,
    definition
  });
  const acquired = [
    {
      id: 'context.project-page-reconciliation.policy',
      role: 'definition',
      authority: definitionAuthority,
      result: policyResult
    },
    {
      id: 'context.project-page-reconciliation.schema',
      role: 'instance',
      authority: instanceAuthority,
      result: schemaResult
    },
    {
      id: 'context.project-page-reconciliation.project',
      role: 'instance',
      authority: instanceAuthority,
      result: metadataResult
    },
    {
      id: 'context.project-page-reconciliation.project-content',
      role: 'instance',
      authority: instanceAuthority,
      result: contentResult
    }
  ];
  const entries = acquired.map(snapshotEntry);
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
        'Project identities, titles, fields, versions, page bodies, replacement text, provider responses, configuration targets, and credentials are excluded from general inspection and evidence.',
        'Only selected-work private review may expose exact before and after values; preparation creates no approval, continuation, retry, or execution authority.'
      ]
    }
  };
  const byAuthority = new Map();
  for (const entry of entries) {
    const values = byAuthority.get(entry.authority) || [];
    values.push(entry.valueFingerprint);
    byAuthority.set(entry.authority, values);
  }
  envelope.context = envelope.context.map((item) => {
    const values = byAuthority.get(item.authority);
    return values ? {
      ...item,
      status: 'loaded',
      provenance: 'fixture:' + fingerprintJson(values),
      freshness: 'passed'
    } : item;
  });
  envelope.lifecycleState = 'paused';
  envelope.checkpoints = [
    {
      id: 'effects-established',
      state: 'passed',
      details: 'Read and disclosure policy was evaluated before every exact contained source.'
    },
    {
      id: 'project-current-state-revalidated',
      state: 'passed',
      details: 'Policy, writable schema, exact Project metadata, and one content-inclusive Project read were fingerprinted.'
    },
    {
      id: 'private-review-boundary-held',
      state: 'passed',
      details: 'Exact fields, page body, and replacement text remain selected-work private material.'
    },
    {
      id: 'write-boundary-held',
      state: 'passed',
      details: 'Preparation emitted review facts only; approval, start, checkpoint execution, retry, and provider writes remain separate.'
    }
  ];
  envelope.outputs = [{
    id: snapshot.id,
    type: 'context-snapshot',
    fingerprint: fingerprintJson(snapshot)
  }];
  envelope.effects = effects;
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      {
        id: 'project-current-state-exact',
        label: 'Exact Project fields and page body revalidated',
        state: 'supported',
        basis: [
          'context.project-page-reconciliation.policy',
          'context.project-page-reconciliation.schema',
          'context.project-page-reconciliation.project',
          'context.project-page-reconciliation.project-content'
        ],
        limitation: 'Contained observations do not establish current connected provider state, permission, readiness, verification, or health.'
      },
      {
        id: 'project-exact-subset-review',
        label: 'Exact supported property and one-match body subset prepared',
        state: 'supported',
        basis: ['context.project-page-reconciliation.project-content'],
        limitation: 'Unselected values are preserved. Exact substitutions may lengthen or shorten selected text; empty deletion, whole-page replacement, old-text-preserving append or prepend, reorder, provider-structural recreation, and template application are unavailable.'
      },
      {
        id: 'project-transaction-boundary',
        label: 'Every write remains behind a separate exact Core transaction',
        state: 'supported',
        basis: ['context.project-page-reconciliation.project-content'],
        limitation: review.preview.proposedChanges.length > 1
          ? 'Combined property and body operations are sequential and non-atomic. Preparation grants no authority; ambiguous outcomes are never retried and require checkpoint-bound reconciliation.'
          : 'Preparation grants no authority; approval, one-time start, checkpoint execution, and verification remain separate.'
      }
    ],
    preview: review.preview,
    derivedReview: review.derivedReview
  };
}
