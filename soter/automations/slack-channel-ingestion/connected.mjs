import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { writeOutputBindingPlaceholder } from '../../core/connected-input-bindings.mjs';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareCodepoint);
}

function normalizedObservedRelationSet(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || !item)
    || new Set(value).size !== value.length) {
    return value;
  }
  return uniqueSorted(value);
}

function fieldMap(item) {
  return new Map(item.fields.map((field) => [field.id, field.reviewValue]));
}

function exactText(fields, id) {
  const value = fields.get(id);
  if (typeof value !== 'string' || !value) {
    throw new Error('Slack channel connected compiler requires one exact private ' + id + ' value.');
  }
  return value;
}

function exactStringList(fields, id, maximum = 500) {
  const value = fields.get(id);
  if (!Array.isArray(value)
    || value.length > maximum
    || value.some((item) => typeof item !== 'string' || !item)
    || new Set(value).size !== value.length) {
    throw new Error('Slack channel connected compiler requires exact unique private ' + id + ' values.');
  }
  return uniqueSorted(value);
}

function exactBoolean(fields, id) {
  const value = fields.get(id);
  if (typeof value !== 'boolean') {
    throw new Error('Slack channel connected compiler requires one exact private ' + id + ' value.');
  }
  return value;
}

function exactChannelFields(fields) {
  return {
    name: exactText(fields, 'name'),
    platform: exactText(fields, 'platform'),
    workspaceUri: exactText(fields, 'workspaceUri'),
    workspaceIdentityFingerprint: exactText(fields, 'workspaceIdentityFingerprint'),
    conversationIdentityFingerprint: exactText(fields, 'conversationIdentityFingerprint'),
    hostWorkspaceName: exactText(fields, 'hostWorkspaceName'),
    visibility: exactText(fields, 'visibility'),
    shared: exactBoolean(fields, 'shared'),
    personUris: exactStringList(fields, 'personUris'),
    organizationUris: exactStringList(fields, 'organizationUris')
  };
}

function mutableChannelFields(after) {
  const {
    platform,
    workspaceUri,
    workspaceIdentityFingerprint,
    conversationIdentityFingerprint,
    ...mutable
  } = after;
  return mutable;
}

function exactBeforeChannel(fields) {
  return {
    id: exactText(fields, 'recordId'),
    version: exactText(fields, 'expectedVersion'),
    fields: {
      name: exactText(fields, 'beforeName'),
      platform: exactText(fields, 'beforePlatform'),
      workspaceUri: exactText(fields, 'beforeWorkspaceUri'),
      workspaceIdentityFingerprint: exactText(fields, 'beforeWorkspaceIdentityFingerprint'),
      conversationIdentityFingerprint: exactText(fields, 'beforeConversationIdentityFingerprint'),
      hostWorkspaceName: exactText(fields, 'beforeHostWorkspaceName'),
      visibility: exactText(fields, 'beforeVisibility'),
      shared: exactBoolean(fields, 'beforeShared'),
      personUris: exactStringList(fields, 'beforePersonUris'),
      organizationUris: exactStringList(fields, 'beforeOrganizationUris')
    }
  };
}

function normalizedChannelFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return fields;
  return {
    ...fields,
    personUris: normalizedObservedRelationSet(fields.personUris),
    organizationUris: normalizedObservedRelationSet(fields.organizationUris)
  };
}

function verification(capability, input, expectationKind, expected, inputBindings = null) {
  const value = {
    capability,
    input,
    inputFingerprint: inputBindings
      ? fingerprintJson({ input, inputBindings })
      : fingerprintJson(input),
    expectation: {
      kind: expectationKind,
      expectedFingerprint: fingerprintJson(expected)
    }
  };
  if (inputBindings) value.inputBindings = inputBindings;
  return value;
}

function expectedPrecondition(capability, input, expectationKind, expected) {
  return {
    kind: 'expectation',
    ...verification(capability, input, expectationKind, expected)
  };
}

