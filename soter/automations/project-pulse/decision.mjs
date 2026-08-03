import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import { exactRequestedContextRecord } from '../../core/context-records.mjs';
import {
  commitDurableAutomationDecision,
  getExactDurableAutomationDecision,
  getExactDurableContextSnapshot
} from '../../core/service.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  hasAutomationDecisionState,
  readAutomationDecisionState
} from '../../core/runtime-state.mjs';
import {
  loadExactProjectPulsePreparedInput,
  projectPulsePreparedWorkIdFromSnapshot
} from './context.mjs';
import { analyzeProjectPulseSnapshot } from './prepare.mjs';
import {
  assertProjectWorkPolicySelection,
  loadProjectWorkPolicyDefinition
} from '../../contexts/projects/project-work-policy.mjs';

const AUTOMATION_ID = 'automation.project-pulse';
const DECISION_TYPE = 'project-pulse.grounded-status';
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
    throw new Error('Project Pulse decision requires one exact selected Automation pack.');
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
    throw new Error('Project Pulse decision producer must have an exact kind, identity, and host binding.');
  }
  return { ...structuredClone(producer), id: producer.id.trim() };
}

function exactEntry(snapshot, id, expected) {
  const matches = snapshot.entries.filter((entry) => entry.id === id);
  if (matches.length !== 1) {
    throw new Error('Project Pulse decision requires exactly one Context entry ' + id + '.');
  }
  const entry = matches[0];
  if (entry.subject !== expected.subject
    || entry.role !== expected.role
    || entry.capability !== expected.capability
    || entry.valueFingerprint !== fingerprintJson(entry.value)) {
    throw new Error('Project Pulse Context entry ' + id + ' has stale or incorrect bindings.');
  }
  return entry;
}

function assertAcquisitionRun(run, snapshot, workId) {
  const suffix = workId.slice('work.project-pulse.'.length);
  const planId = 'plan.project-pulse.connected-acquisition.' + suffix;
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
      'Project Pulse decision requires the exact completed acquisition plan and context-assembly binding.'
    );
  }
}

function exactContext({ root, lock, snapshot, run }) {
  if (snapshot.containment !== 'connected'
    || snapshot.configurationLockFingerprint !== fingerprintLock(lock)
    || snapshot.graphFingerprint !== lock.graphFingerprint
    || snapshot.runId !== run.id) {
    throw new Error('Project Pulse decision Context does not match the exact connected run and graph.');
  }
  const workId = projectPulsePreparedWorkIdFromSnapshot(snapshot.id);
  const prepared = loadExactProjectPulsePreparedInput({
    root,
    workId,
    expectedHost: lock.host.id
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.run.id !== run.id) {
    throw new Error(
      'Project Pulse decision prepared input does not match the exact connected lock and run.'
    );
  }
  assertAcquisitionRun(run, snapshot, workId);
  const expectedIds = [
    'context.project-pulse.policy-selection',
    'context.project-pulse.project',
    'context.project-pulse.tasks',
    'context.project-pulse.document'
  ];
  if (fingerprintJson(snapshot.entries.map((entry) => entry.id)) !== fingerprintJson(expectedIds)) {
    throw new Error('Project Pulse decision Context does not cover the exact acquisition sources.');
  }
  const definition = loadProjectWorkPolicyDefinition(root);
  const policyEntry = exactEntry(snapshot, 'context.project-pulse.policy-selection', {
    subject: 'projects.records',
    role: 'definition',
    capability: 'projects.records.read'
  });
  const policy = assertProjectWorkPolicySelection(policyEntry.value, definition);
  const projectEntry = exactEntry(snapshot, 'context.project-pulse.project', {
    subject: 'projects.records',
    role: 'instance',
    capability: 'projects.records.read'
  });
  const tasksEntry = exactEntry(snapshot, 'context.project-pulse.tasks', {
    subject: 'tasks.records',
    role: 'instance',
    capability: 'tasks.records.read'
  });
  const documentEntry = exactEntry(snapshot, 'context.project-pulse.document', {
    subject: 'projects.records',
    role: 'instance',
    capability: 'documents.content.read'
  });
  exactRequestedContextRecord(projectEntry.value, {
    recordType: 'project',
    requestedId: prepared.input.project
  });
  const analysis = analyzeProjectPulseSnapshot({
    root,
    snapshot,
    input: prepared.input
  });
  return {
    workId,
    prepared,
    definition,
    policy,
    policyEntry,
    projectEntry,
    tasksEntry,
    documentEntry,
    analysis
  };
}

function buildDecision({ root, lock, snapshot, run, id, createdAt, producer }) {
  const automation = selectedAutomation(lock);
  const context = exactContext({ root, lock, snapshot, run });
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
    state: context.analysis.state,
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
      observations: {
        projectEntryFingerprint: context.projectEntry.valueFingerprint,
        tasksEntryFingerprint: context.tasksEntry.valueFingerprint,
        documentEntryFingerprint: context.documentEntry.valueFingerprint
      },
      analysis: structuredClone(context.analysis)
    },
    issues: structuredClone(context.analysis.issues),
    privacy: {
      scope: 'private',
      redactions: [
        'Project and task identities, project name, task titles, status date, summary, milestone lines, and exact desired changes remain in private local decision state.',
        'Provider credentials, secret references, raw native responses, and unrelated workspace values are excluded.',
        'This decision grants no approval, continuation, provider call, write, proof, or maturity authority.'
      ]
    },
    decisionFingerprint: ZERO_FINGERPRINT
  };
  decision.decisionFingerprint = decisionFingerprint(decision);
  return decision;
}

