#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fingerprintFile,
  fingerprintJson,
  readJson,
  writeJson
} from './lib/canonical-json.mjs';
import {
  assertLegacyFinalizationCandidateBasis,
  assertLegacyFinalizationFixtureRequest,
  readLegacyFinalizationFixtureRequest
} from './legacy-finalization.mjs';
import {
  buildLegacyCheckerRunProjectionFixture,
  managedHostOutputTemplateReferences,
  materializeGeneratedFixtureSet,
  operationalLegacyPathReferences
} from './fixtures.mjs';
import {
  LEGACY_CHECKER_RUN_PROJECTION_PATH,
  projectLegacyCheckerRunReceipt
} from '../kernel/legacy-checker-run.mjs';

const file = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(file), '..', '..');
const HASH_A = 'sha256:' + 'a'.repeat(64);
const CHECKER_RECEIPT_LIMITATIONS = [
  'This receipt records one exact immutable legacy checker observation only; it does not grant migration, fallback-removal, execution, provider, publication, or merge authority.',
  'The temporary CRM Channel vocabulary fragment exists only to satisfy the immutable pre-cutover compatibility pointer check and must be removed with the legacy cutover.',
  'Raw checker output, absolute paths, source content, inherited environment values, credentials, provider data, readiness, verification, and health claims are excluded.'
];

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function expectCode(run, code) {
  try {
    run();
  } catch (error) {
    assert.equal(error.code, code, error.message);
    return;
  }
  assert.fail('Expected ' + code);
}

async function expectAsyncFailure(run, pattern) {
  await assert.rejects(run, pattern);
}

function bindingKey(sourcePath, targetId, targetPath) {
  return `${sourcePath}\0${targetId}\0${targetPath}`;
}

function aggregate(targets) {
  return targets.every((target) => target.state === 'retired') ? 'retired' : 'migrated';
}

const tombstoneSource = '.claude/skills/example/SKILL.md';
assert.deepEqual(operationalLegacyPathReferences({
  $contract: 'soter://contracts/workflow-guide/v2',
  source: { presence: 'removed', legacyPath: tombstoneSource }
}, tombstoneSource), []);
assert.deepEqual(operationalLegacyPathReferences({
  $contract: 'soter://contracts/workflow-guide/v2',
  source: { presence: 'present', legacyPath: tombstoneSource }
}, tombstoneSource), ['/source/legacyPath']);
assert.deepEqual(operationalLegacyPathReferences({
  $contract: 'soter://contracts/scenario/v1',
  sourceCases: [tombstoneSource]
}, tombstoneSource), []);
assert.deepEqual(operationalLegacyPathReferences({
  $contract: 'soter://contracts/workflow-definition/v2',
  source: { presence: 'removed', legacyPath: tombstoneSource }
}, tombstoneSource), []);
const evaluationSource = '.claude/evals/example/happy-path.md';
assert.deepEqual(operationalLegacyPathReferences({
  $contract: 'soter://contracts/workflow-evaluation-set/v2',
  cases: [{ source: { presence: 'removed', legacyPath: evaluationSource } }]
}, evaluationSource), []);
assert.deepEqual(operationalLegacyPathReferences({
  $contract: 'soter://contracts/workflow-evaluation-set/v2',
  cases: [{ source: { presence: 'present', legacyPath: evaluationSource } }]
}, evaluationSource), ['/cases/0/source/legacyPath']);
assert.deepEqual(operationalLegacyPathReferences({
  $contract: 'soter://contracts/pack/v1',
  limitations: ['Runtime fallback: ' + tombstoneSource],
  operator: { module: tombstoneSource }
}, tombstoneSource), ['/limitations/0', '/operator/module']);
const managedHostOutput = '.mcp.json';
const managedHostProjection = {
  $contract: 'soter://contracts/host-projection-definition/v2',
  host: 'claude',
  outputs: [{
    path: managedHostOutput,
    role: 'tools',
    template: 'soter/hosts/claude/templates/mcp.json.tmpl',
    mode: '0644'
  }]
};
assert.deepEqual(
  operationalLegacyPathReferences(managedHostProjection, managedHostOutput),
  []
);
assert.deepEqual(operationalLegacyPathReferences({
  $contract: 'soter://contracts/host-projection-definition/v2',
  host: 'claude',
  outputs: [{
    path: managedHostOutput,
    role: 'tools',
    template: 'soter/hosts/../private-template.json',
    mode: '0644'
  }],
  fallback: managedHostOutput
}, managedHostOutput), ['/fallback', '/outputs/0/path']);
const managedTemplateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-host-template-'));
try {
  const managedTemplatePath = path.join(
    managedTemplateRoot,
    'soter/hosts/claude/templates/mcp.json.tmpl'
  );
  fs.mkdirSync(path.dirname(managedTemplatePath), { recursive: true });
  fs.writeFileSync(managedTemplatePath, '{"mcpServers":{}}\n');
  assert.deepEqual(
    managedHostOutputTemplateReferences(
      managedTemplateRoot,
      managedHostProjection,
      managedHostOutput
    ),
    []
  );
  fs.writeFileSync(managedTemplatePath, `{"fallback":"${managedHostOutput}"}\n`);
  assert.deepEqual(
    managedHostOutputTemplateReferences(
      managedTemplateRoot,
      managedHostProjection,
      managedHostOutput
    ),
    ['/outputs/0/template']
  );
} finally {
  fs.rmSync(managedTemplateRoot, { recursive: true, force: true });
}

