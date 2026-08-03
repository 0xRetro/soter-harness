import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspace } from '../../core/inspection.mjs';
import { fingerprintPath, writeJson } from '../../core/lib/canonical-json.mjs';
import {
  inspectPreparedAutomationDerivedReviewMaterial,
  inspectPreparedAutomationReviewMaterial,
  prepareAutomationRun
} from '../../core/prepared-work.mjs';
import { createReviewOnlyCandidatePreview } from '../../core/review-only-candidate-previews.mjs';
import { createReviewOnlyCandidateSelection } from '../../core/review-only-candidate-selections.mjs';
import { resolveConfiguration } from '../../core/resolve.mjs';
import {
  buildCapturedFeatureBody,
  loadFeatureWorkflowPolicy
} from '../../contexts/product/feature-workflow.mjs';
import { runContainedFeatureCaptureScenario } from './scenario.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-21T18:00:00.000Z';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-feature-capture-selftest-'));
  for (const directory of ['soter']) {
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function privateFields(material) {
  return new Map(material.items[0].fields.map((field) => [field.id, field.reviewValue]));
}

function input(overrides = {}) {
  return {
    name: 'PRIVATE_FEATURE_NAME_SENTINEL',
    why: 'PRIVATE_FEATURE_WHY_SENTINEL removes repeated manual explanations.',
    whyState: 'confirmed',
    featureType: 'Feature',
    summary: 'PRIVATE_FEATURE_SUMMARY_SENTINEL describes the exact self-serve outcome.',
    sectionTwo: ['PRIVATE_FEATURE_ACCEPTANCE_SENTINEL completes without a walkthrough.'],
    currentState: 'PRIVATE_FEATURE_CURRENT_STATE_SENTINEL not built yet.',
    relationships: ['PRIVATE_FEATURE_RELATION_SENTINEL Soter Harness'],
    openQuestions: ['PRIVATE_FEATURE_QUESTION_SENTINEL which provider first?'],
    area: 'Context',
    priority: 'Next',
    ...overrides
  };
}

export async function selftestFeatureCapture(root = defaultRoot) {
  const temporaryRoot = copyHarness(root);
  try {
    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/feature-capture.config.json'
    });
    const fixtureDirectory = path.join(temporaryRoot, 'soter', 'fixtures', 'feature-capture');
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const lockPath = 'soter/fixtures/feature-capture/feature-capture.lock.json';
    writeJson(path.join(temporaryRoot, lockPath), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const policy = loadFeatureWorkflowPolicy(temporaryRoot);
    assert.throws(() => buildCapturedFeatureBody({
      policy,
      name: 'Injected\n## Summary',
      featureType: 'Feature',
      summary: 'Safe summary.',
      sectionTwo: ['Safe criterion.'],
      currentState: '',
      relationships: [],
      openQuestions: []
    }), /one bounded line/);
    assert.throws(() => buildCapturedFeatureBody({
      policy,
      name: 'Safe feature',
      featureType: 'Feature',
      summary: 'Safe summary.',
      sectionTwo: ['Safe criterion.\n## Relationships'],
      currentState: '',
      relationships: [],
      openQuestions: []
    }), /one bounded line/);
    const escapedBody = buildCapturedFeatureBody({
      policy,
      name: 'Safe feature',
      featureType: 'Feature',
      summary: 'First paragraph.\n## Relationships\nThis remains summary data.',
      sectionTwo: ['Safe criterion.'],
      currentState: '',
      relationships: [],
      openQuestions: []
    });
    assert(escapedBody.includes('\\## Relationships'));
    assert.equal(escapedBody.split('\n').filter((line) => line === '## Relationships').length, 1);
    const scenario = await runContainedFeatureCaptureScenario({
      root: temporaryRoot,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/feature-capture/preparation.scenario.json',
      workId: 'work.feature-capture.preparation-fixture',
      scenarioEvidenceId: 'evidence.feature-capture.preparation.fixture',
      createdAt: AT
    });
    assert.equal(scenario.assessment.result, 'passed');
    assert.equal(scenario.scenarioEvidence.result, 'passed');

    const exactInput = input();
    const work = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.feature-capture',
      configurationName: 'feature-capture',
      configurationBasis: 'tracked-contained',
      input: exactInput,
      createdAt: '2026-07-21T18:01:00.000Z'
    });
    assert.equal(work.state, 'ready-for-review');
    assert.equal(work.preview.kind, 'feature-capture-preview');
    assert.equal(work.preview.proposedChanges.length, 1);
    assert.equal(work.approval.state, 'not-requested');
    assert.equal(work.continuationRequest, null);
    assert.equal(work.preview.collections[0].rows[0].actions[0].state, 'proposed');
    const review = inspectPreparedAutomationReviewMaterial({ root: temporaryRoot, workId: work.id });
    assert.equal(review.fields.find((field) => field.id === 'why').reviewValue, exactInput.why);
    const derived = inspectPreparedAutomationDerivedReviewMaterial({ root: temporaryRoot, workId: work.id });
    const fields = privateFields(derived);
    assert.equal(fields.get('name'), exactInput.name);
    assert.equal(fields.get('why'), exactInput.why);
    assert.equal(fields.get('status'), 'Planned');
    assert.equal(fields.get('featureType'), 'Feature');
    assert.deepEqual(fields.get('area'), ['Context']);
    assert.deepEqual(fields.get('priority'), ['Next']);
    assert(fields.get('body').includes('## Behavior / Acceptance'));
    assert(fields.get('body').includes(exactInput.summary));

    const selection = createReviewOnlyCandidateSelection({
      root: temporaryRoot,
      workId: work.id,
      actionIds: ['action.feature-capture.create'],
      createdAt: '2026-07-21T18:01:30.000Z'
    });
    await assert.rejects(
      createReviewOnlyCandidatePreview({
        root: temporaryRoot,
        selectionId: selection.id,
        createdAt: '2026-07-21T18:02:00.000Z'
      }),
      (error) => error?.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_COMPILER_INVALID'
    );

    const duplicate = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.feature-capture',
      configurationName: 'feature-capture',
      configurationBasis: 'tracked-contained',
      input: input({ name: 'Existing dark mode' }),
      createdAt: '2026-07-21T18:03:00.000Z'
    });
    assert.equal(duplicate.preview.proposedChanges.length, 0);
    assert(duplicate.preview.collections[0].rows[0].flags.includes('FEATURE_DUPLICATE_CANDIDATE_OBSERVED'));

    const provisional = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.feature-capture',
      configurationName: 'feature-capture',
      configurationBasis: 'tracked-contained',
      input: input({ name: 'Provisional feature', whyState: 'provisional' }),
      createdAt: '2026-07-21T18:04:00.000Z'
    });
    assert.equal(provisional.preview.proposedChanges.length, 0);
    assert(provisional.preview.collections[0].rows[0].flags.includes('FEATURE_WHY_PROVISIONAL_CONFIRM_REQUIRED'));

    const sanitized = JSON.stringify({ work, duplicate, provisional, inspection: inspectWorkspace({ root: temporaryRoot }) });
    for (const sentinel of [
      exactInput.name,
      exactInput.why,
      exactInput.summary,
      ...exactInput.sectionTwo,
      exactInput.currentState,
      ...exactInput.relationships,
      ...exactInput.openQuestions
    ]) {
      assert(!sanitized.includes(sentinel), 'Sanitized projection leaked ' + sentinel + '.');
    }
    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore);
    process.stdout.write('Feature Capture selftest: configured-board grounding, required why, current option matching, deterministic body, duplicate/provisional blocking, private review, no-authority preparation, and inspection privacy passed.\n');
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await selftestFeatureCapture();
}
