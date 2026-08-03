import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { writeOutputBindingPlaceholder } from '../../core/connected-input-bindings.mjs';

function fieldMap(item) {
  return new Map(item.fields.map((field) => [field.id, field.reviewValue]));
}

function exactText(fields, id) {
  const value = fields.get(id);
  if (typeof value !== 'string' || !value) {
    throw new Error(
      'Contact Capture connected compiler requires one exact private ' + id + ' value.'
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
      'Contact Capture connected compiler requires exact unique private '
        + id + ' values.'
    );
  }
  return [...value];
}

function optionalScalar(fields, id) {
  const values = exactStringList(fields, id, { maximum: 1 });
  return values[0] || null;
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
    subject: { kind: 'portable-resource', type: 'crm-person', id: null },
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

function personFromMaterial(materialAction) {
  const fields = fieldMap(materialAction.proposed);
  const name = exactText(fields, 'name');
  const email = optionalScalar(fields, 'email');
  const role = optionalScalar(fields, 'role');
  const status = optionalScalar(fields, 'status');
  const disposition = optionalScalar(fields, 'disposition');
  const authority = exactStringList(fields, 'authority', { maximum: 8 });
  const tags = exactStringList(fields, 'tags', { maximum: 12 });
  const telegram = optionalScalar(fields, 'telegram');
  const signal = optionalScalar(fields, 'signal');
  const github = optionalScalar(fields, 'github');
  const timezoneUtc = optionalScalar(fields, 'timezoneUtc');
  const source = optionalScalar(fields, 'source');
  const organizationUris = exactStringList(fields, 'organizationUris', { maximum: 1 });
  const duplicateSearchValues = exactStringList(fields, 'duplicateSearchValues', {
    minimum: 1,
    maximum: 2
  });
  const duplicateFilters = [
    ...(email ? [{ email }] : []),
    { name }
  ];
  const expectedSearchValues = duplicateFilters.map((filter) => {
    return Object.keys(filter)[0] + ':' + Object.values(filter)[0];
  });
  if (fingerprintJson(duplicateSearchValues) !== fingerprintJson(expectedSearchValues)) {
    throw new Error(
      'Contact Capture connected compiler duplicate search values do not match the exact private person fields.'
    );
  }
  return {
    name,
    email,
    duplicateFilters,
    fields: {
      name,
      ...(email ? { email } : {}),
      ...(role ? { role } : {}),
      ...(status ? { status } : {}),
      ...(disposition ? { disposition } : {}),
      ...(authority.length ? { authority } : {}),
      ...(tags.length ? { tags } : {}),
      ...(telegram ? { telegram } : {}),
      ...(signal ? { signal } : {}),
      ...(github ? { github } : {}),
      ...(timezoneUtc ? { timezoneUtc } : {}),
      ...(source ? { source } : {}),
      ...(organizationUris.length ? { organizationUris } : {})
    }
  };
}

export function compileContactCaptureConnectedOperations({ batch, material }) {
  const automationId = batch.work?.automationId || batch.automationId;
  if (automationId !== 'automation.contact-capture'
    || material.selection.id !== batch.id
    || material.selection.fingerprint !== batch.fingerprint
    || batch.actions.length !== 1
    || material.actions.length !== 1) {
    throw new Error(
      'Contact Capture connected compiler requires one exact review-only candidate selection.'
    );
  }
  const materialAction = material.actions[0];
  const selection = materialAction.selection;
  if (selection.id !== batch.actions[0].id
    || selection.kind !== 'contact-create'
    || selection.capability !== 'crm.records.create'
    || selection.effect !== 'write'
    || materialAction.proposed.kind !== 'contact-create') {
    throw new Error('Contact Capture connected compiler received an unsupported action.');
  }
  const person = personFromMaterial(materialAction);
  const readInput = {
    recordTypes: ['person'],
    filtersAny: person.duplicateFilters,
    limit: 10
  };
  const precondition = expectedPrecondition(
    'crm.records.read',
    readInput,
    'contact-record-absent',
    { records: [] }
  );
  const deduplicationFilter = person.email
    ? { field: 'email', value: person.email }
    : { field: 'name', value: person.name };
  const createInput = {
    recordType: 'person',
    deduplicationKey: person.email || person.name.toLocaleLowerCase('en'),
    deduplicationFilter,
    fields: person.fields
  };
  const after = { recordType: 'person', fields: person.fields };
  const verificationBinding = {
    id: 'binding.contact-capture.created-person-id',
    sourceStage: 'write',
    sourcePath: ['record', 'id'],
    targetPath: ['ids'],
    transform: 'singleton-string-list'
  };
  const verificationInput = {
    recordTypes: ['person'],
    ids: writeOutputBindingPlaceholder(
      verificationBinding.sourcePath,
      verificationBinding.transform
    ),
    limit: 2
  };
  return {
    operations: [{
      id: 'operation.contact-capture.create',
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
        'contact-record-created',
        {
          records: [{
            type: 'person',
            fields: person.fields,
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
        reasonCode: 'CONTACT_CREATE_AMBIGUOUS'
      },
      recovery: {
        mode: 'manual-required',
        reasonCode: 'CONTACT_DELETE_NOT_DECLARED'
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

function expectedPersonFields(operation) {
  const after = operation.review.after.reviewValue;
  if (after?.recordType !== 'person'
    || !after.fields
    || typeof after.fields !== 'object'
    || Array.isArray(after.fields)) {
    throw new Error(
      'Contact Capture verification requires the exact compiled private person value.'
    );
  }
  return after.fields;
}

function matchingPersonRecord(records, expectedFields, resolvedInput) {
  if (records.length !== 1 || records[0]?.type !== 'person') return false;
  const record = records[0];
  const observed = record.fields;
  return Array.isArray(resolvedInput?.ids)
    && resolvedInput.ids.length === 1
    && resolvedInput.recordTypes?.length === 1
    && resolvedInput.recordTypes[0] === 'person'
    && resolvedInput.ids[0] === record.id
    && typeof record.id === 'string' && Boolean(record.id)
    && observed && typeof observed === 'object' && !Array.isArray(observed)
    && Object.entries(expectedFields).every(([key, value]) => {
      return fingerprintJson(observed[key]) === fingerprintJson(value);
    });
}

export function evaluateContactCaptureConnectedVerification({
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
  if (observationValue.expectation.kind === 'contact-record-absent') {
    observed = records.length === 0 ? { records: [] } : failedObservation(records);
  } else if (observationValue.expectation.kind === 'contact-record-created') {
    const expectedFields = expectedPersonFields(operation);
    observed = matchingPersonRecord(records, expectedFields, resolvedInput)
      ? {
        records: [{
          type: 'person',
          fields: structuredClone(expectedFields),
          recordIdState: 'write-output-bound'
        }]
      }
      : failedObservation(records);
  } else {
    throw new Error(
      'Contact Capture verifier received an unsupported expectation kind.'
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
