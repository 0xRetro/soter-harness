#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fingerprintWorkflowGuideContent
} from '../kernel/workflow-guides.mjs';
import {
  assertLegacyNonworkflowFinalDispositions,
  buildLegacyFinalizationTransitionRequest,
  deriveLegacyWorkflowTransitions,
  legacyTransitionRootIdentity,
  readLegacyFinalizationTransitionRequest
} from './legacy-transition-finalization.mjs';
import {
  planLegacyFinalizationObsoleteFixturePaths
} from './fixtures.mjs';
import {
  fingerprintJson,
  readJson,
  sha256
} from './lib/canonical-json.mjs';
import {
  developmentWorkflowLifecycleFinalizationContract
} from './development-workflow-lifecycle-finalization.mjs';
import {
  assertLegacyInventoryStructureCurrent
} from '../kernel/legacy-inventory.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function expectCode(run, code) {
  assert.throws(run, (error) => error?.code === code, code);
}

async function expectAsyncCode(run, code) {
  await assert.rejects(run, (error) => error?.code === code, code);
}

function workflowFiles(root, workflowId) {
  const slug = workflowId.slice('automation.'.length);
  const paths = {
    definition: `soter/automations/${slug}/definition.json`,
    evaluations: `soter/automations/${slug}/evaluations.json`,
    guide: `soter/automations/${slug}/guide.json`
  };
  return {
    paths,
    definition: readJson(path.join(root, paths.definition)),
    evaluations: readJson(path.join(root, paths.evaluations)),
    guide: readJson(path.join(root, paths.guide))
  };
}

function syntheticLifecycleCandidate(root) {
  const request = {
    $contract: developmentWorkflowLifecycleFinalizationContract.request,
    requestFingerprint: fingerprintJson({ request: 'synthetic-read-only-lifecycle' })
  };
  const files = [];
  const workflows = [];
  for (const workflowId of [
    ...developmentWorkflowLifecycleFinalizationContract.activeWorkflows,
    ...developmentWorkflowLifecycleFinalizationContract.retiredWorkflows
  ].sort(compareCodepoint)) {
    const current = workflowFiles(root, workflowId);
    const after = structuredClone(current);
    after.definition.source.presence = 'removed';
    after.guide.source.presence = 'removed';
    after.evaluations.cases.forEach((testCase) => {
      testCase.source.presence = 'removed';
    });
    const active = developmentWorkflowLifecycleFinalizationContract.activeWorkflows
      .includes(workflowId);
    const slug = workflowId.slice('automation.'.length);
    const parity = active
      && current.guide.source.normalization
        === 'behavior-preserving-with-explicit-authority-boundary'
      ? 'passed'
      : 'intentional-change';
    const evidence = active
      ? ['claude', 'codex'].map((host) => ({
          host,
          path: `soter/evidence/development/development-agent-migration-evidence.${host}.${slug}.json`,
          fingerprint: fingerprintJson({ workflowId, host, kind: 'historical' })
        }))
      : [{
          path: `soter/fixtures/harness-development-catalog/${slug}.intentional-retirement.evidence.json`
        }];
    if (active) {
      after.definition.lifecycle.activation = {
        state: 'active',
        reasonCode: 'WORKFLOW_HOST_GUIDANCE_ACTIVE',
        proceduralAuthority: 'target',
        delivery: 'host-skill',
        behaviorParity: parity,
        evidence: structuredClone(evidence),
        permittedNextAction: 'invoke-through-selected-host'
      };
      after.guide.status = {
        state: 'active',
        reasonCode: 'WORKFLOW_GUIDE_ACTIVE',
        proceduralAuthority: 'target',
        behaviorParity: parity,
        delivery: 'host-skill',
        evidence: structuredClone(evidence),
        permittedNextAction: 'invoke-through-selected-host'
      };
      after.evaluations.lifecycle = {
        state: 'active-host-guided',
        activation: 'active',
        authority: 'request-bound-development-evidence',
        permittedNextAction: 'run-exact-evaluation-suite'
      };
    } else {
      after.definition.lifecycle.retirement = {
        state: 'complete',
        reasonCode: 'WORKFLOW_RETIRED',
        proceduralAuthority: 'none',
        fallback: 'removed',
        evidence: structuredClone(evidence),
        permittedNextAction: 'inspect-replacement'
      };
      after.guide.status = {
        state: 'retired',
        reasonCode: 'WORKFLOW_GUIDE_RETIRED',
        proceduralAuthority: 'none',
        behaviorParity: 'intentional-change',
        delivery: 'unavailable',
        evidence: structuredClone(evidence),
        permittedNextAction: 'inspect-replacement'
      };
      after.evaluations.lifecycle = {
        state: 'retired',
        retirement: 'complete',
        authority: 'none',
        permittedNextAction: 'inspect-replacement'
      };
    }
    after.guide.workflow.definitionFingerprint = fingerprintJson(after.definition);
    after.guide.workflow.evaluationSetFingerprint = fingerprintJson(after.evaluations);
    after.guide.contentFingerprint = fingerprintWorkflowGuideContent(after.guide);
    workflows.push({
      id: workflowId,
      disposition: active ? 'active' : 'retired',
      parity
    });
    for (const kind of ['definition', 'evaluations', 'guide']) {
      files.push({
        kind,
        path: current.paths[kind],
        before: current[kind],
        beforeFingerprint: fingerprintJson(current[kind]),
        beforeFileFingerprint: sha256(canonicalBytes(current[kind])),
        after: after[kind],
        afterFingerprint: fingerprintJson(after[kind]),
        afterFileFingerprint: sha256(canonicalBytes(after[kind])),
        mode: '0644'
      });
    }
  }
  const plan = {
    contract: 'development-workflow-lifecycle-finalization-plan/v1',
    requestFingerprint: request.requestFingerprint,
    workflows,
    files: files.map(({ before: _before, after: _after, ...file }) => file),
    authority: {
      repositoryWrites: false,
      sourceDeletion: false,
      fallbackRemoval: false
    },
    planFingerprint: null
  };
  plan.planFingerprint = fingerprintJson(plan);
  return { request, plan, files };
}

