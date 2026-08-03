import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

const PROPERTY_ACTION = 'action.project-page-reconciliation.properties';
const BODY_ACTION = 'action.project-page-reconciliation.body';

function sameJson(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return fingerprintJson(left) === fingerprintJson(right);
}

function fieldMap(item) {
  return new Map(item.fields.map((field) => [field.id, field.reviewValue]));
}

function exactText(fields, id) {
  const value = fields.get(id);
  if (typeof value !== 'string' || !value) {
    throw new Error(
      'Project page reconciliation compiler requires one exact private ' + id + ' value.'
    );
  }
  return value;
}

function exactStringList(fields, id, { minimum = 0, maximum = 100 } = {}) {
  const value = fields.get(id);
  if (!Array.isArray(value)
    || value.length < minimum
    || value.length > maximum
    || value.some((item) => typeof item !== 'string' || !item)
    || new Set(value).size !== value.length) {
    throw new Error(
      'Project page reconciliation compiler requires exact unique private ' + id + ' values.'
    );
  }
  return [...value];
}

function exactJsonObject(fields, id) {
  const serialized = exactText(fields, id);
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('Project page reconciliation compiler received malformed private ' + id + '.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Project page reconciliation compiler requires one private object for ' + id + '.');
  }
  return value;
}

function observation(capability, input, kind, expected) {
  return {
    capability,
    input,
    inputFingerprint: fingerprintJson(input),
    expectation: {
      kind,
      expectedFingerprint: fingerprintJson(expected)
    }
  };
}

function expectedPrecondition(capability, input, kind, expected) {
  return { kind: 'expectation', ...observation(capability, input, kind, expected) };
}

function privateReview({ type, id, before, after, precondition }) {
  return {
    subject: { kind: 'portable-resource', type, id },
    before: {
      state: 'provided',
      reasonCode: 'PRIOR_VALUE_REQUIRED',
      fingerprint: fingerprintJson(before),
      reviewValue: structuredClone(before)
    },
    after: {
      state: 'provided',
      fingerprint: fingerprintJson(after),
      reviewValue: structuredClone(after)
    },
    precondition: {
      fingerprint: fingerprintJson(precondition),
      reviewValue: structuredClone(precondition)
    }
  };
}

function exactPropertyPatch(beforeFields, afterFields, patchFields) {
  const allowed = ['projectType', 'status'];
  if (patchFields.length < 1
    || patchFields.length > 2
    || patchFields.some((field) => !allowed.includes(field))
    || !sameJson([...patchFields].sort(), patchFields)) {
    throw new Error('Project page reconciliation property selection is unavailable or unordered.');
  }
  const allKeys = new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)]);
  const changed = [...allKeys].filter((key) => !sameJson(beforeFields[key], afterFields[key])).sort();
  if (!sameJson(changed, patchFields)) {
    throw new Error('Project page reconciliation property material does not preserve unselected fields.');
  }
  return Object.fromEntries(patchFields.map((field) => [field, afterFields[field]]));
}

