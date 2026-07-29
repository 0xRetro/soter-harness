import path from 'node:path';

import { listProviderDeclarations } from '../../core/capabilities.mjs';
import { exactRequestedContextRecord } from '../../core/context-records.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import {
  loadExactPreparedAutomationAcquisition
} from '../../core/prepared-work.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  commitDurableContextSnapshot,
  getExactDurableHostExecution,
  prepareDurableOperationPlanExecution
} from '../../core/service.mjs';
import {
  assertProjectCreationProfileSelection,
  assertProjectCapturePolicySelection,
  loadProjectCapturePolicyDefinition,
  projectCapturePolicyFields
} from '../../contexts/projects/project-capture-policy.mjs';
import { assertProjectCaptureSchema } from './schema.mjs';

const AUTOMATION_ID = 'automation.project-capture';
const PLAN_PREFIX = 'plan.project-capture.connected-acquisition.';
const SNAPSHOT_PREFIX = 'context.project-capture.connected-acquisition.';
const POLICY_STEP_ID = 'step.project-policy-selection';
const PROFILE_STEP_ID = 'step.project-creation-profiles';
const SCHEMA_STEP_ID = 'step.project-schema';
const ORGANIZATION_STEP_ID = 'step.project-organization';
const DUPLICATES_STEP_ID = 'step.project-duplicates';

function safeWorkId(workId) {
  if (typeof workId !== 'string'
    || !/^work\.project-capture\.[a-f0-9]{24}$/.test(workId)) {
    throw new Error('Connected Project acquisition requires one exact Project prepared-work ID.');
  }
  return workId;
}

function suffixForWork(workId) {
  return safeWorkId(workId).slice('work.project-capture.'.length);
}

function workIdFromPlan(planId) {
  if (typeof planId !== 'string' || !planId.startsWith(PLAN_PREFIX)) {
    throw new Error('Checkpoint is not a connected Project acquisition plan.');
  }
  return safeWorkId('work.project-capture.' + planId.slice(PLAN_PREFIX.length));
}

function snapshotIdForWork(workId) {
  return SNAPSHOT_PREFIX + suffixForWork(workId);
}

function workIdFromSnapshot(snapshotId) {
  if (typeof snapshotId !== 'string' || !snapshotId.startsWith(SNAPSHOT_PREFIX)) {
    throw new Error('Context snapshot is not bound to connected Project acquisition.');
  }
  return safeWorkId('work.project-capture.' + snapshotId.slice(SNAPSHOT_PREFIX.length));
}

function sameJson(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function selectedAuthority(lock, role, subject) {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error(
      'Connected Project acquisition requires one ' + role + ' authority for '
        + subject + '; found ' + matches.length + '.'
    );
  }
  return matches[0].id;
}

function connectedProvider(root, lock, capability) {
  const binding = lock.bindings.find((item) => item.capability === capability);
  if (!binding) throw new Error('No resolved binding for ' + capability + '.');
  const matches = listProviderDeclarations(root).filter((provider) => {
    return provider.pack === binding.providerPack
      && provider.containment === 'connected'
      && provider.capabilities.some((item) => {
        return item.id === capability && item.version === binding.capabilityVersion;
      });
  });
  if (matches.length !== 1) {
    throw new Error(
      'Expected one connected provider for ' + capability + '; found '
        + matches.length + '.'
    );
  }
  return matches[0].id;
}

function selectedPolicySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => {
    return source.consumers.some((consumer) => {
      return consumer.pack === AUTOMATION_ID
        && consumer.purpose === 'project-capture-policy';
    });
  });
  if (matches.length !== 1) {
    throw new Error('Connected Project acquisition requires one policy-selection source.');
  }
  const source = matches[0];
  if (source.capability !== 'projects.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || !sameJson(source.input.recordTypes, ['project-capture-policy'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 1
    || source.input.limit !== 2) {
    throw new Error(
      'Connected Project policy selection must be one exact definition-authority record read.'
    );
  }
  return source;
}

