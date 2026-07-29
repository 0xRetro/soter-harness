import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  composeConnectedAcceptanceInspection,
  inspectConnectedAcceptance
} from './connected-acceptance-inspection.mjs';
import { readJson } from './lib/canonical-json.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = '2026-07-29T12:00:00.000Z';
const FINGERPRINTS = {
  checkpoint: 'sha256:' + '1'.repeat(64),
  lock: 'sha256:' + '2'.repeat(64),
  graph: 'sha256:' + '3'.repeat(64),
  observed: 'sha256:' + '4'.repeat(64)
};

function operatorInspection(host, state) {
  const needsAttention = state === 'needs-attention';
  return {
    activity: {
      automationId: 'automation.task-capture',
      workId: 'work.acceptance.' + host,
      workState: needsAttention ? 'blocked' : 'completed',
      phase: needsAttention ? 'reconciliation' : 'complete'
    },
    configuration: {
      name: 'task-capture',
      host,
      lockFingerprint: FINGERPRINTS.lock,
      graphFingerprint: FINGERPRINTS.graph,
      applicability: {
        state: 'current',
        reasonCode: 'CONFIGURATION_LOCK_CURRENT'
      }
    },
    approval: {
      state: 'consumed',
      reasonCode: 'APPROVAL_CONSUMED'
    },
    checkpoint: {
      id: 'checkpoint.transaction.acceptance-' + host,
      fingerprint: FINGERPRINTS.checkpoint,
      state,
      updatedAt: AT
    },
    verification: {
      state: needsAttention ? 'unknown' : 'verified',
      observedFingerprint: needsAttention ? null : FINGERPRINTS.observed
    },
    resume: {
      classification: 'unavailable',
      reasonCode: needsAttention
        ? 'TRANSACTION_NEEDS_ATTENTION'
        : 'TRANSACTION_COMPLETED',
      permittedNextAction: needsAttention ? 'inspect-checkpoint' : 'none'
    },
    blockers: needsAttention
      ? [{ reasonCode: 'TRANSACTION_NEEDS_ATTENTION' }]
      : [],
    rawProviderResponse: 'HOSTILE_RAW_PROVIDER_RESPONSE_SENTINEL',
    privateInput: 'HOSTILE_PRIVATE_INPUT_SENTINEL',
    localPath: '/private/user/acceptance.json'
  };
}

export function selftestConnectedAcceptanceInspection(sourceRoot = root) {
  const schema = readJson(path.join(
    sourceRoot,
    'soter/contracts/connected-acceptance-inspection.schema.json'
  ));
  const baseline = inspectConnectedAcceptance({
    root: sourceRoot,
    generatedAt: AT
  });
  assert.deepEqual(validateJsonSchema(baseline, schema), []);
  assert.equal(baseline.slackConversationReview.state, 'unavailable');
  assert.equal(
    baseline.slackConversationReview.reasonCode,
    'CLOSED_MESSAGE_THREAD_RESPONSE_UNAVAILABLE'
  );
  assert.equal(baseline.transactions.state, 'not-evaluated');
  assert.equal(baseline.authority.grants, 'none');
  assert.equal(baseline.claims.acceptance, 'not-evaluated');

  const observed = composeConnectedAcceptanceInspection({
    root: sourceRoot,
    generatedAt: AT,
    slackConversationReview: baseline.slackConversationReview,
    operatorInspections: [
      operatorInspection('claude', 'completed'),
      operatorInspection('codex', 'needs-attention')
    ]
  });
  assert.deepEqual(validateJsonSchema(observed, schema), []);
  assert.deepEqual(
    observed.transactions.observations.map((item) => [item.host, item.checkpoint.state]),
    [['claude', 'completed'], ['codex', 'needs-attention']]
  );
  assert.equal(
    observed.transactions.observations[1].resume.permittedNextAction,
    'inspect-checkpoint'
  );
  const serialized = JSON.stringify(observed);
  for (const excluded of [
    'HOSTILE_RAW_PROVIDER_RESPONSE_SENTINEL',
    'HOSTILE_PRIVATE_INPUT_SENTINEL',
    '/private/user/acceptance.json'
  ]) {
    assert.equal(serialized.includes(excluded), false);
  }

  assert.throws(() => {
    composeConnectedAcceptanceInspection({
      root: sourceRoot,
      generatedAt: AT,
      slackConversationReview: baseline.slackConversationReview,
      operatorInspections: [
        operatorInspection('codex', 'needs-attention'),
        operatorInspection('codex', 'needs-attention')
      ]
    });
  }, /duplicate checkpoint identity/);

  const hostile = structuredClone(observed);
  hostile.rawProviderResponse = 'HOSTILE_SCHEMA_ESCAPE_SENTINEL';
  assert(validateJsonSchema(hostile, schema).length > 0);
  assert.throws(() => {
    inspectConnectedAcceptance({
      root: sourceRoot,
      checkpointIds: ['checkpoint.transaction.duplicate', 'checkpoint.transaction.duplicate'],
      generatedAt: AT
    });
  }, /unique exact checkpoint IDs/);

  process.stdout.write('Connected acceptance inspection selftest passed.\n');
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestConnectedAcceptanceInspection();
}