function recompute(inventory) {
  inventory.items.forEach((item, sequence) => {
    item.sequence = sequence;
    item.state = aggregate(item.targets);
  });
  inventory.stateCounts = { mapped: 0, bridged: 0, migrated: 0, retired: 0 };
  inventory.bindingStateCounts = { mapped: 0, bridged: 0, migrated: 0, retired: 0 };
  for (const item of inventory.items) {
    inventory.stateCounts[item.state] += 1;
    for (const binding of item.targets) inventory.bindingStateCounts[binding.state] += 1;
  }
  inventory.inventoryFingerprint = null;
  inventory.inventoryFingerprint = fingerprintJson(inventory);
  return inventory;
}

function finalEvidencePath(item, target, targetIndex) {
  if (target.evidence?.length) return target.evidence;
  return [
    `soter/fixtures/finalization/source-${String(item.sequence).padStart(3, '0')}`
      + `-target-${String(targetIndex).padStart(2, '0')}.migration.evidence.json`
  ];
}

function createSyntheticCheckerReceipt(sourceRoot, candidateRoot, inventory) {
  const schemaSource = path.join(
    sourceRoot,
    'soter/contracts/legacy-checker-run-receipt.schema.json'
  );
  const schemaTarget = path.join(
    candidateRoot,
    'soter/contracts/legacy-checker-run-receipt.schema.json'
  );
  fs.mkdirSync(path.dirname(schemaTarget), { recursive: true });
  fs.copyFileSync(schemaSource, schemaTarget);
  fs.copyFileSync(
    path.join(sourceRoot, 'soter/contracts/legacy-checker-run-projection.schema.json'),
    path.join(candidateRoot, 'soter/contracts/legacy-checker-run-projection.schema.json')
  );
  const vocabularyPath = path.join(sourceRoot, 'soter/contexts/crm/vocabulary.json');
  const restoredVocabulary = readJson(vocabularyPath);
  assert.equal(
    restoredVocabulary.entries.some((entry) => entry.id === 'channel'),
    false,
    'Final CRM vocabulary must not regain Communications-owned Channel semantics.'
  );
  const channelEntry = {
    sequence: restoredVocabulary.entries.length + 1,
    id: 'channel',
    term: 'channel',
    aliases: [],
    abbreviation: null,
    definition: 'Synthetic immutable pre-cutover compatibility fragment used only by this finalization selftest.',
    domain: 'communication',
    sourceUris: []
  };
  const vocabulary = structuredClone(restoredVocabulary);
  vocabulary.entries.push(channelEntry);
  writeJson(
    path.join(candidateRoot, 'soter/contexts/crm/vocabulary.json'),
    restoredVocabulary
  );
  const checker = inventory.items.find((item) => item.sourcePath === '.claude/scripts/check.mjs');
  assert(checker);
  const basis = {
    checker: {
      path: '.claude/scripts/check.mjs',
      fingerprint: checker.sourceFingerprint
    },
    transition: {
      path: 'soter/kernel/legacy-checker-transition.json',
      fingerprint: HASH_A,
      documentFingerprint: HASH_A
    },
    temporaryCrmVocabulary: {
      path: 'soter/contexts/crm/vocabulary.json',
      fingerprint: fingerprintJson(vocabulary),
      baseFingerprint: fingerprintJson(restoredVocabulary),
      shimEntryFingerprint: fingerprintJson(channelEntry),
      purpose: 'immutable-pre-removal-channel-fragment-check-only',
      retention: 'must-be-removed-with-legacy-cutover'
    },
    checkerVisibleInputTree: {
      scope: 'complete-public-repository-tree',
      excludedRoots: ['.git', '.soter', 'node_modules'],
      directoryCount: 1,
      fileCount: 1,
      treeFingerprint: HASH_A
    },
    gitFreshnessInputs: {
      state: 'unavailable',
      observationCount: 0,
      observationsFingerprint: HASH_A
    },
    runtime: {
      identity: 'current-node-binary',
      version: process.version,
      binaryFingerprint: HASH_A
    }
  };
  const command = {
    executable: 'current-node-binary',
    script: '.claude/scripts/check.mjs',
    arguments: ['--all'],
    cwd: 'repository-root',
    environmentPolicy: 'fixed-minimal-v1',
    timeoutMs: 60000
  };
  const receipt = {
    $contract: 'soter://contracts/legacy-checker-run-receipt/v1',
    contractVersion: '1.0.0',
    id: 'legacy-checker-run.' + fingerprintJson({ basis, command }).slice('sha256:'.length),
    observedAt: '2026-07-22T12:00:00.000Z',
    basis,
    command,
    result: {
      exitStatus: 0,
      errorCount: 0,
      warningCount: 0,
      stdoutFingerprint: HASH_A,
      stderrFingerprint: HASH_A
    },
    authority: {
      kind: 'none',
      grantsMigration: false,
      grantsFallbackRemoval: false,
      grantsExecution: false,
      grantsProviderRead: false,
      grantsProviderWrite: false,
      grantsPublication: false,
      grantsMerge: false
    },
    privacy: {
      rawOutputIncluded: false,
      absolutePathsIncluded: false,
      sourceContentIncluded: false,
      environmentValuesIncluded: false
    },
    limitations: [...CHECKER_RECEIPT_LIMITATIONS],
    receiptFingerprint: null
  };
  receipt.receiptFingerprint = fingerprintJson(receipt);
  const stateDirectory = path.join(candidateRoot, '.soter/state/legacy-checker-runs');
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  for (const directory of [
    path.join(candidateRoot, '.soter'),
    path.join(candidateRoot, '.soter/state'),
    stateDirectory
  ]) {
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  }
  const receiptFile = path.join(stateDirectory, receipt.id + '.json');
  writeJson(receiptFile, receipt);
  if (process.platform !== 'win32') fs.chmodSync(receiptFile, 0o600);
  const projection = projectLegacyCheckerRunReceipt({ root: candidateRoot, receipt });
  writeJson(path.join(candidateRoot, LEGACY_CHECKER_RUN_PROJECTION_PATH), projection);
  return { id: receipt.id, receiptFingerprint: receipt.receiptFingerprint };
}

