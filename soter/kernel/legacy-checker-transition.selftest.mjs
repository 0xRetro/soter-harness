#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fingerprintJson,
  readJson,
  writeJson
} from '../core/lib/canonical-json.mjs';
import {
  assertLegacyCheckerTransitionCurrent,
  assertLegacyCheckerTransitionDocument,
  buildLegacyFinalizationCandidate,
  extractLegacyCheckerCodes,
  inspectLegacyFinalizationBlockers
} from './legacy-checker-transition.mjs';
import {
  assertLegacyInventoryCurrent,
  updateLegacyInventory
} from './legacy-inventory.mjs';

const file = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(file), '..', '..');
const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);

function expectCode(run, code) {
  try {
    run();
  } catch (error) {
    assert.equal(error.code, code, error.message);
    return;
  }
  assert.fail('Expected ' + code);
}

function expectFailure(run, pattern) {
  try {
    run();
  } catch (error) {
    assert.match(String(error.message), pattern);
    return;
  }
  assert.fail('Expected failure matching ' + pattern);
}

function evidenceDocument({ id, sourcePath, sourceFingerprint, targetPath, targetFingerprint }) {
  return {
    $contract: 'soter://contracts/evidence/v2',
    contractVersion: '2.0.0',
    id,
    createdAt: '2026-07-22T00:00:00.000Z',
    claimFamily: 'migration',
    claim: 'The exact synthetic legacy responsibility completed its target authority transition.',
    subject: { type: 'pack', id: 'kernel.example', version: '1.0.0' },
    configurationLockFingerprint: HASH_A,
    graphFingerprint: HASH_B,
    dependencies: [],
    host: {
      id: 'codex',
      adapter: 'host.codex',
      version: '1.0.0',
      manifestFingerprint: HASH_A
    },
    integrations: [],
    authorities: [],
    evaluator: { id: 'legacy-finalization-selftest', version: '1.0.0', level: 'contained' },
    environment: { containment: 'fixture', runtime: 'node' },
    acceptanceCriteria: ['Exact source and target fingerprints are bound.'],
    result: 'passed',
    outcomes: [],
    artifacts: [
      { role: 'migration-source', path: sourcePath, fingerprint: sourceFingerprint },
      { role: 'migration-target', path: targetPath, fingerprint: targetFingerprint }
    ],
    effects: [],
    failures: [],
    warnings: [],
    skipped: [],
    limitations: ['Synthetic contained finalization proof only.'],
    freshness: { policy: 'immutable synthetic migration proof', validUntil: null },
    supersedes: null,
    privacy: { scope: 'private', redactions: [] }
  };
}

function authorizationOverlay(temp, transitions) {
  return [...new Set(transitions.flatMap((item) => item.authorizationEvidence))]
    .sort()
    .map((evidencePath) => {
      const document = readJson(path.join(temp, evidencePath));
      return {
        path: evidencePath,
        documentFingerprint: fingerprintJson(document),
        document
      };
    });
}

