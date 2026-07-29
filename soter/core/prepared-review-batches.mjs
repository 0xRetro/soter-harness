import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
import { fingerprintJson, readJson, resolveRepoPath } from './lib/canonical-json.mjs';
import {
  assertPreparedWork,
  inspectPreparedAutomationDerivedReviewMaterial,
  inspectPreparedAutomationWork
} from './prepared-work.mjs';
import {
  createPreparedReviewBatchState,
  hasPreparedReviewBatchState,
  readPreparedReviewBatchState,
  readPreparedWorkState
} from './runtime-state.mjs';

const BATCH_CONTRACT = 'soter://contracts/prepared-review-batch/v1';
const MATERIAL_CONTRACT = 'soter://contracts/prepared-review-batch-material/v1';
const VERSION = '1.0.0';
function blockersForWork(root, work) {
  const manifest = readJson(path.join(
    root,
    'soter',
    'packs',
    work.automation.id,
    'pack.json'
  ));
  return [
    manifest.operator?.connection
      ? 'CONNECTED_PLAN_NOT_COMPILED'
      : 'CONNECTED_COMPILER_NOT_DECLARED',
    'CONNECTED_VERIFICATION_NOT_PROVEN'
  ];
}

function blockersMatchWork(root, work, blockers) {
  const expected = blockersForWork(root, work);
  let manifestCurrent = false;
  try {
    const manifest = readJson(path.join(root, 'soter', 'packs', work.automation.id, 'pack.json'));
    const lock = readJson(resolveRepoPath(root, work.configuration.lockPath));
    const lockedPack = lock.packs.find((pack) => pack.id === work.automation.id);
    manifestCurrent = lockedPack?.manifestFingerprint === fingerprintJson(manifest);
  } catch {
    manifestCurrent = false;
  }
  if (manifestCurrent) return fingerprintJson(blockers) === fingerprintJson(expected);
  const staleAllowed = [
    ['CONNECTED_COMPILER_NOT_DECLARED', 'CONNECTED_VERIFICATION_NOT_PROVEN'],
    ['CONNECTED_PLAN_NOT_COMPILED', 'CONNECTED_VERIFICATION_NOT_PROVEN']
  ];
  return staleAllowed.some((candidate) => {
    return fingerprintJson(blockers) === fingerprintJson(candidate);
  });
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en');
}

function validate(root, value, contractPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, contractPath)));
  if (failures.length) {
    throw new Error(label + ' does not satisfy its contract: '
      + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; '));
  }
}

