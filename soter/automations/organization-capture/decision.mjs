import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
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
  loadExactOrganizationCapturePreparedInput,
  organizationCapturePreparedWorkIdFromSnapshot
} from './context.mjs';
import {
  assertOrganizationCapturePolicySelection,
  classifyOrganization,
  loadOrganizationCapturePolicyDefinition,
  normalizeOrganizationTwitter,
  normalizeOrganizationWebsite,
  organizationDuplicateNames
} from './policy.mjs';
import { assertOrganizationSchema } from './prepare.mjs';

const AUTOMATION_ID = 'automation.organization-capture';
const DECISION_TYPE = 'organization-capture.grounded-create';
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
    throw new Error(
      'Organization Capture decision requires one exact selected Automation pack.'
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
      'Organization Capture decision producer must have an exact kind, identity, and host binding.'
    );
  }
  return { ...structuredClone(producer), id: producer.id.trim() };
}

function exactEntry(snapshot, id, expected) {
  const matches = snapshot.entries.filter((entry) => entry.id === id);
  if (matches.length !== 1) {
    throw new Error(
      'Organization Capture decision requires exactly one Context entry ' + id + '.'
    );
  }
  const entry = matches[0];
  if (entry.subject !== expected.subject
    || entry.role !== expected.role
    || entry.capability !== expected.capability
    || entry.freshness !== 'passed'
    || entry.valueFingerprint !== fingerprintJson(entry.value)) {
    throw new Error(
      'Organization Capture Context entry ' + id + ' is stale or incorrectly bound.'
    );
  }
  return entry;
}

function exactRecords(entry, type) {
  const records = entry.value?.records;
  if (!Array.isArray(records)
    || records.some((record) => record?.type !== type)
    || new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error(
      'Organization Capture Context entry ' + entry.id + ' has invalid typed records.'
    );
  }
  return records;
}

function assertAcquisitionRun(run, snapshot, workId) {
  const suffix = workId.slice('work.organization-capture.'.length);
  const planId = 'plan.organization-capture.connected-acquisition.' + suffix;
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
      'Organization Capture decision requires the exact completed acquisition plan and Context assembly.'
    );
  }
}

