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
import { runContainedDriveFilingScenario } from './scenario.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-21T16:00:00.000Z';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-drive-filing-selftest-'));
  for (const directory of ['soter']) {
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function fieldsFor(material, kind) {
  const item = material.items.find((candidate) => candidate.kind === kind);
  assert(item, 'Private derived review omitted ' + kind + '.');
  return new Map(item.fields.map((field) => [field.id, field.reviewValue]));
}

function flags(work) {
  return work.preview.collections[0].rows[0].flags;
}

function actions(work) {
  return work.preview.collections[0].rows.flatMap((row) => row.actions);
}

function exactHappyInput(overrides = {}) {
  return {
    artifactUri: 'soter-fixture://storage/artifact/external-research',
    retentionDecision: 'keep',
    subjectKey: 'research',
    placementReason: 'PRIVATE_PLACEMENT_BASIS_SENTINEL for the research library.',
    alternativeSubjectKeys: ['prime'],
    frozenSnapshot: false,
    owner: 'self',
    organization: 'soter-fixture://crm/organization/acme',
    documentType: 'Research',
    description: 'PRIVATE_DOCUMENT_DESCRIPTION_SENTINEL retained for analysis.',
    skipIndexRequested: false,
    ...overrides
  };
}

export async function selftestDriveFiling(root = defaultRoot) {
  const temporaryRoot = copyHarness(root);
  try {
    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/drive-filing.config.json'
    });
    const fixtureDirectory = path.join(temporaryRoot, 'soter', 'fixtures', 'drive-filing');
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const lockPath = 'soter/fixtures/drive-filing/drive-filing.lock.json';
    writeJson(path.join(temporaryRoot, lockPath), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));

    const scenario = await runContainedDriveFilingScenario({
      root: temporaryRoot,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/filing-a-drive-artifact/preparation.scenario.json',
      workId: 'work.drive-filing.preparation-fixture',
      scenarioEvidenceId: 'evidence.drive-filing.preparation.fixture',
      createdAt: AT
    });
    assert.equal(scenario.assessment.result, 'passed');
    assert.equal(scenario.scenarioEvidence.result, 'passed');

    const happyInput = exactHappyInput();
    const work = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.filing-a-drive-artifact',
      configurationName: 'drive-filing',
      configurationBasis: 'tracked-contained',
      input: happyInput,
      createdAt: '2026-07-21T16:01:00.000Z'
    });
    assert.equal(work.state, 'ready-for-review');
    assert.equal(work.preview.kind, 'drive-filing-preview');
    assert.equal(work.preview.proposedChanges.length, 2);
    assert.equal(work.approval.state, 'not-requested');
    assert.equal(work.continuationRequest, null);
    assert.deepEqual(actions(work).map((action) => [action.capability, action.state]), [
      ['storage.shortcuts.create', 'proposed'],
      ['documents.records.create', 'proposed']
    ]);
    const privateArtifactSummary = work.inputSummary.fields.find((field) => {
      return field.id === 'artifactUri';
    });
    assert.equal(privateArtifactSummary.exposure, 'private');
    assert(!Object.hasOwn(privateArtifactSummary, 'value'));

    const originalReview = inspectPreparedAutomationReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    assert.equal(
      originalReview.fields.find((field) => field.id === 'placementReason').reviewValue,
      happyInput.placementReason
    );
    const derived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    assert.equal(derived.kind, 'drive-filing-derived-review');
    const placement = fieldsFor(derived, 'storage-placement');
    const document = fieldsFor(derived, 'document-index-create');
    assert.equal(placement.get('artifactUri'), happyInput.artifactUri);
    assert.equal(placement.get('destinationKey'), 'home.research');
    assert.equal(placement.get('form'), 'shortcut');
    assert.equal(placement.get('placementReason'), happyInput.placementReason);
    assert.deepEqual(placement.get('alternativeSubjectKeys'), ['prime']);
    assert.deepEqual(document.get('documentType'), ['Research']);
    assert.deepEqual(document.get('categories'), ['Research']);
    assert.deepEqual(document.get('ownerIds'), ['provider-person.maya']);
    assert.deepEqual(document.get('organizationUris'), [
      'soter-fixture://crm/organization/acme'
    ]);
    assert.equal(document.get('description'), happyInput.description);

    const selection = createReviewOnlyCandidateSelection({
      root: temporaryRoot,
      workId: work.id,
      actionIds: actions(work).map((action) => action.id),
      createdAt: '2026-07-21T16:01:30.000Z'
    });
    await assert.rejects(
      createReviewOnlyCandidatePreview({
        root: temporaryRoot,
        selectionId: selection.id,
        createdAt: '2026-07-21T16:02:00.000Z'
      }),
      (error) => error?.code === 'REVIEW_ONLY_CANDIDATE_PREVIEW_COMPILER_INVALID'
    );

    const inspection = inspectWorkspace({ root: temporaryRoot });
    const sanitized = JSON.stringify({ work, inspection });
    for (const sentinel of [
      happyInput.artifactUri,
      happyInput.subjectKey,
      happyInput.placementReason,
      happyInput.description,
      'https://drive.example.invalid/external-research',
      'soter-fixture://storage/folder/research'
    ]) {
      assert(!sanitized.includes(sentinel), 'Sanitized projection leaked ' + sentinel + '.');
    }

    const ambiguous = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.filing-a-drive-artifact',
      configurationName: 'drive-filing',
      configurationBasis: 'tracked-contained',
      input: {
        artifactUri: 'soter-fixture://storage/artifact/ambiguous-root',
        retentionDecision: 'keep',
        placementReason: 'PRIVATE_AMBIGUOUS_REASON_SENTINEL has no defensible home.',
        alternativeSubjectKeys: [],
        frozenSnapshot: false,
        description: 'PRIVATE_AMBIGUOUS_DESCRIPTION_SENTINEL awaiting review.',
        skipIndexRequested: false
      },
      createdAt: '2026-07-21T16:03:00.000Z'
    });
    assert.equal(ambiguous.state, 'ready-for-review');
    assert.equal(ambiguous.preview.proposedChanges.length, 0);
    assert(flags(ambiguous).includes('DRIVE_HOME_PROVISIONAL_INBOX'));
    assert(flags(ambiguous).includes('DRIVE_EXISTING_ARTIFACT_REQUIRES_HUMAN_MOVE'));
    assert(flags(ambiguous).includes('DRIVE_DOCUMENT_OWNER_REQUIRED'));
    assert(flags(ambiguous).includes('DRIVE_DOCUMENT_ORGANIZATION_REQUIRED'));
    assert(flags(ambiguous).includes('DRIVE_DOCUMENT_TYPE_REQUIRED'));
    assert(actions(ambiguous).every((action) => action.state !== 'proposed'));
    const ambiguousPlacement = fieldsFor(
      inspectPreparedAutomationDerivedReviewMaterial({
        root: temporaryRoot,
        workId: ambiguous.id
      }),
      'storage-placement'
    );
    assert.equal(ambiguousPlacement.get('destinationKey'), 'home.inbox');
    assert.equal(
      ambiguousPlacement.get('destinationUri'),
      'soter-fixture://storage/folder/inbox'
    );

    const urgent = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.filing-a-drive-artifact',
      configurationName: 'drive-filing',
      configurationBasis: 'tracked-contained',
      input: exactHappyInput({
        artifactUri: 'soter-fixture://storage/artifact/urgent-shortcut',
        subjectKey: 'prime',
        placementReason: 'PRIVATE_URGENT_REASON_SENTINEL belongs with Prime.',
        alternativeSubjectKeys: [],
        documentType: 'Reference',
        description: 'PRIVATE_URGENT_DESCRIPTION_SENTINEL for human move review.',
        skipIndexRequested: true
      }),
      createdAt: '2026-07-21T16:04:00.000Z'
    });
    assert.equal(urgent.preview.proposedChanges.length, 0);
    assert(flags(urgent).includes('DRIVE_EXISTING_ARTIFACT_REQUIRES_HUMAN_MOVE'));
    assert(flags(urgent).includes('DRIVE_REQUIRED_INDEX_SKIP_REQUESTED'));
    assert.equal(actions(urgent)[0].kind, 'storage-move');
    assert.equal(actions(urgent)[0].state, 'handoff');
    assert.equal(actions(urgent)[0].capability, null);
    assert.equal(actions(urgent)[1].state, 'held');
    const urgentPlacement = fieldsFor(
      inspectPreparedAutomationDerivedReviewMaterial({ root: temporaryRoot, workId: urgent.id }),
      'storage-placement'
    );
    assert.equal(urgentPlacement.get('humanMoveInstruction').length, 1);
    assert.match(
      urgentPlacement.get('humanMoveInstruction')[0],
      /Do not copy, rename, or delete/
    );

    const retention = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.filing-a-drive-artifact',
      configurationName: 'drive-filing',
      configurationBasis: 'tracked-contained',
      input: exactHappyInput({ retentionDecision: 'undecided' }),
      createdAt: '2026-07-21T16:05:00.000Z'
    });
    assert.equal(retention.preview.proposedChanges.length, 0);
    assert(flags(retention).includes('DRIVE_RETENTION_DECISION_REQUIRED'));
    assert(actions(retention).every((action) => action.state !== 'proposed'));

    const invalidHome = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.filing-a-drive-artifact',
      configurationName: 'drive-filing',
      configurationBasis: 'tracked-contained',
      input: exactHappyInput({
        subjectKey: 'invented-home',
        alternativeSubjectKeys: ['invented-alternative']
      }),
      createdAt: '2026-07-21T16:06:00.000Z'
    });
    assert.equal(invalidHome.preview.proposedChanges.length, 0);
    assert(flags(invalidHome).includes('DRIVE_SUBJECT_NOT_REGISTERED'));
    assert(flags(invalidHome).includes('DRIVE_ALTERNATIVE_SUBJECT_NOT_REGISTERED'));
    const invalidPlacement = fieldsFor(
      inspectPreparedAutomationDerivedReviewMaterial({
        root: temporaryRoot,
        workId: invalidHome.id
      }),
      'storage-placement'
    );
    assert.equal(invalidPlacement.get('destinationKey'), 'home.inbox');
    assert.notEqual(invalidPlacement.get('destinationKey'), 'invented-home');

    const duplicate = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.filing-a-drive-artifact',
      configurationName: 'drive-filing',
      configurationBasis: 'tracked-contained',
      input: exactHappyInput({
        artifactUri: 'soter-fixture://storage/artifact/duplicate-reference',
        documentType: 'Reference'
      }),
      createdAt: '2026-07-21T16:07:00.000Z'
    });
    assert.equal(duplicate.preview.proposedChanges.length, 0);
    assert(flags(duplicate).includes('DRIVE_DOCUMENT_DUPLICATE_CANDIDATE_OBSERVED'));
    assert(actions(duplicate).every((action) => action.state !== 'proposed'));

    const snapshot = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.filing-a-drive-artifact',
      configurationName: 'drive-filing',
      configurationBasis: 'tracked-contained',
      input: exactHappyInput({ frozenSnapshot: true }),
      createdAt: '2026-07-21T16:08:00.000Z'
    });
    assert.equal(snapshot.preview.proposedChanges.length, 2);
    assert.equal(actions(snapshot)[0].capability, 'storage.files.copy');
    assert.equal(actions(snapshot)[0].state, 'proposed');

    assert.equal(
      fingerprintPath(path.join(temporaryRoot, 'soter')),
      canonicalBefore,
      'Drive Filing preparation changed canonical artifacts.'
    );
    process.stdout.write('Drive Filing self-test passed.\n');
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestDriveFiling().catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
