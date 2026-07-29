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
  assertContactCapturePolicySelection,
  contactDuplicateFilters,
  loadContactCapturePolicyDefinition,
  normalizeContactEmail,
  normalizeContactText,
  selectContactOptions
} from './policy.mjs';

const AUTOMATION_ID = 'automation.contact-capture';
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
    'contact-capture',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'contact-capture-derived-review') {
    throw new Error(
      'Contact Capture derived review definition drifted from its Automation-owned contract.'
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
      'Contact Capture requires one exact ' + role + ' authority for ' + subject + '.'
    );
  }
  return matches[0].id;
}

function policySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID
      && consumer.purpose === 'contact-capture-policy';
  }));
  if (matches.length !== 1) {
    throw new Error('Contact Capture requires exactly one configured policy source.');
  }
  const source = matches[0];
  if (source.capability !== 'crm.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || fingerprintJson(source.input.recordTypes)
      !== fingerprintJson(['contact-capture-policy'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 1
    || source.input.limit !== 2) {
    throw new Error(
      'Contact Capture policy source must be one exact typed definition-authority read.'
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
    throw new Error('Contact Capture contained read did not pass: ' + effectId + '.');
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
    'context.contact-capture.policy': 'Load exact contact-capture policy',
    'context.contact-capture.schema': 'Observe current contact schema',
    'context.contact-capture.duplicates': 'Inspect exact email and name duplicate candidates',
    'context.contact-capture.organization': 'Resolve the requested organization relation'
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
    throw new Error('Contact schema must expose one writable portable ' + id + ' field.');
  }
  const field = matches[0];
  if (optionsRequired && (!Array.isArray(field.options) || field.options.length < 1)) {
    throw new Error('Contact schema field ' + id + ' must expose current choice options.');
  }
  if (!optionsRequired && field.options !== null) {
    throw new Error('Contact schema field ' + id + ' must not invent choice options.');
  }
  return field;
}

export function assertContactSchema(output) {
  const schema = output?.schema;
  if (!schema || schema.recordType !== 'person') {
    throw new Error('Contact Capture requires one exact person schema observation.');
  }
  schemaField(schema, 'name', false);
  schemaField(schema, 'email', false);
  const role = schemaField(schema, 'role', true);
  const status = schemaField(schema, 'status', true);
  const disposition = schemaField(schema, 'disposition', true);
  const authority = schemaField(schema, 'authority', true);
  const tags = schemaField(schema, 'tags', true);
  schemaField(schema, 'telegram', false);
  schemaField(schema, 'signal', false);
  schemaField(schema, 'github', false);
  schemaField(schema, 'timezoneUtc', false);
  schemaField(schema, 'source', false);
  schemaField(schema, 'organizationUris', false);
  return {
    schema,
    roleOptions: [...role.options],
    statusOptions: [...status.options],
    dispositionOptions: [...disposition.options],
    authorityOptions: [...authority.options],
    tagOptions: [...tags.options]
  };
}

function issueClaim(code) {
  return {
    CONTACT_ROLE_NOT_IN_CURRENT_SCHEMA: 'The requested Role is absent from the current schema and was omitted.',
    CONTACT_STATUS_NOT_IN_CURRENT_SCHEMA: 'The requested Status is absent from the current schema and was omitted.',
    CONTACT_DISPOSITION_NOT_IN_CURRENT_SCHEMA: 'The requested Disposition is absent from the current schema and was omitted.',
    CONTACT_AUTHORITY_NOT_IN_CURRENT_SCHEMA: 'At least one requested Authority label is absent from the current schema and was omitted.',
    CONTACT_TAGS_NOT_IN_CURRENT_SCHEMA: 'At least one requested Tag is absent from the current schema and was omitted.',
    CONTACT_ORGANIZATION_NOT_FOUND: 'The requested organization did not resolve to an exact existing resource; the relation remains empty.',
    CONTACT_ORGANIZATION_AMBIGUOUS: 'The requested organization resolved to multiple candidates; the relation remains empty.',
    CONTACT_DUPLICATE_CANDIDATE_OBSERVED: 'An exact email or name candidate already exists and blocks create.'
  }[code];
}

export function buildContactCapturePreview({
  input,
  policy,
  schema,
  duplicateFilters,
  duplicateIds,
  organizationRecords,
  derivedReviewDefinition
}) {
  const duplicateBasisIds = ['context.contact-capture.duplicates'];
  const organizationBasisIds = input.organizationName
    ? ['context.contact-capture.organization']
    : ['context.contact-capture.policy'];
  const selected = selectContactOptions({ input, schema });
  const name = normalizeContactText(input.name, 'name', 200);
  const email = normalizeContactEmail(input.email);
  const organizationMatches = input.organizationName
    ? organizationRecords.filter((record) => {
      return record.fields?.name?.trim().toLocaleLowerCase('en')
        === input.organizationName.trim().toLocaleLowerCase('en');
    })
    : [];
  const organizationUris = organizationMatches.length === 1
    ? [organizationMatches[0].id]
    : [];
  const issueCodes = [...selected.issues];
  if (input.organizationName && organizationMatches.length === 0) {
    issueCodes.push('CONTACT_ORGANIZATION_NOT_FOUND');
  }
  if (organizationMatches.length > 1) issueCodes.push('CONTACT_ORGANIZATION_AMBIGUOUS');
  if (duplicateIds.length) issueCodes.push('CONTACT_DUPLICATE_CANDIDATE_OBSERVED');
  const issues = [...new Set(issueCodes)].sort(compareText);
  const fields = {
    name,
    ...(email ? { email } : {}),
    ...(selected.role ? { role: selected.role } : {}),
    ...(selected.status ? { status: selected.status } : {}),
    ...(selected.disposition ? { disposition: selected.disposition } : {}),
    ...(selected.authority.length ? { authority: selected.authority } : {}),
    ...(selected.tags.length ? { tags: selected.tags } : {}),
    ...(input.telegram ? { telegram: normalizeContactText(input.telegram, 'Telegram', 300) } : {}),
    ...(input.signal ? { signal: normalizeContactText(input.signal, 'Signal', 300) } : {}),
    ...(input.github ? { github: normalizeContactText(input.github, 'GitHub', 300) } : {}),
    ...(input.timezoneUtc ? { timezoneUtc: normalizeContactText(input.timezoneUtc, 'timezone', 100) } : {}),
    ...(input.source ? { source: normalizeContactText(input.source, 'source', 500) } : {}),
    ...(organizationUris.length ? { organizationUris } : {})
  };
  const contactFingerprint = fingerprintJson({ recordType: 'person', fields });
  const proposed = duplicateIds.length === 0;
  const reasonCode = proposed
    ? 'CONTACT_CREATE_READY_FOR_REVIEW'
    : 'CONTACT_CREATE_HELD_FOR_DUPLICATE_REVIEW';
  const action = {
    id: 'action.contact-capture.create',
    kind: 'contact-create',
    capability: 'crm.records.create',
    effect: 'write',
    state: proposed ? 'proposed' : 'held',
    reasonCode,
    changeFingerprint: null
  };
  const row = {
    id: 'row.contact-capture.contact',
    sequence: 1,
    representedCount: 1,
    subject: { kind: 'crm-person', fingerprint: contactFingerprint },
    group: 'contact-capture',
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
    collectionId: 'collection.contact-capture.contact',
    rowId: row.id,
    rowFingerprint: row.fingerprint
  };
  const item = privateItem(
    'review-item.contact-capture.contact',
    'contact-create',
    [source],
    [
      privateField('name', 'Contact name', 'text', fields.name),
      privateField('email', 'Email', 'string-list', fields.email ? [fields.email] : []),
      privateField('role', 'Role', 'string-list', fields.role ? [fields.role] : []),
      privateField('status', 'Status', 'string-list', fields.status ? [fields.status] : []),
      privateField('disposition', 'Disposition', 'string-list', fields.disposition ? [fields.disposition] : []),
      privateField('authority', 'Authority', 'string-list', fields.authority || []),
      privateField('tags', 'Tags', 'string-list', fields.tags || []),
      privateField('telegram', 'Telegram', 'string-list', fields.telegram ? [fields.telegram] : []),
      privateField('signal', 'Signal', 'string-list', fields.signal ? [fields.signal] : []),
      privateField('github', 'GitHub', 'string-list', fields.github ? [fields.github] : []),
      privateField('timezoneUtc', 'Timezone (UTC)', 'string-list', fields.timezoneUtc ? [fields.timezoneUtc] : []),
      privateField('source', 'Source', 'string-list', fields.source ? [fields.source] : []),
      privateField('organizationUris', 'Resolved organization', 'string-list', fields.organizationUris || []),
      privateField(
        'duplicateSearchValues',
        'Exact duplicate search values',
        'string-list',
        duplicateFilters.map((filter) => Object.keys(filter)[0] + ':' + Object.values(filter)[0])
      )
    ]
  );
  row.privateDetailFingerprint = item.fingerprint;
  const proposedChanges = [];
  if (proposed) {
    const change = {
      id: action.id,
      recordId: 'new:person:'
        + contactFingerprint.slice('sha256:'.length, 'sha256:'.length + 16),
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
    kind: 'contact-capture-contact',
    labelKey: 'contact-capture-contact',
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
    basisIds: code === 'CONTACT_DUPLICATE_CANDIDATE_OBSERVED'
      ? duplicateBasisIds
      : code.startsWith('CONTACT_ORGANIZATION_')
        ? organizationBasisIds
      : ['context.contact-capture.policy', 'context.contact-capture.schema']
  }));
  const facts = [
    { id: 'policy-bound', label: 'Policy identity bound', value: true, state: 'supported', basisIds: ['context.contact-capture.policy'] },
    { id: 'schema-fingerprint', label: 'Current schema fingerprint', value: schema.schema.fingerprint, state: 'supported', basisIds: ['context.contact-capture.schema'] },
    { id: 'role-option-count', label: 'Current Role options', value: schema.roleOptions.length, state: 'supported', basisIds: ['context.contact-capture.schema'] },
    { id: 'disposition-option-count', label: 'Current Disposition options', value: schema.dispositionOptions.length, state: 'supported', basisIds: ['context.contact-capture.schema'] },
    { id: 'authority-option-count', label: 'Current Authority options', value: schema.authorityOptions.length, state: 'supported', basisIds: ['context.contact-capture.schema'] },
    { id: 'tag-option-count', label: 'Current Tag options', value: schema.tagOptions.length, state: 'supported', basisIds: ['context.contact-capture.schema'] },
    { id: 'duplicate-query-count', label: 'Exact duplicate keys inspected', value: duplicateFilters.length, state: 'supported', basisIds: duplicateBasisIds },
    { id: 'duplicate-candidate-count', label: 'Duplicate candidates', value: duplicateIds.length, state: duplicateIds.length ? 'contradicted' : 'supported', basisIds: duplicateBasisIds },
    { id: 'organization-resolved', label: 'Organization relation resolved', value: organizationUris.length === 1, state: input.organizationName ? (organizationUris.length === 1 ? 'supported' : 'unavailable') : 'unavailable', basisIds: organizationBasisIds },
    { id: 'unmatched-option-count', label: 'Requested options omitted', value: selected.issues.length, state: selected.issues.length ? 'contradicted' : 'supported', basisIds: ['context.contact-capture.policy', 'context.contact-capture.schema'] }
  ];
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedReviewDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedReviewDefinition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'contact-capture-preview',
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
  return { preview, derivedReview, contactFingerprint, fields, issues };
}

export async function prepareContactCaptureRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  const derivedReviewDefinition = exactDerivedReviewDefinition(root);
  const policyDefinition = loadContactCapturePolicyDefinition(root);
  const definitionAuthority = authority(lock, 'definition');
  const instanceAuthority = authority(lock, 'instance');
  const source = policySource(lock, definitionAuthority);
  const duplicateFilters = contactDuplicateFilters(input, policyDefinition);
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
    requestedOutcome: 'Prepare one exact schema-grounded contact-create review and stop before change-set issuance, approval, or provider writes.',
    evidenceIds: []
  });

  const policyResult = await readFixture({
    root,
    lock,
    capability: 'crm.records.read',
    authorityId: definitionAuthority,
    input: source.input,
    effectId: 'effect.contact-capture.preparation.policy.fixture',
    at: createdAt
  });
  const policy = assertContactCapturePolicySelection(policyResult.output, policyDefinition);
  const schemaResult = await readFixture({
    root,
    lock,
    capability: 'crm.schema.read',
    authorityId: instanceAuthority,
    input: { recordType: 'person' },
    effectId: 'effect.contact-capture.preparation.schema.fixture',
    at: createdAt
  });
  const schema = assertContactSchema(schemaResult.output);
  const duplicateResult = await readFixture({
    root,
    lock,
    capability: 'crm.records.read',
    authorityId: instanceAuthority,
    input: {
      recordTypes: ['person'],
      filtersAny: duplicateFilters,
      limit: policyDefinition.duplicateCandidateLimit
    },
    effectId: 'effect.contact-capture.preparation.duplicates.fixture',
    at: createdAt
  });
  const duplicateRecords = duplicateResult.output.records.filter((record) => {
    return record.type === 'person';
  });
  const duplicateIds = [...new Set(duplicateRecords.map((record) => record.id))].sort(compareText);
  const organizationResult = input.organizationName
    ? await readFixture({
      root,
      lock,
      capability: 'crm.records.read',
      authorityId: instanceAuthority,
      input: {
        recordTypes: ['organization'],
        filtersAny: [{ name: input.organizationName }],
        limit: policyDefinition.organizationCandidateLimit
      },
      effectId: 'effect.contact-capture.preparation.organization.fixture',
      at: createdAt
    })
    : null;
  const organizationRecords = (organizationResult?.output?.records || []).filter((record) => {
    return record.type === 'organization';
  });
  const acquired = [
    {
      result: policyResult,
      entry: snapshotEntry({
        id: 'context.contact-capture.policy',
        subject: 'crm.records.contact-capture-policy',
        authorityId: definitionAuthority,
        role: 'definition',
        result: policyResult
      })
    },
    {
      result: schemaResult,
      entry: snapshotEntry({
        id: 'context.contact-capture.schema',
        subject: 'crm.schema.person',
        authorityId: instanceAuthority,
        role: 'instance',
        result: schemaResult
      })
    },
    {
      result: duplicateResult,
      entry: snapshotEntry({
        id: 'context.contact-capture.duplicates',
        subject: 'crm.records.contact-candidates',
        authorityId: instanceAuthority,
        role: 'instance',
        result: duplicateResult,
        value: {
          candidateCount: duplicateRecords.length,
          candidateIds: duplicateIds,
          providerOutputFingerprint: duplicateResult.invocation.outputFingerprint
        }
      })
    },
    ...(organizationResult ? [{
      result: organizationResult,
      entry: snapshotEntry({
        id: 'context.contact-capture.organization',
        subject: 'crm.records.organization-candidates',
        authorityId: instanceAuthority,
        role: 'instance',
        result: organizationResult,
        value: {
          candidateCount: organizationRecords.length,
          candidateIds: organizationRecords.map((record) => record.id).sort(compareText),
          providerOutputFingerprint: organizationResult.invocation.outputFingerprint
        }
      })
    }] : [])
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
        'Provider credentials, raw contact values, raw schema responses, organization names, and candidate fields are excluded from workspace inspection.'
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
    { id: 'contact-review-grounded', state: 'passed', details: 'The exact policy, current normalized schema, bounded duplicate candidates, and optional organization candidates were loaded.' },
    { id: 'write-boundary-held', state: 'passed', details: 'No change set, approval, continuation request, provider write, or canonical write was issued.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;

  const built = buildContactCapturePreview({
    input,
    policy: policyDefinition,
    schema,
    duplicateFilters,
    duplicateIds,
    organizationRecords,
    derivedReviewDefinition
  });
  const proposed = built.preview.proposedChanges.length === 1;
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      { id: 'contact-policy-grounded', label: 'Exact contact-capture policy grounded', state: 'supported', basis: ['context.contact-capture.policy'], limitation: 'The external record identifies a governed local Context definition; this fixture does not establish connected provider conformance.' },
      { id: 'contact-schema-grounded', label: 'Current normalized contact schema grounded', state: 'supported', basis: ['context.contact-capture.schema'], limitation: 'This contained observation does not establish the schema remains unchanged at execution time.' },
      { id: 'contact-create-preview', label: 'Contact create scope prepared for review', state: proposed ? 'proposed' : 'blocked', basis: ['context.contact-capture.policy', 'context.contact-capture.schema', 'context.contact-capture.duplicates', ...(organizationResult ? ['context.contact-capture.organization'] : [])], limitation: proposed ? 'Unavailable optional selections and unresolved organization relations are omitted and flagged; this fingerprint-only preview grants no approval, continuation, execution, write, or retry authority.' : 'An exact duplicate candidate prevents a contact-create proposal.' }
    ],
    preview: built.preview,
    derivedReview: built.derivedReview
  };
}
