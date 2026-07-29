import fs from 'node:fs';
import path from 'node:path';

import { invokeCapability, listProviderDeclarations } from '../../core/capabilities.mjs';
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
import { prepareRunEnvelope } from '../../core/run.mjs';
import {
  commitDurableContextSnapshot,
  getExactDurableHostExecution,
  prepareDurableOperationPlanExecution
} from '../../core/service.mjs';
import {
  assertProjectWorkPolicySelection,
  loadProjectWorkPolicyDefinition
} from '../../contexts/projects/project-work-policy.mjs';

const AUTOMATION_ID = 'automation.project-pulse';
const PLAN_PREFIX = 'plan.project-pulse.connected-acquisition.';
const SNAPSHOT_PREFIX = 'context.project-pulse.connected-acquisition.';
const POLICY_STEP_ID = 'step.project-pulse-policy-selection';
const PROJECT_STEP_ID = 'step.project-pulse-project';
const TASKS_STEP_ID = 'step.project-pulse-tasks';
const DOCUMENT_STEP_ID = 'step.project-pulse-document';

function projectStatusPolicySource(lock) {
  const sources = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === 'project-work-policy';
  }));
  if (sources.length !== 1) {
    throw new Error('Project Pulse requires exactly one resolved project-work-policy source.');
  }
  const source = sources[0];
  if (source.capability !== 'projects.records.read'
    || source.authority !== 'authority.projects.definition'
    || fingerprintJson(source.input.recordTypes) !== fingerprintJson(['project-work-policy'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 1) {
    throw new Error(
      'Project Pulse Projects-policy source must be one exact project-work-policy read under definition authority.'
    );
  }
  return source;
}

function freshnessState(root, capability, observedAt, at) {
  const contract = JSON.parse(fs.readFileSync(
    path.join(root, 'soter', 'capabilities', capability + '.json'),
    'utf8'
  ));
  const maxAge = contract.freshness.maxAgeSeconds;
  if (maxAge === null) return 'unknown';
  const age = (Date.parse(at) - Date.parse(observedAt)) / 1000;
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  return age <= maxAge ? 'passed' : 'stale';
}

function requirePassed(result) {
  if (result.invocation.state !== 'passed') {
    throw new Error(
      result.invocation.capability + ' failed during Project Pulse grounding: '
        + result.invocation.error.kind + ' ' + result.invocation.error.message
    );
  }
  return result;
}

function snapshotEntry({ id, subject, authority, role, invocation, output, freshness, value = output }) {
  return {
    id,
    subject,
    authority,
    role,
    capability: invocation.capability,
    providerPack: invocation.providerPack,
    providerImplementation: invocation.providerImplementation,
    providerVersion: invocation.providerVersion,
    observedAt: output.observedAt,
    freshness,
    provenance: output.provenance,
    valueFingerprint: fingerprintJson(value),
    value
  };
}

function exactTaskUris(project) {
  const values = project.fields?.taskUris || [];
  if (!Array.isArray(values)
    || values.length > 100
    || values.some((value) => typeof value !== 'string' || !value)
    || new Set(values).size !== values.length) {
    throw new Error('Project Pulse requires exact unique promoted task resource identities.');
  }
  return [...values].sort();
}

export async function assembleProjectPulseContext({
  root,
  lock,
  lockPath,
  scenarioPath,
  runId,
  snapshotId,
  projectId,
  createdAt,
  evidenceIds = []
}) {
  const resolvedRoot = path.resolve(root);
  const envelope = prepareRunEnvelope({
    root: resolvedRoot,
    lock,
    lockPath,
    scenarioPath,
    automationId: AUTOMATION_ID,
    runId,
    createdAt,
    requestedOutcome: 'Ground a project status and exact milestone-change review without external writes.',
    evidenceIds
  });
  const policySource = projectStatusPolicySource(lock);
  const policyDefinition = loadProjectWorkPolicyDefinition(resolvedRoot);

  const definition = requirePassed(await invokeCapability({
    root: resolvedRoot,
    lock,
    capability: 'projects.records.read',
    authority: 'authority.projects.definition',
    containment: 'fixture',
    input: policySource.input,
    effectId: 'effect.project-pulse.policy.fixture',
    at: createdAt
  }));
  assertProjectWorkPolicySelection(definition.output, policyDefinition, {
    requireProjectedRules: true
  });
  const project = requirePassed(await invokeCapability({
    root: resolvedRoot,
    lock,
    capability: 'projects.records.read',
    authority: 'authority.projects.instance',
    containment: 'fixture',
    input: { recordTypes: ['project'], ids: [projectId], limit: 2 },
    effectId: 'effect.project-pulse.project.fixture',
    at: createdAt
  }));
  const projectRecord = exactRequestedContextRecord(project.output, {
    recordType: 'project',
    requestedId: projectId
  });
  const taskUris = exactTaskUris(projectRecord);
  const tasks = requirePassed(await invokeCapability({
    root: resolvedRoot,
    lock,
    capability: 'tasks.records.read',
    authority: 'authority.tasks.instance',
    containment: 'fixture',
    input: taskUris.length
      ? { recordTypes: ['task'], ids: taskUris, limit: 100 }
      : { recordTypes: ['task'], filters: { projectId }, limit: 1 },
    effectId: 'effect.project-pulse.tasks.fixture',
    at: createdAt
  }));
  const observedTaskIds = tasks.output.records.map((record) => record.id).sort();
  if (tasks.output.records.some((record) => record.type !== 'task')
    || fingerprintJson(observedTaskIds) !== fingerprintJson(taskUris)) {
    throw new Error('Project Pulse promoted tasks do not match the exact project relations.');
  }
  const document = requirePassed(await invokeCapability({
    root: resolvedRoot,
    lock,
    capability: 'documents.content.read',
    authority: 'authority.projects.instance',
    containment: 'fixture',
    input: { uri: projectRecord.id, expectedTitle: projectRecord.fields.name },
    effectId: 'effect.project-pulse.document.fixture',
    at: createdAt
  }));
  if (document.output.document.uri !== projectRecord.id
    || document.output.document.title !== projectRecord.fields.name) {
    throw new Error('Project Pulse document does not match the exact selected project identity and title.');
  }

  const results = [definition, project, tasks, document];
  const entries = [
    snapshotEntry({
      id: 'context.project-pulse.policy-selection',
      subject: 'projects.records',
      authority: 'authority.projects.definition',
      role: 'definition',
      invocation: definition.invocation,
      output: definition.output,
      freshness: freshnessState(
        resolvedRoot,
        definition.invocation.capability,
        definition.output.observedAt,
        createdAt
      )
    }),
    snapshotEntry({
      id: 'context.project-pulse.project',
      subject: 'projects.records',
      authority: 'authority.projects.instance',
      role: 'instance',
      invocation: project.invocation,
      output: project.output,
      freshness: freshnessState(
        resolvedRoot,
        project.invocation.capability,
        project.output.observedAt,
        createdAt
      )
    }),
    snapshotEntry({
      id: 'context.project-pulse.tasks',
      subject: 'tasks.records',
      authority: 'authority.tasks.instance',
      role: 'instance',
      invocation: tasks.invocation,
      output: tasks.output,
      freshness: freshnessState(
        resolvedRoot,
        tasks.invocation.capability,
        tasks.output.observedAt,
        createdAt
      )
    }),
    snapshotEntry({
      id: 'context.project-pulse.document',
      subject: 'projects.records',
      authority: 'authority.projects.instance',
      role: 'instance',
      invocation: document.invocation,
      output: document.output,
      freshness: freshnessState(
        resolvedRoot,
        document.invocation.capability,
        document.output.observedAt,
        createdAt
      )
    })
  ];
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
    effectIds: results.map((result) => result.invocation.id),
    privacy: {
      scope: 'private',
      redactions: [
        'Provider credentials, secret references, and native responses are excluded.',
        'Project, task, policy, and document values remain in private context state and do not become workspace inspection facts.'
      ]
    }
  };

  const loaded = new Map(entries.map((entry) => [entry.authority, entry]));
  envelope.context = envelope.context.map((item) => {
    const source = loaded.get(item.authority);
    if (!source) return item;
    return {
      ...item,
      status: source.freshness === 'stale' ? 'stale' : 'loaded',
      provenance: source.providerImplementation + ':' + source.valueFingerprint,
      freshness: source.freshness
    };
  });
  envelope.lifecycleState = 'context-assembled';
  envelope.checkpoints = [
    {
      id: 'effects-established',
      state: 'passed',
      details: 'Read and disclosure policies were evaluated before every fixture provider invocation.'
    },
    {
      id: 'project-context-grounded',
      state: 'passed',
      details: 'The exact policy selection, project, related promoted tasks, and current project document were loaded through typed fixture reads.'
    },
    {
      id: 'read-only-boundary',
      state: 'passed',
      details: 'No create, update, dispatch, or destructive capability was invoked.'
    }
  ];
  envelope.outputs = [{
    id: snapshot.id,
    type: 'context-snapshot',
    fingerprint: fingerprintJson(snapshot)
  }];
  envelope.effects = results.map((result) => result.invocation);
  return { envelope, snapshot };
}