function makeFinalCandidate(sourceRoot) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'soter-finalization-resolver-'))
  );
  const inventory = readJson(path.join(sourceRoot, 'soter/migrations/legacy-inventory.json'));
  for (const item of inventory.items) {
    item.sourcePresence = 'removed';
    item.targets.forEach((target, targetIndex) => {
      target.status = 'existing';
      target.state = 'migrated';
      target.canonicalAuthority = 'target';
      target.fallback = 'removed';
      target.parity = 'intentional-change';
      target.evidence = finalEvidencePath(item, target, targetIndex);
    });
  }
  recompute(inventory);
  writeJson(path.join(root, 'soter/migrations/legacy-inventory.json'), inventory);

  const bindings = new Map(inventory.items.flatMap((item) => {
    return item.targets.map((target) => [
      bindingKey(item.sourcePath, target.id, target.path),
      { item, target }
    ]);
  }));
  const migrationNames = fs.readdirSync(path.join(sourceRoot, 'soter/migrations'))
    .filter((name) => name.endsWith('.migration.json'))
    .sort(compareCodepoint);
  let migrationItemCount = 0;
  for (const name of migrationNames) {
    const migration = readJson(path.join(sourceRoot, 'soter/migrations', name));
    for (const item of migration.items) {
      migrationItemCount += 1;
      const exact = bindings.get(bindingKey(item.sourcePath, item.targetPack, item.targetPath));
      assert(exact, 'Synthetic finalizer fixture has no inventory binding for ' + name);
      item.sourceFingerprint = exact.item.sourceFingerprint;
      item.state = exact.target.state;
      item.evidence = [...exact.target.evidence];
    }
    writeJson(path.join(root, 'soter/migrations', name), migration);
  }
  assert.equal(migrationItemCount, 213);
  const evidencePaths = [...new Set(inventory.items.flatMap((item) => {
    return item.targets.flatMap((target) => target.evidence);
  }))].sort(compareCodepoint);
  const firstMigration = migrationNames[0];
  const firstItem = readJson(path.join(root, 'soter/migrations', firstMigration)).items[0];
  const verification = {
    health: { valid: 'failed' },
    violations: [{
      file: path.join(root, 'soter/migrations', firstMigration),
      code: 'SOTER_MIGRATION_EVIDENCE',
      what: 'migration evidence is not a passed evidence/v2 record: ' + firstItem.evidence[0],
      level: 'error'
    }]
  };
  const checkerReceipt = createSyntheticCheckerReceipt(sourceRoot, root, inventory);
  return { root, inventory, evidencePaths, verification, firstMigration, checkerReceipt };
}