function makeFinalizationRoot({
  multipleTargets = false,
  sharedOwners = false,
  existingFinalBinding = false
} = {}) {
  assert(!existingFinalBinding || multipleTargets);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-legacy-finalization-'));
  fs.mkdirSync(path.join(temp, 'soter'), { recursive: true });
  fs.cpSync(path.join(root, 'soter', 'contracts'), path.join(temp, 'soter', 'contracts'), {
    recursive: true
  });
  const targetSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'soter://contracts/finalization-target/v1',
    type: 'object',
    additionalProperties: false,
    required: ['$contract', 'id'],
    properties: {
      $contract: { const: 'soter://contracts/finalization-target/v1' },
      id: { type: 'string', minLength: 1 }
    }
  };
  writeJson(path.join(temp, 'soter/contracts/finalization-target.schema.json'), targetSchema);
  const sourcePaths = sharedOwners
    ? [
        '.claude/skills/example-guide/SKILL.md',
        '.claude/evals/example-guide/example-case.md'
      ]
    : ['.claude/rules/example.md'];
  fs.mkdirSync(path.join(temp, '.claude', 'rules'), { recursive: true });
  for (const [index, sourcePath] of sourcePaths.entries()) {
    fs.mkdirSync(path.dirname(path.join(temp, sourcePath)), { recursive: true });
    fs.writeFileSync(path.join(temp, sourcePath), `exact legacy source ${index + 1}\n`);
  }
  updateLegacyInventory(temp);

  const targets = [{
    id: 'kernel.example',
    path: 'soter/targets/example.json',
    document: { $contract: targetSchema.$id, id: 'example' },
    evidence: 'soter/evidence/example-migration.json'
  }];
  if (multipleTargets) {
    targets.push({
      id: 'host.example',
      path: 'soter/targets/example-host.json',
      document: { $contract: targetSchema.$id, id: 'example-host' },
      evidence: 'soter/evidence/example-host-migration.json'
    });
  }
  for (const target of targets) {
    writeJson(path.join(temp, target.path), target.document);
  }
  const inventoryPath = path.join(temp, 'soter/migrations/legacy-inventory.json');
  const inventory = readJson(inventoryPath);
  assert.equal(inventory.items.length, sourcePaths.length);
  for (const item of inventory.items) {
    item.targets = targets.map((target) => ({
      status: 'existing',
      id: target.id,
      path: target.path,
      responsibility: 'Exact synthetic target responsibility for finalization selftest coverage.',
      state: 'mapped',
      canonicalAuthority: 'legacy',
      fallback: 'retained',
      parity: 'not-evaluated',
      evidence: []
    }));
    item.state = 'mapped';
  }
  writeJson(inventoryPath, inventory);
  const mapped = updateLegacyInventory(temp);
  const authorizationPath = (sourceIndex, targetIndex) => {
    if (!sharedOwners) return targets[targetIndex].evidence;
    return `soter/evidence/shared-owner-${sourceIndex + 1}-${targetIndex + 1}.json`;
  };
  for (const [sourceIndex, mappedItem] of mapped.items.entries()) {
    for (const [targetIndex, target] of targets.entries()) {
      writeJson(path.join(temp, authorizationPath(sourceIndex, targetIndex)), evidenceDocument({
        id: `evidence.${target.id.replaceAll('.', '-')}-${sourceIndex + 1}`,
        sourcePath: mappedItem.sourcePath,
        sourceFingerprint: mappedItem.sourceFingerprint,
        targetPath: target.path,
        targetFingerprint: fingerprintJson(target.document)
      }));
    }
  }
  const authorizedInventory = readJson(inventoryPath);
  for (const [sourceIndex, authorizedItem] of authorizedInventory.items.entries()) {
    authorizedItem.state = 'bridged';
    for (const binding of authorizedItem.targets) {
      const targetIndex = targets.findIndex((target) => {
        return target.id === binding.id && target.path === binding.path;
      });
      assert.notEqual(targetIndex, -1);
      binding.status = 'existing';
      binding.state = 'bridged';
      binding.canonicalAuthority = 'legacy';
      binding.fallback = 'retained';
      binding.parity = 'not-evaluated';
      binding.evidence = [authorizationPath(sourceIndex, targetIndex)];
      if (existingFinalBinding && targetIndex === 1) {
        const existingEvidencePath
          = 'soter/fixtures/finalization/existing-final.evidence.json';
        writeJson(path.join(temp, existingEvidencePath), evidenceDocument({
          id: 'evidence.existing-final',
          sourcePath: authorizedItem.sourcePath,
          sourceFingerprint: authorizedItem.sourceFingerprint,
          targetPath: binding.path,
          targetFingerprint: fingerprintJson(targets[targetIndex].document)
        }));
        binding.state = 'migrated';
        binding.canonicalAuthority = 'target';
        binding.fallback = 'removed';
        binding.parity = 'proven';
        binding.evidence = [existingEvidencePath];
      }
    }
  }
  writeJson(inventoryPath, authorizedInventory);
  const current = updateLegacyInventory(temp);
  assertLegacyInventoryCurrent(temp);
  const migrationPath = 'soter/migrations/example.migration.json';
  writeJson(path.join(temp, migrationPath), {
    $contract: 'soter://contracts/migration/v1',
    contractVersion: '1.0.0',
    id: 'example-finalization',
    source: 'synthetic-legacy-source',
    slice: 'kernel.example',
    items: current.items.flatMap((currentItem) => {
      return currentItem.targets.map((binding) => ({
        sourcePath: currentItem.sourcePath,
        sourceFingerprint: currentItem.sourceFingerprint,
        targetPath: binding.path,
        targetPack: binding.id,
        state: binding.state,
        bridge: 'Synthetic current migration binding for exact finalization planning.',
        evidence: [...binding.evidence]
      }));
    })
  });
  const sharedFinalEvidence = [
    'soter/fixtures/finalization/shared-codex.evidence.json',
    'soter/fixtures/finalization/shared-claude.evidence.json'
  ];
  const transitions = current.items.flatMap((currentItem, sourceIndex) => {
    return currentItem.targets
      .filter((binding) => !['migrated', 'retired'].includes(binding.state))
      .map((binding) => {
      const targetIndex = targets.findIndex((target) => {
        return target.id === binding.id && target.path === binding.path;
      });
      assert.notEqual(targetIndex, -1);
      return {
      sourcePath: currentItem.sourcePath,
      targetId: binding.id,
      targetPath: binding.path,
      state: 'migrated',
      parity: 'proven',
      authorizationEvidence: [authorizationPath(sourceIndex, targetIndex)],
      finalEvidence: sharedOwners
        ? [...sharedFinalEvidence]
        : [`soter/fixtures/finalization/example-${targetIndex + 1}.evidence.json`]
      };
    });
  });
  return {
    temp,
    sourcePath: sourcePaths[0],
    sourcePaths,
    transitions,
    targets,
    migrationPath
  };
}

