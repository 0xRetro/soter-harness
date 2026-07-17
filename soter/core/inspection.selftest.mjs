import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { readJson } from './lib/canonical-json.mjs';
import { aggregateProofStates, inspectWorkspace } from './inspection.mjs';
import { prepareAutomationRun } from './prepared-work.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const first = inspectWorkspace({ root });
const second = inspectWorkspace({ root });
const failures = validateJsonSchema(first, readJson(path.join(root, 'soter/contracts/workspace-inspection.schema.json')));

assert.deepEqual(failures, [], 'Workspace inspection must satisfy its provider-neutral contract.');
assert.deepEqual(second, first, 'Unchanged canonical and private inputs must produce a deterministic snapshot.');
assert(first.activity.every((item) => item.kind !== 'operator-work'), 'Provisional operator-work activity must not enter Studio.');
assert(!JSON.stringify(first).includes('operator-confirmation/v1'), 'Provisional confirmation contracts must not enter Studio.');
assert.equal(first.workspace.mode, 'read-only');
assert.deepEqual(Object.keys(first.proof.states).sort(), ['healthy', 'ready', 'valid', 'verified']);
assert.equal(new Set(first.graph.nodes.map((item) => item.id)).size, first.graph.nodes.length,
  'Workspace graph node IDs must remain unique across configurations.');
assert.equal(new Set(first.graph.edges.map((item) => item.id)).size, first.graph.edges.length,
  'Workspace graph edge IDs must remain unique across configurations.');
assert(first.configurations.every((item) => item.lockState === 'current'),
  'The finalized multi-configuration fixture graph must provide a current exact lock for every configuration.');
assert.equal(first.proof.states.valid, 'passed');
assert.notEqual(first.proof.states.ready, 'passed',
  'Current exact locks do not promote offline readiness without connected evidence.');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-inspection-selftest-'));
