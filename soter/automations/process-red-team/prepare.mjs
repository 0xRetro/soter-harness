import path from 'node:path';

import { invokeCapability } from '../../core/capabilities.mjs';
import { exactRequestedContextRecord } from '../../core/context-records.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import {
  derivedReviewContentFingerprint,
  derivedReviewItemFingerprint
} from '../../core/review-projections.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';
import {
  assertProcessReviewPolicySelection,
  assertProcessReviewSources,
  evaluateProcessReview,
  loadProcessReviewPolicy
} from '../../contexts/process/process-review.mjs';

const AUTOMATION_ID = 'automation.process-red-team';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function derivedReviewDefinition(root) {
  const definition = readJson(path.join(root, 'soter', 'automations', 'process-red-team', 'derived-review.json'));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'process-red-team-derived-review') {
    throw new Error('Process Red Team derived review definition drifted from its Automation-owned contract.');
  }
  return definition;
}

function authority(lock, role, subject) {
  const matches = lock.authorities.filter((item) => item.role === role && item.subject === subject);
  if (matches.length !== 1) {
    throw new Error('Process Red Team requires one exact ' + role + ' authority for ' + subject + '.');
  }
  return matches[0].id;
}

function policySource(lock, definitionAuthority) {
  const matches = lock.sources.filter((source) => source.consumers.some((consumer) => {
    return consumer.pack === AUTOMATION_ID && consumer.purpose === 'process-review-policy';
  }));
  if (matches.length !== 1) {
    throw new Error('Process Red Team requires exactly one configured process-review-policy source.');
  }
  const source = matches[0];
  if (source.capability !== 'process.records.read'
    || source.authority !== definitionAuthority
    || source.inputFingerprint !== fingerprintJson(source.input)) {
    throw new Error('Process review policy source must be one exact typed definition-authority read.');
  }
  return source;
}

async function readFixture({ root, lock, capability, authorityId, input, effectId, at }) {
  const result = await invokeCapability({
    root,
    lock,
    capability,
    authority: authorityId,
    containment: 'fixture',
    input,
    effectId,
    at
  });
  if (result.invocation.state !== 'passed') {
    throw new Error('Process Red Team contained read did not pass: ' + effectId + '.');
  }
  return result;
}

function snapshotEntry({ id, subject, authorityId, role, result, value = result.output }) {
  return {
    id,
    subject,
    authority: authorityId,
    role,
    capability: result.invocation.capability,
    providerPack: result.invocation.providerPack,
    providerImplementation: result.invocation.providerImplementation,
    providerVersion: result.invocation.providerVersion,
    observedAt: result.output.observedAt,
    freshness: 'passed',
    provenance: result.output.provenance,
    valueFingerprint: fingerprintJson(value),
    value
  };
}

function contextStep(entry, invocation, sequence) {
  const labels = {
    'context.process-review.policy': 'Load exact process-review policy selection',
    'context.process-review.target': 'Read exact target process definition',
    'context.process-review.policy-standards': 'Read every related policy standard',
    'context.process-review.write-target-schema': 'Read current declared write-target schema',
    'context.process-review.runs': 'Read exact latest process run evidence'
  };
  return {
    id: 'preparation.context.' + String(sequence),
    sequence,
    label: labels[entry.id],
    capability: entry.capability,
    authority: entry.authority,
    containment: 'fixture',
    state: 'completed',
    inputFingerprint: invocation.inputFingerprint,
    outputFingerprint: entry.valueFingerprint,
    limitation: 'This typed fixture read does not establish connected identity, reachability, permission, provider conformance, write verification, readiness, or health.'
  };
}

function privateField(id, label, type, reviewValue) {
  return { id, label, type, fingerprint: fingerprintJson(reviewValue), reviewValue };
}