function resignLifecycleAfter(candidate, row) {
  row.afterFingerprint = fingerprintJson(row.after);
  row.afterFileFingerprint = sha256(canonicalBytes(row.after));
  const planned = candidate.plan.files.find((file) => {
    return file.kind === row.kind && file.path === row.path;
  });
  planned.afterFingerprint = row.afterFingerprint;
  planned.afterFileFingerprint = row.afterFileFingerprint;
  candidate.plan.planFingerprint = null;
  candidate.plan.planFingerprint = fingerprintJson(candidate.plan);
}

function writeFixture(root, relativePath, value) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

export async function selftestLegacyTransitionFinalization(root = defaultRoot) {
  const currentInventory = assertLegacyInventoryStructureCurrent(root);
  const currentBindings = currentInventory.items.flatMap((item) => item.targets);
  const currentUnfinished = currentBindings.filter((binding) => {
    return ['mapped', 'bridged'].includes(binding.state);
  });
  if (currentUnfinished.length === 0) {
    const declaration = readJson(path.join(
      root,
      'soter/migrations/legacy-nonworkflow-final-dispositions.json'
    ));
    const unsignedDeclaration = structuredClone(declaration);
    unsignedDeclaration.declarationFingerprint = null;
    assert.equal(currentInventory.items.length, 143);
    assert.equal(currentInventory.items.every((item) => item.sourcePresence === 'removed'), true);
    assert.equal(currentBindings.length, 221);
    assert.equal(currentBindings.filter((binding) => binding.state === 'migrated').length, 197);
    assert.equal(currentBindings.filter((binding) => binding.state === 'retired').length, 24);
    assert.equal(declaration.rows.length, 66);
    assert.equal(declaration.summary.migrated, 55);
    assert.equal(declaration.summary.retired, 11);
    assert.equal(
      declaration.declarationFingerprint,
      fingerprintJson(unsignedDeclaration),
      'The sealed pre-cutover non-workflow disposition basis changed after cutover.'
    );
    expectCode(
      () => assertLegacyNonworkflowFinalDispositions(root),
      'LEGACY_NONWORKFLOW_DISPOSITIONS_BASIS_INVALID'
    );
    process.stdout.write(
      'Legacy transition finalization selftest passed: the sealed pre-cutover disposition '
        + 'basis remains inspectable while the current 143-source/221-binding inventory is '
        + 'fully finalized and rejects transition re-entry.\n'
    );
    return true;
  }
  const basis = assertLegacyNonworkflowFinalDispositions(root);
  assert.equal(basis.declaration.rows.length, 66);
  assert.equal(basis.declaration.summary.migrated, 55);
  assert.equal(basis.declaration.summary.retired, 11);
  assert.equal(basis.directKeys.size, 42);
  assert.equal(basis.unfinished.length, 108);

  const reordered = structuredClone(basis.declaration);
  [reordered.rows[0], reordered.rows[1]] = [reordered.rows[1], reordered.rows[0]];
  reordered.declarationFingerprint = null;
  reordered.declarationFingerprint = fingerprintJson(reordered);
  expectCode(
    () => assertLegacyNonworkflowFinalDispositions(root, reordered),
    'LEGACY_NONWORKFLOW_DISPOSITIONS_ROW_INVALID'
  );

  const substituted = structuredClone(basis.declaration);
  substituted.rows[0].sourceFingerprint = 'sha256:' + 'a'.repeat(64);
  substituted.declarationFingerprint = null;
  substituted.declarationFingerprint = fingerprintJson(substituted);
  expectCode(
    () => assertLegacyNonworkflowFinalDispositions(root, substituted),
    'LEGACY_NONWORKFLOW_DISPOSITIONS_ROW_INVALID'
  );

  const wrongRetirement = structuredClone(basis.declaration);
  const migratedRow = wrongRetirement.rows.find((row) => row.state === 'migrated');
  migratedRow.state = 'retired';
  migratedRow.reasonCode = 'UNSUPPORTED_CLAUDE_DELIVERY_INTENTIONALLY_RETIRED';
  wrongRetirement.declarationFingerprint = null;
  wrongRetirement.declarationFingerprint = fingerprintJson(wrongRetirement);
  expectCode(
    () => assertLegacyNonworkflowFinalDispositions(root, wrongRetirement),
    'LEGACY_NONWORKFLOW_DISPOSITIONS_ROW_INVALID'
  );

  const lifecycle = syntheticLifecycleCandidate(root);
  const workflowTransitions = deriveLegacyWorkflowTransitions(root, lifecycle, basis.inventory);
  assert.equal(workflowTransitions.length, 42);
  assert.equal(workflowTransitions.filter((row) => row.state === 'migrated').length, 30);
  assert.equal(workflowTransitions.filter((row) => row.state === 'retired').length, 12);
  assert.equal(workflowTransitions.filter((row) => row.parity === 'proven').length, 26);
  assert.equal(
    workflowTransitions.filter((row) => row.parity === 'intentional-change').length,
    16
  );
  assert.equal(
    new Set(workflowTransitions.flatMap((row) => row.finalEvidence)).size,
    17
  );
  const auditingTransitions = workflowTransitions.filter(
    (row) => row.targetId === 'automation.auditing-a-schema-doc'
  );
  assert(
    auditingTransitions.every((row) => row.parity === 'proven')
  );
  assert.deepEqual(
    [...new Set(auditingTransitions.flatMap((row) => row.finalEvidence))],
    [
      'soter/evidence/development/evidence.development-activation.claude.auditing-a-schema-doc.json',
      'soter/evidence/development/evidence.development-activation.codex.auditing-a-schema-doc.json'
    ]
  );
  assert(
    workflowTransitions.every((row) => row.finalEvidence.every((evidencePath) => {
      return !evidencePath.includes('development-agent-migration-evidence');
    }))
  );
  const validatingTransitions = workflowTransitions.filter(
    (row) => row.targetId === 'automation.validating-resources'
  );
  assert(
    validatingTransitions.every((row) => {
      return row.state === 'migrated' && row.parity === 'intentional-change';
    })
  );
  const writingAdrTransitions = workflowTransitions.filter(
    (row) => row.targetId === 'automation.writing-adrs'
  );
  assert(
    writingAdrTransitions.every((row) => {
      return row.state === 'retired'
        && row.parity === 'intentional-change'
        && row.finalEvidence.length === 1
        && row.finalEvidence[0]
          === 'soter/fixtures/harness-development-catalog/writing-adrs.intentional-retirement.evidence.json';
    })
  );
  const exactCombinedTransitions = [
    ...workflowTransitions,
    ...basis.declaration.rows
  ];
  assert.equal(exactCombinedTransitions.length, 108);
  assert.equal(exactCombinedTransitions.filter((row) => row.state === 'migrated').length, 85);
  assert.equal(exactCombinedTransitions.filter((row) => row.state === 'retired').length, 23);
  assert.equal(new Set(exactCombinedTransitions.map((row) => row.sourcePath)).size, 79);
  for (const [workflowId, parity] of [
    ['automation.auditing-a-schema-doc', 'intentional-change'],
    ['automation.validating-resources', 'passed'],
    ['automation.writing-adrs', 'passed']
  ]) {
    const crossedParity = structuredClone(lifecycle);
    crossedParity.plan.workflows.find((row) => row.id === workflowId).parity = parity;
    crossedParity.plan.planFingerprint = null;
    crossedParity.plan.planFingerprint = fingerprintJson(crossedParity.plan);
    expectCode(
      () => deriveLegacyWorkflowTransitions(root, crossedParity, basis.inventory),
      'LEGACY_FINALIZATION_LIFECYCLE_INVALID'
    );
  }
  const crossedHistoricalPath = structuredClone(lifecycle);
  const crossedHistoricalGuide = crossedHistoricalPath.files.find((row) => {
    return row.kind === 'guide'
      && row.path === 'soter/automations/auditing-a-schema-doc/guide.json';
  }).after;
  const crossedHistoricalDefinition = crossedHistoricalPath.files.find((row) => {
    return row.kind === 'definition'
      && row.path === 'soter/automations/auditing-a-schema-doc/definition.json';
  }).after;
  crossedHistoricalGuide.status.evidence[0].path
    = 'soter/evidence/development/development-agent-migration-evidence.claude.forge.json';
  crossedHistoricalDefinition.lifecycle.activation.evidence = structuredClone(
    crossedHistoricalGuide.status.evidence
  );
  crossedHistoricalGuide.workflow.definitionFingerprint = fingerprintJson(
    crossedHistoricalDefinition
  );
  crossedHistoricalGuide.contentFingerprint = fingerprintWorkflowGuideContent(
    crossedHistoricalGuide
  );
  resignLifecycleAfter(
    crossedHistoricalPath,
    crossedHistoricalPath.files.find((row) => row.after === crossedHistoricalDefinition)
  );
  resignLifecycleAfter(
    crossedHistoricalPath,
    crossedHistoricalPath.files.find((row) => row.after === crossedHistoricalGuide)
  );
  expectCode(
    () => deriveLegacyWorkflowTransitions(
      root,
      crossedHistoricalPath,
      basis.inventory
    ),
    'LEGACY_FINALIZATION_LIFECYCLE_INVALID'
  );

  const duplicateHistoricalHost = structuredClone(lifecycle);
  const duplicateHistoricalGuide = duplicateHistoricalHost.files.find((row) => {
    return row.kind === 'guide'
      && row.path === 'soter/automations/auditing-a-schema-doc/guide.json';
  }).after;
  const duplicateHistoricalDefinition = duplicateHistoricalHost.files.find((row) => {
    return row.kind === 'definition'
      && row.path === 'soter/automations/auditing-a-schema-doc/definition.json';
  }).after;
  duplicateHistoricalGuide.status.evidence[1] = structuredClone(
    duplicateHistoricalGuide.status.evidence[0]
  );
  duplicateHistoricalDefinition.lifecycle.activation.evidence = structuredClone(
    duplicateHistoricalGuide.status.evidence
  );
  duplicateHistoricalGuide.workflow.definitionFingerprint = fingerprintJson(
    duplicateHistoricalDefinition
  );
  duplicateHistoricalGuide.contentFingerprint = fingerprintWorkflowGuideContent(
    duplicateHistoricalGuide
  );
  resignLifecycleAfter(
    duplicateHistoricalHost,
    duplicateHistoricalHost.files.find((row) => row.after === duplicateHistoricalDefinition)
  );
  resignLifecycleAfter(
    duplicateHistoricalHost,
    duplicateHistoricalHost.files.find((row) => row.after === duplicateHistoricalGuide)
  );
  expectCode(
    () => deriveLegacyWorkflowTransitions(
      root,
      duplicateHistoricalHost,
      basis.inventory
    ),
    'LEGACY_FINALIZATION_LIFECYCLE_INVALID'
  );

  const mismatchedDefinitionEvidence = structuredClone(lifecycle);
  const mismatchedDefinitionRow = mismatchedDefinitionEvidence.files.find((row) => {
    return row.kind === 'definition'
      && row.path === 'soter/automations/auditing-a-schema-doc/definition.json';
  });
  mismatchedDefinitionRow.after.lifecycle.activation.evidence[0].fingerprint = fingerprintJson({
    kind: 'substituted-definition-evidence'
  });
  const mismatchedDefinitionGuideRow = mismatchedDefinitionEvidence.files.find((row) => {
    return row.kind === 'guide'
      && row.path === 'soter/automations/auditing-a-schema-doc/guide.json';
  });
  mismatchedDefinitionGuideRow.after.workflow.definitionFingerprint = fingerprintJson(
    mismatchedDefinitionRow.after
  );
  mismatchedDefinitionGuideRow.after.contentFingerprint = fingerprintWorkflowGuideContent(
    mismatchedDefinitionGuideRow.after
  );
  resignLifecycleAfter(mismatchedDefinitionEvidence, mismatchedDefinitionRow);
  resignLifecycleAfter(mismatchedDefinitionEvidence, mismatchedDefinitionGuideRow);
  expectCode(
    () => deriveLegacyWorkflowTransitions(
      root,
      mismatchedDefinitionEvidence,
      basis.inventory
    ),
    'LEGACY_FINALIZATION_LIFECYCLE_INVALID'
  );

  const substitutedRetirementEvidence = structuredClone(lifecycle);
  const substitutedRetirementGuide = substitutedRetirementEvidence.files.find((row) => {
    return row.kind === 'guide'
      && row.path === 'soter/automations/writing-adrs/guide.json';
  }).after;
  const substitutedRetirementDefinition = substitutedRetirementEvidence.files.find((row) => {
    return row.kind === 'definition'
      && row.path === 'soter/automations/writing-adrs/definition.json';
  }).after;
  substitutedRetirementGuide.status.evidence[0].path
    = 'soter/fixtures/harness-development-catalog/forge.intentional-retirement.evidence.json';
  substitutedRetirementDefinition.lifecycle.retirement.evidence = structuredClone(
    substitutedRetirementGuide.status.evidence
  );
  substitutedRetirementGuide.workflow.definitionFingerprint = fingerprintJson(
    substitutedRetirementDefinition
  );
  substitutedRetirementGuide.contentFingerprint = fingerprintWorkflowGuideContent(
    substitutedRetirementGuide
  );
  resignLifecycleAfter(
    substitutedRetirementEvidence,
    substitutedRetirementEvidence.files.find(
      (row) => row.after === substitutedRetirementDefinition
    )
  );
  resignLifecycleAfter(
    substitutedRetirementEvidence,
    substitutedRetirementEvidence.files.find((row) => row.after === substitutedRetirementGuide)
  );
  expectCode(
    () => deriveLegacyWorkflowTransitions(
      root,
      substitutedRetirementEvidence,
      basis.inventory
    ),
    'LEGACY_FINALIZATION_LIFECYCLE_INVALID'
  );

  const substitutedWorkflowIdentity = structuredClone(lifecycle);
  const substitutedGuideRow = substitutedWorkflowIdentity.files.find((row) => {
    return row.kind === 'guide'
      && row.path === 'soter/automations/auditing-a-schema-doc/guide.json';
  });
  substitutedGuideRow.after.workflow.id = 'automation.substituted-workflow';
  substitutedGuideRow.after.contentFingerprint = fingerprintWorkflowGuideContent(
    substitutedGuideRow.after
  );
  resignLifecycleAfter(substitutedWorkflowIdentity, substitutedGuideRow);
  expectCode(
    () => deriveLegacyWorkflowTransitions(
      root,
      substitutedWorkflowIdentity,
      basis.inventory
    ),
    'LEGACY_FINALIZATION_LIFECYCLE_INVALID'
  );

  const contradictoryActiveState = structuredClone(lifecycle);
  const contradictoryDefinitionRow = contradictoryActiveState.files.find((row) => {
    return row.kind === 'definition'
      && row.path === 'soter/automations/auditing-a-schema-doc/definition.json';
  });
  contradictoryDefinitionRow.after.lifecycle.state = 'retired';
  resignLifecycleAfter(contradictoryActiveState, contradictoryDefinitionRow);
  expectCode(
    () => deriveLegacyWorkflowTransitions(
      root,
      contradictoryActiveState,
      basis.inventory
    ),
    'LEGACY_FINALIZATION_LIFECYCLE_INVALID'
  );

  const contradictoryGuideReason = structuredClone(lifecycle);
  const contradictoryGuideRow = contradictoryGuideReason.files.find((row) => {
    return row.kind === 'guide'
      && row.path === 'soter/automations/auditing-a-schema-doc/guide.json';
  });
  contradictoryGuideRow.after.status.reasonCode = 'WORKFLOW_GUIDE_RETIRED';
  contradictoryGuideRow.after.contentFingerprint = fingerprintWorkflowGuideContent(
    contradictoryGuideRow.after
  );
  resignLifecycleAfter(contradictoryGuideReason, contradictoryGuideRow);
  expectCode(
    () => deriveLegacyWorkflowTransitions(
      root,
      contradictoryGuideReason,
      basis.inventory
    ),
    'LEGACY_FINALIZATION_LIFECYCLE_INVALID'
  );

  const crossedLifecycle = structuredClone(lifecycle);
  const crossedLifecycleGuideRow = crossedLifecycle.files.find((row) => row.kind === 'guide');
  crossedLifecycleGuideRow.after.source.legacyFingerprint = 'sha256:' + 'b'.repeat(64);
  crossedLifecycleGuideRow.after.contentFingerprint = fingerprintWorkflowGuideContent(
    crossedLifecycleGuideRow.after
  );
  resignLifecycleAfter(crossedLifecycle, crossedLifecycleGuideRow);
  expectCode(
    () => deriveLegacyWorkflowTransitions(root, crossedLifecycle, basis.inventory),
    'LEGACY_FINALIZATION_LIFECYCLE_BINDING_INVALID'
  );

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-obsolete-fixture-plan-'));
  try {
    const currentPath = 'soter/fixtures/harness-development-catalog/current.bridge.evidence.json';
    const retainedPath = 'soter/fixtures/harness-development-catalog/current.lock.json';
    const oldHostPath = 'soter/fixtures/legacy-claude-host/obsolete.bridge.evidence.json';
    const finalPath = 'soter/fixtures/harness-development-catalog/current.migration.evidence.json';
    const evidence = { $contract: 'soter://contracts/evidence/v2', id: 'evidence.current' };
    const retained = { $contract: 'soter://contracts/lock/v1', id: 'lock.current' };
    for (const [relativePath, value] of [
      [currentPath, evidence],
      [retainedPath, retained],
      [oldHostPath, { old: true }]
    ]) writeFixture(fixtureRoot, relativePath, value);
    const currentStat = fs.statSync(path.join(fixtureRoot, currentPath));
    const currentFixtures = new Map([[currentPath, evidence], [retainedPath, retained]]);
    const transition = {
      authorizationEvidence: [currentPath],
      finalEvidence: [finalPath]
    };
    const overlay = [{
      path: currentPath,
      documentFingerprint: fingerprintJson(evidence),
      document: evidence
    }];
    const plan = planLegacyFinalizationObsoleteFixturePaths(fixtureRoot, {
      currentFixtures,
      transitions: [transition],
      authorizationEvidenceOverlay: overlay
    });
    assert.deepEqual(plan.obsoleteFixturePaths, [currentPath, oldHostPath]);
    assert.equal(fs.statSync(path.join(fixtureRoot, currentPath)).ino, currentStat.ino);
    assert.deepEqual(readJson(path.join(fixtureRoot, currentPath)), evidence);

    const duplicatePath
      = 'soter/fixtures/harness-development-catalog/duplicate.bridge.evidence.json';
    writeFixture(fixtureRoot, duplicatePath, evidence);
    const duplicateFixtures = new Map(currentFixtures);
    duplicateFixtures.set(duplicatePath, structuredClone(evidence));
    assert.throws(
      () => planLegacyFinalizationObsoleteFixturePaths(fixtureRoot, {
        currentFixtures: duplicateFixtures,
        transitions: [transition],
        authorizationEvidenceOverlay: overlay
      }),
      /exactly one current generated fixture path/
    );
    assert.deepEqual(readJson(path.join(fixtureRoot, duplicatePath)), evidence);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  const firstRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'soter-root-identity-'))
  );
  const heldRoot = firstRoot + '-held';
  try {
    const firstIdentity = legacyTransitionRootIdentity(firstRoot);
    fs.renameSync(firstRoot, heldRoot);
    fs.mkdirSync(firstRoot);
    const replacementIdentity = legacyTransitionRootIdentity(firstRoot);
    assert.notEqual(firstIdentity.fingerprint, replacementIdentity.fingerprint);
  } finally {
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(heldRoot, { recursive: true, force: true });
  }

  const requestRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'soter-transition-request-root-'))
  );
  const external = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'soter-transition-request-external-'))
  );
  const externalReal = path.join(external, 'real');
  const externalLink = path.join(external, 'linked');
  try {
    await expectAsyncCode(
      () => buildLegacyFinalizationTransitionRequest({
        root: requestRoot,
        id: 'legacy-finalization-transition.selftest',
        createdAt: '2026-07-22T12:00:00.000Z',
        validUntil: '2026-07-22T12:15:00.000Z',
        at: '2026-07-22T12:15:00.000Z'
      }),
      'LEGACY_FINALIZATION_TRANSITION_REQUEST_EXPIRED'
    );
    await expectAsyncCode(
      () => buildLegacyFinalizationTransitionRequest({
        root: requestRoot,
        id: 'legacy-finalization-transition.selftest',
        createdAt: '2026-07-22T12:00:00.000Z',
        validUntil: '2026-07-22T12:15:00.000Z',
        at: 'not-a-date'
      }),
      'LEGACY_FINALIZATION_TRANSITION_AT_INVALID'
    );
    fs.mkdirSync(externalReal);
    fs.symlinkSync(externalReal, externalLink, 'dir');
    const requestPath = path.join(externalReal, 'request.json');
    fs.writeFileSync(requestPath, '{}\n', { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(requestPath, 0o600);
    await expectAsyncCode(
      () => readLegacyFinalizationTransitionRequest({
        root: requestRoot,
        requestPath: path.join(externalLink, 'request.json'),
        lifecycleRequestPath: path.join(external, 'unused-lifecycle.json'),
        at: '2026-07-22T12:00:00.000Z'
      }),
      'LEGACY_FINALIZATION_TRANSITION_REQUEST_PATH_INVALID'
    );
  } finally {
    fs.rmSync(requestRoot, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }

  process.stdout.write('Legacy transition finalization selftest passed.\n');
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestLegacyTransitionFinalization().catch((error) => {
    process.stderr.write((error.stack || String(error)) + '\n');
    process.exitCode = 1;
  });
}