function exactContext({ root, lock, snapshot, run }) {
  if (snapshot.containment !== 'connected'
    || snapshot.configurationLockFingerprint !== fingerprintLock(lock)
    || snapshot.graphFingerprint !== lock.graphFingerprint
    || snapshot.runId !== run.id) {
    throw new Error(
      'Organization Capture decision Context does not match the exact connected run and graph.'
    );
  }
  const workId = organizationCapturePreparedWorkIdFromSnapshot(snapshot.id);
  const prepared = loadExactOrganizationCapturePreparedInput({
    root,
    workId,
    expectedHost: lock.host.id
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.run.id !== run.id) {
    throw new Error(
      'Organization Capture decision prepared input does not match the exact connected lock and run.'
    );
  }
  assertAcquisitionRun(run, snapshot, workId);
  const expectedIds = [
    'context.organization-capture.policy-selection',
    'context.organization-capture.schema',
    'context.organization-capture.duplicates'
  ];
  if (fingerprintJson(snapshot.entries.map((entry) => entry.id))
    !== fingerprintJson(expectedIds)) {
    throw new Error(
      'Organization Capture decision Context does not cover the exact acquisition sources.'
    );
  }

  const definition = loadOrganizationCapturePolicyDefinition(root);
  const policyEntry = exactEntry(snapshot, 'context.organization-capture.policy-selection', {
    subject: 'crm.records',
    role: 'definition',
    capability: 'crm.records.read'
  });
  const policy = assertOrganizationCapturePolicySelection(policyEntry.value, definition);
  const schemaEntry = exactEntry(snapshot, 'context.organization-capture.schema', {
    subject: 'crm.records',
    role: 'instance',
    capability: 'crm.schema.read'
  });
  const schema = assertOrganizationSchema(schemaEntry.value);
  if (schema.schema.fingerprint !== fingerprintJson({
    recordType: schema.schema.recordType,
    fields: schema.schema.fields
  })) {
    throw new Error(
      'Organization Capture schema observation does not seal its exact portable fields.'
    );
  }
  const duplicateEntry = exactEntry(snapshot, 'context.organization-capture.duplicates', {
    subject: 'crm.records',
    role: 'instance',
    capability: 'crm.records.read'
  });
  const duplicates = exactRecords(duplicateEntry, 'organization');
  if (duplicates.length > definition.duplicateCandidateLimit
    || definition.createRequiresConfirmation !== true
    || definition.relationsOnCreate !== 'empty') {
    throw new Error(
      'Organization Capture connected Context violates the governed create boundary.'
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
    duplicates,
    duplicateEntry
  };
}

const ISSUE_MESSAGES = {
  ORG_TYPE_NOT_IN_CURRENT_SCHEMA: 'ORG_TYPE_NOT_IN_CURRENT_SCHEMA: The requested organization Type is absent from the current schema.',
  ORG_TYPE_POLICY_SCHEMA_DRIFT: 'ORG_TYPE_POLICY_SCHEMA_DRIFT: A governed Type rule names a value absent from the current schema.',
  ORG_TYPE_UNRESOLVED: 'ORG_TYPE_UNRESOLVED: The governed rules do not resolve one organization Type.',
  ORG_TYPE_AMBIGUOUS: 'ORG_TYPE_AMBIGUOUS: The governed rules resolve more than one organization Type.',
  ORG_TYPE_CONTRADICTS_GOVERNED_CLASSIFICATION: 'ORG_TYPE_CONTRADICTS_GOVERNED_CLASSIFICATION: The requested Type conflicts with the governed classification.',
  ORG_TAG_NOT_IN_CURRENT_SCHEMA: 'ORG_TAG_NOT_IN_CURRENT_SCHEMA: A requested Tag is absent from the current schema.',
  ORG_SECTOR_TAG_UNAVAILABLE: 'ORG_SECTOR_TAG_UNAVAILABLE: A detected sector signal has no matching current Tag.',
  ORG_DUPLICATE_CANDIDATE_OBSERVED: 'ORG_DUPLICATE_CANDIDATE_OBSERVED: Exact-name or alias candidates require operator resolution.'
};

function organizationValue(context) {
  const input = context.prepared.input;
  const classified = classifyOrganization({
    input,
    policy: context.definition,
    typeOptions: context.schema.typeOptions,
    tagOptions: context.schema.tagOptions
  });
  const website = normalizeOrganizationWebsite(input.website);
  const twitter = normalizeOrganizationTwitter(input.twitter);
  const duplicateSearchNames = organizationDuplicateNames(input, context.definition);
  const fields = {
    name: input.name,
    ...(classified.organizationType
      ? { organizationType: classified.organizationType }
      : {}),
    ...(classified.tags.length ? { tags: classified.tags } : {}),
    ...(website ? { website } : {}),
    ...(twitter ? { twitter } : {})
  };
  const issueCodes = [...classified.issues];
  if (context.duplicates.length) issueCodes.push('ORG_DUPLICATE_CANDIDATE_OBSERVED');
  const issues = [...new Set(issueCodes)].sort().map((code) => {
    const message = ISSUE_MESSAGES[code];
    if (!message) throw new Error('Unknown Organization Capture decision issue: ' + code);
    return message;
  });
  return {
    organization: {
      name: input.name,
      organizationType: classified.organizationType,
      tags: structuredClone(classified.tags),
      website,
      twitter,
      duplicateSearchNames,
      afterFingerprint: fingerprintJson({ recordType: 'organization', fields })
    },
    issues
  };
}

function buildDecision({ root, lock, snapshot, run, id, createdAt, producer }) {
  const automation = selectedAutomation(lock);
  const context = exactContext({ root, lock, snapshot, run });
  const evaluated = organizationValue(context);
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
    state: evaluated.issues.length ? 'needs-input' : 'ready',
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
        schemaFingerprint: context.schema.schema.fingerprint
      },
      duplicates: {
        entryId: context.duplicateEntry.id,
        entryFingerprint: context.duplicateEntry.valueFingerprint,
        candidates: context.duplicates.map((record) => ({
          recordId: record.id,
          recordFingerprint: fingerprintJson(record)
        }))
      },
      organization: evaluated.organization,
      limitations: [
        'This private decision binds exact prepared input and current connected observations but grants no approval, continuation, provider call, write, or proof authority.',
        'A ready decision may produce a separate private review proposal; exact batch selection, approval, one-time start consumption, checkpoint execution, and verification remain separate.'
      ]
    },
    issues: evaluated.issues,
    privacy: {
      scope: 'private',
      redactions: [
        'Organization prose, aliases, schema option values, URLs, and duplicate identities remain private local decision state and are excluded from workspace inspection and evidence.',
        'Provider credentials, secret references, raw native responses, target identifiers, and unrelated record values are excluded.'
      ]
    },
    decisionFingerprint: ZERO_FINGERPRINT
  };
  decision.decisionFingerprint = decisionFingerprint(decision);
  return decision;
}

export function createOrganizationCaptureDecision(args) {
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
    'soter/automations/organization-capture/decision.schema.json',
    'Organization Capture decision'
  );
  return decision;
}

export function assertOrganizationCaptureDecision({ root, lock, snapshot, run, decision }) {
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
    'soter/automations/organization-capture/decision.schema.json',
    'Organization Capture decision'
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
      'Organization Capture decision does not match the exact prepared input, connected Context, and deterministic classification.'
    );
  }
  return true;
}

export function inspectOrganizationCaptureDecisionContext({
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
    id: 'decision.organization-capture.preview',
    createdAt: exact.snapshot.createdAt,
    producer: { kind: 'fixture', id: 'organization-capture-preview', host: null }
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
      schemaFingerprint: preview.payload.schema.schemaFingerprint,
      organizationAfterFingerprint: preview.payload.organization.afterFingerprint
    },
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_DECISION_NOT_COMMITTED'
    }
  };
}

export function commitOrganizationCaptureDecision({
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
  const decision = createOrganizationCaptureDecision({
    root: resolvedRoot,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    id,
    createdAt: existing?.createdAt || at || new Date().toISOString(),
    producer
  });
  if (existing && fingerprintJson(existing) !== fingerprintJson(decision)) {
    throw new Error('Organization Capture decision conflicts with existing durable state.');
  }
  assertOrganizationCaptureDecision({
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

export function loadOrganizationCaptureDecision({ root, lockPath, decisionId, expectedHost }) {
  const exact = getExactDurableAutomationDecision({
    root,
    lockPath,
    decisionId,
    expectedHost
  });
  assertOrganizationCaptureDecision({
    root,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    decision: exact.decision
  });
  return exact;
}
