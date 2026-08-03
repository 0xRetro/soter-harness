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

const AUTOMATION_ID = 'automation.filing-a-drive-artifact';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';
const REQUIRED_DOCUMENT_FIELDS = [
  'categories',
  'description',
  'documentType',
  'link',
  'name',
  'organizationUris',
  'ownerIds',
  'relatedProjectUris'
];

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactDerivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'filing-a-drive-artifact',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'drive-filing-derived-review') {
    throw new Error('Drive Filing derived review definition drifted from its Automation-owned contract.');
  }
  return definition;
}

function authority(lock, role, subject) {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error(
      'Drive Filing requires one exact ' + role + ' authority for ' + subject + '.'
    );
  }
  return matches[0].id;
}

function registrySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID
      && consumer.purpose === 'storage-location-registry';
  }));
  if (matches.length !== 1) {
    throw new Error('Drive Filing requires exactly one configured storage-location-registry source.');
  }
  const source = matches[0];
  if (source.capability !== 'storage.registry.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || typeof source.input.registryId !== 'string'
    || !source.input.registryId) {
    throw new Error('Drive Filing registry source must be one exact typed definition-authority read.');
  }
  return source;
}

async function readFixture({
  root,
  lock,
  capability,
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
    throw new Error('Drive Filing contained read did not pass: ' + effectId + '.');
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
    'context.drive-filing.registry': 'Load exact storage policy and destination registry',
    'context.drive-filing.artifact': 'Read exact artifact metadata without content',
    'context.drive-filing.document-schema': 'Read current document-index schema',
    'context.drive-filing.document-candidates': 'Inspect bounded Link and Name candidates',
    'context.drive-filing.organization': 'Resolve exact organization reference',
    'context.drive-filing.identity': 'Resolve authenticated current-user identity'
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
    limitation: 'This is a typed fixture read; it does not establish connected identity, reachability, permission, shortcut creation, record creation, or write verification.'
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

function assertRegistry(output, expectedId) {
  const registry = output.registry;
  if (registry.id !== expectedId
    || registry.fingerprint !== fingerprintJson({
      id: registry.id,
      policy: registry.policy,
      locations: registry.locations
    })) {
    throw new Error('Drive Filing registry identity or fingerprint is invalid.');
  }
  const policy = registry.policy;
  if (policy.placementRequiresConfirmation !== true
    || policy.indexRequired !== true
    || policy.movesHumanOnly !== true
    || policy.renameAllowed !== false
    || policy.deleteAllowed !== false
    || policy.externalDefaultForm !== 'shortcut'
    || policy.snapshotForm !== 'copy') {
    throw new Error('Drive Filing policy drifted outside the no-move, indexed, confirmation-bound contract.');
  }
  const keys = registry.locations.map((location) => location.key);
  const uris = registry.locations.map((location) => location.uri);
  if (new Set(keys).size !== keys.length || new Set(uris).size !== uris.length) {
    throw new Error('Drive Filing registry contains duplicate destination identities.');
  }
  const subjectOwners = new Map();
  for (const location of registry.locations) {
    if (!Array.isArray(location.documentCategories) || location.documentCategories.length === 0) {
      throw new Error('Every Drive Filing destination requires at least one governed document category.');
    }
    for (const subject of location.subjectKeys) {
      if (subjectOwners.has(subject)) {
        throw new Error('Drive Filing registry maps one subject key to several destinations.');
      }
      subjectOwners.set(subject, location.key);
    }
  }
  const inboxes = registry.locations.filter((location) => {
    return location.key === policy.unclearHomeKey && location.kind === 'inbox';
  });
  if (inboxes.length !== 1) {
    throw new Error('Drive Filing policy does not resolve one exact registered unclear-case inbox.');
  }
  return { registry, subjectOwners, inbox: inboxes[0] };
}

function selectDestination({ registry, subjectOwners, inbox }, subjectKey) {
  if (!subjectKey) {
    return { location: inbox, provisional: true, subjectRegistered: true };
  }
  const locationKey = subjectOwners.get(subjectKey);
  if (!locationKey) {
    return { location: inbox, provisional: true, subjectRegistered: false };
  }
  const matches = registry.locations.filter((location) => location.key === locationKey);
  if (matches.length !== 1 || matches[0].kind !== 'home') {
    throw new Error('Drive Filing subject key does not resolve one exact registered home.');
  }
  return { location: matches[0], provisional: false, subjectRegistered: true };
}

function assertDocumentSchema(output) {
  const schema = output.schema;
  if (schema.recordType !== 'document-index'
    || schema.fingerprint !== fingerprintJson({
      recordType: schema.recordType,
      fields: schema.fields
    })) {
    throw new Error('Drive Filing document-index schema identity or fingerprint is invalid.');
  }
  const byId = new Map(schema.fields.map((field) => [field.id, field]));
  if (byId.size !== schema.fields.length
    || REQUIRED_DOCUMENT_FIELDS.some((fieldId) => !byId.get(fieldId)?.writable)) {
    throw new Error('Drive Filing document-index schema does not expose every required portable field.');
  }
  const documentTypeOptions = byId.get('documentType').options;
  const categoryOptions = byId.get('categories').options;
  if (!Array.isArray(documentTypeOptions) || !documentTypeOptions.length
    || !Array.isArray(categoryOptions) || !categoryOptions.length) {
    throw new Error('Drive Filing document Type and Category require current closed option sets.');
  }
  return {
    schema,
    documentTypeOptions: new Set(documentTypeOptions),
    categoryOptions: new Set(categoryOptions)
  };
}

function contradiction(id, claim, basisIds) {
  return { id, claim, state: 'observed', basisIds };
}

function fixedFlags(values) {
  return [...new Set(values)].sort(compareCodepoint);
}

function syntheticRecordId(prefix, fingerprint) {
  return 'new:' + prefix + ':'
    + fingerprint.slice('sha256:'.length, 'sha256:'.length + 16);
}

export function buildDriveFilingPreview({
  input,
  registry,
  destination,
  artifact,
  documentSchema,
  organizationUris,
  ownerIds,
  duplicateIds,
  derivedReviewDefinition
}) {
  const alternatives = input.alternativeSubjectKeys || [];
  const subjectLocations = new Map();
  for (const location of registry.locations) {
    for (const subject of location.subjectKeys) subjectLocations.set(subject, location);
  }
  const invalidAlternatives = alternatives.filter((subject) => !subjectLocations.has(subject));
  const alreadyAtDestination = artifact.parentUris.includes(destination.location.uri);
  const artifactSupported = artifact.kind !== 'folder';
  const externalPlacement = artifactSupported
    && artifact.kind === 'file'
    && artifact.ownership === 'external'
    && !alreadyAtDestination;
  const humanMoveRequired = artifactSupported
    && !alreadyAtDestination
    && !externalPlacement;
  const form = alreadyAtDestination
    ? 'already-present'
    : humanMoveRequired
      ? 'human-move'
      : externalPlacement
        ? (input.frozenSnapshot ? registry.policy.snapshotForm : registry.policy.externalDefaultForm)
        : 'unsupported';
  const placementCapability = externalPlacement
    ? (form === 'copy' ? 'storage.files.copy' : 'storage.shortcuts.create')
    : null;
  const documentTypeValid = typeof input.documentType === 'string'
    && documentSchema.documentTypeOptions.has(input.documentType);
  const categoriesValid = destination.location.documentCategories.every((category) => {
    return documentSchema.categoryOptions.has(category);
  });
  const organizationResolved = organizationUris.length === 1;
  const ownerResolved = ownerIds.length === 1;
  const flags = [];
  const contradictions = [];

  if (input.retentionDecision !== 'keep') {
    flags.push('DRIVE_RETENTION_DECISION_REQUIRED');
    contradictions.push(contradiction(
      'retention-decision-required',
      'Artifact retention remains a human decision and is unresolved for this review.',
      ['context.drive-filing.artifact']
    ));
  }
  if (destination.provisional) {
    flags.push(destination.subjectRegistered
      ? 'DRIVE_HOME_PROVISIONAL_INBOX'
      : 'DRIVE_SUBJECT_NOT_REGISTERED');
    contradictions.push(contradiction(
      'registered-final-home-unavailable',
      'The registered unclear-case inbox is provisional and must not be presented as a final subject home.',
      ['context.drive-filing.registry', 'context.drive-filing.artifact']
    ));
  }
  if (invalidAlternatives.length) {
    flags.push('DRIVE_ALTERNATIVE_SUBJECT_NOT_REGISTERED');
    contradictions.push(contradiction(
      'alternative-subject-unregistered',
      'At least one proposed alternative does not resolve to the current registered destination set.',
      ['context.drive-filing.registry']
    ));
  }
  if (!artifactSupported) {
    flags.push('DRIVE_ARTIFACT_KIND_UNSUPPORTED');
    contradictions.push(contradiction(
      'artifact-kind-unsupported',
      'Folder filing is outside this single file-or-shortcut Automation boundary.',
      ['context.drive-filing.artifact']
    ));
  }
  if (humanMoveRequired) {
    flags.push('DRIVE_EXISTING_ARTIFACT_REQUIRES_HUMAN_MOVE');
    contradictions.push(contradiction(
      'existing-artifact-requires-human-move',
      'An existing organization-owned artifact or shortcut must be moved by a human and cannot be copied into place as a workaround.',
      ['context.drive-filing.registry', 'context.drive-filing.artifact']
    ));
  }
  if (!ownerResolved) {
    flags.push('DRIVE_DOCUMENT_OWNER_REQUIRED');
    contradictions.push(contradiction(
      'document-owner-required',
      'The required document owner has not been resolved to the authenticated current workspace identity.',
      ['context.drive-filing.document-schema']
    ));
  }
  if (!organizationResolved) {
    flags.push('DRIVE_DOCUMENT_ORGANIZATION_REQUIRED');
    contradictions.push(contradiction(
      'document-organization-required',
      'The required document organization has not been resolved to one exact CRM resource.',
      ['context.drive-filing.document-schema']
    ));
  }
  if (!documentTypeValid) {
    flags.push(input.documentType
      ? 'DRIVE_DOCUMENT_TYPE_NOT_IN_CURRENT_SCHEMA'
      : 'DRIVE_DOCUMENT_TYPE_REQUIRED');
    contradictions.push(contradiction(
      'document-type-unavailable',
      'The document Type is missing or does not exactly match the current document-index option set.',
      ['context.drive-filing.document-schema']
    ));
  }
  if (!categoriesValid) {
    flags.push('DRIVE_DOCUMENT_CATEGORY_NOT_IN_CURRENT_SCHEMA');
    contradictions.push(contradiction(
      'document-category-unavailable',
      'The registered destination category does not exactly match the current document-index option set.',
      ['context.drive-filing.registry', 'context.drive-filing.document-schema']
    ));
  }
  if (duplicateIds.length) {
    flags.push('DRIVE_DOCUMENT_DUPLICATE_CANDIDATE_OBSERVED');
    contradictions.push(contradiction(
      'document-duplicate-candidate-observed',
      'An exact Link and Name document-index candidate exists and must be reviewed instead of creating a duplicate.',
      ['context.drive-filing.document-candidates']
    ));
  }
  if (input.skipIndexRequested) {
    flags.push('DRIVE_REQUIRED_INDEX_SKIP_REQUESTED');
    contradictions.push(contradiction(
      'required-index-skip-requested',
      'The request to skip the required document index is surfaced and cannot silently remove that item from the complete plan.',
      ['context.drive-filing.registry', 'context.drive-filing.document-schema']
    ));
  }

  const stableFlags = fixedFlags(flags);
  const batchReady = stableFlags.length === 0;
  const placementReasonCode = alreadyAtDestination
    ? 'DRIVE_PLACEMENT_ALREADY_PRESENT'
    : humanMoveRequired
      ? 'DRIVE_PLACEMENT_REQUIRES_HUMAN_MOVE'
      : externalPlacement && batchReady
        ? (form === 'copy'
          ? 'DRIVE_SNAPSHOT_COPY_READY_FOR_REVIEW'
          : 'DRIVE_SHORTCUT_READY_FOR_REVIEW')
        : externalPlacement
          ? 'DRIVE_PLACEMENT_HELD_FOR_COMPLETE_PLAN'
          : 'DRIVE_PLACEMENT_HELD';
  const indexReasonCode = batchReady
    ? 'DRIVE_DOCUMENT_INDEX_READY_FOR_REVIEW'
    : duplicateIds.length
      ? 'DRIVE_DOCUMENT_INDEX_HELD_FOR_DUPLICATE_REVIEW'
      : 'DRIVE_DOCUMENT_INDEX_HELD_FOR_COMPLETE_PLAN';
  const placementAction = humanMoveRequired
    ? {
      id: 'action.drive-filing.placement',
      kind: 'storage-move',
      capability: null,
      effect: null,
      state: 'handoff',
      reasonCode: placementReasonCode
    }
    : placementCapability
      ? {
        id: 'action.drive-filing.placement',
        kind: 'storage-placement',
        capability: placementCapability,
        effect: 'write',
        state: batchReady ? 'proposed' : 'held',
        reasonCode: placementReasonCode,
        changeFingerprint: null
      }
      : {
        id: 'action.drive-filing.placement',
        kind: 'storage-placement',
        capability: null,
        effect: null,
        state: 'held',
        reasonCode: placementReasonCode
      };
  const indexAction = {
    id: 'action.drive-filing.document-index',
    kind: 'document-index-create',
    capability: 'documents.records.create',
    effect: 'write',
    state: batchReady ? 'proposed' : 'held',
    reasonCode: indexReasonCode,
    changeFingerprint: null
  };
  const placementFingerprint = fingerprintJson({
    artifactFingerprint: artifact.fingerprint,
    destinationFingerprint: fingerprintJson(destination.location),
    form
  });
  const documentFields = {
    name: artifact.name,
    documentType: documentTypeValid ? input.documentType : '',
    categories: [...destination.location.documentCategories],
    description: input.description,
    link: artifact.link,
    ownerIds,
    organizationUris,
    relatedProjectUris: []
  };
  const documentFingerprint = fingerprintJson({
    recordType: 'document-index',
    fields: documentFields
  });
  const placementRow = {
    id: 'row.drive-filing.placement',
    sequence: 1,
    representedCount: 1,
    subject: { kind: 'storage-artifact', fingerprint: placementFingerprint },
    group: 'drive-filing',
    attention: humanMoveRequired ? 'operator' : 'operator',
    disposition: humanMoveRequired ? 'handoff' : 'itemized',
    reasonCode: placementReasonCode,
    flags: stableFlags,
    actions: [placementAction],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  placementRow.fingerprint = reviewRowFingerprint(placementRow);
  const indexRow = {
    id: 'row.drive-filing.document-index',
    sequence: 2,
    representedCount: 1,
    subject: { kind: 'document-index', fingerprint: documentFingerprint },
    group: 'drive-filing',
    attention: 'operator',
    disposition: 'itemized',
    reasonCode: indexReasonCode,
    flags: stableFlags,
    actions: [indexAction],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  indexRow.fingerprint = reviewRowFingerprint(indexRow);
  const collectionId = 'collection.drive-filing.plan';
  const placementSource = {
    collectionId,
    rowId: placementRow.id,
    rowFingerprint: placementRow.fingerprint
  };
  const indexSource = {
    collectionId,
    rowId: indexRow.id,
    rowFingerprint: indexRow.fingerprint
  };
  const humanMoveInstruction = humanMoveRequired
    ? 'Move the existing artifact from '
      + artifact.parentUris.join(', ')
      + ' to ' + destination.location.label
      + ' (' + destination.location.uri + '). Do not copy, rename, or delete it.'
    : '';
  const placementItem = privateItem(
    'review-item.drive-filing.placement',
    'storage-placement',
    [placementSource],
    [
      privateField('artifactName', 'Artifact name', 'text', artifact.name),
      privateField('artifactUri', 'Artifact identity', 'text', artifact.uri),
      privateField('artifactKind', 'Artifact kind', 'text', artifact.kind),
      privateField('sourceParentUris', 'Observed source locations', 'string-list', artifact.parentUris),
      privateField('destinationKey', 'Destination key', 'text', destination.location.key),
      privateField('destinationLabel', 'Destination label', 'text', destination.location.label),
      privateField('destinationUri', 'Destination identity', 'text', destination.location.uri),
      privateField('form', 'Filed form', 'text', form),
      privateField('placementReason', 'Placement basis', 'text', input.placementReason),
      privateField('alternativeSubjectKeys', 'Alternative subjects', 'string-list', alternatives),
      privateField(
        'humanMoveInstruction',
        'Human move instruction',
        'string-list',
        humanMoveInstruction ? [humanMoveInstruction] : []
      )
    ]
  );
  const documentItem = privateItem(
    'review-item.drive-filing.document-index',
    'document-index-create',
    [indexSource],
    [
      privateField('name', 'Document name', 'text', documentFields.name),
      privateField(
        'documentType',
        'Document type',
        'string-list',
        documentTypeValid ? [documentFields.documentType] : []
      ),
      privateField('categories', 'Document categories', 'string-list', documentFields.categories),
      privateField('description', 'Description', 'text', documentFields.description),
      privateField('link', 'Artifact link', 'text', documentFields.link),
      privateField('ownerIds', 'Owner identities', 'string-list', documentFields.ownerIds),
      privateField('organizationUris', 'Organization identities', 'string-list', documentFields.organizationUris),
      privateField('relatedProjectUris', 'Related project identities', 'string-list', documentFields.relatedProjectUris)
    ]
  );
  placementRow.privateDetailFingerprint = placementItem.fingerprint;
  indexRow.privateDetailFingerprint = documentItem.fingerprint;
  const proposedChanges = [];
  if (placementAction.state === 'proposed') {
    const change = {
      id: placementAction.id,
      recordId: syntheticRecordId('storage-presence', placementFingerprint),
      effect: placementCapability,
      beforeFingerprint: null,
      afterFingerprint: placementItem.fingerprint
    };
    placementAction.changeFingerprint = fingerprintJson(change);
    proposedChanges.push(change);
  }
  if (indexAction.state === 'proposed') {
    const change = {
      id: indexAction.id,
      recordId: syntheticRecordId('document-index', documentFingerprint),
      effect: 'documents.records.create',
      beforeFingerprint: null,
      afterFingerprint: documentItem.fingerprint
    };
    indexAction.changeFingerprint = fingerprintJson(change);
    proposedChanges.push(change);
  }
  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: collectionId,
    kind: 'drive-filing-plan',
    labelKey: 'drive-filing-plan',
    coverage: {
      complete: true,
      observedCount: 2,
      includedCount: 2,
      excludedCount: 0,
      exclusions: []
    },
    rows: [placementRow, indexRow],
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  collection.fingerprint = reviewCollectionFingerprint(collection);
  const derivedReview = {
    kind: derivedReviewDefinition.kind,
    items: [placementItem, documentItem]
  };
  const facts = [
    {
      id: 'storage-policy-grounded',
      label: 'Storage policy grounded',
      value: true,
      state: 'supported',
      basisIds: ['context.drive-filing.registry']
    },
    {
      id: 'destination-classification',
      label: 'Destination classification',
      value: destination.provisional ? 'registered-inbox' : 'registered-home',
      state: destination.provisional ? 'contradicted' : 'supported',
      basisIds: ['context.drive-filing.registry']
    },
    {
      id: 'artifact-content-read',
      label: 'Artifact content read',
      value: false,
      state: 'supported',
      basisIds: ['context.drive-filing.artifact']
    },
    {
      id: 'placement-form',
      label: 'Placement form',
      value: form,
      state: artifactSupported ? 'supported' : 'unavailable',
      basisIds: ['context.drive-filing.registry', 'context.drive-filing.artifact']
    },
    {
      id: 'owner-resolved',
      label: 'Owner identity resolved',
      value: ownerResolved,
      state: ownerResolved ? 'supported' : 'unavailable',
      basisIds: ownerResolved
        ? ['context.drive-filing.document-schema', 'context.drive-filing.identity']
        : ['context.drive-filing.document-schema']
    },
    {
      id: 'organization-resolved',
      label: 'Organization identity resolved',
      value: organizationResolved,
      state: organizationResolved ? 'supported' : 'unavailable',
      basisIds: organizationResolved
        ? ['context.drive-filing.document-schema', 'context.drive-filing.organization']
        : ['context.drive-filing.document-schema']
    },
    {
      id: 'document-schema-compatible',
      label: 'Document schema compatible',
      value: documentTypeValid && categoriesValid,
      state: documentTypeValid && categoriesValid ? 'supported' : 'contradicted',
      basisIds: ['context.drive-filing.registry', 'context.drive-filing.document-schema']
    },
    {
      id: 'document-duplicate-count',
      label: 'Document duplicate candidates',
      value: duplicateIds.length,
      state: duplicateIds.length ? 'contradicted' : 'supported',
      basisIds: ['context.drive-filing.document-candidates']
    },
    {
      id: 'complete-plan-write-count',
      label: 'Complete plan proposed writes',
      value: proposedChanges.length,
      state: batchReady ? 'supported' : 'unavailable',
      basisIds: [
        'context.drive-filing.registry',
        'context.drive-filing.artifact',
        'context.drive-filing.document-schema',
        'context.drive-filing.document-candidates'
      ]
    }
  ];
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedReviewDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedReviewDefinition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'drive-filing-preview',
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
  return { preview, derivedReview, batchReady, humanMoveRequired };
}

export async function prepareDriveFilingRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  const derivedReviewDefinition = exactDerivedReviewDefinition(root);
  const storageDefinitionAuthority = authority(lock, 'definition', 'storage.locations');
  const storageInstanceAuthority = authority(lock, 'instance', 'storage.artifacts');
  const documentsDefinitionAuthority = authority(lock, 'definition', 'documents.records');
  const documentsInstanceAuthority = authority(lock, 'instance', 'documents.records');
  const crmInstanceAuthority = authority(lock, 'instance', 'crm.records');
  const notionProviderAuthority = authority(lock, 'provider', 'notion.workspace');
  const source = registrySource(lock, storageDefinitionAuthority);
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
    requestedOutcome: 'Prepare one exact artifact placement or human-move handoff plus its required document-index review, then stop before approval or provider writes.',
    evidenceIds: []
  });

  const registryResult = await readFixture({
    root,
    lock,
    capability: 'storage.registry.read',
    authorityId: storageDefinitionAuthority,
    input: source.input,
    effectId: 'effect.drive-filing.preparation.registry.fixture',
    at: createdAt
  });
  const registryState = assertRegistry(registryResult.output, source.input.registryId);
  const destination = selectDestination(registryState, input.subjectKey);
  const artifactResult = await readFixture({
    root,
    lock,
    capability: 'storage.artifacts.read',
    authorityId: storageInstanceAuthority,
    input: { uri: input.artifactUri },
    effectId: 'effect.drive-filing.preparation.artifact.fixture',
    at: createdAt
  });
  const artifact = artifactResult.output.artifact;
  if (artifact.uri !== input.artifactUri) {
    throw new Error('Drive Filing artifact metadata does not match the exact operator reference.');
  }
  const schemaResult = await readFixture({
    root,
    lock,
    capability: 'documents.schema.read',
    authorityId: documentsDefinitionAuthority,
    input: { recordType: 'document-index' },
    effectId: 'effect.drive-filing.preparation.document-schema.fixture',
    at: createdAt
  });
  const documentSchema = assertDocumentSchema(schemaResult.output);
  const duplicateResult = await readFixture({
    root,
    lock,
    capability: 'documents.records.read',
    authorityId: documentsInstanceAuthority,
    input: {
      recordType: 'document-index',
      filters: { link: artifact.link, name: artifact.name },
      limit: registryState.registry.policy.duplicateCandidateLimit
    },
    effectId: 'effect.drive-filing.preparation.document-candidates.fixture',
    at: createdAt
  });
  const duplicateIds = duplicateResult.output.records
    .filter((record) => record.type === 'document-index')
    .map((record) => record.id)
    .sort(compareCodepoint);
  const organizationResult = input.organization
    ? await readFixture({
      root,
      lock,
      capability: 'crm.records.read',
      authorityId: crmInstanceAuthority,
      input: { recordTypes: ['organization'], ids: [input.organization], limit: 2 },
      effectId: 'effect.drive-filing.preparation.organization.fixture',
      at: createdAt
    })
    : null;
  const organizationUris = organizationResult
    ? [exactRequestedContextRecord(organizationResult.output, {
      recordType: 'organization',
      requestedId: input.organization
    }).id]
    : [];
  const identityResult = input.owner === 'self'
    ? await readFixture({
      root,
      lock,
      capability: 'workspace.identity.read',
      authorityId: notionProviderAuthority,
      input: { identity: 'current-user' },
      effectId: 'effect.drive-filing.preparation.identity.fixture',
      at: createdAt
    })
    : null;
  const ownerIds = identityResult
    ? [identityResult.output.identity.providerPersonId]
    : [];
  const duplicateValue = {
    candidateCount: duplicateIds.length,
    candidateIds: duplicateIds,
    providerOutputFingerprint: duplicateResult.invocation.outputFingerprint
  };
  const acquired = [
    {
      result: registryResult,
      entry: snapshotEntry({
        id: 'context.drive-filing.registry',
        subject: 'storage.locations.drive-filing',
        authorityId: storageDefinitionAuthority,
        role: 'definition',
        result: registryResult
      })
    },
    {
      result: artifactResult,
      entry: snapshotEntry({
        id: 'context.drive-filing.artifact',
        subject: 'storage.artifacts.selected',
        authorityId: storageInstanceAuthority,
        role: 'instance',
        result: artifactResult
      })
    },
    {
      result: schemaResult,
      entry: snapshotEntry({
        id: 'context.drive-filing.document-schema',
        subject: 'documents.records.document-index-schema',
        authorityId: documentsDefinitionAuthority,
        role: 'definition',
        result: schemaResult
      })
    },
    {
      result: duplicateResult,
      entry: snapshotEntry({
        id: 'context.drive-filing.document-candidates',
        subject: 'documents.records.document-index-candidates',
        authorityId: documentsInstanceAuthority,
        role: 'instance',
        result: duplicateResult,
        value: duplicateValue
      })
    },
    ...(organizationResult ? [{
      result: organizationResult,
      entry: snapshotEntry({
        id: 'context.drive-filing.organization',
        subject: 'crm.records.organization',
        authorityId: crmInstanceAuthority,
        role: 'instance',
        result: organizationResult
      })
    }] : []),
    ...(identityResult ? [{
      result: identityResult,
      entry: snapshotEntry({
        id: 'context.drive-filing.identity',
        subject: 'notion.workspace.current-user',
        authorityId: notionProviderAuthority,
        role: 'provider',
        result: identityResult
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
        'Artifact names, resource identities, destination labels, private operator values, provider responses, credentials, and document values are excluded from general inspection.'
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
    {
      id: 'effects-established',
      state: 'passed',
      details: 'Read and disclosure policies were evaluated before every contained context invocation.'
    },
    {
      id: 'drive-filing-review-grounded',
      state: 'passed',
      details: 'The exact registry, artifact metadata, document schema, duplicate candidates, and requested references were loaded without reading artifact content.'
    },
    {
      id: 'write-boundary-held',
      state: 'passed',
      details: 'No change set, approval request, continuation request, provider write, move, rename, delete, or canonical write was issued.'
    }
  ];
  envelope.outputs = [{
    id: snapshot.id,
    type: 'context-snapshot',
    fingerprint: fingerprintJson(snapshot)
  }];
  envelope.effects = effects;

  const { preview, derivedReview, batchReady, humanMoveRequired } = buildDriveFilingPreview({
    input,
    registry: registryState.registry,
    destination,
    artifact,
    documentSchema,
    organizationUris,
    ownerIds,
    duplicateIds,
    derivedReviewDefinition
  });
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      {
        id: 'storage-policy-grounded',
        label: 'Exact storage policy and registered destinations grounded',
        state: 'supported',
        basis: ['context.drive-filing.registry'],
        limitation: 'The contained registry proves exact selection and no invention only; it does not establish connected folder existence or permission.'
      },
      {
        id: 'artifact-metadata-grounded',
        label: 'Exact artifact metadata grounded without content access',
        state: 'supported',
        basis: ['context.drive-filing.artifact'],
        limitation: 'The fixture metadata does not establish connected Drive state, ownership conformance, or live reachability.'
      },
      {
        id: 'complete-filing-plan',
        label: 'Complete placement and document-index plan prepared',
        state: batchReady ? 'proposed' : 'blocked',
        basis: [
          'context.drive-filing.registry',
          'context.drive-filing.artifact',
          'context.drive-filing.document-schema',
          'context.drive-filing.document-candidates'
        ],
        limitation: humanMoveRequired
          ? 'The exact move remains a human handoff, and all provider writes remain held until the resulting state is reviewed again.'
          : 'Fingerprint-only proposals create no approval or execution authority. Connected shortcut and document-index writes are unavailable for this workflow.'
      },
      {
        id: 'external-write-boundary',
        label: 'All external writes held behind separate authority',
        state: 'supported',
        basis: entries.map((entry) => entry.id),
        limitation: 'Preparation performs no provider write. The current host has no connected shortcut-create or document-index-create compiler for this cross-provider plan.'
      }
    ],
    preview,
    derivedReview
  };
}