try {
  fs.cpSync(path.join(root, 'soter'), path.join(temporaryRoot, 'soter'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(temporaryRoot, 'package.json'));
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(temporaryRoot, 'package-lock.json'));
  for (const directory of ['.claude', '.codex']) {
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  const configurationDirectory = path.join(temporaryRoot, 'soter', 'configurations');
  const proofObservations = {
    valid: ['passed', 'stale'],
    ready: ['unknown', 'stale'],
    verified: ['unknown', 'passed'],
    healthy: ['skipped', 'passed']
  };
  assert.deepEqual(
    aggregateProofStates(Object.fromEntries(Object.entries(proofObservations).map(([key, values]) => [key, [...values].reverse()]))),
    aggregateProofStates(proofObservations),
    'Workspace proof aggregation must not depend on configuration ordering.'
  );
  const privatePreparationSentinel = 'INSPECTION_PRIVATE_PREPARATION_SENTINEL';
  const prepared = await prepareAutomationRun({
    root: temporaryRoot,
    automationId: 'automation.project-pulse',
    configurationName: 'project-pulse',
    input: { project: 'project.pulse-risk', operatorGoal: privatePreparationSentinel },
    createdAt: '2026-07-16T14:30:00.000Z'
  });
  const meetingPreparationSentinel = 'INSPECTION_PRIVATE_MEETING_PREPARATION_SENTINEL';
  const preparedMeeting = await prepareAutomationRun({
    root: temporaryRoot,
    automationId: 'automation.meeting-intake',
    configurationName: 'meeting-intake',
    input: {
      meeting: 'meeting.fixture-001',
      recordingUri: 'otter://fixture/meeting.fixture-001',
      operatorGoal: meetingPreparationSentinel
    },
    createdAt: '2026-07-16T14:31:00.000Z'
  });
  const taskPreparationSentinel = 'INSPECTION_PRIVATE_TASK_CAPTURE_SENTINEL';
  const preparedTask = await prepareAutomationRun({
    root: temporaryRoot,
    automationId: 'automation.task-capture',
    configurationName: 'task-capture',
    input: {
      title: taskPreparationSentinel,
      project: 'soter-fixture://crm/project/launch',
      nextActionOn: '2026-07-24',
      context: 'Project'
    },
    createdAt: '2026-07-16T14:32:00.000Z'
  });
  const emailPreparationSentinel = 'INSPECTION_PRIVATE_EMAIL_FOCUS_SENTINEL';
  const preparedEmail = await prepareAutomationRun({
    root: temporaryRoot,
    automationId: 'automation.email-triage',
    configurationName: 'email-triage',
    input: {
      query: 'in:inbox newer_than:1d',
      scope: 'triage-drafts-handoffs-digest',
      focus: emailPreparationSentinel
    },
    createdAt: '2026-07-16T14:33:00.000Z'
  });
  const preparedSnapshot = inspectWorkspace({ root: temporaryRoot });
  const preparedActivity = preparedSnapshot.activity.find((item) => item.id === prepared.id);
  assert.equal(preparedActivity?.kind, 'prepared-work');
  assert.equal(preparedActivity?.state, 'ready-for-review');
  assert.equal(preparedActivity?.source, 'runtime');
  assert.equal(preparedActivity?.preparedWorkRef.workId, prepared.id);
  assert(!JSON.stringify(preparedSnapshot).includes(privatePreparationSentinel),
    'Private prepared input reached the workspace inspection projection.');
  assert(!JSON.stringify(preparedSnapshot).includes(meetingPreparationSentinel),
    'Private Meeting Intake input reached the workspace inspection projection.');
  assert(!JSON.stringify(preparedSnapshot).includes(taskPreparationSentinel),
    'Private Task Capture input reached the workspace inspection projection.');
  assert(!JSON.stringify(preparedSnapshot).includes(emailPreparationSentinel),
    'Private Email input reached the workspace inspection projection.');
  for (const sentinel of [
    'in:inbox newer_than:1d',
    'RAW_EMAIL_SUBJECT_SENTINEL',
    'raw-email-sender-sentinel@bountyhub.example',
    'HOSTILE_RAW_BODY_SENTINEL',
    'Thanks for the note. I will research'
  ]) {
    assert(!JSON.stringify(preparedSnapshot).includes(sentinel),
      sentinel + ' reached the workspace inspection projection.');
  }
  assert.equal(preparedSnapshot.activity.find((item) => item.id === preparedMeeting.id)?.state, 'ready-for-review');
  assert.equal(preparedSnapshot.activity.find((item) => item.id === preparedTask.id)?.state, 'ready-for-review');
  assert.equal(preparedSnapshot.activity.find((item) => item.id === preparedEmail.id)?.state, 'ready-for-review');
  const projectWorkflow = preparedSnapshot.workflows.find((item) => item.id === 'automation.project-pulse');
  const meetingWorkflow = preparedSnapshot.workflows.find((item) => item.id === 'automation.meeting-intake');
  const taskWorkflow = preparedSnapshot.workflows.find((item) => item.id === 'automation.task-capture');
  const emailWorkflow = preparedSnapshot.workflows.find((item) => item.id === 'automation.email-triage');
  assert.equal(projectWorkflow?.operator.preparation.supported, true);
  assert.deepEqual(projectWorkflow?.operator.preparation.workStates,
    ['draft', 'preparing', 'needs-input', 'ready-for-review']);
  assert.equal(meetingWorkflow?.operator.preparation.supported, true);
  assert.deepEqual(meetingWorkflow?.operator.preparation.workStates,
    ['draft', 'preparing', 'needs-input', 'ready-for-review']);
  assert.equal(taskWorkflow?.operator.preparation.supported, true);
  assert.deepEqual(taskWorkflow?.operator.preparation.workStates,
    ['draft', 'preparing', 'needs-input', 'ready-for-review']);
  assert.equal(emailWorkflow?.operator.preparation.supported, true);
  assert.deepEqual(emailWorkflow?.operator.preparation.workStates,
    ['draft', 'preparing', 'needs-input', 'ready-for-review']);

  const tamperedPrepared = structuredClone(prepared);
  tamperedPrepared.fingerprint = 'sha256:' + '0'.repeat(64);
  fs.writeFileSync(
    path.join(temporaryRoot, '.soter', 'state', 'prepared-work', 'tampered.json'),
    JSON.stringify(tamperedPrepared, null, 2) + '\n'
  );
  const staleConfigurationPath = path.join(configurationDirectory, 'meeting-intake.config.json');
  const staleConfiguration = readJson(staleConfigurationPath);
  staleConfiguration.host.reason += ' Planted inspection self-test drift.';
  fs.writeFileSync(staleConfigurationPath, JSON.stringify(staleConfiguration, null, 2) + '\n');
  const staleSnapshot = inspectWorkspace({ root: temporaryRoot });
  assert.equal(staleSnapshot.configurations.find((item) => item.name === 'meeting-intake')?.lockState, 'stale');
  assert.equal(staleSnapshot.proof.states.valid, 'stale');
  assert.equal(staleSnapshot.proof.states.ready, 'stale');
  const malformed = path.join(temporaryRoot, 'soter', 'fixtures', 'studio-malformed.json');
  fs.writeFileSync(malformed, '{not-json\n');
  const hostile = path.join(temporaryRoot, 'soter', 'fixtures', 'hostile-privacy.json');
  fs.writeFileSync(hostile, JSON.stringify({
    $contract: 'soter://contracts/provider-fixture/v1',
    contractVersion: '1.0.0',
    id: 'fixture.hostile.privacy',
    provider: 'provider.integration.notion.fixture',
    observedAt: '2026-07-16T00:00:00.000Z',
    data: {
      rawProviderResponse: 'RAW_PROVIDER_RESPONSE_SENTINEL',
      value: 'PRIVATE_INPUT_SENTINEL',
      secretRef: 'SECRET_REFERENCE_TARGET_SENTINEL',
      before: 'RAW_BEFORE_SENTINEL',
      after: 'RAW_AFTER_SENTINEL'
    }
  }));
  const partial = inspectWorkspace({ root: temporaryRoot });
  assert(partial.catalog.length > 0, 'One malformed artifact must not prevent the remainder from loading.');
  assert(partial.diagnostics.some((item) => item.code === 'SOTER_INSPECTION_JSON_INVALID'
    && item.subject === 'soter/fixtures/studio-malformed.json'));
  assert(partial.diagnostics.some((item) => item.code === 'SOTER_INSPECTION_PREPARED_WORK_TAMPERED'
    && item.subject === '.soter/state/prepared-work/tampered.json'));
  const serialized = JSON.stringify(partial);
  for (const sentinel of [
    'RAW_PROVIDER_RESPONSE_SENTINEL',
    'PRIVATE_INPUT_SENTINEL',
    'SECRET_REFERENCE_TARGET_SENTINEL',
    'RAW_BEFORE_SENTINEL',
    'RAW_AFTER_SENTINEL',
    privatePreparationSentinel,
    taskPreparationSentinel,
    emailPreparationSentinel,
    'RAW_EMAIL_SUBJECT_SENTINEL',
    'raw-email-sender-sentinel@bountyhub.example',
    'HOSTILE_RAW_BODY_SENTINEL'
  ]) {
    assert(!serialized.includes(sentinel), sentinel + ' reached the workspace inspection projection or diagnostics.');
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write('Soter workspace inspection self-test passed.\n');