function safeWorkId(workId) {
  if (typeof workId !== 'string'
    || !/^work\.project-pulse\.[a-f0-9]{24}$/.test(workId)) {
    throw new Error('Connected Project Pulse acquisition requires one exact prepared-work ID.');
  }
  return workId;
}

function suffixForWork(workId) {
  return safeWorkId(workId).slice('work.project-pulse.'.length);
}

function workIdFromPlan(planId) {
  if (typeof planId !== 'string' || !planId.startsWith(PLAN_PREFIX)) {
    throw new Error('Checkpoint is not a connected Project Pulse acquisition plan.');
  }
  return safeWorkId('work.project-pulse.' + planId.slice(PLAN_PREFIX.length));
}

function snapshotIdForWork(workId) {
  return SNAPSHOT_PREFIX + suffixForWork(workId);
}

function workIdFromSnapshot(snapshotId) {
  if (typeof snapshotId !== 'string' || !snapshotId.startsWith(SNAPSHOT_PREFIX)) {
    throw new Error('Context snapshot is not bound to connected Project Pulse acquisition.');
  }
  return safeWorkId('work.project-pulse.' + snapshotId.slice(SNAPSHOT_PREFIX.length));
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
      'Connected Project Pulse acquisition requires one ' + role + ' authority for '
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
  const source = projectStatusPolicySource(lock);
  if (source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)
    || !sameJson(source.input.recordTypes, ['project-work-policy'])
    || !Array.isArray(source.input.ids)
    || source.input.ids.length !== 1
    || source.input.limit !== 2) {
    throw new Error(
      'Connected Project Pulse Projects-policy selection must be one exact definition-authority record read.'
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
      'Connected Project Pulse acquisition requires an exact run selecting '
        + AUTOMATION_ID + '.'
    );
  }
}

