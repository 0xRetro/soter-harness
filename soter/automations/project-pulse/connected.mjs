import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { writeOutputBindingPlaceholder } from '../../core/connected-input-bindings.mjs';

const DOCUMENT_ACTION = 'action.project-pulse.document-update';
const STATUS_ACTION = 'action.project-pulse.status-create';

function fieldMap(item) {
  return new Map(item.fields.map((field) => [field.id, field.reviewValue]));
}

function exactText(fields, id) {
  const value = fields.get(id);
  if (typeof value !== 'string' || !value) {
    throw new Error('Project Pulse connected compiler requires one exact private ' + id + ' value.');
  }
  return value;
}

function exactBoolean(fields, id) {
  const value = fields.get(id);
  if (typeof value !== 'boolean') {
    throw new Error('Project Pulse connected compiler requires one exact private ' + id + ' boolean.');
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
    throw new Error('Project Pulse connected compiler requires exact unique private ' + id + ' values.');
  }
  return [...value];
}

function observation(capability, input, kind, expected, inputBindings = null) {
  const value = {
    capability,
    input,
    inputFingerprint: inputBindings
      ? fingerprintJson({ input, inputBindings })
      : fingerprintJson(input),
    expectation: {
      kind,
      expectedFingerprint: fingerprintJson(expected)
    }
  };
  if (inputBindings) value.inputBindings = inputBindings;
  return value;
}

function expectedPrecondition(capability, input, kind, expected) {
  return {
    kind: 'expectation',
    ...observation(capability, input, kind, expected)
  };
}

