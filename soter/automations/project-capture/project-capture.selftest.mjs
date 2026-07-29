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
import { createPreparedReviewBatch } from '../../core/prepared-review-batches.mjs';
import { resolveConfiguration } from '../../core/resolve.mjs';
import { runContainedProjectCaptureScenario } from './scenario.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-21T15:00:00.000Z';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-project-capture-selftest-'));
  for (const directory of ['soter']) {
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function privateInput(overrides = {}) {
  return {
    name: 'PRIVATE_PROJECT_SHORT_NAME_SENTINEL: PRIVATE_PROJECT_NAME_SENTINEL',
    organizationShortName: 'PRIVATE_PROJECT_SHORT_NAME_SENTINEL',
    organization: 'soter-fixture://crm/organization/acme',
    creationProfile: 'project',
    projectType: 'Project',
    overview: 'PRIVATE_PROJECT_OVERVIEW_SENTINEL grounded without invented delivery claims.',
    milestoneTitles: [
      'PRIVATE_PROJECT_FIRST_MILESTONE_SENTINEL',
      'PRIVATE_PROJECT_SECOND_MILESTONE_SENTINEL'
    ],
    milestoneDescriptions: [
      'PRIVATE_PROJECT_FIRST_DESCRIPTION_SENTINEL defines the reviewed outcome',
      'PRIVATE_PROJECT_SECOND_DESCRIPTION_SENTINEL defines the review boundary'
    ],
    milestoneOwners: [
      'PRIVATE_PROJECT_FIRST_OWNER_SENTINEL',
      'PRIVATE_PROJECT_SECOND_OWNER_SENTINEL'
    ],
    milestoneActions: [
      'PRIVATE_PROJECT_FIRST_ACTION_SENTINEL confirms the scope',
      'PRIVATE_PROJECT_SECOND_ACTION_SENTINEL reviews the evidence'
    ],
    milestoneDates: ['2026-07-28', '2026-08-14'],
    startDate: '2026-07-24',
    targetEndDate: '2026-08-15',
    ...overrides
  };
}

export async function selftestProjectCapture(root = defaultRoot) {
  const temporaryRoot = copyHarness(root);
  try {
    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/project-capture.config.json'
    });
    const fixtureDirectory = path.join(temporaryRoot, 'soter', 'fixtures', 'project-capture');
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const lockPath = 'soter/fixtures/project-capture/project-capture.lock.json';
    writeJson(path.join(temporaryRoot, lockPath), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));

    const scenario = await runContainedProjectCaptureScenario({
      root: temporaryRoot,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/project-capture/preparation.scenario.json',
      workId: 'work.project-capture.preparation-fixture',
      scenarioEvidenceId: 'evidence.project-capture.preparation.fixture',
      createdAt: AT
    });
    assert.equal(scenario.assessment.result, 'passed');
    assert.equal(scenario.scenarioEvidence.result, 'passed');

    const input = privateInput();
    const work = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-capture',
      configurationName: 'project-capture',
      configurationBasis: 'tracked-contained',
      input,
      createdAt: '2026-07-21T15:01:00.000Z'
    });
    assert.equal(work.state, 'ready-for-review');
    assert.equal(work.preview.proposedChanges.length, 0);
    assert.equal(work.approval.state, 'not-requested');
    assert.equal(work.continuationRequest, null);
    const row = work.preview.collections[0].rows[0];
    const action = row.actions[0];
    assert.equal(action.state, 'held');
    assert.equal(action.reasonCode, 'COMPLETE_PROJECT_READBACK_UNAVAILABLE');
    assert.equal(action.capability, null);
    assert.equal(action.effect, null);
    assert(!Object.hasOwn(action, 'changeFingerprint'));
    assert.deepEqual(row.flags, ['COMPLETE_PROJECT_READBACK_UNAVAILABLE']);
    assert.equal(
      work.preview.facts.find((fact) => fact.id === 'project-body-readback-state')?.state,
      'unavailable'
    );
    for (const id of [
      'name',
      'organizationShortName',
      'overview',
      'milestoneTitles',
      'milestoneDescriptions',
      'milestoneOwners',
      'milestoneActions',
      'milestoneDates',
      'startDate',
      'targetEndDate'
    ]) {
      const field = work.inputSummary.fields.find((candidate) => candidate.id === id);
      assert.equal(field.exposure, 'private');
      assert(!Object.hasOwn(field, 'value'));
    }

    const review = inspectPreparedAutomationReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    assert.equal(review.fields.find((field) => field.id === 'name').reviewValue, input.name);
    assert.equal(
      review.fields.find((field) => field.id === 'organizationShortName').reviewValue,
      input.organizationShortName
    );
    assert.deepEqual(
      review.fields.find((field) => field.id === 'milestoneTitles').reviewValue,
      input.milestoneTitles
    );
    assert.equal(
      review.fields.find((field) => field.id === 'targetEndDate').reviewValue,
      input.targetEndDate,
      'Target end date must remain bound to its own private field rather than the start date.'
    );
    const derived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    const fields = new Map(derived.items[0].fields.map((field) => [field.id, field.reviewValue]));
    assert.equal(derived.kind, 'project-capture-derived-review');
    assert.equal(fields.get('name'), input.name);
    assert.equal(fields.get('organizationShortName'), input.organizationShortName);
    assert.equal(fields.get('creationProfile'), 'project');
    assert.equal(fields.get('projectType'), 'Project');
    assert.equal(fields.get('status'), 'Not Started');
    assert.deepEqual(fields.get('organizationUris'), [input.organization]);
    assert.equal(fields.has('managerIds'), false);
    assert.equal(fields.has('clientContactIds'), false);
    assert.equal(fields.get('startDate')[0], input.startDate);
    assert.equal(fields.get('targetEndDate')[0], input.targetEndDate);
    assert(fields.get('body').includes(input.overview));
    assert.equal(fields.get('milestoneLines').length, input.milestoneTitles.length);
    assert.equal(fields.get('workItemLines').length, input.milestoneTitles.length);
    assert(fields.get('milestoneLines').every((line) => /^- \[ \] \*\*.+ - \*\*\*.+\*$/.test(line)));
    assert(fields.get('workItemLines').every((line) => /^\t- \[ \] @[0-9]{4}-[0-9]{2}-[0-9]{2} - [^,]+ - .+$/.test(line)));

    const authorityStateBeforeSelection = fingerprintPath(
      path.join(temporaryRoot, '.soter', 'state')
    );
    assert.throws(
      () => createPreparedReviewBatch({
        root: temporaryRoot,
        workId: work.id,
        actionIds: [action.id],
        createdAt: '2026-07-21T15:01:30.000Z'
      }),
      (error) => error?.code === 'PREPARED_REVIEW_BATCH_SELECTION_INVALID'
    );
    assert.equal(
      fingerprintPath(path.join(temporaryRoot, '.soter', 'state')),
      authorityStateBeforeSelection,
      'Selecting the held Project candidate must create no batch, approval, start, or checkpoint state.'
    );

    const inspection = inspectWorkspace({ root: temporaryRoot });
    const sanitized = JSON.stringify({ work, inspection });
    for (const sentinel of [
      input.name,
      input.organizationShortName,
      input.overview,
      ...input.milestoneTitles,
      ...input.milestoneDescriptions,
      ...input.milestoneOwners,
      ...input.milestoneActions,
      ...input.milestoneDates,
      input.startDate,
      input.targetEndDate
    ]) {
      assert(!sanitized.includes(sentinel), 'Sanitized projection leaked ' + sentinel + '.');
    }

    const wrongPrefix = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-capture',
      configurationName: 'project-capture',
      configurationBasis: 'tracked-contained',
      input: privateInput({ name: 'Wrong: PRIVATE_PROJECT_WRONG_PREFIX_SENTINEL' }),
      createdAt: '2026-07-21T15:03:00.000Z'
    });
    assert.equal(wrongPrefix.state, 'ready-for-review');
    assert.equal(wrongPrefix.preview.proposedChanges.length, 0);
    assert(wrongPrefix.preview.collections[0].rows[0].flags.includes(
      'PROJECT_ORGANIZATION_SHORT_NAME_MISMATCH'
    ));
    assert.equal(
      wrongPrefix.preview.collections[0].rows[0].actions[0].reasonCode,
      'PROJECT_ORGANIZATION_SHORT_NAME_MISMATCH'
    );

    await assert.rejects(
      () => prepareAutomationRun({
        root: temporaryRoot,
        automationId: 'automation.project-capture',
        configurationName: 'project-capture',
        configurationBasis: 'tracked-contained',
        input: privateInput({ manager: 'provider-person.hostile' }),
        createdAt: '2026-07-21T15:03:30.000Z'
      }),
      /input contains undeclared fields/
    );

    const wrongProfile = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-capture',
      configurationName: 'project-capture',
      configurationBasis: 'tracked-contained',
      input: privateInput({ creationProfile: 'deal', projectType: 'Project' }),
      createdAt: '2026-07-21T15:04:00.000Z'
    });
    assert.equal(wrongProfile.state, 'ready-for-review');
    assert.equal(wrongProfile.preview.proposedChanges.length, 0);
    assert(wrongProfile.preview.collections[0].rows[0].flags.includes(
      'PROJECT_CREATION_PROFILE_TYPE_MISMATCH'
    ));
    assert.equal(
      wrongProfile.preview.collections[0].rows[0].actions[0].reasonCode,
      'PROJECT_CREATION_PROFILE_TYPE_MISMATCH'
    );

    const badDates = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-capture',
      configurationName: 'project-capture',
      configurationBasis: 'tracked-contained',
      input: privateInput({ startDate: '2026-08-15', targetEndDate: '2026-07-24' }),
      createdAt: '2026-07-21T15:05:00.000Z'
    });
    assert.equal(badDates.state, 'ready-for-review');
    assert.equal(badDates.preview.proposedChanges.length, 0);
    assert(badDates.preview.collections[0].rows[0].flags.includes('PROJECT_DATE_ORDER_INVALID'));
    assert.equal(
      badDates.preview.collections[0].rows[0].actions[0].reasonCode,
      'PROJECT_DATE_ORDER_INVALID'
    );

    const unequalMilestones = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-capture',
      configurationName: 'project-capture',
      configurationBasis: 'tracked-contained',
      input: privateInput({ milestoneActions: ['Only one action remains'] }),
      createdAt: '2026-07-21T15:06:00.000Z'
    });
    assert.equal(unequalMilestones.state, 'needs-input');
    assert.equal(unequalMilestones.readiness.blockers[0].reasonCode, 'PREPARATION_INPUT_INVALID');

    const impossibleMilestoneDate = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-capture',
      configurationName: 'project-capture',
      configurationBasis: 'tracked-contained',
      input: privateInput({ milestoneDates: ['2026-02-30', '2026-08-14'] }),
      createdAt: '2026-07-21T15:07:00.000Z'
    });
    assert.equal(impossibleMilestoneDate.state, 'needs-input');
    assert.equal(
      impossibleMilestoneDate.readiness.blockers[0].reasonCode,
      'PREPARATION_INPUT_INVALID'
    );

    const multipleOwners = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-capture',
      configurationName: 'project-capture',
      configurationBasis: 'tracked-contained',
      input: privateInput({ milestoneOwners: ['Maya, Jonah', 'Alex'] }),
      createdAt: '2026-07-21T15:08:00.000Z'
    });
    assert.equal(multipleOwners.state, 'needs-input');
    assert(multipleOwners.readiness.blockers.some((blocker) => {
      return blocker.reasonCode === 'INPUT_INVALID' && blocker.fieldId === 'milestoneOwners';
    }));

    const duplicatePortableMilestones = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.project-capture',
      configurationName: 'project-capture',
      configurationBasis: 'tracked-contained',
      input: privateInput({
        milestoneTitles: ['Duplicate portable milestone', 'Duplicate portable milestone!']
      }),
      createdAt: '2026-07-21T15:09:00.000Z'
    });
    assert.equal(duplicatePortableMilestones.state, 'needs-input');
    assert.equal(
      duplicatePortableMilestones.readiness.blockers[0].reasonCode,
      'PREPARATION_INPUT_INVALID'
    );

    assert.equal(
      fingerprintPath(path.join(temporaryRoot, 'soter')),
      canonicalBefore,
      'Project Capture preparation changed canonical artifacts.'
    );
    process.stdout.write('Project Capture self-test passed.\n');
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestProjectCapture().catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