const transition = assertLegacyCheckerTransitionCurrent(root);
assert.equal(transition.rules.length, 47);
assert.equal(transition.coverage.kernelRule + transition.coverage.intentionalRetirement, 47);
const checkerPath = path.join(root, transition.source.path);
if (fs.existsSync(checkerPath)) {
  assert.equal(extractLegacyCheckerCodes(fs.readFileSync(checkerPath, 'utf8')).length, 47);
} else {
  const inventory = readJson(path.join(root, 'soter/migrations/legacy-inventory.json'));
  const checkerTombstones = inventory.items.filter((item) => {
    return item.sourcePath === transition.source.path
      && item.sourceFingerprint === transition.source.fingerprint
      && item.sourcePresence === 'removed'
      && ['migrated', 'retired'].includes(item.state)
      && item.targets.every((binding) => {
        return ['migrated', 'retired'].includes(binding.state)
          && binding.fallback === 'removed'
          && binding.evidence.length > 0;
      });
  });
  assert.equal(checkerTombstones.length, 1);
  assert.equal(transition.source.effectiveCodeCount, 47);
  assert.equal(
    fingerprintJson(transition.rules.map((rule) => rule.legacyCode)),
    transition.source.effectiveCodesFingerprint
  );
}
const liveInventoryForReceiptGate = readJson(
  path.join(root, 'soter/migrations/legacy-inventory.json')
);
const liveCheckerForReceiptGate = liveInventoryForReceiptGate.items.find((item) => {
  return item.sourcePath === '.claude/scripts/check.mjs';
});
assert(liveCheckerForReceiptGate);
const checkerRemovalWithoutReceipt = liveCheckerForReceiptGate.targets.map((binding, index) => ({
  sourcePath: liveCheckerForReceiptGate.sourcePath,
  targetId: binding.id,
  targetPath: binding.path,
  state: 'migrated',
  parity: 'intentional-change',
  authorizationEvidence: [...binding.evidence],
  finalEvidence: [`soter/evidence/checker-receipt-gate-${index + 1}.json`]
}));
expectCode(
  () => buildLegacyFinalizationCandidate(root, checkerRemovalWithoutReceipt),
  'LEGACY_FINALIZATION_CHECKER_RECEIPT_REQUIRED'
);

const removedCheckerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-legacy-checker-removed-'));
try {
  fs.mkdirSync(path.join(removedCheckerRoot, 'soter'), { recursive: true });
  fs.cpSync(
    path.join(root, 'soter/contracts'),
    path.join(removedCheckerRoot, 'soter/contracts'),
    { recursive: true }
  );
  for (const replacementPath of new Set(transition.rules.flatMap((rule) => {
    return rule.disposition === 'kernel-rule'
      ? rule.enforcements.map((enforcement) => enforcement.path)
      : [];
  }))) {
    const destination = path.join(removedCheckerRoot, replacementPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, replacementPath), destination);
  }
  writeJson(
    path.join(removedCheckerRoot, 'soter/kernel/legacy-checker-transition.json'),
    transition
  );

  const liveInventory = readJson(path.join(root, 'soter/migrations/legacy-inventory.json'));
  const checkerItem = structuredClone(liveInventory.items.find((item) => {
    return item.sourcePath === transition.source.path;
  }));
  assert(checkerItem);
  checkerItem.sequence = 0;
  checkerItem.sourcePresence = 'removed';
  checkerItem.state = 'migrated';
  for (const binding of checkerItem.targets) {
    binding.status = 'existing';
    binding.state = 'migrated';
    binding.canonicalAuthority = 'target';
    binding.fallback = 'removed';
    binding.parity = 'intentional-change';
    binding.evidence = ['soter/evidence/final-checker-transition.json'];
  }
  const removedInventory = {
    ...structuredClone(liveInventory),
    basis: {
      ...structuredClone(liveInventory.basis),
      fileCount: 1,
      treeFingerprint: fingerprintJson([{
        sourcePath: checkerItem.sourcePath,
        sourceFingerprint: checkerItem.sourceFingerprint
      }])
    },
    stateCounts: { mapped: 0, bridged: 0, migrated: 1, retired: 0 },
    bindingStateCounts: {
      mapped: 0,
      bridged: 0,
      migrated: checkerItem.targets.length,
      retired: 0
    },
    items: [checkerItem],
    inventoryFingerprint: null
  };
  removedInventory.inventoryFingerprint = fingerprintJson(removedInventory);
  writeJson(
    path.join(removedCheckerRoot, 'soter/migrations/legacy-inventory.json'),
    removedInventory
  );
  assert(!fs.existsSync(path.join(removedCheckerRoot, transition.source.path)));
  assert.equal(
    assertLegacyCheckerTransitionCurrent(removedCheckerRoot).transitionFingerprint,
    transition.transitionFingerprint
  );

  const incompleteTombstone = structuredClone(removedInventory);
  incompleteTombstone.items[0].targets[0].evidence = [];
  incompleteTombstone.inventoryFingerprint = null;
  incompleteTombstone.inventoryFingerprint = fingerprintJson(incompleteTombstone);
  writeJson(
    path.join(removedCheckerRoot, 'soter/migrations/legacy-inventory.json'),
    incompleteTombstone
  );
  expectCode(
    () => assertLegacyCheckerTransitionCurrent(removedCheckerRoot),
    'LEGACY_CHECKER_TRANSITION_SOURCE_INVALID'
  );
} finally {
  fs.rmSync(removedCheckerRoot, { recursive: true, force: true });
}

