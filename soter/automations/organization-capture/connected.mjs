import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { writeOutputBindingPlaceholder } from '../../core/connected-input-bindings.mjs';

function fieldMap(item) {
  return new Map(item.fields.map((field) => [field.id, field.reviewValue]));
}

function exactText(fields, id) {
  const value = fields.get(id);
  if (typeof value !== 'string' || !value) {
    throw new Error(
      'Organization Capture connected compiler requires one exact private ' + id + ' value.'
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
      'Organization Capture connected compiler requires exact unique private '
        + id + ' values.'
    );
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
    expectation: { kind, expectedFingerprint: fingerprintJson(expected) }
  };
  if (inputBindings) value.inputBindings = inputBindings;
  return value;
}

function expectedPrecondition(capability, input, kind, expected) {
  return { kind: 'expectation', ...observation(capability, input, kind, expected) };
}

function privateReview({ after, precondition }) {
  return {
    subject: { kind: 'portable-resource', type: 'crm-organization', id: null },
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

function organizationFromMaterial(materialAction) {
  const fields = fieldMap(materialAction.proposed);
  const name = exactText(fields, 'name');
  const organizationTypes = exactStringList(fields, 'organizationType', {
    minimum: 1,
    maximum: 1
  });
  const tags = exactStringList(fields, 'tags', { maximum: 12 });
  const websites = exactStringList(fields, 'website', { maximum: 1 });
  const twitterProfiles = exactStringList(fields, 'twitter', { maximum: 1 });
  const duplicateSearchNames = exactStringList(fields, 'duplicateSearchNames', {
    minimum: 1,
    maximum: 12
  });
  return {
    name,
    duplicateSearchNames,
    fields: {
      name,
      organizationType: organizationTypes[0],
      ...(tags.length ? { tags } : {}),
      ...(websites.length ? { website: websites[0] } : {}),
      ...(twitterProfiles.length ? { twitter: twitterProfiles[0] } : {})
    }
  };
}

export function compileOrganizationCaptureConnectedOperations({ batch, material }) {
  const automationId = batch.work?.automationId || batch.automationId;
  if (automationId !== 'automation.organization-capture'
    || material.selection.id !== batch.id
    || material.selection.fingerprint !== batch.fingerprint
    || batch.actions.length !== 1
    || material.actions.length !== 1) {
    throw new Error(
      'Organization Capture connected compiler requires one exact review-only candidate selection.'
    );
  }
  const materialAction = material.actions[0];
  const selection = materialAction.selection;
  if (selection.id !== batch.actions[0].id
    || selection.kind !== 'organization-create'
    || selection.capability !== 'crm.records.create'
    || selection.effect !== 'write'
    || materialAction.proposed.kind !== 'organization-create') {
    throw new Error('Organization Capture connected compiler received an unsupported action.');
  }
  const organization = organizationFromMaterial(materialAction);
  const readInput = {
    recordTypes: ['organization'],
    filtersAny: organization.duplicateSearchNames.map((name) => ({ name })),
    limit: 25
  };
  const precondition = expectedPrecondition(
    'crm.records.read',
    readInput,
    'organization-record-absent',
    { records: [] }
  );
  const createInput = {
    recordType: 'organization',
    deduplicationKey: organization.name.toLocaleLowerCase('en'),
    deduplicationFilter: { field: 'name', value: organization.name },
    fields: organization.fields
  };
  const after = { recordType: 'organization', fields: organization.fields };
  const verificationBinding = {
    id: 'binding.organization-capture.created-organization-id',
    sourceStage: 'write',
    sourcePath: ['record', 'id'],
    targetPath: ['ids'],
    transform: 'singleton-string-list'
  };
  const verificationInput = {
    recordTypes: ['organization'],
    ids: writeOutputBindingPlaceholder(
      verificationBinding.sourcePath,
      verificationBinding.transform
    ),
    limit: 2
  };
  return {
    operations: [{
      id: 'operation.organization-capture.create',
      sequence: 1,
      sourceActionId: selection.id,
      capability: selection.capability,
      effect: 'write',
      input: createInput,
      inputFingerprint: fingerprintJson(createInput),
      precondition,
      verification: observation(
        'crm.records.read',
        verificationInput,
        'organization-record-created',
        {
          records: [{
            type: 'organization',
            fields: organization.fields,
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
        reasonCode: 'ORGANIZATION_CREATE_AMBIGUOUS'
      },
      recovery: {
        mode: 'manual-required',
        reasonCode: 'ORGANIZATION_DELETE_NOT_DECLARED'
      }
    }]
  };
}

function failedObservation(records) {
  return {
    records: records.map((record) => ({
      type: record?.type || 'unknown',
      idFingerprint: fingerprintJson(record?.id || null),
      fieldsFingerprint: fingerprintJson(record?.fields || null)
    })).sort((left, right) => {
      if (left.type !== right.type) return left.type < right.type ? -1 : 1;
      return left.idFingerprint < right.idFingerprint
        ? -1
        : left.idFingerprint > right.idFingerprint ? 1 : 0;
    })
  };
}

function expectedOrganizationFields(operation) {
  const after = operation.review.after.reviewValue;
  if (after?.recordType !== 'organization'
    || !after.fields
    || typeof after.fields !== 'object'
    || Array.isArray(after.fields)) {
    throw new Error(
      'Organization Capture verification requires the exact compiled private organization value.'
    );
  }
  return after.fields;
}

function matchingOrganizationRecord(records, expectedFields, resolvedInput) {
  if (records.length !== 1 || records[0]?.type !== 'organization') return false;
  const record = records[0];
  const observed = record.fields;
  return Array.isArray(resolvedInput?.ids)
    && resolvedInput.ids.length === 1
    && resolvedInput.recordTypes?.length === 1
    && resolvedInput.recordTypes[0] === 'organization'
    && resolvedInput.ids[0] === record.id
    && typeof record.id === 'string' && Boolean(record.id)
    && observed && typeof observed === 'object' && !Array.isArray(observed)
    && Object.entries(expectedFields).every(([key, value]) => {
      return fingerprintJson(observed[key]) === fingerprintJson(value);
    });
}

export function evaluateOrganizationCaptureConnectedVerification({
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
  if (observationValue.expectation.kind === 'organization-record-absent') {
    observed = records.length === 0 ? { records: [] } : failedObservation(records);
  } else if (observationValue.expectation.kind === 'organization-record-created') {
    const expectedFields = expectedOrganizationFields(operation);
    observed = matchingOrganizationRecord(records, expectedFields, resolvedInput)
      ? {
        records: [{
          type: 'organization',
          fields: structuredClone(expectedFields),
          recordIdState: 'write-output-bound'
        }]
      }
      : failedObservation(records);
  } else {
    throw new Error(
      'Organization Capture verifier received an unsupported expectation kind.'
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
