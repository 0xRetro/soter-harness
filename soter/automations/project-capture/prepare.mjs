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
  assertProjectCreationProfileSelection,
  assertProjectCapturePolicySelection,
  loadProjectCapturePolicyDefinition
} from '../../contexts/projects/project-capture-policy.mjs';
import { assertProjectCaptureSchema } from './schema.mjs';
import { compileProjectCaptureValue } from './project.mjs';

const AUTOMATION_ID = 'automation.project-capture';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';

function exactDerivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'project-capture',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'project-capture-derived-review') {
    throw new Error('Project Capture derived review definition drifted from its Automation-owned contract.');
  }
  return definition;
}

function authority(lock, role, subject = 'projects.records') {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error(
      'Project Capture requires one exact ' + role + ' authority for ' + subject + '.'
    );
  }
  return matches[0].id;
}

function policySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === 'project-capture-policy';
  }));
  if (matches.length !== 1) {
    throw new Error('Project Capture requires exactly one configured project-capture-policy source.');
  }
  const source = matches[0];
  if (source.capability !== 'projects.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || fingerprintJson(source.input.recordTypes) !== fingerprintJson(['project-capture-policy'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 1) {
    throw new Error('Project Capture policy source must be one exact typed definition-authority record read.');
  }
  return source;
}

function profileSource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === 'project-creation-profiles';
  }));
  if (matches.length !== 1) {
    throw new Error('Project Capture requires exactly one configured project-creation-profiles source.');
  }
  const source = matches[0];
  if (source.capability !== 'projects.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || fingerprintJson(source.input.recordTypes) !== fingerprintJson(['project-creation-profile'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 2
    || source.input.limit !== 2) {
    throw new Error(
      'Project Capture profile source must be one exact typed definition-authority read of the complete profile set.'
    );
  }
  return source;
}

