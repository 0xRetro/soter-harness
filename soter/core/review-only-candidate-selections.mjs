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
  createReviewOnlyCandidateSelectionState,
  hasReviewOnlyCandidateSelectionState,
  readReviewOnlyCandidateSelectionState,
  readPreparedWorkState
} from './runtime-state.mjs';

const SELECTION_CONTRACT = 'soter://contracts/review-only-candidate-selection/v1';
const MATERIAL_CONTRACT = 'soter://contracts/review-only-candidate-selection-material/v1';
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
      ? 'REVIEW_ONLY_CANDIDATE_PREVIEW_NOT_CREATED'
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
    ['REVIEW_ONLY_CANDIDATE_PREVIEW_NOT_CREATED', 'CONNECTED_VERIFICATION_NOT_PROVEN']
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

function selectionFingerprint(selection) {
  const unsigned = structuredClone(selection);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function materialFingerprint(material) {
  const unsigned = structuredClone(material);
  delete unsigned.fingerprint;
  delete unsigned.configuration.applicability;
  return fingerprintJson(unsigned);
}

function withSelectionFingerprint(selection) {
  return { ...selection, fingerprint: selectionFingerprint(selection) };
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
        'REVIEW_ONLY_CANDIDATE_SELECTION_INVALID',
        'Incomplete prepared review coverage cannot produce a review-only candidate selection.'
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
            'REVIEW_ONLY_CANDIDATE_SELECTION_BINDING_INVALID',
            'Prepared proposed actions do not bind exact fingerprint-only candidate changes.'
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

function selectionIdentity(work, actions) {
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

function selectionId(work, actions) {
  const hex = fingerprintJson(selectionIdentity(work, actions)).slice('sha256:'.length, 39);
  return 'review-only-candidate-selection.' + work.automation.id.slice('automation.'.length) + '.' + hex;
}

function exactEffects(actions) {
  return [...new Set(actions.map((action) => action.effect))].sort(compareText);
}

function exactSelectionDocument({ work, actions, availableActionCount, blockers, createdAt }) {
  const scope = {
    availableActionCount,
    selectedActionCount: actions.length,
    partial: actions.length !== availableActionCount,
    fingerprint: fingerprintJson(actions)
  };
  return withSelectionFingerprint({
    $contract: SELECTION_CONTRACT,
    contractVersion: VERSION,
    id: selectionId(work, actions),
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
      scope: 'private-local-review-only-candidate-selection',
      authority: 'none',
      projection: 'review-only-candidate-selection-only',
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

function assertSelectionBindings(root, selection, work) {
  const available = proposedActionBindings(work);
  const byId = new Map(available.map((binding) => [binding.action.id, binding]));
  if (selection.work.id !== work.id
    || selection.work.fingerprint !== work.fingerprint
    || selection.work.checkpointId !== work.checkpoint.id
    || selection.work.checkpointFingerprint !== work.checkpoint.fingerprint
    || selection.work.automationId !== work.automation.id
    || selection.work.automationVersion !== work.automation.version
    || fingerprintJson(selection.configuration) !== fingerprintJson({
      name: work.configuration.name,
      path: work.configuration.path,
      lockPath: work.configuration.lockPath,
      configurationBasis: work.configuration.configurationBasis,
      lockFingerprint: work.configuration.lockFingerprint,
      graphFingerprint: work.configuration.graphFingerprint,
      host: work.configuration.host
    })
    || selection.preview.kind !== work.preview.kind
    || selection.preview.fingerprint !== work.preview.fingerprint
    || selection.preview.privateReviewKind !== work.preview.privateReview.kind
    || selection.preview.privateReviewContentFingerprint !== work.preview.privateReview.contentFingerprint) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_BINDING_INVALID',
      'Review-only candidate selection does not bind the exact prepared work, checkpoint, configuration, and private review.'
    );
  }
  const selectedIds = selection.actions.map((action) => action.id);
  const selectedIdSet = new Set(selectedIds);
  const canonicalBindings = available.filter((binding) => {
    return selectedIdSet.has(binding.action.id);
  });
  const expected = canonicalBindings.map(selectedAction);
  if (selectedIdSet.size !== selectedIds.length
    || canonicalBindings.length !== selection.actions.length
    || fingerprintJson(expected) !== fingerprintJson(selection.actions)
    || selection.scope.availableActionCount !== available.length
    || selection.scope.selectedActionCount !== selection.actions.length
    || selection.scope.partial !== (selection.actions.length !== available.length)
    || selection.scope.fingerprint !== fingerprintJson(selection.actions)
    || fingerprintJson(selection.effects) !== fingerprintJson(exactEffects(selection.actions))
    || !blockersMatchWork(root, work, selection.blockers)
    || selection.id !== selectionId(work, selection.actions)) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_BINDING_INVALID',
      'Review-only candidate selection action scope or immutable binding is invalid.'
    );
  }
}

export function assertReviewOnlyCandidateSelection(root, selection, work = null) {
  const resolvedRoot = path.resolve(root);
  try {
    validate(
      resolvedRoot,
      selection,
      'soter/contracts/review-only-candidate-selection.schema.json',
      'Review-only candidate selection'
    );
  } catch (error) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_MALFORMED',
      'Review-only candidate selection does not satisfy its private runtime contract.',
      error
    );
  }
  if (selection.fingerprint !== selectionFingerprint(selection)) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_TAMPERED',
      'Review-only candidate selection fingerprint does not match its immutable contents.'
    );
  }
  let exactWork = work;
  if (!exactWork) {
    try {
      exactWork = readPreparedWorkState(resolvedRoot, selection.work.id).work;
    } catch (error) {
      throw codedError(
        'REVIEW_ONLY_CANDIDATE_SELECTION_BINDING_INVALID',
        'Review-only candidate selection has no exact durable prepared-work binding.',
        error
      );
    }
  }
  try {
    exactWork = assertPreparedWork(resolvedRoot, exactWork);
    assertSelectionBindings(resolvedRoot, selection, exactWork);
  } catch (error) {
    if (error?.code?.startsWith('REVIEW_ONLY_CANDIDATE_SELECTION_')) throw error;
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_BINDING_INVALID',
      'Review-only candidate selection could not revalidate its exact prepared-work scope.',
      error
    );
  }
  return selection;
}