function compileProperties(materialAction, sequence) {
  const selection = materialAction.selection;
  if (selection.id !== PROPERTY_ACTION
    || selection.kind !== 'project-properties-update'
    || selection.capability !== 'projects.records.update'
    || selection.effect !== 'write'
    || materialAction.proposed.kind !== 'project-properties-update') {
    throw new Error('Project page reconciliation compiler received an unsupported property action.');
  }
  const fields = fieldMap(materialAction.proposed);
  const projectId = exactText(fields, 'projectId');
  const expectedTitle = exactText(fields, 'expectedTitle');
  const expectedVersion = exactText(fields, 'expectedVersion');
  const bodyFingerprint = exactText(fields, 'bodyFingerprint');
  const patchFields = exactStringList(fields, 'patchFields', { minimum: 1, maximum: 2 });
  const beforeFields = exactJsonObject(fields, 'beforeFieldsJson');
  const afterFields = exactJsonObject(fields, 'afterFieldsJson');
  const patch = exactPropertyPatch(beforeFields, afterFields, patchFields);
  const beforeProjectType = exactStringList(fields, 'beforeProjectType', { maximum: 1 });
  const afterProjectType = exactStringList(fields, 'afterProjectType', { maximum: 1 });
  const beforeStatus = exactStringList(fields, 'beforeStatus', { maximum: 1 });
  const afterStatus = exactStringList(fields, 'afterStatus', { maximum: 1 });
  if (!sameJson(beforeProjectType, typeof beforeFields.projectType === 'string' ? [beforeFields.projectType] : [])
    || !sameJson(afterProjectType, typeof afterFields.projectType === 'string' ? [afterFields.projectType] : [])
    || !sameJson(beforeStatus, typeof beforeFields.status === 'string' ? [beforeFields.status] : [])
    || !sameJson(afterStatus, typeof afterFields.status === 'string' ? [afterFields.status] : [])) {
    throw new Error('Project page reconciliation property summaries do not bind the exact field objects.');
  }
  const preconditionInput = {
    recordTypes: ['project'],
    ids: [projectId],
    content: { expectedTitle },
    limit: 1
  };
  const beforeObservation = {
    records: [{
      type: 'project',
      fields: beforeFields,
      bodyFingerprint,
      recordIdState: 'exact-request'
    }]
  };
  const precondition = expectedPrecondition(
    'projects.records.read',
    preconditionInput,
    'project-properties-current',
    beforeObservation
  );
  const updateInput = {
    recordType: 'project',
    id: projectId,
    expectedVersion,
    patch
  };
  const verificationInput = {
    recordTypes: ['project'],
    ids: [projectId],
    content: { expectedTitle },
    limit: 1
  };
  const afterObservation = {
    records: [{
      type: 'project',
      fields: afterFields,
      bodyFingerprint,
      recordIdState: 'exact-request'
    }]
  };
  return {
    id: 'operation.project-page-reconciliation.properties',
    sequence,
    sourceActionId: selection.id,
    capability: selection.capability,
    effect: 'write',
    input: updateInput,
    inputFingerprint: fingerprintJson(updateInput),
    precondition,
    verification: observation(
      'projects.records.read',
      verificationInput,
      'project-properties-updated-with-body-preserved',
      afterObservation
    ),
    review: privateReview({
      type: 'project',
      id: projectId,
      before: {
        recordType: 'project',
        version: expectedVersion,
        fields: beforeFields,
        bodyFingerprint
      },
      after: {
        recordType: 'project',
        fields: afterFields,
        bodyFingerprint
      },
      precondition
    }),
    ambiguity: {
      retry: 'prohibited',
      reconcileWith: 'verification',
      unresolvedState: 'needs-attention',
      reasonCode: 'PROJECT_PROPERTIES_UPDATE_AMBIGUOUS'
    },
    recovery: {
      mode: 'manual-required',
      reasonCode: 'PROJECT_PROPERTIES_RESTORE_NOT_AUTOMATED'
    }
  };
}

