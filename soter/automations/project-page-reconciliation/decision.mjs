import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import { exactRequestedContextRecord } from '../../core/context-records.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  commitDurableAutomationDecision,
  getExactDurableAutomationDecision,
  getExactDurableContextSnapshot
} from '../../core/service.mjs';
import {
  hasAutomationDecisionState,
  readAutomationDecisionState
} from '../../core/runtime-state.mjs';
import {
  assertProjectCapturePolicySelection,
  loadProjectCapturePolicyDefinition,
  projectCapturePolicyFields
} from '../../contexts/projects/project-capture-policy.mjs';
import { assertProjectPageReconciliationSchema } from './schema.mjs';
import {
  loadExactProjectPageReconciliationPreparedInput,
  projectPageReconciliationPreparedWorkIdFromSnapshot
} from './context.mjs';
import { buildProjectPageReconciliationReview } from './prepare.mjs';

const AUTOMATION_ID = 'automation.project-page-reconciliation';
const DECISION_TYPE = 'project-page-reconciliation.grounded-change';
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

function sameJson(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
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
    throw new Error(
      'Project page reconciliation decision requires one exact selected Automation pack.'
    );
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
    throw new Error(
      'Project page reconciliation decision producer requires exact kind, identity, and host.'
    );
  }
  return { ...structuredClone(producer), id: producer.id.trim() };
}

function exactEntry(snapshot, id, expected) {
  const matches = snapshot.entries.filter((entry) => entry.id === id);
  if (matches.length !== 1) {
    throw new Error('Project page reconciliation requires one Context entry ' + id + '.');
  }
  const entry = matches[0];
  if (entry.subject !== expected.subject
    || entry.role !== expected.role
    || entry.capability !== expected.capability
    || entry.valueFingerprint !== fingerprintJson(entry.value)) {
    throw new Error(
      'Project page reconciliation Context entry ' + id + ' has stale bindings.'
    );
  }
  return entry;
}

function assertAcquisitionRun(run, snapshot, workId) {
  const suffix = workId.slice('work.project-page-reconciliation.'.length);
  const planId = 'plan.project-page-reconciliation.connected-acquisition.' + suffix;
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
      'Project page reconciliation decision requires its completed acquisition and assembly.'
    );
  }
}

