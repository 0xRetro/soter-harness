import path from 'node:path';

import { listProviderDeclarations } from '../../core/capabilities.mjs';
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
  assertOrganizationCapturePolicySelection,
  loadOrganizationCapturePolicyDefinition,
  organizationDuplicateNames
} from './policy.mjs';

const AUTOMATION_ID = 'automation.organization-capture';
const PLAN_PREFIX = 'plan.organization-capture.connected-acquisition.';
const SNAPSHOT_PREFIX = 'context.organization-capture.connected-acquisition.';
const POLICY_STEP_ID = 'step.organization-policy-selection';
const SCHEMA_STEP_ID = 'step.organization-schema';
const DUPLICATES_STEP_ID = 'step.organization-duplicates';

function safeWorkId(workId) {
  if (typeof workId !== 'string'
    || !/^work\.organization-capture\.[a-f0-9]{24}$/.test(workId)) {
    throw new Error(
      'Connected Organization acquisition requires one exact prepared-work ID.'
    );
  }
  return workId;
}

function suffixForWork(workId) {
  return safeWorkId(workId).slice('work.organization-capture.'.length);
}

function workIdFromPlan(planId) {
  if (typeof planId !== 'string' || !planId.startsWith(PLAN_PREFIX)) {
    throw new Error('Checkpoint is not a connected Organization acquisition plan.');
  }
  return safeWorkId('work.organization-capture.' + planId.slice(PLAN_PREFIX.length));
}

function snapshotIdForWork(workId) {
  return SNAPSHOT_PREFIX + suffixForWork(workId);
}

function workIdFromSnapshot(snapshotId) {
  if (typeof snapshotId !== 'string' || !snapshotId.startsWith(SNAPSHOT_PREFIX)) {
    throw new Error('Context snapshot is not bound to connected Organization acquisition.');
  }
  return safeWorkId('work.organization-capture.' + snapshotId.slice(SNAPSHOT_PREFIX.length));
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
      'Connected Organization acquisition requires one ' + role + ' authority for '
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
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID
      && consumer.purpose === 'organization-capture-policy';
  }));
  if (matches.length !== 1) {
    throw new Error('Connected Organization acquisition requires one policy-selection source.');
  }
  const source = matches[0];
  if (source.capability !== 'crm.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || !sameJson(source.input.recordTypes, ['organization-capture-policy'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 1
    || source.input.limit !== 2) {
    throw new Error(
      'Connected Organization policy selection must be one exact definition read.'
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
      'Connected Organization acquisition requires an exact run selecting '
        + AUTOMATION_ID + '.'
    );
  }
}

function reviewValue(fields, id, { required = false, list = false } = {}) {
  const matches = fields.filter((field) => field.id === id);
  if (matches.length !== 1) {
    throw new Error(
      'Organization prepared review material must declare field ' + id + ' exactly once.'
    );
  }
  const field = matches[0];
  if (field.state === 'omitted') {
    if (required) throw new Error('Organization prepared review requires field ' + id + '.');
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
    throw new Error(
      'Organization prepared review field ' + id + ' is not exactly fingerprint-bound.'
    );
  }
  return structuredClone(field.reviewValue);
}

