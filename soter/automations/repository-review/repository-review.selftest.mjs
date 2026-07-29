import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspace } from '../../core/inspection.mjs';
import { fingerprintPath, readJson, writeJson } from '../../core/lib/canonical-json.mjs';
import {
  inspectPreparedAutomationDerivedReviewMaterial,
  inspectPreparedAutomationReviewMaterial,
  prepareAutomationRun
} from '../../core/prepared-work.mjs';
import { resolveConfiguration } from '../../core/resolve.mjs';
import { invoke as invokeRepositoryFixture } from '../../integrations/local-repository/fixture.mjs';
import { runContainedRepositoryReviewScenario } from './scenario.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-21T20:00:00.000Z';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-repository-review-selftest-'));
  for (const directory of ['soter']) {
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function privateItems(material) {
  return material.items.map((item) => new Map(item.fields.map((field) => {
    return [field.id, field.reviewValue];
  })));
}

export async function selftestRepositoryReview(root = defaultRoot) {
  const temporaryRoot = copyHarness(root);
  try {
    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/repository-review.config.json'
    });
    const fixtureDirectory = path.join(temporaryRoot, 'soter', 'fixtures', 'repository-review');
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const lockPath = 'soter/fixtures/repository-review/repository-review.lock.json';
    writeJson(path.join(temporaryRoot, lockPath), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const scenario = await runContainedRepositoryReviewScenario({
      root: temporaryRoot,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/repository-review/preparation.scenario.json',
      workId: 'work.repository-review.preparation-fixture',
      scenarioEvidenceId: 'evidence.repository-review.preparation.fixture',
      createdAt: AT
    });
    assert.equal(scenario.assessment.result, 'passed');
    assert.equal(scenario.scenarioEvidence.result, 'passed');

    const exactInput = {
      repositoryUri: 'repo-fixture://process-platform',
      scope: 'product-capabilities',
      focus: 'scrambling'
    };
    const work = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.repository-review',
      configurationName: 'repository-review',
      configurationBasis: 'tracked-contained',
      input: exactInput,
      createdAt: '2026-07-21T20:01:00.000Z'
    });
    assert.equal(work.state, 'ready-for-review');
    assert.equal(work.preview.kind, 'repository-review-preview');
    assert.equal(work.preview.proposedChanges.length, 0);
    assert.equal(work.approval.state, 'not-requested');
    assert.equal(work.continuationRequest, null);
    assert.equal(work.preview.collections[0].coverage.observedCount, 1);
    assert(work.preview.collections[0].rows.every((row) => {
      return row.actions.every((action) => ['handoff', 'held'].includes(action.state));
    }));
    const inputReview = inspectPreparedAutomationReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    assert.equal(
      inputReview.fields.find((field) => field.id === 'repositoryUri').reviewValue,
      exactInput.repositoryUri
    );
    const derived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    const items = privateItems(derived);
    assert.equal(items.length, 1);
    assert(items.every((fields) => fields.get('targetAutomation') === 'automation.feature-capture'));
    assert(items.some((fields) => fields.get('name') === 'Schema-derived template editor'));

    const originalFixture = readJson(path.join(
      temporaryRoot,
      'soter',
      'fixtures',
      'providers',
      'local-repository',
      'repositories.json'
    ));
    const hostile = structuredClone(originalFixture);
    hostile.data.repositories[0].capabilities[0].evidence = [{
      relativePath: '../PRIVATE_REPOSITORY_ESCAPE_SENTINEL',
      contentFingerprint: 'sha256:' + 'a'.repeat(64)
    }];
    await assert.rejects(
      invokeRepositoryFixture({
        capability: 'repository.snapshot.read',
        input: { uri: 'repo-fixture://process-platform' },
        authority: 'authority.repository.instance',
        state: hostile,
        at: '2026-07-21T20:02:00.000Z'
      }),
      (error) => error?.kind === 'validation'
    );

    const sanitized = JSON.stringify({ work, inspection: inspectWorkspace({ root: temporaryRoot }) });
    for (const sentinel of [
      exactInput.repositoryUri,
      exactInput.focus,
      'Schema-derived template editor',
      'Stable schema-derived identities prevent reordered fields from scrambling operator state.',
      'packages/editor/required-field-expression.ts',
      'PRIVATE_REPOSITORY_ESCAPE_SENTINEL'
    ]) {
      assert(!sanitized.includes(sentinel), 'Sanitized projection leaked ' + sentinel + '.');
    }
    assert(!JSON.stringify(work).includes('https://www.notion.so/44444444444444444444444444444444'));
    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore);
    process.stdout.write('Repository Review selftest: exact snapshot selection, source-backed bounded candidates, duplicate hold, private Feature Capture handoffs, path confinement, no-authority preparation, and inspection privacy passed.\n');
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await selftestRepositoryReview();
}
