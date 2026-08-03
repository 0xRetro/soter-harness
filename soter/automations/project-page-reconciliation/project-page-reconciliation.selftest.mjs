import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspace } from '../../core/inspection.mjs';
import { fingerprintJson, readJson, writeJson } from '../../core/lib/canonical-json.mjs';
import {
  inspectPreparedAutomationDerivedReviewMaterial,
  prepareAutomationRun
} from '../../core/prepared-work.mjs';
import { createReviewOnlyCandidatePreview } from '../../core/review-only-candidate-previews.mjs';
import { createReviewOnlyCandidateSelection } from '../../core/review-only-candidate-selections.mjs';
import { resolveConfiguration } from '../../core/resolve.mjs';
import {
  evaluateProjectPageReconciliationConnectedVerification
} from './connected.mjs';
import { runContainedProjectPageReconciliationScenario } from './scenario.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROJECT = 'soter-fixture://projects/project/launch';
const OLD_TEXT = 'Confirm launch readiness.';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-project-reconciliation-'));
  fs.cpSync(path.join(root, 'soter'), path.join(temporaryRoot, 'soter'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function input(overrides = {}) {
  return {
    project: PROJECT,
    projectType: 'Project',
    ...overrides
  };
}

function materialFields(derived, kind) {
  const item = derived.items.find((candidate) => candidate.kind === kind);
  assert(item, 'Expected private review item ' + kind + '.');
  return new Map(item.fields.map((field) => [field.id, field.reviewValue]));
}

function sourceRecord(root) {
  const fixture = readJson(path.join(root, 'soter/fixtures/providers/notion/workspace-records.json'));
  return fixture.data.records.find((record) => record.type === 'project' && record.id === PROJECT);
}

function sourceBody(root) {
  const fixture = readJson(path.join(root, 'soter/fixtures/providers/notion/workspace-records.json'));
  return fixture.data.documents.find((document) => document.uri === PROJECT).body;
}

async function prepared(root, inputValue, createdAt) {
  return prepareAutomationRun({
    root,
    automationId: 'automation.project-page-reconciliation',
    configurationName: 'project-page-reconciliation',
    configurationBasis: 'tracked-contained',
    input: inputValue,
    createdAt
  });
}

async function candidatePreview(root, work, actionIds, createdAt) {
  const selection = createReviewOnlyCandidateSelection({
    root,
    workId: work.id,
    actionIds,
    createdAt
  });
  return createReviewOnlyCandidatePreview({
    root,
    selectionId: selection.id,
    createdAt: new Date(Date.parse(createdAt) + 1000).toISOString()
  });
}

export async function selftestProjectPageReconciliation(root = defaultRoot) {
  const temporaryRoot = copyHarness(root);
  try {
    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/project-page-reconciliation.config.json'
    });
    const fixtureDirectory = path.join(
      temporaryRoot,
      'soter',
      'fixtures',
      'project-page-reconciliation'
    );
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const lockPath = 'soter/fixtures/project-page-reconciliation/project-page-reconciliation.lock.json';
    writeJson(path.join(temporaryRoot, lockPath), lock);

    const scenario = await runContainedProjectPageReconciliationScenario({
      root: temporaryRoot,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/project-page-reconciliation/preparation.scenario.json',
      workId: 'work.project-page-reconciliation.preparation-fixture',
      createdAt: '2026-08-03T10:00:00.000Z'
    });
    assert.equal(scenario.assessment.result, 'passed');

    const property = await prepared(
      temporaryRoot,
      input(),
      '2026-08-03T10:01:00.000Z'
    );
    assert.equal(property.state, 'ready-for-review');
    assert.equal(property.preview.proposedChanges.length, 1);
    assert.equal(property.preview.collections[0].rows[0].actions[0].id,
      'action.project-page-reconciliation.properties');
    assert.equal(property.approval.state, 'not-requested');
    assert.equal(property.continuationRequest, null);
    const propertyDerived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: property.id
    });
    const propertyFields = materialFields(propertyDerived, 'project-properties-update');
    const beforeFields = JSON.parse(propertyFields.get('beforeFieldsJson'));
    const afterFields = JSON.parse(propertyFields.get('afterFieldsJson'));
    assert.equal(afterFields.projectType, 'Project');
    assert.equal(afterFields.name, beforeFields.name);
    assert.deepEqual(afterFields.organizationUris, beforeFields.organizationUris);
    assert.deepEqual(afterFields.taskUris, beforeFields.taskUris);

    const propertyPreview = await candidatePreview(
      temporaryRoot,
      property,
      ['action.project-page-reconciliation.properties'],
      '2026-08-03T10:01:30.000Z'
    );
    assert.equal(propertyPreview.state, 'blocked-review-only');
    assert.equal(propertyPreview.executable, false);
    assert.equal(propertyPreview.privacy.authority, 'none');
    assert.equal(propertyPreview.operations.length, 1);
    assert.equal(propertyPreview.operations[0].capability, 'projects.records.update');
    assert.equal(propertyPreview.operations[0].precondition.capability, 'projects.records.read');
    assert.equal(propertyPreview.operations[0].precondition.input.content.expectedTitle, 'Acme launch');
    assert.equal(propertyPreview.operations[0].verification.capability, 'projects.records.read');
    assert.deepEqual(propertyPreview.operations[0].input.patch, { projectType: 'Project' });
    assert.equal(propertyPreview.operations[0].ambiguity.retry, 'prohibited');
    assert.equal(propertyPreview.operations[0].recovery.mode, 'manual-required');

    const fixtureProject = sourceRecord(temporaryRoot);
    const propertyOperation = propertyPreview.operations[0];
    assert.equal(evaluateProjectPageReconciliationConnectedVerification({
      operation: propertyOperation,
      phase: 'precondition',
      output: {
        records: [{
          ...structuredClone(fixtureProject),
          body: sourceBody(temporaryRoot),
          identityBinding: {
            state: 'exact-request',
            requestedIdFingerprint: fingerprintJson(PROJECT)
          }
        }]
      }
    }).state, 'passed');
    assert.equal(evaluateProjectPageReconciliationConnectedVerification({
      operation: propertyOperation,
      phase: 'precondition',
      output: {
        records: [{
          ...structuredClone(fixtureProject),
          body: sourceBody(temporaryRoot) + '\nPRIVATE_BODY_DRIFT_BEFORE_PROPERTY_SENTINEL',
          identityBinding: {
            state: 'exact-request',
            requestedIdFingerprint: fingerprintJson(PROJECT)
          }
        }]
      }
    }).state, 'failed');
    assert.equal(evaluateProjectPageReconciliationConnectedVerification({
      operation: propertyOperation,
      output: {
        records: [{
          type: 'project',
          id: PROJECT,
          version: '2',
          fields: afterFields,
          body: sourceBody(temporaryRoot),
          identityBinding: {
            state: 'exact-request',
            requestedIdFingerprint: fingerprintJson(PROJECT)
          }
        }]
      }
    }).state, 'passed');

    const bodySentinel = 'PRIVATE_PROJECT_REPLACEMENT_SENTINEL';
    const body = await prepared(
      temporaryRoot,
      {
        project: PROJECT,
        oldTexts: [OLD_TEXT],
        newTexts: [bodySentinel]
      },
      '2026-08-03T10:02:00.000Z'
    );
    assert.equal(body.preview.proposedChanges.length, 1);
    assert.equal(body.preview.collections[0].rows[0].actions[0].id,
      'action.project-page-reconciliation.body');
    const bodyDerived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: body.id
    });
    const bodyFields = materialFields(bodyDerived, 'project-body-update');
    assert.deepEqual(bodyFields.get('oldTexts'), [OLD_TEXT]);
    assert.deepEqual(bodyFields.get('newTexts'), [bodySentinel]);
    assert.deepEqual(
      JSON.parse(bodyFields.get('beforeFieldsJson')),
      JSON.parse(bodyFields.get('afterFieldsJson'))
    );
    const bodyPreview = await candidatePreview(
      temporaryRoot,
      body,
      ['action.project-page-reconciliation.body'],
      '2026-08-03T10:02:30.000Z'
    );
    assert.equal(bodyPreview.operations[0].capability, 'documents.content.update');
    assert.equal(bodyPreview.operations[0].precondition.capability, 'projects.records.read');
    assert.equal(bodyPreview.operations[0].verification.capability, 'projects.records.read');
    assert.equal(bodyPreview.operations[0].input.updates[0].replaceAllMatches, false);
    assert.equal(evaluateProjectPageReconciliationConnectedVerification({
      operation: bodyPreview.operations[0],
      phase: 'precondition',
      output: {
        records: [{
          ...structuredClone(fixtureProject),
          body: sourceBody(temporaryRoot),
          identityBinding: {
            state: 'exact-request',
            requestedIdFingerprint: fingerprintJson(PROJECT)
          }
        }]
      }
    }).state, 'passed');
    assert.equal(evaluateProjectPageReconciliationConnectedVerification({
      operation: bodyPreview.operations[0],
      output: {
        records: [{
          ...structuredClone(fixtureProject),
          body: sourceBody(temporaryRoot).replace(OLD_TEXT, bodySentinel),
          identityBinding: {
            state: 'exact-request',
            requestedIdFingerprint: fingerprintJson(PROJECT)
          }
        }]
      }
    }).state, 'passed');

    const shortenedSubstitution = await prepared(
      temporaryRoot,
      {
        project: PROJECT,
        oldTexts: [OLD_TEXT],
        newTexts: ['Launch ready.']
      },
      '2026-08-03T10:02:45.000Z'
    );
    assert.equal(shortenedSubstitution.state, 'ready-for-review');
    assert.equal(shortenedSubstitution.preview.proposedChanges.length, 1);

    const combined = await prepared(
      temporaryRoot,
      input({
        status: 'Active',
        oldTexts: [OLD_TEXT],
        newTexts: ['PRIVATE_PROJECT_COMBINED_REPLACEMENT_SENTINEL']
      }),
      '2026-08-03T10:03:00.000Z'
    );
    assert.deepEqual(
      combined.preview.collections[0].rows.flatMap((row) => row.actions.map((action) => action.id)),
      [
        'action.project-page-reconciliation.properties',
        'action.project-page-reconciliation.body'
      ]
    );
    assert.equal(
      combined.preview.facts.find((fact) => fact.id === 'combined-execution-atomicity')?.value,
      'sequential-non-atomic'
    );
    const combinedPreview = await candidatePreview(
      temporaryRoot,
      combined,
      [
        'action.project-page-reconciliation.properties',
        'action.project-page-reconciliation.body'
      ],
      '2026-08-03T10:03:30.000Z'
    );
    assert.deepEqual(
      combinedPreview.operations.map((operation) => operation.capability),
      ['projects.records.update', 'documents.content.update']
    );
    const combinedDerived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: combined.id
    });
    const combinedPropertyFields = materialFields(
      combinedDerived,
      'project-properties-update'
    );
    const combinedBodyFields = materialFields(combinedDerived, 'project-body-update');
    const combinedBeforeFields = JSON.parse(combinedBodyFields.get('beforeFieldsJson'));
    const combinedAfterFields = JSON.parse(combinedBodyFields.get('afterFieldsJson'));
    assert.deepEqual(
      combinedAfterFields,
      JSON.parse(combinedPropertyFields.get('afterFieldsJson'))
    );
    const combinedBodyOperation = combinedPreview.operations[1];
    const combinedAfterBody = sourceBody(temporaryRoot).replace(
      OLD_TEXT,
      'PRIVATE_PROJECT_COMBINED_REPLACEMENT_SENTINEL'
    );
    assert.equal(evaluateProjectPageReconciliationConnectedVerification({
      operation: combinedBodyOperation,
      phase: 'precondition',
      output: {
        records: [{
          ...structuredClone(fixtureProject),
          fields: combinedAfterFields,
          body: sourceBody(temporaryRoot),
          identityBinding: {
            state: 'exact-request',
            requestedIdFingerprint: fingerprintJson(PROJECT)
          }
        }]
      }
    }).state, 'passed');
    assert.equal(evaluateProjectPageReconciliationConnectedVerification({
      operation: combinedBodyOperation,
      output: {
        records: [{
          ...structuredClone(fixtureProject),
          fields: combinedBeforeFields,
          body: combinedAfterBody,
          identityBinding: {
            state: 'exact-request',
            requestedIdFingerprint: fingerprintJson(PROJECT)
          }
        }]
      }
    }).state, 'failed');
    assert.equal(evaluateProjectPageReconciliationConnectedVerification({
      operation: combinedBodyOperation,
      output: {
        records: [{
          ...structuredClone(fixtureProject),
          fields: combinedAfterFields,
          body: combinedAfterBody,
          identityBinding: {
            state: 'exact-request',
            requestedIdFingerprint: fingerprintJson(PROJECT)
          }
        }]
      }
    }).state, 'passed');

    const partialPreview = await candidatePreview(
      temporaryRoot,
      combined,
      ['action.project-page-reconciliation.body'],
      '2026-08-03T10:04:00.000Z'
    );
    assert.equal(partialPreview.operations.length, 1);
    assert.equal(partialPreview.operations[0].capability, 'documents.content.update');
    assert.deepEqual(
      partialPreview.operations[0].review.before.reviewValue.fields,
      combinedBeforeFields
    );

    const noOp = await prepared(
      temporaryRoot,
      {
        project: PROJECT,
        oldTexts: [OLD_TEXT],
        newTexts: [OLD_TEXT]
      },
      '2026-08-03T10:05:00.000Z'
    );
    assert.equal(noOp.state, 'needs-input');
    assert.equal(noOp.readiness.blockers[0].reasonCode, 'PREPARATION_INPUT_INVALID');

    const duplicateMatch = await prepared(
      temporaryRoot,
      {
        project: PROJECT,
        oldTexts: ['.'],
        newTexts: ['PRIVATE_PROJECT_DUPLICATE_SENTINEL!']
      },
      '2026-08-03T10:06:00.000Z'
    );
    assert.equal(duplicateMatch.state, 'needs-input');
    assert.equal(duplicateMatch.readiness.blockers[0].reasonCode, 'PREPARATION_INPUT_INVALID');

    const introducedMatch = await prepared(
      temporaryRoot,
      {
        project: PROJECT,
        oldTexts: [OLD_TEXT, 'PRIVATE_PROJECT_SYNTHETIC_MATCH_SENTINEL'],
        newTexts: [
          'PRIVATE_PROJECT_SYNTHETIC_MATCH_SENTINEL',
          'PRIVATE_PROJECT_FINAL_MATCH_SENTINEL'
        ]
      },
      '2026-08-03T10:06:20.000Z'
    );
    assert.equal(introducedMatch.state, 'needs-input');
    assert.equal(introducedMatch.readiness.blockers[0].reasonCode, 'PREPARATION_INPUT_INVALID');

    const originalRegions = await prepared(
      temporaryRoot,
      {
        project: PROJECT,
        oldTexts: ['Launch the customer program', OLD_TEXT],
        newTexts: [OLD_TEXT, 'PRIVATE_PROJECT_ORIGINAL_REGIONS_SENTINEL']
      },
      '2026-08-03T10:06:40.000Z'
    );
    assert.equal(originalRegions.state, 'ready-for-review');
    const originalDerived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: originalRegions.id
    });
    const originalFields = materialFields(originalDerived, 'project-body-update');
    assert.deepEqual(originalFields.get('updateIds'), ['replacement.002', 'replacement.001']);
    const originalPreview = await candidatePreview(
      temporaryRoot,
      originalRegions,
      ['action.project-page-reconciliation.body'],
      '2026-08-03T10:06:50.000Z'
    );
    assert.deepEqual(
      originalPreview.operations[0].input.updates.map((update) => update.id),
      ['replacement.002', 'replacement.001']
    );

    const collidingExecutionOrder = await prepared(
      temporaryRoot,
      {
        project: PROJECT,
        oldTexts: ['Launch the customer program', OLD_TEXT],
        newTexts: [
          'PRIVATE_PROJECT_COLLISION_RESULT_SENTINEL',
          'Launch the customer program'
        ]
      },
      '2026-08-03T10:06:55.000Z'
    );
    assert.equal(collidingExecutionOrder.state, 'needs-input');
    assert.equal(
      collidingExecutionOrder.readiness.blockers[0].reasonCode,
      'PREPARATION_INPUT_INVALID'
    );

    const appendEquivalent = await prepared(
      temporaryRoot,
      {
        project: PROJECT,
        oldTexts: [OLD_TEXT],
        newTexts: [OLD_TEXT + ' PRIVATE_PROJECT_APPEND_EQUIVALENT_SENTINEL']
      },
      '2026-08-03T10:06:56.000Z'
    );
    assert.equal(appendEquivalent.state, 'needs-input');
    assert.equal(
      appendEquivalent.readiness.blockers[0].reasonCode,
      'PREPARATION_INPUT_INVALID'
    );

    const wholePageReplacement = await prepared(
      temporaryRoot,
      {
        project: PROJECT,
        oldTexts: [sourceBody(temporaryRoot)],
        newTexts: ['PRIVATE_PROJECT_WHOLE_PAGE_SENTINEL']
      },
      '2026-08-03T10:06:57.000Z'
    );
    assert.equal(wholePageReplacement.state, 'needs-input');
    assert.equal(
      wholePageReplacement.readiness.blockers[0].reasonCode,
      'PREPARATION_INPUT_INVALID'
    );

    await assert.rejects(
      () => prepared(
        temporaryRoot,
        {
          project: PROJECT,
          appendText: 'PRIVATE_PROJECT_APPEND_SENTINEL'
        },
        '2026-08-03T10:07:00.000Z'
      ),
      /input contains undeclared fields/
    );

    const sanitized = JSON.stringify({
      property,
      body,
      combined,
      inspection: inspectWorkspace({ root: temporaryRoot })
    });
    for (const sentinel of [
      PROJECT,
      OLD_TEXT,
      bodySentinel,
      'PRIVATE_PROJECT_COMBINED_REPLACEMENT_SENTINEL'
    ]) {
      assert(!sanitized.includes(sentinel), 'Sanitized projection leaked ' + sentinel + '.');
    }
    assert.equal(property.approval.state, 'not-requested');
    assert.equal(property.continuationRequest, null);
    assert.equal(propertyPreview.privacy.approvalAuthorityIncluded, false);
    assert.equal(propertyPreview.privacy.executionAuthorityIncluded, false);
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await selftestProjectPageReconciliation();
  console.log('project page reconciliation selftest passed');
}
