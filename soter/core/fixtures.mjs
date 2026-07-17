import fs from 'node:fs';
import path from 'node:path';

import { runConnectedDoctor, runOfflineDoctor } from './doctor.mjs';
import { assembleMeetingIntakeContext } from './context.mjs';
import {
  createContextAssemblyEvidence,
  createContainedTransactionEvidence,
  createResolutionEvidence,
  createRunPreparationEvidence
} from './evidence.mjs';
import { canonicalJson, readJson, writeJson } from './lib/canonical-json.mjs';
import { resolveConfiguration } from './resolve.mjs';
import { prepareRunEnvelope } from './run.mjs';
import { runContainedMeetingIntakeTransaction } from '../automations/meeting-intake/transaction.mjs';
import { runContainedProjectPulseScenario } from '../automations/project-pulse/scenario.mjs';

export const MEETING_INTAKE_FIXTURE_TIME = '2026-07-15T12:00:00.000Z';
export const PROJECT_PULSE_FIXTURE_TIME = '2026-07-16T12:00:00.000Z';
export const TASK_CAPTURE_FIXTURE_TIME = '2026-07-16T15:00:00.000Z';
export const EMAIL_TRIAGE_FIXTURE_TIME = '2026-07-16T16:00:00.000Z';

export async function buildMeetingIntakeFixtures(root) {
  const lockPath = 'soter/fixtures/meeting-intake/meeting-intake.lock.json';
  const resolutionEvidenceId = 'evidence.meeting-intake.resolution.fixture';
  const preparationEvidenceId = 'evidence.meeting-intake.preparation.fixture';
  const contextEvidenceId = 'evidence.meeting-intake.context.fixture';
  const transactionEvidenceId = 'evidence.meeting-intake.transaction.fixture';
  const lock = resolveConfiguration({
    root,
    configPath: 'soter/configurations/meeting-intake.config.json'
  });
  const envelope = prepareRunEnvelope({
    root,
    lock,
    lockPath,
    scenarioPath: 'soter/scenarios/meeting-intake/happy-path.scenario.json',
    runId: 'run.meeting-intake.fixture',
    createdAt: MEETING_INTAKE_FIXTURE_TIME,
    evidenceIds: [resolutionEvidenceId, preparationEvidenceId]
  });
  const resolutionEvidence = createResolutionEvidence({
    lock,
    id: resolutionEvidenceId,
    createdAt: MEETING_INTAKE_FIXTURE_TIME
  });
  const preparationEvidence = createRunPreparationEvidence({
    lock,
    envelope,
    id: preparationEvidenceId,
    createdAt: MEETING_INTAKE_FIXTURE_TIME
  });
  const doctor = runOfflineDoctor({
    root,
    lock,
    doctorId: 'doctor.meeting-intake.fixture',
    evidenceId: resolutionEvidenceId,
    createdAt: MEETING_INTAKE_FIXTURE_TIME
  });
  if (doctor.evidence.length !== 1
    || canonicalJson(doctor.evidence[0]) !== canonicalJson(resolutionEvidence)) {
    throw new Error('Offline doctor did not reproduce the shared resolution evidence record.');
  }
  const connectedDoctor = runConnectedDoctor({
    root,
    lock,
    doctorId: 'doctor.meeting-intake.connected-fixture',
    evidenceId: resolutionEvidenceId,
    createdAt: MEETING_INTAKE_FIXTURE_TIME,
    providerProbes: []
  });
  if (connectedDoctor.evidence.length !== 1
    || canonicalJson(connectedDoctor.evidence[0]) !== canonicalJson(resolutionEvidence)) {
    throw new Error('Connected doctor did not reproduce the shared resolution evidence record.');
  }
  const contained = await assembleMeetingIntakeContext({
    root,
    lock,
    lockPath,
    scenarioPath: 'soter/scenarios/meeting-intake/happy-path.scenario.json',
    runId: 'run.meeting-intake.contained-fixture',
    snapshotId: 'context.meeting-intake.contained-fixture',
    createdAt: MEETING_INTAKE_FIXTURE_TIME,
    meetingId: 'meeting.fixture-001',
    recordingUri: 'otter://fixture/meeting.fixture-001',
    evidenceIds: [resolutionEvidenceId, contextEvidenceId]
  });
  const contextEvidence = createContextAssemblyEvidence({
    lock,
    envelope: contained.envelope,
    snapshot: contained.snapshot,
    id: contextEvidenceId,
    createdAt: MEETING_INTAKE_FIXTURE_TIME
  });
  const transaction = await runContainedMeetingIntakeTransaction({
    root,
    lock,
    lockPath,
    scenarioPath: 'soter/scenarios/meeting-intake/happy-path.scenario.json',
    runId: 'run.meeting-intake.transaction-fixture',
    snapshotId: 'context.meeting-intake.transaction-fixture',
    decisionId: 'decision.meeting-intake.transaction-fixture',
    changeSetId: 'changeset.meeting-intake.transaction-fixture',
    approvalId: 'approval.meeting-intake.transaction-fixture',
    createdAt: MEETING_INTAKE_FIXTURE_TIME,
    actor: 'fixture.user',
    approved: true,
    evidenceIds: [resolutionEvidenceId, transactionEvidenceId]
  });
  const transactionEvidence = createContainedTransactionEvidence({
    lock,
    envelope: transaction.envelope,
    decision: transaction.decision,
    changeSet: transaction.changeSet,
    approval: transaction.approval,
    id: transactionEvidenceId,
    createdAt: MEETING_INTAKE_FIXTURE_TIME
  });

  return new Map([
    [lockPath, lock],
    ['soter/fixtures/meeting-intake/preflight.run.json', envelope],
    ['soter/fixtures/meeting-intake/resolution.evidence.json', resolutionEvidence],
    ['soter/fixtures/meeting-intake/preparation.evidence.json', preparationEvidence],
    ['soter/fixtures/meeting-intake/offline.doctor.json', doctor.report],
    ['soter/fixtures/meeting-intake/connected.doctor.json', connectedDoctor.report],
    ['soter/fixtures/meeting-intake/contained.run.json', contained.envelope],
    ['soter/fixtures/meeting-intake/contained.context.json', contained.snapshot],
    ['soter/fixtures/meeting-intake/contained.evidence.json', contextEvidence],
    ['soter/fixtures/meeting-intake/transaction.run.json', transaction.envelope],
    ['soter/fixtures/meeting-intake/transaction.context.json', transaction.snapshot],
    ['soter/fixtures/meeting-intake/transaction.decision.json', transaction.decision],
    ['soter/fixtures/meeting-intake/transaction.changeset.json', transaction.changeSet],
    ['soter/fixtures/meeting-intake/transaction.approval.json', transaction.approval],
    ['soter/fixtures/meeting-intake/transaction.evidence.json', transactionEvidence]
  ]);
}