const duplicate = structuredClone(transition);
duplicate.rules[1].legacyCode = duplicate.rules[0].legacyCode;
expectCode(
  () => assertLegacyCheckerTransitionDocument(root, duplicate),
  'LEGACY_CHECKER_TRANSITION_COVERAGE_INVALID'
);

const missing = structuredClone(transition);
missing.rules.pop();
expectCode(
  () => assertLegacyCheckerTransitionDocument(root, missing),
  'LEGACY_CHECKER_TRANSITION_SCHEMA_INVALID'
);

const missingAnchor = structuredClone(transition);
missingAnchor.rules.find((rule) => rule.disposition === 'kernel-rule')
  .enforcements[0].anchors[0] = 'PLANTED_ABSENT_KERNEL_RULE';
expectCode(
  () => assertLegacyCheckerTransitionDocument(root, missingAnchor),
  'LEGACY_CHECKER_TRANSITION_TARGET_INVALID'
);

const implementationText = fs.readFileSync(path.join(root, 'soter/kernel/legacy-checker-transition.mjs'), 'utf8');
assert(!implementationText.includes("from './legacy-check.mjs'"));
assert(!implementationText.includes('spawnSync'));
assert(!implementationText.includes('reference.startsWith(fixturePrefix)'));
assert(implementationText.includes('CLAUDE_HOST_COMPLETION_BINDINGS'));

