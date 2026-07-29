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
  loadExactProjectCapturePreparedInput,
  projectCapturePreparedWorkIdFromSnapshot
} from './context.mjs';
import {
  assertProjectCreationProfileSelection,
  assertProjectCapturePolicySelection,
  loadProjectCapturePolicyDefinition,
  projectCapturePolicyFields
} from '../../contexts/projects/project-capture-policy.mjs';
import { compileProjectCaptureValue } from './project.mjs';
import { assertProjectCaptureSchema } from './schema.mjs';

const AUTOMATION_ID = 'automation.project-capture';
const DECISION_TYPE = 'project-capture.grounded-candidate';
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
    throw new Error('Project Capture decision requires one exact selected Automation pack.');
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
    throw new Error('Project Capture decision producer must have an exact kind, identity, and host binding.');
  }
  return { ...structuredClone(producer), id: producer.id.trim() };
}

function exactEntry(snapshot, id, expected) {
  const matches = snapshot.entries.filter((entry) => entry.id === id);
  if (matches.length !== 1) {
    throw new Error('Project Capture decision requires exactly one Context entry ' + id + '.');
  }
  const entry = matches[0];
  if (entry.subject !== expected.subject
    || entry.role !== expected.role
    || entry.capability !== expected.capability
    || entry.valueFingerprint !== fingerprintJson(entry.value)) {
    throw new Error('Project Capture Context entry ' + id + ' has stale or incorrect bindings.');
  }
  return entry;
}

function exactRecords(entry, type) {
  const records = entry.value?.records;
  if (!Array.isArray(records)
    || records.some((record) => record?.type !== type)
    || new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error('Project Capture Context entry ' + entry.id + ' has invalid typed records.');
  }
  return records;
}

function assertAcquisitionRun(run, snapshot, workId) {
  const suffix = workId.slice('work.project-capture.'.length);
  const planId = 'plan.project-capture.connected-acquisition.' + suffix;
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
      'Project Capture decision requires the exact completed acquisition plan and context-assembly binding.'
    );
  }
}

