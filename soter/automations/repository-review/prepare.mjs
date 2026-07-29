import path from 'node:path';

import { invokeCapability } from '../../core/capabilities.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import {
  derivedReviewContentFingerprint,
  derivedReviewItemFingerprint
} from '../../core/review-projections.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';

const AUTOMATION_ID = 'automation.repository-review';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';
const MAX_CANDIDATES = 10;

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function derivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'repository-review',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'repository-review-derived-review') {
    throw new Error('Repository Review derived review definition drifted from its Automation-owned contract.');
  }
  return definition;
}

function authority(lock, role, subject) {
  const matches = lock.authorities.filter((item) => {
    return item.role === role && item.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error('Repository Review requires one exact ' + role + ' authority for ' + subject + '.');
  }
  return matches[0].id;
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
    throw new Error('Repository Review contained read did not pass: ' + effectId + '.');
  }
  return result;
}

function assertRepositorySnapshot(output) {
  if (!output?.repository
    || !Array.isArray(output.capabilities)
    || output.capabilities.length < 1
    || output.capabilities.length > MAX_CANDIDATES
    || new Set(output.capabilities.map((candidate) => candidate.id)).size
      !== output.capabilities.length
    || output.repository.sourceFileCount < 1) {
    throw new Error('Repository Review requires one bounded, unique normalized capability snapshot.');
  }
  for (const candidate of output.capabilities) {
    const unsigned = structuredClone(candidate);
    delete unsigned.fingerprint;
    if (candidate.fingerprint !== fingerprintJson(unsigned)
      || !candidate.evidence.some((item) => item.relativePath !== 'README.md')
      || new Set(candidate.evidence.map((item) => item.relativePath)).size
        !== candidate.evidence.length
      || candidate.evidence.some((item) => {
        return item.relativePath.startsWith('/')
          || item.relativePath.split('/').includes('..')
          || item.relativePath.includes('\\');
      })) {
      throw new Error('Repository Review candidate fingerprint or source evidence is invalid.');
    }
  }
  return output.capabilities;
}

function selectedCapabilities(capabilities, focus) {
  if (!focus) return capabilities;
  const terms = focus.toLocaleLowerCase('en').split(/\s+/).filter(Boolean);
  const selected = capabilities.filter((candidate) => {
    const haystack = [candidate.name, candidate.why, candidate.summary, candidate.currentState]
      .join('\n')
      .toLocaleLowerCase('en');
    return terms.every((term) => haystack.includes(term));
  });
  if (!selected.length) {
    throw new Error('Repository Review focus did not match any bounded normalized capability observation.');
  }
  return selected;
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
    'context.repository-review.snapshot': 'Read exact bounded repository capability snapshot',
    'context.repository-review.duplicates': 'Inspect bounded exact-name Product feature candidates'
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
    limitation: 'This typed fixture read does not establish connected repository access, provider identity, permission, Product write authority, readiness, verification, or health.'
  };
}

function privateField(id, label, type, reviewValue) {
  return { id, label, type, fingerprint: fingerprintJson(reviewValue), reviewValue };
}