export async function selftestLegacyFinalization(root = repositoryRoot) {
const candidate = makeFinalCandidate(path.resolve(root));
const requestRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'soter-finalization-request-'))
);
const materializationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-finalization-materialize-'));
try {
  const input = {
    root: candidate.root,
    expectedInventoryFingerprint: candidate.inventory.inventoryFingerprint,
    checkerReceipt: candidate.checkerReceipt,
    evidencePaths: candidate.evidencePaths,
    verification: candidate.verification
  };
  const accepted = assertLegacyFinalizationCandidateBasis(input);
  assert.equal(accepted.sourceCount, 143);
  assert.equal(accepted.migrationItemCount, 213);
  assert.equal(accepted.pendingEvidenceViolations, 1);
  assert.deepEqual(accepted.evidencePaths, candidate.evidencePaths);
  assert.deepEqual(accepted.checkerReceipt, candidate.checkerReceipt);
  assert.match(accepted.checkerProjection.id, /^legacy-checker-run-projection[.][a-f0-9]{64}$/);
  assert.match(accepted.checkerProjection.fingerprint, /^sha256:[a-f0-9]{64}$/);
  const privateStateRoot = path.join(candidate.root, '.soter');
  const heldPrivateStateRoot = path.join(candidate.root, '.soter-held-for-selftest');
  fs.renameSync(privateStateRoot, heldPrivateStateRoot);
  const projectedWithoutPrivateState = buildLegacyCheckerRunProjectionFixture(candidate.root);
  assert.deepEqual(
    projectedWithoutPrivateState.get(LEGACY_CHECKER_RUN_PROJECTION_PATH),
    readJson(path.join(candidate.root, LEGACY_CHECKER_RUN_PROJECTION_PATH))
  );
  fs.renameSync(heldPrivateStateRoot, privateStateRoot);

  expectCode(
    () => assertLegacyFinalizationCandidateBasis({
      ...input,
      checkerReceipt: null
    }),
    'LEGACY_FINALIZATION_CHECKER_RECEIPT_REQUIRED'
  );
  expectCode(
    () => assertLegacyFinalizationCandidateBasis({
      ...input,
      checkerReceipt: {
        ...candidate.checkerReceipt,
        receiptFingerprint: HASH_A
      }
    }),
    'LEGACY_FINALIZATION_CHECKER_RECEIPT_INVALID'
  );

  const checkerProjectionPath = path.join(
    candidate.root,
    LEGACY_CHECKER_RUN_PROJECTION_PATH
  );
  const checkerProjectionBytes = fs.readFileSync(checkerProjectionPath);
  fs.rmSync(checkerProjectionPath);
  expectCode(
    () => assertLegacyFinalizationCandidateBasis(input),
    'LEGACY_FINALIZATION_CHECKER_PROJECTION_INVALID'
  );
  fs.mkdirSync(path.dirname(checkerProjectionPath), { recursive: true });
  fs.writeFileSync(checkerProjectionPath, checkerProjectionBytes);
  const tamperedProjection = readJson(checkerProjectionPath);
  tamperedProjection.result.stdoutFingerprint = 'sha256:' + 'b'.repeat(64);
  writeJson(checkerProjectionPath, tamperedProjection);
  expectCode(
    () => assertLegacyFinalizationCandidateBasis(input),
    'LEGACY_FINALIZATION_CHECKER_PROJECTION_INVALID'
  );
  fs.writeFileSync(checkerProjectionPath, checkerProjectionBytes);

  const crmVocabularyPath = path.join(
    candidate.root,
    'soter/contexts/crm/vocabulary.json'
  );
  const crmVocabulary = readJson(crmVocabularyPath);
  const shimmedVocabulary = structuredClone(crmVocabulary);
  shimmedVocabulary.entries.push({
    sequence: 3,
    id: 'channel',
    term: 'channel',
    aliases: [],
    abbreviation: null,
    definition: 'planted temporary shim',
    domain: 'communications-compatibility',
    sourceUris: []
  });
  writeJson(crmVocabularyPath, shimmedVocabulary);
  expectCode(
    () => assertLegacyFinalizationCandidateBasis(input),
    'LEGACY_FINALIZATION_CHECKER_SHIM_REMAINS'
  );
  writeJson(crmVocabularyPath, crmVocabulary);

  const packedCheckerPath = path.join(candidate.root, 'soter/kernel/legacy-check.mjs');
  fs.mkdirSync(path.dirname(packedCheckerPath), { recursive: true });
  fs.writeFileSync(packedCheckerPath, 'planted packed checker\n');
  expectCode(
    () => assertLegacyFinalizationCandidateBasis(input),
    'LEGACY_FINALIZATION_CHECKER_RUNTIME_REMAINS'
  );
  fs.rmSync(packedCheckerPath);

  for (const trackedHostOutput of [
    '.claude-plugin/marketplace.json',
    '.codex/config.toml',
    'AGENTS.md',
    'CLAUDE.md'
  ]) {
    const trackedHostOutputPath = path.join(candidate.root, trackedHostOutput);
    fs.mkdirSync(path.dirname(trackedHostOutputPath), { recursive: true });
    fs.writeFileSync(trackedHostOutputPath, 'planted tracked generated output\n');
    expectCode(
      () => assertLegacyFinalizationCandidateBasis(input),
      'LEGACY_FINALIZATION_HOST_OUTPUT_REMAINS'
    );
    fs.rmSync(trackedHostOutputPath);
  }

  expectCode(
    () => assertLegacyFinalizationCandidateBasis({
      ...input,
      expectedInventoryFingerprint: HASH_A
    }),
    'LEGACY_FINALIZATION_INVENTORY_INVALID'
  );

  expectCode(
    () => assertLegacyFinalizationCandidateBasis({
      ...input,
      expectedSourceCount: 1,
      expectedMigrationItemCount: 1,
      baselineCommit: 'caller-controlled',
      verificationOverride: { health: { valid: 'passed' }, violations: [] }
    }),
    'LEGACY_FINALIZATION_REQUEST_INVALID'
  );

  const exactRequest = {
    expectedInventoryFingerprint: candidate.inventory.inventoryFingerprint,
    checkerReceipt: candidate.checkerReceipt,
    evidencePaths: candidate.evidencePaths,
    obsoleteFixturePaths: [
      'soter/fixtures/legacy-claude-host/obsolete.finalization.fixture.json'
    ]
  };
  assert.deepEqual(
    assertLegacyFinalizationFixtureRequest(candidate.root, exactRequest),
    exactRequest
  );
  const developmentEvidencePath
    = 'soter/evidence/development/evidence.development-activation.codex.selftest.json';
  const requestWithDevelopmentEvidence = {
    ...exactRequest,
    evidencePaths: [...exactRequest.evidencePaths, developmentEvidencePath].sort(compareCodepoint)
  };
  assert.deepEqual(
    assertLegacyFinalizationFixtureRequest(candidate.root, requestWithDevelopmentEvidence),
    requestWithDevelopmentEvidence
  );
  expectCode(
    () => assertLegacyFinalizationFixtureRequest(candidate.root, {
      ...exactRequest,
      privateOutputData: 'HOSTILE_PRIVATE_OUTPUT_SENTINEL'
    }),
    'LEGACY_FINALIZATION_REQUEST_INVALID'
  );
  expectCode(
    () => assertLegacyFinalizationFixtureRequest(candidate.root, {
      expectedInventoryFingerprint: exactRequest.expectedInventoryFingerprint,
      evidencePaths: exactRequest.evidencePaths,
      obsoleteFixturePaths: exactRequest.obsoleteFixturePaths
    }),
    'LEGACY_FINALIZATION_REQUEST_INVALID'
  );
  expectCode(
    () => assertLegacyFinalizationFixtureRequest(candidate.root, {
      ...exactRequest,
      evidencePaths: ['/tmp/HOSTILE_PRIVATE_OUTPUT_SENTINEL.json']
    }),
    'LEGACY_FINALIZATION_EVIDENCE_SCOPE_INVALID'
  );
  expectCode(
    () => assertLegacyFinalizationFixtureRequest(candidate.root, {
      ...exactRequest,
      obsoleteFixturePaths: ['/tmp/HOSTILE_PRIVATE_OUTPUT_SENTINEL.json']
    }),
    'LEGACY_FINALIZATION_OBSOLETE_FIXTURE_SCOPE_INVALID'
  );
  if (process.platform !== 'win32') {
    const externalEvidenceDirectory = path.join(requestRoot, 'external-evidence');
    const linkedEvidenceDirectory = path.join(
      candidate.root,
      'soter/fixtures/linked-finalization-evidence'
    );
    fs.mkdirSync(externalEvidenceDirectory, { recursive: true });
    fs.mkdirSync(path.dirname(linkedEvidenceDirectory), { recursive: true });
    fs.symlinkSync(externalEvidenceDirectory, linkedEvidenceDirectory);
    const linkedEvidencePath
      = 'soter/fixtures/linked-finalization-evidence/escaped.evidence.json';
    expectCode(
      () => assertLegacyFinalizationFixtureRequest(candidate.root, {
        ...exactRequest,
        evidencePaths: [linkedEvidencePath]
      }),
      'LEGACY_FINALIZATION_EVIDENCE_SCOPE_INVALID'
    );
    expectCode(
      () => assertLegacyFinalizationFixtureRequest(candidate.root, {
        ...exactRequest,
        obsoleteFixturePaths: [linkedEvidencePath]
      }),
      'LEGACY_FINALIZATION_OBSOLETE_FIXTURE_SCOPE_INVALID'
    );
    fs.unlinkSync(linkedEvidenceDirectory);
  }
  expectCode(
    () => assertLegacyFinalizationFixtureRequest(candidate.root, {
      ...exactRequest,
      obsoleteFixturePaths: [developmentEvidencePath]
    }),
    'LEGACY_FINALIZATION_OBSOLETE_FIXTURE_SCOPE_INVALID'
  );
  expectCode(
    () => assertLegacyFinalizationFixtureRequest(candidate.root, {
      ...exactRequest,
      obsoleteFixturePaths: [candidate.evidencePaths[0]]
    }),
    'LEGACY_FINALIZATION_OBSOLETE_FIXTURE_SCOPE_INVALID'
  );

  const requestFile = path.join(requestRoot, 'finalization-request.json');
  writeJson(requestFile, exactRequest);
  fs.chmodSync(requestFile, 0o600);
  assert.deepEqual(
    readLegacyFinalizationFixtureRequest(candidate.root, requestFile),
    exactRequest
  );
  fs.writeFileSync(requestFile, JSON.stringify(exactRequest), { mode: 0o600 });
  fs.chmodSync(requestFile, 0o600);
  expectCode(
    () => readLegacyFinalizationFixtureRequest(candidate.root, requestFile),
    'LEGACY_FINALIZATION_REQUEST_INVALID'
  );
  writeJson(requestFile, exactRequest);
  fs.chmodSync(requestFile, 0o600);
  writeJson(requestFile, {
    ...exactRequest,
    privateOutputData: 'HOSTILE_PRIVATE_OUTPUT_SENTINEL'
  });
  fs.chmodSync(requestFile, 0o600);
  expectCode(
    () => readLegacyFinalizationFixtureRequest(candidate.root, requestFile),
    'LEGACY_FINALIZATION_REQUEST_INVALID'
  );
  fs.writeFileSync(requestFile, '{not-valid-json\n', { mode: 0o600 });
  fs.chmodSync(requestFile, 0o600);
  expectCode(
    () => readLegacyFinalizationFixtureRequest(candidate.root, requestFile),
    'LEGACY_FINALIZATION_REQUEST_INVALID'
  );
  writeJson(requestFile, exactRequest);
  fs.chmodSync(requestFile, 0o600);
  expectCode(
    () => readLegacyFinalizationFixtureRequest(candidate.root, 'relative-request.json'),
    'LEGACY_FINALIZATION_REQUEST_PATH_INVALID'
  );
  const insideRequest = path.join(candidate.root, 'private-request.json');
  writeJson(insideRequest, exactRequest);
  fs.chmodSync(insideRequest, 0o600);
  expectCode(
    () => readLegacyFinalizationFixtureRequest(candidate.root, insideRequest),
    'LEGACY_FINALIZATION_REQUEST_PATH_INVALID'
  );
  const linkedRequest = path.join(requestRoot, 'linked-request.json');
  fs.symlinkSync(requestFile, linkedRequest);
  expectCode(
    () => readLegacyFinalizationFixtureRequest(candidate.root, linkedRequest),
    'LEGACY_FINALIZATION_REQUEST_PATH_INVALID'
  );
  fs.rmSync(linkedRequest);
  const realParent = path.join(requestRoot, 'real-parent');
  const linkedParent = path.join(requestRoot, 'linked-parent');
  fs.mkdirSync(realParent);
  const parentRequest = path.join(realParent, 'request.json');
  writeJson(parentRequest, exactRequest);
  fs.chmodSync(parentRequest, 0o600);
  fs.symlinkSync(realParent, linkedParent, 'dir');
  expectCode(
    () => readLegacyFinalizationFixtureRequest(
      candidate.root,
      path.join(linkedParent, 'request.json')
    ),
    'LEGACY_FINALIZATION_REQUEST_PATH_INVALID'
  );
  fs.unlinkSync(linkedParent);
  const hardlinkedRequest = path.join(requestRoot, 'hardlinked-request.json');
  fs.linkSync(requestFile, hardlinkedRequest);
  expectCode(
    () => readLegacyFinalizationFixtureRequest(candidate.root, hardlinkedRequest),
    'LEGACY_FINALIZATION_REQUEST_PATH_INVALID'
  );
  fs.rmSync(hardlinkedRequest);
  fs.chmodSync(requestFile, 0o644);
  expectCode(
    () => readLegacyFinalizationFixtureRequest(candidate.root, requestFile),
    'LEGACY_FINALIZATION_REQUEST_PATH_INVALID'
  );
  fs.chmodSync(requestFile, 0o600);

  const conflictingModes = spawnSync(
    process.execPath,
    [path.join(path.resolve(root), 'soter/core/cli.mjs'), 'fixtures', '--update', '--finalize', requestFile],
    { cwd: path.resolve(root), encoding: 'utf8' }
  );
  assert.notEqual(conflictingModes.status, 0);
  assert.match(
    conflictingModes.stderr + conflictingModes.stdout,
    /fixtures requires exactly one of --check, --update, or --finalize/
  );

  const existingFixture = path.join(
    materializationRoot,
    'soter/fixtures/finalization/existing.json'
  );
  const absentFixture = path.join(
    materializationRoot,
    'soter/fixtures/finalization/absent.json'
  );
  writeJson(existingFixture, { state: 'before' });
  await expectAsyncFailure(
    () => materializeGeneratedFixtureSet(materializationRoot, async () => {
      const completeButRejected = new Map([
        ['soter/fixtures/finalization/existing.json', { state: 'after' }],
        ['soter/fixtures/finalization/absent.json', { state: 'after' }]
      ]);
      assert.deepEqual(readJson(existingFixture), { state: 'before' });
      assert.equal(fs.existsSync(absentFixture), false);
      void completeButRejected;
      throw new Error('planted late builder failure');
    }),
    /planted late builder failure/
  );
  assert.deepEqual(readJson(existingFixture), { state: 'before' });
  assert.equal(fs.existsSync(absentFixture), false);

  const circular = {};
  circular.self = circular;
  await expectAsyncFailure(
    () => materializeGeneratedFixtureSet(materializationRoot, async () => new Map([
      ['soter/fixtures/finalization/existing.json', { state: 'after' }],
      ['soter/fixtures/finalization/absent.json', circular]
    ])),
    /circular/i
  );
  assert.deepEqual(readJson(existingFixture), { state: 'before' });
  assert.equal(fs.existsSync(absentFixture), false);

  const retiredCollectionIdentity = ['39dd79b5', 'de38', '8042', '9d47', '000b9293ab47'].join('-');
  await expectAsyncFailure(
    () => materializeGeneratedFixtureSet(materializationRoot, async () => new Map([
      ['soter/fixtures/finalization/existing.json', { state: 'after' }],
      ['soter/fixtures/finalization/absent.json', {
        target: 'collection://' + retiredCollectionIdentity
      }]
    ])),
    /retired private workspace collection identity/
  );
  assert.deepEqual(readJson(existingFixture), { state: 'before' });
  assert.equal(fs.existsSync(absentFixture), false);

  const inventoryFile = path.join(candidate.root, 'soter/migrations/legacy-inventory.json');
  const truncated = structuredClone(candidate.inventory);
  truncated.items.pop();
  truncated.basis.fileCount = truncated.items.length;
  truncated.basis.treeFingerprint = fingerprintJson(truncated.items.map((item) => ({
    sourcePath: item.sourcePath,
    sourceFingerprint: item.sourceFingerprint
  })));
  recompute(truncated);
  writeJson(inventoryFile, truncated);
  expectCode(
    () => assertLegacyFinalizationCandidateBasis({
      ...input,
      expectedInventoryFingerprint: truncated.inventoryFingerprint,
      evidencePaths: [...new Set(truncated.items.flatMap((item) => {
        return item.targets.flatMap((target) => target.evidence);
      }))].sort(compareCodepoint)
    }),
    'LEGACY_FINALIZATION_INVENTORY_INVALID'
  );
  writeJson(inventoryFile, candidate.inventory);

  const source = path.join(candidate.root, candidate.inventory.items[0].sourcePath);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'planted retained fallback\n');
  expectCode(
    () => assertLegacyFinalizationCandidateBasis(input),
    'LEGACY_FINALIZATION_SOURCE_PRESENT'
  );
  fs.rmSync(source);

  const partial = structuredClone(candidate.inventory);
  partial.items[0].sourcePresence = 'present';
  partial.items[0].targets[0].state = 'bridged';
  partial.items[0].targets[0].canonicalAuthority = 'legacy';
  partial.items[0].targets[0].fallback = 'retained';
  partial.items[0].targets[0].parity = 'not-evaluated';
  recompute(partial);
  writeJson(inventoryFile, partial);
  expectCode(
    () => assertLegacyFinalizationCandidateBasis({
      ...input,
      expectedInventoryFingerprint: partial.inventoryFingerprint
    }),
    'LEGACY_FINALIZATION_INVENTORY_INVALID'
  );
  writeJson(inventoryFile, candidate.inventory);

  expectCode(
    () => assertLegacyFinalizationCandidateBasis({
      ...input,
      evidencePaths: candidate.evidencePaths.slice(1)
    }),
    'LEGACY_FINALIZATION_EVIDENCE_SCOPE_INVALID'
  );

  const migrationFile = path.join(
    candidate.root,
    'soter/migrations',
    candidate.firstMigration
  );
  const migration = readJson(migrationFile);
  const unfinishedMigration = structuredClone(migration);
  unfinishedMigration.items[0].state = 'bridged';
  writeJson(migrationFile, unfinishedMigration);
  expectCode(
    () => assertLegacyFinalizationCandidateBasis(input),
    'LEGACY_FINALIZATION_MIGRATION_INVALID'
  );
  const mismatchedMigration = structuredClone(migration);
  mismatchedMigration.items[0].evidence = [candidate.evidencePaths.at(-1)];
  writeJson(migrationFile, mismatchedMigration);
  expectCode(
    () => assertLegacyFinalizationCandidateBasis(input),
    'LEGACY_FINALIZATION_MIGRATION_INVALID'
  );
  const missingMigrationItem = structuredClone(migration);
  missingMigrationItem.items.pop();
  writeJson(migrationFile, missingMigrationItem);
  expectCode(
    () => assertLegacyFinalizationCandidateBasis(input),
    'LEGACY_FINALIZATION_MIGRATION_INVALID'
  );
  const hostSource = candidate.inventory.items.find((item) => {
    return item.sourcePath === '.claude/.claude-plugin/plugin.json';
  });
  const hostTarget = hostSource.targets.find((target) => target.id === 'host.claude');
  const substitutedHostCompletion = structuredClone(migration);
  substitutedHostCompletion.items[0] = {
    ...substitutedHostCompletion.items[0],
    sourcePath: hostSource.sourcePath,
    sourceFingerprint: hostSource.sourceFingerprint,
    targetPath: hostTarget.path,
    targetPack: hostTarget.id,
    state: hostTarget.state,
    evidence: [...hostTarget.evidence]
  };
  writeJson(migrationFile, substitutedHostCompletion);
  expectCode(
    () => assertLegacyFinalizationCandidateBasis(input),
    'LEGACY_FINALIZATION_MIGRATION_INVALID'
  );
  writeJson(migrationFile, migration);

  expectCode(
    () => assertLegacyFinalizationCandidateBasis({
      ...input,
      verification: {
        health: { valid: 'failed' },
        violations: [{
          file: path.join(candidate.root, 'soter/packs/kernel.example/pack.json'),
          code: 'SOTER_PACK_ARTIFACT',
          what: 'planted unrelated failure',
          level: 'error'
        }]
      }
    }),
    'LEGACY_FINALIZATION_GRAPH_INVALID'
  );

  expectCode(
    () => assertLegacyFinalizationCandidateBasis({
      ...input,
      verification: {
        health: { valid: 'failed' },
        violations: [{
          file: migrationFile,
          code: 'SOTER_MIGRATION_EVIDENCE',
          what: 'planted evidence failure for a different source and target',
          level: 'error'
        }]
      }
    }),
    'LEGACY_FINALIZATION_VIOLATION_UNATTRIBUTED'
  );

  const staticClean = assertLegacyFinalizationCandidateBasis({
    ...input,
    verification: { health: { valid: 'passed' }, violations: [] }
  });
  assert.equal(staticClean.pendingEvidenceViolations, 0);
} finally {
  fs.rmSync(candidate.root, { recursive: true, force: true });
  fs.rmSync(requestRoot, { recursive: true, force: true });
  fs.rmSync(materializationRoot, { recursive: true, force: true });
}

process.stdout.write(
  'Legacy finalization resolver selftest: immutable 143-source v1 basis, 213 exact ordinary bindings plus eight closed host completions, private receipt/request confinement, durable governed checker projection without private-state dependence, complete pre-write fixture materialization, zero unfinished bindings, closed evidence outputs, unrelated graph failures, and attributable migration-only bootstrap checks passed.\n'
);
return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === file) {
  await selftestLegacyFinalization();
}