export async function buildProjectPulseFixtures(root) {
  const lockPath = 'soter/fixtures/project-pulse/project-pulse.lock.json';
  const resolutionEvidenceId = 'evidence.project-pulse.resolution.fixture';
  const lock = resolveConfiguration({
    root,
    configPath: 'soter/configurations/project-pulse.config.json'
  });
  const resolutionEvidence = createResolutionEvidence({
    lock,
    id: resolutionEvidenceId,
    createdAt: PROJECT_PULSE_FIXTURE_TIME
  });
  const doctor = runOfflineDoctor({
    root,
    lock,
    doctorId: 'doctor.project-pulse.fixture',
    evidenceId: resolutionEvidenceId,
    createdAt: PROJECT_PULSE_FIXTURE_TIME
  });
  if (doctor.evidence.length !== 1
    || canonicalJson(doctor.evidence[0]) !== canonicalJson(resolutionEvidence)) {
    throw new Error('Project Pulse offline doctor did not reproduce the shared resolution evidence record.');
  }
  const scenarios = [
    ['happy-path', 'soter/scenarios/project-pulse/happy-path.scenario.json'],
    ['no-invented-progress', 'soter/scenarios/project-pulse/no-invented-progress.scenario.json'],
    ['pressure-on-track', 'soter/scenarios/project-pulse/pressure-on-track.scenario.json']
  ];
  const fixtures = new Map([
    [lockPath, lock],
    ['soter/fixtures/project-pulse/resolution.evidence.json', resolutionEvidence],
    ['soter/fixtures/project-pulse/offline.doctor.json', doctor.report]
  ]);
  for (const [slug, scenarioPath] of scenarios) {
    const scenarioEvidenceId = 'evidence.project-pulse.' + slug + '.fixture';
    const execution = await runContainedProjectPulseScenario({
      root,
      lock,
      lockPath,
      scenarioPath,
      runId: 'run.project-pulse.' + slug + '-fixture',
      snapshotId: 'context.project-pulse.' + slug + '-fixture',
      scenarioEvidenceId,
      createdAt: PROJECT_PULSE_FIXTURE_TIME,
      evidenceIds: [resolutionEvidenceId]
    });
    if (execution.scenarioEvidence.result !== 'passed') {
      throw new Error('Project Pulse scenario fixture did not pass: ' + execution.scenario.id + '.');
    }
    fixtures.set('soter/fixtures/project-pulse/' + slug + '.run.json', execution.envelope);
    fixtures.set('soter/fixtures/project-pulse/' + slug + '.context.json', execution.snapshot);
    fixtures.set('soter/fixtures/project-pulse/' + slug + '.evidence.json', execution.scenarioEvidence);
  }
  return fixtures;
}