function privateReview({ subjectType, subjectId, before, after, precondition }) {
  return {
    subject: {
      kind: 'portable-resource',
      type: subjectType,
      id: subjectId
    },
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

function absentPrivateReview({ subjectType, after, precondition }) {
  return {
    subject: {
      kind: 'portable-resource',
      type: subjectType,
      id: null
    },
    before: {
      state: 'absent-required',
      reasonCode: 'DEDUPLICATION_ABSENCE_REQUIRED',
      fingerprint: null
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

function assertExactBatch(selection, fields, selectedActionIds) {
  const requiredActionIds = exactStringList(fields, 'batchActionIds', { minimum: 1, maximum: 2 });
  if (fingerprintJson(requiredActionIds) !== fingerprintJson(selectedActionIds)) {
    throw new Error(
      'Project Pulse requires the exact complete document-and-status action group; partial selection is not allowed.'
    );
  }
  if (!requiredActionIds.includes(selection.id)) {
    throw new Error('Project Pulse private review material does not bind its selected action.');
  }
}

function compileDocument(materialAction, sequence, selectedActionIds) {
  const selection = materialAction.selection;
  if (selection.id !== DOCUMENT_ACTION
    || selection.kind !== 'project-document-update'
    || selection.capability !== 'documents.content.update'
    || selection.effect !== 'write'
    || materialAction.proposed.kind !== 'project-document-update') {
    throw new Error('Project Pulse connected compiler received an unsupported document action.');
  }
  const fields = fieldMap(materialAction.proposed);
  assertExactBatch(selection, fields, selectedActionIds);
  const uri = exactText(fields, 'uri');
  const expectedTitle = exactText(fields, 'expectedTitle');
  const expectedBodyFingerprint = exactText(fields, 'expectedBodyFingerprint');
  const afterBodyFingerprint = exactText(fields, 'afterBodyFingerprint');
  const updateIds = exactStringList(fields, 'updateIds', { minimum: 1, maximum: 20 });
  const oldTexts = exactStringList(fields, 'oldTexts', { minimum: 1, maximum: 20 });
  const newTexts = exactStringList(fields, 'newTexts', { minimum: 1, maximum: 20 });
  if (updateIds.length !== oldTexts.length
    || updateIds.length !== newTexts.length
    || oldTexts.some((value, index) => value === newTexts[index])) {
    throw new Error('Project Pulse document review requires aligned exact changing milestone replacements.');
  }
  const updates = updateIds.map((id, index) => ({
    id,
    oldText: oldTexts[index],
    newText: newTexts[index],
    replaceAllMatches: false
  }));
  const readInput = { uri, expectedTitle };
  const beforeObservation = {
    document: { uri, title: expectedTitle, bodyFingerprint: expectedBodyFingerprint }
  };
  const afterObservation = {
    document: { uri, title: expectedTitle, bodyFingerprint: afterBodyFingerprint }
  };
  const precondition = expectedPrecondition(
    'documents.content.read',
    readInput,
    'project-document-current',
    beforeObservation
  );
  const updateInput = { uri, expectedTitle, expectedBodyFingerprint, updates };
  const beforeReview = {
    uri,
    title: expectedTitle,
    bodyFingerprint: expectedBodyFingerprint,
    milestoneLines: oldTexts
  };
  const afterReview = {
    uri,
    title: expectedTitle,
    bodyFingerprint: afterBodyFingerprint,
    milestoneLines: newTexts
  };
  return {
    id: 'operation.project-pulse.document-update',
    sequence,
    sourceActionId: selection.id,
    capability: selection.capability,
    effect: 'write',
    input: updateInput,
    inputFingerprint: fingerprintJson(updateInput),
    precondition,
    verification: observation(
      'documents.content.read',
      readInput,
      'project-document-updated',
      afterObservation
    ),
    review: privateReview({
      subjectType: 'project-document',
      subjectId: uri,
      before: beforeReview,
      after: afterReview,
      precondition
    }),
    ambiguity: {
      retry: 'prohibited',
      reconcileWith: 'verification',
      unresolvedState: 'needs-attention',
      reasonCode: 'PROJECT_DOCUMENT_UPDATE_AMBIGUOUS'
    },
    recovery: {
      mode: 'manual-required',
      reasonCode: 'PROJECT_DOCUMENT_RESTORE_NOT_AUTOMATED'
    }
  };
}

function compileStatus(materialAction, sequence, selectedActionIds) {
  const selection = materialAction.selection;
  if (selection.id !== STATUS_ACTION
    || selection.kind !== 'project-status-create'
    || selection.capability !== 'projects.records.create'
    || selection.effect !== 'write'
    || materialAction.proposed.kind !== 'project-status-create') {
    throw new Error('Project Pulse connected compiler received an unsupported status action.');
  }
  const values = fieldMap(materialAction.proposed);
  assertExactBatch(selection, values, selectedActionIds);
  const fields = {
    headline: exactText(values, 'headline'),
    category: exactText(values, 'category'),
    date: exactText(values, 'date'),
    summary: exactText(values, 'summary'),
    processed: exactBoolean(values, 'processed'),
    visibility: exactText(values, 'visibility'),
    projectIds: exactStringList(values, 'projectIds', { minimum: 1, maximum: 1 })
  };
  const readInput = {
    recordTypes: ['project-feed-entry'],
    filters: { headline: fields.headline },
    limit: 2
  };
  const precondition = expectedPrecondition(
    'projects.records.read',
    readInput,
    'project-status-record-absent',
    { records: [] }
  );
  const createInput = {
    recordType: 'project-feed-entry',
    deduplicationKey: fields.headline,
    deduplicationFilter: { field: 'headline', value: fields.headline },
    fields
  };
  const after = { recordType: 'project-feed-entry', fields };
  const verificationBinding = {
    id: 'binding.project-pulse.created-status-id',
    sourceStage: 'write',
    sourcePath: ['record', 'id'],
    targetPath: ['ids'],
    transform: 'singleton-string-list'
  };
  const verificationInput = {
    recordTypes: ['project-feed-entry'],
    ids: writeOutputBindingPlaceholder(
      verificationBinding.sourcePath,
      verificationBinding.transform
    ),
    limit: 2
  };
  return {
    id: 'operation.project-pulse.status-create',
    sequence,
    sourceActionId: selection.id,
    capability: selection.capability,
    effect: 'write',
    input: createInput,
    inputFingerprint: fingerprintJson(createInput),
    precondition,
    verification: observation(
      'projects.records.read',
      verificationInput,
      'project-status-record-created',
      {
        records: [{
          type: 'project-feed-entry',
          fields,
          recordIdState: 'write-output-bound'
        }]
      },
      [verificationBinding]
    ),
    review: absentPrivateReview({
      subjectType: 'project-feed-entry',
      after,
      precondition
    }),
    ambiguity: {
      retry: 'prohibited',
      reconcileWith: 'verification',
      unresolvedState: 'needs-attention',
      reasonCode: 'PROJECT_STATUS_CREATE_AMBIGUOUS'
    },
    recovery: {
      mode: 'manual-required',
      reasonCode: 'PROJECT_STATUS_DELETE_NOT_DECLARED'
    }
  };
}

export function compileProjectPulseConnectedOperations({ batch, material }) {
  const automationId = batch.work?.automationId || batch.automationId;
  if (automationId !== 'automation.project-pulse'
    || material.batch.id !== batch.id
    || material.batch.fingerprint !== batch.fingerprint
    || batch.actions.length < 1
    || batch.actions.length > 2
    || material.actions.length !== batch.actions.length) {
    throw new Error('Project Pulse connected compiler requires one exact selected review batch.');
  }
  const selectedActionIds = batch.actions.map((action) => action.id);
  const allowedOrder = selectedActionIds.length === 2
    ? [DOCUMENT_ACTION, STATUS_ACTION]
    : [STATUS_ACTION];
  if (fingerprintJson(selectedActionIds) !== fingerprintJson(allowedOrder)) {
    throw new Error(
      'Project Pulse connected compiler requires document update first and status creation last.'
    );
  }
  const operations = material.actions.map((materialAction, index) => {
    if (materialAction.selection.id !== batch.actions[index].id) {
      throw new Error('Project Pulse connected compiler material order does not match the selected batch.');
    }
    return materialAction.selection.id === DOCUMENT_ACTION
      ? compileDocument(materialAction, index + 1, selectedActionIds)
      : compileStatus(materialAction, index + 1, selectedActionIds);
  });
  return { operations };
}

function failedRecordObservation(records) {
  return {
    records: records.map((record) => ({
      type: record?.type || 'unknown',
      idFingerprint: fingerprintJson(record?.id || null),
      fieldsFingerprint: fingerprintJson(record?.fields || null)
    })).sort((left, right) => {
      if (left.type !== right.type) return left.type < right.type ? -1 : 1;
      return left.idFingerprint < right.idFingerprint ? -1 : left.idFingerprint > right.idFingerprint ? 1 : 0;
    })
  };
}

function expectedStatusFields(operation) {
  const after = operation.review.after.reviewValue;
  if (after?.recordType !== 'project-feed-entry'
    || !after.fields || typeof after.fields !== 'object' || Array.isArray(after.fields)) {
    throw new Error('Project Pulse verification requires the exact compiled private status value.');
  }
  return after.fields;
}

function matchingStatusRecord(records, expectedFields, resolvedInput) {
  if (records.length !== 1 || records[0]?.type !== 'project-feed-entry') return false;
  const record = records[0];
  const observed = record.fields;
  return Array.isArray(resolvedInput?.ids)
    && resolvedInput.ids.length === 1
    && resolvedInput.recordTypes?.length === 1
    && resolvedInput.recordTypes[0] === 'project-feed-entry'
    && resolvedInput.ids[0] === record.id
    && typeof record.id === 'string' && Boolean(record.id)
    && observed && typeof observed === 'object' && !Array.isArray(observed)
    && Object.entries(expectedFields).every(([key, value]) => {
      return fingerprintJson(observed[key]) === fingerprintJson(value);
    });
}

function documentObservation(output) {
  const document = output?.document;
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { document: { observationFingerprint: fingerprintJson(null) } };
  }
  return {
    document: {
      uri: typeof document.uri === 'string' ? document.uri : '',
      title: typeof document.title === 'string' ? document.title : '',
      bodyFingerprint: typeof document.bodyFingerprint === 'string'
        ? document.bodyFingerprint
        : fingerprintJson(null)
    }
  };
}

export function evaluateProjectPulseConnectedVerification({
  operation,
  phase = 'verification',
  resolvedInput = null,
  output
}) {
  const observationValue = phase === 'precondition'
    ? operation.precondition
    : operation.verification;
  let observed;
  if (observationValue.expectation.kind === 'project-document-current'
    || observationValue.expectation.kind === 'project-document-updated') {
    observed = documentObservation(output);
  } else if (observationValue.expectation.kind === 'project-status-record-absent') {
    const records = Array.isArray(output?.records) ? output.records : [];
    observed = records.length === 0 ? { records: [] } : failedRecordObservation(records);
  } else if (observationValue.expectation.kind === 'project-status-record-created') {
    const records = Array.isArray(output?.records) ? output.records : [];
    const expectedFields = expectedStatusFields(operation);
    observed = matchingStatusRecord(records, expectedFields, resolvedInput)
      ? {
        records: [{
          type: 'project-feed-entry',
          fields: structuredClone(expectedFields),
          recordIdState: 'write-output-bound'
        }]
      }
      : failedRecordObservation(records);
  } else {
    throw new Error('Project Pulse connected verifier received an unsupported expectation kind.');
  }
  const observedFingerprint = fingerprintJson(observed);
  const passed = observedFingerprint === observationValue.expectation.expectedFingerprint;
  return {
    state: passed ? 'passed' : 'failed',
    reasonCode: passed
      ? phase === 'precondition' ? 'PRECONDITION_PASSED' : 'VERIFICATION_PASSED'
      : phase === 'precondition' ? 'PRECONDITION_MISMATCH' : 'READ_AFTER_WRITE_MISMATCH',
    observedFingerprint,
    retryPermitted: false
  };
}
