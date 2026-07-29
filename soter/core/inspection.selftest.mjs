import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { workflowEvidenceBasisLockPaths } from '../kernel/workflow-evidence-bases.mjs';
import { readJson } from './lib/canonical-json.mjs';
import { aggregateProofStates, inspectWorkspace } from './inspection.mjs';
import { prepareAutomationRun } from './prepared-work.mjs';
import { writePrivateConfigurationState } from './private-configurations.mjs';
import { resolveConfiguration } from './resolve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const historicalLockPath of workflowEvidenceBasisLockPaths()) {
  const rejectedDoctor = spawnSync(process.execPath, [
    path.join(root, 'soter/core/cli.mjs'),
    'doctor',
    '--root',
    root,
    '--lock',
    historicalLockPath,
    '--json'
  ], {
    encoding: 'utf8'
  });
  assert.notEqual(rejectedDoctor.status, 0,
    'Doctor accepted historical workflow-evidence basis ' + historicalLockPath + '.');
  assert.match(
    rejectedDoctor.stderr,
    /SOTER_HISTORICAL_EVIDENCE_LOCK_NOT_OPERATIONAL/,
    'Doctor did not return the stable historical-basis rejection code for '
      + historicalLockPath + '.'
  );
}
const first = inspectWorkspace({ root });
const second = inspectWorkspace({ root });
const failures = validateJsonSchema(first, readJson(path.join(root, 'soter/contracts/workspace-inspection.schema.json')));

assert.deepEqual(failures, [], 'Workspace inspection must satisfy its provider-neutral contract.');
assert.deepEqual(second, first, 'Unchanged canonical and private inputs must produce a deterministic snapshot.');
const crossedPreparationMode = structuredClone(first);
crossedPreparationMode.workflows
  .find((item) => item.id === 'automation.task-capture')
  .operator.preparation.modes
  .find((mode) => mode.id === 'connected-acquisition')
  .resultState = 'ready-for-review';
assert.notDeepEqual(
  validateJsonSchema(
    crossedPreparationMode,
    readJson(path.join(root, 'soter/contracts/workspace-inspection.schema.json'))
  ),
  [],
  'Workspace inspection must reject crossed connected-acquisition mode and result-state facts.'
);
const hostilePreparationBoundary = structuredClone(first);
hostilePreparationBoundary.workflows
  .find((item) => item.id === 'automation.task-capture')
  .operator.preparation.modes
  .find((mode) => mode.id === 'connected-acquisition')
  .boundary = 'Exact confirmation is complete and execution is now authorized.';
assert.notDeepEqual(
  validateJsonSchema(
    hostilePreparationBoundary,
    readJson(path.join(root, 'soter/contracts/workspace-inspection.schema.json'))
  ),
  [],
  'Workspace inspection must reject authority-misleading preparation boundaries.'
);
const duplicatePreparationMode = structuredClone(first);
const duplicateModeWorkflow = duplicatePreparationMode.workflows
  .find((item) => item.id === 'automation.task-capture');
duplicateModeWorkflow.operator.preparation.modes.push({
  ...structuredClone(
    duplicateModeWorkflow.operator.preparation.modes
      .find((mode) => mode.id === 'connected-acquisition')
  ),
  boundary: 'A conflicting duplicate boundary must not be representable.'
});
assert.notDeepEqual(
  validateJsonSchema(
    duplicatePreparationMode,
    readJson(path.join(root, 'soter/contracts/workspace-inspection.schema.json'))
  ),
  [],
  'Workspace inspection must reject duplicate preparation-mode identities.'
);
const slackHostCompatibility = first.workflows
  .find((item) => item.id === 'automation.slack-conversation-review')
  .hostCompatibility;
