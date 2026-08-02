import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspace } from './inspection.mjs';
import { fingerprintJson, fingerprintPath } from './lib/canonical-json.mjs';
import { prepareAutomationRun } from './prepared-work.mjs';
import {
  assertPreparedReviewBatch,
  assertPreparedReviewBatchMaterial,
  createPreparedReviewBatch,
  inspectPreparedReviewBatchMaterial
} from './prepared-review-batches.mjs';
import {
  preparedReviewBatchStatePath,
  preparedWorkDerivedReviewMaterialStatePath
} from './runtime-state.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function resignBatch(batch) {
  const unsigned = structuredClone(batch);
  delete unsigned.fingerprint;
  batch.fingerprint = fingerprintJson(unsigned);
  return batch;
}

function resignMaterial(material) {
  const unsigned = structuredClone(material);
  delete unsigned.fingerprint;
  delete unsigned.configuration.applicability;
  material.fingerprint = fingerprintJson(unsigned);
  return material;
}

function reidentifyBatch(batch, work) {
  const identity = {
    workId: work.id,
    workFingerprint: work.fingerprint,
    checkpointId: work.checkpoint.id,
    checkpointFingerprint: work.checkpoint.fingerprint,
    previewFingerprint: work.preview.fingerprint,
    lockFingerprint: work.configuration.lockFingerprint,
    actions: batch.actions
  };
  const hex = fingerprintJson(identity).slice('sha256:'.length, 39);
  batch.id = 'review-batch.' + work.automation.id.slice('automation.'.length) + '.' + hex;
  return resignBatch(batch);
}

function substituteReviewValue(field, suffix) {
  if (typeof field.reviewValue === 'string') {
    field.reviewValue += ' ' + suffix;
  } else if (typeof field.reviewValue === 'boolean') {
    field.reviewValue = !field.reviewValue;
  } else {
    field.reviewValue = [...field.reviewValue, suffix];
  }
}

function createBatchProcess(root, workId, actionId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'soter/core/cli.mjs',
      'operator-review-batch-create',
      '--work-id', workId,
      '--action-id', actionId,
      '--json'
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('Concurrent batch create failed: ' + stderr));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error('Concurrent batch create returned invalid JSON.', { cause: error }));
      }
    });
  });
}