function compileBody(materialAction, sequence, selectedIds) {
  const selection = materialAction.selection;
  if (selection.id !== BODY_ACTION
    || selection.kind !== 'project-body-update'
    || selection.capability !== 'documents.content.update'
    || selection.effect !== 'write'
    || materialAction.proposed.kind !== 'project-body-update') {
    throw new Error('Project page reconciliation compiler received an unsupported body action.');
  }
  const fields = fieldMap(materialAction.proposed);
  const projectId = exactText(fields, 'projectId');
  const expectedTitle = exactText(fields, 'expectedTitle');
  const expectedBodyFingerprint = exactText(fields, 'expectedBodyFingerprint');
  const afterBodyFingerprint = exactText(fields, 'afterBodyFingerprint');
  const beforeFields = exactJsonObject(fields, 'beforeFieldsJson');
  const afterFields = exactJsonObject(fields, 'afterFieldsJson');
  const updateIds = exactStringList(fields, 'updateIds', { minimum: 1, maximum: 20 });
  const oldTexts = exactStringList(fields, 'oldTexts', { minimum: 1, maximum: 20 });
  const newTexts = exactStringList(fields, 'newTexts', { minimum: 1, maximum: 20 });
  if (updateIds.length !== oldTexts.length
    || updateIds.length !== newTexts.length
    || oldTexts.some((value, index) => value === newTexts[index])) {
    throw new Error('Project page reconciliation body material is not one aligned changing set.');
  }
  const updates = updateIds.map((id, index) => ({
    id,
    oldText: oldTexts[index],
    newText: newTexts[index],
    replaceAllMatches: false
  }));
  const propertySelected = selectedIds.includes(PROPERTY_ACTION);
  const expectedFields = propertySelected ? afterFields : beforeFields;
  const readInput = {
    recordTypes: ['project'],
    ids: [projectId],
    content: { expectedTitle },
    limit: 1
  };
  const beforeObservation = {
    records: [{
      type: 'project',
      fields: expectedFields,
      bodyFingerprint: expectedBodyFingerprint,
      recordIdState: 'exact-request'
    }]
  };
  const afterObservation = {
    records: [{
      type: 'project',
      fields: expectedFields,
      bodyFingerprint: afterBodyFingerprint,
      recordIdState: 'exact-request'
    }]
  };
  const precondition = expectedPrecondition(
    'projects.records.read',
    readInput,
    propertySelected
      ? 'project-body-current-after-properties'
      : 'project-body-current-with-fields',
    beforeObservation
  );
  const updateInput = {
    uri: projectId,
    expectedTitle,
    expectedBodyFingerprint,
    updates
  };
  return {
    id: 'operation.project-page-reconciliation.body',
    sequence,
    sourceActionId: selection.id,
    capability: selection.capability,
    effect: 'write',
    input: updateInput,
    inputFingerprint: fingerprintJson(updateInput),
    precondition,
    verification: observation(
      'projects.records.read',
      readInput,
      propertySelected
        ? 'project-body-updated-with-final-fields'
        : 'project-body-updated-with-fields-preserved',
      afterObservation
    ),
    review: privateReview({
      type: 'project-document',
      id: projectId,
      before: {
        uri: projectId,
        title: expectedTitle,
        fields: expectedFields,
        bodyFingerprint: expectedBodyFingerprint,
        replacedText: oldTexts
      },
      after: {
        uri: projectId,
        title: expectedTitle,
        fields: expectedFields,
        bodyFingerprint: afterBodyFingerprint,
        replacementText: newTexts
      },
      precondition
    }),
    ambiguity: {
      retry: 'prohibited',
      reconcileWith: 'verification',
      unresolvedState: 'needs-attention',
      reasonCode: 'PROJECT_BODY_UPDATE_AMBIGUOUS'
    },
    recovery: {
      mode: 'manual-required',
      reasonCode: 'PROJECT_BODY_RESTORE_NOT_AUTOMATED'
    }
  };
}

export function compileProjectPageReconciliationConnectedOperations({ batch, material }) {
  const automationId = batch.work?.automationId || batch.automationId;
  if (automationId !== 'automation.project-page-reconciliation'
    || material.selection.id !== batch.id
    || material.selection.fingerprint !== batch.fingerprint
    || batch.actions.length < 1
    || batch.actions.length > 2
    || material.actions.length !== batch.actions.length) {
    throw new Error('Project page reconciliation compiler requires one exact review-only candidate selection.');
  }
  const selectedIds = batch.actions.map((action) => action.id);
  const allowed = [
    [PROPERTY_ACTION],
    [BODY_ACTION],
    [PROPERTY_ACTION, BODY_ACTION]
  ];
  if (!allowed.some((candidate) => sameJson(candidate, selectedIds))) {
    throw new Error(
      'Project page reconciliation compiler requires property update before body update and no unsupported action.'
    );
  }
  const operations = material.actions.map((materialAction, index) => {
    if (materialAction.selection.id !== batch.actions[index].id) {
      throw new Error('Project page reconciliation material order does not match its exact batch.');
    }
    return materialAction.selection.id === PROPERTY_ACTION
      ? compileProperties(materialAction, index + 1)
      : compileBody(materialAction, index + 1, selectedIds);
  });
  if (operations.length === 2
    && !sameJson(
      operations[0].review.after.reviewValue.fields,
      operations[1].review.before.reviewValue.fields
    )) {
    throw new Error(
      'Combined Project property and body material does not bind one exact aggregate final field state.'
    );
  }
  return { operations };
}

