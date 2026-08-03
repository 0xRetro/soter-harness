import path from 'node:path';

import { listProviderDeclarations } from '../../core/capabilities.mjs';
import { exactRequestedContextRecord } from '../../core/context-records.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { loadExactPreparedAutomationAcquisition } from '../../core/prepared-work.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  commitDurableContextSnapshot,
  getExactDurableHostExecution,
  prepareDurableOperationPlanExecution
} from '../../core/service.mjs';
import {
  assertProjectCapturePolicySelection,
  loadProjectCapturePolicyDefinition,
  projectCapturePolicyFields
} from '../../contexts/projects/project-capture-policy.mjs';
import { assertProjectPageReconciliationSchema } from './schema.mjs';

const AUTOMATION_ID = 'automation.project-page-reconciliation';
const PLAN_PREFIX = 'plan.project-page-reconciliation.connected-acquisition.';
const SNAPSHOT_PREFIX = 'context.project-page-reconciliation.connected-acquisition.';
const POLICY_STEP_ID = 'step.project-reconciliation-policy';
const SCHEMA_STEP_ID = 'step.project-reconciliation-schema';
const PROJECT_STEP_ID = 'step.project-reconciliation-project';
const CONTENT_STEP_ID = 'step.project-reconciliation-content';

function sameJson(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function safeWorkId(workId) {
  if (typeof workId !== 'string'
    || !/^work\.project-page-reconciliation\.[a-f0-9]{24}$/.test(workId)) {
    throw new Error(
      'Connected Project page reconciliation acquisition requires one exact prepared-work ID.'
    );
  }
  return workId;
}

function suffixForWork(workId) {
  return safeWorkId(workId).slice('work.project-page-reconciliation.'.length);
}

function workIdFromPlan(planId) {
  if (typeof planId !== 'string' || !planId.startsWith(PLAN_PREFIX)) {
    throw new Error('Checkpoint is not a connected Project page reconciliation acquisition plan.');
  }
  return safeWorkId(
    'work.project-page-reconciliation.' + planId.slice(PLAN_PREFIX.length)
  );
}

function snapshotIdForWork(workId) {
  return SNAPSHOT_PREFIX + suffixForWork(workId);
}

function workIdFromSnapshot(snapshotId) {
  if (typeof snapshotId !== 'string' || !snapshotId.startsWith(SNAPSHOT_PREFIX)) {
    throw new Error('Context snapshot is not bound to Project page reconciliation acquisition.');
  }
  return safeWorkId(
    'work.project-page-reconciliation.' + snapshotId.slice(SNAPSHOT_PREFIX.length)
  );
}

function selectedAuthority(lock, role, subject = 'projects.records') {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error(
      'Connected Project page reconciliation acquisition requires one ' + role
        + ' authority for ' + subject + '; found ' + matches.length + '.'
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
      'Expected one connected provider for ' + capability + '; found ' + matches.length + '.'
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
    throw new Error(
      'Connected Project page reconciliation acquisition requires one policy source.'
    );
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
      'Connected Project page reconciliation policy must be one exact definition read.'
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
      'Connected Project page reconciliation acquisition requires its exact selected Automation.'
    );
  }
}

function reviewValue(fields, id, { required = false, list = false } = {}) {
  const matches = fields.filter((field) => field.id === id);
  if (matches.length !== 1) {
    throw new Error(
      'Project page reconciliation prepared review material must declare ' + id + ' once.'
    );
  }
  const field = matches[0];
  if (field.state === 'omitted') {
    if (required) {
      throw new Error('Project page reconciliation prepared review material requires ' + id + '.');
    }
    return undefined;
  }
  const valid = list
    ? Array.isArray(field.reviewValue)
      && field.reviewValue.length > 0
      && field.reviewValue.every((item) => typeof item === 'string' && item)
      && new Set(field.reviewValue).size === field.reviewValue.length
    : typeof field.reviewValue === 'string' && field.reviewValue;
  if (field.state !== 'provided'
    || !valid
    || field.fingerprint !== fingerprintJson(field.reviewValue)) {
    throw new Error(
      'Project page reconciliation prepared review field ' + id
        + ' is not exactly fingerprint-bound.'
    );
  }
  return structuredClone(field.reviewValue);
}