function exactDecisionContext({ root, lock, snapshot, run }) {
  if (snapshot.containment !== 'connected'
    || snapshot.configurationLockFingerprint !== fingerprintLock(lock)
    || snapshot.graphFingerprint !== lock.graphFingerprint
    || snapshot.runId !== run.id) {
    throw new Error(
      'Project page reconciliation decision Context does not match its exact connected run.'
    );
  }
  const workId = projectPageReconciliationPreparedWorkIdFromSnapshot(snapshot.id);
  const prepared = loadExactProjectPageReconciliationPreparedInput({
    root,
    workId,
    expectedHost: lock.host.id
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.run.id !== run.id) {
    throw new Error(
      'Project page reconciliation prepared input does not match the connected Context.'
    );
  }
  assertAcquisitionRun(run, snapshot, workId);
  const expectedIds = [
    'context.project-page-reconciliation.policy',
    'context.project-page-reconciliation.schema',
    'context.project-page-reconciliation.project',
    'context.project-page-reconciliation.project-content'
  ];
  if (!sameJson(snapshot.entries.map((entry) => entry.id), expectedIds)) {
    throw new Error('Project page reconciliation Context does not cover its exact source set.');
  }

  const definition = loadProjectCapturePolicyDefinition(root);
  const policyEntry = exactEntry(snapshot, expectedIds[0], {
    subject: 'projects.records',
    role: 'definition',
    capability: 'projects.records.read'
  });
  const policy = assertProjectCapturePolicySelection(policyEntry.value, definition);
  const schemaEntry = exactEntry(snapshot, expectedIds[1], {
    subject: 'projects.records',
    role: 'instance',
    capability: 'projects.schema.read'
  });
  const schema = assertProjectPageReconciliationSchema(
    schemaEntry.value,
    projectCapturePolicyFields(definition)
  );
  const projectEntry = exactEntry(snapshot, expectedIds[2], {
    subject: 'projects.records',
    role: 'instance',
    capability: 'projects.records.read'
  });
  const project = exactRequestedContextRecord(projectEntry.value, {
    recordType: 'project',
    requestedId: prepared.input.project
  });
  const contentEntry = exactEntry(snapshot, expectedIds[3], {
    subject: 'projects.records',
    role: 'instance',
    capability: 'projects.records.read'
  });
  const content = exactRequestedContextRecord(contentEntry.value, {
    recordType: 'project',
    requestedId: prepared.input.project
  });
  if (typeof project.fields?.name !== 'string'
    || !project.fields.name
    || content.id !== project.id
    || !sameJson(project.fields, content.fields)
    || typeof content.body !== 'string'
    || !content.body.trim()) {
    throw new Error(
      'Project page reconciliation exact metadata and content observations disagree.'
    );
  }
  const review = buildProjectPageReconciliationReview({
    input: prepared.input,
    project,
    body: content.body,
    policy,
    schema: schema.schema,
    definition: readJson(path.join(
      root,
      'soter',
      'automations',
      'project-page-reconciliation',
      'derived-review.json'
    ))
  });
  const actions = review.preview.collections[0]?.rows.flatMap((row) => row.actions) || [];
  if (review.preview.proposedChanges.length < 1
    || review.preview.proposedChanges.length > 2
    || actions.length !== review.preview.proposedChanges.length
    || actions.some((action) => action.state !== 'proposed'
      || action.effect !== 'write'
      || typeof action.changeFingerprint !== 'string')) {
    throw new Error(
      'Project page reconciliation requires one non-empty exact supported change set.'
    );
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
    content,
    contentEntry,
    review,
    actions
  };
}

export function projectPageReconciliationDecisionReview({ root, lock, snapshot, run }) {
  return exactDecisionContext({ root: path.resolve(root), lock, snapshot, run }).review;
}

function buildDecision({ root, lock, snapshot, run, id, createdAt, producer }) {
  const automation = selectedAutomation(lock);
  const context = exactDecisionContext({ root, lock, snapshot, run });
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
    state: 'ready',
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
        schemaFingerprint: context.schema.schemaFingerprint
      },
      project: {
        metadataEntryId: context.projectEntry.id,
        metadataEntryFingerprint: context.projectEntry.valueFingerprint,
        contentEntryId: context.contentEntry.id,
        contentEntryFingerprint: context.contentEntry.valueFingerprint,
        recordId: context.project.id,
        recordFingerprint: fingerprintJson(context.content),
        versionFingerprint: fingerprintJson(context.project.version),
        fieldsFingerprint: fingerprintJson(context.project.fields),
        bodyFingerprint: fingerprintJson(context.content.body)
      },
      review: {
        previewFingerprint: context.review.preview.fingerprint,
        derivedReviewContentFingerprint: context.review.preview.privateReview.contentFingerprint,
        actionIds: context.actions.map((action) => action.id),
        changeFingerprints: context.actions.map((action) => action.changeFingerprint)
      },
      limitations: [
        'This private decision binds exact prepared input and connected observations but grants no approval, continuation, provider call, write, retry, or proof authority.',
        'Only projectType, status, and bounded exact one-match page-text replacements are supported; every unselected value is preserved.',
        'Combined property and body operations are sequential and non-atomic; ambiguous outcomes are never retried and require checkpoint-bound reconciliation.'
      ]
    },
    issues: [],
    privacy: {
      scope: 'private',
      redactions: [
        'Project identity, title, fields, version, page body, and exact replacement text remain private local decision state.',
        'Provider credentials, secret references, raw native responses, and unrelated values are excluded.'
      ]
    },
    decisionFingerprint: ZERO_FINGERPRINT
  };
  decision.decisionFingerprint = decisionFingerprint(decision);
  return decision;
}

export function createProjectPageReconciliationDecision(args) {
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
    'soter/automations/project-page-reconciliation/decision.schema.json',
    'Project page reconciliation decision'
  );
  return decision;
}

export function assertProjectPageReconciliationDecision({ root, lock, snapshot, run, decision }) {
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
    'soter/automations/project-page-reconciliation/decision.schema.json',
    'Project page reconciliation decision'
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
  if (!sameJson(expected, decision)
    || decision.decisionFingerprint !== decisionFingerprint(decision)) {
    throw new Error(
      'Project page reconciliation decision does not match exact deterministic Context.'
    );
  }
  return true;
}

export function inspectProjectPageReconciliationDecisionContext({
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
    id: 'decision.project-page-reconciliation.preview',
    createdAt: exact.snapshot.createdAt,
    producer: { kind: 'fixture', id: 'project-page-reconciliation-preview', host: null }
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
      actionIds: structuredClone(preview.payload.review.actionIds),
      previewFingerprint: preview.payload.review.previewFingerprint,
      projectFingerprint: preview.payload.project.recordFingerprint
    },
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_DECISION_NOT_COMMITTED'
    }
  };
}

export function commitProjectPageReconciliationDecision({
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
  const decision = createProjectPageReconciliationDecision({
    root: resolvedRoot,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    id,
    createdAt: existing?.createdAt || at || new Date().toISOString(),
    producer
  });
  if (existing && !sameJson(existing, decision)) {
    throw new Error('Project page reconciliation decision conflicts with durable state.');
  }
  return commitDurableAutomationDecision({
    root: resolvedRoot,
    lockPath,
    decision,
    expectedHost
  });
}

export function loadProjectPageReconciliationDecision({
  root,
  lockPath,
  decisionId,
  expectedHost
}) {
  const exact = getExactDurableAutomationDecision({
    root,
    lockPath,
    decisionId,
    expectedHost
  });
  assertProjectPageReconciliationDecision({
    root,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    decision: exact.decision
  });
  return exact;
}