function absentPrivateReview({ subjectType, after, precondition }) {
  return {
    subject: { kind: 'portable-resource', type: subjectType, id: null },
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

function providedPrivateReview({ subjectType, subjectId, before, after, precondition }) {
  return {
    subject: { kind: 'portable-resource', type: subjectType, id: subjectId },
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

function operation({ id, sourceActionId, capability, input, precondition, verify, review, ambiguity, recovery }) {
  return {
    id,
    sequence: 0,
    sourceActionId,
    capability,
    effect: 'write',
    input,
    inputFingerprint: fingerprintJson(input),
    precondition,
    verification: verify,
    review,
    ambiguity: {
      retry: 'prohibited',
      reconcileWith: 'verification',
      unresolvedState: 'needs-attention',
      reasonCode: ambiguity
    },
    recovery: {
      mode: 'manual-required',
      reasonCode: recovery
    }
  };
}

function readInput(conversationIdentityFingerprint) {
  return {
    recordTypes: ['channel'],
    filtersAny: [{ conversationIdentityFingerprint }],
    limit: 4
  };
}

export function compileSlackChannelConnectedOperations({ batch, material }) {
  const automationId = batch.work?.automationId || batch.automationId;
  if (automationId !== 'automation.slack-channel-ingestion'
    || material.selection.id !== batch.id
    || material.selection.fingerprint !== batch.fingerprint
    || material.actions.length !== batch.actions.length) {
    throw new Error('Slack channel connected compiler requires one exact review-only candidate selection.');
  }
  const operations = [];
  for (const action of material.actions) {
    const selection = action.selection;
    const fields = fieldMap(action.proposed);
    const after = exactChannelFields(fields);
    if (after.platform !== 'Slack'
      || !/^sha256:[a-f0-9]{64}$/.test(after.workspaceIdentityFingerprint)
      || !/^sha256:[a-f0-9]{64}$/.test(after.conversationIdentityFingerprint)
      || after.workspaceUri !== 'soter://communications/workspace/'
        + after.workspaceIdentityFingerprint.slice('sha256:'.length)
      || !['public', 'private'].includes(after.visibility)) {
      throw new Error('Slack channel connected compiler received unsupported portable options.');
    }
    if (selection.kind === 'channel-create'
      && selection.capability === 'communications.records.create'
      && action.proposed.kind === 'channel-create') {
      const deduplicationKey = exactText(fields, 'deduplicationKey');
      if (deduplicationKey !== after.conversationIdentityFingerprint) {
        throw new Error('Slack channel create deduplication key does not match its exact identity.');
      }
      const observe = readInput(after.conversationIdentityFingerprint);
      const precondition = expectedPrecondition(
        'communications.records.read', observe, 'channel-record-absent', { records: [] }
      );
      const input = {
        recordType: 'channel',
        deduplicationKey,
        deduplicationFilter: {
          field: 'conversationIdentityFingerprint',
          value: after.conversationIdentityFingerprint
        },
        fields: after,
        body: null
      };
      const verificationBinding = {
        id: 'binding.slack-channel-ingestion.created-channel-id',
        sourceStage: 'write',
        sourcePath: ['record', 'id'],
        targetPath: ['ids'],
        transform: 'singleton-string-list'
      };
      const verificationInput = {
        recordTypes: ['channel'],
        ids: writeOutputBindingPlaceholder(
          verificationBinding.sourcePath,
          verificationBinding.transform
        ),
        limit: 2
      };
      operations.push(operation({
        id: 'operation.slack-channel-ingestion.' + selection.id.split('.').slice(-2).join('.'),
        sourceActionId: selection.id,
        capability: selection.capability,
        input,
        precondition,
        verify: verification(
          'communications.records.read',
          verificationInput,
          'channel-record-created',
          { fields: after, recordIdState: 'write-output-bound' },
          [verificationBinding]
        ),
        review: absentPrivateReview({
          subjectType: 'communications-channel',
          after,
          precondition
        }),
        ambiguity: 'CHANNEL_CREATE_AMBIGUOUS',
        recovery: 'CHANNEL_CREATE_ROLLBACK_NOT_DECLARED'
      }));
      continue;
    }
    if (selection.kind === 'channel-update'
      && selection.capability === 'communications.records.update'
      && action.proposed.kind === 'channel-update') {
      const recordId = exactText(fields, 'recordId');
      const expectedVersion = exactText(fields, 'expectedVersion');
      const beforeFingerprint = exactText(fields, 'beforeFingerprint');
      const before = exactBeforeChannel(fields);
      if (before.id !== recordId
        || before.version !== expectedVersion
        || fingerprintJson(before) !== beforeFingerprint
        || before.fields.workspaceIdentityFingerprint !== after.workspaceIdentityFingerprint
        || before.fields.conversationIdentityFingerprint !== after.conversationIdentityFingerprint
        || before.fields.platform !== after.platform
        || before.fields.workspaceUri !== after.workspaceUri) {
        throw new Error('Slack channel update private before value does not match its exact immutable identity and fingerprint.');
      }
      const observe = {
        recordTypes: ['channel'],
        ids: [recordId],
        limit: 2
      };
      const precondition = expectedPrecondition(
        'communications.records.read',
        observe,
        'channel-record-current',
        { recordFingerprint: beforeFingerprint }
      );
      const input = {
        recordType: 'channel',
        id: recordId,
        expectedVersion,
        patch: mutableChannelFields(after)
      };
      operations.push(operation({
        id: 'operation.slack-channel-ingestion.' + selection.id.split('.').slice(-2).join('.'),
        sourceActionId: selection.id,
        capability: selection.capability,
        input,
        precondition,
        verify: verification(
          'communications.records.read', observe, 'channel-record-updated', { id: recordId, fields: after }
        ),
        review: providedPrivateReview({
          subjectType: 'communications-channel',
          subjectId: recordId,
          before,
          after,
          precondition
        }),
        ambiguity: 'CHANNEL_UPDATE_AMBIGUOUS',
        recovery: 'CHANNEL_UPDATE_ROLLBACK_NOT_DECLARED'
      }));
      continue;
    }
    throw new Error('Slack channel connected compiler received an unsupported selected action.');
  }
  operations.forEach((entry, index) => {
    entry.sequence = index + 1;
  });
  return { operations };
}

export function evaluateSlackChannelConnectedVerification({
  operation,
  phase = 'verification',
  resolvedInput = null,
  output
}) {
  const observation = phase === 'precondition' ? operation.precondition : operation.verification;
  const records = Array.isArray(output?.records) ? output.records : [];
  let observed;
  if (observation.expectation.kind === 'channel-record-absent') {
    observed = { records: records.length === 0 ? [] : records.map((record) => record.id).sort() };
  } else if (observation.expectation.kind === 'channel-record-current') {
    observed = records.length === 1
      ? { recordFingerprint: fingerprintJson({
          id: records[0].id,
          version: records[0].version,
          fields: normalizedChannelFields(records[0].fields)
        }) }
      : { recordFingerprints: records.map((record) => fingerprintJson(record)).sort() };
  } else if (observation.expectation.kind === 'channel-record-created') {
    observed = records.length === 1
      && Array.isArray(resolvedInput?.ids)
      && resolvedInput.ids.length === 1
      && resolvedInput.recordTypes?.length === 1
      && resolvedInput.recordTypes[0] === 'channel'
      && resolvedInput.ids[0] === records[0].id
      && typeof records[0].id === 'string' && Boolean(records[0].id)
      ? {
        fields: normalizedChannelFields(records[0].fields),
        recordIdState: 'write-output-bound'
      }
      : { recordFingerprints: records.map((record) => fingerprintJson(record)).sort() };
  } else if (observation.expectation.kind === 'channel-record-updated') {
    observed = records.length === 1
      ? { id: records[0].id, fields: normalizedChannelFields(records[0].fields) }
      : { recordFingerprints: records.map((record) => fingerprintJson(record)).sort() };
  } else {
    throw new Error('Slack channel connected verifier received an unsupported expectation kind.');
  }
  const observedFingerprint = fingerprintJson(observed);
  const passed = observedFingerprint === observation.expectation.expectedFingerprint;
  return {
    state: passed ? 'passed' : 'failed',
    reasonCode: passed
      ? phase === 'precondition' ? 'PRECONDITION_PASSED' : 'VERIFICATION_PASSED'
      : phase === 'precondition' ? 'PRECONDITION_MISMATCH' : 'READ_AFTER_WRITE_MISMATCH',
    observedFingerprint,
    retryPermitted: false
  };
}