export function loadExactProjectPageReconciliationPreparedInput({
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
  const projectType = reviewValue(material.fields, 'projectType');
  const status = reviewValue(material.fields, 'status');
  const oldTexts = reviewValue(material.fields, 'oldTexts', { list: true });
  const newTexts = reviewValue(material.fields, 'newTexts', { list: true });
  if ((oldTexts === undefined) !== (newTexts === undefined)) {
    throw new Error('Project page reconciliation text replacements must remain exactly aligned.');
  }
  const input = {
    project: reviewValue(material.fields, 'project', { required: true }),
    ...(projectType === undefined ? {} : { projectType }),
    ...(status === undefined ? {} : { status }),
    ...(oldTexts === undefined ? {} : { oldTexts, newTexts })
  };
  if (!Object.hasOwn(input, 'projectType')
    && !Object.hasOwn(input, 'status')
    && !Object.hasOwn(input, 'oldTexts')) {
    throw new Error('Project page reconciliation prepared input has no supported requested change.');
  }
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

export function createProjectPageReconciliationConnectedAcquisitionPlan({
  root,
  lock,
  runId,
  workId,
  createdAt,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactProjectPageReconciliationPreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.lock.graphFingerprint !== lock.graphFingerprint
    || prepared.run.id !== runId) {
    throw new Error(
      'Connected Project page reconciliation plan does not match its prepared work and run.'
    );
  }
  const definitionAuthority = selectedAuthority(lock, 'definition');
  const instanceAuthority = selectedAuthority(lock, 'instance');
  const policySource = selectedPolicySource(lock, definitionAuthority);
  const recordProvider = connectedProvider(resolvedRoot, lock, 'projects.records.read');
  const schemaProvider = connectedProvider(resolvedRoot, lock, 'projects.schema.read');
  return {
    $contract: 'soter://contracts/operation-plan/v2',
    contractVersion: '2.0.0',
    id: PLAN_PREFIX + suffixForWork(workId),
    runId,
    createdAt,
    mode: 'sequential',
    failurePolicy: 'stop',
    reason: 'Acquire one exact Project policy, writable schema, metadata record, and content-inclusive record from one current prepared-input basis.',
    configuration: {
      name: prepared.work.configuration.name,
      configurationBasis: 'private-active',
      path: prepared.work.configuration.path,
      lockPath: prepared.work.configuration.lockPath,
      lockFingerprint: prepared.work.configuration.lockFingerprint,
      graphFingerprint: prepared.work.configuration.graphFingerprint
    },
    steps: [
      {
        id: POLICY_STEP_ID,
        capability: 'projects.records.read',
        authority: definitionAuthority,
        providerImplementation: recordProvider,
        input: structuredClone(policySource.input),
        inputBindings: [],
        reason: 'Confirm the exact external policy-selection identity.'
      },
      {
        id: SCHEMA_STEP_ID,
        capability: 'projects.schema.read',
        authority: instanceAuthority,
        providerImplementation: schemaProvider,
        input: { recordType: 'project' },
        inputBindings: [],
        reason: 'Observe the current normalized writable Project fields and choices.'
      },
      {
        id: PROJECT_STEP_ID,
        capability: 'projects.records.read',
        authority: instanceAuthority,
        providerImplementation: recordProvider,
        input: { recordTypes: ['project'], ids: [prepared.input.project], limit: 1 },
        inputBindings: [],
        reason: 'Resolve the exact selected Project identity, title, fields, and version.'
      },
      {
        id: CONTENT_STEP_ID,
        capability: 'projects.records.read',
        authority: instanceAuthority,
        providerImplementation: recordProvider,
        input: { recordTypes: ['project'], limit: 1 },
        inputBindings: [
          {
            id: 'binding.project-reconciliation-content-id',
            sourceStepId: PROJECT_STEP_ID,
            sourcePath: ['records', '*', 'id'],
            targetPath: ['ids'],
            transform: 'unique-string-list',
            onEmpty: 'fail-plan'
          },
          {
            id: 'binding.project-reconciliation-content-title',
            sourceStepId: PROJECT_STEP_ID,
            sourcePath: ['records', '*', 'fields', 'name'],
            targetPath: ['content', 'expectedTitle'],
            transform: 'exact-string',
            onEmpty: 'fail-plan'
          }
        ],
        reason: 'Read the exact selected Project again through the content-inclusive mapping.'
      }
    ]
  };
}

export function assertProjectPageReconciliationConnectedAcquisitionPlan(plan) {
  const workId = workIdFromPlan(plan?.id);
  const [policy, schema, project, content] = plan.steps || [];
  if (plan.$contract !== 'soter://contracts/operation-plan/v2'
    || plan.contractVersion !== '2.0.0'
    || plan.mode !== 'sequential'
    || plan.failurePolicy !== 'stop'
    || !sameJson(plan.steps.map((step) => step.id), [
      POLICY_STEP_ID,
      SCHEMA_STEP_ID,
      PROJECT_STEP_ID,
      CONTENT_STEP_ID
    ])
    || policy.capability !== 'projects.records.read'
    || schema.capability !== 'projects.schema.read'
    || project.capability !== 'projects.records.read'
    || content.capability !== 'projects.records.read'
    || !sameJson(policy.inputBindings, [])
    || !sameJson(schema.inputBindings, [])
    || !sameJson(project.inputBindings, [])
    || !sameJson(content.input, { recordTypes: ['project'], limit: 1 })
    || !sameJson(content.inputBindings, [
      {
        id: 'binding.project-reconciliation-content-id',
        sourceStepId: PROJECT_STEP_ID,
        sourcePath: ['records', '*', 'id'],
        targetPath: ['ids'],
        transform: 'unique-string-list',
        onEmpty: 'fail-plan'
      },
      {
        id: 'binding.project-reconciliation-content-title',
        sourceStepId: PROJECT_STEP_ID,
        sourcePath: ['records', '*', 'fields', 'name'],
        targetPath: ['content', 'expectedTitle'],
        transform: 'exact-string',
        onEmpty: 'fail-plan'
      }
    ])) {
    throw new Error(
      'Connected Project page reconciliation acquisition does not preserve exact source order.'
    );
  }
  return {
    workId,
    snapshotId: snapshotIdForWork(workId),
    policy,
    schema,
    project,
    content
  };
}

function completedStep(checkpoint, id) {
  const step = checkpoint.steps.find((item) => item.id === id);
  if (!step || step.state !== 'completed' || !step.call || !step.output) {
    throw new Error(
      'Connected Project page reconciliation source ' + id + ' is not completed.'
    );
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

function snapshotEntry({ root, id, role, step, at }) {
  return {
    id,
    subject: 'projects.records',
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

export async function prepareProjectPageReconciliationConnectedAcquisition({
  root,
  workId,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactProjectPageReconciliationPreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  const createdAt = at || new Date().toISOString();
  const plan = createProjectPageReconciliationConnectedAcquisitionPlan({
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

export function finalizeProjectPageReconciliationConnectedAcquisition({
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
      'Connected Project page reconciliation acquisition requires a completed plan.'
    );
  }
  const shape = assertProjectPageReconciliationConnectedAcquisitionPlan(checkpoint.plan);
  const prepared = loadExactProjectPageReconciliationPreparedInput({
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
    throw new Error(
      'Connected Project page reconciliation acquisition no longer matches its lock and run.'
    );
  }
  assertSelectedAutomation(lock, execution.run);
  const expectedPlan = createProjectPageReconciliationConnectedAcquisitionPlan({
    root: resolvedRoot,
    lock,
    runId: checkpoint.plan.runId,
    workId: shape.workId,
    createdAt: checkpoint.plan.createdAt,
    expectedHost
  });
  if (!sameJson(expectedPlan, checkpoint.plan)) {
    throw new Error(
      'Connected Project page reconciliation acquisition drifted from prepared input.'
    );
  }

  const policyStep = completedStep(checkpoint, POLICY_STEP_ID);
  const schemaStep = completedStep(checkpoint, SCHEMA_STEP_ID);
  const projectStep = completedStep(checkpoint, PROJECT_STEP_ID);
  const contentStep = completedStep(checkpoint, CONTENT_STEP_ID);
  const definition = loadProjectCapturePolicyDefinition(resolvedRoot);
  assertProjectCapturePolicySelection(policyStep.output, definition);
  assertProjectPageReconciliationSchema(
    schemaStep.output,
    projectCapturePolicyFields(definition)
  );
  const metadata = exactRequestedContextRecord(projectStep.output, {
    recordType: 'project',
    requestedId: prepared.input.project
  });
  if (typeof metadata.fields?.name !== 'string' || !metadata.fields.name) {
    throw new Error('Connected Project page reconciliation requires one exact Project title.');
  }
  if (!sameJson(contentStep.resolvedInput, {
    recordTypes: ['project'],
    ids: [prepared.input.project],
    content: { expectedTitle: metadata.fields.name },
    limit: 1
  })) {
    throw new Error('Connected Project content read is not bound to the exact observed ID and title.');
  }
  const content = exactRequestedContextRecord(contentStep.output, {
    recordType: 'project',
    requestedId: prepared.input.project
  });
  if (content.id !== metadata.id
    || !sameJson(content.fields, metadata.fields)
    || typeof content.body !== 'string'
    || !content.body.trim()) {
    throw new Error(
      'Connected Project metadata and content-inclusive observations are not the same exact state.'
    );
  }

  const createdAt = checkpoint.updatedAt;
  const entries = [
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-page-reconciliation.policy',
      role: 'definition',
      step: policyStep,
      at: createdAt
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-page-reconciliation.schema',
      role: 'instance',
      step: schemaStep,
      at: createdAt
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-page-reconciliation.project',
      role: 'instance',
      step: projectStep,
      at: createdAt
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-page-reconciliation.project-content',
      role: 'instance',
      step: contentStep,
      at: createdAt
    })
  ];
  const contextUpdates = [...new Set(entries.map((entry) => entry.authority))].map((authority) => {
    const selected = entries.filter((entry) => entry.authority === authority);
    const freshness = selected.some((entry) => entry.freshness === 'stale')
      ? 'stale'
      : (selected.some((entry) => entry.freshness === 'unknown') ? 'unknown' : 'passed');
    return {
      authority,
      status: freshness === 'stale' ? 'stale' : 'loaded',
      provenance: 'connected-project-page-reconciliation:set:' + fingerprintJson(
        selected.map((entry) => ({ id: entry.id, fingerprint: entry.valueFingerprint }))
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
    effectIds: [policyStep, schemaStep, projectStep, contentStep].map((step) => {
      return effectId(step.call);
    }),
    privacy: {
      scope: 'private',
      redactions: [
        'Exact Project identity, title, fields, version, page body, and desired changes remain private local state.',
        'Provider credentials, raw responses, target metadata, and unrelated values are excluded from general inspection and evidence.',
        'Acquisition creates no decision, proposal, approval, continuation, retry, provider write, or proof authority.'
      ]
    }
  };
  return commitDurableContextSnapshot({
    root: resolvedRoot,
    checkpointId,
    snapshot,
    contextUpdates,
    checkpointDetails: 'Automation acquired exact Project policy, schema, metadata, and content-inclusive state, then paused before decision, proposal, approval, or writes.',
    expectedHost
  });
}

export function projectPageReconciliationPreparedWorkIdFromSnapshot(snapshotId) {
  return workIdFromSnapshot(snapshotId);
}