function selectedProfileSource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => {
    return source.consumers.some((consumer) => {
      return consumer.pack === AUTOMATION_ID
        && consumer.purpose === 'project-creation-profiles';
    });
  });
  if (matches.length !== 1) {
    throw new Error('Connected Project acquisition requires one creation-profile source.');
  }
  const source = matches[0];
  if (source.capability !== 'projects.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || !sameJson(source.input.recordTypes, ['project-creation-profile'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 2
    || source.input.limit !== 2) {
    throw new Error(
      'Connected Project creation-profile selection must read the complete exact definition set.'
    );
  }
  return source;
}

function assertSelectedAutomation(lock, run) {
  const selected = lock.packs.filter((pack) => {
    return pack.id === AUTOMATION_ID && pack.layer === 'automation';
  });
  if (selected.length !== 1
    || run?.automation?.id !== AUTOMATION_ID
    || run.automation.version !== selected[0].version) {
    throw new Error(
      'Connected Project acquisition requires an exact run selecting ' + AUTOMATION_ID + '.'
    );
  }
}

function reviewValue(fields, id, { required = false, list = false } = {}) {
  const matches = fields.filter((field) => field.id === id);
  if (matches.length !== 1) {
    throw new Error('Project prepared review material must declare field ' + id + ' exactly once.');
  }
  const field = matches[0];
  if (field.state === 'omitted') {
    if (required) throw new Error('Project prepared review material requires field ' + id + '.');
    return list ? [] : null;
  }
  const validValue = list
    ? Array.isArray(field.reviewValue)
      && field.reviewValue.every((item) => typeof item === 'string' && item)
      && new Set(field.reviewValue).size === field.reviewValue.length
    : typeof field.reviewValue === 'string' && field.reviewValue;
  if (field.state !== 'provided'
    || !validValue
    || field.fingerprint !== fingerprintJson(field.reviewValue)) {
    throw new Error('Project prepared review field ' + id + ' is not exactly fingerprint-bound.');
  }
  return structuredClone(field.reviewValue);
}