function privateItem(id, sources, fields) {
  const value = {
    id,
    kind: 'feature-capture-handoff',
    sources,
    fields,
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

function exactDuplicates(records, candidateName) {
  return records.filter((record) => {
    return record.type === 'feature' && record.fields?.name === candidateName;
  }).map((record) => record.id).sort(compareCodepoint);
}

export function buildRepositoryReviewPreview({ capabilities, records, derivedDefinition }) {
  const collectionId = 'collection.repository-review.capabilities';
  const rows = [];
  const items = [];
  const contradictions = [];
  let handoffCount = 0;
  for (const [index, candidate] of capabilities.entries()) {
    const sequenceId = String(index + 1).padStart(2, '0');
    const duplicates = exactDuplicates(records, candidate.name);
    const duplicate = duplicates.length > 0;
    const reasonCode = duplicate
      ? 'REPOSITORY_FEATURE_DUPLICATE_REVIEW_REQUIRED'
      : 'REPOSITORY_FEATURE_HANDOFF_READY_FOR_REVIEW';
    const action = duplicate ? {
      id: 'action.repository-review.candidate-' + sequenceId + '.held',
      kind: 'none',
      capability: null,
      effect: null,
      state: 'held',
      reasonCode
    } : {
      id: 'action.repository-review.candidate-' + sequenceId + '.handoff',
      kind: 'feature-capture-handoff',
      capability: null,
      effect: null,
      state: 'handoff',
      reasonCode
    };
    if (!duplicate) handoffCount += 1;
    const row = {
      id: 'row.repository-review.candidate-' + sequenceId,
      sequence: index + 1,
      representedCount: 1,
      subject: { kind: 'repository-capability', fingerprint: candidate.fingerprint },
      group: 'product-capability',
      attention: 'operator',
      disposition: duplicate ? 'itemized' : 'handoff',
      reasonCode,
      flags: duplicate ? ['REPOSITORY_FEATURE_DUPLICATE_OBSERVED'] : [],
      actions: [action],
      privateDetailFingerprint: null,
      fingerprint: 'sha256:' + '0'.repeat(64)
    };
    row.fingerprint = rowFingerprint(row);
    const item = privateItem(
      'review-item.repository-review.candidate-' + sequenceId,
      [{ collectionId, rowId: row.id, rowFingerprint: row.fingerprint }],
      [
        privateField('candidateId', 'Candidate identity', 'text', candidate.id),
        privateField('name', 'Feature name', 'text', candidate.name),
        privateField('why', 'Why', 'text', candidate.why),
        privateField('summary', 'Summary', 'text', candidate.summary),
        privateField('currentState', 'Current state in code', 'text', candidate.currentState),
        privateField('evidencePaths', 'Repository evidence', 'string-list', candidate.evidence.map((item) => item.relativePath)),
        privateField('duplicateCandidateIds', 'Existing feature candidates', 'string-list', duplicates),
        privateField('targetAutomation', 'Target Automation', 'text', 'automation.feature-capture')
      ]
    );
    row.privateDetailFingerprint = item.fingerprint;
    rows.push(row);
    items.push(item);
    if (duplicate) {
      contradictions.push({
        id: 'repository-duplicate-candidate-' + sequenceId,
        claim: 'One repository capability matches an existing exact-name Product feature and remains held for duplicate review.',
        state: 'observed',
        basisIds: ['context.repository-review.duplicates']
      });
    }
  }
  const collection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: collectionId,
    kind: 'repository-capability-review',
    labelKey: 'repository-capability-review',
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
  const duplicateCount = rows.length - handoffCount;
  const facts = [
    { id: 'repository-source-observed', label: 'Repository source snapshot observed', value: true, state: 'supported', basisIds: ['context.repository-review.snapshot'] },
    { id: 'repository-capability-count', label: 'Bounded capability candidates', value: rows.length, state: 'supported', basisIds: ['context.repository-review.snapshot'] },
    { id: 'repository-feature-handoff-count', label: 'Feature Capture handoffs prepared', value: handoffCount, state: handoffCount ? 'supported' : 'unavailable', basisIds: ['context.repository-review.snapshot', 'context.repository-review.duplicates'] },
    { id: 'repository-duplicate-count', label: 'Exact-name Product candidates observed', value: duplicateCount, state: duplicateCount ? 'contradicted' : 'supported', basisIds: ['context.repository-review.duplicates'] },
    { id: 'repository-proposed-write-count', label: 'External writes proposed', value: 0, state: 'supported', basisIds: ['context.repository-review.snapshot', 'context.repository-review.duplicates'] }
  ];
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedDefinition),
    contentFingerprint: derivedReviewContentFingerprint(derivedReview)
  };
  const preview = {
    kind: 'repository-review-preview',
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
  return { preview, derivedReview, handoffCount, duplicateCount };
}

export async function prepareRepositoryReviewRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  if (input.scope !== 'product-capabilities') {
    throw new Error('Repository Review supports only the product-capabilities review altitude.');
  }
  const derivedDefinition = derivedReviewDefinition(root);
  const repositoryAuthority = authority(lock, 'instance', 'repository.source');
  const productAuthority = authority(lock, 'instance', 'product.records');
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
    requestedOutcome: 'Prepare one bounded repository capability review and exact private Feature Capture handoffs, then stop before approval or external writes.',
    evidenceIds: []
  });
  const repositoryResult = await readFixture({
    root,
    lock,
    capability: 'repository.snapshot.read',
    authorityId: repositoryAuthority,
    input: { uri: input.repositoryUri },
    effectId: 'effect.repository-review.preparation.snapshot.fixture',
    at: createdAt
  });
  const capabilities = selectedCapabilities(
    assertRepositorySnapshot(repositoryResult.output),
    input.focus
  );
  const duplicateResult = await readFixture({
    root,
    lock,
    capability: 'product.records.read',
    authorityId: productAuthority,
    input: {
      recordTypes: ['feature'],
      filtersAny: capabilities.map((candidate) => ({ name: candidate.name })),
      limit: MAX_CANDIDATES
    },
    effectId: 'effect.repository-review.preparation.duplicates.fixture',
    at: createdAt
  });
  if (duplicateResult.output.records.some((record) => record.type !== 'feature')) {
    throw new Error('Repository Review duplicate read returned a non-feature Product record.');
  }
  const acquired = [
    {
      result: repositoryResult,
      entry: snapshotEntry({
        id: 'context.repository-review.snapshot',
        subject: 'repository.source.snapshot',
        authorityId: repositoryAuthority,
        role: 'instance',
        result: repositoryResult
      })
    },
    {
      result: duplicateResult,
      entry: snapshotEntry({
        id: 'context.repository-review.duplicates',
        subject: 'product.records.feature-candidates',
        authorityId: productAuthority,
        role: 'instance',
        result: duplicateResult,
        value: {
          candidateCount: duplicateResult.output.records.length,
          candidateIds: duplicateResult.output.records.map((record) => record.id).sort(compareCodepoint),
          providerOutputFingerprint: duplicateResult.invocation.outputFingerprint
        }
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
        'Repository reference, remote, candidate names, why, summaries, evidence paths, Product record values, provider responses, and credentials are excluded from general inspection.'
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
    { id: 'effects-established', state: 'passed', details: 'Read and disclosure policies were evaluated before every contained context invocation.' },
    { id: 'repository-review-grounded', state: 'passed', details: 'One exact repository snapshot and bounded Product duplicate comparison were loaded.' },
    { id: 'write-boundary-held', state: 'passed', details: 'No tooling page, feature card, change set, approval request, continuation request, provider write, repository mutation, or canonical write was issued.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = effects;
  const result = buildRepositoryReviewPreview({
    capabilities,
    records: duplicateResult.output.records,
    derivedDefinition
  });
  return {
    envelope,
    snapshot,
    contextPlan: entries.map((entry, index) => contextStep(entry, effects[index], index + 1)),
    outcomes: [
      { id: 'repository-snapshot-grounded', label: 'Exact bounded repository snapshot grounded', state: 'supported', basis: ['context.repository-review.snapshot'], limitation: 'The normalized contained snapshot does not establish connected repository access or current provider state.' },
      { id: 'repository-review-prepared', label: 'Itemized Product capability review prepared', state: 'proposed', basis: entries.map((entry) => entry.id), limitation: 'Review candidates are observations, not Product authority or a recommendation to create every item.' },
      { id: 'feature-handoffs-prepared', label: 'Exact private Feature Capture handoffs prepared', state: result.handoffCount ? 'proposed' : 'blocked', basis: entries.map((entry) => entry.id), limitation: 'Handoffs create no Feature Capture prepared work, approval, continuation, or Product write authority.' },
      { id: 'external-write-boundary', label: 'All external and repository writes prohibited', state: 'supported', basis: entries.map((entry) => entry.id), limitation: 'Tooling-page creation and all connected writes are intentionally unavailable in this migration slice.' }
    ],
    preview: result.preview,
    derivedReview: result.derivedReview
  };
}