export function loadExactOrganizationCapturePreparedInput({
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
  return {
    work,
    material,
    lock,
    lockPath: work.configuration.lockPath,
    run,
    runPath,
    input: {
      name: reviewValue(material.fields, 'name', { required: true }),
      description: reviewValue(material.fields, 'description', { required: true }),
      website: reviewValue(material.fields, 'website'),
      twitter: reviewValue(material.fields, 'twitter'),
      aliases: reviewValue(material.fields, 'aliases', { list: true }),
      organizationType: reviewValue(material.fields, 'organizationType'),
      tags: reviewValue(material.fields, 'tags', { list: true })
    }
  };
}

export function createOrganizationCaptureConnectedAcquisitionPlan({
  root,
  lock,
  runId,
  workId,
  createdAt,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactOrganizationCapturePreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.lock.graphFingerprint !== lock.graphFingerprint
    || prepared.run.id !== runId) {
    throw new Error(
      'Connected Organization plan does not match its exact prepared work, lock, graph, and run.'
    );
  }
  const policy = loadOrganizationCapturePolicyDefinition(resolvedRoot);
  const names = organizationDuplicateNames(prepared.input, policy);
  const definitionAuthority = selectedAuthority(lock, 'definition', 'crm.records');
  const instanceAuthority = selectedAuthority(lock, 'instance', 'crm.records');
  const recordsProvider = connectedProvider(resolvedRoot, lock, 'crm.records.read');
  const steps = [
    {
      id: POLICY_STEP_ID,
      capability: 'crm.records.read',
      authority: definitionAuthority,
      providerImplementation: recordsProvider,
      input: structuredClone(selectedPolicySource(lock, definitionAuthority).input),
      inputBindings: [],
      reason: 'Confirm the external policy-selection identity bound to the governed Context definition.'
    },
    {
      id: SCHEMA_STEP_ID,
      capability: 'crm.schema.read',
      authority: instanceAuthority,
      providerImplementation: connectedProvider(resolvedRoot, lock, 'crm.schema.read'),
      input: { recordType: 'organization' },
      inputBindings: [],
      reason: 'Observe the current writable organization fields and exact Type and Tags option sets.'
    },
    {
      id: DUPLICATES_STEP_ID,
      capability: 'crm.records.read',
      authority: instanceAuthority,
      providerImplementation: recordsProvider,
      input: {
        recordTypes: ['organization'],
        filtersAny: names.map((name) => ({ name })),
        limit: policy.duplicateCandidateLimit
      },
      inputBindings: [],
      reason: 'Inspect every bounded exact name and alias candidate before a proposal exists.'
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
    reason: 'Acquire exact connected Organization policy selection, current schema, and bounded alias candidates from one prepared-input basis.',
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

export function assertOrganizationCaptureConnectedAcquisitionPlan(plan) {
  const workId = workIdFromPlan(plan?.id);
  const expectedIds = [POLICY_STEP_ID, SCHEMA_STEP_ID, DUPLICATES_STEP_ID];
  if (plan.$contract !== 'soter://contracts/operation-plan/v2'
    || plan.contractVersion !== '2.0.0'
    || plan.mode !== 'sequential'
    || plan.failurePolicy !== 'stop'
    || !Array.isArray(plan.steps)
    || !sameJson(plan.steps.map((step) => step.id), expectedIds)
    || plan.steps.some((step) => !sameJson(step.inputBindings, []))) {
    throw new Error(
      'Connected Organization acquisition plan does not preserve its exact source order.'
    );
  }
  return {
    workId,
    snapshotId: snapshotIdForWork(workId),
    policy: plan.steps[0],
    schema: plan.steps[1],
    duplicates: plan.steps[2]
  };
}

function completedStep(checkpoint, id) {
  const step = checkpoint.steps.find((item) => item.id === id);
  if (!step || step.state !== 'completed' || !step.call || !step.output) {
    throw new Error('Connected Organization acquisition source ' + id + ' is incomplete.');
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

export async function prepareOrganizationCaptureConnectedAcquisition({
  root,
  workId,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactOrganizationCapturePreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  const createdAt = at || new Date().toISOString();
  const plan = createOrganizationCaptureConnectedAcquisitionPlan({
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

function assertConnectedSchema(schema) {
  if (schema?.recordType !== 'organization'
    || !Array.isArray(schema.fields)
    || !schema.fields.some((field) => {
      return field.id === 'organizationType' && Array.isArray(field.options);
    })
    || !schema.fields.some((field) => {
      return field.id === 'tags' && Array.isArray(field.options);
    })) {
    throw new Error('Connected Organization schema observation is incomplete.');
  }
}

export function finalizeOrganizationCaptureConnectedAcquisition({
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
    throw new Error(
      'Connected Organization acquisition can finalize only from a completed plan.'
    );
  }
  const shape = assertOrganizationCaptureConnectedAcquisitionPlan(checkpoint.plan);
  const prepared = loadExactOrganizationCapturePreparedInput({
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
    throw new Error('Connected Organization acquisition no longer matches its exact lock.');
  }
  assertSelectedAutomation(lock, execution.run);
  const expectedPlan = createOrganizationCaptureConnectedAcquisitionPlan({
    root: resolvedRoot,
    lock,
    runId: checkpoint.plan.runId,
    workId: shape.workId,
    createdAt: checkpoint.plan.createdAt,
    expectedHost
  });
  if (!sameJson(expectedPlan, checkpoint.plan)) {
    throw new Error(
      'Connected Organization acquisition drifted from its exact prepared-input basis.'
    );
  }

  const definition = loadOrganizationCapturePolicyDefinition(resolvedRoot);
  const policy = completedStep(checkpoint, POLICY_STEP_ID);
  const schema = completedStep(checkpoint, SCHEMA_STEP_ID);
  const duplicates = completedStep(checkpoint, DUPLICATES_STEP_ID);
  assertOrganizationCapturePolicySelection(policy.output, definition);
  assertConnectedSchema(schema.output.schema);
  const duplicateRecords = duplicates.output.records || [];
  const duplicateIds = duplicateRecords.map((record) => record.id);
  if (duplicateRecords.length > definition.duplicateCandidateLimit
    || duplicateRecords.some((record) => record.type !== 'organization')
    || new Set(duplicateIds).size !== duplicateIds.length) {
    throw new Error(
      'Connected Organization duplicate acquisition is not exact, unique, and bounded.'
    );
  }

  const createdAt = checkpoint.updatedAt;
  const entries = [
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.organization-capture.policy-selection',
      subject: 'crm.records',
      role: 'definition',
      step: policy,
      at: createdAt
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.organization-capture.schema',
      subject: 'crm.records',
      role: 'instance',
      step: schema,
      at: createdAt
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.organization-capture.duplicates',
      subject: 'crm.records',
      role: 'instance',
      step: duplicates,
      at: createdAt
    })
  ];
  const completedSources = [policy, schema, duplicates];
  const authorities = [...new Set(entries.map((entry) => entry.authority))];
  const contextUpdates = authorities.map((authority) => {
    const authorityEntries = entries.filter((entry) => entry.authority === authority);
    const freshness = authorityEntries.some((entry) => entry.freshness === 'stale')
      ? 'stale'
      : authorityEntries.some((entry) => entry.freshness === 'unknown') ? 'unknown' : 'passed';
    return {
      authority,
      status: freshness === 'stale' ? 'stale' : 'loaded',
      provenance: 'connected-organization-acquisition:set:' + fingerprintJson(
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
        'Exact organization prose, aliases, requested options, and URLs remain in private prepared-work review material.',
        'Provider credentials, native responses, target metadata, and private values are excluded from general inspection and evidence.',
        'The external policy record confirms selected identity only; governed rules remain sealed by the current graph.',
        'This acquisition pauses before decision, proposal, approval, provider write, or execution authority exists.'
      ]
    }
  };
  return commitDurableContextSnapshot({
    root: resolvedRoot,
    checkpointId,
    snapshot,
    contextUpdates,
    checkpointDetails: 'Automation acquired exact Organization policy selection, current schema, and bounded alias candidates, then paused before decision, proposal, approval, or writes.',
    expectedHost
  });
}

export function organizationCapturePreparedWorkIdFromSnapshot(snapshotId) {
  return workIdFromSnapshot(snapshotId);
}