function codedError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function batchFingerprint(batch) {
  const unsigned = structuredClone(batch);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function materialFingerprint(material) {
  const unsigned = structuredClone(material);
  delete unsigned.fingerprint;
  delete unsigned.configuration.applicability;
  return fingerprintJson(unsigned);
}

function withBatchFingerprint(batch) {
  return { ...batch, fingerprint: batchFingerprint(batch) };
}

function withMaterialFingerprint(material) {
  return { ...material, fingerprint: materialFingerprint(material) };
}

function proposedActionBindings(work) {
  const changes = new Map(work.preview.proposedChanges.map((change) => [change.id, change]));
  const bindings = [];
  for (const collection of work.preview.collections) {
    if (!collection.coverage.complete) {
      throw codedError(
        'PREPARED_REVIEW_BATCH_SELECTION_INVALID',
        'Incomplete prepared review coverage cannot produce a selected review batch.'
      );
    }
    for (const row of collection.rows) {
      for (const action of row.actions) {
        if (action.state !== 'proposed') continue;
        const change = changes.get(action.id);
        if (!change || action.capability === null || action.effect === null
          || action.changeFingerprint === null
          || action.changeFingerprint !== fingerprintJson(change)
          || change.effect !== action.capability
          || change.afterFingerprint === null) {
          throw codedError(
            'PREPARED_REVIEW_BATCH_BINDING_INVALID',
            'Prepared proposed actions do not bind exact fingerprint-only changes.'
          );
        }
        bindings.push({ collection, row, action, change });
      }
    }
  }
  return bindings;
}

function selectedAction(action, index) {
  const { collection, row, change } = action;
  return {
    id: action.action.id,
    sequence: index + 1,
    kind: action.action.kind,
    reasonCode: action.action.reasonCode,
    capability: action.action.capability,
    effect: action.action.effect,
    source: {
      collectionId: collection.id,
      rowId: row.id,
      rowFingerprint: row.fingerprint
    },
    subjectFingerprint: row.subject.fingerprint,
    sourceActionFingerprint: fingerprintJson(action.action),
    changeFingerprint: action.action.changeFingerprint,
    contextValueFingerprint: row.privateDetailFingerprint,
    proposedValueFingerprint: change.afterFingerprint
  };
}

function batchIdentity(work, actions) {
  return {
    workId: work.id,
    workFingerprint: work.fingerprint,
    checkpointId: work.checkpoint.id,
    checkpointFingerprint: work.checkpoint.fingerprint,
    previewFingerprint: work.preview.fingerprint,
    lockFingerprint: work.configuration.lockFingerprint,
    actions
  };
}

function batchId(work, actions) {
  const hex = fingerprintJson(batchIdentity(work, actions)).slice('sha256:'.length, 39);
  return 'review-batch.' + work.automation.id.slice('automation.'.length) + '.' + hex;
}

function exactEffects(actions) {
  return [...new Set(actions.map((action) => action.effect))].sort(compareText);
}

function exactBatchDocument({ work, actions, availableActionCount, blockers, createdAt }) {
  const scope = {
    availableActionCount,
    selectedActionCount: actions.length,
    partial: actions.length !== availableActionCount,
    fingerprint: fingerprintJson(actions)
  };
  return withBatchFingerprint({
    $contract: BATCH_CONTRACT,
    contractVersion: VERSION,
    id: batchId(work, actions),
    fingerprint: 'sha256:' + '0'.repeat(64),
    createdAt,
    work: {
      id: work.id,
      fingerprint: work.fingerprint,
      checkpointId: work.checkpoint.id,
      checkpointFingerprint: work.checkpoint.fingerprint,
      automationId: work.automation.id,
      automationVersion: work.automation.version
    },
    configuration: {
      name: work.configuration.name,
      path: work.configuration.path,
      lockPath: work.configuration.lockPath,
      configurationBasis: work.configuration.configurationBasis,
      lockFingerprint: work.configuration.lockFingerprint,
      graphFingerprint: work.configuration.graphFingerprint,
      host: work.configuration.host
    },
    preview: {
      kind: work.preview.kind,
      fingerprint: work.preview.fingerprint,
      privateReviewKind: work.preview.privateReview.kind,
      privateReviewContentFingerprint: work.preview.privateReview.contentFingerprint
    },
    state: 'review-only',
    effects: exactEffects(actions),
    scope,
    actions,
    blockers: [...blockers],
    privacy: {
      scope: 'private-local-review-batch',
      authority: 'none',
      projection: 'selected-batch-only',
      privateValuesIncluded: false,
      providerArgumentsIncluded: false,
      rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsIncluded: false,
      approvalAuthorityIncluded: false,
      continuationAuthorityIncluded: false,
      executionAuthorityIncluded: false
    }
  });
}

function assertBatchBindings(root, batch, work) {
  const available = proposedActionBindings(work);
  const byId = new Map(available.map((binding) => [binding.action.id, binding]));
  if (batch.work.id !== work.id
    || batch.work.fingerprint !== work.fingerprint
    || batch.work.checkpointId !== work.checkpoint.id
    || batch.work.checkpointFingerprint !== work.checkpoint.fingerprint
    || batch.work.automationId !== work.automation.id
    || batch.work.automationVersion !== work.automation.version
    || fingerprintJson(batch.configuration) !== fingerprintJson({
      name: work.configuration.name,
      path: work.configuration.path,
      lockPath: work.configuration.lockPath,
      configurationBasis: work.configuration.configurationBasis,
      lockFingerprint: work.configuration.lockFingerprint,
      graphFingerprint: work.configuration.graphFingerprint,
      host: work.configuration.host
    })
    || batch.preview.kind !== work.preview.kind
    || batch.preview.fingerprint !== work.preview.fingerprint
    || batch.preview.privateReviewKind !== work.preview.privateReview.kind
    || batch.preview.privateReviewContentFingerprint !== work.preview.privateReview.contentFingerprint) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_BINDING_INVALID',
      'Prepared review batch does not bind the exact prepared work, checkpoint, configuration, and private review.'
    );
  }
  const selectedIds = batch.actions.map((action) => action.id);
  const selectedIdSet = new Set(selectedIds);
  const canonicalBindings = available.filter((binding) => {
    return selectedIdSet.has(binding.action.id);
  });
  const expected = canonicalBindings.map(selectedAction);
  if (selectedIdSet.size !== selectedIds.length
    || canonicalBindings.length !== batch.actions.length
    || fingerprintJson(expected) !== fingerprintJson(batch.actions)
    || batch.scope.availableActionCount !== available.length
    || batch.scope.selectedActionCount !== batch.actions.length
    || batch.scope.partial !== (batch.actions.length !== available.length)
    || batch.scope.fingerprint !== fingerprintJson(batch.actions)
    || fingerprintJson(batch.effects) !== fingerprintJson(exactEffects(batch.actions))
    || !blockersMatchWork(root, work, batch.blockers)
    || batch.id !== batchId(work, batch.actions)) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_BINDING_INVALID',
      'Prepared review batch action scope or immutable binding is invalid.'
    );
  }
}

