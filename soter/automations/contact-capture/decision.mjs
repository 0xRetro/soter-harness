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
  loadExactContactCapturePreparedInput,
  contactCapturePreparedWorkIdFromSnapshot
} from './context.mjs';
import {
  assertContactCapturePolicySelection,
  contactDuplicateFilters,
  loadContactCapturePolicyDefinition,
  normalizeContactEmail,
  normalizeContactText,
  selectContactOptions
} from './policy.mjs';
import { assertContactSchema } from './prepare.mjs';

const AUTOMATION_ID = 'automation.contact-capture';
const DECISION_TYPE = 'contact-capture.grounded-create';
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
      'Contact Capture decision requires one exact selected Automation pack.'
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
      'Contact Capture decision producer must have an exact kind, identity, and host binding.'
    );
  }
  return { ...structuredClone(producer), id: producer.id.trim() };
}

function exactEntry(snapshot, id, expected) {
  const matches = snapshot.entries.filter((entry) => entry.id === id);
  if (matches.length !== 1) {
    throw new Error(
      'Contact Capture decision requires exactly one Context entry ' + id + '.'
    );
  }
  const entry = matches[0];
  if (entry.subject !== expected.subject
    || entry.role !== expected.role
    || entry.capability !== expected.capability
    || entry.freshness !== 'passed'
    || entry.valueFingerprint !== fingerprintJson(entry.value)) {
    throw new Error(
      'Contact Capture Context entry ' + id + ' is stale or incorrectly bound.'
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
      'Contact Capture Context entry ' + entry.id + ' has invalid typed records.'
    );
  }
  return records;
}

function assertAcquisitionRun(run, snapshot, workId) {
  const suffix = workId.slice('work.contact-capture.'.length);
  const planId = 'plan.contact-capture.connected-acquisition.' + suffix;
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
      'Contact Capture decision requires the exact completed acquisition plan and Context assembly.'
    );
  }
}