function reviewValue(fields, id, { required = false, list = false } = {}) {
  const matches = fields.filter((field) => field.id === id);
  if (matches.length !== 1) {
    throw new Error('Project Pulse prepared review material must declare field ' + id + ' exactly once.');
  }
  const field = matches[0];
  if (field.state === 'omitted') {
    if (required) throw new Error('Project Pulse prepared review material requires field ' + id + '.');
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
    throw new Error('Project Pulse prepared review field ' + id + ' is not exactly fingerprint-bound.');
  }
  return structuredClone(field.reviewValue);
}

export function loadExactProjectPulsePreparedInput({
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
      project: reviewValue(material.fields, 'project', { required: true }),
      statusDate: reviewValue(material.fields, 'statusDate', { required: true }),
      visibility: reviewValue(material.fields, 'visibility', { required: true }),
      health: reviewValue(material.fields, 'health', { required: true }),
      healthMilestones: reviewValue(material.fields, 'healthMilestones', { list: true }),
      operatorGoal: reviewValue(material.fields, 'operatorGoal')
    }
  };
}

export function createProjectPulseConnectedAcquisitionPlan({
  root,
  lock,
  runId,
  workId,
  createdAt,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactProjectPulsePreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.lock.graphFingerprint !== lock.graphFingerprint
    || prepared.run.id !== runId) {
    throw new Error(
      'Connected Project Pulse plan does not match its exact prepared work, lock, graph, and run.'
    );
  }
  const definitionAuthority = selectedAuthority(lock, 'definition', 'projects.records');
  const projectAuthority = selectedAuthority(lock, 'instance', 'projects.records');
  const taskAuthority = selectedAuthority(lock, 'instance', 'tasks.records');
  const policySource = selectedPolicySource(lock, definitionAuthority);
  const projectProvider = connectedProvider(resolvedRoot, lock, 'projects.records.read');
  const taskProvider = connectedProvider(resolvedRoot, lock, 'tasks.records.read');
  const documentProvider = connectedProvider(resolvedRoot, lock, 'documents.content.read');
  return {
    $contract: 'soter://contracts/operation-plan/v2',
    contractVersion: '2.0.0',
    id: PLAN_PREFIX + suffixForWork(workId),
    runId,
    createdAt,
    mode: 'sequential',
    failurePolicy: 'stop',
    reason: 'Acquire one exact shared Projects policy selection, project, every related promoted task, and the exact current project document from one current prepared-input basis.',
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
        providerImplementation: projectProvider,
        input: structuredClone(policySource.input),
        inputBindings: [],
        reason: 'Confirm the exact external policy-selection identity bound to the governed Context definition.'
      },
      {
        id: PROJECT_STEP_ID,
        capability: 'projects.records.read',
        authority: projectAuthority,
        providerImplementation: projectProvider,
        input: { recordTypes: ['project'], ids: [prepared.input.project], limit: 2 },
        inputBindings: [],
        reason: 'Resolve the exact selected project and its explicit promoted-task relations.'
      },
      {
        id: TASKS_STEP_ID,
        capability: 'tasks.records.read',
        authority: taskAuthority,
        providerImplementation: taskProvider,
        input: { recordTypes: ['task'], limit: 100 },
        inputBindings: [{
          id: 'binding.project-pulse-task-uris',
          sourceStepId: PROJECT_STEP_ID,
          sourcePath: ['records', '*', 'fields', 'taskUris'],
          targetPath: ['ids'],
          transform: 'unique-string-list',
          onEmpty: 'skip-step'
        }],
        reason: 'Read every and only the promoted tasks explicitly related by the selected project.'
      },
      {
        id: DOCUMENT_STEP_ID,
        capability: 'documents.content.read',
        authority: projectAuthority,
        providerImplementation: documentProvider,
        input: {},
        inputBindings: [
          {
            id: 'binding.project-pulse-document-uri',
            sourceStepId: PROJECT_STEP_ID,
            sourcePath: ['records', '*', 'id'],
            targetPath: ['uri'],
            transform: 'exact-string',
            onEmpty: 'fail-plan'
          },
          {
            id: 'binding.project-pulse-document-title',
            sourceStepId: PROJECT_STEP_ID,
            sourcePath: ['records', '*', 'fields', 'name'],
            targetPath: ['expectedTitle'],
            transform: 'exact-string',
            onEmpty: 'fail-plan'
          }
        ],
        reason: 'Read the exact current project document body before interpreting or proposing milestone changes.'
      }
    ]
  };
}