export async function selftestPreparedReviewBatches(root = defaultRoot) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-review-batch-selftest-'));
  try {
    fs.cpSync(path.join(root, 'soter'), path.join(temporaryRoot, 'soter'), { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
    }
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const focus = 'PRIVATE_REVIEW_BATCH_FOCUS_SENTINEL';
    const work = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.email-triage',
      configurationName: 'email-triage',
      configurationBasis: 'tracked-contained',
      input: {
        query: 'in:inbox newer_than:1d',
        scope: 'triage-drafts-handoffs-digest',
        focus
      },
      createdAt: '2026-07-16T18:00:00.000Z'
    });
    const proposed = work.preview.collections.flatMap((collection) => {
      return collection.rows.flatMap((row) => row.actions);
    }).filter((action) => action.state === 'proposed');
    const draft = proposed.find((action) => action.kind === 'draft');
    assert(draft, 'Email fixture must provide one proposed draft action.');
    const draftRow = work.preview.collections.flatMap((collection) => {
      return collection.rows;
    }).find((row) => row.actions.some((action) => action.id === draft.id));
    const label = draftRow.actions.find((action) => action.kind === 'label');
    assert(label, 'Draft review row must provide its exact proposed label action.');

    const batch = createPreparedReviewBatch({
      root: temporaryRoot,
      workId: work.id,
      actionIds: [draft.id, label.id],
      createdAt: '2026-07-16T18:01:00.000Z'
    });
    assert.equal(batch.$contract, 'soter://contracts/prepared-review-batch/v1');
    assert.equal(batch.state, 'review-only');
    assert.equal(batch.scope.availableActionCount, proposed.length);
    assert.equal(batch.scope.selectedActionCount, 2);
    assert.equal(batch.scope.partial, true);
    assert.deepEqual(batch.actions.map((action) => action.id), [label.id, draft.id],
      'Selection order must follow the immutable prepared review, not request order.');
    assert.deepEqual(batch.effects, ['write']);
    assert.deepEqual(batch.blockers, [
      'CONNECTED_PLAN_NOT_COMPILED',
      'CONNECTED_VERIFICATION_NOT_PROVEN'
    ]);
    assert.equal(batch.privacy.authority, 'none');
    assert.equal(batch.privacy.approvalAuthorityIncluded, false);
    assert.equal(batch.privacy.continuationAuthorityIncluded, false);
    assert.equal(batch.privacy.executionAuthorityIncluded, false);
    const serializedBatch = JSON.stringify(batch);
    assert(!serializedBatch.includes('in:inbox newer_than:1d'));
    assert(!serializedBatch.includes(focus));
    assert(!serializedBatch.includes('Complete draft body'));
    assert(!serializedBatch.includes('Thanks for the note.'));

    const batchFile = preparedReviewBatchStatePath(temporaryRoot, batch.id);
    assert.equal(fs.statSync(batchFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(batchFile)).mode & 0o777, 0o700);
    const reentered = createPreparedReviewBatch({
      root: temporaryRoot,
      workId: work.id,
      actionIds: [label.id, draft.id],
      createdAt: '2026-07-16T18:02:00.000Z'
    });
    assert.equal(reentered.fingerprint, batch.fingerprint);
    assert.equal(reentered.createdAt, batch.createdAt,
      'Exact re-entry must not replace an immutable selected batch.');

    const concurrent = await Promise.all([
      createBatchProcess(temporaryRoot, work.id, draft.id),
      createBatchProcess(temporaryRoot, work.id, draft.id),
      createBatchProcess(temporaryRoot, work.id, draft.id),
      createBatchProcess(temporaryRoot, work.id, draft.id)
    ]);
    assert.equal(new Set(concurrent.map((item) => item.id)).size, 1);
    assert.equal(new Set(concurrent.map((item) => item.fingerprint)).size, 1);
    assert.equal(new Set(concurrent.map((item) => item.createdAt)).size, 1,
      'Concurrent exact re-entry must return the one create-only document.');

    const material = inspectPreparedReviewBatchMaterial({
      root: temporaryRoot,
      batchId: batch.id
    });
    assert.equal(material.$contract, 'soter://contracts/prepared-review-batch-material/v1');
    assert.equal(material.batch.fingerprint, batch.fingerprint);
    assert.equal(material.configuration.applicability, 'current');
    assert.equal(material.actions.length, 2);
    assert(material.actions.some((action) => {
      return action.proposed.kind === 'draft'
        && action.proposed.fields.some((field) => {
          return field.id === 'body' && field.reviewValue.includes('Thanks for the note.');
        });
    }));
    assert(material.actions.every((action) => {
      return action.proposed.fingerprint === action.selection.proposedValueFingerprint
        && action.context?.fingerprint === action.selection.contextValueFingerprint;
    }));
    assert.equal(material.privacy.authority, 'none');
    assert.equal(material.privacy.approvalAuthorityIncluded, false);
    assert.equal(material.privacy.continuationAuthorityIncluded, false);
    assert.equal(material.privacy.executionAuthorityIncluded, false);

    assert.throws(() => createPreparedReviewBatch({
      root: temporaryRoot,
      workId: work.id,
      actionIds: [label.id, label.id]
    }), (error) => error.code === 'PREPARED_REVIEW_BATCH_SELECTION_INVALID');
    const hostileUnknownAction = 'action.email-triage.not-present-/private/operator/token';
    assert.throws(() => createPreparedReviewBatch({
      root: temporaryRoot,
      workId: work.id,
      actionIds: [hostileUnknownAction]
    }), (error) => {
      return error.code === 'PREPARED_REVIEW_BATCH_SELECTION_INVALID'
        && error.message.includes('one or more unknown action ids')
        && !error.message.includes(hostileUnknownAction)
        && !error.message.includes('/private/operator/token');
    }, 'An unknown action id must keep the stable diagnostic class without echoing caller input.');
    const handoff = work.preview.collections.flatMap((collection) => {
      return collection.rows.flatMap((row) => row.actions);
    }).find((action) => action.state === 'handoff');
    assert(handoff, 'Email fixture must declare at least one handoff boundary.');
    assert.throws(() => createPreparedReviewBatch({
      root: temporaryRoot,
      workId: work.id,
      actionIds: [handoff.id]
    }), (error) => {
      return error.code === 'PREPARED_REVIEW_BATCH_SELECTION_INVALID'
        && error.message.includes('unavailable, held, prohibited, or handoff action');
    }, 'A known handoff action must be distinguished from an unknown action id.');
    const prohibited = work.preview.collections.flatMap((collection) => {
      return collection.rows.flatMap((row) => row.actions);
    }).find((action) => action.state === 'prohibited');
    assert(prohibited, 'Email fixture must declare its prohibited send boundary.');
    assert.throws(() => createPreparedReviewBatch({
      root: temporaryRoot,
      workId: work.id,
      actionIds: [prohibited.id]
    }), (error) => {
      return error.code === 'PREPARED_REVIEW_BATCH_SELECTION_INVALID'
        && error.message.includes('unavailable, held, prohibited, or handoff action');
    }, 'A known prohibited action must be distinguished from an unknown action id.');

    const substitutedBatch = structuredClone(batch);
    substitutedBatch.actions[0].proposedValueFingerprint = batch.actions[1].proposedValueFingerprint;
    substitutedBatch.scope.fingerprint = fingerprintJson(substitutedBatch.actions);
    resignBatch(substitutedBatch);
    assert.throws(
      () => assertPreparedReviewBatch(temporaryRoot, substitutedBatch, work),
      (error) => error.code === 'PREPARED_REVIEW_BATCH_BINDING_INVALID'
    );
    const substitutedBatchBasis = structuredClone(batch);
    substitutedBatchBasis.configuration.configurationBasis = 'private-active';
    resignBatch(substitutedBatchBasis);
    assert.throws(
      () => assertPreparedReviewBatch(temporaryRoot, substitutedBatchBasis, work),
      (error) => error.code === 'PREPARED_REVIEW_BATCH_BINDING_INVALID'
    );
    const reorderedBatch = structuredClone(batch);
    reorderedBatch.actions.reverse();
    reorderedBatch.actions.forEach((action, index) => {
      action.sequence = index + 1;
    });
    reorderedBatch.scope.fingerprint = fingerprintJson(reorderedBatch.actions);
    reidentifyBatch(reorderedBatch, work);
    assert.throws(
      () => assertPreparedReviewBatch(temporaryRoot, reorderedBatch, work),
      (error) => error.code === 'PREPARED_REVIEW_BATCH_BINDING_INVALID'
    );
    const substitutedMaterial = structuredClone(material);
    substitutedMaterial.actions[0].proposed = structuredClone(material.actions[1].proposed);
    resignMaterial(substitutedMaterial);
    assert.throws(
      () => assertPreparedReviewBatchMaterial(temporaryRoot, substitutedMaterial, batch, work),
      (error) => error.code === 'PREPARED_REVIEW_BATCH_MATERIAL_BINDING_INVALID'
    );
    const substitutedPrivateValue = structuredClone(material);
    const privateField = substitutedPrivateValue.actions[0].proposed.fields[0];
    substituteReviewValue(privateField, 'HOSTILE_PRIVATE_SUBSTITUTION');
    resignMaterial(substitutedPrivateValue);
    assert.throws(
      () => assertPreparedReviewBatchMaterial(
        temporaryRoot,
        substitutedPrivateValue,
        batch,
        work
      ),
      (error) => error.code === 'PREPARED_REVIEW_BATCH_MATERIAL_TAMPERED'
    );
    const substitutedContextValue = structuredClone(material);
    const contextField = substitutedContextValue.actions.find((action) => {
      return action.context !== null;
    }).context.fields[0];
    substituteReviewValue(contextField, 'HOSTILE_CONTEXT_SUBSTITUTION');
    resignMaterial(substitutedContextValue);
    assert.throws(
      () => assertPreparedReviewBatchMaterial(
        temporaryRoot,
        substitutedContextValue,
        batch,
        work
      ),
      (error) => error.code === 'PREPARED_REVIEW_BATCH_MATERIAL_TAMPERED'
    );
    const falseApplicability = structuredClone(material);
    falseApplicability.configuration.applicability = 'stale';
    resignMaterial(falseApplicability);
    assert.throws(
      () => assertPreparedReviewBatchMaterial(temporaryRoot, falseApplicability, batch, work),
      (error) => error.code === 'PREPARED_REVIEW_BATCH_MATERIAL_BINDING_INVALID'
    );
    const substitutedConfigurationBasis = structuredClone(material);
    substitutedConfigurationBasis.configuration.configurationBasis = 'private-active';
    resignMaterial(substitutedConfigurationBasis);
    assert.throws(
      () => assertPreparedReviewBatchMaterial(
        temporaryRoot,
        substitutedConfigurationBasis,
        batch,
        work
      ),
      (error) => error.code === 'PREPARED_REVIEW_BATCH_MATERIAL_BINDING_INVALID'
    );
    const rawProviderEscape = structuredClone(material);
    rawProviderEscape.actions[0].rawProviderResponse = 'HOSTILE_RAW_PROVIDER_RESPONSE';
    resignMaterial(rawProviderEscape);
    assert.throws(
      () => assertPreparedReviewBatchMaterial(temporaryRoot, rawProviderEscape, batch, work),
      (error) => error.code === 'PREPARED_REVIEW_BATCH_MATERIAL_MALFORMED'
    );

    const taskTitle = 'PRIVATE_TASK_BATCH_TITLE_SENTINEL';
    const taskDate = '2099-12-31';
    const taskWork = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      configurationBasis: 'tracked-contained',
      input: {
        title: taskTitle,
        project: 'soter-fixture://projects/project/launch',
        assignee: 'self',
        nextActionOn: taskDate,
        context: 'Project'
      },
      createdAt: '2026-07-16T18:02:30.000Z'
    });
    const taskAction = taskWork.preview.collections[0].rows[0].actions[0];
    assert.equal(taskAction.kind, 'task-create');
    assert.equal(taskAction.state, 'proposed');
    const taskBatch = createPreparedReviewBatch({
      root: temporaryRoot,
      workId: taskWork.id,
      actionIds: [taskAction.id],
      createdAt: '2026-07-16T18:03:00.000Z'
    });
    assert.equal(taskBatch.scope.availableActionCount, 1);
    assert.equal(taskBatch.scope.selectedActionCount, 1);
    assert.equal(taskBatch.scope.partial, false);
    assert.deepEqual(taskBatch.blockers, [
      'CONNECTED_PLAN_NOT_COMPILED',
      'CONNECTED_VERIFICATION_NOT_PROVEN'
    ]);
    assert(!JSON.stringify(taskBatch).includes(taskTitle));
    assert(!JSON.stringify(taskBatch).includes(taskDate));
    const taskMaterial = inspectPreparedReviewBatchMaterial({
      root: temporaryRoot,
      batchId: taskBatch.id
    });
    assert.equal(taskMaterial.actions.length, 1);
    assert.equal(taskMaterial.actions[0].proposed.kind, 'task-create');
    assert.equal(taskMaterial.actions[0].context.fingerprint,
      taskMaterial.actions[0].proposed.fingerprint);
    const taskFields = new Map(taskMaterial.actions[0].proposed.fields.map((field) => {
      return [field.id, field.reviewValue];
    }));
    assert.equal(taskFields.get('title'), taskTitle);
    assert.deepEqual(taskFields.get('projectUris'), ['soter-fixture://projects/project/launch']);
    assert.deepEqual(taskFields.get('assigneeIds'), ['provider-person.maya']);
    assert.deepEqual(taskFields.get('nextActionOn'), [taskDate]);
    assert.equal(taskMaterial.privacy.authority, 'none');
    assert.equal(taskMaterial.privacy.approvalAuthorityIncluded, false);
    assert.equal(taskMaterial.privacy.executionAuthorityIncluded, false);

    const duplicateTaskWork = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.task-capture',
      configurationName: 'task-capture',
      configurationBasis: 'tracked-contained',
      input: {
        title: 'Send launch deck',
        project: 'soter-fixture://projects/project/launch',
        context: 'Project'
      },
      createdAt: '2026-07-16T18:03:30.000Z'
    });
    const heldTaskAction = duplicateTaskWork.preview.collections[0].rows[0].actions[0];
    assert.equal(heldTaskAction.state, 'held');
    assert.throws(() => createPreparedReviewBatch({
      root: temporaryRoot,
      workId: duplicateTaskWork.id,
      actionIds: [heldTaskAction.id]
    }), (error) => {
      return error.code === 'PREPARED_REVIEW_BATCH_SELECTION_INVALID'
        && error.message.includes('unavailable, held, prohibited, or handoff action');
    }, 'A known held action must be distinguished from an unknown action id.');

    const derivedPath = preparedWorkDerivedReviewMaterialStatePath(temporaryRoot, work.id);
    const heldDerivedPath = derivedPath + '.held';
    fs.renameSync(derivedPath, heldDerivedPath);
    try {
      assert.throws(() => createPreparedReviewBatch({
        root: temporaryRoot,
        workId: work.id,
        actionIds: [label.id]
      }), (error) => error.code === 'PREPARED_REVIEW_BATCH_MATERIAL_BINDING_INVALID');
    } finally {
      fs.renameSync(heldDerivedPath, derivedPath);
    }

    const workspace = inspectWorkspace({ root: temporaryRoot });
    const serializedWorkspace = JSON.stringify(workspace);
    assert(!serializedWorkspace.includes(batch.id));
    assert(!serializedWorkspace.includes(taskBatch.id));
    assert(!serializedWorkspace.includes('Thanks for the note.'));
    assert(!serializedWorkspace.includes(focus));
    assert(!serializedWorkspace.includes(taskTitle));
    assert(!serializedWorkspace.includes(taskDate));
    assert.equal(fs.existsSync(path.join(temporaryRoot, '.soter', 'state', 'approval-requests')), false);
    assert.equal(fs.existsSync(path.join(temporaryRoot, '.soter', 'state', 'approvals')), false);
    assert.equal(fs.existsSync(path.join(temporaryRoot, '.soter', 'state', 'approval-consumptions')), false);
    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore,
      'Prepared review batch work changed canonical artifacts.');

    const modelPath = path.join(temporaryRoot, 'soter', 'contexts', 'email', 'processing.model.json');
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    model.window.maximumThreads = 49;
    fs.writeFileSync(modelPath, JSON.stringify(model, null, 2) + '\n');
    const staleMaterial = inspectPreparedReviewBatchMaterial({
      root: temporaryRoot,
      batchId: batch.id
    });
    assert.equal(staleMaterial.configuration.applicability, 'stale');
    assert.equal(staleMaterial.fingerprint, material.fingerprint,
      'Derived applicability must not alter immutable private material identity.');
    assert.throws(() => createPreparedReviewBatch({
      root: temporaryRoot,
      workId: work.id,
      actionIds: [label.id]
    }), (error) => error.code === 'PREPARED_REVIEW_BATCH_STALE');

    assert.throws(() => inspectPreparedReviewBatchMaterial({
      root: temporaryRoot,
      batchId: 'review-batch.missing.value'
    }), (error) => error.code === 'PREPARED_REVIEW_BATCH_MISSING');
    fs.writeFileSync(batchFile, '{ malformed private state\n');
    assert.throws(() => inspectPreparedReviewBatchMaterial({
      root: temporaryRoot,
      batchId: batch.id
    }), (error) => error.code === 'PREPARED_REVIEW_BATCH_MALFORMED');
    process.stdout.write(
      'PREPARED REVIEW BATCH SELFTEST PASS: exact partial subsets, create-only private state, '
        + 'selected values, stale applicability, privacy exclusion, and no authority.\n'
    );
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
