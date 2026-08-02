import fs from 'node:fs';
import path from 'node:path';

import { listProviderDeclarations } from '../../core/capabilities.mjs';
import { exactRequestedContextRecord } from '../../core/context-records.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { loadExactPreparedAutomationAcquisition } from '../../core/prepared-work.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  commitDurableContextSnapshot,
  getExactDurableContextSnapshot,
  getExactDurableHostExecution,
  prepareDurableOperationPlanExecution
} from '../../core/service.mjs';
import { validateJsonSchema } from '../../kernel/verify.mjs';
import {
  assertProjectCapturePolicySelection,
  loadProjectCapturePolicyDefinition,
  projectCapturePolicyFields
} from '../../contexts/projects/project-capture-policy.mjs';
import {
  assertProjectWorkPolicySelection,
  loadProjectWorkPolicyDefinition,
  projectWorkPolicyFields
} from '../../contexts/projects/project-work-policy.mjs';
import {
  assertTaskWorkPolicySelection,
  loadTaskWorkPolicyDefinition,
  taskWorkPolicyFields
} from '../../contexts/tasks/task-work-policy.mjs';
import { analyzeProjectPageReview } from './analysis.mjs';

const AUTOMATION_ID = 'automation.project-page-review';
const WORK_PATTERN = /^work\.project-page-review\.([a-f0-9]{24})$/;
const PLAN_PREFIX = 'plan.project-page-review.connected-acquisition.';
const SNAPSHOT_PREFIX = 'context.project-page-review.connected-acquisition.';
const CAPTURE_POLICY_STEP = 'step.project-page-review.capture-policy';
const PROJECT_WORK_POLICY_STEP = 'step.project-page-review.project-work-policy';
const TASK_WORK_POLICY_STEP = 'step.project-page-review.task-work-policy';
const TEMPLATE_STEP = 'step.project-page-review.template';
const PROJECT_STEP = 'step.project-page-review.project';
const TASKS_STEP = 'step.project-page-review.tasks';
const DOCUMENT_STEP = 'step.project-page-review.document';
const INSPECTION_SCHEMA =
  'soter/automations/project-page-review/connected-inspection.schema.json';
const REVIEW_SCHEMA =
  'soter/automations/project-page-review/connected-review.schema.json';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameJson(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function connectedError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function safeWorkId(workId) {
  if (typeof workId !== 'string' || !WORK_PATTERN.test(workId)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_WORK_INVALID',
      'Connected Project-page review requires one exact prepared-work identifier.'
    );
  }
  return workId;
}

function suffix(workId) {
  return WORK_PATTERN.exec(safeWorkId(workId))[1];
}

function planIdFor(workId) {
  return PLAN_PREFIX + suffix(workId);
}

function workIdFromPlan(planId) {
  if (typeof planId !== 'string' || !planId.startsWith(PLAN_PREFIX)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_PLAN_INVALID',
      'Connected Project-page checkpoint is not the expected plan family.'
    );
  }
  return safeWorkId('work.project-page-review.' + planId.slice(PLAN_PREFIX.length));
}

function snapshotIdFor(workId) {
  return SNAPSHOT_PREFIX + suffix(workId);
}

function selfFingerprint(value) {
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function withSelfFingerprint(value) {
  const next = { ...value, fingerprint: 'sha256:' + '0'.repeat(64) };
  next.fingerprint = selfFingerprint(next);
  return next;
}

function validateClosed(root, value, schemaPath, code, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw connectedError(code, label + ' does not satisfy its closed contract.');
  }
  return value;
}

function selectedAuthority(lock, role, subject) {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_BINDING_INVALID',
      'Connected Project-page review requires one exact '
        + role + ' authority for ' + subject + '.'
    );
  }
  return matches[0].id;
}

function exactSettings(lock) {
  const settings = lock.settings?.[AUTOMATION_ID];
  if (!settings
    || Object.keys(settings).length !== 3
    || !Number.isInteger(settings.maximumOutlineEntries)
    || settings.maximumOutlineEntries < 2
    || settings.maximumOutlineEntries > 200
    || settings.semanticLabelMatcher !== 'headings-and-standalone-bold/v1'
    || settings.structuralBlockMatcher !== 'normalized-structural-block-tags/v1') {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_BINDING_INVALID',
      'Connected Project-page review matcher settings are missing or invalid.'
    );
  }
  return structuredClone(settings);
}

function selectedSource(lock, purpose, capability, authority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === purpose;
  }));
  if (matches.length !== 1) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_BINDING_INVALID',
      'Connected Project-page review requires one exact source for ' + purpose + '.'
    );
  }
  const source = matches[0];
  if (source.capability !== capability
    || source.authority !== authority
    || source.inputFingerprint !== fingerprintJson(source.input)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_BINDING_INVALID',
      'Connected Project-page review source drifted for ' + purpose + '.'
    );
  }
  return source;
}