async function readFixture({
  root,
  lock,
  capability = 'projects.records.read',
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
    throw new Error('Project Capture contained read did not pass: ' + effectId + '.');
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
    'context.project-capture.policy': 'Load exact project-capture policy',
    'context.project-capture.profile': 'Load exact Project creation profiles',
    'context.project-capture.schema': 'Observe current project schema',
    'context.project-capture.organization': 'Resolve exact organization',
    'context.project-capture.duplicates': 'Inspect bounded duplicate candidates'
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

export function buildProjectCapturePreview({
  input,
  policy,
  schema,
  organization,
  duplicateIds,
  derivedReviewDefinition,
  creationProfile = null,
  compiledProject = null
}) {
  const project = compiledProject || compileProjectCaptureValue({
    input,
    policy: policy.fields,
    schema,
    organization,
    creationProfile
  });
  const contradictions = project.issues.map((issue) => ({
    id: issue.id,
    claim: issue.claim,
    state: 'observed',
    basisIds: issue.basisIds
  }));
  if (duplicateIds.length) {
    contradictions.push({
      id: 'duplicate-candidates-observed',
      claim: 'An exact-name project candidate exists and must be reviewed instead of silently creating a duplicate.',
      state: 'observed',
      basisIds: ['context.project-capture.duplicates']
    });
  }
  const projectFields = project.fields;
  const projectFingerprint = project.afterFingerprint;
  const body = project.body;
  const milestoneLines = project.milestoneLines;
  const workItemLines = project.workItemLines;
  const flags = project.issues.map((issue) => issue.code);
  if (duplicateIds.length) flags.push('PROJECT_DUPLICATE_CANDIDATE_OBSERVED');
  const reviewable = project.issues.length === 0 && duplicateIds.length === 0;
  const reasonCode = reviewable
    ? 'COMPLETE_PROJECT_READBACK_UNAVAILABLE'
    : (project.issues[0]?.code || 'PROJECT_DUPLICATE_CANDIDATE_OBSERVED');
  if (reviewable) flags.push(reasonCode);
  const action = {
    id: 'action.project-capture.create',
    kind: 'project-create',
    capability: null,
    effect: null,
    state: 'held',
    reasonCode
  };
  const row = {
    id: 'row.project-capture.project',
    sequence: 1,
    representedCount: 1,
    subject: {
      kind: 'crm-project',
      fingerprint: projectFingerprint
    },
    group: 'project-capture',
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
    collectionId: 'collection.project-capture.project',
    rowId: row.id,
    rowFingerprint: row.fingerprint
  };
  const projectItem = privateItem(
    'review-item.project-capture.project',
    'project-create',
    [source],
    [
      privateField('name', 'Project name', 'text', projectFields.name),
      privateField(
        'organizationShortName',
        'Organization short name',
        'text',
        project.organizationShortName
      ),
      privateField('creationProfile', 'Creation profile', 'text', project.creationProfile),
      privateField('projectType', 'Project type', 'text', projectFields.projectType),
      privateField('status', 'Project status', 'text', projectFields.status),
      privateField('organizationUris', 'Organization identities', 'string-list', projectFields.organizationUris),
      privateField(
        'startDate',
        'Start date',
        'string-list',
        projectFields.startDate ? [projectFields.startDate] : []
      ),
      privateField(
        'targetEndDate',
        'Target end date',
        'string-list',
        projectFields.targetEndDate ? [projectFields.targetEndDate] : []
      ),
      privateField('body', 'Candidate body supplement', 'text', body),
      privateField('milestoneLines', 'Candidate milestone lines', 'string-list', milestoneLines),
      privateField('workItemLines', 'Candidate milestone work-item lines', 'string-list', workItemLines)
    ]
  );
  row.privateDetailFingerprint = projectItem.fingerprint;
  const proposedChanges = [];
  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: source.collectionId,
    kind: 'project-capture-project',
    labelKey: 'project-capture-project',
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
    items: [projectItem]
  };
  const facts = [
    {
      id: 'policy-identity',
      label: 'Project policy',
      value: policy.fields.name,
      state: 'supported',
      basisIds: ['context.project-capture.policy']
    },
    {
      id: 'organization-identity',
      label: 'Resolved organization',
      value: organization.id,
      state: 'supported',
      basisIds: ['context.project-capture.organization']
    },
    {
      id: 'default-status',
      label: 'Create status',
      value: policy.fields.defaultStatus,
      state: 'supported',
      basisIds: ['context.project-capture.policy']
    },
    {
      id: 'project-type',
      label: 'Project type',
      value: input.projectType,
      state: policy.fields.allowedTypes.includes(input.projectType) ? 'supported' : 'contradicted',
      basisIds: ['context.project-capture.policy', 'context.project-capture.schema']
    },
    {
      id: 'creation-profile',
      label: 'Creation profile',
      value: project.creationProfile,
      state: project.issues.some((issue) => {
        return issue.code === 'PROJECT_CREATION_PROFILE_TYPE_MISMATCH';
      }) ? 'contradicted' : 'supported',
      basisIds: ['context.project-capture.profile', 'context.project-capture.policy']
    },
    {
      id: 'project-name-policy-shaped',
      label: 'Project short-name prefix validated',
      value: !project.issues.some((issue) => {
        return issue.code === 'PROJECT_ORGANIZATION_SHORT_NAME_MISMATCH';
      }),
      state: project.issues.some((issue) => {
        return issue.code === 'PROJECT_ORGANIZATION_SHORT_NAME_MISMATCH';
      }) ? 'contradicted' : 'supported',
      basisIds: ['context.project-capture.policy', 'context.project-capture.organization']
    },
    {
      id: 'duplicate-candidate-count',
      label: 'Duplicate candidates',
      value: duplicateIds.length,
      state: duplicateIds.length ? 'contradicted' : 'supported',
      basisIds: ['context.project-capture.duplicates']
    },
    {
      id: 'milestone-count',
      label: 'Initial milestones',
      value: project.milestoneLines.length,
      state: 'supported',
      basisIds: ['context.project-capture.policy']
    },
    {
      id: 'calendar-range-pinned',
      label: 'Project date range pinned',
      value: Boolean(input.startDate && input.targetEndDate),
      state: project.issues.some((issue) => issue.code === 'PROJECT_DATE_ORDER_INVALID')
        ? 'contradicted'
        : 'supported',
      basisIds: ['context.project-capture.policy']
    },
    {
      id: 'milestone-syntax-version',
      label: 'Milestone syntax',
      value: creationProfile?.fields?.milestoneSyntaxVersion
        || policy.fields.milestoneSyntaxVersion,
      state: 'supported',
      basisIds: ['context.project-capture.policy', 'context.project-capture.profile']
    },
    {
      id: 'work-item-syntax-version',
      label: 'Work-item syntax',
      value: creationProfile?.fields?.workItemSyntaxVersion
        || policy.fields.workItemSyntaxVersion,
      state: 'supported',
      basisIds: ['context.project-capture.policy', 'context.project-capture.profile']
    },
    {
      id: 'provider-template-side-effects',
      label: 'Provider-native template side effects',
      value: 'unavailable',
      state: 'unavailable',
      basisIds: ['context.project-capture.profile']
    },
    {
      id: 'manager-reference-bound',
      label: 'Project manager relation',
      value: 'unavailable',
      state: 'unavailable',
      basisIds: ['context.project-capture.policy']
    },
    {
      id: 'client-contact-state',
      label: 'Client contact assignment',
      value: 'unavailable',
      state: 'unavailable',
      basisIds: ['context.project-capture.policy']
    },
    {
      id: 'task-link-state',
      label: 'Existing Task links',
      value: 'unavailable',
      state: 'unavailable',
      basisIds: ['context.project-capture.policy']
    },
    {
      id: 'document-link-state',
      label: 'Existing Document links',
      value: 'unavailable',
      state: 'unavailable',
      basisIds: ['context.project-capture.policy']
    },
    {
      id: 'channel-link-state',
      label: 'Existing Communication channel links',
      value: 'unavailable',
      state: 'unavailable',
      basisIds: ['context.project-capture.policy']
    },
    {
      id: 'arbitrary-manager-state',
      label: 'Arbitrary manager identities',
      value: 'unavailable',
      state: 'unavailable',
      basisIds: ['context.project-capture.policy']
    },
    {
      id: 'multiple-milestone-owner-state',
      label: 'Multiple owners per milestone work item',
      value: 'unavailable',
      state: 'unavailable',
      basisIds: ['context.project-capture.profile']
    },
    {
      id: 'provider-linked-view-state',
      label: 'Provider-native linked views',
      value: 'unavailable',
      state: 'unavailable',
      basisIds: ['context.project-capture.profile']
    },
    {
      id: 'project-body-readback-state',
      label: 'Connected Project body read-back',
      value: 'unavailable',
      state: 'unavailable',
      basisIds: ['context.project-capture.profile']
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
    kind: 'project-capture-preview',
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
  return { preview, derivedReview, projectFingerprint };
}

export async function prepareProjectCaptureRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  const derivedReviewDefinition = exactDerivedReviewDefinition(root);
  const projectPolicyDefinition = loadProjectCapturePolicyDefinition(root);
  if (Object.hasOwn(input, 'manager')) {
    throw new Error('Project Capture manager resolution is intentionally unavailable.');
  }
  const definitionAuthority = authority(lock, 'definition');
  const projectAuthority = authority(lock, 'instance');
  const crmAuthority = authority(lock, 'instance', 'crm.records');
  const policySelectionSource = policySource(lock, definitionAuthority);
  const profileSelectionSource = profileSource(lock, definitionAuthority);
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
    requestedOutcome: 'Prepare one grounded portable Project or Deal candidate for exact private review and stop before approval, start authorization, or provider writes.',
    evidenceIds: []
  });

  const policyResult = await readFixture({
    root,
    lock,
    authorityId: definitionAuthority,
    input: policySelectionSource.input,
    effectId: 'effect.project-capture.preparation.policy.fixture',
    at: createdAt
  });
  const policy = assertProjectCapturePolicySelection(
    policyResult.output,
    projectPolicyDefinition
  );
  const profileResult = await readFixture({
    root,
    lock,
    authorityId: definitionAuthority,
    input: profileSelectionSource.input,
    effectId: 'effect.project-capture.preparation.profile.fixture',
    at: createdAt
  });
  const creationProfile = assertProjectCreationProfileSelection(
    profileResult.output,
    projectPolicyDefinition,
    input.creationProfile
  );
  const schemaResult = await readFixture({
    root,
    lock,
    capability: 'projects.schema.read',
    authorityId: projectAuthority,
    input: { recordType: 'project' },
    effectId: 'effect.project-capture.preparation.schema.fixture',
    at: createdAt
  });
  const schema = assertProjectCaptureSchema(schemaResult.output, policy.fields);
  const organizationResult = await readFixture({
    root,
    lock,
    capability: 'crm.records.read',
    authorityId: crmAuthority,
    input: { recordTypes: ['organization'], ids: [input.organization], limit: 2 },
    effectId: 'effect.project-capture.preparation.organization.fixture',
    at: createdAt
  });
  const organization = exactRequestedContextRecord(organizationResult.output, {
    recordType: 'organization',
    requestedId: input.organization
  });
  const duplicateResult = await readFixture({
    root,
    lock,
    authorityId: projectAuthority,
    input: {
      recordTypes: ['project'],
      filters: { name: input.name },
      limit: policy.fields.duplicateCandidateLimit
    },
    effectId: 'effect.project-capture.preparation.duplicates.fixture',
    at: createdAt
  });
  const duplicateIds = duplicateResult.output.records
    .filter((record) => record.type === 'project')
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
        id: 'context.project-capture.policy',
        subject: 'projects.records.project-capture-policy',
        authorityId: definitionAuthority,
        role: 'definition',
        result: policyResult
      })
    },
    {
      result: profileResult,
      entry: snapshotEntry({
        id: 'context.project-capture.profile',
        subject: 'projects.records.project-creation-profile',
        authorityId: definitionAuthority,
        role: 'definition',
        result: profileResult
      })
    },
    {
      result: schemaResult,
      entry: snapshotEntry({
        id: 'context.project-capture.schema',
        subject: 'projects.records.project-schema',
        authorityId: projectAuthority,
        role: 'instance',
        result: schemaResult
      })
    },
    {
      result: organizationResult,
      entry: snapshotEntry({
        id: 'context.project-capture.organization',
        subject: 'crm.records.organization',
        authorityId: crmAuthority,
        role: 'instance',
        result: organizationResult
      })
    },
    {
      result: duplicateResult,
      entry: snapshotEntry({
        id: 'context.project-capture.duplicates',
        subject: 'projects.records.project-candidates',
        authorityId: projectAuthority,
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
        'Provider credentials, raw private inputs, project body values, and duplicate candidate field values are excluded.'
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
    { id: 'project-create-review-grounded', state: 'passed', details: 'The exact policy, complete creation-profile set, current schema, organization, and bounded duplicate candidates were loaded without retaining raw private input values.' },
    { id: 'portable-project-grammar-validated', state: 'passed', details: 'The exact private milestone inputs round-tripped through the governed portable milestone and work-item grammar.' },
    { id: 'write-boundary-held', state: 'passed', details: 'No change set, approval request, continuation request, provider call, or canonical write was issued.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;

  const { preview, derivedReview } = buildProjectCapturePreview({
    input,
    policy,
    schema,
    organization,
    duplicateIds,
    derivedReviewDefinition,
    creationProfile
  });
  const reviewable = preview.collections[0]?.rows[0]?.actions[0]?.reasonCode
    === 'COMPLETE_PROJECT_READBACK_UNAVAILABLE';
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      {
        id: 'project-policy-grounded',
        label: 'Exact project-capture policy grounded',
        state: 'supported',
        basis: ['context.project-capture.policy'],
        limitation: 'The external policy identity matches one governed Context definition; this fixture does not establish connected provider conformance.'
      },
      {
        id: 'project-creation-profile-grounded',
        label: 'Exact portable creation profile grounded',
        state: 'supported',
        basis: ['context.project-capture.profile'],
        limitation: 'The fixture source binds the selected portable profile; it does not invoke or adopt a provider-native template.'
      },
      {
        id: 'project-schema-observed',
        label: 'Current project schema observed',
        state: 'supported',
        basis: ['context.project-capture.schema'],
        limitation: 'The contained schema observation proves fixture conformance only; connected schema freshness is revalidated in the separate acquisition and held-review path.'
      },
      {
        id: 'project-organization-resolved',
        label: 'Exact organization relation resolved',
        state: 'supported',
        basis: ['context.project-capture.organization'],
        limitation: 'Fixture identity does not establish connected access to the provider record.'
      },
      {
        id: 'project-create-preview',
        label: 'Project candidate prepared for review',
        state: reviewable ? 'supported' : 'blocked',
        basis: ['context.project-capture.policy', 'context.project-capture.profile', 'context.project-capture.schema', 'context.project-capture.organization', 'context.project-capture.duplicates'],
        limitation: reviewable
          ? 'One exact private candidate is reviewable, but the connected create remains held because complete mapped-field and body read-back is unavailable; no batch, approval, start, provider-call, write, verification, or proof authority is created.'
          : 'The private candidate remains held while the surfaced exact profile, naming, type, date, or duplicate contradiction is unresolved; connected create authority also remains unavailable until complete mapped-field and body read-back exists.'
      }
    ],
    preview,
    derivedReview
  };
}
