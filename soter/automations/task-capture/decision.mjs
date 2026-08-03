import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import { exactRequestedContextRecord } from '../../core/context-records.mjs';
import {
  commitDurableAutomationDecision,
  getExactDurableAutomationDecision,
  getExactDurableContextSnapshot
} from '../../core/service.mjs';
import { inspectContextSnapshotCurrentness } from '../../core/automation-proposals.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  hasAutomationDecisionState,
  readAutomationDecisionState
} from '../../core/runtime-state.mjs';
import {
  loadExactTaskCapturePreparedInput,
  taskCapturePreparedWorkIdFromSnapshot
} from './context.mjs';
import {
  assertTaskWorkPolicySelection,
  loadTaskWorkPolicyDefinition,
  taskWorkPolicyFields
} from '../../contexts/tasks/task-work-policy.mjs';
import { evaluateTaskCaptureSchema } from './schema.mjs';

const AUTOMATION_ID = 'automation.task-capture';
const DECISION_TYPE = 'task-capture.grounded-create';
const ZERO_FINGERPRINT = 'sha256:' + '0'.repeat(64);

function validate(root, value, schemaPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw new Error(
      label + ' does not satisfy its contract: '
        + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

function decisionFingerprint(decision) {
  const value = structuredClone(decision);
  delete value.decisionFingerprint;
  return fingerprintJson(value);
}

function selectedAutomation(lock) {
  const matches = lock.packs.filter((pack) => {
    return pack.id === AUTOMATION_ID && pack.layer === 'automation';
  });
  if (matches.length !== 1) {
    throw new Error('Task Capture decision requires one exact selected Automation pack.');
  }
  return matches[0];
}

function assertProducer(producer) {
  if (!producer
    || !['host', 'user', 'fixture'].includes(producer.kind)
    || typeof producer.id !== 'string'
    || !producer.id.trim()
    || (producer.kind === 'host'
      ? (typeof producer.host !== 'string' || !producer.host)
      : producer.host !== null)) {
    throw new Error('Task Capture decision producer must have an exact kind, identity, and host binding.');
  }
  return { ...structuredClone(producer), id: producer.id.trim() };
}

function exactEntry(root, snapshot, id, expected, at) {
  const matches = snapshot.entries.filter((entry) => entry.id === id);
  if (matches.length !== 1) {
    throw new Error('Task Capture decision requires exactly one Context entry ' + id + '.');
  }
  const entry = matches[0];
  const capability = readJson(path.join(
    root,
    'soter',
    'capabilities',
    entry.capability + '.json'
  ));
  const maximumAgeSeconds = capability.freshness?.maxAgeSeconds;
  const observedAt = Date.parse(entry.observedAt);
  const currentAt = Date.parse(at);
  const ageSeconds = (currentAt - observedAt) / 1000;
  if (entry.subject !== expected.subject
    || entry.role !== expected.role
    || entry.capability !== expected.capability
    || entry.freshness !== 'passed'
    || !Number.isInteger(maximumAgeSeconds)
    || !Number.isFinite(observedAt)
    || !Number.isFinite(currentAt)
    || ageSeconds < 0
    || ageSeconds > maximumAgeSeconds
    || entry.valueFingerprint !== fingerprintJson(entry.value)) {
    throw new Error('Task Capture Context entry ' + id + ' has stale or incorrect bindings.');
  }
  return entry;
}

function exactRecords(entry, type) {
  const records = entry.value?.records;
  if (!Array.isArray(records)
    || records.some((record) => record?.type !== type)
    || new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error('Task Capture Context entry ' + entry.id + ' has invalid typed records.');
  }
  return records;
}

function assertAcquisitionRun(run, snapshot, workId) {
  const suffix = workId.slice('work.task-capture.'.length);
  const planId = 'plan.task-capture.connected-acquisition.' + suffix;
  const planEntries = run.checkpoints.filter((checkpoint) => {
    return checkpoint.kind === 'operation-plan' && checkpoint.planId === planId;
  });
  const assemblyEntries = run.checkpoints.filter((checkpoint) => {
    return checkpoint.kind === 'context-assembly'
      && checkpoint.id === 'context-assembly.' + snapshot.id;
  });
  if (planEntries.length !== 1
    || planEntries[0].state !== 'completed'
    || assemblyEntries.length !== 1
    || assemblyEntries[0].state !== 'passed'
    || assemblyEntries[0].planId !== planId
    || assemblyEntries[0].planFingerprint !== planEntries[0].planFingerprint
    || assemblyEntries[0].snapshotFingerprint !== fingerprintJson(snapshot)) {
    throw new Error(
      'Task Capture decision requires the exact completed acquisition plan and context-assembly binding.'
    );
  }
}

function exactContext({ root, lock, snapshot, run, at }) {
  if (snapshot.containment !== 'connected'
    || snapshot.configurationLockFingerprint !== fingerprintLock(lock)
    || snapshot.graphFingerprint !== lock.graphFingerprint
    || snapshot.runId !== run.id) {
    throw new Error('Task Capture decision Context does not match the exact connected run and graph.');
  }
  const workId = taskCapturePreparedWorkIdFromSnapshot(snapshot.id);
  const prepared = loadExactTaskCapturePreparedInput({
    root,
    workId,
    expectedHost: lock.host.id
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.run.id !== run.id) {
    throw new Error(
      'Task Capture decision prepared input does not match the exact connected lock and run.'
    );
  }
  assertAcquisitionRun(run, snapshot, workId);
  const expectsIdentity = prepared.input.assignee === 'self';
  const expectedIds = [
    'context.task-capture.policy-selection',
    'context.task-capture.schema',
    'context.task-capture.project',
    ...(expectsIdentity ? ['context.task-capture.identity'] : []),
    'context.task-capture.duplicates'
  ];
  if (fingerprintJson(snapshot.entries.map((entry) => entry.id)) !== fingerprintJson(expectedIds)) {
    throw new Error('Task Capture decision Context does not cover the exact acquisition sources.');
  }

  const definition = loadTaskWorkPolicyDefinition(root);
  const policyEntry = exactEntry(root, snapshot, 'context.task-capture.policy-selection', {
    subject: 'tasks.records',
    role: 'definition',
    capability: 'tasks.records.read'
  }, at);
  const policy = assertTaskWorkPolicySelection(policyEntry.value, definition);
  const schemaEntry = exactEntry(root, snapshot, 'context.task-capture.schema', {
    subject: 'tasks.records',
    role: 'instance',
    capability: 'tasks.schema.read'
  }, at);
  const schema = evaluateTaskCaptureSchema(schemaEntry.value, {
    status: policy.fields.defaultStatus,
    context: prepared.input.context
  });
  const projectEntry = exactEntry(root, snapshot, 'context.task-capture.project', {
    subject: 'projects.records',
    role: 'instance',
    capability: 'projects.records.read'
  }, at);
  const project = exactRequestedContextRecord(projectEntry.value, {
    recordType: 'project',
    requestedId: prepared.input.project
  });
  const identityEntry = expectsIdentity
    ? exactEntry(root, snapshot, 'context.task-capture.identity', {
      subject: 'notion.workspace',
      role: 'provider',
      capability: 'workspace.identity.read'
    }, at)
    : null;
  const identity = identityEntry?.value?.identity || null;
  if (expectsIdentity && (identity?.kind !== 'current-user'
    || typeof identity.providerPersonId !== 'string'
    || !identity.providerPersonId
    || identity.fingerprint !== fingerprintJson({
      kind: 'current-user',
      providerPersonId: identity.providerPersonId
    }))) {
    throw new Error('Task Capture decision requires one exact authenticated current-user identity.');
  }
  const duplicateEntry = exactEntry(root, snapshot, 'context.task-capture.duplicates', {
    subject: 'tasks.records',
    role: 'instance',
    capability: 'tasks.records.read'
  }, at);
  const duplicates = exactRecords(duplicateEntry, 'task');
  if (duplicates.length > definition.duplicateCandidateLimit) {
    throw new Error('Task Capture duplicate candidates exceed the governed Context bound.');
  }
  const fields = taskWorkPolicyFields(definition);
  if (!fields.allowedContexts.includes(prepared.input.context)
    || fields.projectRequired !== true
    || fields.createRequiresConfirmation !== true
    || fields.assigneePolicy !== 'current-user-or-unassigned') {
    throw new Error('Task Capture prepared input does not satisfy the governed Context vocabulary.');
  }
  return {
    workId,
    prepared,
    definition,
    policy,
    policyEntry,
    schema,
    schemaEntry,
    project,
    projectEntry,
    identity,
    identityEntry,
    duplicates,
    duplicateEntry
  };
}

function taskValue(context) {
  const input = context.prepared.input;
  const fields = {
    title: input.title,
    status: context.policy.fields.defaultStatus,
    context: input.context,
    projectUris: [context.project.id],
    ...(context.identity ? { assigneeIds: [context.identity.providerPersonId] } : {}),
    ...(input.nextActionOn ? { nextActionOn: input.nextActionOn } : {})
  };
  return {
    title: fields.title,
    status: fields.status,
    context: fields.context,
    projectUris: structuredClone(fields.projectUris),
    assigneeIds: structuredClone(fields.assigneeIds || []),
    nextActionOn: fields.nextActionOn || null,
    afterFingerprint: fingerprintJson({ recordType: 'task', fields })
  };
}

function issuesFor(task, duplicates, schemaIssues) {
  const issues = [...schemaIssues];
  if (task.context !== 'Project') {
    issues.push(
      'TASK_PROJECT_CONTEXT_REQUIRED: A task linked to the selected project must use Project context.'
    );
  }
  if (duplicates.length) {
    issues.push(
      'TASK_DUPLICATE_CANDIDATE_OBSERVED: Exact-title task candidates require operator review.'
    );
  }
  return issues;
}

function buildDecision({ root, lock, snapshot, run, id, createdAt, producer }) {
  const automation = selectedAutomation(lock);
  const context = exactContext({ root, lock, snapshot, run, at: createdAt });
  const task = taskValue(context);
  const issues = issuesFor(task, context.duplicates, context.schema.issues);
  const decision = {
    $contract: 'soter://contracts/automation-decision/v1',
    contractVersion: '1.0.0',
    id,
    automation: { id: AUTOMATION_ID, version: automation.version },
    runId: snapshot.runId,
    createdAt,
    configurationLockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint,
    context: {
      snapshotId: snapshot.id,
      snapshotFingerprint: fingerprintJson(snapshot)
    },
    producer: assertProducer(producer),
    state: issues.length ? 'needs-input' : 'ready',
    decisionType: DECISION_TYPE,
    payload: {
      preparedWork: {
        id: context.workId,
        fingerprint: context.prepared.work.fingerprint,
        reviewMaterialFingerprint: context.prepared.material.fingerprint,
        inputContractFingerprint: context.prepared.material.inputContractFingerprint
      },
      policy: {
        definitionId: context.definition.id,
        definitionFingerprint: fingerprintJson(context.definition),
        entryId: context.policyEntry.id,
        entryFingerprint: context.policyEntry.valueFingerprint,
        externalRecordId: context.policy.record.id,
        externalRecordFingerprint: fingerprintJson(context.policy.record)
      },
      schema: {
        entryId: context.schemaEntry.id,
        entryFingerprint: context.schemaEntry.valueFingerprint,
        schemaFingerprint: context.schema.schemaFingerprint,
        statusAvailable: context.schema.statusAvailable,
        contextAvailable: context.schema.contextAvailable
      },
      project: {
        entryId: context.projectEntry.id,
        entryFingerprint: context.projectEntry.valueFingerprint,
        recordId: context.project.id,
        recordFingerprint: fingerprintJson(context.project)
      },
      identity: context.identity ? {
        entryId: context.identityEntry.id,
        entryFingerprint: context.identityEntry.valueFingerprint,
        providerPersonId: context.identity.providerPersonId,
        identityFingerprint: context.identity.fingerprint
      } : null,
      duplicates: {
        entryId: context.duplicateEntry.id,
        entryFingerprint: context.duplicateEntry.valueFingerprint,
        candidates: context.duplicates.map((record) => ({
          recordId: record.id,
          recordFingerprint: fingerprintJson(record)
        }))
      },
      task,
      limitations: [
        'This private decision binds exact prepared input and connected read observations but grants no approval, continuation, provider call, write, or proof authority.',
        'A ready decision may produce a separate private review proposal; an exact batch, approval request, confirmation, one-time start consumption, checkpoint, and verification remain separate.'
      ]
    },
    issues,
    privacy: {
      scope: 'private',
      redactions: [
        'Task title, date, provider person identity, and exact desired fields remain in private local decision state and are excluded from workspace inspection and evidence.',
        'Provider credentials, secret references, raw native responses, and unrelated record values are excluded.'
      ]
    },
    decisionFingerprint: ZERO_FINGERPRINT
  };
  decision.decisionFingerprint = decisionFingerprint(decision);
  return decision;
}

export function createTaskCaptureDecision(args) {
  const resolvedRoot = path.resolve(args.root);
  const decision = buildDecision({ ...args, root: resolvedRoot });
  validate(
    resolvedRoot,
    decision,
    'soter/contracts/automation-decision.schema.json',
    'Automation decision'
  );
  validate(
    resolvedRoot,
    decision,
    'soter/automations/task-capture/decision.schema.json',
    'Task Capture decision'
  );
  return decision;
}

export function assertTaskCaptureDecision({ root, lock, snapshot, run, decision }) {
  const resolvedRoot = path.resolve(root);
  validate(
    resolvedRoot,
    decision,
    'soter/contracts/automation-decision.schema.json',
    'Automation decision'
  );
  validate(
    resolvedRoot,
    decision,
    'soter/automations/task-capture/decision.schema.json',
    'Task Capture decision'
  );
  const expected = buildDecision({
    root: resolvedRoot,
    lock,
    snapshot,
    run,
    id: decision.id,
    createdAt: decision.createdAt,
    producer: decision.producer
  });
  if (fingerprintJson(expected) !== fingerprintJson(decision)
    || decision.decisionFingerprint !== decisionFingerprint(decision)) {
    throw new Error(
      'Task Capture decision does not match the exact prepared input, connected Context, and deterministic outcome.'
    );
  }
  return true;
}

export function inspectTaskCaptureDecisionContext({
  root,
  lockPath,
  snapshotId,
  expectedHost,
  at = new Date().toISOString()
}) {
  const exact = getExactDurableContextSnapshot({
    root,
    lockPath,
    snapshotId,
    expectedHost
  });
  const preview = buildDecision({
    root: path.resolve(root),
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    id: 'decision.task-capture.preview',
    createdAt: exact.snapshot.createdAt,
    producer: { kind: 'fixture', id: 'task-capture-preview', host: null }
  });
  const currentness = inspectContextSnapshotCurrentness({
    root,
    snapshot: exact.snapshot,
    at
  });
  const issueCodes = preview.issues.map((issue) => issue.split(':')[0]);
  if (currentness.state !== 'current') issueCodes.unshift('TASK_CONTEXT_STALE');
  return {
    snapshot: {
      id: exact.snapshot.id,
      fingerprint: fingerprintJson(exact.snapshot),
      containment: exact.snapshot.containment
    },
    preparedWork: structuredClone(preview.payload.preparedWork),
    outcome: {
      state: currentness.state === 'current' ? preview.state : 'needs-input',
      issueCodes,
      duplicateCandidateCount: preview.payload.duplicates.candidates.length,
      projectFingerprint: preview.payload.project.recordFingerprint,
      taskAfterFingerprint: preview.payload.task.afterFingerprint
    },
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_DECISION_NOT_COMMITTED'
    }
  };
}

export function commitTaskCaptureDecision({
  root,
  lockPath,
  snapshotId,
  id,
  producer,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const exact = getExactDurableContextSnapshot({
    root: resolvedRoot,
    lockPath,
    snapshotId,
    expectedHost
  });
  const existing = hasAutomationDecisionState(resolvedRoot, id)
    ? readAutomationDecisionState(resolvedRoot, id).decision
    : null;
  const requestedAt = at || new Date().toISOString();
  if (existing && inspectContextSnapshotCurrentness({
    root: resolvedRoot,
    snapshot: exact.snapshot,
    at: requestedAt
  }).state !== 'current') {
    throw new Error(
      'Task Capture decision re-entry requires current exact Context observations.'
    );
  }
  const decision = createTaskCaptureDecision({
    root: resolvedRoot,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    id,
    createdAt: existing?.createdAt || requestedAt,
    producer
  });
  if (existing && fingerprintJson(existing) !== fingerprintJson(decision)) {
    throw new Error('Task Capture decision conflicts with existing durable state.');
  }
  assertTaskCaptureDecision({
    root: resolvedRoot,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    decision
  });
  return commitDurableAutomationDecision({
    root: resolvedRoot,
    lockPath,
    decision,
    expectedHost
  });
}

export function loadTaskCaptureDecision({ root, lockPath, decisionId, expectedHost }) {
  const exact = getExactDurableAutomationDecision({
    root,
    lockPath,
    decisionId,
    expectedHost
  });
  assertTaskCaptureDecision({
    root,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    decision: exact.decision
  });
  return exact;
}