export function createReviewOnlyCandidateSelection({
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
      'REVIEW_ONLY_CANDIDATE_SELECTION_BINDING_INVALID',
      'Review-only candidate selection requires one exact durable prepared work item.',
      error
    );
  }
  const projected = inspectPreparedAutomationWork({ root: resolvedRoot, workId });
  if (projected.configuration.applicability !== 'current') {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_STALE',
      'Stale prepared work cannot create a new review-only candidate selection.'
    );
  }
  if (work.state !== 'ready-for-review'
    || work.preview.fingerprint === null
    || work.preview.privateReview.state !== 'available') {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_INVALID',
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
      'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_BINDING_INVALID',
      'Review-only candidate selection requires valid exact private derived-review material.',
      error
    );
  }
  if (derivedReview.contentFingerprint !== work.preview.privateReview.contentFingerprint) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_BINDING_INVALID',
      'Review-only candidate selection does not bind the exact private derived-review content.'
    );
  }
  if (!Array.isArray(actionIds) || actionIds.length < 1 || actionIds.length > 100
    || actionIds.some((id) => typeof id !== 'string' || id.length < 1)
    || new Set(actionIds).size !== actionIds.length) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_INVALID',
      'Review-only candidate selection requires one to one hundred unique exact proposed action ids.'
    );
  }
  const available = proposedActionBindings(work);
  const selectedIds = new Set(actionIds);
  const selected = available.filter((binding) => selectedIds.has(binding.action.id));
  if (selected.length !== selectedIds.size) {
    const known = new Set();
    for (const collection of work.preview.collections) {
      for (const row of collection.rows) {
        for (const action of row.actions) known.add(action.id);
      }
    }
    const unknown = actionIds.filter((id) => !known.has(id));
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_INVALID',
      unknown.length
        ? 'Review-only candidate selection contains one or more unknown action ids.'
        : 'Review-only candidate selection contains an unavailable, held, prohibited, or handoff action.'
    );
  }
  const actions = selected.map(selectedAction);
  const id = selectionId(work, actions);
  if (hasReviewOnlyCandidateSelectionState(resolvedRoot, id)) {
    let existing;
    try {
      existing = readReviewOnlyCandidateSelectionState(resolvedRoot, id).selection;
      return assertReviewOnlyCandidateSelection(resolvedRoot, existing, work);
    } catch (error) {
      if (error?.code?.startsWith('REVIEW_ONLY_CANDIDATE_SELECTION_')) throw error;
      throw codedError(
        'REVIEW_ONLY_CANDIDATE_SELECTION_MALFORMED',
        'Existing review-only candidate selection could not be read or validated.',
        error
      );
    }
  }
  const selection = exactSelectionDocument({
    work,
    actions,
    availableActionCount: available.length,
    blockers: blockersForWork(resolvedRoot, work),
    createdAt: new Date(createdAt).toISOString()
  });
  assertReviewOnlyCandidateSelection(resolvedRoot, selection, work);
  try {
    createReviewOnlyCandidateSelectionState(resolvedRoot, selection);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      try {
        const existing = readReviewOnlyCandidateSelectionState(resolvedRoot, id).selection;
        return assertReviewOnlyCandidateSelection(resolvedRoot, existing, work);
      } catch (existingError) {
        if (existingError?.code?.startsWith('REVIEW_ONLY_CANDIDATE_SELECTION_')) {
          throw existingError;
        }
        throw codedError(
          'REVIEW_ONLY_CANDIDATE_SELECTION_MALFORMED',
          'Concurrent review-only candidate selection state could not be read or validated.',
          existingError
        );
      }
    }
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_WRITE_FAILED',
      'Review-only candidate selection could not be stored atomically.',
      error
    );
  }
  return selection;
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
        'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_TAMPERED',
        'Review-only candidate selection field fingerprints do not match their private values.'
      );
    }
    fieldIds.add(field.id);
  }
  const unsigned = structuredClone(item);
  delete unsigned.fingerprint;
  if (item.fingerprint !== fingerprintJson(unsigned)) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_TAMPERED',
      'Review-only candidate selection item fingerprint does not match its private fields.'
    );
  }
}