const single = makeFinalizationRoot();
try {
  const inventoryBefore = fs.readFileSync(
    path.join(single.temp, 'soter/migrations/legacy-inventory.json'),
    'utf8'
  );
  const migrationBefore = fs.readFileSync(path.join(single.temp, single.migrationPath), 'utf8');
  assert(!fs.existsSync(path.join(single.temp, single.transitions[0].finalEvidence[0])));
  const result = buildLegacyFinalizationCandidate(single.temp, single.transitions);
  assert.equal(result.contract, 'legacy-finalization-plan/v1');
  assert.equal(result.state, 'planned');
  assert.equal(result.authority.kind, 'none');
  assert.equal(result.authority.writesRepository, false);
  assert.equal(result.authority.deletesSources, false);
  assert.equal(result.authority.generatesEvidence, false);
  assert.equal(result.basis.legacyCheckerRun, null);
  assert.deepEqual(result.requiredOperationalDeletions, []);
  assert.deepEqual(result.requiredGovernedOutputs, []);
  assert.equal(result.summary.operationalDeletionCount, 0);
  assert.equal(result.summary.governedOutputCount, 0);
  assert.match(result.planFingerprint, /^sha256:[a-f0-9]{64}$/);
  const unsignedPlan = structuredClone(result);
  unsignedPlan.planFingerprint = null;
  assert.equal(result.planFingerprint, fingerprintJson(unsignedPlan));
  assert.deepEqual(result.deletePaths, [single.sourcePath]);
  assert.deepEqual(result.sourceDeletions, [{
    path: single.sourcePath,
    fingerprint: result.candidate.items[0].sourceFingerprint
  }]);
  assert.deepEqual(result.finalEvidencePaths, single.transitions[0].finalEvidence);
  assert.equal(result.migrationUpdates.length, 1);
  assert.equal(result.migrationUpdates[0].path, single.migrationPath);
  assert.equal(result.migrationUpdates[0].document.items[0].state, 'migrated');
  assert.deepEqual(
    result.migrationUpdates[0].document.items[0].evidence,
    single.transitions[0].finalEvidence
  );
  assert.equal(result.candidate.stateCounts.migrated, 1);
  assert.equal(result.candidate.bindingStateCounts.migrated, 1);
  assert.equal(result.candidate.items[0].sourcePresence, 'removed');
  assert.deepEqual(
    result.candidate.items[0].targets[0].evidence,
    single.transitions[0].finalEvidence
  );
  assert.equal(
    fs.readFileSync(path.join(single.temp, 'soter/migrations/legacy-inventory.json'), 'utf8'),
    inventoryBefore
  );
  assert.equal(fs.readFileSync(path.join(single.temp, single.migrationPath), 'utf8'), migrationBefore);
  assert(fs.existsSync(path.join(single.temp, single.sourcePath)));
  assert(!fs.existsSync(path.join(single.temp, single.transitions[0].finalEvidence[0])));

  expectCode(
    () => buildLegacyFinalizationCandidate(single.temp, [single.transitions[0], single.transitions[0]]),
    'LEGACY_FINALIZATION_TRANSITION_INVALID'
  );
  expectCode(
    () => buildLegacyFinalizationCandidate(single.temp, [{
      ...single.transitions[0],
      inventedEvidence: true
    }]),
    'LEGACY_FINALIZATION_TRANSITION_INVALID'
  );

  const wrongEvidencePath = 'soter/evidence/wrong-target-migration.json';
  const wrongEvidence = readJson(
    path.join(single.temp, single.transitions[0].authorizationEvidence[0])
  );
  wrongEvidence.id = 'evidence.wrong-target-migration';
  wrongEvidence.artifacts.find((artifact) => artifact.role === 'migration-target').fingerprint = HASH_B;
  writeJson(path.join(single.temp, wrongEvidencePath), wrongEvidence);
  expectCode(
    () => buildLegacyFinalizationCandidate(single.temp, [{
      ...single.transitions[0],
      authorizationEvidence: [wrongEvidencePath]
    }]),
    'LEGACY_FINALIZATION_AUTHORIZATION_EVIDENCE_INVALID'
  );

  const authorizationPath = single.transitions[0].authorizationEvidence[0];
  const authorizationBefore = fs.readFileSync(path.join(single.temp, authorizationPath), 'utf8');
  const exactAuthorization = readJson(path.join(single.temp, authorizationPath));
  const exactAuthorizationOverlay = [{
    path: authorizationPath,
    documentFingerprint: fingerprintJson(exactAuthorization),
    document: exactAuthorization
  }];
  const staleAuthorization = readJson(path.join(single.temp, authorizationPath));
  staleAuthorization.artifacts.find((artifact) => {
    return artifact.role === 'migration-target';
  }).fingerprint = HASH_B;
  writeJson(path.join(single.temp, authorizationPath), staleAuthorization);
  expectFailure(
    () => buildLegacyFinalizationCandidate(single.temp, single.transitions),
    /Legacy inventory .*evidence|exact migration-source and migration-target evidence/
  );
  const overlayResult = buildLegacyFinalizationCandidate(
    single.temp,
    single.transitions,
    null,
    exactAuthorizationOverlay
  );
  assert.equal(
    overlayResult.basis.authorizationEvidence.kind,
    'sealed-in-memory-overlay'
  );
  assert.equal(overlayResult.basis.authorizationEvidence.evidenceCount, 1);
  assert.equal(
    overlayResult.basis.authorizationEvidence.overlayFingerprint,
    fingerprintJson(exactAuthorizationOverlay)
  );
  expectCode(
    () => buildLegacyFinalizationCandidate(single.temp, single.transitions, null, []),
    'LEGACY_FINALIZATION_AUTHORIZATION_EVIDENCE_INVALID'
  );
  expectCode(
    () => buildLegacyFinalizationCandidate(single.temp, single.transitions, null, [{
      ...exactAuthorizationOverlay[0],
      documentFingerprint: HASH_A
    }]),
    'LEGACY_FINALIZATION_AUTHORIZATION_EVIDENCE_INVALID'
  );
  const wrongTargetOverlayDocument = structuredClone(exactAuthorization);
  wrongTargetOverlayDocument.artifacts.find((artifact) => {
    return artifact.role === 'migration-target';
  }).fingerprint = HASH_B;
  expectCode(
    () => buildLegacyFinalizationCandidate(single.temp, single.transitions, null, [{
      path: authorizationPath,
      documentFingerprint: fingerprintJson(wrongTargetOverlayDocument),
      document: wrongTargetOverlayDocument
    }]),
    'LEGACY_FINALIZATION_AUTHORIZATION_EVIDENCE_INVALID'
  );
  expectCode(
    () => buildLegacyFinalizationCandidate(single.temp, single.transitions, null, [
      ...exactAuthorizationOverlay,
      {
        path: 'soter/evidence/extra-migration.json',
        documentFingerprint: fingerprintJson(exactAuthorization),
        document: exactAuthorization
      }
    ]),
    'LEGACY_FINALIZATION_AUTHORIZATION_EVIDENCE_INVALID'
  );
  fs.writeFileSync(path.join(single.temp, authorizationPath), authorizationBefore);

  expectCode(
    () => buildLegacyFinalizationCandidate(single.temp, [{
      ...single.transitions[0],
      finalEvidence: [
        single.transitions[0].finalEvidence[0],
        single.transitions[0].finalEvidence[0]
      ]
    }]),
    'LEGACY_FINALIZATION_TRANSITION_INVALID'
  );
  expectCode(
    () => buildLegacyFinalizationCandidate(single.temp, [{
      ...single.transitions[0],
      finalEvidence: [...single.transitions[0].authorizationEvidence]
    }]),
    'LEGACY_FINALIZATION_FINAL_EVIDENCE_COLLISION'
  );
  expectCode(
    () => buildLegacyFinalizationCandidate(single.temp, [{
      ...single.transitions[0],
      finalEvidence: ['soter/contracts/not-final-evidence.json']
    }]),
    'LEGACY_FINALIZATION_FINAL_EVIDENCE_PATH_INVALID'
  );

  const wrongMigration = readJson(path.join(single.temp, single.migrationPath));
  wrongMigration.items[0].targetPack = 'kernel.wrong';
  writeJson(path.join(single.temp, single.migrationPath), wrongMigration);
  expectCode(
    () => buildLegacyFinalizationCandidate(single.temp, single.transitions),
    'LEGACY_FINALIZATION_MIGRATION_BINDING_INVALID'
  );
  fs.writeFileSync(path.join(single.temp, single.migrationPath), migrationBefore);

  for (const transitionItem of single.transitions) {
    const authorization = readJson(path.join(
      single.temp,
      transitionItem.authorizationEvidence[0]
    ));
    writeJson(path.join(single.temp, transitionItem.finalEvidence[0]), authorization);
  }
  fs.rmSync(path.join(single.temp, single.sourcePath));
  writeJson(path.join(single.temp, 'soter/migrations/legacy-inventory.json'), result.candidate);
  for (const update of result.migrationUpdates) {
    writeJson(path.join(single.temp, update.path), update.document);
  }
  const finalized = assertLegacyInventoryCurrent(single.temp);
  assert.equal(finalized.items[0].sourceFingerprint, result.candidate.items[0].sourceFingerprint);
  assert.equal(finalized.items[0].targets[0].canonicalAuthority, 'target');
  assert.equal(finalized.items[0].targets[0].fallback, 'removed');
} finally {
  fs.rmSync(single.temp, { recursive: true, force: true });
}