function connectedProvider(root, lock, capability) {
  const binding = lock.bindings.find((item) => item.capability === capability);
  if (!binding) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_BINDING_INVALID',
      'Connected Project-page review is missing a required capability binding.'
    );
  }
  const matches = listProviderDeclarations(root).filter((provider) => {
    return provider.pack === binding.providerPack
      && provider.containment === 'connected'
      && provider.capabilities.some((item) => {
        return item.id === capability && item.version === binding.capabilityVersion;
      });
  });
  if (matches.length !== 1) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_BINDING_INVALID',
      'Connected Project-page review requires one exact connected provider for '
        + capability + '.'
    );
  }
  return matches[0].id;
}

function assertSelectedAutomation(lock, run) {
  const selected = lock.packs.filter((pack) => {
    return pack.id === AUTOMATION_ID && pack.layer === 'automation';
  });
  if (selected.length !== 1
    || run?.automation?.id !== AUTOMATION_ID
    || run.automation.version !== selected[0].version) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_BINDING_INVALID',
      'Connected Project-page review requires one exact selected Automation run.'
    );
  }
}

function reviewField(material, id, { required = false } = {}) {
  const fields = material?.fields || [];
  const matches = fields.filter((field) => field.id === id);
  if (matches.length !== 1) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_WORK_INVALID',
      'Connected Project-page review private input must declare ' + id + ' exactly once.'
    );
  }
  const field = matches[0];
  if (field.state === 'omitted') {
    if (required) {
      throw connectedError(
        'PROJECT_PAGE_CONNECTED_WORK_INVALID',
        'Connected Project-page review requires private input ' + id + '.'
      );
    }
    return null;
  }
  if (field.state !== 'provided'
    || typeof field.reviewValue !== 'string'
    || !field.reviewValue
    || field.fingerprint !== fingerprintJson(field.reviewValue)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_WORK_INVALID',
      'Connected Project-page review input ' + id + ' is not exact and fingerprint-bound.'
    );
  }
  return field.reviewValue;
}

function exactTaskUris(project) {
  const fields = project?.fields;
  if (!fields
    || !Object.hasOwn(fields, 'taskUris')
    || !Array.isArray(fields.taskUris)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_OUTPUT_INVALID',
      'Connected Project-page review requires an explicitly available Project taskUris array.'
    );
  }
  const values = fields.taskUris;
  if (values.length > 100
    || values.some((value) => typeof value !== 'string' || !value)
    || new Set(values).size !== values.length) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_OUTPUT_INVALID',
      'Connected Project-page review requires at most 100 exact unique related Tasks.'
    );
  }
  return [...values].sort(compareCodepoint);
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

function completedStep(checkpoint, id) {
  const step = checkpoint.steps.find((item) => item.id === id);
  if (!step || step.state !== 'completed' || !step.call || !step.output) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_INCOMPLETE',
      'Connected Project-page source ' + id + ' is not complete.'
    );
  }
  return step;
}

function terminalTasksStep(checkpoint, expectedIds) {
  const step = checkpoint.steps.find((item) => item.id === TASKS_STEP);
  if (!step) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_INCOMPLETE',
      'Connected Project-page Task source is missing.'
    );
  }
  if (step.state === 'skipped') {
    if (expectedIds.length
      || step.call !== null
      || step.output !== null
      || !Array.isArray(step.resolvedInput?.ids)
      || step.resolvedInput.ids.length
      || step.bindingResolutions.length !== 1
      || step.bindingResolutions[0].state !== 'empty') {
      throw connectedError(
        'PROJECT_PAGE_CONNECTED_OUTPUT_INVALID',
        'Connected Project-page empty Task relation has invalid skipped state.'
      );
    }
    return {
      step: null,
      expectedCount: 0,
      observedCount: 0,
      unavailableCount: 0
    };
  }
  if (step.state !== 'completed' || !step.call || !step.output) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_INCOMPLETE',
      'Connected Project-page Task source is not terminal.'
    );
  }
  const records = step.output.records || [];
  const ids = records.map((record) => record.id).sort(compareCodepoint);
  const expected = new Set(expectedIds);
  if (records.some((record) => record.type !== 'task')
    || new Set(ids).size !== ids.length
    || ids.some((id) => !expected.has(id))
    || !sameJson(step.resolvedInput.ids, expectedIds)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_OUTPUT_INVALID',
      'Connected Project-page Task source returned duplicate, substituted, or out-of-scope Tasks.'
    );
  }
  return {
    step,
    expectedCount: expectedIds.length,
    observedCount: ids.length,
    unavailableCount: expectedIds.length - ids.length
  };
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