export function assertProjectPulseConnectedAcquisitionPlan(plan) {
  const workId = workIdFromPlan(plan?.id);
  const [policy, project, tasks, document] = plan.steps || [];
  const expectedIds = [POLICY_STEP_ID, PROJECT_STEP_ID, TASKS_STEP_ID, DOCUMENT_STEP_ID];
  if (plan.$contract !== 'soter://contracts/operation-plan/v2'
    || plan.contractVersion !== '2.0.0'
    || plan.mode !== 'sequential'
    || plan.failurePolicy !== 'stop'
    || !sameJson(plan.steps.map((step) => step.id), expectedIds)
    || policy.capability !== 'projects.records.read'
    || project.capability !== 'projects.records.read'
    || tasks.capability !== 'tasks.records.read'
    || document.capability !== 'documents.content.read'
    || !sameJson(policy.inputBindings, [])
    || !sameJson(project.inputBindings, [])
    || !sameJson(tasks.input, { recordTypes: ['task'], limit: 100 })
    || !sameJson(tasks.inputBindings, [{
      id: 'binding.project-pulse-task-uris',
      sourceStepId: PROJECT_STEP_ID,
      sourcePath: ['records', '*', 'fields', 'taskUris'],
      targetPath: ['ids'],
      transform: 'unique-string-list',
      onEmpty: 'skip-step'
    }])
    || !sameJson(document.input, {})
    || !sameJson(document.inputBindings, [
      {
        id: 'binding.project-pulse-document-uri',
        sourceStepId: PROJECT_STEP_ID,
        sourcePath: ['records', '*', 'id'],
        targetPath: ['uri'],
        transform: 'exact-string',
        onEmpty: 'fail-plan'
      },
      {
        id: 'binding.project-pulse-document-title',
        sourceStepId: PROJECT_STEP_ID,
        sourcePath: ['records', '*', 'fields', 'name'],
        targetPath: ['expectedTitle'],
        transform: 'exact-string',
        onEmpty: 'fail-plan'
      }
    ])) {
    throw new Error('Connected Project Pulse acquisition plan does not preserve its exact source order and bindings.');
  }
  return { workId, snapshotId: snapshotIdForWork(workId), policy, project, tasks, document };
}

