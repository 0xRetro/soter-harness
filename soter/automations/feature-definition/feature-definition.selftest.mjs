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
  buildDefinedFeatureBody,
  loadFeatureWorkflowPolicy
} from '../../contexts/product/feature-workflow.mjs';
import { runContainedFeatureDefinitionScenario } from './scenario.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-21T19:00:00.000Z';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-feature-definition-selftest-'));
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
    feature: 'https://www.notion.so/44444444444444444444444444444444',
    whatItIs: 'PRIVATE_DEFINITION_SENTINEL takes an integrator to one successful result.',
    scopeIn: ['PRIVATE_SCOPE_IN_SENTINEL one supported path'],
    scopeOut: ['PRIVATE_SCOPE_OUT_SENTINEL every advanced provider'],
    doneWhen: ['PRIVATE_DONE_SENTINEL a new integrator completes it alone'],
    openQuestions: ['PRIVATE_QUESTION_SENTINEL which provider first?'],
    statusChangeRequested: false,
    ...overrides
  };
}

export async function selftestFeatureDefinition(root = defaultRoot) {
  const temporaryRoot = copyHarness(root);
  try {
    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/feature-definition.config.json'
    });
    const fixtureDirectory = path.join(temporaryRoot, 'soter', 'fixtures', 'feature-definition');
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const lockPath = 'soter/fixtures/feature-definition/feature-definition.lock.json';
    writeJson(path.join(temporaryRoot, lockPath), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const policy = loadFeatureWorkflowPolicy(temporaryRoot);
    const currentBody = buildCapturedFeatureBody({
      policy,
      name: 'Safe feature',
      featureType: 'Feature',
      summary: 'Existing summary.',
      sectionTwo: ['Existing criterion.'],
      currentState: 'Observed state.',
      relationships: ['Soter Harness'],
      openQuestions: []
    });
    const definitionInput = {
      policy,
      featureType: 'Feature',
      whatItIs: 'A safe definition.',
      scopeIn: ['One supported path'],
      scopeOut: ['Unsupported paths'],
      doneWhen: ['The supported path passes'],
      openQuestions: []
    };
    assert.equal(buildDefinedFeatureBody({
      ...definitionInput,
      currentBody: currentBody.replace('## Summary', '### Summary')
    }).compatible, false);
    assert.equal(buildDefinedFeatureBody({
      ...definitionInput,
      currentBody: currentBody.replace('## Summary', 'Inline ## Summary')
    }).compatible, false);
    assert.equal(buildDefinedFeatureBody({
      ...definitionInput,
      currentBody: currentBody + '\n## Summary\n\nDuplicate.\n'
    }).compatible, false);
    const escapedDefinition = buildDefinedFeatureBody({
      ...definitionInput,
      currentBody,
      whatItIs: 'A safe definition.\n## Relationships\nThis remains summary data.'
    });
    assert.equal(escapedDefinition.compatible, true);
    assert(escapedDefinition.body.includes('\\## Relationships'));
    assert.equal(escapedDefinition.body.split('\n').filter((line) => line === '## Relationships').length, 1);
    const scenario = await runContainedFeatureDefinitionScenario({
      root: temporaryRoot,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/feature-definition/preparation.scenario.json',
      workId: 'work.feature-definition.preparation-fixture',
      scenarioEvidenceId: 'evidence.feature-definition.preparation.fixture',
      createdAt: AT
    });
    assert.equal(scenario.assessment.result, 'passed');
    assert.equal(scenario.scenarioEvidence.result, 'passed');

    const exactInput = input();
    const work = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.feature-definition',
      configurationName: 'feature-definition',
      configurationBasis: 'tracked-contained',
      input: exactInput,
      createdAt: '2026-07-21T19:01:00.000Z'
    });
    assert.equal(work.state, 'ready-for-review');
    assert.equal(work.preview.kind, 'feature-definition-preview');
    assert.equal(work.preview.proposedChanges.length, 1);
    assert.equal(work.approval.state, 'not-requested');
    assert.equal(work.continuationRequest, null);
    assert.equal(work.preview.collections[0].rows[0].actions[0].capability, 'documents.content.update');
    const review = inspectPreparedAutomationReviewMaterial({ root: temporaryRoot, workId: work.id });
    assert.equal(review.fields.find((field) => field.id === 'whatItIs').reviewValue, exactInput.whatItIs);
    const derived = inspectPreparedAutomationDerivedReviewMaterial({ root: temporaryRoot, workId: work.id });
    const fields = privateFields(derived);
    assert.equal(fields.get('featureId'), exactInput.feature);
    assert.equal(fields.get('status'), 'Planned');
    assert.equal(fields.get('description'), 'Manual re-explanation wastes time and makes the first successful integration inconsistent.');
    assert(fields.get('proposedBody').includes(exactInput.whatItIs));
    assert(fields.get('proposedBody').includes('- [ ] ' + exactInput.doneWhen[0]));
    assert(!fields.get('proposedBody').includes(fields.get('description')));

    const selection = createReviewOnlyCandidateSelection({
      root: temporaryRoot,
      workId: work.id,
      actionIds: ['action.feature-definition.body-update'],
      createdAt: '2026-07-21T19:01:30.000Z'
    });
    await assert.rejects(
      createReviewOnlyCandidatePreview({
        root: temporaryRoot,
        selectionId: selection.id,
        createdAt: '2026-07-21T19:02:00.000Z'
      }),
      (error) => error?.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_COMPILER_INVALID'
    );

    const pressure = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.feature-definition',
      configurationName: 'feature-definition',
      configurationBasis: 'tracked-contained',
      input: input({ statusChangeRequested: true }),
      createdAt: '2026-07-21T19:03:00.000Z'
    });
    assert.equal(pressure.preview.proposedChanges.length, 1);
    assert(pressure.preview.collections[0].rows[0].flags.includes('FEATURE_STATUS_CHANGE_EXCLUDED_FROM_DEFINITION'));
    assert.equal(pressure.preview.facts.find((fact) => fact.id === 'feature-status-change-count').value, 0);

    const sanitized = JSON.stringify({ work, pressure, inspection: inspectWorkspace({ root: temporaryRoot }) });
    for (const sentinel of [
      exactInput.whatItIs,
      ...exactInput.scopeIn,
      ...exactInput.scopeOut,
      ...exactInput.doneWhen,
      ...exactInput.openQuestions,
      fields.get('description'),
      fields.get('currentBody'),
      fields.get('proposedBody')
    ]) {
      assert(!sanitized.includes(sentinel), 'Sanitized projection leaked private feature definition material.');
    }
    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore);
    process.stdout.write('Feature Definition selftest: exact feature/body grounding, deterministic definition, why and Planned preservation, status-pressure separation, private review, no-authority preparation, and inspection privacy passed.\n');
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await selftestFeatureDefinition();
}