export function loadExactProjectPageReviewPreparedInput({
  root,
  workId,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  let prepared;
  try {
    prepared = loadExactPreparedAutomationAcquisition({
      root: resolvedRoot,
      workId: safeWorkId(workId),
      automationId: AUTOMATION_ID,
      expectedHost
    });
  } catch (error) {
    throw connectedError(
      error?.code === 'PREPARED_ACQUISITION_STALE'
        ? 'PROJECT_PAGE_CONNECTED_STALE'
        : 'PROJECT_PAGE_CONNECTED_WORK_INVALID',
      'Connected Project-page prepared work or private input is unavailable or invalid.',
      error
    );
  }
  const { work, material, lock, run, runPath } = prepared;
  assertSelectedAutomation(lock, run);
  const project = reviewField(material, 'project', { required: true });
  const focus = reviewField(material, 'focus');
  if (project.length < 3 || project.length > 500 || (focus && focus.length > 500)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_WORK_INVALID',
      'Connected Project-page private input exceeds its exact bounds.'
    );
  }
  return {
    work,
    material,
    lock,
    lockPath: work.configuration.lockPath,
    run,
    runPath,
    settings: exactSettings(lock),
    input: { project, focus },
    privateInputFingerprint: fingerprintJson({ project, focus })
  };
}

export function createProjectPageReviewConnectedPlan({
  root,
  lock,
  runId,
  workId,
  createdAt,
  expectedHost = null
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactProjectPageReviewPreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.lock.graphFingerprint !== lock.graphFingerprint
    || prepared.run.id !== runId) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_STALE',
      'Connected Project-page plan does not match its prepared work, lock, graph, and run.'
    );
  }
  const projectDefinition = selectedAuthority(lock, 'definition', 'projects.records');
  const projectInstance = selectedAuthority(lock, 'instance', 'projects.records');
  const taskDefinition = selectedAuthority(lock, 'definition', 'tasks.records');
  const taskInstance = selectedAuthority(lock, 'instance', 'tasks.records');
  const projectProvider = connectedProvider(resolvedRoot, lock, 'projects.records.read');
  const taskProvider = connectedProvider(resolvedRoot, lock, 'tasks.records.read');
  const documentProvider = connectedProvider(resolvedRoot, lock, 'documents.content.read');
  const captureSource = selectedSource(
    lock,
    'project-capture-policy',
    'projects.records.read',
    projectDefinition
  );
  const projectWorkSource = selectedSource(
    lock,
    'project-work-policy',
    'projects.records.read',
    projectDefinition
  );
  const taskWorkSource = selectedSource(
    lock,
    'task-work-policy',
    'tasks.records.read',
    taskDefinition
  );
  const templateSource = selectedSource(
    lock,
    'project-page-template',
    'documents.content.read',
    projectDefinition
  );
  return {
    $contract: 'soter://contracts/operation-plan/v2',
    contractVersion: '2.0.0',
    id: planIdFor(workId),
    runId,
    createdAt,
    mode: 'sequential',
    failurePolicy: 'stop',
    reason: 'Acquire exact portable Project and Task policies, exact configured template, selected Project, every related Task, and the exact current page without any write authority.',
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
        id: CAPTURE_POLICY_STEP,
        capability: 'projects.records.read',
        authority: projectDefinition,
        providerImplementation: projectProvider,
        input: structuredClone(captureSource.input),
        inputBindings: [],
        reason: 'Read the exact configured Project capture policy selection.'
      },
      {
        id: PROJECT_WORK_POLICY_STEP,
        capability: 'projects.records.read',
        authority: projectDefinition,
        providerImplementation: projectProvider,
        input: structuredClone(projectWorkSource.input),
        inputBindings: [],
        reason: 'Read the exact configured Project work policy selection.'
      },
      {
        id: TASK_WORK_POLICY_STEP,
        capability: 'tasks.records.read',
        authority: taskDefinition,
        providerImplementation: taskProvider,
        input: structuredClone(taskWorkSource.input),
        inputBindings: [],
        reason: 'Read the exact configured Task work policy selection.'
      },
      {
        id: TEMPLATE_STEP,
        capability: 'documents.content.read',
        authority: projectDefinition,
        providerImplementation: documentProvider,
        input: structuredClone(templateSource.input),
        inputBindings: [],
        reason: 'Read one exact configured Project template definition body.'
      },
      {
        id: PROJECT_STEP,
        capability: 'projects.records.read',
        authority: projectInstance,
        providerImplementation: projectProvider,
        input: { recordTypes: ['project'], ids: [prepared.input.project], limit: 2 },
        inputBindings: [],
        reason: 'Read the exact selected Project and its explicit Task relationships.'
      },
      {
        id: TASKS_STEP,
        capability: 'tasks.records.read',
        authority: taskInstance,
        providerImplementation: taskProvider,
        input: { recordTypes: ['task'], limit: 100 },
        inputBindings: [{
          id: 'binding.project-page-review-task-uris',
          sourceStepId: PROJECT_STEP,
          sourcePath: ['records', '*', 'fields', 'taskUris'],
          targetPath: ['ids'],
          transform: 'unique-string-list',
          onEmpty: 'skip-step'
        }],
        reason: 'Read every and only the Tasks related by the selected Project.'
      },
      {
        id: DOCUMENT_STEP,
        capability: 'documents.content.read',
        authority: projectInstance,
        providerImplementation: documentProvider,
        input: {},
        inputBindings: [
          {
            id: 'binding.project-page-review-document-uri',
            sourceStepId: PROJECT_STEP,
            sourcePath: ['records', '*', 'id'],
            targetPath: ['uri'],
            transform: 'exact-string',
            onEmpty: 'fail-plan'
          },
          {
            id: 'binding.project-page-review-document-title',
            sourceStepId: PROJECT_STEP,
            sourcePath: ['records', '*', 'fields', 'name'],
            targetPath: ['expectedTitle'],
            transform: 'exact-string',
            onEmpty: 'fail-plan'
          }
        ],
        reason: 'Read the exact current Project page under its exact normalized title.'
      }
    ]
  };
}