export function assertPreparedReviewBatch(root, batch, work = null) {
  const resolvedRoot = path.resolve(root);
  try {
    validate(
      resolvedRoot,
      batch,
      'soter/contracts/prepared-review-batch.schema.json',
      'Prepared review batch'
    );
  } catch (error) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_MALFORMED',
      'Prepared review batch does not satisfy its private runtime contract.',
      error
    );
  }
  if (batch.fingerprint !== batchFingerprint(batch)) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_TAMPERED',
      'Prepared review batch fingerprint does not match its immutable contents.'
    );
  }
  let exactWork = work;
  if (!exactWork) {
    try {
      exactWork = readPreparedWorkState(resolvedRoot, batch.work.id).work;
    } catch (error) {
      throw codedError(
        'PREPARED_REVIEW_BATCH_BINDING_INVALID',
        'Prepared review batch has no exact durable prepared-work binding.',
        error
      );
    }
  }
  try {
    exactWork = assertPreparedWork(resolvedRoot, exactWork);
    assertBatchBindings(resolvedRoot, batch, exactWork);
  } catch (error) {
    if (error?.code?.startsWith('PREPARED_REVIEW_BATCH_')) throw error;
    throw codedError(
      'PREPARED_REVIEW_BATCH_BINDING_INVALID',
      'Prepared review batch could not revalidate its exact prepared-work scope.',
      error
    );
  }
  return batch;
}