export async function buildTaskCaptureFixtures(root) {
  const lockPath = 'soter/fixtures/task-capture/task-capture.lock.json';
  const resolutionEvidenceId = 'evidence.task-capture.resolution.fixture';
  const lock = resolveConfiguration({
    root,
    configPath: 'soter/configurations/task-capture.config.json'
  });
  const resolutionEvidence = createResolutionEvidence({
    lock,
    id: resolutionEvidenceId,
    createdAt: TASK_CAPTURE_FIXTURE_TIME
  });
  const doctor = runOfflineDoctor({
    root,
    lock,
    doctorId: 'doctor.task-capture.fixture',
    evidenceId: resolutionEvidenceId,
    createdAt: TASK_CAPTURE_FIXTURE_TIME
  });
  if (doctor.evidence.length !== 1
    || canonicalJson(doctor.evidence[0]) !== canonicalJson(resolutionEvidence)) {
    throw new Error('Task Capture offline doctor did not reproduce the shared resolution evidence record.');
  }
  return new Map([
    [lockPath, lock],
    ['soter/fixtures/task-capture/resolution.evidence.json', resolutionEvidence],
    ['soter/fixtures/task-capture/offline.doctor.json', doctor.report]
  ]);
}

export async function buildEmailTriageFixtures(root) {
  const lockPath = 'soter/fixtures/email-triage/email-triage.lock.json';
  const resolutionEvidenceId = 'evidence.email-triage.resolution.fixture';
  const lock = resolveConfiguration({
    root,
    configPath: 'soter/configurations/email-triage.config.json'
  });
  const resolutionEvidence = createResolutionEvidence({
    lock,
    id: resolutionEvidenceId,
    createdAt: EMAIL_TRIAGE_FIXTURE_TIME
  });
  const doctor = runOfflineDoctor({
    root,
    lock,
    doctorId: 'doctor.email-triage.fixture',
    evidenceId: resolutionEvidenceId,
    createdAt: EMAIL_TRIAGE_FIXTURE_TIME
  });
  if (doctor.evidence.length !== 1
    || canonicalJson(doctor.evidence[0]) !== canonicalJson(resolutionEvidence)) {
    throw new Error('Email triage offline doctor did not reproduce the shared resolution evidence record.');
  }
  return new Map([
    [lockPath, lock],
    ['soter/fixtures/email-triage/resolution.evidence.json', resolutionEvidence],
    ['soter/fixtures/email-triage/offline.doctor.json', doctor.report]
  ]);
}

export async function buildSoterFixtures(root) {
  const combined = new Map();
  for (const fixtures of [
    await buildMeetingIntakeFixtures(root),
    await buildProjectPulseFixtures(root),
    await buildTaskCaptureFixtures(root),
    await buildEmailTriageFixtures(root)
  ]) {
    for (const [relativePath, value] of fixtures) {
      if (combined.has(relativePath)) throw new Error('Duplicate generated fixture path: ' + relativePath + '.');
      combined.set(relativePath, value);
    }
  }
  return combined;
}

function managedTaskCaptureFiles(root) {
  const directory = path.join(root, 'soter/fixtures/task-capture');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => 'soter/fixtures/task-capture/' + entry.name)
    .sort();
}

function managedEmailTriageFiles(root) {
  const directory = path.join(root, 'soter/fixtures/email-triage');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => 'soter/fixtures/email-triage/' + entry.name)
    .sort();
}

function managedProjectPulseFiles(root) {
  const directory = path.join(root, 'soter/fixtures/project-pulse');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => 'soter/fixtures/project-pulse/' + entry.name)
    .sort();
}

export async function checkSoterFixtures(root) {
  const expected = await buildSoterFixtures(root);
  const mismatches = [];
  for (const [relativePath, value] of expected) {
    const file = path.join(root, relativePath);
    if (!fs.existsSync(file)) {
      mismatches.push({ path: relativePath, reason: 'missing' });
      continue;
    }
    let observed;
    try {
      observed = readJson(file);
    } catch (error) {
      mismatches.push({ path: relativePath, reason: 'invalid JSON: ' + error.message });
      continue;
    }
    if (canonicalJson(observed) !== canonicalJson(value)) {
      mismatches.push({ path: relativePath, reason: 'stale' });
    }
  }
  for (const relativePath of managedProjectPulseFiles(root)) {
    if (!expected.has(relativePath)) mismatches.push({ path: relativePath, reason: 'unexpected unmanaged fixture' });
  }
  for (const relativePath of managedTaskCaptureFiles(root)) {
    if (!expected.has(relativePath)) mismatches.push({ path: relativePath, reason: 'unexpected unmanaged fixture' });
  }
  for (const relativePath of managedEmailTriageFiles(root)) {
    if (!expected.has(relativePath)) mismatches.push({ path: relativePath, reason: 'unexpected unmanaged fixture' });
  }
  mismatches.sort((left, right) => left.path.localeCompare(right.path));
  return { matches: mismatches.length === 0, mismatches, expected };
}

export async function writeSoterFixtures(root) {
  const fixtures = await buildSoterFixtures(root);
  for (const [relativePath, value] of fixtures) {
    writeJson(path.join(root, relativePath), value);
  }
  return fixtures;
}