export function assertProjectPageReviewConnectedPlan(plan) {
  const workId = workIdFromPlan(plan?.id);
  const expectedIds = [
    CAPTURE_POLICY_STEP,
    PROJECT_WORK_POLICY_STEP,
    TASK_WORK_POLICY_STEP,
    TEMPLATE_STEP,
    PROJECT_STEP,
    TASKS_STEP,
    DOCUMENT_STEP
  ];
  const steps = plan?.steps || [];
  if (plan.$contract !== 'soter://contracts/operation-plan/v2'
    || plan.contractVersion !== '2.0.0'
    || plan.mode !== 'sequential'
    || plan.failurePolicy !== 'stop'
    || !sameJson(steps.map((step) => step.id), expectedIds)
    || !sameJson(steps.map((step) => step.capability), [
      'projects.records.read',
      'projects.records.read',
      'tasks.records.read',
      'documents.content.read',
      'projects.records.read',
      'tasks.records.read',
      'documents.content.read'
    ])
    || !sameJson(steps[5].input, { recordTypes: ['task'], limit: 100 })
    || !sameJson(steps[5].inputBindings, [{
      id: 'binding.project-page-review-task-uris',
      sourceStepId: PROJECT_STEP,
      sourcePath: ['records', '*', 'fields', 'taskUris'],
      targetPath: ['ids'],
      transform: 'unique-string-list',
      onEmpty: 'skip-step'
    }])
    || !sameJson(steps[6].input, {})
    || !sameJson(steps[6].inputBindings, [
      {
        id: 'binding.project-page-review-document-uri',
        sourceStepId: PROJECT_STEP,
        sourcePath: ['records', '*', 'id'],
        targetPath: ['uri'],
        transform: 'exact-string',
        onEmpty: 'fail-plan'
      },
      {
        id: 'binding.project-page-review-document-title',
        sourceStepId: PROJECT_STEP,
        sourcePath: ['records', '*', 'fields', 'name'],
        targetPath: ['expectedTitle'],
        transform: 'exact-string',
        onEmpty: 'fail-plan'
      }
    ])
    || steps.some((step, index) => {
      return index < 5 && step.inputBindings.length !== 0;
    })) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_PLAN_INVALID',
      'Connected Project-page plan does not preserve its exact read-only source order and bindings.'
    );
  }
  return {
    workId,
    snapshotId: snapshotIdFor(workId),
    capturePolicy: steps[0],
    projectWorkPolicy: steps[1],
    taskWorkPolicy: steps[2],
    template: steps[3],
    project: steps[4],
    tasks: steps[5],
    document: steps[6]
  };
}

export async function prepareProjectPageReviewConnectedAcquisition({
  root,
  workId,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactProjectPageReviewPreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  const createdAt = at || new Date().toISOString();
  const plan = createProjectPageReviewConnectedPlan({
    root: resolvedRoot,
    lock: prepared.lock,
    runId: prepared.run.id,
    workId,
    createdAt,
    expectedHost
  });
  try {
    return await prepareDurableOperationPlanExecution({
      root: resolvedRoot,
      lockPath: prepared.lockPath,
      runPath: prepared.runPath,
      plan,
      at: createdAt,
      expectedHost,
      configurationBasis: 'private-active'
    });
  } catch (error) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_PLAN_INVALID',
      'Connected Project-page plan could not enter the durable host-tool boundary.',
      error
    );
  }
}

