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
import { runContainedOrganizationCaptureScenario } from './scenario.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-21T12:00:00.000Z';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-org-capture-selftest-'));
  for (const directory of ['soter']) {
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

export async function selftestOrganizationCapture(root = defaultRoot) {
  const temporaryRoot = copyHarness(root);
  try {
    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/organization-capture.config.json'
    });
    const fixtureDirectory = path.join(
      temporaryRoot,
      'soter',
      'fixtures',
      'organization-capture'
    );
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const lockPath = 'soter/fixtures/organization-capture/organization-capture.lock.json';
    writeJson(path.join(temporaryRoot, lockPath), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));

    const scenario = await runContainedOrganizationCaptureScenario({
      root: temporaryRoot,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/organization-capture/preparation.scenario.json',
      workId: 'work.organization-capture.preparation-fixture',
      scenarioEvidenceId: 'evidence.organization-capture.preparation.fixture',
      createdAt: AT
    });
    assert.equal(scenario.assessment.result, 'passed');
    assert.equal(scenario.scenarioEvidence.result, 'passed');

    const privateInput = {
      name: 'PRIVATE_ORGANIZATION_NAME_SENTINEL',
      description: 'PRIVATE_DESCRIPTION_SENTINEL foundation in DeFi.',
      website: 'private-org.example',
      twitter: '@private_org',
      aliases: ['PRIVATE_ALIAS_ONE', 'PRIVATE_ALIAS_TWO'],
      tags: ['Prospect', 'Priority']
    };
    const work = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.organization-capture',
      configurationName: 'organization-capture',
      configurationBasis: 'tracked-contained',
      input: privateInput,
      createdAt: '2026-07-21T12:01:00.000Z'
    });
    assert.equal(work.state, 'ready-for-review');
    assert.equal(work.preview.proposedChanges.length, 1);
    assert.equal(work.approval.state, 'not-requested');
    assert.equal(work.continuationRequest, null);
    assert.equal(work.inputSummary.fields.find((field) => field.id === 'aliases').exposure, 'private');
    assert(!Object.hasOwn(work.inputSummary.fields.find((field) => field.id === 'aliases'), 'value'));
    const review = inspectPreparedAutomationReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    assert.deepEqual(
      review.fields.find((field) => field.id === 'aliases').reviewValue,
      privateInput.aliases
    );
    const derived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    assert.equal(derived.kind, 'organization-capture-derived-review');
    assert.deepEqual(
      derived.items[0].fields.find((field) => field.id === 'organizationType').reviewValue,
      ['Foundation']
    );
    assert.deepEqual(
      derived.items[0].fields.find((field) => field.id === 'tags').reviewValue,
      ['DeFi', 'Priority', 'Prospect']
    );

    const action = work.preview.collections[0].rows[0].actions[0];
    const selection = createReviewOnlyCandidateSelection({
      root: temporaryRoot,
      workId: work.id,
      actionIds: [action.id],
      createdAt: '2026-07-21T12:01:30.000Z'
    });
    const preview = await createReviewOnlyCandidatePreview({
      root: temporaryRoot,
      selectionId: selection.id,
      createdAt: '2026-07-21T12:02:00.000Z'
    });
    assert.equal(preview.state, 'blocked-review-only');
    assert.equal(preview.executable, false);
    assert.equal(preview.privacy.authority, 'none');
    assert.equal(preview.operations.length, 1);
    assert.equal(preview.operations[0].capability, 'crm.records.create');
    assert.deepEqual(preview.operations[0].precondition.input.filtersAny, [
      { name: privateInput.name },
      { name: 'PRIVATE_ALIAS_ONE' },
      { name: 'PRIVATE_ALIAS_TWO' },
      { name: 'PRIVATEORGANIZATIONNAMESENTINEL' }
    ]);
    assert.deepEqual(preview.operations[0].input.fields, {
      name: privateInput.name,
      organizationType: 'Foundation',
      tags: ['DeFi', 'Priority', 'Prospect'],
      website: 'https://private-org.example',
      twitter: 'https://twitter.com/private_org'
    });
    assert.equal(preview.operations[0].ambiguity.retry, 'prohibited');
    assert.equal(preview.operations[0].recovery.mode, 'manual-required');

    const inspection = inspectWorkspace({ root: temporaryRoot });
    const sanitized = JSON.stringify({ work, inspection });
    for (const sentinel of [
      privateInput.name,
      privateInput.description,
      privateInput.website,
      privateInput.twitter,
      ...privateInput.aliases
    ]) {
      assert(!sanitized.includes(sentinel), 'Sanitized projection leaked ' + sentinel + '.');
    }

    const pressure = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.organization-capture',
      configurationName: 'organization-capture',
      configurationBasis: 'tracked-contained',
      input: {
        name: 'Acme Rollups',
        description: 'An L2 rollup company.',
        organizationType: 'L2 Rollup'
      },
      createdAt: '2026-07-21T12:03:00.000Z'
    });
    assert.equal(pressure.state, 'ready-for-review');
    assert.equal(pressure.preview.proposedChanges.length, 0);
    assert(pressure.preview.collections[0].rows[0].flags.includes(
      'ORG_TYPE_NOT_IN_CURRENT_SCHEMA'
    ));

    const sector = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.organization-capture',
      configurationName: 'organization-capture',
      configurationBasis: 'tracked-contained',
      input: {
        name: 'Helios Grants',
        description: 'A DeFi grants program.'
      },
      createdAt: '2026-07-21T12:04:00.000Z'
    });
    assert.equal(sector.state, 'ready-for-review');
    const sectorDerived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: sector.id
    });
    const sectorFields = new Map(
      sectorDerived.items[0].fields.map((field) => [field.id, field.reviewValue])
    );
    assert.deepEqual(sectorFields.get('organizationType'), ['Ecosystem Actor']);
    assert.deepEqual(sectorFields.get('tags'), ['DeFi', 'Grants']);

    const duplicateList = await prepareAutomationRun({
        root: temporaryRoot,
        automationId: 'automation.organization-capture',
        configurationName: 'organization-capture',
        configurationBasis: 'tracked-contained',
        input: {
          name: 'Duplicate List',
          description: 'A foundation.',
          aliases: ['Same', 'Same']
        },
        createdAt: '2026-07-21T12:05:00.000Z'
      });
    assert.equal(duplicateList.state, 'needs-input');
    assert.equal(duplicateList.readiness.blockers[0].reasonCode, 'INPUT_INVALID');
    assert.match(duplicateList.readiness.blockers[0].message, /duplicate values/);
    const nonTextList = await prepareAutomationRun({
        root: temporaryRoot,
        automationId: 'automation.organization-capture',
        configurationName: 'organization-capture',
        configurationBasis: 'tracked-contained',
        input: {
          name: 'Non Text List',
          description: 'A foundation.',
          aliases: ['Okay', 42]
        },
        createdAt: '2026-07-21T12:06:00.000Z'
      });
    assert.equal(nonTextList.state, 'needs-input');
    assert.equal(nonTextList.readiness.blockers[0].reasonCode, 'INPUT_INVALID');
    assert.match(nonTextList.readiness.blockers[0].message, /non-text value/);
    assert.equal(
      fingerprintPath(path.join(temporaryRoot, 'soter')),
      canonicalBefore,
      'Organization Capture preparation changed canonical artifacts.'
    );
    process.stdout.write('Organization Capture self-test passed.\n');
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestOrganizationCapture().catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