export function loadExactProjectCapturePreparedInput({
  root,
  workId,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  const exactWorkId = safeWorkId(workId);
  const prepared = loadExactPreparedAutomationAcquisition({
    root: resolvedRoot,
    workId: exactWorkId,
    automationId: AUTOMATION_ID,
    expectedHost
  });
  const { work, material, lock, run, runPath } = prepared;
  assertSelectedAutomation(lock, run);
  const input = {
    name: reviewValue(material.fields, 'name', { required: true }),
    organizationShortName: reviewValue(material.fields, 'organizationShortName', { required: true }),
    organization: reviewValue(material.fields, 'organization', { required: true }),
    creationProfile: reviewValue(material.fields, 'creationProfile', { required: true }),
    projectType: reviewValue(material.fields, 'projectType', { required: true }),
    overview: reviewValue(material.fields, 'overview', { required: true }),
    milestoneTitles: reviewValue(material.fields, 'milestoneTitles', { required: true, list: true }),
    milestoneDescriptions: reviewValue(
      material.fields,
      'milestoneDescriptions',
      { required: true, list: true }
    ),
    milestoneOwners: reviewValue(material.fields, 'milestoneOwners', { required: true, list: true }),
    milestoneActions: reviewValue(material.fields, 'milestoneActions', { required: true, list: true }),
    milestoneDates: reviewValue(material.fields, 'milestoneDates', { list: true }),
    startDate: reviewValue(material.fields, 'startDate'),
    targetEndDate: reviewValue(material.fields, 'targetEndDate')
  };
  return {
    work,
    material,
    lock,
    lockPath: work.configuration.lockPath,
    run,
    runPath,
    input
  };
}

export function createProjectCaptureConnectedAcquisitionPlan({
  root,
  lock,
  runId,
  workId,
  createdAt,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactProjectCapturePreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.lock.graphFingerprint !== lock.graphFingerprint
    || prepared.run.id !== runId) {
    throw new Error(
      'Connected Project plan does not match its exact prepared work, lock, graph, and run.'
    );
  }
  const policy = loadProjectCapturePolicyDefinition(resolvedRoot);
  const definitionAuthority = selectedAuthority(lock, 'definition', 'projects.records');
  const projectAuthority = selectedAuthority(lock, 'instance', 'projects.records');
  const crmAuthority = selectedAuthority(lock, 'instance', 'crm.records');
  const policySource = selectedPolicySource(lock, definitionAuthority);
  const profileSource = selectedProfileSource(lock, definitionAuthority);
  const projectProvider = connectedProvider(resolvedRoot, lock, 'projects.records.read');
  const crmProvider = connectedProvider(resolvedRoot, lock, 'crm.records.read');
  const schemaProvider = connectedProvider(resolvedRoot, lock, 'projects.schema.read');
  const steps = [
    {
      id: POLICY_STEP_ID,
      capability: 'projects.records.read',
      authority: definitionAuthority,
      providerImplementation: projectProvider,
      input: structuredClone(policySource.input),
      inputBindings: [],
      reason: 'Confirm the exact external policy-selection identity bound to the governed Context definition.'
    },
    {
      id: PROFILE_STEP_ID,
      capability: 'projects.records.read',
      authority: definitionAuthority,
      providerImplementation: projectProvider,
      input: structuredClone(profileSource.input),
      inputBindings: [],
      reason: 'Confirm the complete exact external Project and Deal creation-profile set and selected portable profile.'
    },
    {
      id: SCHEMA_STEP_ID,
      capability: 'projects.schema.read',
      authority: projectAuthority,
      providerImplementation: schemaProvider,
      input: { recordType: 'project' },
      inputBindings: [],
      reason: 'Observe the exact current writable project fields and closed Type and Status options.'
    },
    {
      id: ORGANIZATION_STEP_ID,
      capability: 'crm.records.read',
      authority: crmAuthority,
      providerImplementation: crmProvider,
      input: { recordTypes: ['organization'], ids: [prepared.input.organization], limit: 2 },
      inputBindings: [],
      reason: 'Resolve the exact selected organization before any project proposal exists.'
    },
    {
      id: DUPLICATES_STEP_ID,
      capability: 'projects.records.read',
      authority: projectAuthority,
      providerImplementation: projectProvider,
      input: {
        recordTypes: ['project'],
        filters: { name: prepared.input.name },
        limit: policy.duplicateCandidateLimit
      },
      inputBindings: [],
      reason: 'Inspect the exact bounded name-duplicate candidates before proposing a create.'
    }
  ];
  return {
    $contract: 'soter://contracts/operation-plan/v2',
    contractVersion: '2.0.0',
    id: PLAN_PREFIX + suffixForWork(workId),
    runId,
    createdAt,
    mode: 'sequential',
    failurePolicy: 'stop',
    reason: 'Acquire exact connected Project policy, complete creation-profile set, current schema, organization, and bounded duplicate candidates from one current prepared-input basis.',
    configuration: {
      name: prepared.work.configuration.name,
      configurationBasis: 'private-active',
      path: prepared.work.configuration.path,
      lockPath: prepared.work.configuration.lockPath,
      lockFingerprint: prepared.work.configuration.lockFingerprint,
      graphFingerprint: prepared.work.configuration.graphFingerprint
    },
    steps
  };
}

export function assertProjectCaptureConnectedAcquisitionPlan(plan) {
  const workId = workIdFromPlan(plan?.id);
  const expectedIds = [
    POLICY_STEP_ID,
    PROFILE_STEP_ID,
    SCHEMA_STEP_ID,
    ORGANIZATION_STEP_ID,
    DUPLICATES_STEP_ID
  ];
  if (plan.$contract !== 'soter://contracts/operation-plan/v2'
    || plan.contractVersion !== '2.0.0'
    || plan.mode !== 'sequential'
    || plan.failurePolicy !== 'stop'
    || !Array.isArray(plan.steps)
    || !sameJson(plan.steps.map((step) => step.id), expectedIds)
    || plan.steps[0].capability !== 'projects.records.read'
    || plan.steps[1].capability !== 'projects.records.read'
    || plan.steps[2].capability !== 'projects.schema.read'
    || plan.steps[3].capability !== 'crm.records.read'
    || plan.steps.at(-1).capability !== 'projects.records.read'
    || plan.steps.some((step) => !sameJson(step.inputBindings, []))) {
    throw new Error('Connected Project acquisition plan does not preserve its exact source order.');
  }
  return {
    workId,
    snapshotId: snapshotIdForWork(workId),
    policy: plan.steps[0],
    profile: plan.steps[1],
    schema: plan.steps[2],
    organization: plan.steps[3],
    duplicates: plan.steps.at(-1)
  };
}

function completedStep(checkpoint, id) {
  const step = checkpoint.steps.find((item) => item.id === id);
  if (!step || step.state !== 'completed' || !step.call || !step.output) {
    throw new Error('Connected Project acquisition source ' + id + ' is not completed.');
  }
  return step;
}

function freshnessState(root, capability, observedAt, at) {
  const contract = readJson(path.join(root, 'soter', 'capabilities', capability + '.json'));
  const maxAge = contract.freshness.maxAgeSeconds;
  if (maxAge === null) return 'unknown';
  const age = (Date.parse(at) - Date.parse(observedAt)) / 1000;
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  return age <= maxAge ? 'passed' : 'stale';
}

function snapshotEntry({ root, id, subject, role, step, at }) {
  return {
    id,
    subject,
    authority: step.call.authority,
    role,
    capability: step.call.capability.id,
    providerPack: step.call.provider.pack,
    providerImplementation: step.call.provider.implementation,
    providerVersion: step.call.provider.version,
    observedAt: step.output.observedAt,
    freshness: freshnessState(root, step.call.capability.id, step.output.observedAt, at),
    provenance: step.output.provenance,
    valueFingerprint: step.outputFingerprint,
    value: step.output
  };
}

function effectId(call) {
  return 'effect.' + call.id.slice('toolcall.'.length);
}

export async function prepareProjectCaptureConnectedAcquisition({
  root,
  workId,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactProjectCapturePreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  const createdAt = at || new Date().toISOString();
  const plan = createProjectCaptureConnectedAcquisitionPlan({
    root: resolvedRoot,
    lock: prepared.lock,
    runId: prepared.run.id,
    workId,
    createdAt,
    expectedHost
  });
  return prepareDurableOperationPlanExecution({
    root: resolvedRoot,
    lockPath: prepared.lockPath,
    runPath: prepared.runPath,
    plan,
    at: createdAt,
    expectedHost,
    configurationBasis: 'private-active'
  });
}

export function finalizeProjectCaptureConnectedAcquisition({
  root,
  checkpointId,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const execution = getExactDurableHostExecution({
    root: resolvedRoot,
    checkpointId,
    expectedHost
  });
  const checkpoint = execution.checkpoint;
  if (checkpoint.kind !== 'operation-plan' || checkpoint.state !== 'completed') {
    throw new Error('Connected Project acquisition can finalize only from a completed operation plan.');
  }
  const shape = assertProjectCaptureConnectedAcquisitionPlan(checkpoint.plan);
  const prepared = loadExactProjectCapturePreparedInput({
    root: resolvedRoot,
    workId: shape.workId,
    expectedHost
  });
  const lock = prepared.lock;
  if (checkpoint.configurationLock.path !== prepared.lockPath
    || checkpoint.configurationLock.fingerprint !== fingerprintLock(lock)
    || checkpoint.graphFingerprint !== lock.graphFingerprint
    || checkpoint.plan.runId !== prepared.run.id
    || execution.run.id !== prepared.run.id) {
    throw new Error('Connected Project acquisition no longer matches its exact lock and graph.');
  }
  assertSelectedAutomation(lock, execution.run);
  const expectedPlan = createProjectCaptureConnectedAcquisitionPlan({
    root: resolvedRoot,
    lock,
    runId: checkpoint.plan.runId,
    workId: shape.workId,
    createdAt: checkpoint.plan.createdAt,
    expectedHost
  });
  if (!sameJson(expectedPlan, checkpoint.plan)) {
    throw new Error('Connected Project acquisition drifted from its exact prepared-input basis.');
  }

  const definition = loadProjectCapturePolicyDefinition(resolvedRoot);
  const policy = completedStep(checkpoint, POLICY_STEP_ID);
  const profile = completedStep(checkpoint, PROFILE_STEP_ID);
  const schema = completedStep(checkpoint, SCHEMA_STEP_ID);
  const organization = completedStep(checkpoint, ORGANIZATION_STEP_ID);
  const duplicates = completedStep(checkpoint, DUPLICATES_STEP_ID);
  const policySelection = assertProjectCapturePolicySelection(policy.output, definition);
  assertProjectCreationProfileSelection(
    profile.output,
    definition,
    loadExactProjectCapturePreparedInput({
      root: resolvedRoot,
      workId: shape.workId,
      expectedHost
    }).input.creationProfile
  );
  assertProjectCaptureSchema(schema.output, projectCapturePolicyFields(definition));
  exactRequestedContextRecord(organization.output, {
    recordType: 'organization',
    requestedId: shape.organization.input.ids[0]
  });
  const duplicateRecords = duplicates.output.records || [];
  const duplicateIds = duplicateRecords.map((record) => record.id);
  if (duplicateRecords.length > definition.duplicateCandidateLimit
    || duplicateRecords.some((record) => record.type !== 'project')
    || new Set(duplicateIds).size !== duplicateIds.length) {
    throw new Error('Connected Project duplicate acquisition is not exact, unique, and bounded.');
  }

  const createdAt = checkpoint.updatedAt;
  const entries = [
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-capture.policy-selection',
      subject: 'projects.records',
      role: 'definition',
      step: policy,
      at: createdAt
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-capture.profile-selection',
      subject: 'projects.records',
      role: 'definition',
      step: profile,
      at: createdAt
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-capture.organization',
      subject: 'crm.records',
      role: 'instance',
      step: organization,
      at: createdAt
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-capture.schema',
      subject: 'projects.records',
      role: 'instance',
      step: schema,
      at: createdAt
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-capture.duplicates',
      subject: 'projects.records',
      role: 'instance',
      step: duplicates,
      at: createdAt
    })
  ];
  const completedSources = [policy, profile, schema, organization, duplicates];
  const authorities = [...new Set(entries.map((entry) => entry.authority))];
  const contextUpdates = authorities.map((authority) => {
    const authorityEntries = entries.filter((entry) => entry.authority === authority);
    const freshness = authorityEntries.some((entry) => entry.freshness === 'stale')
      ? 'stale'
      : (authorityEntries.some((entry) => entry.freshness === 'unknown')
        ? 'unknown'
        : 'passed');
    return {
      authority,
      status: freshness === 'stale' ? 'stale' : 'loaded',
      provenance: 'connected-project-acquisition:set:' + fingerprintJson(
        authorityEntries.map((entry) => ({ id: entry.id, fingerprint: entry.valueFingerprint }))
      ),
      freshness
    };
  });
  const snapshot = {
    $contract: 'soter://contracts/context-snapshot/v1',
    contractVersion: '1.0.0',
    id: shape.snapshotId,
    runId: checkpoint.plan.runId,
    createdAt,
    configurationLockFingerprint: checkpoint.configurationLock.fingerprint,
    graphFingerprint: checkpoint.graphFingerprint,
    containment: 'connected',
    entries,
    effectIds: completedSources.map((step) => effectId(step.call)),
    privacy: {
      scope: 'private',
      redactions: [
        'The exact project name, organization short name, overview, milestone fields, dates, and organization request remain bound to private prepared-work review material.',
        'Provider credentials, secret references, native responses, and raw target metadata are excluded from general inspection and evidence.',
        'The governed Context policy definition is sealed by the current graph; the external record confirms only its selected identity.',
        'This acquisition pauses before a Project decision, proposal, approval request, provider write, or execution authority exists.'
      ]
    }
  };
  return commitDurableContextSnapshot({
    root: resolvedRoot,
    checkpointId,
    snapshot,
    contextUpdates,
    checkpointDetails: 'Automation acquired the exact Project policy selection, complete creation-profile set, current schema, organization, and bounded duplicate candidates, then paused before decision, proposal, approval, or writes.',
    expectedHost
  });
}

export function projectCapturePreparedWorkIdFromSnapshot(snapshotId) {
  return workIdFromSnapshot(snapshotId);
}
