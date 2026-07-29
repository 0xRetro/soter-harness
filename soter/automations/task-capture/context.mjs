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
  assertTaskWorkPolicySelection,
  loadTaskWorkPolicyDefinition
} from '../../contexts/tasks/task-work-policy.mjs';
import { evaluateTaskCaptureSchema } from './schema.mjs';

const AUTOMATION_ID = 'automation.task-capture';
const PLAN_PREFIX = 'plan.task-capture.connected-acquisition.';
const SNAPSHOT_PREFIX = 'context.task-capture.connected-acquisition.';
const POLICY_STEP_ID = 'step.task-policy-selection';
const SCHEMA_STEP_ID = 'step.task-schema';
const PROJECT_STEP_ID = 'step.task-project';
const IDENTITY_STEP_ID = 'step.task-current-user';
const DUPLICATES_STEP_ID = 'step.task-duplicates';

function safeWorkId(workId) {
  if (typeof workId !== 'string'
    || !/^work\.task-capture\.[a-f0-9]{24}$/.test(workId)) {
    throw new Error('Connected Task acquisition requires one exact Task prepared-work ID.');
  }
  return workId;
}

function suffixForWork(workId) {
  return safeWorkId(workId).slice('work.task-capture.'.length);
}

function workIdFromPlan(planId) {
  if (typeof planId !== 'string' || !planId.startsWith(PLAN_PREFIX)) {
    throw new Error('Checkpoint is not a connected Task acquisition plan.');
  }
  return safeWorkId('work.task-capture.' + planId.slice(PLAN_PREFIX.length));
}

function snapshotIdForWork(workId) {
  return SNAPSHOT_PREFIX + suffixForWork(workId);
}

function workIdFromSnapshot(snapshotId) {
  if (typeof snapshotId !== 'string' || !snapshotId.startsWith(SNAPSHOT_PREFIX)) {
    throw new Error('Context snapshot is not bound to connected Task acquisition.');
  }
  return safeWorkId('work.task-capture.' + snapshotId.slice(SNAPSHOT_PREFIX.length));
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
      'Connected Task acquisition requires one ' + role + ' authority for '
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
        && consumer.purpose === 'task-work-policy';
    });
  });
  if (matches.length !== 1) {
    throw new Error('Connected Task acquisition requires one policy-selection source.');
  }
  const source = matches[0];
  if (source.capability !== 'tasks.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || !sameJson(source.input.recordTypes, ['task-work-policy'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 1
    || source.input.limit !== 2) {
    throw new Error(
      'Connected Task policy selection must be one exact definition-authority record read.'
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
      'Connected Task acquisition requires an exact run selecting ' + AUTOMATION_ID + '.'
    );
  }
}

function reviewValue(fields, id, { required = false } = {}) {
  const matches = fields.filter((field) => field.id === id);
  if (matches.length !== 1) {
    throw new Error('Task prepared review material must declare field ' + id + ' exactly once.');
  }
  const field = matches[0];
  if (field.state === 'omitted') {
    if (required) throw new Error('Task prepared review material requires field ' + id + '.');
    return null;
  }
  if (field.state !== 'provided'
    || typeof field.reviewValue !== 'string'
    || field.fingerprint !== fingerprintJson(field.reviewValue)) {
    throw new Error('Task prepared review field ' + id + ' is not exactly fingerprint-bound.');
  }
  return field.reviewValue;
}