function completedStep(checkpoint, id) {
  const step = checkpoint.steps.find((item) => item.id === id);
  if (!step || step.state !== 'completed' || !step.call || !step.output) {
    throw new Error('Connected Project Pulse acquisition source ' + id + ' is not completed.');
  }
  return step;
}

function terminalTasksStep(checkpoint, expectedIds) {
  const step = checkpoint.steps.find((item) => item.id === TASKS_STEP_ID);
  if (!step) throw new Error('Connected Project Pulse task source is missing.');
  if (step.state === 'skipped') {
    if (expectedIds.length
      || step.call !== null
      || step.output !== null
      || !Array.isArray(step.resolvedInput?.ids)
      || step.resolvedInput.ids.length
      || step.bindingResolutions.length !== 1
      || step.bindingResolutions[0].state !== 'empty') {
      throw new Error('Connected Project Pulse empty task relation has invalid skipped state.');
    }
    return null;
  }
  if (step.state !== 'completed' || !step.call || !step.output) {
    throw new Error('Connected Project Pulse task source is not terminal.');
  }
  const records = step.output.records || [];
  const ids = records.map((record) => record.id).sort();
  if (records.some((record) => record.type !== 'task')
    || new Set(ids).size !== ids.length
    || !sameJson(ids, [...expectedIds].sort())
    || !sameJson(step.resolvedInput.ids, [...expectedIds].sort())) {
    throw new Error('Connected Project Pulse task source must return every and only the bound task records.');
  }
  return step;
}