function failedRecordObservation(records) {
  return {
    records: records.map((record) => ({
      type: record?.type || 'unknown',
      idFingerprint: fingerprintJson(record?.id || null),
      versionFingerprint: fingerprintJson(record?.version || null),
      fieldsFingerprint: fingerprintJson(record?.fields || null),
      bodyFingerprint: fingerprintJson(record?.body || null)
    }))
  };
}

function projectObservation(operation, phase, output, resolvedInput) {
  const records = Array.isArray(output?.records) ? output.records : [];
  const input = resolvedInput || (phase === 'precondition'
    ? operation.precondition.input
    : operation.verification.input);
  const record = records[0];
  const exactIdentity = records.length === 1
    && Array.isArray(input?.ids)
    && input.ids.length === 1
    && input.ids[0] === record?.id
    && record?.identityBinding?.state === 'exact-request'
    && record.identityBinding.requestedIdFingerprint === fingerprintJson(input.ids[0]);
  if (phase === 'precondition') {
    const expected = operation.review.before.reviewValue;
    return exactIdentity
      && record.type === 'project'
      && sameJson(record.fields, expected.fields)
      && typeof record.body === 'string'
      && fingerprintJson(record.body) === expected.bodyFingerprint
      ? {
          records: [{
            type: 'project',
            fields: expected.fields,
            bodyFingerprint: expected.bodyFingerprint,
            recordIdState: 'exact-request'
          }]
        }
      : failedRecordObservation(records);
  }
  const expected = operation.review.after.reviewValue;
  return exactIdentity
    && record.type === 'project'
    && sameJson(record.fields, expected.fields)
    && typeof record.body === 'string'
    && fingerprintJson(record.body) === expected.bodyFingerprint
    ? {
        records: [{
          type: 'project',
          fields: expected.fields,
          bodyFingerprint: expected.bodyFingerprint,
          recordIdState: 'exact-request'
        }]
      }
    : failedRecordObservation(records);
}

export function evaluateProjectPageReconciliationConnectedVerification({
  operation,
  phase = 'verification',
  resolvedInput = null,
  output
}) {
  const observation = phase === 'precondition' ? operation.precondition : operation.verification;
  let observed;
  if (observation.expectation.kind === 'project-properties-current'
    || observation.expectation.kind === 'project-properties-updated-with-body-preserved'
    || observation.expectation.kind === 'project-body-current-after-properties'
    || observation.expectation.kind === 'project-body-current-with-fields'
    || observation.expectation.kind === 'project-body-updated-with-final-fields'
    || observation.expectation.kind === 'project-body-updated-with-fields-preserved') {
    observed = projectObservation(operation, phase, output, resolvedInput);
  } else {
    throw new Error('Project page reconciliation verifier received an unsupported expectation kind.');
  }
  const passed = fingerprintJson(observed) === observation.expectation.expectedFingerprint;
  return {
    state: passed ? 'passed' : 'failed',
    reasonCode: passed
      ? (phase === 'precondition'
          ? 'PROJECT_RECONCILIATION_PRECONDITION_PASSED'
          : 'PROJECT_RECONCILIATION_VERIFICATION_PASSED')
      : (phase === 'precondition'
          ? 'PROJECT_RECONCILIATION_PRECONDITION_MISMATCH'
          : 'PROJECT_RECONCILIATION_VERIFICATION_MISMATCH'),
    observedFingerprint: fingerprintJson(observed),
    retryPermitted: false
  };
}
