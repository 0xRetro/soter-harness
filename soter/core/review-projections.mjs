import { containsCredentialMaterial } from './host-runtime.mjs';
import { fingerprintJson } from './lib/canonical-json.mjs';

function defaultInvalid(message) {
  return new Error(message);
}

function defaultMaterialInvalid(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function reviewRowFingerprint(row) {
  const unsigned = structuredClone(row);
  delete unsigned.fingerprint;
  delete unsigned.privateDetailFingerprint;
  for (const action of unsigned.actions) delete action.changeFingerprint;
  return fingerprintJson(unsigned);
}

export function derivedReviewItemFingerprint(item) {
  const unsigned = structuredClone(item);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

export function derivedReviewContentFingerprint(review) {
  return fingerprintJson({ kind: review.kind, items: review.items });
}

export function derivedReviewDefinitionMap(definition) {
  if (!definition) return null;
  const byKind = new Map();
  for (const item of definition.items) {
    if (byKind.has(item.kind)
      || new Set(item.fields.map((field) => field.id)).size !== item.fields.length) {
      throw new Error('Automation derived review declaration has duplicate item or field identities.');
    }
    byKind.set(item.kind, item);
  }
  return byKind;
}

export function assertDerivedReviewDeclaration(review, definition, invalid = defaultInvalid) {
  if (!definition || review.kind !== definition.kind) {
    throw invalid('Private derived review does not match its Automation-owned contract kind.');
  }
  const definitions = derivedReviewDefinitionMap(definition);
  for (const item of review.items) {
    const declared = definitions.get(item.kind);
    if (!declared
      || fingerprintJson(item.fields.map(({ id, label, type }) => ({ id, label, type })))
        !== fingerprintJson(declared.fields)) {
      throw invalid(
        'Private derived review item vocabulary or field order exceeds its Automation-owned contract.'
      );
    }
  }
}

export function assertReviewProjectionSemantics(preview, invalid = defaultInvalid) {
  const rowBindings = new Map();
  const actions = [];
  if (preview.fingerprint === null) {
    if (preview.kind !== 'unavailable'
      || preview.facts.length
      || preview.contradictions.length
      || preview.collections.length
      || preview.proposedChanges.length
      || preview.privateReview.state !== 'unavailable') {
      throw invalid('Unavailable Automation review projection must be empty and carry no private reference.');
    }
    return { rowBindings, actions, changes: new Map() };
  }
  const collectionIds = new Set();
  const rowIds = new Set();
  const actionIds = new Set();
  const proposedActions = new Map();
  let incompleteCollection = false;
  for (const collection of preview.collections) {
    if (collectionIds.has(collection.id)) {
      throw invalid('Automation review collection identities must be globally unique.');
    }
    collectionIds.add(collection.id);
    const unsignedCollection = structuredClone(collection);
    delete unsignedCollection.fingerprint;
    const exclusionCodes = new Set(collection.coverage.exclusions.map((item) => item.reasonCode));
    const excludedCount = collection.coverage.exclusions.reduce((sum, item) => sum + item.count, 0);
    const includedCount = collection.rows.reduce((sum, row) => sum + row.representedCount, 0);
    if (collection.fingerprint !== fingerprintJson(unsignedCollection)
      || collection.coverage.observedCount
        !== collection.coverage.includedCount + collection.coverage.excludedCount
      || collection.coverage.includedCount !== includedCount
      || collection.coverage.excludedCount !== excludedCount
      || exclusionCodes.size !== collection.coverage.exclusions.length) {
      throw invalid('Automation review collection coverage or fingerprint is invalid.');
    }
    if (fingerprintJson(collection.rows.map((row) => row.sequence))
      !== fingerprintJson(collection.rows.map((_, index) => index + 1))) {
      throw invalid('Automation review rows must have one exact contiguous sequence.');
    }
    for (const row of collection.rows) {
      if (rowIds.has(row.id) || row.fingerprint !== reviewRowFingerprint(row)) {
        throw invalid('Automation review row identity or fingerprint is invalid.');
      }
      rowIds.add(row.id);
      const source = {
        collectionId: collection.id,
        rowId: row.id,
        rowFingerprint: row.fingerprint,
        privateDetailFingerprint: row.privateDetailFingerprint
      };
      rowBindings.set(collection.id + '\u0000' + row.id, source);
      for (const action of row.actions) {
        if (actionIds.has(action.id)) {
          throw invalid('Automation review action identities must be globally unique.');
        }
        actionIds.add(action.id);
        const binding = { action, source };
        actions.push(binding);
        if (action.state === 'proposed') proposedActions.set(action.id, binding);
      }
    }
    if (!collection.coverage.complete) incompleteCollection = true;
  }
  const changes = new Map();
  for (const change of preview.proposedChanges) {
    if (changes.has(change.id)) throw invalid('Automation review change identities must be unique.');
    changes.set(change.id, change);
  }
  if (incompleteCollection && (proposedActions.size || changes.size)) {
    throw invalid('Incomplete review coverage cannot propose any external write batch.');
  }
  if (preview.collections.length > 0
    && (changes.size !== proposedActions.size || [...proposedActions].some(([id, binding]) => {
      const change = changes.get(id);
      return !change
        || change.effect !== binding.action.capability
        || change.afterFingerprint === null
        || binding.action.changeFingerprint !== fingerprintJson(change);
    }))) {
    throw invalid('Automation review proposed changes are not exactly bound to write actions.');
  }
  const unsignedPreview = structuredClone(preview);
  delete unsignedPreview.fingerprint;
  if (preview.fingerprint !== fingerprintJson(unsignedPreview)) {
    throw invalid('Automation review projection fingerprint is invalid.');
  }
  return { rowBindings, actions, changes };
}

export function assertAutomationReviewProjection({
  preview,
  derivedReview,
  automationPack,
  lock,
  derivedReviewDefinition,
  invalid = defaultInvalid,
  materialInvalid = defaultMaterialInvalid
}) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || !Array.isArray(preview.collections)) {
    throw invalid('Automation review projection does not declare closed review collections.');
  }
  const { rowBindings, actions, changes } = assertReviewProjectionSemantics(preview, invalid);
  const boundCapabilities = new Map(lock.bindings.map((binding) => [binding.capability, binding]));
  for (const { action } of actions) {
    if (action.capability === null) continue;
    const binding = boundCapabilities.get(action.capability);
    if (!binding
      || !automationPack.capabilities.requires.some((requirement) => {
        return requirement.id === action.capability;
      })
      || !binding.effects.includes(action.effect)
      || binding.effects.some((effect) => !automationPack.effects.includes(effect))) {
      throw invalid(
        'Automation review action ' + action.id
          + ' names an undeclared or unbound Automation effect capability.'
      );
    }
  }
  const reference = preview.privateReview;
  if (derivedReview === null) {
    if (reference?.state !== 'unavailable'
      || reference.kind !== null
      || reference.contractId !== null
      || reference.contractFingerprint !== null
      || reference.contentFingerprint !== null) {
      throw invalid('Automation review declares private derived content that was not supplied.');
    }
  } else {
    if (Object.keys(derivedReview).sort().join(',') !== 'items,kind'
      || typeof derivedReview.kind !== 'string'
      || !Array.isArray(derivedReview.items)) {
      throw materialInvalid(
        'MALFORMED',
        'Automation derived review output is not a closed kind and item collection.'
      );
    }
    assertDerivedReviewDeclaration(
      derivedReview,
      derivedReviewDefinition,
      (message) => materialInvalid('MALFORMED', message)
    );
    const itemIds = new Set();
    const itemFingerprints = new Map();
    const credentialShape = {};
    for (const item of derivedReview.items) {
      if (itemIds.has(item.id)) {
        throw materialInvalid(
          'MALFORMED',
          'Automation derived review item kinds and identities must be declared and unique.'
        );
      }
      itemIds.add(item.id);
      if (!item.sources.every((source) => {
        return rowBindings.get(source.collectionId + '\u0000' + source.rowId)
          ?.rowFingerprint === source.rowFingerprint;
      })) {
        throw materialInvalid(
          'BINDING_INVALID',
          'Automation derived review items must bind only to exact sanitized review rows.'
        );
      }
      const fieldIds = new Set();
      for (const field of item.fields) {
        if (fieldIds.has(field.id)
          || field.fingerprint !== fingerprintJson(field.reviewValue)) {
          throw materialInvalid(
            'MALFORMED',
            'Automation derived review fields exceed their closed item contract or fingerprint.'
          );
        }
        fieldIds.add(field.id);
        credentialShape[item.id + '.' + field.id] = field.reviewValue;
      }
      if (item.fingerprint !== derivedReviewItemFingerprint(item)) {
        throw materialInvalid(
          'TAMPERED',
          'Automation derived review item fingerprint does not match its normalized fields.'
        );
      }
      if (itemFingerprints.has(item.fingerprint)) {
        throw materialInvalid(
          'BINDING_INVALID',
          'Automation derived review item fingerprints must be unique.'
        );
      }
      itemFingerprints.set(item.fingerprint, item);
    }
    if (containsCredentialMaterial(credentialShape)) {
      throw materialInvalid(
        'CREDENTIAL_REJECTED',
        'Automation derived review material cannot contain credential material.'
      );
    }
    const contentFingerprint = derivedReviewContentFingerprint(derivedReview);
    if (reference?.state !== 'available'
      || reference.kind !== derivedReview.kind
      || reference.contractId !== derivedReviewDefinition.$contract
      || reference.contractFingerprint !== fingerprintJson(derivedReviewDefinition)
      || reference.contentFingerprint !== contentFingerprint) {
      throw materialInvalid(
        'BINDING_INVALID',
        'Sanitized private-review reference does not bind the exact Automation review content.'
      );
    }
    for (const binding of rowBindings.values()) {
      if (binding.privateDetailFingerprint === null) continue;
      const detail = itemFingerprints.get(binding.privateDetailFingerprint);
      if (!detail || !detail.sources.some((source) => {
        return source.collectionId === binding.collectionId
          && source.rowId === binding.rowId
          && source.rowFingerprint === binding.rowFingerprint;
      })) {
        throw materialInvalid(
          'BINDING_INVALID',
          'Sanitized private-detail references must bind an exact private item and source row.'
        );
      }
    }
    for (const { action, source } of actions.filter(({ action }) => action.state === 'proposed')) {
      const change = changes.get(action.id);
      const privateItem = itemFingerprints.get(change.afterFingerprint);
      if (!privateItem || privateItem.kind !== action.kind || !privateItem.sources.some((candidate) => {
        return candidate.collectionId === source.collectionId
          && candidate.rowId === source.rowId
          && candidate.rowFingerprint === source.rowFingerprint;
      })) {
        throw materialInvalid(
          'BINDING_INVALID',
          'Proposed changes must bind exact private review material for the same sanitized row.'
        );
      }
    }
  }
  return { rowBindings, actions, changes };
}