function connectedSnapshotEntry({ root, id, subject, role, step, at }) {
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

function skippedTasksEntry({ root, lock, planStep, projectStep, at }) {
  const binding = lock.bindings.find((item) => item.capability === 'tasks.records.read');
  const provider = listProviderDeclarations(root).find((item) => {
    return item.id === planStep.providerImplementation;
  });
  const value = {
    records: [],
    provenance: {
      provider: 'derived-empty-binding',
      authority: planStep.authority,
      sourceOutputFingerprint: projectStep.outputFingerprint
    },
    observedAt: projectStep.output.observedAt
  };
  return {
    id: 'context.project-pulse.tasks',
    subject: 'tasks.records',
    authority: planStep.authority,
    role: 'instance',
    capability: 'tasks.records.read',
    providerPack: binding.providerPack,
    providerImplementation: planStep.providerImplementation,
    providerVersion: provider.version,
    observedAt: value.observedAt,
    freshness: freshnessState(root, 'tasks.records.read', value.observedAt, at),
    provenance: value.provenance,
    valueFingerprint: fingerprintJson(value),
    value
  };
}

function effectId(call) {
  return 'effect.' + call.id.slice('toolcall.'.length);
}

export async function prepareProjectPulseConnectedAcquisition({
  root,
  workId,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactProjectPulsePreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  const createdAt = at || new Date().toISOString();
  const plan = createProjectPulseConnectedAcquisitionPlan({
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

export function finalizeProjectPulseConnectedAcquisition({
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
    throw new Error('Connected Project Pulse acquisition can finalize only from a completed operation plan.');
  }
  const shape = assertProjectPulseConnectedAcquisitionPlan(checkpoint.plan);
  const prepared = loadExactProjectPulsePreparedInput({
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
    throw new Error('Connected Project Pulse acquisition no longer matches its exact lock and graph.');
  }
  assertSelectedAutomation(lock, execution.run);
  const expectedPlan = createProjectPulseConnectedAcquisitionPlan({
    root: resolvedRoot,
    lock,
    runId: checkpoint.plan.runId,
    workId: shape.workId,
    createdAt: checkpoint.plan.createdAt,
    expectedHost
  });
  if (!sameJson(expectedPlan, checkpoint.plan)) {
    throw new Error('Connected Project Pulse acquisition drifted from its exact prepared-input basis.');
  }

  const definition = loadProjectWorkPolicyDefinition(resolvedRoot);
  const policy = completedStep(checkpoint, POLICY_STEP_ID);
  const project = completedStep(checkpoint, PROJECT_STEP_ID);
  assertProjectWorkPolicySelection(policy.output, definition);
  const projectRecord = exactRequestedContextRecord(project.output, {
    recordType: 'project',
    requestedId: shape.project.input.ids[0]
  });
  const taskIds = exactTaskUris(projectRecord);
  const tasks = terminalTasksStep(checkpoint, taskIds);
  const document = completedStep(checkpoint, DOCUMENT_STEP_ID);
  if (document.output.document?.uri !== projectRecord.id
    || document.output.document?.title !== projectRecord.fields.name
    || document.output.document?.bodyFingerprint
      !== fingerprintJson(document.output.document?.body)) {
    throw new Error('Connected Project Pulse acquisition did not resolve the exact current project document.');
  }

  const createdAt = checkpoint.updatedAt;
  const entries = [
    connectedSnapshotEntry({
      root: resolvedRoot,
      id: 'context.project-pulse.policy-selection',
      subject: 'projects.records',
      role: 'definition',
      step: policy,
      at: createdAt
    }),
    connectedSnapshotEntry({
      root: resolvedRoot,
      id: 'context.project-pulse.project',
      subject: 'projects.records',
      role: 'instance',
      step: project,
      at: createdAt
    }),
    tasks ? connectedSnapshotEntry({
      root: resolvedRoot,
      id: 'context.project-pulse.tasks',
      subject: 'tasks.records',
      role: 'instance',
      step: tasks,
      at: createdAt
    }) : skippedTasksEntry({
      root: resolvedRoot,
      lock,
      planStep: shape.tasks,
      projectStep: project,
      at: createdAt
    }),
    connectedSnapshotEntry({
      root: resolvedRoot,
      id: 'context.project-pulse.document',
      subject: 'projects.records',
      role: 'instance',
      step: document,
      at: createdAt
    })
  ];
  const completedSources = [policy, project, tasks, document].filter(Boolean);
  const contextUpdates = [...new Set(entries.map((entry) => entry.authority))].map((authority) => {
    const values = entries.filter((entry) => entry.authority === authority);
    const freshness = values.some((entry) => entry.freshness === 'stale') ? 'stale'
      : values.some((entry) => entry.freshness === 'unknown') ? 'unknown'
        : 'passed';
    return {
      authority,
      status: freshness === 'stale' ? 'stale' : 'loaded',
      provenance: 'connected-project-pulse:set:' + fingerprintJson(values.map((entry) => ({
        id: entry.id,
        fingerprint: entry.valueFingerprint
      }))),
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
        'The exact project request, status date, visibility, operator health judgment, selected health milestones, and operator note remain bound to private prepared-work review material.',
        'Project names, task titles, milestone lines, provider responses, and native target metadata remain in private local Context state.',
        'The external policy record confirms selected identity only; the governed Context definition owns normalized rules.',
        'This acquisition pauses before a decision, proposal, approval request, provider write, or execution authority exists.'
      ]
    }
  };
  return commitDurableContextSnapshot({
    root: resolvedRoot,
    checkpointId,
    snapshot,
    contextUpdates,
    checkpointDetails: 'Automation acquired the exact shared Projects policy selection, project, promoted tasks, and current document, then paused before decision, proposal, approval, or writes.',
    expectedHost
  });
}

export function projectPulsePreparedWorkIdFromSnapshot(snapshotId) {
  return workIdFromSnapshot(snapshotId);
}