export function createPreparedReviewBatch({
  root,
  workId,
  actionIds,
  createdAt = new Date().toISOString()
}) {
  const resolvedRoot = path.resolve(root);
  let work;
  try {
    work = readPreparedWorkState(resolvedRoot, workId).work;
    work = assertPreparedWork(resolvedRoot, work);
  } catch (error) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_BINDING_INVALID',
      'Prepared review batch requires one exact durable prepared work item.',
      error
    );
  }
  const projected = inspectPreparedAutomationWork({ root: resolvedRoot, workId });
  if (projected.configuration.applicability !== 'current') {
    throw codedError(
      'PREPARED_REVIEW_BATCH_STALE',
      'Stale prepared work cannot create a new selected review batch.'
    );
  }
  if (work.state !== 'ready-for-review'
    || work.preview.fingerprint === null
    || work.preview.privateReview.state !== 'available') {
    throw codedError(
      'PREPARED_REVIEW_BATCH_SELECTION_INVALID',
      'Prepared work must have a complete private review and proposed actions before selection.'
    );
  }
  let derivedReview;
  try {
    derivedReview = inspectPreparedAutomationDerivedReviewMaterial({
      root: resolvedRoot,
      workId
    });
  } catch (error) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_MATERIAL_BINDING_INVALID',
      'Prepared review selection requires valid exact private derived-review material.',
      error
    );
  }
  if (derivedReview.contentFingerprint !== work.preview.privateReview.contentFingerprint) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_MATERIAL_BINDING_INVALID',
      'Prepared review selection does not bind the exact private derived-review content.'
    );
  }
  if (!Array.isArray(actionIds) || actionIds.length < 1 || actionIds.length > 100
    || actionIds.some((id) => typeof id !== 'string' || id.length < 1)
    || new Set(actionIds).size !== actionIds.length) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_SELECTION_INVALID',
      'Prepared review selection requires one to one hundred unique exact proposed action ids.'
    );
  }
  const available = proposedActionBindings(work);
  const selectedIds = new Set(actionIds);
  const selected = available.filter((binding) => selectedIds.has(binding.action.id));
  if (selected.length !== selectedIds.size) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_SELECTION_INVALID',
      'Prepared review selection contains an unavailable, held, prohibited, or handoff action.'
    );
  }
  const actions = selected.map(selectedAction);
  const id = batchId(work, actions);
  if (hasPreparedReviewBatchState(resolvedRoot, id)) {
    let existing;
    try {
      existing = readPreparedReviewBatchState(resolvedRoot, id).batch;
      return assertPreparedReviewBatch(resolvedRoot, existing, work);
    } catch (error) {
      if (error?.code?.startsWith('PREPARED_REVIEW_BATCH_')) throw error;
      throw codedError(
        'PREPARED_REVIEW_BATCH_MALFORMED',
        'Existing prepared review batch could not be read or validated.',
        error
      );
    }
  }
  const batch = exactBatchDocument({
    work,
    actions,
    availableActionCount: available.length,
    blockers: blockersForWork(resolvedRoot, work),
    createdAt: new Date(createdAt).toISOString()
  });
  assertPreparedReviewBatch(resolvedRoot, batch, work);
  try {
    createPreparedReviewBatchState(resolvedRoot, batch);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      try {
        const existing = readPreparedReviewBatchState(resolvedRoot, id).batch;
        return assertPreparedReviewBatch(resolvedRoot, existing, work);
      } catch (existingError) {
        if (existingError?.code?.startsWith('PREPARED_REVIEW_BATCH_')) {
          throw existingError;
        }
        throw codedError(
          'PREPARED_REVIEW_BATCH_MALFORMED',
          'Concurrent prepared review batch state could not be read or validated.',
          existingError
        );
      }
    }
    throw codedError(
      'PREPARED_REVIEW_BATCH_WRITE_FAILED',
      'Prepared review batch could not be stored atomically.',
      error
    );
  }
  return batch;
}

function itemMatchesSelection(item, selection) {
  return item?.sources?.some((source) => {
    return source.collectionId === selection.source.collectionId
      && source.rowId === selection.source.rowId
      && source.rowFingerprint === selection.source.rowFingerprint;
  });
}

function assertPrivateItemIntegrity(item) {
  const fieldIds = new Set();
  for (const field of item.fields) {
    if (fieldIds.has(field.id)
      || field.fingerprint !== fingerprintJson(field.reviewValue)) {
      throw codedError(
        'PREPARED_REVIEW_BATCH_MATERIAL_TAMPERED',
        'Selected review batch field fingerprints do not match their private values.'
      );
    }
    fieldIds.add(field.id);
  }
  const unsigned = structuredClone(item);
  delete unsigned.fingerprint;
  if (item.fingerprint !== fingerprintJson(unsigned)) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_MATERIAL_TAMPERED',
      'Selected review batch item fingerprint does not match its private fields.'
    );
  }
}