const sharedEvidence = makeFinalizationRoot({ sharedOwners: true });
try {
  const sharedResult = buildLegacyFinalizationCandidate(
    sharedEvidence.temp,
    sharedEvidence.transitions
  );
  assert.equal(sharedResult.bindingTransitions.length, 2);
  assert.equal(sharedResult.finalEvidencePaths.length, 2);
  assert.deepEqual(
    sharedResult.finalEvidencePaths,
    [...sharedEvidence.transitions[0].finalEvidence].sort()
  );
  assert.equal(sharedResult.summary.finalEvidenceOutputCount, 2);
  assert.equal(sharedResult.summary.sourceDeletionCount, 2);
  assert.equal(sharedResult.migrationUpdates[0].document.items.length, 2);

  for (const incompatible of [
    { targetId: 'kernel.other-target' },
    { sourcePath: '.claude/rules/not-a-workflow-source.md' },
    { state: 'retired' },
    { parity: 'intentional-change' },
    { finalEvidence: [sharedEvidence.transitions[1].finalEvidence[0]] }
  ]) {
    expectCode(
      () => buildLegacyFinalizationCandidate(sharedEvidence.temp, [
        sharedEvidence.transitions[0],
        { ...sharedEvidence.transitions[1], ...incompatible }
      ]),
      'LEGACY_FINALIZATION_FINAL_EVIDENCE_COLLISION'
    );
  }
  expectCode(
    () => buildLegacyFinalizationCandidate(sharedEvidence.temp, [
      sharedEvidence.transitions[0],
      {
        ...sharedEvidence.transitions[1],
        finalEvidence: sharedEvidence.transitions[1].finalEvidence.map((evidencePath, index) => {
          return index === 0 ? evidencePath.replace('shared-', 'Shared-') : evidencePath;
        })
      }
    ]),
    'LEGACY_FINALIZATION_FINAL_EVIDENCE_COLLISION'
  );
} finally {
  fs.rmSync(sharedEvidence.temp, { recursive: true, force: true });
}

