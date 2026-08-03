import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

function fieldMap(item) {
  return new Map(item.fields.map((field) => [field.id, field.reviewValue]));
}

function exactText(fields, id) {
  const value = fields.get(id);
  if (typeof value !== 'string' || !value) {
    throw new Error('Email connected compiler requires one exact private ' + id + ' value.');
  }
  return value;
}

function exactStringList(fields, id) {
  const value = fields.get(id);
  if (!Array.isArray(value) || value.length < 1
    || value.some((item) => typeof item !== 'string' || !item)
    || new Set(value).size !== value.length) {
    throw new Error('Email connected compiler requires unique exact private ' + id + ' values.');
  }
  return [...value];
}

function idempotencyKey(kind, batch, selection, replyMessageId) {
  const suffix = fingerprintJson({
    batchId: batch.id,
    batchFingerprint: batch.fingerprint,
    actionId: selection.id,
    sourceActionFingerprint: selection.sourceActionFingerprint,
    proposedValueFingerprint: selection.proposedValueFingerprint,
    replyMessageId
  }).slice('sha256:'.length, 39);
  return 'soter.' + kind + '.' + suffix;
}

function verification(capability, input, expectationKind, expected) {
  return {
    capability,
    input,
    inputFingerprint: fingerprintJson(input),
    expectation: {
      kind: expectationKind,
      expectedFingerprint: fingerprintJson(expected)
    }
  };
}

function noPrecondition() {
  return {
    kind: 'none',
    capability: null,
    input: null,
    inputFingerprint: null,
    expectation: null
  };
}

function expectedPrecondition(capability, input, expectationKind, expected) {
  return {
    kind: 'expectation',
    ...verification(capability, input, expectationKind, expected)
  };
}