function exactContext({ root, lock, snapshot, run }) {
  if (snapshot.containment !== 'connected'
    || snapshot.configurationLockFingerprint !== fingerprintLock(lock)
    || snapshot.graphFingerprint !== lock.graphFingerprint
    || snapshot.runId !== run.id) {
    throw new Error(
      'Contact Capture decision Context does not match the exact connected run and graph.'
    );
  }
  const workId = contactCapturePreparedWorkIdFromSnapshot(snapshot.id);
  const prepared = loadExactContactCapturePreparedInput({
    root,
    workId,
    expectedHost: lock.host.id
  });
  if (fingerprintLock(prepared.lock) !== fingerprintLock(lock)
    || prepared.run.id !== run.id) {
    throw new Error(
      'Contact Capture decision prepared input does not match the exact connected lock and run.'
    );
  }
  assertAcquisitionRun(run, snapshot, workId);
  const expectedIds = [
    'context.contact-capture.policy-selection',
    'context.contact-capture.schema',
    'context.contact-capture.duplicates',
    ...(prepared.input.organizationName ? ['context.contact-capture.organization'] : [])
  ];
  if (fingerprintJson(snapshot.entries.map((entry) => entry.id))
    !== fingerprintJson(expectedIds)) {
    throw new Error(
      'Contact Capture decision Context does not cover the exact acquisition sources.'
    );
  }

  const definition = loadContactCapturePolicyDefinition(root);
  const policyEntry = exactEntry(snapshot, 'context.contact-capture.policy-selection', {
    subject: 'crm.records',
    role: 'definition',
    capability: 'crm.records.read'
  });
  const policy = assertContactCapturePolicySelection(policyEntry.value, definition);
  const schemaEntry = exactEntry(snapshot, 'context.contact-capture.schema', {
    subject: 'crm.records',
    role: 'instance',
    capability: 'crm.schema.read'
  });
  const schema = assertContactSchema(schemaEntry.value);
  if (schema.schema.fingerprint !== fingerprintJson({
    recordType: schema.schema.recordType,
    fields: schema.schema.fields
  })) {
    throw new Error(
      'Contact Capture schema observation does not seal its exact portable fields.'
    );
  }
  const duplicateEntry = exactEntry(snapshot, 'context.contact-capture.duplicates', {
    subject: 'crm.records',
    role: 'instance',
    capability: 'crm.records.read'
  });
  const duplicates = exactRecords(duplicateEntry, 'person');
  const organizationEntry = prepared.input.organizationName
    ? exactEntry(snapshot, 'context.contact-capture.organization', {
      subject: 'crm.records',
      role: 'instance',
      capability: 'crm.records.read'
    })
    : null;
  const organizations = organizationEntry ? exactRecords(organizationEntry, 'organization') : [];
  if (duplicates.length > definition.duplicateCandidateLimit
    || organizations.length > definition.organizationCandidateLimit
    || definition.createRequiresConfirmation !== true) {
    throw new Error(
      'Contact Capture connected Context violates the governed create boundary.'
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
    duplicateEntry,
    organizations,
    organizationEntry
  };
}

const MESSAGE = {
  CONTACT_ROLE_NOT_IN_CURRENT_SCHEMA: 'CONTACT_ROLE_NOT_IN_CURRENT_SCHEMA: The requested Role was omitted because it is absent from the current schema.',
  CONTACT_STATUS_NOT_IN_CURRENT_SCHEMA: 'CONTACT_STATUS_NOT_IN_CURRENT_SCHEMA: The requested Status was omitted because it is absent from the current schema.',
  CONTACT_DISPOSITION_NOT_IN_CURRENT_SCHEMA: 'CONTACT_DISPOSITION_NOT_IN_CURRENT_SCHEMA: The requested Disposition was omitted because it is absent from the current schema.',
  CONTACT_AUTHORITY_NOT_IN_CURRENT_SCHEMA: 'CONTACT_AUTHORITY_NOT_IN_CURRENT_SCHEMA: One or more requested Authority values were omitted because they are absent from the current schema.',
  CONTACT_TAGS_NOT_IN_CURRENT_SCHEMA: 'CONTACT_TAGS_NOT_IN_CURRENT_SCHEMA: One or more requested Tags were omitted because they are absent from the current schema.',
  CONTACT_ORGANIZATION_NOT_FOUND: 'CONTACT_ORGANIZATION_NOT_FOUND: The requested organization was not found and the relation remains empty.',
  CONTACT_ORGANIZATION_AMBIGUOUS: 'CONTACT_ORGANIZATION_AMBIGUOUS: The requested organization matched multiple candidates and the relation remains empty.',
  CONTACT_DUPLICATE_CANDIDATE_OBSERVED: 'CONTACT_DUPLICATE_CANDIDATE_OBSERVED: An exact email or name candidate requires operator resolution.'
};

function contactValue(context) {
  const input = context.prepared.input;
  const selected = selectContactOptions({ input, schema: context.schema });
  const name = normalizeContactText(input.name, 'name', 200);
  const email = normalizeContactEmail(input.email);
  const duplicateFilters = contactDuplicateFilters(input, context.definition);
  const organizations = input.organizationName
    ? context.organizations.filter((record) => {
      return record.fields?.name?.trim().toLocaleLowerCase('en')
        === input.organizationName.trim().toLocaleLowerCase('en');
    })
    : [];
  const organizationUris = organizations.length === 1 ? [organizations[0].id] : [];
  const fields = {
    name,
    ...(email ? { email } : {}),
    ...(selected.role ? { role: selected.role } : {}),
    ...(selected.status ? { status: selected.status } : {}),
    ...(selected.disposition ? { disposition: selected.disposition } : {}),
    ...(selected.authority.length ? { authority: selected.authority } : {}),
    ...(selected.tags.length ? { tags: selected.tags } : {}),
    ...(input.telegram ? { telegram: normalizeContactText(input.telegram, 'Telegram', 300) } : {}),
    ...(input.signal ? { signal: normalizeContactText(input.signal, 'Signal', 300) } : {}),
    ...(input.github ? { github: normalizeContactText(input.github, 'GitHub', 300) } : {}),
    ...(input.timezoneUtc ? { timezoneUtc: normalizeContactText(input.timezoneUtc, 'timezone', 100) } : {}),
    ...(input.source ? { source: normalizeContactText(input.source, 'source', 500) } : {}),
    ...(organizationUris.length ? { organizationUris } : {})
  };
  const warningCodes = [...selected.issues];
  if (input.organizationName && organizations.length === 0) {
    warningCodes.push('CONTACT_ORGANIZATION_NOT_FOUND');
  }
  if (organizations.length > 1) warningCodes.push('CONTACT_ORGANIZATION_AMBIGUOUS');
  const warnings = [...new Set(warningCodes)].sort().map((code) => {
    const message = MESSAGE[code];
    if (!message) throw new Error('Unknown Contact Capture decision warning: ' + code);
    return message;
  });
  const issues = context.duplicates.length
    ? [MESSAGE.CONTACT_DUPLICATE_CANDIDATE_OBSERVED]
    : [];
  return {
    person: {
      name,
      email,
      role: selected.role,
      status: selected.status,
      disposition: selected.disposition,
      authority: structuredClone(selected.authority),
      tags: structuredClone(selected.tags),
      telegram: fields.telegram || null,
      signal: fields.signal || null,
      github: fields.github || null,
      timezoneUtc: fields.timezoneUtc || null,
      source: fields.source || null,
      organizationUris,
      duplicateSearchValues: duplicateFilters.map((filter) => {
        return Object.keys(filter)[0] + ':' + Object.values(filter)[0];
      }),
      afterFingerprint: fingerprintJson({ recordType: 'person', fields })
    },
    warnings,
    issues
  };
}

function buildDecision({ root, lock, snapshot, run, id, createdAt, producer }) {
  const automation = selectedAutomation(lock);
  const context = exactContext({ root, lock, snapshot, run });
  const evaluated = contactValue(context);
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
      organizationResolution: {
        requested: Boolean(context.prepared.input.organizationName),
        entryId: context.organizationEntry?.id || null,
        entryFingerprint: context.organizationEntry?.valueFingerprint || null,
        candidates: context.organizations.map((record) => ({
          recordId: record.id,
          recordFingerprint: fingerprintJson(record)
        }))
      },
      person: evaluated.person,
      warnings: evaluated.warnings,
      limitations: [
        'This private decision binds exact prepared input and current connected observations but grants no approval, continuation, provider call, write, or proof authority.',
        'A ready decision may produce a separate private review proposal; exact batch selection, approval, one-time start consumption, checkpoint execution, and verification remain separate.'
      ]
    },
    issues: evaluated.issues,
    privacy: {
      scope: 'private',
      redactions: [
        'Contact values, current option selections, organization candidates, and duplicate identities remain private local decision state and are excluded from workspace inspection and evidence.',
        'Provider credentials, secret references, raw native responses, target identifiers, and unrelated record values are excluded.'
      ]
    },
    decisionFingerprint: ZERO_FINGERPRINT
  };
  decision.decisionFingerprint = decisionFingerprint(decision);
  return decision;
}