function buildMaterial(batch, work, derivedReview, applicability) {
  const items = new Map(derivedReview.items.map((item) => [item.fingerprint, item]));
  const actions = batch.actions.map((selection) => {
    const proposed = items.get(selection.proposedValueFingerprint);
    const context = selection.contextValueFingerprint === null
      ? null
      : items.get(selection.contextValueFingerprint);
    if (!itemMatchesSelection(proposed, selection)
      || (selection.contextValueFingerprint !== null && !itemMatchesSelection(context, selection))) {
      throw codedError(
        'PREPARED_REVIEW_BATCH_MATERIAL_BINDING_INVALID',
        'Selected review batch values do not bind the exact sanitized source row and action.'
      );
    }
    return {
      selection: structuredClone(selection),
      context: context ? structuredClone(context) : null,
      proposed: structuredClone(proposed)
    };
  });
  if (containsCredentialMaterial(actions)) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_MATERIAL_CREDENTIAL_REJECTED',
      'Selected review batch material cannot contain credential values.'
    );
  }
  return withMaterialFingerprint({
    $contract: MATERIAL_CONTRACT,
    contractVersion: VERSION,
    fingerprint: 'sha256:' + '0'.repeat(64),
    batch: {
      id: batch.id,
      fingerprint: batch.fingerprint,
      createdAt: batch.createdAt,
      state: batch.state
    },
    work: {
      id: work.id,
      fingerprint: work.fingerprint,
      checkpointId: work.checkpoint.id,
      checkpointFingerprint: work.checkpoint.fingerprint,
      automationId: work.automation.id
    },
    configuration: {
      ...structuredClone(batch.configuration),
      applicability
    },
    scope: structuredClone(batch.scope),
    effects: [...batch.effects],
    actions,
    blockers: [...batch.blockers],
    privacy: {
      scope: 'private-local-review-batch-material',
      authority: 'none',
      projection: 'selected-batch-only',
      providerArgumentsIncluded: false,
      rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsIncluded: false,
      approvalAuthorityIncluded: false,
      continuationAuthorityIncluded: false,
      executionAuthorityIncluded: false
    }
  });
}