export function finalizeProjectPageReviewConnectedAcquisition({
  root,
  checkpointId,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  let execution;
  try {
    execution = getExactDurableHostExecution({
      root: resolvedRoot,
      checkpointId,
      expectedHost
    });
  } catch (error) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_INCOMPLETE',
      'Connected Project-page durable checkpoint is unavailable or invalid.',
      error
    );
  }
  const checkpoint = execution.checkpoint;
  if (checkpoint.kind !== 'operation-plan' || checkpoint.state !== 'completed') {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_INCOMPLETE',
      'Connected Project-page review can finalize only after complete acquisition.'
    );
  }
  const shape = assertProjectPageReviewConnectedPlan(checkpoint.plan);
  const prepared = loadExactProjectPageReviewPreparedInput({
    root: resolvedRoot,
    workId: shape.workId,
    expectedHost
  });
  if (checkpoint.configurationLock.path !== prepared.lockPath
    || checkpoint.configurationLock.fingerprint !== fingerprintLock(prepared.lock)
    || checkpoint.graphFingerprint !== prepared.lock.graphFingerprint
    || checkpoint.plan.runId !== prepared.run.id
    || execution.run.id !== prepared.run.id) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_STALE',
      'Connected Project-page acquisition no longer matches its exact lock and graph.'
    );
  }
  assertSelectedAutomation(prepared.lock, execution.run);
  const expectedPlan = createProjectPageReviewConnectedPlan({
    root: resolvedRoot,
    lock: prepared.lock,
    runId: checkpoint.plan.runId,
    workId: shape.workId,
    createdAt: checkpoint.plan.createdAt,
    expectedHost
  });
  if (!sameJson(expectedPlan, checkpoint.plan)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_STALE',
      'Connected Project-page acquisition drifted from its exact prepared-input basis.'
    );
  }
  const capture = completedStep(checkpoint, CAPTURE_POLICY_STEP);
  const projectWork = completedStep(checkpoint, PROJECT_WORK_POLICY_STEP);
  const taskWork = completedStep(checkpoint, TASK_WORK_POLICY_STEP);
  const template = completedStep(checkpoint, TEMPLATE_STEP);
  const projectStep = completedStep(checkpoint, PROJECT_STEP);
  const captureDefinition = loadProjectCapturePolicyDefinition(resolvedRoot);
  const projectWorkDefinition = loadProjectWorkPolicyDefinition(resolvedRoot);
  const taskWorkDefinition = loadTaskWorkPolicyDefinition(resolvedRoot);
  assertProjectCapturePolicySelection(
    capture.output,
    captureDefinition
  );
  assertProjectWorkPolicySelection(
    projectWork.output,
    projectWorkDefinition
  );
  assertTaskWorkPolicySelection(
    taskWork.output,
    taskWorkDefinition
  );
  if (template.output.document?.uri !== shape.template.input.uri
    || template.output.document?.title !== shape.template.input.expectedTitle
    || template.output.document?.bodyFingerprint
      !== fingerprintJson(template.output.document?.body)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_OUTPUT_INVALID',
      'Connected Project-page template output does not match its exact source.'
    );
  }
  const project = exactRequestedContextRecord(projectStep.output, {
    recordType: 'project',
    requestedId: shape.project.input.ids[0]
  });
  const taskIds = exactTaskUris(project);
  const taskCoverage = terminalTasksStep(checkpoint, taskIds);
  const tasks = taskCoverage.step;
  const document = completedStep(checkpoint, DOCUMENT_STEP);
  if (document.output.document?.uri !== project.id
    || document.output.document?.title !== project.fields.name
    || document.output.document?.bodyFingerprint
      !== fingerprintJson(document.output.document?.body)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_OUTPUT_INVALID',
      'Connected Project-page current document is not exact.'
    );
  }
  const at = checkpoint.updatedAt;
  const entries = [
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-page-review.project-capture-policy',
      subject: 'projects.records',
      role: 'definition',
      step: capture,
      at
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-page-review.project-work-policy',
      subject: 'projects.records',
      role: 'definition',
      step: projectWork,
      at
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-page-review.task-work-policy',
      subject: 'tasks.records',
      role: 'definition',
      step: taskWork,
      at
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-page-review.template',
      subject: 'projects.records',
      role: 'definition',
      step: template,
      at
    }),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-page-review.project',
      subject: 'projects.records',
      role: 'instance',
      step: projectStep,
      at
    }),
    ...(tasks ? [snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-page-review.tasks',
      subject: 'tasks.records',
      role: 'instance',
      step: tasks,
      at
    })] : []),
    snapshotEntry({
      root: resolvedRoot,
      id: 'context.project-page-review.document',
      subject: 'projects.records',
      role: 'instance',
      step: document,
      at
    })
  ];
  const completed = [capture, projectWork, taskWork, template, projectStep, tasks, document]
    .filter(Boolean);
  const contextUpdates = [...new Set(entries.map((entry) => entry.authority))].map((authority) => {
    const values = entries.filter((entry) => entry.authority === authority);
    const freshness = values.some((entry) => entry.freshness === 'stale') ? 'stale'
      : values.some((entry) => entry.freshness === 'unknown') ? 'unknown'
        : 'passed';
    return {
      authority,
      status: freshness === 'stale' ? 'stale' : 'loaded',
      provenance: 'connected-project-page-review:set:' + fingerprintJson(values.map((entry) => ({
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
    createdAt: at,
    configurationLockFingerprint: checkpoint.configurationLock.fingerprint,
    graphFingerprint: checkpoint.graphFingerprint,
    containment: 'connected',
    entries,
    effectIds: completed.map((step) => effectId(step.call)),
    privacy: {
      scope: 'private',
      redactions: [
        'Project and Task identifiers, page bodies, names, titles, relationships, provider responses, configuration targets, and operator focus remain private local state.',
        'Selected-work review projects only semantic labels, Task titles, counts, and fingerprints; raw URLs and raw page bodies remain excluded.',
        'Acquisition creates no proposal, approval, continuation request, provider write, retry authority, or canonical mutation.'
      ]
    }
  };
  return commitDurableContextSnapshot({
    root: resolvedRoot,
    checkpointId,
    snapshot,
    contextUpdates,
    checkpointDetails: taskCoverage.unavailableCount
      ? 'Exact Project-page sources were acquired and committed privately with incomplete related-Task coverage; review remains attention-required, read-only, and no-authority.'
      : 'Exact Project-page sources were acquired and committed privately with complete related-Task coverage; review remains read-only and no-authority.',
    expectedHost
  });
}

function exactEntry(snapshot, id) {
  const matches = snapshot.entries.filter((entry) => entry.id === id);
  if (matches.length !== 1
    || matches[0].valueFingerprint !== fingerprintJson(matches[0].value)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_SNAPSHOT_INVALID',
      'Connected Project-page snapshot entry ' + id + ' is missing or invalid.'
    );
  }
  return matches[0];
}

function exactConnectedBasis({ root, workId, expectedHost }) {
  const resolvedRoot = path.resolve(root);
  const prepared = loadExactProjectPageReviewPreparedInput({
    root: resolvedRoot,
    workId,
    expectedHost
  });
  let state;
  try {
    state = getExactDurableContextSnapshot({
      root: resolvedRoot,
      lockPath: prepared.lockPath,
      snapshotId: snapshotIdFor(workId),
      expectedHost
    });
  } catch (error) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_SNAPSHOT_INVALID',
      'Connected Project-page private snapshot is unavailable or invalid.',
      error
    );
  }
  const snapshot = state.snapshot;
  if (snapshot.runId !== prepared.run.id
    || snapshot.configurationLockFingerprint !== fingerprintLock(prepared.lock)
    || snapshot.graphFingerprint !== prepared.lock.graphFingerprint
    || state.run.id !== prepared.run.id) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_STALE',
      'Connected Project-page private snapshot no longer matches its prepared work and lock.'
    );
  }
  const requiredPrefix = [
    'context.project-page-review.project-capture-policy',
    'context.project-page-review.project-work-policy',
    'context.project-page-review.task-work-policy',
    'context.project-page-review.template',
    'context.project-page-review.project'
  ];
  const projectEntry = exactEntry(snapshot, requiredPrefix[4]);
  const project = exactRequestedContextRecord(projectEntry.value, {
    recordType: 'project',
    requestedId: prepared.input.project
  });
  const taskIds = exactTaskUris(project);
  const expectedIds = [
    ...requiredPrefix,
    ...(taskIds.length ? ['context.project-page-review.tasks'] : []),
    'context.project-page-review.document'
  ];
  if (!sameJson(snapshot.entries.map((entry) => entry.id), expectedIds)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_SNAPSHOT_INVALID',
      'Connected Project-page snapshot does not contain every exact source in order.'
    );
  }
  const capture = exactEntry(snapshot, expectedIds[0]);
  const projectWork = exactEntry(snapshot, expectedIds[1]);
  const taskWork = exactEntry(snapshot, expectedIds[2]);
  const template = exactEntry(snapshot, expectedIds[3]);
  const tasksEntry = taskIds.length
    ? exactEntry(snapshot, 'context.project-page-review.tasks')
    : null;
  const documentEntry = exactEntry(snapshot, 'context.project-page-review.document');
  const captureDefinition = loadProjectCapturePolicyDefinition(resolvedRoot);
  const projectWorkDefinition = loadProjectWorkPolicyDefinition(resolvedRoot);
  const taskWorkDefinition = loadTaskWorkPolicyDefinition(resolvedRoot);
  assertProjectCapturePolicySelection(
    capture.value,
    captureDefinition
  );
  assertProjectWorkPolicySelection(
    projectWork.value,
    projectWorkDefinition
  );
  assertTaskWorkPolicySelection(
    taskWork.value,
    taskWorkDefinition
  );
  const tasks = tasksEntry?.value.records || [];
  const expectedTaskIds = new Set(taskIds);
  if (tasks.some((record) => record.type !== 'task')
    || new Set(tasks.map((record) => record.id)).size !== tasks.length
    || tasks.some((record) => !expectedTaskIds.has(record.id))) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_SNAPSHOT_INVALID',
      'Connected Project-page snapshot Tasks are duplicated, substituted, or outside the exact Project relations.'
    );
  }
  const analysis = analyzeProjectPageReview({
    project,
    tasks,
    document: documentEntry.value.document,
    templateDocument: template.value.document,
    settings: prepared.settings,
    policies: {
      projectCapture: projectCapturePolicyFields(captureDefinition),
      projectWork: projectWorkPolicyFields(projectWorkDefinition),
      taskWork: taskWorkPolicyFields(taskWorkDefinition)
    },
    taskCoverageMode: 'allow-incomplete-no-authority'
  });
  return {
    root: resolvedRoot,
    prepared,
    snapshot,
    analysis
  };
}

