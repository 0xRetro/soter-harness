import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { fingerprintJson, readJson } from './lib/canonical-json.mjs';
import {
  deriveOperatorContinuationRequest,
  deriveOperatorResumeFacts
} from './operator-inspection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fingerprint = (digit) => 'sha256:' + digit.repeat(64);
const currentPrivateConfiguration = {
  configurationBasis: 'private-active',
  lockFingerprint: fingerprint('1'),
  applicability: {
    state: 'current',
    reasonCode: 'LOCK_CURRENT'
  }
};
const confirmedApproval = { state: 'confirmed' };
const consumedApproval = { state: 'consumed' };

const confirmed = deriveOperatorResumeFacts(
  currentPrivateConfiguration,
  confirmedApproval,
  null,
  null
);
assert.deepEqual(confirmed, {
  classification: 'safe',
  reasonCode: 'APPROVAL_CONFIRMED_NOT_STARTED',
  reason: 'The current exact approval may be consumed once to create its bound checkpoint.',
  permittedNextAction: 'start-transaction'
});
assert.equal(deriveOperatorContinuationRequest(null, confirmed), null,
  'Confirmed approval is not itself an executable checkpoint continuation request.');

const requestedCheckpoint = {
  id: 'checkpoint.transaction.operator-selftest',
  checkpointFingerprint: fingerprint('2'),
  state: 'requested',
  current: {
    operationId: 'operation.operator-selftest',
    stage: 'write',
    callId: 'toolcall.operator-selftest.write',
    reconciliationId: null
  },
  operations: [{
    id: 'operation.operator-selftest',
    state: 'writing',
    ambiguity: null
  }]
};
const requested = deriveOperatorResumeFacts(
  currentPrivateConfiguration,
  consumedApproval,
  { state: 'started' },
  requestedCheckpoint
);
assert.equal(requested.classification, 'safe');
assert.equal(requested.permittedNextAction, 'execute-current-call');
const expectedRequestedContinuation = {
  kind: 'execute-current-call',
  checkpointId: requestedCheckpoint.id,
  checkpointFingerprint: requestedCheckpoint.checkpointFingerprint,
  callId: requestedCheckpoint.current.callId
};
assert.deepEqual(deriveOperatorContinuationRequest(requestedCheckpoint, requested), {
  ...expectedRequestedContinuation,
  requestFingerprint: fingerprintJson(expectedRequestedContinuation)
});

const verificationCheckpoint = structuredClone(requestedCheckpoint);
verificationCheckpoint.current.stage = 'verify';
verificationCheckpoint.current.callId = 'toolcall.operator-selftest.verify';
verificationCheckpoint.operations[0].state = 'verifying';
const verifying = deriveOperatorResumeFacts(
  currentPrivateConfiguration,
  consumedApproval,
  { state: 'started' },
  verificationCheckpoint
);
assert.equal(verifying.classification, 'safe');
assert.equal(verifying.permittedNextAction, 'execute-current-call');

const needsAttentionCheckpoint = structuredClone(requestedCheckpoint);
needsAttentionCheckpoint.state = 'needs-attention';
needsAttentionCheckpoint.current = null;
needsAttentionCheckpoint.operations[0].state = 'needs-attention';
needsAttentionCheckpoint.operations[0].ambiguity = {
  id: 'ambiguity.operator-selftest',
  stage: 'write',
  status: 'unresolved'
};
const needsAttention = deriveOperatorResumeFacts(
  currentPrivateConfiguration,
  consumedApproval,
  { state: 'started' },
  needsAttentionCheckpoint
);
assert.equal(needsAttention.reasonCode, 'RECONCILIATION_AVAILABLE');
assert.equal(needsAttention.permittedNextAction, 'prepare-reconciliation');
const expectedReconciliationContinuation = {
  kind: 'prepare-reconciliation',
  checkpointId: needsAttentionCheckpoint.id,
  checkpointFingerprint: needsAttentionCheckpoint.checkpointFingerprint,
  callId: null
};
assert.deepEqual(deriveOperatorContinuationRequest(needsAttentionCheckpoint, needsAttention), {
  ...expectedReconciliationContinuation,
  requestFingerprint: fingerprintJson(expectedReconciliationContinuation)
});