export function loadExactTaskCapturePreparedInput({
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
  const title = reviewValue(material.fields, 'title', { required: true });
  const project = reviewValue(material.fields, 'project', { required: true });
  const assignee = reviewValue(material.fields, 'assignee');
  const nextActionOn = reviewValue(material.fields, 'nextActionOn');
  const context = reviewValue(material.fields, 'context') || 'Project';
  if (assignee !== null && assignee !== 'self') {
    throw new Error('Task prepared assignee must be omitted or the authenticated current user.');
  }
  return {
    work,
    material,
    lock,
    lockPath: work.configuration.lockPath,
    run,
    runPath,
    input: { title, project, assignee, nextActionOn, context }
  };
}

export function createTaskCaptureConnectedAcquisitionPlan({
  root,
  lock,
  runId,
  workId,
  createdAt,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactTaskCapturePreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.lock.graphFingerprint !== lock.graphFingerprint
    || prepared.run.id !== runId) {
    throw new Error(
      'Connected Task plan does not match its exact prepared work, lock, graph, and run.'
    );
  }
  const policy = loadTaskWorkPolicyDefinition(resolvedRoot);
  const definitionAuthority = selectedAuthority(lock, 'definition', 'tasks.records');
  const taskAuthority = selectedAuthority(lock, 'instance', 'tasks.records');
  const projectAuthority = selectedAuthority(lock, 'instance', 'projects.records');
  const providerAuthority = selectedAuthority(lock, 'provider', 'notion.workspace');
  const policySource = selectedPolicySource(lock, definitionAuthority);
  const taskProvider = connectedProvider(resolvedRoot, lock, 'tasks.records.read');
  const taskSchemaProvider = connectedProvider(resolvedRoot, lock, 'tasks.schema.read');
  const projectProvider = connectedProvider(resolvedRoot, lock, 'projects.records.read');
  const steps = [
    {
      id: POLICY_STEP_ID,
      capability: 'tasks.records.read',
      authority: definitionAuthority,
      providerImplementation: taskProvider,
      input: structuredClone(policySource.input),
      inputBindings: [],
      reason: 'Confirm the exact external policy-selection identity bound to the governed Context definition.'
    },
    {
      id: SCHEMA_STEP_ID,
      capability: 'tasks.schema.read',
      authority: taskAuthority,
      providerImplementation: taskSchemaProvider,
      input: { recordType: 'task' },
      inputBindings: [],
      reason: 'Observe the exact normalized writable Task option vocabulary before any approval-capable proposal exists.'
    },
    {
      id: PROJECT_STEP_ID,
      capability: 'projects.records.read',
      authority: projectAuthority,
      providerImplementation: projectProvider,
      input: { recordTypes: ['project'], ids: [prepared.input.project], limit: 2 },
      inputBindings: [],
      reason: 'Resolve the exact selected project before any task proposal exists.'
    },
    ...(prepared.input.assignee === 'self' ? [{
      id: IDENTITY_STEP_ID,
      capability: 'workspace.identity.read',
      authority: providerAuthority,
      providerImplementation: connectedProvider(
        resolvedRoot,
        lock,
        'workspace.identity.read'
      ),
      input: { identity: 'current-user' },
      inputBindings: [],
      reason: 'Resolve the authenticated current workspace user without accepting an arbitrary person identifier.'
    }] : []),
    {
      id: DUPLICATES_STEP_ID,
      capability: 'tasks.records.read',
      authority: taskAuthority,
      providerImplementation: taskProvider,
      input: {
        recordTypes: ['task'],
        filters: { title: prepared.input.title },
        limit: policy.duplicateCandidateLimit
      },
      inputBindings: [],
      reason: 'Inspect the exact bounded title-duplicate candidates before proposing a create.'
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
    reason: 'Acquire exact connected Task policy selection, writable schema, project, optional current-user identity, and bounded duplicate candidates from one current prepared-input basis.',
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

export function assertTaskCaptureConnectedAcquisitionPlan(plan) {
  const workId = workIdFromPlan(plan?.id);
  const hasIdentity = plan.steps?.some((step) => step.id === IDENTITY_STEP_ID);
  const expectedIds = hasIdentity
    ? [
        POLICY_STEP_ID,
        SCHEMA_STEP_ID,
        PROJECT_STEP_ID,
        IDENTITY_STEP_ID,
        DUPLICATES_STEP_ID
      ]
    : [POLICY_STEP_ID, SCHEMA_STEP_ID, PROJECT_STEP_ID, DUPLICATES_STEP_ID];
  if (plan.$contract !== 'soter://contracts/operation-plan/v2'
    || plan.contractVersion !== '2.0.0'
    || plan.mode !== 'sequential'
    || plan.failurePolicy !== 'stop'
    || !Array.isArray(plan.steps)
    || !sameJson(plan.steps.map((step) => step.id), expectedIds)
    || plan.steps[0].capability !== 'tasks.records.read'
    || plan.steps[1].capability !== 'tasks.schema.read'
    || plan.steps[2].capability !== 'projects.records.read'
    || plan.steps.at(-1).capability !== 'tasks.records.read'
    || plan.steps.some((step) => !sameJson(step.inputBindings, []))) {
    throw new Error('Connected Task acquisition plan does not preserve its exact source order.');
  }
  return {
    workId,
    snapshotId: snapshotIdForWork(workId),
    policy: plan.steps[0],
    schema: plan.steps[1],
    project: plan.steps[2],
    identity: hasIdentity ? plan.steps[3] : null,
    duplicates: plan.steps.at(-1)
  };
}

function completedStep(checkpoint, id) {
  const step = checkpoint.steps.find((item) => item.id === id);
  if (!step || step.state !== 'completed' || !step.call || !step.output) {
    throw new Error('Connected Task acquisition source ' + id + ' is not completed.');
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

export async function prepareTaskCaptureConnectedAcquisition({
  root,
  workId,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactTaskCapturePreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  const createdAt = at || new Date().toISOString();
  const plan = createTaskCaptureConnectedAcquisitionPlan({
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

export function finalizeTaskCaptureConnectedAcquisition({
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
    throw new Error('Connected Task acquisition can finalize only from a completed operation plan.');
  }
  const shape = assertTaskCaptureConnectedAcquisitionPlan(checkpoint.plan);
  const prepared = loadExactTaskCapturePreparedInput({
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
    throw new Error('Connected Task acquisition no longer matches its exact lock and graph.');
  }
  assertSelectedAutomation(lock, execution.run);
  const expectedPlan = createTaskCaptureConnectedAcquisitionPlan({
    root: resolvedRoot,
    lock,
    runId: checkpoint.plan.runId,
    workId: shape.workId,
    createdAt: checkpoint.plan.createdAt,
    expectedHost
  });
  if (!sameJson(expectedPlan, checkpoint.plan)) {
    throw new Error('Connected Task acquisition drifted from its exact prepared-input basis.');
  }

  const definition = loadTaskWorkPolicyDefinition(resolvedRoot);
  const policy = completedStep(checkpoint, POLICY_STEP_ID);
  const schema = completedStep(checkpoint, SCHEMA_STEP_ID);
  const project = completedStep(checkpoint, PROJECT_STEP_ID);
  const identity = shape.identity ? completedStep(checkpoint, IDENTITY_STEP_ID) : null;
  const duplicates = completedStep(checkpoint, DUPLICATES_STEP_ID);
  const selectedPolicy = assertTaskWorkPolicySelection(policy.output, definition);
  evaluateTaskCaptureSchema(schema.output, {
    status: selectedPolicy.fields.defaultStatus,
    context: prepared.input.context
  });
  exactRequestedContextRecord(project.output, {
    recordType: 'project',
    requestedId: shape.project.input.ids[0]
  });
  if (identity && (identity.output.identity?.kind !== 'current-user'
    || typeof identity.output.identity.providerPersonId !== 'string'
    || !identity.output.identity.providerPersonId
    || identity.output.identity.fingerprint !== fingerprintJson({
      kind: 'current-user',
      providerPersonId: identity.output.identity.providerPersonId
    }))) {
    throw new Error('Connected Task acquisition did not resolve one exact current-user identity.');
  }
  const duplicateRecords = duplicates.output.records || [];
  const duplicateIds = duplicateRecords.map((record) => record.id);
  if (duplicateRecords.length > definition.duplicateCandidateLimit
    || duplicateRecords.some((record) => record.type !== 'task')
    || new Set(duplicateIds).size !== duplicateIds.length) {
    throw new Error('Connected Task duplicate acquisition is not exact, unique, and bounded.');
  }

  const createdAt = checkpoint.updatedAt;
  const entries = [
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.task-capture.policy-selection',
      subject: 'tasks.records',
      role: 'definition',
      step: policy,
      at: createdAt
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.task-capture.schema',
      subject: 'tasks.records',
      role: 'instance',
      step: schema,
      at: createdAt
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.task-capture.project',
      subject: 'projects.records',
      role: 'instance',
      step: project,
      at: createdAt
    }),
    ...(identity ? [snapshotEntry({
      root: resolvedRoot,
      id: 'context.task-capture.identity',
      subject: 'notion.workspace',
      role: 'provider',
      step: identity,
      at: createdAt
    })] : []),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.task-capture.duplicates',
      subject: 'tasks.records',
      role: 'instance',
      step: duplicates,
      at: createdAt
    })
  ];
  const completedSources = [policy, schema, project, identity, duplicates].filter(Boolean);
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
      provenance: 'connected-task-acquisition:set:' + fingerprintJson(
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
        'The exact operator title, date, context, project request, and current-user selection remain bound to private prepared-work review material.',
        'Provider credentials, secret references, native responses, workspace identity values, and raw target metadata are excluded from general inspection and evidence.',
        'The governed Context policy definition is sealed by the current graph; the external record confirms only its selected identity.',
        'This acquisition pauses before a Task decision, proposal, approval request, provider write, or execution authority exists.'
      ]
    }
  };
  return commitDurableContextSnapshot({
    root: resolvedRoot,
    checkpointId,
    snapshot,
    contextUpdates,
    checkpointDetails: 'Automation acquired the exact Task policy selection, writable schema, project, optional current-user identity, and bounded duplicate candidates, then paused before decision, proposal, approval, or writes.',
    expectedHost
  });
}

export function taskCapturePreparedWorkIdFromSnapshot(snapshotId) {
  return workIdFromSnapshot(snapshotId);
}