function allReasonCodes(analysis) {
  return [...new Set([
    ...analysis.project.reasonCodes,
    ...analysis.tasks.flatMap((task) => task.reasonCodes)
  ])].sort(compareCodepoint);
}

function findings(analysis) {
  const value = {
    state: analysis.state,
    reasonCodes: allReasonCodes(analysis),
    counts: structuredClone(analysis.counts),
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  value.fingerprint = fingerprintJson({
    state: value.state,
    reasonCodes: value.reasonCodes,
    counts: value.counts
  });
  return value;
}

function sanitizedTaskCoverage(analysis) {
  const coverage = analysis.taskCoverage;
  return withSelfFingerprint({
    state: coverage.state,
    reasonCode: coverage.reasonCode,
    expectedCount: coverage.expectedCount,
    observedCount: coverage.observedCount,
    unavailableCount: coverage.unavailableCount,
    expectedIdentitySetFingerprint: coverage.expectedIdentitySetFingerprint,
    observedIdentitySetFingerprint: coverage.observedIdentitySetFingerprint,
    unavailableIdentitySetFingerprint: coverage.unavailableIdentitySetFingerprint
  });
}

function privateTaskCoverage(analysis) {
  const coverage = analysis.taskCoverage;
  return withSelfFingerprint({
    state: coverage.state,
    reasonCode: coverage.reasonCode,
    expectedCount: coverage.expectedCount,
    observedCount: coverage.observedCount,
    unavailableCount: coverage.unavailableCount,
    expectedIdentitySetFingerprint: coverage.expectedIdentitySetFingerprint,
    observedIdentitySetFingerprint: coverage.observedIdentitySetFingerprint,
    unavailableIdentitySetFingerprint: coverage.unavailableIdentitySetFingerprint,
    unavailableIdentityFingerprints:
      structuredClone(coverage.unavailableIdentityFingerprints)
  });
}

function identityFingerprints(values) {
  return (Array.isArray(values) ? values : []).map((value) => fingerprintJson(value));
}

function privateTask(review) {
  const fields = review.task.fields || {};
  return withSelfFingerprint({
    identityFingerprint: fingerprintJson(review.task.id),
    title: fields.title,
    status: fields.status || null,
    context: fields.context || null,
    nextActionOn: fields.nextActionOn || null,
    assigneeIdentityFingerprints: identityFingerprints(fields.assigneeIds),
    projectIdentityFingerprints: identityFingerprints(fields.projectUris),
    reasonCodes: structuredClone(review.reasonCodes)
  });
}

export function buildProjectPageReviewConnectedViews({
  root,
  prepared,
  snapshot,
  analysis
}) {
  const exactFindings = findings(analysis);
  const exactSanitizedTaskCoverage = sanitizedTaskCoverage(analysis);
  const exactPrivateTaskCoverage = privateTaskCoverage(analysis);
  const inspection = withSelfFingerprint({
    $contract: 'soter://contracts/project-page-review-connected-inspection/v1',
    contractVersion: '1.0.0',
    work: {
      id: prepared.work.id,
      fingerprint: prepared.work.fingerprint,
      privateInputFingerprint: prepared.privateInputFingerprint
    },
    snapshot: {
      id: snapshot.id,
      fingerprint: fingerprintJson(snapshot)
    },
    configuration: {
      lockFingerprint: fingerprintLock(prepared.lock),
      graphFingerprint: prepared.lock.graphFingerprint,
      host: prepared.lock.host.id
    },
    standard: {
      evaluatedPolicySemanticsFingerprint: analysis.policy.fingerprint,
      templateBodyFingerprint: analysis.templateDocument.bodyFingerprint,
      templateOutlineFingerprint: analysis.outline.templateFingerprint,
      pageOutlineFingerprint: analysis.outline.pageFingerprint,
      templateStructureFingerprint: analysis.structure.template.fingerprint,
      pageStructureFingerprint: analysis.structure.page.fingerprint
    },
    taskCoverage: exactSanitizedTaskCoverage,
    findings: exactFindings,
    authority: {
      state: 'none',
      reasonCode: 'PROJECT_PAGE_CONNECTED_REVIEW_READ_ONLY',
      approvalIncluded: false,
      continuationIncluded: false,
      providerWriteIncluded: false,
      retryAuthorityIncluded: false
    },
    privacy: {
      privateValuesIncluded: false,
      projectReferencesIncluded: false,
      taskReferencesIncluded: false,
      unavailableTaskIdentityFingerprintsIncluded: false,
      pageBodiesIncluded: false,
      taskTitlesIncluded: false,
      rawProviderResponsesIncluded: false,
      configurationTargetsIncluded: false,
      workspaceInspectionIncluded: false
    }
  });
  validateClosed(
    root,
    inspection,
    INSPECTION_SCHEMA,
    'PROJECT_PAGE_CONNECTED_INSPECTION_MALFORMED',
    'Connected Project-page sanitized inspection'
  );
  if (inspection.fingerprint !== selfFingerprint(inspection)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_INSPECTION_TAMPERED',
      'Connected Project-page sanitized inspection fingerprint is invalid.'
    );
  }
  const projectFields = analysis.project.record.fields || {};
  const project = withSelfFingerprint({
    identityFingerprint: fingerprintJson(analysis.project.record.id),
    name: projectFields.name,
    projectType: projectFields.projectType || null,
    status: projectFields.status || null,
    organizationIdentityFingerprints: identityFingerprints(projectFields.organizationUris),
    bodyFingerprint: analysis.document.bodyFingerprint,
    templateBodyFingerprint: analysis.templateDocument.bodyFingerprint,
    templateOutline: structuredClone(analysis.outline.template),
    pageOutline: structuredClone(analysis.outline.page),
    missingOutlineEntries: structuredClone(analysis.outline.missing),
    extraOutlineEntries: structuredClone(analysis.outline.extra),
    templateStructuralCounts: structuredClone(analysis.structure.template.counts),
    pageStructuralCounts: structuredClone(analysis.structure.page.counts),
    reasonCodes: structuredClone(analysis.project.reasonCodes)
  });
  const review = withSelfFingerprint({
    $contract: 'soter://contracts/project-page-review-connected-review/v1',
    contractVersion: '1.0.0',
    createdAt: snapshot.createdAt,
    work: {
      id: prepared.work.id,
      fingerprint: prepared.work.fingerprint,
      checkpointFingerprint: prepared.work.checkpoint.fingerprint,
      privateInputFingerprint: prepared.privateInputFingerprint
    },
    snapshot: {
      id: snapshot.id,
      fingerprint: fingerprintJson(snapshot),
      runId: snapshot.runId
    },
    configuration: {
      name: prepared.work.configuration.name,
      lockFingerprint: fingerprintLock(prepared.lock),
      graphFingerprint: prepared.lock.graphFingerprint,
      host: prepared.lock.host.id
    },
    project,
    tasks: analysis.tasks.map(privateTask),
    taskCoverage: exactPrivateTaskCoverage,
    findings: exactFindings,
    authority: {
      state: 'none',
      reasonCode: 'PROJECT_PAGE_CONNECTED_REVIEW_SELECTED_WORK_ONLY',
      approvalIncluded: false,
      continuationIncluded: false,
      providerWriteIncluded: false,
      retryAuthorityIncluded: false
    },
    privacy: {
      scope: 'private-local-selected-work',
      projection: 'explicit-selected-work-only',
      semanticLabelsIncluded: true,
      taskTitlesIncluded: true,
      unavailableTaskIdentityFingerprintsIncluded: true,
      rawUrlsIncluded: false,
      rawPageBodiesIncluded: false,
      rawProviderResponsesIncluded: false,
      configurationTargetsIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsIncluded: false
    }
  });
  validateClosed(
    root,
    review,
    REVIEW_SCHEMA,
    'PROJECT_PAGE_CONNECTED_REVIEW_MALFORMED',
    'Connected Project-page private selected-work review'
  );
  if (review.fingerprint !== selfFingerprint(review)) {
    throw connectedError(
      'PROJECT_PAGE_CONNECTED_REVIEW_TAMPERED',
      'Connected Project-page private review fingerprint is invalid.'
    );
  }
  return { inspection, review };
}

export function inspectProjectPageReviewConnected({
  root,
  workId,
  expectedHost
}) {
  const exact = exactConnectedBasis({
    root,
    workId: safeWorkId(workId),
    expectedHost
  });
  return buildProjectPageReviewConnectedViews(exact).inspection;
}

export function inspectProjectPageReviewConnectedPrivate({
  root,
  workId,
  expectedHost
}) {
  const exact = exactConnectedBasis({
    root,
    workId: safeWorkId(workId),
    expectedHost
  });
  return buildProjectPageReviewConnectedViews(exact).review;
}