function exactContext({ root, lock, snapshot, run }) {
  if (snapshot.containment !== 'connected'
    || snapshot.configurationLockFingerprint !== fingerprintLock(lock)
    || snapshot.graphFingerprint !== lock.graphFingerprint
    || snapshot.runId !== run.id) {
    throw new Error('Project Capture decision Context does not match the exact connected run and graph.');
  }
  const workId = projectCapturePreparedWorkIdFromSnapshot(snapshot.id);
  const prepared = loadExactProjectCapturePreparedInput({
    root,
    workId,
    expectedHost: lock.host.id
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.run.id !== run.id) {
    throw new Error(
      'Project Capture decision prepared input does not match the exact connected lock and run.'
    );
  }
  assertAcquisitionRun(run, snapshot, workId);
  const expectedIds = [
    'context.project-capture.policy-selection',
    'context.project-capture.profile-selection',
    'context.project-capture.organization',
    'context.project-capture.schema',
    'context.project-capture.duplicates'
  ];
  if (fingerprintJson(snapshot.entries.map((entry) => entry.id)) !== fingerprintJson(expectedIds)) {
    throw new Error('Project Capture decision Context does not cover the exact acquisition sources.');
  }

  const definition = loadProjectCapturePolicyDefinition(root);
  const policyEntry = exactEntry(snapshot, 'context.project-capture.policy-selection', {
    subject: 'projects.records',
    role: 'definition',
    capability: 'projects.records.read'
  });
  const policy = assertProjectCapturePolicySelection(policyEntry.value, definition);
  const profileEntry = exactEntry(snapshot, 'context.project-capture.profile-selection', {
    subject: 'projects.records',
    role: 'definition',
    capability: 'projects.records.read'
  });
  const creationProfile = assertProjectCreationProfileSelection(
    profileEntry.value,
    definition,
    prepared.input.creationProfile
  );
  const schemaEntry = exactEntry(snapshot, 'context.project-capture.schema', {
    subject: 'projects.records',
    role: 'instance',
    capability: 'projects.schema.read'
  });
  const schema = assertProjectCaptureSchema(
    schemaEntry.value,
    projectCapturePolicyFields(definition)
  );
  const organizationEntry = exactEntry(snapshot, 'context.project-capture.organization', {
    subject: 'crm.records',
    role: 'instance',
    capability: 'crm.records.read'
  });
  const organization = exactRequestedContextRecord(organizationEntry.value, {
    recordType: 'organization',
    requestedId: prepared.input.organization
  });
  const duplicateEntry = exactEntry(snapshot, 'context.project-capture.duplicates', {
    subject: 'projects.records',
    role: 'instance',
    capability: 'projects.records.read'
  });
  const duplicates = exactRecords(duplicateEntry, 'project');
  if (duplicates.length > definition.duplicateCandidateLimit) {
    throw new Error('Project Capture duplicate candidates exceed the governed Context bound.');
  }
  const fields = projectCapturePolicyFields(definition);
  if (!fields.allowedTypes.includes(prepared.input.projectType)
    || fields.projectTypePolicy !== 'optional-when-unclear'
    || fields.organizationPolicy !== 'client-facing-required-internal-optional'
    || fields.createRequiresConfirmation !== true
    || fields.managerPolicy !== 'unavailable'
    || fields.clientContactPolicy !== 'unavailable'
    || fields.bodyFormat !== 'portable-project-body/v1'
    || fields.milestoneSyntaxVersion !== 'project-milestone-line/v1'
    || fields.workItemSyntaxVersion !== 'dated-owner-action-line/v1') {
    throw new Error('Project Capture prepared input does not satisfy the governed Context vocabulary.');
  }
  return {
    workId,
    prepared,
    definition,
    policy,
    policyEntry,
    creationProfile,
    profileEntry,
    schema,
    schemaEntry,
    organization,
    organizationEntry,
    duplicates,
    duplicateEntry
  };
}

function projectValue(context) {
  return compileProjectCaptureValue({
    input: context.prepared.input,
    policy: context.policy.fields,
    schema: context.schema,
    organization: context.organization,
    creationProfile: context.creationProfile
  });
}

function issuesFor(project, duplicates) {
  const issues = project.issues.map((issue) => issue.code + ': ' + issue.claim);
  if (duplicates.length) {
    issues.push(
      'PROJECT_DUPLICATE_CANDIDATE_OBSERVED: Exact-name project candidates require operator review.'
    );
  }
  return issues;
}

function buildDecision({ root, lock, snapshot, run, id, createdAt, producer }) {
  const automation = selectedAutomation(lock);
  const context = exactContext({ root, lock, snapshot, run });
  const compiledProject = projectValue(context);
  const issues = issuesFor(compiledProject, context.duplicates);
  const project = structuredClone(compiledProject);
  delete project.fields;
  delete project.issues;
  delete project.creationProfileBinding;
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
      creationProfile: {
        definitionId: context.creationProfile.profile.id,
        definitionFingerprint: context.creationProfile.definitionFingerprint,
        entryId: context.profileEntry.id,
        entryFingerprint: context.profileEntry.valueFingerprint,
        externalRecordId: context.creationProfile.record.id,
        externalRecordFingerprint: fingerprintJson(context.creationProfile.record)
      },
      schema: {
        entryId: context.schemaEntry.id,
        entryFingerprint: context.schemaEntry.valueFingerprint,
        schemaFingerprint: context.schema.schemaFingerprint
      },
      organization: {
        entryId: context.organizationEntry.id,
        entryFingerprint: context.organizationEntry.valueFingerprint,
        recordId: context.organization.id,
        recordFingerprint: fingerprintJson(context.organization)
      },
      duplicates: {
        entryId: context.duplicateEntry.id,
        entryFingerprint: context.duplicateEntry.valueFingerprint,
        candidates: context.duplicates.map((record) => ({
          recordId: record.id,
          recordFingerprint: fingerprintJson(record)
        }))
      },
      project,
      limitations: [
        'This private decision binds exact prepared input and connected read observations but grants no approval, continuation, provider call, write, proof, or migration authority.',
        'Provider-native templates, linked views, manager and client-contact relations, existing Task/Document/channel links, multiple-owner milestone work items, and connected body read-back are intentionally unavailable in this narrow portable profile.'
      ]
    },
    issues,
    privacy: {
      scope: 'private',
      redactions: [
        'Project name, overview, milestone body, dates, and exact desired fields remain in private local decision state and are excluded from workspace inspection and evidence.',
        'Provider credentials, secret references, raw native responses, and unrelated record values are excluded.'
      ]
    },
    decisionFingerprint: ZERO_FINGERPRINT
  };
  decision.decisionFingerprint = decisionFingerprint(decision);
  return decision;
}

export function createProjectCaptureDecision(args) {
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
    'soter/automations/project-capture/decision.schema.json',
    'Project Capture decision'
  );
  return decision;
}

export function assertProjectCaptureDecision({ root, lock, snapshot, run, decision }) {
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
    'soter/automations/project-capture/decision.schema.json',
    'Project Capture decision'
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
      'Project Capture decision does not match the exact prepared input, connected Context, and deterministic outcome.'
    );
  }
  return true;
}

export function inspectProjectCaptureDecisionContext({
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
    id: 'decision.project-capture.preview',
    createdAt: exact.snapshot.createdAt,
    producer: { kind: 'fixture', id: 'project-capture-preview', host: null }
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
      duplicateCandidateCount: preview.payload.duplicates.candidates.length,
      organizationFingerprint: preview.payload.organization.recordFingerprint,
      projectAfterFingerprint: preview.payload.project.afterFingerprint
    },
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_DECISION_NOT_COMMITTED'
    }
  };
}

export function commitProjectCaptureDecision({
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
  const decision = createProjectCaptureDecision({
    root: resolvedRoot,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    id,
    createdAt: existing?.createdAt || at || new Date().toISOString(),
    producer
  });
  if (existing && fingerprintJson(existing) !== fingerprintJson(decision)) {
    throw new Error('Project Capture decision conflicts with existing durable state.');
  }
  assertProjectCaptureDecision({
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

export function loadProjectCaptureDecision({ root, lockPath, decisionId, expectedHost }) {
  const exact = getExactDurableAutomationDecision({
    root,
    lockPath,
    decisionId,
    expectedHost
  });
  assertProjectCaptureDecision({
    root,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    decision: exact.decision
  });
  return exact;
}