const multiple = makeFinalizationRoot({ multipleTargets: true });
try {
  expectCode(
    () => buildLegacyFinalizationCandidate(multiple.temp, [multiple.transitions[0]]),
    'LEGACY_FINALIZATION_PARTIAL_SOURCE'
  );
  expectCode(
    () => buildLegacyFinalizationCandidate(multiple.temp, [
      multiple.transitions[0],
      {
        ...multiple.transitions[1],
        finalEvidence: [...multiple.transitions[0].finalEvidence]
      }
    ]),
    'LEGACY_FINALIZATION_FINAL_EVIDENCE_COLLISION'
  );
  expectCode(
    () => buildLegacyFinalizationCandidate(multiple.temp, [
      multiple.transitions[0],
      {
        ...multiple.transitions[1],
        finalEvidence: [multiple.transitions[0].finalEvidence[0].replace('example-', 'Example-')]
      }
    ]),
    'LEGACY_FINALIZATION_FINAL_EVIDENCE_COLLISION'
  );
  const result = buildLegacyFinalizationCandidate(multiple.temp, multiple.transitions);
  const reordered = buildLegacyFinalizationCandidate(
    multiple.temp,
    [...multiple.transitions].reverse()
  );
  const overlay = authorizationOverlay(multiple.temp, multiple.transitions);
  const overlayResult = buildLegacyFinalizationCandidate(
    multiple.temp,
    multiple.transitions,
    null,
    overlay
  );
  const reorderedOverlayResult = buildLegacyFinalizationCandidate(
    multiple.temp,
    multiple.transitions,
    null,
    [...overlay].reverse()
  );
  assert.equal(reordered.planFingerprint, result.planFingerprint);
  assert.equal(reorderedOverlayResult.planFingerprint, overlayResult.planFingerprint);
  assert.equal(result.candidate.bindingStateCounts.migrated, 2);
  assert.equal(result.candidate.items[0].sourcePresence, 'removed');
  assert.equal(result.migrationUpdates.length, 1);
  assert.equal(result.migrationUpdates[0].document.items.length, 2);
  assert.equal(result.finalEvidencePaths.length, 2);
} finally {
  fs.rmSync(multiple.temp, { recursive: true, force: true });
}

const mixedExistingAndNewEvidence = makeFinalizationRoot({
  multipleTargets: true,
  existingFinalBinding: true
});
try {
  const result = buildLegacyFinalizationCandidate(
    mixedExistingAndNewEvidence.temp,
    mixedExistingAndNewEvidence.transitions
  );
  assert.equal(result.bindingTransitions.length, 1);
  assert.deepEqual(result.finalEvidencePaths, [
    'soter/fixtures/finalization/example-1.evidence.json',
    'soter/fixtures/finalization/existing-final.evidence.json'
  ]);
  assert.equal(result.summary.finalEvidenceOutputCount, 2);
  assert.deepEqual(
    [...new Set(result.candidate.items.flatMap((item) => {
      return item.targets.flatMap((binding) => binding.evidence);
    }))].sort(),
    result.finalEvidencePaths
  );
} finally {
  fs.rmSync(mixedExistingAndNewEvidence.temp, { recursive: true, force: true });
}

const blockers = inspectLegacyFinalizationBlockers(root);
assert.equal(
  blockers.remaining.inventoryArtifacts,
  blockers.current.stateCounts.mapped + blockers.current.stateCounts.bridged
);
assert.equal(
  blockers.remaining.inventoryBindings,
  blockers.current.bindingStateCounts.mapped + blockers.current.bindingStateCounts.bridged
);
assert(blockers.items.every((item) => item.sourceBlockers.length || item.bindings.length));
const hostCleanup = blockers.cleanupDecisions.find((item) => {
  return item.id === 'claude-host-projection-configuration-reframe';
});
assert(hostCleanup);
assert.equal(hostCleanup.state, 'complete');
assert.equal(hostCleanup.reasonCode, 'LEGACY_HOST_CONFIGURATION_REFRAME_COMPLETE');
assert.deepEqual(hostCleanup.blockers, []);
assert.equal(hostCleanup.exactBindingSet, true);
assert.equal(hostCleanup.bindings.length, 8);
assert.equal(hostCleanup.bindings.filter((binding) => {
  return binding.sourcePresence === 'removed'
    && ['migrated', 'retired'].includes(binding.sourceState)
    && ['migrated', 'retired'].includes(binding.state)
    && binding.fallback === 'removed'
    && binding.evidence.length > 0;
}).length, 8);
const legacyHostConfigurationPath = 'soter/configurations/'
  + ['legacy', 'claude', 'host'].join('-') + '.config.json';
