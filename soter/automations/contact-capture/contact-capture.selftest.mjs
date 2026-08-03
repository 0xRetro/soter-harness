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
import { runContainedContactCaptureScenario } from './scenario.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-21T12:00:00.000Z';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-contact-capture-selftest-'));
  for (const directory of ['soter']) {
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function reviewFields(material) {
  return new Map(material.items[0].fields.map((field) => [field.id, field.reviewValue]));
}

function rowFlags(work) {
  return work.preview.collections[0].rows[0].flags;
}

export async function selftestContactCapture(root = defaultRoot) {
  const temporaryRoot = copyHarness(root);
  try {
    const lock = resolveConfiguration({
      root: temporaryRoot,
      configPath: 'soter/configurations/contact-capture.config.json'
    });
    const fixtureDirectory = path.join(temporaryRoot, 'soter', 'fixtures', 'contact-capture');
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const lockPath = 'soter/fixtures/contact-capture/contact-capture.lock.json';
    writeJson(path.join(temporaryRoot, lockPath), lock);
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));

    const scenario = await runContainedContactCaptureScenario({
      root: temporaryRoot,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/contact-capture/preparation.scenario.json',
      workId: 'work.contact-capture.preparation-fixture',
      scenarioEvidenceId: 'evidence.contact-capture.preparation.fixture',
      createdAt: AT
    });
    assert.equal(scenario.assessment.result, 'passed');
    assert.equal(scenario.scenarioEvidence.result, 'passed');

    const privateInput = {
      name: 'PRIVATE_CONTACT_NAME_SENTINEL',
      email: 'Private.Contact@Example.Invalid',
      organizationName: 'Acme Design',
      role: 'engineering',
      status: 'prospect',
      disposition: 'coach',
      authority: ['Technical Buyer'],
      tags: ['Prospect', 'Priority'],
      telegram: 'PRIVATE_TELEGRAM_SENTINEL',
      signal: 'PRIVATE_SIGNAL_SENTINEL',
      github: 'PRIVATE_GITHUB_SENTINEL',
      timezoneUtc: 'UTC+1',
      source: 'PRIVATE_SOURCE_SENTINEL'
    };
    const work = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.contact-capture',
      configurationName: 'contact-capture',
      configurationBasis: 'tracked-contained',
      input: privateInput,
      createdAt: '2026-07-21T12:01:00.000Z'
    });
    assert.equal(work.state, 'ready-for-review');
    assert.equal(work.preview.proposedChanges.length, 1);
    assert.equal(work.approval.state, 'not-requested');
    assert.equal(work.continuationRequest, null);
    assert.equal(work.inputSummary.fields.find((field) => field.id === 'name').exposure, 'private');
    assert(!Object.hasOwn(work.inputSummary.fields.find((field) => field.id === 'name'), 'value'));

    const originalReview = inspectPreparedAutomationReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    assert.equal(
      originalReview.fields.find((field) => field.id === 'name').reviewValue,
      privateInput.name
    );
    const derived = inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: work.id
    });
    assert.equal(derived.kind, 'contact-capture-derived-review');
    const fields = reviewFields(derived);
    assert.equal(fields.get('name'), privateInput.name);
    assert.deepEqual(fields.get('email'), ['private.contact@example.invalid']);
    assert.deepEqual(fields.get('role'), ['Engineering']);
    assert.deepEqual(fields.get('status'), ['Prospect']);
    assert.deepEqual(fields.get('disposition'), ['Coach']);
    assert.deepEqual(fields.get('authority'), ['Technical Buyer']);
    assert.deepEqual(fields.get('tags'), ['Priority', 'Prospect']);
    assert.deepEqual(fields.get('organizationUris'), [
      'soter-fixture://crm/organization/acme'
    ]);
    assert.deepEqual(fields.get('duplicateSearchValues'), [
      'email:private.contact@example.invalid',
      'name:PRIVATE_CONTACT_NAME_SENTINEL'
    ]);

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
      { email: 'private.contact@example.invalid' },
      { name: privateInput.name }
    ]);
    assert.deepEqual(preview.operations[0].input.fields, {
      name: privateInput.name,
      email: 'private.contact@example.invalid',
      role: 'Engineering',
      status: 'Prospect',
      disposition: 'Coach',
      authority: ['Technical Buyer'],
      tags: ['Priority', 'Prospect'],
      telegram: privateInput.telegram,
      signal: privateInput.signal,
      github: privateInput.github,
      timezoneUtc: privateInput.timezoneUtc,
      source: privateInput.source,
      organizationUris: ['soter-fixture://crm/organization/acme']
    });
    assert.equal(preview.operations[0].ambiguity.retry, 'prohibited');
    assert.equal(preview.operations[0].recovery.mode, 'manual-required');

    const inspection = inspectWorkspace({ root: temporaryRoot });
    const sanitized = JSON.stringify({ work, inspection });
    for (const sentinel of [
      privateInput.name,
      privateInput.email,
      privateInput.organizationName,
      privateInput.telegram,
      privateInput.signal,
      privateInput.github,
      privateInput.source
    ]) {
      assert(!sanitized.includes(sentinel), 'Sanitized projection leaked ' + sentinel + '.');
    }

    const pressure = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.contact-capture',
      configurationName: 'contact-capture',
      configurationBasis: 'tracked-contained',
      input: {
        name: 'Pressure Contact',
        role: 'VP of Engineering',
        disposition: 'supportive',
        tags: ['VIP']
      },
      createdAt: '2026-07-21T12:03:00.000Z'
    });
    assert.equal(pressure.state, 'ready-for-review');
    assert.equal(pressure.preview.proposedChanges.length, 1);
    assert(rowFlags(pressure).includes('CONTACT_ROLE_NOT_IN_CURRENT_SCHEMA'));
    assert(rowFlags(pressure).includes('CONTACT_DISPOSITION_NOT_IN_CURRENT_SCHEMA'));
    assert(rowFlags(pressure).includes('CONTACT_TAGS_NOT_IN_CURRENT_SCHEMA'));
    const pressureFields = reviewFields(inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: pressure.id
    }));
    assert.deepEqual(pressureFields.get('role'), []);
    assert.deepEqual(pressureFields.get('disposition'), []);
    assert.deepEqual(pressureFields.get('tags'), []);
    assert(!pressureFields.get('disposition').includes('Champion'));

    const unresolved = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.contact-capture',
      configurationName: 'contact-capture',
      configurationBasis: 'tracked-contained',
      input: {
        name: 'Unresolved Organization Contact',
        organizationName: 'PRIVATE_UNKNOWN_ORGANIZATION_SENTINEL'
      },
      createdAt: '2026-07-21T12:04:00.000Z'
    });
    assert.equal(unresolved.state, 'ready-for-review');
    assert.equal(unresolved.preview.proposedChanges.length, 1);
    assert(rowFlags(unresolved).includes('CONTACT_ORGANIZATION_NOT_FOUND'));
    const unresolvedFields = reviewFields(inspectPreparedAutomationDerivedReviewMaterial({
      root: temporaryRoot,
      workId: unresolved.id
    }));
    assert.deepEqual(unresolvedFields.get('organizationUris'), []);
    assert(!JSON.stringify({ unresolved, inspection: inspectWorkspace({ root: temporaryRoot }) })
      .includes('PRIVATE_UNKNOWN_ORGANIZATION_SENTINEL'));

    const duplicate = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.contact-capture',
      configurationName: 'contact-capture',
      configurationBasis: 'tracked-contained',
      input: { name: 'Maya Chen' },
      createdAt: '2026-07-21T12:05:00.000Z'
    });
    assert.equal(duplicate.state, 'ready-for-review');
    assert.equal(duplicate.preview.proposedChanges.length, 0);
    assert.equal(duplicate.preview.collections[0].rows[0].actions[0].state, 'held');
    assert(rowFlags(duplicate).includes('CONTACT_DUPLICATE_CANDIDATE_OBSERVED'));

    const duplicateList = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.contact-capture',
      configurationName: 'contact-capture',
      configurationBasis: 'tracked-contained',
      input: { name: 'Duplicate List Contact', tags: ['Priority', 'Priority'] },
      createdAt: '2026-07-21T12:06:00.000Z'
    });
    assert.equal(duplicateList.state, 'needs-input');
    assert.equal(duplicateList.readiness.blockers[0].reasonCode, 'INPUT_INVALID');
    assert.match(duplicateList.readiness.blockers[0].message, /duplicate values/);

    const nonTextList = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.contact-capture',
      configurationName: 'contact-capture',
      configurationBasis: 'tracked-contained',
      input: { name: 'Non Text List Contact', authority: ['User', 42] },
      createdAt: '2026-07-21T12:07:00.000Z'
    });
    assert.equal(nonTextList.state, 'needs-input');
    assert.equal(nonTextList.readiness.blockers[0].reasonCode, 'INPUT_INVALID');
    assert.match(nonTextList.readiness.blockers[0].message, /non-text value/);

    assert.equal(
      fingerprintPath(path.join(temporaryRoot, 'soter')),
      canonicalBefore,
      'Contact Capture preparation changed canonical artifacts.'
    );
    process.stdout.write('Contact Capture self-test passed.\n');
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestContactCapture().catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