function buildMaterial(selection, work, derivedReview, applicability) {
  const items = new Map(derivedReview.items.map((item) => [item.fingerprint, item]));
  const actions = selection.actions.map((selection) => {
    const proposed = items.get(selection.proposedValueFingerprint);
    const context = selection.contextValueFingerprint === null
      ? null
      : items.get(selection.contextValueFingerprint);
    if (!itemMatchesSelection(proposed, selection)
      || (selection.contextValueFingerprint !== null && !itemMatchesSelection(context, selection))) {
      throw codedError(
        'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_BINDING_INVALID',
        'Review-only candidate selection values do not bind the exact sanitized source row and action.'
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
      'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_CREDENTIAL_REJECTED',
      'Review-only candidate selection material cannot contain credential values.'
    );
  }
  return withMaterialFingerprint({
    $contract: MATERIAL_CONTRACT,
    contractVersion: VERSION,
    fingerprint: 'sha256:' + '0'.repeat(64),
    selection: {
      id: selection.id,
      fingerprint: selection.fingerprint,
      createdAt: selection.createdAt,
      state: selection.state
    },
    work: {
      id: work.id,
      fingerprint: work.fingerprint,
      checkpointId: work.checkpoint.id,
      checkpointFingerprint: work.checkpoint.fingerprint,
      automationId: work.automation.id
    },
    configuration: {
      ...structuredClone(selection.configuration),
      applicability
    },
    scope: structuredClone(selection.scope),
    effects: [...selection.effects],
    actions,
    blockers: [...selection.blockers],
    privacy: {
      scope: 'private-local-review-only-candidate-selection-material',
      authority: 'none',
      projection: 'review-only-candidate-selection-only',
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

export function assertReviewOnlyCandidateSelectionMaterial(root, material, selection, work) {
  const resolvedRoot = path.resolve(root);
  try {
    validate(
      resolvedRoot,
      material,
      'soter/contracts/review-only-candidate-selection-material.schema.json',
      'Review-only candidate selection material'
    );
  } catch (error) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_MALFORMED',
      'Review-only candidate selection material does not satisfy its candidate-selection contract.',
      error
    );
  }
  if (material.fingerprint !== materialFingerprint(material)) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_TAMPERED',
      'Review-only candidate selection material fingerprint does not match its private contents.'
    );
  }
  const validSelection = assertReviewOnlyCandidateSelection(resolvedRoot, selection, work);
  const applicability = inspectPreparedAutomationWork({
    root: resolvedRoot,
    workId: work.id
  }).configuration.applicability;
  if (material.selection.id !== validSelection.id
    || material.selection.fingerprint !== validSelection.fingerprint
    || material.selection.createdAt !== validSelection.createdAt
    || material.selection.state !== validSelection.state
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
    }) !== fingerprintJson(validSelection.configuration)
    || fingerprintJson(material.scope) !== fingerprintJson(validSelection.scope)
    || fingerprintJson(material.effects) !== fingerprintJson(validSelection.effects)
    || fingerprintJson(material.blockers) !== fingerprintJson(validSelection.blockers)
    || material.actions.length !== validSelection.actions.length) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_BINDING_INVALID',
      'Review-only candidate selection material does not bind the exact immutable selection and work.'
    );
  }
  for (let index = 0; index < material.actions.length; index += 1) {
    const action = material.actions[index];
    const selection = validSelection.actions[index];
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
        'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_BINDING_INVALID',
        'Review-only candidate selection material contains a substituted action, context, or proposed value.'
      );
    }
  }
  if (containsCredentialMaterial(material.actions)) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_CREDENTIAL_REJECTED',
      'Review-only candidate selection material cannot contain credential values.'
    );
  }
  return material;
}