function privateItem(id, sources, finding) {
  const value = {
    id,
    kind: 'process-review-finding',
    sources,
    fields: [
      privateField('findingId', 'Finding identity', 'text', finding.id),
      privateField('severity', 'Severity', 'text', finding.severity),
      privateField('lens', 'Review lens', 'text', finding.lens),
      privateField('title', 'Title', 'text', finding.title),
      privateField('finding', 'Verified finding', 'text', finding.finding),
      privateField('reproduction', 'Reproduction', 'text', finding.reproduction),
      privateField('sourceIds', 'Exact source identities', 'string-list', finding.sourceIds),
      privateField('proposedFix', 'Proposed fix', 'text', finding.proposedFix),
      privateField('reproduced', 'Reproduced', 'boolean', finding.reproduced),
      privateField('disposition', 'Disposition', 'text', finding.disposition)
    ],
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  value.fingerprint = derivedReviewItemFingerprint(value);
  return value;
}

function rowFingerprint(row) {
  const unsigned = structuredClone(row);
  delete unsigned.fingerprint;
  delete unsigned.privateDetailFingerprint;
  for (const action of unsigned.actions) delete action.changeFingerprint;
  return fingerprintJson(unsigned);
}

function collectionFingerprint(collection) {
  const unsigned = structuredClone(collection);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function severityFlag(severity) {
  return 'PROCESS_FINDING_' + severity.toUpperCase().replace(/-/g, '_');
}

export function buildProcessRedTeamPreview({ policy, sources, findings, derivedDefinition, fixRequested }) {
  const collectionId = 'collection.process-red-team.findings';
  const rows = [];
  const items = [];
  for (const [index, finding] of findings.entries()) {
    const sequenceId = String(index + 1).padStart(2, '0');
    const action = {
      id: 'action.process-red-team.finding-' + sequenceId + '.held',
      kind: 'process-review-finding',
      capability: null,
      effect: null,
      state: 'held',
      reasonCode: fixRequested
        ? 'PROCESS_REVIEW_FIX_REQUEST_WITHHELD'
        : 'PROCESS_REVIEW_REPORT_ONLY'
    };
    const row = {
      id: 'row.process-red-team.finding-' + sequenceId,
      sequence: index + 1,
      representedCount: 1,
      subject: {
        kind: 'process-review-finding',
        fingerprint: fingerprintJson({
          id: finding.id,
          severity: finding.severity,
          lens: finding.lens,
          sourceFingerprint: finding.sourceFingerprint
        })
      },
      group: 'process-finding-' + finding.severity,
      attention: 'operator',
      disposition: 'itemized',
      reasonCode: finding.reasonCode,
      flags: [severityFlag(finding.severity)],
      actions: [action],
      privateDetailFingerprint: null,
      fingerprint: 'sha256:' + '0'.repeat(64)
    };
    row.fingerprint = rowFingerprint(row);
    const item = privateItem(
      'review-item.process-red-team.finding-' + sequenceId,
      [{ collectionId, rowId: row.id, rowFingerprint: row.fingerprint }],
      finding
    );
    row.privateDetailFingerprint = item.fingerprint;
    rows.push(row);
    items.push(item);
  }
  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: collectionId,
    kind: 'process-red-team-review',
    labelKey: 'process-red-team-review',
    coverage: {
      complete: true,
      observedCount: rows.length,
      includedCount: rows.length,
      excludedCount: 0,
      exclusions: []
    },
    rows,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  collection.fingerprint = collectionFingerprint(collection);
  const derivedReview = { kind: derivedDefinition.kind, items };
  const criticalCount = findings.filter((finding) => finding.severity === 'critical').length;
  const facts = [
    { id: 'process-review-policy-grounded', label: 'Process review policy grounded', value: true, state: 'supported', basisIds: ['context.process-review.policy'] },
    { id: 'process-review-lens-count', label: 'Governed review lenses', value: policy.lenses.length, state: policy.lenses.length === 5 ? 'supported' : 'contradicted', basisIds: ['context.process-review.policy'] },
    { id: 'process-review-policy-source-count', label: 'Related policy standards', value: sources.policies.length, state: sources.policies.length ? 'supported' : 'unavailable', basisIds: ['context.process-review.policy-standards'] },
    { id: 'process-review-run-source-count', label: 'Exact process runs reviewed', value: sources.runs.length, state: sources.runs.length ? 'supported' : 'unavailable', basisIds: ['context.process-review.runs'] },
    { id: 'process-review-critical-count', label: 'Reproduced critical findings', value: criticalCount, state: criticalCount ? 'contradicted' : 'supported', basisIds: ['context.process-review.target', 'context.process-review.policy-standards', 'context.process-review.runs'] },
    { id: 'process-review-fix-requested', label: 'Auto-fix requested', value: fixRequested, state: fixRequested ? 'contradicted' : 'supported', basisIds: ['context.process-review.policy'] },
    { id: 'process-review-proposed-write-count', label: 'External writes proposed', value: 0, state: 'supported', basisIds: ['context.process-review.policy'] }
  ];
  const contradictions = criticalCount ? [{
    id: 'process-critical-findings-reproduced',
    claim: 'At least one critical process-control gap is reproduced against the exact definition, policy, and run evidence.',
    state: 'observed',
    basisIds: ['context.process-review.target', 'context.process-review.policy-standards', 'context.process-review.runs']
  }] : [];
  if (fixRequested) contradictions.push({
    id: 'process-auto-fix-request-withheld',
    claim: 'The request to modify sources during review is withheld because the governed review mode is report-only.',
    state: 'observed',
    basisIds: ['context.process-review.policy']
  });
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedDefinition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'process-red-team-preview',
    fingerprint: null,
    facts,
    contradictions,
    collections: [collection],
    privateReview,
    proposedChanges: []
  };
  preview.fingerprint = fingerprintJson({
    kind: preview.kind,
    facts,
    contradictions,
    collections: preview.collections,
    privateReview,
    proposedChanges: []
  });
  return { preview, derivedReview, criticalCount };
}

export async function prepareProcessRedTeamRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  const derivedDefinition = derivedReviewDefinition(root);
  const policy = loadProcessReviewPolicy(root);
  const definitionAuthority = authority(lock, 'definition', 'process.records');
  const instanceAuthority = authority(lock, 'instance', 'process.records');
  const source = policySource(lock, definitionAuthority);
  const runId = 'run.' + workId.slice('work.'.length);
  const snapshotId = 'context.' + workId.slice('work.'.length);
  const envelope = prepareRunEnvelope({
    root,
    lock,
    lockPath,
    scenarioPath,
    automationId: AUTOMATION_ID,
    runId,
    createdAt,
    requestedOutcome: 'Prepare one ranked five-lens process review with exact source reproduction, then stop before edits, approval, dispatch, or provider writes.',
    evidenceIds: []
  });
  const policyResult = await readFixture({
    root,
    lock,
    capability: 'process.records.read',
    authorityId: definitionAuthority,
    input: source.input,
    effectId: 'effect.process-red-team.preparation.policy.fixture',
    at: createdAt
  });
  const selection = assertProcessReviewPolicySelection(policyResult.output, policy);
  const processResult = await readFixture({
    root,
    lock,
    capability: 'process.records.read',
    authorityId: instanceAuthority,
    input: { recordTypes: ['process'], ids: [input.processUri], limit: 2 },
    effectId: 'effect.process-red-team.preparation.target.fixture',
    at: createdAt
  });
  const target = exactRequestedContextRecord(processResult.output, {
    recordType: 'process',
    requestedId: input.processUri
  });
  const relatedPolicyUris = target.fields?.relatedPolicyUris || [];
  const targetTypes = target.fields?.writeTargetTypes || [];
  if (relatedPolicyUris.length < 1 || targetTypes.length !== 1) {
    throw new Error('Process Red Team target does not declare one complete bounded review source set.');
  }
  const standardsResult = await readFixture({
    root,
    lock,
    capability: 'process.records.read',
    authorityId: instanceAuthority,
    input: { recordTypes: ['process-policy-standard'], ids: relatedPolicyUris, limit: Math.min(relatedPolicyUris.length + 1, 100) },
    effectId: 'effect.process-red-team.preparation.policy-standards.fixture',
    at: createdAt
  });
  const schemaResult = await readFixture({
    root,
    lock,
    capability: 'process.schema.read',
    authorityId: instanceAuthority,
    input: { recordType: targetTypes[0] },
    effectId: 'effect.process-red-team.preparation.write-target-schema.fixture',
    at: createdAt
  });
  const runsResult = await readFixture({
    root,
    lock,
    capability: 'process.records.read',
    authorityId: instanceAuthority,
    input: input.includeLatestRun
      ? { recordTypes: ['process-run'], filters: { processUri: target.id }, limit: 2 }
      : { recordTypes: ['process-run'], filters: { processUri: target.id, state: '__none__' }, limit: 1 },
    effectId: 'effect.process-red-team.preparation.runs.fixture',
    at: createdAt
  });
  const sources = assertProcessReviewSources({
    processOutput: processResult.output,
    policyOutput: standardsResult.output,
    runOutput: runsResult.output,
    schemaOutput: schemaResult.output,
    processUri: target.id,
    includeLatestRun: input.includeLatestRun
  });
  const findings = evaluateProcessReview({
    policy,
    sources,
    fixRequested: input.fixRequested === true
  });
  const acquired = [
    {
      result: policyResult,
      entry: snapshotEntry({
        id: 'context.process-review.policy',
        subject: 'process.records.process-review-policy',
        authorityId: definitionAuthority,
        role: 'definition',
        result: policyResult,
        value: { record: selection.record, definitionFingerprint: selection.definitionFingerprint }
      })
    },
    {
      result: processResult,
      entry: snapshotEntry({
        id: 'context.process-review.target',
        subject: 'process.records.process',
        authorityId: instanceAuthority,
        role: 'instance',
        result: processResult
      })
    },
    {
      result: standardsResult,
      entry: snapshotEntry({
        id: 'context.process-review.policy-standards',
        subject: 'process.records.process-policy-standard',
        authorityId: instanceAuthority,
        role: 'instance',
        result: standardsResult
      })
    },
    {
      result: schemaResult,
      entry: snapshotEntry({
        id: 'context.process-review.write-target-schema',
        subject: 'process.records.schema',
        authorityId: instanceAuthority,
        role: 'instance',
        result: schemaResult
      })
    },
    {
      result: runsResult,
      entry: snapshotEntry({
        id: 'context.process-review.runs',
        subject: 'process.records.process-run',
        authorityId: instanceAuthority,
        role: 'instance',
        result: runsResult
      })
    }
  ];
  const entries = acquired.map((item) => item.entry);
  const effects = acquired.map((item) => item.result.invocation);
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
    effectIds: effects.map((effect) => effect.id),
    privacy: {
      scope: 'private',
      redactions: [
        'Process reference, definition body, policy bodies and claims, run bodies and outcomes, provider targets, native responses, proposed fixes, and credentials are excluded from general inspection.'
      ]
    }
  };
  const grouped = new Map();
  for (const entry of entries) {
    const current = grouped.get(entry.authority) || [];
    current.push(entry.valueFingerprint);
    grouped.set(entry.authority, current);
  }
  envelope.context = envelope.context.map((item) => {
    const fingerprints = grouped.get(item.authority);
    return fingerprints ? {
      ...item,
      status: 'loaded',
      provenance: 'fixture:' + fingerprintJson(fingerprints),
      freshness: 'passed'
    } : item;
  });
  envelope.lifecycleState = 'paused';
  envelope.checkpoints = [
    { id: 'effects-established', state: 'passed', details: 'Read and disclosure policies were evaluated before every contained source invocation.' },
    { id: 'review-source-set-grounded', state: 'passed', details: 'The exact review policy, process, related policies, current write-target schema, and run evidence were loaded.' },
    { id: 'critical-reproduction-held', state: 'passed', details: 'Every critical finding was mechanically reproduced against the exact private source set before inclusion.' },
    { id: 'write-boundary-held', state: 'passed', details: 'No proposed change, approval request, continuation request, dispatch, provider write, or canonical write was issued.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;
  const result = buildProcessRedTeamPreview({
    policy,
    sources,
    findings,
    derivedDefinition,
    fixRequested: input.fixRequested === true
  });
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      { id: 'process-review-policy-grounded', label: 'Exact Process review policy grounded', state: 'supported', basis: ['context.process-review.policy'], limitation: 'The contained selection does not establish connected provider state.' },
      { id: 'process-review-source-set-grounded', label: 'Complete bounded review source set grounded', state: 'supported', basis: entries.slice(1).map((entry) => entry.id), limitation: 'The baseline supports one declared write-target schema and one latest run; broader source graphs remain unavailable.' },
      { id: 'process-review-findings-reproduced', label: 'Ranked findings reproduced', state: 'supported', basis: entries.map((entry) => entry.id), limitation: 'Contained claim comparison does not prove a general model review, connected source completeness, or future correctness.' },
      { id: 'process-review-report-only', label: 'Every proposed fix remains report-only', state: 'supported', basis: ['context.process-review.policy'], limitation: 'No process, policy, schema, run, Task, or provider write is available from this Automation.' }
    ],
    preview: result.preview,
    derivedReview: result.derivedReview
  };
}