if (fs.existsSync(path.join(root, legacyHostConfigurationPath))) {
  assert(hostCleanup.exactReferences.includes(legacyHostConfigurationPath));
} else {
  assert(!hostCleanup.exactReferences.includes(legacyHostConfigurationPath));
  assert(fs.existsSync(path.join(root, 'soter/configurations/claude-host-projection.config.json')));
}
assert.deepEqual(hostCleanup.exactOperationalReferences, []);
assert.deepEqual(hostCleanup.historicalGuardReferences, [
  'soter/core/fixtures.mjs',
  'soter/core/legacy-finalization.selftest.mjs',
  'soter/core/legacy-transition-finalization.selftest.mjs'
]);
assert.equal(hostCleanup.historicalProvenance.renameHistoricalSourcePaths, false);
assert.equal(hostCleanup.finalization.automaticPromotion, false);
const checkerRemoval = blockers.cleanupDecisions.find((item) => {
  return item.id === 'legacy-checker-operational-removal';
});
assert(checkerRemoval);
assert.equal(checkerRemoval.state, 'complete');
assert.equal(checkerRemoval.reasonCode, 'LEGACY_CHECKER_RECEIPT_GATED_CUTOVER_COMPLETE');
assert.deepEqual(checkerRemoval.blockers, []);
assert.equal(checkerRemoval.targetOnlyReplacement.invokesLegacyChecker, false);
assert.equal(checkerRemoval.bindings.length, 2);
assert.equal(
  checkerRemoval.immutableSource.finalRunRecorded,
  checkerRemoval.immutableSource.receipt !== null
    || checkerRemoval.immutableSource.governedProjection !== null
);
assert.deepEqual(
  checkerRemoval.requiredOperationalDeletions.map((entry) => entry.path),
  [
    '.claude-plugin/marketplace.json',
    '.codex/config.toml',
    'AGENTS.md',
    'CLAUDE.md',
    'soter/kernel/legacy-check.mjs'
  ]
);
assert(!checkerRemoval.exactOperationalReferences.includes('package.json'));
assert.deepEqual(checkerRemoval.historicalGuardReferences, [
  'soter/core/legacy-finalization.mjs',
  'soter/core/legacy-finalization.selftest.mjs',
  'soter/core/repository-cutover.mjs',
  'soter/kernel/legacy-checker-transition.mjs',
  'soter/kernel/legacy-checker-transition.selftest.mjs'
]);
const sourceDependentLegacyCheckerCliRoutes = [
  ['legacy', 'checker', 'pre', 'removal', 'inspect'].join('-'),
  ['legacy', 'checker', 'pre', 'removal', 'run'].join('-'),
  ['legacy', 'checker', 'receipt', 'current'].join('-')
];
const coreCliSource = fs.readFileSync(path.join(root, 'soter/core/cli.mjs'), 'utf8');
for (const route of sourceDependentLegacyCheckerCliRoutes) {
  assert(
    !coreCliSource.includes(route),
    `deleted legacy checker source remains reachable through CLI route ${route}`
  );
}
const packageDocument = readJson(path.join(root, 'package.json'));
assert(!Object.hasOwn(packageDocument.scripts, 'soter:legacy-check'));
assert(!Object.hasOwn(packageDocument.scripts, 'soter:legacy-check:selftest'));
assert.equal(
  packageDocument.scripts['soter:legacy-transition:check'],
  'node soter/kernel/legacy-checker-transition.mjs'
);
assert.equal(
  packageDocument.scripts['soter:legacy-transition:selftest'],
  'node soter/kernel/legacy-checker-transition.selftest.mjs'
);
const continuousIntegration = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
assert(!continuousIntegration.includes(['.claude', 'scripts', 'check.mjs'].join('/')));
assert(continuousIntegration.includes('soter:legacy-transition:selftest'));
assert(continuousIntegration.includes('soter:legacy-transition:check'));
for (const documentPath of ['README.md', 'ARCHITECTURE.md', 'CONTRACTS.md', 'soter/README.md']) {
  assert(!fs.readFileSync(path.join(root, documentPath), 'utf8').includes(
    ['soter', 'kernel', 'legacy-check.mjs'].join('/')
  ));
}
const legacyCheckerFileExists = fs.existsSync(
  path.join(root, 'soter', 'kernel', 'legacy-check.mjs')
);
const kernelPack = readJson(path.join(root, 'soter/packs/kernel.soter/pack.json'));
const kernelPackReferencesLegacyChecker = kernelPack.artifacts.some((artifact) => {
  return artifact.path === 'soter/kernel/legacy-check.mjs';
});
assert.equal(
  kernelPackReferencesLegacyChecker,
  false,
  'the retained pre-cutover checker file must have no Kernel pack/runtime authority'
);
assert(!checkerRemoval.exactOperationalReferences.includes('soter/packs/kernel.soter/pack.json'));
const legacyCheckerDeletion = checkerRemoval.requiredOperationalDeletions.find((entry) => {
  return entry.path === 'soter/kernel/legacy-check.mjs';
});
assert(legacyCheckerDeletion);
assert.equal(
  legacyCheckerDeletion.state,
  legacyCheckerFileExists ? 'present' : 'absent',
  'source-file presence and Kernel pack/runtime authority are independent transition facts'
);

process.stdout.write(
  'Legacy checker transition selftest: exact 47-code coverage, replacement anchors, explicit retirements, present-source and removed-source tombstone validation, no legacy-checker runtime dependency, receipt-and-governed-projection-gated authorization-versus-final evidence planning, deterministic inventory/migration/source-deletion plans, workflow-guide/evaluation-only compatible shared-evidence outputs, hostile cross-owner/partial-set/case collisions, exact eight-binding host-configuration reframe, complete tracked operational-output removal accounting, and blocker accounting passed.\n'
);