export function inspectReviewOnlyCandidateSelectionMaterial({ root, selectionId: requestedSelectionId }) {
  const resolvedRoot = path.resolve(root);
  let exists = false;
  try {
    exists = hasReviewOnlyCandidateSelectionState(resolvedRoot, requestedSelectionId);
  } catch {
    exists = false;
  }
  if (!exists) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_MISSING',
      'Review-only candidate selection is unavailable.'
    );
  }
  let selection;
  try {
    selection = readReviewOnlyCandidateSelectionState(resolvedRoot, requestedSelectionId).selection;
  } catch (error) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_MALFORMED',
      'Review-only candidate selection could not be read.',
      error
    );
  }
  let work;
  try {
    selection = assertReviewOnlyCandidateSelection(resolvedRoot, selection);
    work = readPreparedWorkState(resolvedRoot, selection.work.id).work;
    work = assertPreparedWork(resolvedRoot, work);
  } catch (error) {
    if (error?.code?.startsWith('REVIEW_ONLY_CANDIDATE_SELECTION_')) throw error;
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_BINDING_INVALID',
      'Review-only candidate selection could not revalidate its durable work binding.',
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
      'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_BINDING_INVALID',
      'Review-only candidate selection private values are unavailable or invalid.',
      error
    );
  }
  if (derivedReview.contentFingerprint !== selection.preview.privateReviewContentFingerprint) {
    throw codedError(
      'REVIEW_ONLY_CANDIDATE_SELECTION_MATERIAL_BINDING_INVALID',
      'Review-only candidate selection does not bind the exact private derived-review content.'
    );
  }
  const projected = inspectPreparedAutomationWork({ root: resolvedRoot, workId: work.id });
  const material = buildMaterial(
    selection,
    work,
    derivedReview,
    projected.configuration.applicability
  );
  return assertReviewOnlyCandidateSelectionMaterial(resolvedRoot, material, selection, work);
}