export function assertPreparedReviewBatchMaterial(root, material, batch, work) {
  const resolvedRoot = path.resolve(root);
  try {
    validate(
      resolvedRoot,
      material,
      'soter/contracts/prepared-review-batch-material.schema.json',
      'Prepared review batch material'
    );
  } catch (error) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_MATERIAL_MALFORMED',
      'Prepared review batch material does not satisfy its selected-batch contract.',
      error
    );
  }
  if (material.fingerprint !== materialFingerprint(material)) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_MATERIAL_TAMPERED',
      'Prepared review batch material fingerprint does not match its private contents.'
    );
  }
  const validBatch = assertPreparedReviewBatch(resolvedRoot, batch, work);
  const applicability = inspectPreparedAutomationWork({
    root: resolvedRoot,
    workId: work.id
  }).configuration.applicability;
  if (material.batch.id !== validBatch.id
    || material.batch.fingerprint !== validBatch.fingerprint
    || material.batch.createdAt !== validBatch.createdAt
    || material.batch.state !== validBatch.state
    || material.work.id !== work.id
    || material.work.fingerprint !== work.fingerprint
    || material.work.checkpointId !== work.checkpoint.id
    || material.work.checkpointFingerprint !== work.checkpoint.fingerprint
    || material.work.automationId !== work.automation.id
    || material.configuration.applicability !== applicability
    || fingerprintJson({
      name: material.configuration.name,
      path: material.configuration.path,
      lockPath: material.configuration.lockPath,
      configurationBasis: material.configuration.configurationBasis,
      lockFingerprint: material.configuration.lockFingerprint,
      graphFingerprint: material.configuration.graphFingerprint,
      host: material.configuration.host
    }) !== fingerprintJson(validBatch.configuration)
    || fingerprintJson(material.scope) !== fingerprintJson(validBatch.scope)
    || fingerprintJson(material.effects) !== fingerprintJson(validBatch.effects)
    || fingerprintJson(material.blockers) !== fingerprintJson(validBatch.blockers)
    || material.actions.length !== validBatch.actions.length) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_MATERIAL_BINDING_INVALID',
      'Prepared review batch material does not bind the exact immutable batch and work.'
    );
  }
  for (let index = 0; index < material.actions.length; index += 1) {
    const action = material.actions[index];
    const selection = validBatch.actions[index];
    assertPrivateItemIntegrity(action.proposed);
    if (action.context !== null) assertPrivateItemIntegrity(action.context);
    if (fingerprintJson(action.selection) !== fingerprintJson(selection)
      || action.proposed.fingerprint !== selection.proposedValueFingerprint
      || !itemMatchesSelection(action.proposed, selection)
      || (selection.contextValueFingerprint === null
        ? action.context !== null
        : action.context?.fingerprint !== selection.contextValueFingerprint
          || !itemMatchesSelection(action.context, selection))) {
      throw codedError(
        'PREPARED_REVIEW_BATCH_MATERIAL_BINDING_INVALID',
        'Prepared review batch material contains a substituted action, context, or proposed value.'
      );
    }
  }
  if (containsCredentialMaterial(material.actions)) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_MATERIAL_CREDENTIAL_REJECTED',
      'Prepared review batch material cannot contain credential values.'
    );
  }
  return material;
}

export function inspectPreparedReviewBatchMaterial({ root, batchId: requestedBatchId }) {
  const resolvedRoot = path.resolve(root);
  let exists = false;
  try {
    exists = hasPreparedReviewBatchState(resolvedRoot, requestedBatchId);
  } catch {
    exists = false;
  }
  if (!exists) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_MISSING',
      'Prepared review batch is unavailable.'
    );
  }
  let batch;
  try {
    batch = readPreparedReviewBatchState(resolvedRoot, requestedBatchId).batch;
  } catch (error) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_MALFORMED',
      'Prepared review batch could not be read.',
      error
    );
  }
  let work;
  try {
    batch = assertPreparedReviewBatch(resolvedRoot, batch);
    work = readPreparedWorkState(resolvedRoot, batch.work.id).work;
    work = assertPreparedWork(resolvedRoot, work);
  } catch (error) {
    if (error?.code?.startsWith('PREPARED_REVIEW_BATCH_')) throw error;
    throw codedError(
      'PREPARED_REVIEW_BATCH_BINDING_INVALID',
      'Prepared review batch could not revalidate its durable work binding.',
      error
    );
  }
  let derivedReview;
  try {
    derivedReview = inspectPreparedAutomationDerivedReviewMaterial({
      root: resolvedRoot,
      workId: work.id
    });
  } catch (error) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_MATERIAL_BINDING_INVALID',
      'Prepared review batch private values are unavailable or invalid.',
      error
    );
  }
  if (derivedReview.contentFingerprint !== batch.preview.privateReviewContentFingerprint) {
    throw codedError(
      'PREPARED_REVIEW_BATCH_MATERIAL_BINDING_INVALID',
      'Prepared review batch does not bind the exact private derived-review content.'
    );
  }
  const projected = inspectPreparedAutomationWork({ root: resolvedRoot, workId: work.id });
  const material = buildMaterial(
    batch,
    work,
    derivedReview,
    projected.configuration.applicability
  );
  return assertPreparedReviewBatchMaterial(resolvedRoot, material, batch, work);
}