function privateReview({ subjectType, beforeState, beforeReasonCode, after, precondition }) {
  return {
    subject: {
      kind: 'portable-resource',
      type: subjectType,
      id: null
    },
    before: {
      state: beforeState,
      reasonCode: beforeReasonCode,
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

function commonOperation({
  id,
  sourceActionId,
  capability,
  input,
  precondition,
  verificationPlan,
  review,
  ambiguityReasonCode,
  recoveryReasonCode
}) {
  return {
    id,
    sequence: 0,
    sourceActionId,
    capability,
    effect: 'write',
    input,
    inputFingerprint: fingerprintJson(input),
    precondition,
    verification: verificationPlan,
    review,
    ambiguity: {
      retry: 'prohibited',
      reconcileWith: 'verification',
      unresolvedState: 'needs-attention',
      reasonCode: ambiguityReasonCode
    },
    recovery: {
      mode: 'manual-required',
      reasonCode: recoveryReasonCode
    }
  };
}

export function compileEmailConnectedOperations({ batch, material }) {
  const automationId = batch.work?.automationId || batch.automationId;
  if (automationId !== 'automation.email-triage'
    || material.selection.id !== batch.id
    || material.selection.fingerprint !== batch.fingerprint
    || material.actions.length !== batch.actions.length) {
    throw new Error('Email connected compiler requires one exact review-only candidate selection.');
  }
  const operations = [];
  for (const action of material.actions) {
    const selection = action.selection;
    const fields = fieldMap(action.proposed);
    if (selection.kind === 'label' && selection.capability === 'mail.labels.apply') {
      const labelName = exactText(fields, 'labelName');
      const messageIds = exactStringList(fields, 'messageIds').sort((left, right) => {
        return left.localeCompare(right, 'en');
      });
      const input = {
        messageIds,
        addLabelNames: [labelName],
        removeLabelNames: [],
        createMissingLabels: false
      };
      const verifyInput = {
        messageIds,
        labelNames: [labelName],
        maximumMessages: messageIds.length
      };
      const precondition = noPrecondition();
      const after = { messageIds, labelName };
      operations.push(commonOperation({
        id: 'operation.email.' + selection.id.slice('action.email.'.length),
        sourceActionId: selection.id,
        capability: selection.capability,
        input,
        precondition,
        verificationPlan: verification(
          'mail.labels.read',
          verifyInput,
          'mail-labels-present',
          {
            messages: messageIds.map((messageId) => ({
              messageId,
              labelNames: [labelName]
            }))
          }
        ),
        review: privateReview({
          subjectType: 'mail-message-set',
          beforeState: 'not-required',
          beforeReasonCode: 'PRIOR_VALUE_NOT_REQUIRED',
          after,
          precondition
        }),
        ambiguityReasonCode: 'MAIL_LABEL_WRITE_AMBIGUOUS',
        recoveryReasonCode: 'MAIL_LABEL_REMOVAL_NOT_DECLARED'
      }));
      continue;
    }
    if (selection.kind === 'draft' && selection.capability === 'mail.drafts.create') {
      const replyMessageId = exactText(fields, 'replyMessageId');
      const recipients = exactStringList(fields, 'recipients');
      const subject = exactText(fields, 'subject');
      const body = exactText(fields, 'body');
      const key = idempotencyKey('draft', batch, selection, replyMessageId);
      const contentFingerprint = fingerprintJson({ recipients, subject, body });
      const input = { replyMessageId, recipients, subject, body, idempotencyKey: key };
      const verifyInput = {
        replyMessageIds: [replyMessageId],
        idempotencyKeys: [key],
        maximumDrafts: 1
      };
      const precondition = expectedPrecondition(
        'mail.drafts.list',
        verifyInput,
        'mail-draft-absent',
        { drafts: [] }
      );
      const after = { replyMessageId, recipients, subject, body, idempotencyKey: key };
      operations.push(commonOperation({
        id: 'operation.email.' + selection.id.slice('action.email.'.length),
        sourceActionId: selection.id,
        capability: selection.capability,
        input,
        precondition,
        verificationPlan: verification(
          'mail.drafts.list',
          verifyInput,
          'mail-draft-listed',
          { replyMessageId, idempotencyKey: key, contentFingerprint }
        ),
        review: privateReview({
          subjectType: 'mail-draft',
          beforeState: 'absent-required',
          beforeReasonCode: 'DEDUPLICATION_ABSENCE_REQUIRED',
          after,
          precondition
        }),
        ambiguityReasonCode: 'MAIL_DRAFT_CREATE_AMBIGUOUS',
        recoveryReasonCode: 'MAIL_DRAFT_DELETE_NOT_DECLARED'
      }));
      continue;
    }
    throw new Error('Email connected compiler received an unsupported selected action kind.');
  }
  operations.forEach((operation, index) => {
    operation.sequence = index + 1;
  });
  return { operations };
}

export function evaluateEmailConnectedVerification({ operation, phase = 'verification', output }) {
  const observation = phase === 'precondition'
    ? operation.precondition
    : operation.verification;
  let observed;
  if (observation.expectation.kind === 'mail-labels-present') {
    const messages = Array.isArray(output?.messages)
      ? output.messages.map((message) => ({
          messageId: message.messageId,
          labelNames: [...message.labelNames].sort((left, right) => left.localeCompare(right, 'en'))
        })).sort((left, right) => left.messageId.localeCompare(right.messageId, 'en'))
      : [];
    observed = { messages };
  } else if (observation.expectation.kind === 'mail-draft-listed') {
    const drafts = Array.isArray(output?.drafts) ? output.drafts : [];
    observed = drafts.length === 1
      ? {
          replyMessageId: drafts[0].replyMessageId,
          idempotencyKey: drafts[0].idempotencyKey,
          contentFingerprint: drafts[0].contentFingerprint
        }
      : { drafts: drafts.map((draft) => draft.contentFingerprint).sort() };
  } else if (observation.expectation.kind === 'mail-draft-absent') {
    const drafts = Array.isArray(output?.drafts) ? output.drafts : [];
    observed = drafts.length === 0
      ? { drafts: [] }
      : { drafts: drafts.map((draft) => draft.contentFingerprint).sort() };
  } else {
    throw new Error('Email connected verifier received an unsupported expectation kind.');
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
