import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { writeOutputBindingPlaceholder } from '../../core/connected-input-bindings.mjs';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fieldMap(item) {
  return new Map(item.fields.map((field) => [field.id, field.reviewValue]));
}

function exactText(fields, id) {
  const value = fields.get(id);
  if (typeof value !== 'string' || !value) {
    throw new Error('Project Capture connected compiler requires one exact private ' + id + ' value.');
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
      'Project Capture connected compiler requires exact unique private ' + id + ' values.'
    );
  }
  return [...value].sort(compareCodepoint);
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

function privateReview({ after, precondition }) {
  return {
    subject: {
      kind: 'portable-resource',
      type: 'project',
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

function projectFromMaterial(materialAction) {
  const values = fieldMap(materialAction.proposed);
  const name = exactText(values, 'name');
  const projectType = exactText(values, 'projectType');
  const status = exactText(values, 'status');
  const organizationUris = exactStringList(values, 'organizationUris', {
    minimum: 1,
    maximum: 1
  });
  const startDates = exactStringList(values, 'startDate', { maximum: 1 });
  const targetEndDates = exactStringList(values, 'targetEndDate', { maximum: 1 });
  const body = exactText(values, 'body').trim();
  const fields = {
    name,
    projectType,
    status,
    organizationUris,
    ...(startDates.length ? { startDate: startDates[0] } : {}),
    ...(targetEndDates.length ? { targetEndDate: targetEndDates[0] } : {})
  };
  return {
    name,
    body,
    fields,
    expectedFields: {
      ...fields,
      startDate: startDates.length ? startDates[0] : null,
      targetEndDate: targetEndDates.length ? targetEndDates[0] : null,
      taskUris: []
    }
  };
}

export function compileProjectCaptureConnectedOperations({ batch, material }) {
  const automationId = batch.work?.automationId || batch.automationId;
  if (automationId !== 'automation.project-capture'
    || material.selection.id !== batch.id
    || material.selection.fingerprint !== batch.fingerprint
    || batch.actions.length !== 1
    || material.actions.length !== 1) {
    throw new Error(
      'Project Capture connected compiler requires one exact review-only candidate selection.'
    );
  }
  const materialAction = material.actions[0];
  const selection = materialAction.selection;
  if (selection.id !== batch.actions[0].id
    || selection.kind !== 'project-create'
    || selection.capability !== 'projects.records.create'
    || selection.effect !== 'write'
    || materialAction.proposed.kind !== 'project-create') {
    throw new Error('Project Capture connected compiler received an unsupported selected action.');
  }
  const project = projectFromMaterial(materialAction);
  const readInput = {
    recordTypes: ['project'],
    filters: { name: project.name },
    limit: 2
  };
  const precondition = expectedPrecondition(
    'projects.records.read',
    readInput,
    'project-record-absent',
    { records: [] }
  );
  const createInput = {
    recordType: 'project',
    deduplicationKey: project.name,
    deduplicationFilter: { field: 'name', value: project.name },
    fields: project.fields,
    body: project.body
  };
  const after = {
    recordType: 'project',
    fields: project.expectedFields,
    body: project.body
  };
  const verificationBinding = {
    id: 'binding.project-capture.created-project-id',
    sourceStage: 'write',
    sourcePath: ['record', 'id'],
    targetPath: ['ids'],
    transform: 'singleton-string-list'
  };
  const verificationInput = {
    recordTypes: ['project'],
    ids: writeOutputBindingPlaceholder(
      verificationBinding.sourcePath,
      verificationBinding.transform
    ),
    content: { expectedTitle: project.name },
    limit: 1
  };
  return {
    operations: [{
      id: 'operation.project-capture.create',
      sequence: 1,
      sourceActionId: selection.id,
      capability: selection.capability,
      effect: 'write',
      input: createInput,
      inputFingerprint: fingerprintJson(createInput),
      precondition,
      verification: observation(
        'projects.records.read',
        verificationInput,
        'project-record-created-with-content',
        {
          records: [{
            type: 'project',
            fields: project.expectedFields,
            body: project.body,
            recordIdState: 'write-output-bound'
          }]
        },
        [verificationBinding]
      ),
      review: privateReview({ after, precondition }),
      ambiguity: {
        retry: 'prohibited',
        reconcileWith: 'verification',
        unresolvedState: 'needs-attention',
        reasonCode: 'PROJECT_CREATE_AMBIGUOUS'
      },
      recovery: {
        mode: 'manual-required',
        reasonCode: 'PROJECT_DELETE_NOT_DECLARED'
      }
    }]
  };
}

function failedObservation(records) {
  return {
    records: records.map((record) => ({
      type: record?.type || 'unknown',
      idFingerprint: fingerprintJson(record?.id || null),
      fieldsFingerprint: fingerprintJson(record?.fields || null),
      bodyFingerprint: fingerprintJson(record?.body || null)
    })).sort((left, right) => {
      if (left.type !== right.type) return compareCodepoint(left.type, right.type);
      return compareCodepoint(left.idFingerprint, right.idFingerprint);
    })
  };
}

function expectedProject(operation) {
  const after = operation.review.after.reviewValue;
  if (after?.recordType !== 'project'
    || !after.fields || typeof after.fields !== 'object' || Array.isArray(after.fields)
    || typeof after.body !== 'string' || !after.body) {
    throw new Error(
      'Project Capture verification requires the exact compiled private fields and body.'
    );
  }
  return { fields: after.fields, body: after.body };
}

function matchingProjectRecord(records, expected, resolvedInput) {
  if (records.length !== 1 || records[0]?.type !== 'project') return false;
  const record = records[0];
  const observed = record.fields;
  return Array.isArray(resolvedInput?.ids)
    && resolvedInput.ids.length === 1
    && resolvedInput.recordTypes?.length === 1
    && resolvedInput.recordTypes[0] === 'project'
    && resolvedInput.ids[0] === record.id
    && resolvedInput.content?.expectedTitle === expected.fields.name
    && typeof record.id === 'string' && Boolean(record.id)
    && observed && typeof observed === 'object' && !Array.isArray(observed)
    && fingerprintJson(observed) === fingerprintJson(expected.fields)
    && fingerprintJson(record.body) === fingerprintJson(expected.body);
}

export function evaluateProjectCaptureConnectedVerification({
  operation,
  phase = 'verification',
  resolvedInput = null,
  output
}) {
  const observationValue = phase === 'precondition'
    ? operation.precondition
    : operation.verification;
  const records = Array.isArray(output?.records) ? output.records : [];
  let observed;
  if (observationValue.expectation.kind === 'project-record-absent') {
    observed = records.length === 0 ? { records: [] } : failedObservation(records);
  } else if (observationValue.expectation.kind === 'project-record-created-with-content') {
    const expected = expectedProject(operation);
    observed = matchingProjectRecord(records, expected, resolvedInput)
      ? {
        records: [{
          type: 'project',
          fields: structuredClone(expected.fields),
          body: expected.body,
          recordIdState: 'write-output-bound'
        }]
      }
      : failedObservation(records);
  } else {
    throw new Error(
      'Project Capture connected verifier received an unsupported expectation kind.'
    );
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