export function createContactCaptureDecision(args) {
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
    'soter/automations/contact-capture/decision.schema.json',
    'Contact Capture decision'
  );
  return decision;
}

export function assertContactCaptureDecision({ root, lock, snapshot, run, decision }) {
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
    'soter/automations/contact-capture/decision.schema.json',
    'Contact Capture decision'
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
      'Contact Capture decision does not match the exact prepared input, connected Context, and deterministic classification.'
    );
  }
  return true;
}

export function inspectContactCaptureDecisionContext({
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
    id: 'decision.contact-capture.preview',
    createdAt: exact.snapshot.createdAt,
    producer: { kind: 'fixture', id: 'contact-capture-preview', host: null }
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
      contactAfterFingerprint: preview.payload.person.afterFingerprint
    },
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_DECISION_NOT_COMMITTED'
    }
  };
}

export function commitContactCaptureDecision({
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
  const decision = createContactCaptureDecision({
    root: resolvedRoot,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    id,
    createdAt: existing?.createdAt || at || new Date().toISOString(),
    producer
  });
  if (existing && fingerprintJson(existing) !== fingerprintJson(decision)) {
    throw new Error('Contact Capture decision conflicts with existing durable state.');
  }
  assertContactCaptureDecision({
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

export function loadContactCaptureDecision({ root, lockPath, decisionId, expectedHost }) {
  const exact = getExactDurableAutomationDecision({
    root,
    lockPath,
    decisionId,
    expectedHost
  });
  assertContactCaptureDecision({
    root,
    lock: exact.lock,
    snapshot: exact.snapshot,
    run: exact.run,
    decision: exact.decision
  });
  return exact;
}
