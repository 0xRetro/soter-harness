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
  assertOrganizationCapturePolicySelection,
  classifyOrganization,
  loadOrganizationCapturePolicyDefinition,
  normalizeOrganizationTwitter,
  normalizeOrganizationWebsite,
  organizationDuplicateNames
} from './policy.mjs';

const AUTOMATION_ID = 'automation.organization-capture';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactDerivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'organization-capture',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'organization-capture-derived-review') {
    throw new Error(
      'Organization Capture derived review definition drifted from its Automation-owned contract.'
    );
  }
  return definition;
}

function authority(lock, role, subject = 'crm.records') {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error(
      'Organization Capture requires one exact ' + role + ' authority for ' + subject + '.'
    );
  }
  return matches[0].id;
}

function policySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID
      && consumer.purpose === 'organization-capture-policy';
  }));
  if (matches.length !== 1) {
    throw new Error('Organization Capture requires exactly one configured policy source.');
  }
  const source = matches[0];
  if (source.capability !== 'crm.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || fingerprintJson(source.input.recordTypes)
      !== fingerprintJson(['organization-capture-policy'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 1
    || source.input.limit !== 2) {
    throw new Error(
      'Organization Capture policy source must be one exact typed definition-authority read.'
    );
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
    throw new Error('Organization Capture contained read did not pass: ' + effectId + '.');
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
    'context.organization-capture.policy': 'Load exact organization-capture policy',
    'context.organization-capture.schema': 'Observe current organization schema'
  };
  return {
    id: 'preparation.context.' + String(sequence),
    sequence,
    label: labels[entry.id] || 'Inspect one bounded organization alias candidate set',
    capability: entry.capability,
    authority: entry.authority,
    containment: 'fixture',
    state: 'completed',
    inputFingerprint: invocation.inputFingerprint,
    outputFingerprint: entry.valueFingerprint,
    limitation: 'This is a typed fixture read; it does not establish connected reachability, permission, schema freshness at execution, or provider write behavior.'
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

function schemaField(schema, id, optionsRequired) {
  const matches = schema.fields.filter((field) => field.id === id);
  if (matches.length !== 1 || matches[0].writable !== true) {
    throw new Error('Organization schema must expose one writable portable ' + id + ' field.');
  }
  const field = matches[0];
  if (optionsRequired && (!Array.isArray(field.options) || field.options.length < 1)) {
    throw new Error('Organization schema field ' + id + ' must expose current choice options.');
  }
  if (!optionsRequired && field.options !== null) {
    throw new Error('Organization schema field ' + id + ' must not invent choice options.');
  }
  return field;
}

export function assertOrganizationSchema(output) {
  const schema = output?.schema;
  if (!schema || schema.recordType !== 'organization') {
    throw new Error('Organization Capture requires one exact organization schema observation.');
  }
  schemaField(schema, 'name', false);
  const organizationType = schemaField(schema, 'organizationType', true);
  const tags = schemaField(schema, 'tags', true);
  schemaField(schema, 'website', false);
  schemaField(schema, 'twitter', false);
  schemaField(schema, 'projectUris', false);
  schemaField(schema, 'contactUris', false);
  return {
    schema,
    typeOptions: [...organizationType.options],
    tagOptions: [...tags.options]
  };
}

function issueClaim(code) {
  return {
    ORG_TYPE_NOT_IN_CURRENT_SCHEMA: 'The requested organization Type is not present in the current schema observation.',
    ORG_TYPE_POLICY_SCHEMA_DRIFT: 'A governed Type rule names a value absent from the current schema observation.',
    ORG_TYPE_UNRESOLVED: 'The governed classification rules do not resolve one organization Type.',
    ORG_TYPE_AMBIGUOUS: 'The governed classification rules resolve more than one organization Type.',
    ORG_TYPE_CONTRADICTS_GOVERNED_CLASSIFICATION: 'The requested Type conflicts with the deterministic governed classification.',
    ORG_TAG_NOT_IN_CURRENT_SCHEMA: 'A requested organization Tag is not present in the current schema observation.',
    ORG_SECTOR_TAG_UNAVAILABLE: 'A detected sector signal has no matching current Tag option.',
    ORG_DUPLICATE_CANDIDATE_OBSERVED: 'At least one bounded alias search returned an existing organization candidate.'
  }[code];
}

export function buildOrganizationCapturePreview({
  input,
  policy,
  schema,
  duplicateNames,
  duplicateIds,
  derivedReviewDefinition
}) {
  const duplicateBasisIds = duplicateNames.map((_, index) => {
    return 'context.organization-capture.duplicates.' + String(index + 1);
  });
  const website = normalizeOrganizationWebsite(input.website);
  const twitter = normalizeOrganizationTwitter(input.twitter);
  const classified = classifyOrganization({
    input,
    policy,
    typeOptions: schema.typeOptions,
    tagOptions: schema.tagOptions
  });
  const issueCodes = [...classified.issues];
  if (duplicateIds.length) issueCodes.push('ORG_DUPLICATE_CANDIDATE_OBSERVED');
  const issues = [...new Set(issueCodes)].sort(compareText);
  const fields = {
    name: input.name,
    ...(classified.organizationType ? { organizationType: classified.organizationType } : {}),
    ...(classified.tags.length ? { tags: classified.tags } : {}),
    ...(website ? { website } : {}),
    ...(twitter ? { twitter } : {})
  };
  const organizationFingerprint = fingerprintJson({ recordType: 'organization', fields });
  const proposed = issues.length === 0;
  const reasonCode = proposed
    ? 'ORGANIZATION_CREATE_READY_FOR_REVIEW'
    : duplicateIds.length
      ? 'ORGANIZATION_CREATE_HELD_FOR_DUPLICATE_REVIEW'
      : 'ORGANIZATION_CREATE_HELD_FOR_CLASSIFICATION_REVIEW';
  const action = {
    id: 'action.organization-capture.create',
    kind: 'organization-create',
    capability: 'crm.records.create',
    effect: 'write',
    state: proposed ? 'proposed' : 'held',
    reasonCode,
    changeFingerprint: null
  };
  const row = {
    id: 'row.organization-capture.organization',
    sequence: 1,
    representedCount: 1,
    subject: { kind: 'crm-organization', fingerprint: organizationFingerprint },
    group: 'organization-capture',
    attention: 'operator',
    disposition: 'itemized',
    reasonCode,
    flags: issues,
    actions: [action],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  row.fingerprint = reviewRowFingerprint(row);
  const source = {
    collectionId: 'collection.organization-capture.organization',
    rowId: row.id,
    rowFingerprint: row.fingerprint
  };
  const item = privateItem(
    'review-item.organization-capture.organization',
    'organization-create',
    [source],
    [
      privateField('name', 'Organization name', 'text', fields.name),
      privateField(
        'organizationType',
        'Organization type',
        'string-list',
        fields.organizationType ? [fields.organizationType] : []
      ),
      privateField('tags', 'Organization tags', 'string-list', fields.tags || []),
      privateField('website', 'Website', 'string-list', fields.website ? [fields.website] : []),
      privateField('twitter', 'Twitter profile', 'string-list', fields.twitter ? [fields.twitter] : []),
      privateField('duplicateSearchNames', 'Exact duplicate search names', 'string-list', duplicateNames)
    ]
  );
  row.privateDetailFingerprint = item.fingerprint;
  const proposedChanges = [];
  if (proposed) {
    const change = {
      id: action.id,
      recordId: 'new:organization:'
        + organizationFingerprint.slice('sha256:'.length, 'sha256:'.length + 16),
      effect: 'crm.records.create',
      beforeFingerprint: null,
      afterFingerprint: item.fingerprint
    };
    action.changeFingerprint = fingerprintJson(change);
    proposedChanges.push(change);
  }
  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: source.collectionId,
    kind: 'organization-capture-organization',
    labelKey: 'organization-capture-organization',
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
  const derivedReview = { kind: derivedReviewDefinition.kind, items: [item] };
  const contradictions = issues.map((code) => ({
    id: code.toLocaleLowerCase('en').replaceAll('_', '-'),
    claim: issueClaim(code),
    state: 'observed',
    basisIds: code === 'ORG_DUPLICATE_CANDIDATE_OBSERVED'
      ? duplicateBasisIds
      : ['context.organization-capture.policy', 'context.organization-capture.schema']
  }));
  const facts = [
    { id: 'policy-bound', label: 'Policy identity bound', value: true, state: 'supported', basisIds: ['context.organization-capture.policy'] },
    { id: 'schema-fingerprint', label: 'Current schema fingerprint', value: schema.schema.fingerprint, state: 'supported', basisIds: ['context.organization-capture.schema'] },
    { id: 'type-option-count', label: 'Current Type options', value: schema.typeOptions.length, state: 'supported', basisIds: ['context.organization-capture.schema'] },
    { id: 'tag-option-count', label: 'Current Tag options', value: schema.tagOptions.length, state: 'supported', basisIds: ['context.organization-capture.schema'] },
    { id: 'classification-resolved', label: 'Type classification resolved', value: Boolean(classified.organizationType), state: classified.organizationType ? 'supported' : 'unavailable', basisIds: ['context.organization-capture.policy', 'context.organization-capture.schema'] },
    { id: 'sector-tag-count', label: 'Detected sector tags', value: classified.detectedSectorCount, state: 'supported', basisIds: ['context.organization-capture.policy', 'context.organization-capture.schema'] },
    { id: 'alias-query-count', label: 'Alias queries inspected', value: duplicateNames.length, state: 'supported', basisIds: duplicateBasisIds },
    { id: 'duplicate-candidate-count', label: 'Duplicate candidates', value: duplicateIds.length, state: duplicateIds.length ? 'contradicted' : 'supported', basisIds: duplicateBasisIds },
    { id: 'relations-empty-on-create', label: 'Relations remain empty', value: true, state: 'supported', basisIds: ['context.organization-capture.policy'] },
    { id: 'website-normalized', label: 'Website normalized', value: Boolean(website), state: website ? 'supported' : 'unavailable', basisIds: ['context.organization-capture.policy'] },
    { id: 'twitter-normalized', label: 'Twitter normalized', value: Boolean(twitter), state: twitter ? 'supported' : 'unavailable', basisIds: ['context.organization-capture.policy'] }
  ];
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedReviewDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedReviewDefinition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'organization-capture-preview',
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
  return { preview, derivedReview, organizationFingerprint, fields, issues };
}

export async function prepareOrganizationCaptureRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  const derivedReviewDefinition = exactDerivedReviewDefinition(root);
  const policyDefinition = loadOrganizationCapturePolicyDefinition(root);
  const definitionAuthority = authority(lock, 'definition');
  const instanceAuthority = authority(lock, 'instance');
  const source = policySource(lock, definitionAuthority);
  const duplicateNames = organizationDuplicateNames(input, policyDefinition);
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
    requestedOutcome: 'Prepare one exact schema-grounded organization-create review and stop before change-set issuance, approval, or provider writes.',
    evidenceIds: []
  });

  const policyResult = await readFixture({
    root,
    lock,
    capability: 'crm.records.read',
    authorityId: definitionAuthority,
    input: source.input,
    effectId: 'effect.organization-capture.preparation.policy.fixture',
    at: createdAt
  });
  const policy = assertOrganizationCapturePolicySelection(policyResult.output, policyDefinition);
  const schemaResult = await readFixture({
    root,
    lock,
    capability: 'crm.schema.read',
    authorityId: instanceAuthority,
    input: { recordType: 'organization' },
    effectId: 'effect.organization-capture.preparation.schema.fixture',
    at: createdAt
  });
  const schema = assertOrganizationSchema(schemaResult.output);
  const duplicateResults = [];
  for (const [index, name] of duplicateNames.entries()) {
    duplicateResults.push(await readFixture({
      root,
      lock,
      capability: 'crm.records.read',
      authorityId: instanceAuthority,
      input: {
        recordTypes: ['organization'],
        filters: { name },
        limit: policyDefinition.duplicateCandidateLimit
      },
      effectId: 'effect.organization-capture.preparation.duplicate.' + String(index + 1) + '.fixture',
      at: createdAt
    }));
  }
  const duplicateRecords = duplicateResults.flatMap((result) => {
    return result.output.records.filter((record) => record.type === 'organization');
  });
  const duplicateIds = [...new Set(duplicateRecords.map((record) => record.id))].sort(compareText);
  const acquired = [
    {
      result: policyResult,
      entry: snapshotEntry({
        id: 'context.organization-capture.policy',
        subject: 'crm.records.organization-capture-policy',
        authorityId: definitionAuthority,
        role: 'definition',
        result: policyResult
      })
    },
    {
      result: schemaResult,
      entry: snapshotEntry({
        id: 'context.organization-capture.schema',
        subject: 'crm.schema.organization',
        authorityId: instanceAuthority,
        role: 'instance',
        result: schemaResult
      })
    },
    ...duplicateResults.map((result, index) => ({
      result,
      entry: snapshotEntry({
        id: 'context.organization-capture.duplicates.' + String(index + 1),
        subject: 'crm.records.organization-candidates',
        authorityId: instanceAuthority,
        role: 'instance',
        result,
        value: {
          candidateCount: result.output.records.length,
          candidateIds: result.output.records.map((record) => record.id).sort(compareText),
          providerOutputFingerprint: result.invocation.outputFingerprint
        }
      })
    }))
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
        'Provider credentials, raw operator prose, raw schema responses, aliases, URLs, and duplicate candidate fields are excluded from workspace inspection.'
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
    { id: 'effects-established', state: 'passed', details: 'Read and disclosure policies were evaluated before each contained invocation.' },
    { id: 'organization-review-grounded', state: 'passed', details: 'The exact policy, current normalized schema, and every bounded alias candidate set were loaded.' },
    { id: 'write-boundary-held', state: 'passed', details: 'No change set, approval, continuation request, provider write, or canonical write was issued.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;

  const built = buildOrganizationCapturePreview({
    input,
    policy: policyDefinition,
    schema,
    duplicateNames,
    duplicateIds,
    derivedReviewDefinition
  });
  const proposed = built.preview.proposedChanges.length === 1;
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      { id: 'organization-policy-grounded', label: 'Exact organization-capture policy grounded', state: 'supported', basis: ['context.organization-capture.policy'], limitation: 'The external record identifies a governed local Context definition; this fixture does not establish connected provider conformance.' },
      { id: 'organization-schema-grounded', label: 'Current normalized organization schema grounded', state: 'supported', basis: ['context.organization-capture.schema'], limitation: 'This contained observation does not establish the schema remains unchanged at execution time.' },
      { id: 'organization-create-preview', label: 'Organization create scope prepared for review', state: proposed ? 'proposed' : 'blocked', basis: ['context.organization-capture.policy', 'context.organization-capture.schema', ...duplicateNames.map((_, index) => 'context.organization-capture.duplicates.' + String(index + 1))], limitation: proposed ? 'This fingerprint-only preview and selected private review grant no approval, continuation, execution, write, or retry authority.' : 'Classification, schema drift, or a duplicate candidate prevents an organization-create proposal.' }
    ],
    preview: built.preview,
    derivedReview: built.derivedReview
  };
}