const reconciliationCheckpoint = structuredClone(requestedCheckpoint);
reconciliationCheckpoint.current.stage = 'reconcile';
reconciliationCheckpoint.current.callId = 'toolcall.operator-selftest.reconcile';
reconciliationCheckpoint.current.reconciliationId = 'reconciliation.operator-selftest';
reconciliationCheckpoint.operations[0].state = 'reconciling';
reconciliationCheckpoint.operations[0].ambiguity = {
  id: 'ambiguity.operator-selftest',
  stage: 'write',
  status: 'unresolved'
};
const reconciliation = deriveOperatorResumeFacts(
  currentPrivateConfiguration,
  consumedApproval,
  { state: 'started' },
  reconciliationCheckpoint
);
assert.equal(reconciliation.reasonCode, 'RECONCILIATION_IN_PROGRESS');
assert.equal(reconciliation.permittedNextAction, 'execute-current-call');

const completedCheckpoint = structuredClone(requestedCheckpoint);
completedCheckpoint.state = 'completed';
completedCheckpoint.current = null;
completedCheckpoint.operations[0].state = 'applied';
const completed = deriveOperatorResumeFacts(
  currentPrivateConfiguration,
  consumedApproval,
  { state: 'started' },
  completedCheckpoint
);
assert.equal(completed.classification, 'unavailable');
assert.equal(completed.reasonCode, 'TRANSACTION_COMPLETED');
assert.equal(completed.permittedNextAction, 'none');
assert.equal(deriveOperatorContinuationRequest(completedCheckpoint, completed), null);

for (const configurationBasis of ['tracked-contained', null, undefined]) {
  const unavailable = deriveOperatorResumeFacts(
    { ...currentPrivateConfiguration, configurationBasis },
    consumedApproval,
    { state: 'started' },
    requestedCheckpoint
  );
  assert.equal(unavailable.classification, 'unavailable');
  assert.equal(unavailable.reasonCode, 'CONFIGURATION_BASIS_NOT_PRIVATE_ACTIVE');
  assert.equal(unavailable.permittedNextAction, 'inspect-checkpoint');
  assert.equal(deriveOperatorContinuationRequest(requestedCheckpoint, unavailable), null,
    'A missing or non-private basis produced executable continuation authority.');
}

const lifecycle = readJson(
  path.join(root, 'soter/fixtures/operator-inspection/connected-transaction.lifecycle.json')
);
const lifecycleFailures = validateJsonSchema(
  lifecycle,
  readJson(path.join(root, 'soter/contracts/operator-inspection-fixture-set.schema.json'))
);
assert.deepEqual(lifecycleFailures, []);
assert(!JSON.stringify(lifecycle).includes('rolling-back'));
assert(!JSON.stringify(lifecycle).includes('rolled-back'));
assert(!JSON.stringify(lifecycle).includes('COMPENSATION_FAILED'));
assert(!JSON.stringify(lifecycle).includes('TRANSACTION_ROLLED_BACK'));
assert(lifecycle.states.some((item) => {
  return item.id === 'private-basis-unavailable'
    && item.resume.classification === 'unavailable'
    && item.resume.reasonCode === 'CONFIGURATION_BASIS_NOT_PRIVATE_ACTIVE';
}));
assert(lifecycle.states.every((item) => item.compensationState === 'not-required'));

process.stdout.write(
  'Operator inspection v2 self-test passed: confirmation, requested execution, '
  + 'verification, reconciliation, completion, private-basis authority, and lifecycle facts remain exact.\n'
);