export function createProjectPulseDecision(args) {
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
    'soter/automations/project-pulse/decision.schema.json',
    'Project Pulse decision'
  );
  return decision;
}

export function assertProjectPulseDecision({ root, lock, snapshot, run, decision }) {
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
    'soter/automations/project-pulse/decision.schema.json',
    'Project Pulse decision'
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
      'Project Pulse decision does not match the exact prepared input, connected Context, and deterministic outcome.'
    );
  }
  return true;
}

export function inspectProjectPulseDecisionContext({
  root,
  lockPath,
  snapshotId,
  expectedHost
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
    id: 'decision.project-pulse.preview',
    createdAt: exact.snapshot.createdAt,
    producer: { kind: 'fixture', id: 'project-pulse-preview', host: null }
  });
  return {
    snapshot: {
      id: exact.snapshot.id,
      fingerprint: fingerprintJson(exact.snapshot),
      containment: exact.snapshot.containment
    },
    preparedWork: structuredClone(preview.payload.preparedWork),
    outcome: {
      state: preview.state,
      issueCodes: preview.issues.map((issue) => issue.split(':')[0]),
      projectFingerprint: preview.payload.analysis.project.fingerprint,
      taskCount: preview.payload.analysis.tasks.total,
      milestoneCount: preview.payload.analysis.milestones.length,
      health: preview.payload.analysis.health.state,
      statusAfterFingerprint: preview.payload.analysis.status.afterFingerprint,
      documentBeforeFingerprint: preview.payload.analysis.document.expectedBodyFingerprint,
      documentAfterFingerprint: preview.payload.analysis.document.afterBodyFingerprint,
      milestoneChangeCount: preview.payload.analysis.document.updates.length
    },
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_DECISION_NOT_COMMITTED'
    }
  };
}

export function commitProjectPulseDecision({
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
  const decision = createProjectPulseDecision({
    root: resolvedRoot,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    id,
    createdAt: existing?.createdAt || at || new Date().toISOString(),
    producer
  });
  if (existing && fingerprintJson(existing) !== fingerprintJson(decision)) {
    throw new Error('Project Pulse decision conflicts with existing durable state.');
  }
  assertProjectPulseDecision({
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

export function loadProjectPulseDecision({ root, lockPath, decisionId, expectedHost }) {
  const exact = getExactDurableAutomationDecision({
    root,
    lockPath,
    decisionId,
    expectedHost
  });
  assertProjectPulseDecision({
    root,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    decision: exact.decision
  });
  return exact;
}