assert.deepEqual(slackHostCompatibility, {
  claude: { state: 'compatible' },
  codex: { state: 'compatible' }
});
assert.deepEqual(
  first.workflows
    .find((item) => item.id === 'automation.slack-conversation-review')
    .operator.preparation.modes
    .find((mode) => mode.id === 'connected-acquisition')
    .availability,
  {
    state: 'unavailable',
    reasonCode: 'CLOSED_MESSAGE_THREAD_RESPONSE_UNAVAILABLE',
    reason: 'Current Codex and Claude Slack routes expose message and thread results as human-formatted prose rather than a closed mechanically normalizable response.'
  }
);
assert.deepEqual(
  first.workflows
    .find((item) => item.id === 'automation.meeting-intake')
  .hostCompatibility,
  {
    claude: { state: 'compatible' },
    codex: { state: 'compatible' }
  }
);
const hostileHostCompatibility = structuredClone(first);
hostileHostCompatibility.workflows
  .find((item) => item.id === 'automation.slack-conversation-review')
  .hostCompatibility.claude.state = 'compatible';
hostileHostCompatibility.workflows
  .find((item) => item.id === 'automation.slack-conversation-review')
  .hostCompatibility.claude.reasonCode = 'STRUCTURED_RESPONSE_PROFILE_UNAVAILABLE';
assert.notDeepEqual(
  validateJsonSchema(
    hostileHostCompatibility,
    readJson(path.join(root, 'soter/contracts/workspace-inspection.schema.json'))
  ),
  [],
  'Workspace inspection must reject invented host-incompatibility reason codes.'
);
const malformedHostCompatibility = structuredClone(first);
malformedHostCompatibility.workflows
  .find((item) => item.id === 'automation.slack-conversation-review')
  .hostCompatibility.Claude = { state: 'compatible' };
assert.notDeepEqual(
  validateJsonSchema(
    malformedHostCompatibility,
    readJson(path.join(root, 'soter/contracts/workspace-inspection.schema.json'))
  ),
  [],
  'Workspace inspection must reject non-canonical host compatibility keys.'
);
const omittedHostCompatibility = structuredClone(first);
delete omittedHostCompatibility.workflows
  .find((item) => item.id === 'automation.slack-conversation-review')
  .hostCompatibility.claude;
assert.notDeepEqual(
  validateJsonSchema(
    omittedHostCompatibility,
    readJson(path.join(root, 'soter/contracts/workspace-inspection.schema.json'))
  ),
  [],
  'Workspace inspection must require one compatibility fact for every governed v1 host.'
);
const inventedHostCompatibility = structuredClone(first);
inventedHostCompatibility.workflows
  .find((item) => item.id === 'automation.slack-conversation-review')
  .hostCompatibility.foo = { state: 'compatible' };
assert.notDeepEqual(
  validateJsonSchema(
    inventedHostCompatibility,
    readJson(path.join(root, 'soter/contracts/workspace-inspection.schema.json'))
  ),
  [],
  'Workspace inspection must reject compatibility facts for hosts outside its governed v1 inventory.'
);
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
const meetingMigrationStates = Object.fromEntries(
  first.workflows
    .find((item) => item.id === 'automation.meeting-intake')
    ?.scenarios.map((scenario) => [scenario.id, scenario.migrationState]) || []
);
assert.equal(meetingMigrationStates['meeting-intake.preparation'], 'migrated',
  'An exact scenario target must retain its mechanically bound migration state.');
assert.equal(meetingMigrationStates['meeting-intake.happy-path'], 'target-native',
  'A target-native scenario must not become unknown or claim migration without an exact target binding.');
const emailMigrationStates = Object.fromEntries(
  first.workflows
    .find((item) => item.id === 'automation.email-triage')
    ?.scenarios.map((scenario) => [scenario.id, scenario.migrationState]) || []
);
assert.equal(emailMigrationStates['email-triage.preparation'], 'migrated');
assert.equal(emailMigrationStates['email-triage.happy-path'], 'target-native');
assert(first.workflows
  .filter((workflow) => workflow.migration.state === 'migrated')
  .flatMap((workflow) => workflow.scenarios)
  .every((scenario) => scenario.migrationState !== 'unknown'),
  'A completed workflow migration must distinguish exact migrated targets from target-native scenarios.');

const halfStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-inspection-basis-selftest-'));
try {
  fs.cpSync(path.join(root, 'soter'), path.join(halfStateRoot, 'soter'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(halfStateRoot, 'package.json'));
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(halfStateRoot, 'package-lock.json'));
  writePrivateConfigurationState(
    halfStateRoot,
    'meeting-intake',
    readJson(path.join(halfStateRoot, 'soter/configurations/meeting-intake.config.json'))
  );
  const halfState = inspectWorkspace({ root: halfStateRoot });
  const halfStateConfiguration = halfState.configurations.find((item) => {
    return item.name === 'meeting-intake';
  });
  const halfStateWorkflow = halfState.workflows.find((item) => {
    return item.id === 'automation.meeting-intake';
  });
  assert.equal(halfStateConfiguration?.configurationBasis, 'private-active');
  assert.equal(halfStateConfiguration?.lockState, 'invalid',
    'Workspace inspection silently fell back to tracked state when private desired state lacked its lock.');
  assert.equal(halfStateConfiguration?.host, 'unavailable');
  assert.deepEqual(halfStateConfiguration?.selections, []);
  assert.deepEqual(halfStateConfiguration?.bindings, []);
  assert.deepEqual(halfStateConfiguration?.authorities, []);
  assert.deepEqual(halfStateConfiguration?.effectPolicies, [],
    'Private half-state inspection exposed tracked configuration details as a fallback.');
  assert.equal(halfStateWorkflow?.configuration, 'meeting-intake',
    'Workflow inspection lost non-sensitive tracked membership for a private half-state.');
  assert.equal(halfStateWorkflow?.configurationBasis, 'private-active',
    'Workflow inspection did not preserve its selected configuration basis.');
  assert.equal(halfStateWorkflow?.host, 'unavailable');
  assert.deepEqual(halfStateWorkflow?.bindings, [],
    'Workflow inspection exposed tracked bindings for a private half-state.');
} finally {
  fs.rmSync(halfStateRoot, { recursive: true, force: true });
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-inspection-selftest-'));
try {
  fs.cpSync(path.join(root, 'soter'), path.join(temporaryRoot, 'soter'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(temporaryRoot, 'package.json'));
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(temporaryRoot, 'package-lock.json'));
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
  const historicalLockPath = path.join(
    temporaryRoot,
    'soter/fixtures/harness-development-catalog-final/codex.lock.json'
  );
  const historicalLock = readJson(historicalLockPath);
  const currentOperationalLock = resolveConfiguration({
    root: temporaryRoot,
    configPath: 'soter/configurations/harness-development-catalog.config.json'
  });
  assert.notEqual(
    currentOperationalLock.graphFingerprint,
    historicalLock.graphFingerprint,
    'The planted operational renewal must differ from its immutable historical evidence basis.'
  );
  const operationalLockPath = path.join(
    temporaryRoot,
    'soter/fixtures/harness-development-catalog/harness-development-catalog.lock.json'
  );
  fs.writeFileSync(
    operationalLockPath,
    JSON.stringify(currentOperationalLock, null, 2) + '\n'
  );
  const renewedOperationalSnapshot = inspectWorkspace({ root: temporaryRoot });
  assert.equal(
    renewedOperationalSnapshot.configurations.find((item) => {
      return item.name === 'harness-development-catalog';
    })?.lockState,
    'current',
    'An immutable historical evidence basis conflicted with the renewed operational lock.'
  );
  assert.equal(
    renewedOperationalSnapshot.proof.checks.find((item) => {
      return item.id === 'harness-development-catalog:core.lock-current';
    })?.state,
    'passed',
    'Operational proof selected the immutable historical evidence basis instead of the renewed lock.'
  );

  const conflictingOperationalLock = structuredClone(currentOperationalLock);
  conflictingOperationalLock.graphFingerprint = 'sha256:' + 'f'.repeat(64);
  const conflictingOperationalDirectory = path.join(
    temporaryRoot,
    'soter/fixtures/inspection-operational-duplicate'
  );
  fs.mkdirSync(conflictingOperationalDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(conflictingOperationalDirectory, 'harness-development-catalog.lock.json'),
    JSON.stringify(conflictingOperationalLock, null, 2) + '\n'
  );
  const conflictingOperationalSnapshot = inspectWorkspace({ root: temporaryRoot });
  assert.equal(
    conflictingOperationalSnapshot.configurations.find((item) => {
      return item.name === 'harness-development-catalog';
    })?.lockState,
    'invalid',
    'Workspace inspection ignored a conflicting ordinary operational lock.'
  );
  fs.rmSync(conflictingOperationalDirectory, { recursive: true, force: true });
  const privatePreparationSentinel = 'INSPECTION_PRIVATE_PREPARATION_SENTINEL';
  const prepared = await prepareAutomationRun({
    root: temporaryRoot,
    automationId: 'automation.project-pulse',
    configurationName: 'project-pulse',
    configurationBasis: 'tracked-contained',
    input: {
      project: 'https://www.notion.so/22222222222222222222222222222221',
      statusDate: '2026-07-16',
      visibility: 'Internal',
      health: 'at-risk',
      operatorGoal: privatePreparationSentinel
    },
    createdAt: '2026-07-16T14:30:00.000Z'
  });
  const meetingPreparationSentinel = 'INSPECTION_PRIVATE_MEETING_PREPARATION_SENTINEL';
  const preparedMeeting = await prepareAutomationRun({
    root: temporaryRoot,
    automationId: 'automation.meeting-intake',
    configurationName: 'meeting-intake',
    configurationBasis: 'tracked-contained',
    input: {
      meeting: 'meeting.fixture-001',
      recordingUri: 'https://otter.ai/u/meeting_fixture_001',
      operatorGoal: meetingPreparationSentinel
    },
    createdAt: '2026-07-16T14:31:00.000Z'
  });
  const taskPreparationSentinel = 'INSPECTION_PRIVATE_TASK_CAPTURE_SENTINEL';
  const preparedTask = await prepareAutomationRun({
    root: temporaryRoot,
    automationId: 'automation.task-capture',
    configurationName: 'task-capture',
    configurationBasis: 'tracked-contained',
    input: {
      title: taskPreparationSentinel,
      project: 'soter-fixture://projects/project/launch',
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
    configurationBasis: 'tracked-contained',
    input: {
      query: 'in:inbox newer_than:1d',
      scope: 'triage-drafts-handoffs-digest',
      focus: emailPreparationSentinel
    },
    createdAt: '2026-07-16T14:33:00.000Z'
  });
  const preparedSnapshot = inspectWorkspace({ root: temporaryRoot });
  assert(preparedSnapshot.configurations.every((item) => {
    return item.configurationBasis === 'tracked-contained';
  }), 'Contained workspace inspection did not disclose tracked-contained configuration basis.');
  assert(preparedSnapshot.workflows.every((item) => {
    return item.configuration === null || item.configurationBasis === 'tracked-contained';
  }), 'Workflow inspection did not preserve its selected contained configuration basis.');
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
    ['draft', 'preparing', 'needs-input', 'ready-for-review', 'ready-for-acquisition']);
  assert.equal(meetingWorkflow?.operator.preparation.supported, true);
  assert.deepEqual(meetingWorkflow?.operator.preparation.workStates,
    ['draft', 'preparing', 'needs-input', 'ready-for-review', 'ready-for-acquisition']);
  assert.equal(taskWorkflow?.operator.preparation.supported, true);
  assert.deepEqual(taskWorkflow?.operator.preparation.workStates,
    ['draft', 'preparing', 'needs-input', 'ready-for-review', 'ready-for-acquisition']);
  assert.equal(emailWorkflow?.operator.preparation.supported, true);
  assert.deepEqual(emailWorkflow?.operator.preparation.workStates,
    ['draft', 'preparing', 'needs-input', 'ready-for-review', 'ready-for-acquisition']);
  for (const workflow of [
    projectWorkflow,
    meetingWorkflow,
    taskWorkflow,
    emailWorkflow
  ]) {
    assert.deepEqual(
      workflow?.operator.preparation.modes.map((mode) => ({
        id: mode.id,
        configurationBases: mode.configurationBases,
        resultState: mode.resultState,
        availability: mode.availability
      })),
      [
        {
          id: 'contained',
          configurationBases: ['tracked-contained', 'private-active'],
          resultState: 'ready-for-review',
          availability: { state: 'available' }
        },
        {
          id: 'connected-acquisition',
          configurationBases: ['private-active'],
          resultState: 'ready-for-acquisition',
          availability: { state: 'available' }
        }
      ]
    );
  }

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
