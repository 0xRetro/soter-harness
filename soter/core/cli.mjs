#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatDoctorReport, runConnectedDoctor, runOfflineDoctor } from './doctor.mjs';
import {
  commitMeetingIntakeDecision,
  inspectMeetingIntakeDecisionContext
} from '../automations/meeting-intake/decision.mjs';
import {
  commitEmailTriageDecision,
  inspectEmailTriageDecisionContext
} from '../automations/email-triage/decision.mjs';
import {
  commitTaskCaptureDecision,
  inspectTaskCaptureDecisionContext
} from '../automations/task-capture/decision.mjs';
import {
  commitOrganizationCaptureDecision,
  inspectOrganizationCaptureDecisionContext
} from '../automations/organization-capture/decision.mjs';
import {
  commitProjectCaptureDecision,
  inspectProjectCaptureDecisionContext
} from '../automations/project-capture/decision.mjs';
import {
  commitProjectPageReconciliationDecision,
  inspectProjectPageReconciliationDecisionContext
} from '../automations/project-page-reconciliation/decision.mjs';
import {
  commitContactCaptureDecision,
  inspectContactCaptureDecisionContext
} from '../automations/contact-capture/decision.mjs';
import {
  commitProjectPulseDecision,
  inspectProjectPulseDecisionContext
} from '../automations/project-pulse/decision.mjs';
import {
  commitEmailTriageProposal,
  inspectEmailTriageProposalDecision,
  inspectEmailTriageProposalMaterial
} from '../automations/email-triage/proposal.mjs';
import {
  commitTaskCaptureProposal,
  inspectTaskCaptureProposalDecision,
  inspectTaskCaptureProposalMaterial
} from '../automations/task-capture/proposal.mjs';
import {
  commitOrganizationCaptureProposal,
  inspectOrganizationCaptureProposalDecision,
  inspectOrganizationCaptureProposalMaterial
} from '../automations/organization-capture/proposal.mjs';
import {
  commitProjectCaptureProposal,
  inspectProjectCaptureProposalDecision,
  inspectProjectCaptureProposalMaterial
} from '../automations/project-capture/proposal.mjs';
import {
  commitProjectPageReconciliationProposal,
  inspectProjectPageReconciliationProposalDecision,
  inspectProjectPageReconciliationProposalMaterial
} from '../automations/project-page-reconciliation/proposal.mjs';
import {
  commitContactCaptureProposal,
  inspectContactCaptureProposalDecision,
  inspectContactCaptureProposalMaterial
} from '../automations/contact-capture/proposal.mjs';
import {
  commitProjectPulseProposal,
  inspectProjectPulseProposalDecision,
  inspectProjectPulseProposalMaterial
} from '../automations/project-pulse/proposal.mjs';
import {
  commitMeetingIntakeProposal,
  inspectMeetingIntakeProposalDecision,
  inspectMeetingIntakeProposalMaterial
} from '../automations/meeting-intake/proposal.mjs';
import {
  createResolutionEvidence,
  createRunPreparationEvidence
} from './evidence.mjs';
import {
  checkSoterFixtures,
  writeSoterFixtures
} from './fixtures.mjs';
import {
  buildConfigurationView,
  formatConfigurationView
} from './configuration-view.mjs';
import {
  readJson,
  readPrivateJsonInput,
  repoRelativePath,
  resolveRepoPath,
  writeJson
} from './lib/canonical-json.mjs';
import {
  fingerprintLock,
  lockMatchesResolution,
  resolveConfiguration
} from './resolve.mjs';
import { prepareRunEnvelope } from './run.mjs';
import {
  completeDurableCapabilityExecution,
  completeDurableConnectedTransactionExecution,
  completeDurableOperationPlanExecution,
  completeDurableProviderProbeExecution,
  failDurableHostExecution,
  getDurableHostExecution,
  getDurableProviderProbeObservation,
  listDurableHostExecutions,
  prepareDurableConnectedTransactionExecution,
  prepareDurableConnectedTransactionReconciliation,
  prepareDurableProviderProbeExecution
} from './service.mjs';
import {
  beginProposalConnectedApprovalRequest,
  confirmProposalConnectedApprovalRequest
} from './operator-authority.mjs';
import { createProposalConnectedBatch } from './proposal-connected-batches.mjs';
import { inspectConnectedApprovalReviewMaterial } from './connected-approval-review.mjs';
import { inspectConnectedOperatorActivity } from './operator-inspection.mjs';
import {
  inspectPreparedAutomationDerivedReviewMaterial,
  inspectPreparedAutomationReviewMaterial,
  inspectPreparedAutomationWork,
  prepareAutomationRun
} from './prepared-work.mjs';
import {
  finalizeDeclaredAutomationAcquisition,
  inspectDeclaredAutomationAcquisitionPrivate,
  inspectDeclaredAutomationAcquisitionPublic,
  prepareDeclaredAutomationAcquisition,
  recoverDeclaredAutomationAcquisition
} from './connected-acquisitions.mjs';
import {
  createReviewOnlyCandidateSelection,
  inspectReviewOnlyCandidateSelectionMaterial
} from './review-only-candidate-selections.mjs';
import {
  createReviewOnlyCandidatePreview,
  inspectReviewOnlyCandidatePreview
} from './review-only-candidate-previews.mjs';
import {
  beginConfigurationChangeRequest,
  confirmConfigurationChangeRequest,
  executeConfigurationChange,
  inspectConfigurationChange,
  prepareConfigurationChange,
  prepareConfigurationChangeExecution,
  recoverConfigurationChange
} from './configuration-transactions.mjs';
import {
  beginHostRealizationRequest,
  confirmHostRealizationRequest,
  executeHostRealization,
  inspectHostRealization,
  prepareHostRealization,
  prepareHostRealizationExecution,
  recoverHostRealization
} from './host-realizations.mjs';
import {
  beginPackInstallRequest,
  confirmPackInstallRequest,
  executePackInstall,
  inspectPackInstall,
  preparePackInstall,
  preparePackInstallExecution,
  recoverPackInstall
} from './pack-installs.mjs';
import {
  buildDevelopmentEvaluationInvocation,
  inspectDevelopmentRun,
  prepareDevelopmentRequest,
  recordHostDevelopmentResult,
  recordDevelopmentResult
} from './development-runs.mjs';
import { materializeDevelopmentCandidateLock } from './development-candidate-locks.mjs';
import {
  finalizeDevelopmentHostEvaluation,
  runDevelopmentHostEvaluation,
  runDevelopmentHostJudgment
} from './development-host-runner.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(name + ' requires a value.');
  }
  return args[index + 1];
}

function options(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    if (!args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error(name + ' requires a value.');
    }
    values.push(args[index + 1]);
  }
  return values;
}

function requiredOption(args, name) {
  const value = option(args, name);
  if (!value) throw new Error('Missing required option ' + name + '.');
  return value;
}

function assertExactCommandArguments(args, {
  valueOptions = [],
  flagOptions = [],
  repeatableValueOptions = []
}) {
  const repeatableValues = new Set(repeatableValueOptions);
  const allowedValues = new Set(['--root', ...valueOptions, ...repeatableValues]);
  const allowedFlags = new Set(['--json', ...flagOptions]);
  const observed = new Set();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (allowedFlags.has(argument)) {
      if (observed.has(argument)) throw new Error('Duplicate option ' + argument + '.');
      observed.add(argument);
      continue;
    }
    if (allowedValues.has(argument)) {
      if (observed.has(argument) && !repeatableValues.has(argument)) {
        throw new Error('Duplicate option ' + argument + '.');
      }
      observed.add(argument);
      if (!args[index + 1] || args[index + 1].startsWith('--')) {
        throw new Error(argument + ' requires a value.');
      }
      index += 1;
      continue;
    }
    throw new Error('Unexpected argument for ' + args[0] + ': ' + argument + '.');
  }
}

const DEVELOPMENT_HOST_RESULT_EFFECT_FLAGS = Object.freeze([
  ['--local-workspace-read', 'local-workspace-read'],
  ['--local-workspace-write', 'local-workspace-write'],
  ['--local-command', 'local-command'],
  ['--subagent-dispatch', 'subagent-dispatch']
]);
const DEVELOPMENT_REQUEST_ID_RE =
  /^development-request[.][a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const DEVELOPMENT_INSTANT_RE =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{3})?Z$/;

function invalidDevelopmentHostResultInput() {
  throw new Error('development-host-result-record input is invalid.');
}

function parseDevelopmentHostResultArguments(args) {
  const valueOptions = new Set([
    '--request-id',
    '--state',
    '--check',
    '--at',
    ...DEVELOPMENT_HOST_RESULT_EFFECT_FLAGS.map(([flag]) => flag)
  ]);
  const singleton = new Map();
  const checks = [];
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      if (json) invalidDevelopmentHostResultInput();
      json = true;
      continue;
    }
    if (!valueOptions.has(argument)
      || !args[index + 1]
      || args[index + 1].startsWith('--')) {
      invalidDevelopmentHostResultInput();
    }
    const value = args[index + 1];
    index += 1;
    if (argument === '--check') {
      checks.push(value);
      if (checks.length > 500) invalidDevelopmentHostResultInput();
      continue;
    }
    if (singleton.has(argument)) invalidDevelopmentHostResultInput();
    singleton.set(argument, value);
  }

  const requestId = singleton.get('--request-id');
  const state = singleton.get('--state');
  if (!DEVELOPMENT_REQUEST_ID_RE.test(requestId || '')
    || !['passed', 'failed', 'blocked', 'partial'].includes(state)
    || DEVELOPMENT_HOST_RESULT_EFFECT_FLAGS.some(([flag]) => !singleton.has(flag))) {
    invalidDevelopmentHostResultInput();
  }

  const seenChecks = new Set();
  const parsedChecks = checks.map((value) => {
    const match = /^([a-z0-9]+(?:[.-][a-z0-9]+)*)=(passed|failed|blocked|unknown)$/.exec(value);
    if (!match || seenChecks.has(match[1])) invalidDevelopmentHostResultInput();
    seenChecks.add(match[1]);
    return { id: match[1], state: match[2] };
  });
  if (state === 'passed'
    && (parsedChecks.length === 0
      || parsedChecks.some((check) => check.state !== 'passed'))) {
    invalidDevelopmentHostResultInput();
  }

  const localEffects = DEVELOPMENT_HOST_RESULT_EFFECT_FLAGS.map(([flag, category]) => {
    const value = singleton.get(flag);
    const match = /^(observed|not-observed|blocked|unknown):([0-9]+)$/.exec(value || '');
    if (!match) invalidDevelopmentHostResultInput();
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count)
      || (match[1] === 'observed' ? count < 1 : count !== 0)) {
      invalidDevelopmentHostResultInput();
    }
    return { category, state: match[1], count };
  });

  const at = singleton.get('--at') || null;
  if (at !== null) {
    const canonical = at.includes('.') ? at : at.replace(/Z$/, '.000Z');
    if (!DEVELOPMENT_INSTANT_RE.test(at)
      || !Number.isFinite(Date.parse(at))
      || new Date(at).toISOString() !== canonical) {
      invalidDevelopmentHostResultInput();
    }
  }
  return { requestId, state, checks: parsedChecks, localEffects, at, json };
}

function nowIdPart(createdAt) {
  return createdAt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function writeEvidence(root, directory, records) {
  if (!directory) return;
  const targetDirectory = resolveRepoPath(root, directory);
  for (const record of records) {
    writeJson(path.join(targetDirectory, record.id + '.json'), record);
  }
}

function readDocumentInput(root, requestedPath) {
  return path.isAbsolute(requestedPath)
    ? readPrivateJsonInput(root, requestedPath)
    : readJson(resolveRepoPath(root, requestedPath));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const root = path.resolve(option(args, '--root', defaultRoot));
  const json = args.includes('--json');
  const createdAt = option(args, '--at', new Date().toISOString());
  const idPart = nowIdPart(createdAt);

  if (command === 'resolve') {
    const configPath = option(args, '--config');
    const host = option(args, '--host');
    const lock = resolveConfiguration({ root, configPath, host });
    const output = option(args, '--output');
    if (output) writeJson(resolveRepoPath(root, output), lock);
    if (json) {
      print(lock);
    } else {
      process.stdout.write(
        'Resolved ' + lock.configuration.name + ' for ' + lock.host.id
          + ' to ' + lock.packs.length + ' packs.\n'
          + 'Lock: ' + fingerprintLock(lock) + '\n'
          + (output ? 'Wrote: ' + output + '\n' : '')
      );
    }
    return;
  }

  if (command === 'config-inspect') {
    const configPath = option(args, '--config');
    const host = option(args, '--host');
    const lockPath = option(args, '--lock');
    if (lockPath && (configPath || host)) {
      throw new Error('config-inspect accepts either --lock or configuration/host selection, not both.');
    }
    let lock;
    let basis;
    if (lockPath) {
      lock = readJson(resolveRepoPath(root, lockPath));
      const exact = lockMatchesResolution({ lock, root });
      if (!exact.matches) {
        throw new Error(
          'Configuration lock is stale: expected ' + fingerprintLock(exact.expected)
            + ' but observed ' + fingerprintLock(lock) + '.'
        );
      }
      basis = 'lock';
    } else {
      lock = resolveConfiguration({ root, configPath, host });
      basis = 'configuration';
    }
    const view = buildConfigurationView({ root, lock, basis });
    const output = option(args, '--output');
    if (output) writeJson(resolveRepoPath(root, output), view);
    if (json) {
      print(view);
    } else {
      process.stdout.write(formatConfigurationView(view));
      if (output) process.stdout.write('Wrote: ' + output + '\n');
    }
    return;
  }

  if (command === 'configuration-change-plan') {
    const name = requiredOption(args, '--configuration');
    const planId = option(args, '--plan-id', 'configuration-change-plan.' + name + '.' + idPart);
    const candidateConfiguration = readPrivateJsonInput(root, requiredOption(args, '--candidate'));
    prepareConfigurationChange({
      root,
      name,
      candidateConfiguration,
      id: planId,
      createdAt
    });
    const inspection = inspectConfigurationChange({ root, planId, at: createdAt });
    if (json) {
      print(inspection);
    } else {
      process.stdout.write(
        'Prepared exact private configuration plan ' + planId + '.\n'
          + 'Candidate lock: ' + inspection.configuration.candidateLockFingerprint + '\n'
          + 'Changed subjects: ' + inspection.scope.changes.length + '\n'
          + 'Execution authority created: no\n'
      );
    }
    return;
  }

  if (command === 'configuration-change-request') {
    const planId = requiredOption(args, '--plan-id');
    const requestId = option(args, '--request-id', 'configuration-change-request.' + idPart);
    beginConfigurationChangeRequest({
      root,
      planId,
      id: requestId,
      reason: requiredOption(args, '--reason'),
      createdAt,
      expiresAt: requiredOption(args, '--expires-at')
    });
    const inspection = inspectConfigurationChange({ root, planId, requestId, at: createdAt });
    if (json) print(inspection);
    else process.stdout.write(
      'Requested exact configuration confirmation ' + requestId + '.\n'
        + 'Expires: ' + inspection.request.expiresAt + '\n'
        + 'Execution authority created: no\n'
    );
    return;
  }

  if (command === 'configuration-change-confirm') {
    const requestId = requiredOption(args, '--request-id');
    const confirmationId = option(args, '--confirmation-id', 'configuration-change-confirmation.' + idPart);
    const result = confirmConfigurationChangeRequest({
      root,
      requestId,
      id: confirmationId,
      actor: { type: 'local-operator', id: requiredOption(args, '--actor') },
      reason: requiredOption(args, '--reason'),
      confirmedAt: createdAt
    });
    const planId = result.confirmation.plan.id;
    const inspection = inspectConfigurationChange({
      root,
      planId,
      requestId,
      confirmationId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Confirmed exact configuration request as ' + confirmationId + '.\n'
        + 'One-time start consumed: no\n'
        + 'Desired configuration changed: no\n'
    );
    return;
  }

  if (command === 'configuration-change-start') {
    const confirmationId = requiredOption(args, '--confirmation-id');
    const checkpointId = option(args, '--checkpoint-id', 'checkpoint.configuration.' + idPart);
    const result = prepareConfigurationChangeExecution({
      root,
      confirmationId,
      checkpointId,
      at: createdAt
    });
    const inspection = inspectConfigurationChange({
      root,
      planId: result.checkpoint.plan.id,
      requestId: result.checkpoint.request.id,
      confirmationId,
      consumptionId: result.consumption.id,
      checkpointId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Consumed exact confirmation into checkpoint ' + checkpointId + '.\n'
        + 'Checkpoint state: ' + inspection.checkpoint.state + '\n'
        + 'Desired configuration changed: no\n'
    );
    return;
  }

  if (command === 'configuration-change-execute' || command === 'configuration-change-recover') {
    const checkpointId = requiredOption(args, '--checkpoint-id');
    const checkpoint = command === 'configuration-change-execute'
      ? executeConfigurationChange({ root, checkpointId, at: createdAt })
      : recoverConfigurationChange({ root, checkpointId, at: createdAt });
    const inspection = inspectConfigurationChange({
      root,
      planId: checkpoint.plan.id,
      requestId: checkpoint.request.id,
      confirmationId: checkpoint.confirmation.id,
      consumptionId: checkpoint.consumption.id,
      checkpointId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Configuration checkpoint ' + checkpointId + ' is ' + checkpoint.state + '.\n'
        + 'Phase: ' + checkpoint.phase + '\n'
        + 'Provider calls executed: 0\n'
    );
    if (checkpoint.state === 'needs-attention') process.exitCode = 1;
    return;
  }

  if (command === 'configuration-change-inspect') {
    const inspection = inspectConfigurationChange({
      root,
      planId: requiredOption(args, '--plan-id'),
      requestId: option(args, '--request-id'),
      confirmationId: option(args, '--confirmation-id'),
      consumptionId: option(args, '--consumption-id'),
      checkpointId: option(args, '--checkpoint-id'),
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Configuration plan ' + inspection.plan.id + ' is ' + inspection.configuration.applicability + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Inspection authority: none\n'
    );
    return;
  }

  if (command === 'host-realization-plan') {
    const configurationName = requiredOption(args, '--configuration');
    const planId = option(args, '--plan-id', 'host-realization-plan.' + configurationName + '.' + idPart);
    prepareHostRealization({
      root,
      configurationName,
      id: planId,
      createdAt,
      validUntil: requiredOption(args, '--valid-until')
    });
    const inspection = inspectHostRealization({ root, planId, at: createdAt });
    if (json) print(inspection);
    else process.stdout.write(
      'Prepared exact private host realization plan ' + planId + '.\n'
        + 'Target fingerprint: ' + inspection.target.fingerprint + '\n'
        + 'Managed file effects: ' + inspection.scope.outputs.length + '\n'
        + 'Execution authority created: no\n'
    );
    return;
  }

  if (command === 'host-realization-request') {
    const planId = requiredOption(args, '--plan-id');
    const requestId = option(args, '--request-id', 'host-realization-request.' + idPart);
    beginHostRealizationRequest({
      root,
      planId,
      id: requestId,
      reason: requiredOption(args, '--reason'),
      createdAt,
      expiresAt: requiredOption(args, '--expires-at')
    });
    const inspection = inspectHostRealization({ root, planId, requestId, at: createdAt });
    if (json) print(inspection);
    else process.stdout.write(
      'Requested exact host realization confirmation ' + requestId + '.\n'
        + 'One-time start consumed: no\n'
    );
    return;
  }

  if (command === 'host-realization-confirm') {
    const requestId = requiredOption(args, '--request-id');
    const confirmationId = option(args, '--confirmation-id', 'host-realization-confirmation.' + idPart);
    const result = confirmHostRealizationRequest({
      root,
      requestId,
      id: confirmationId,
      actor: { type: 'local-operator', id: requiredOption(args, '--actor') },
      reason: requiredOption(args, '--reason'),
      confirmedAt: createdAt
    });
    const inspection = inspectHostRealization({
      root,
      planId: result.confirmation.plan.id,
      requestId,
      confirmationId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Confirmed exact host realization request as ' + confirmationId + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Host files changed: no\n'
    );
    return;
  }

  if (command === 'host-realization-start') {
    const confirmationId = requiredOption(args, '--confirmation-id');
    const checkpointId = option(args, '--checkpoint-id', 'checkpoint.host-realization.' + idPart);
    const result = prepareHostRealizationExecution({
      root,
      confirmationId,
      checkpointId,
      at: createdAt
    });
    const inspection = inspectHostRealization({
      root,
      planId: result.checkpoint.plan.id,
      requestId: result.checkpoint.request.id,
      confirmationId,
      consumptionId: result.consumption.id,
      checkpointId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Consumed exact host confirmation into checkpoint ' + checkpointId + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Host files changed: no\n'
    );
    return;
  }

  if (command === 'host-realization-execute' || command === 'host-realization-recover') {
    const checkpointId = requiredOption(args, '--checkpoint-id');
    const checkpoint = command === 'host-realization-execute'
      ? executeHostRealization({ root, checkpointId, at: createdAt })
      : recoverHostRealization({ root, checkpointId, at: createdAt });
    const inspection = inspectHostRealization({
      root,
      planId: checkpoint.plan.id,
      requestId: checkpoint.request.id,
      confirmationId: checkpoint.confirmation.id,
      consumptionId: checkpoint.consumption.id,
      checkpointId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Host realization checkpoint ' + checkpointId + ' is ' + checkpoint.state + '.\n'
        + 'Local projection claim: ' + inspection.claims.localProjection + '\n'
        + 'Host launch claim: ' + inspection.claims.hostLaunch + '\n'
        + 'Provider calls executed: 0\n'
    );
    if (checkpoint.state === 'needs-attention') process.exitCode = 1;
    return;
  }

  if (command === 'host-realization-inspect') {
    const inspection = inspectHostRealization({
      root,
      planId: requiredOption(args, '--plan-id'),
      requestId: option(args, '--request-id'),
      confirmationId: option(args, '--confirmation-id'),
      consumptionId: option(args, '--consumption-id'),
      checkpointId: option(args, '--checkpoint-id'),
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Host realization plan ' + inspection.plan.id + ' is ' + inspection.plan.applicability + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Inspection authority: none\n'
    );
    return;
  }

  if (command === 'pack-install-plan') {
    const targetRoot = requiredOption(args, '--target');
    const planId = option(args, '--plan-id', 'pack-install-plan.' + idPart);
    const inspection = preparePackInstall({
      sourceRoot: root,
      targetRoot,
      capsulePaths: options(args, '--capsule'),
      bundlePath: option(args, '--bundle'),
      baseContract: option(args, '--base-contract', '1.0.0'),
      planId,
      createdAt,
      validUntil: requiredOption(args, '--valid-until')
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Prepared exact private local pack install plan ' + planId + '.\n'
        + 'Target fingerprint: ' + inspection.plan.targetFingerprint + '\n'
        + 'Verified releases: ' + inspection.plan.releases.length + '\n'
        + 'Managed file effects: ' + inspection.plan.effects.length + '\n'
        + 'Execution authority created: no\n'
    );
    return;
  }

  if (command === 'pack-install-request') {
    const targetRoot = requiredOption(args, '--target');
    const planId = requiredOption(args, '--plan-id');
    const requestId = option(args, '--request-id', 'pack-install-request.' + idPart);
    const inspection = beginPackInstallRequest({
      sourceRoot: root,
      targetRoot,
      planId,
      requestId,
      reason: requiredOption(args, '--reason'),
      createdAt,
      expiresAt: requiredOption(args, '--expires-at')
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Requested exact local pack install confirmation ' + requestId + '.\n'
        + 'One-time start consumed: no\n'
    );
    return;
  }

  if (command === 'pack-install-confirm') {
    const targetRoot = requiredOption(args, '--target');
    const confirmationId = option(args, '--confirmation-id', 'pack-install-confirmation.' + idPart);
    const inspection = confirmPackInstallRequest({
      sourceRoot: root,
      targetRoot,
      requestId: requiredOption(args, '--request-id'),
      confirmationId,
      actor: requiredOption(args, '--actor'),
      reason: requiredOption(args, '--reason'),
      confirmedAt: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Confirmed exact local pack install request as ' + confirmationId + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Managed files changed: no\n'
    );
    return;
  }

  if (command === 'pack-install-start') {
    const checkpointId = option(args, '--checkpoint-id', 'checkpoint.pack-install.' + idPart);
    const inspection = preparePackInstallExecution({
      sourceRoot: root,
      targetRoot: requiredOption(args, '--target'),
      confirmationId: requiredOption(args, '--confirmation-id'),
      checkpointId,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Consumed exact pack install confirmation into checkpoint ' + checkpointId + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Managed files changed: no\n'
    );
    return;
  }

  if (command === 'pack-install-execute' || command === 'pack-install-recover') {
    const targetRoot = requiredOption(args, '--target');
    const checkpointId = requiredOption(args, '--checkpoint-id');
    const inspection = command === 'pack-install-execute'
      ? executePackInstall({ sourceRoot: root, targetRoot, checkpointId, at: createdAt })
      : recoverPackInstall({ sourceRoot: root, targetRoot, checkpointId, at: createdAt });
    if (json) print(inspection);
    else process.stdout.write(
      'Local pack install checkpoint ' + checkpointId + ' is ' + inspection.checkpoint.state + '.\n'
        + 'Local materialization claim: ' + inspection.claims.localMaterialization + '\n'
        + 'Installed registry claim: ' + inspection.claims.installedRegistry + '\n'
        + 'Network and package-manager effects executed: 0\n'
    );
    if (inspection.checkpoint.state === 'needs-attention') process.exitCode = 1;
    return;
  }

  if (command === 'pack-install-inspect') {
    const references = {
      planId: option(args, '--plan-id'),
      requestId: option(args, '--request-id'),
      confirmationId: option(args, '--confirmation-id'),
      consumptionId: option(args, '--consumption-id'),
      checkpointId: option(args, '--checkpoint-id')
    };
    if (!Object.values(references).some(Boolean)) {
      throw new Error('pack-install-inspect requires at least one exact transaction identifier.');
    }
    const inspection = inspectPackInstall({
      sourceRoot: root,
      targetRoot: requiredOption(args, '--target'),
      ...references,
      at: createdAt
    });
    if (json) print(inspection);
    else process.stdout.write(
      'Local pack install plan ' + inspection.plan.id + '.\n'
        + 'Next action: ' + inspection.resume.permittedNextAction + '\n'
        + 'Inspection authority: none\n'
    );
    return;
  }

  if (command === 'prepare') {
    const lockPath = requiredOption(args, '--lock');
    const lock = readJson(resolveRepoPath(root, lockPath));
    const scenarioPath = option(args, '--scenario');
    const runId = option(args, '--run-id', 'run.' + lock.configuration.name + '.' + idPart);
    const resolutionEvidenceId = option(
      args,
      '--resolution-evidence-id',
      'evidence.' + lock.configuration.name + '.resolution.' + idPart
    );
    const preparationEvidenceId = option(
      args,
      '--preparation-evidence-id',
      'evidence.' + lock.configuration.name + '.preparation.' + idPart
    );
    const envelope = prepareRunEnvelope({
      root,
      lock,
      lockPath,
      scenarioPath,
      automationId: option(args, '--automation'),
      runId,
      createdAt,
      requestedOutcome: option(args, '--outcome'),
      evidenceIds: [resolutionEvidenceId, preparationEvidenceId]
    });
    const evidence = [
      createResolutionEvidence({ lock, id: resolutionEvidenceId, createdAt }),
      createRunPreparationEvidence({
        lock,
        envelope,
        id: preparationEvidenceId,
        createdAt
      })
    ];
    const output = option(args, '--output');
    if (output) writeJson(resolveRepoPath(root, output), envelope);
    writeEvidence(root, option(args, '--evidence-dir'), evidence);
    if (json) {
      print({ envelope, evidence });
    } else {
      process.stdout.write(
        'Prepared ' + envelope.id + ' at lifecycle state ' + envelope.lifecycleState + '.\n'
          + 'External effects executed: 0\n'
          + (output ? 'Wrote: ' + output + '\n' : '')
      );
    }
    return;
  }

  if (command === 'doctor') {
    const lockPath = requiredOption(args, '--lock');
    const lock = readJson(resolveRepoPath(root, lockPath));
    const level = option(args, '--level', 'offline');
    if (!['offline', 'connected'].includes(level)) {
      throw new Error('doctor --level must be offline or connected; canary execution is not implemented.');
    }
    const evidenceId = option(
      args,
      '--evidence-id',
      'evidence.' + lock.configuration.name + '.doctor.' + idPart
    );
    const doctorOptions = {
      root,
      configPath: option(args, '--config'),
      lock,
      doctorId: option(args, '--doctor-id', 'doctor.' + lock.configuration.name + '.' + idPart),
      evidenceId,
      createdAt
    };
    const checkpointObservations = level === 'connected'
      ? options(args, '--probe-checkpoint').map((checkpointId) => {
        return getDurableProviderProbeObservation({ root, checkpointId });
      })
      : [];
    const result = level === 'connected'
      ? runConnectedDoctor({
        ...doctorOptions,
        providerProbes: [
          ...options(args, '--probe').map((probePath) => {
            return readJson(resolveRepoPath(root, probePath));
          }),
          ...checkpointObservations.filter((observation) => {
            return observation.$contract === 'soter://contracts/provider-probe/v2';
          })
        ],
        providerProbeAttempts: checkpointObservations.filter((observation) => {
          return observation.$contract === 'soter://contracts/provider-probe-attempt/v1';
        })
      })
      : runOfflineDoctor(doctorOptions);
    const output = option(args, '--output');
    if (output) writeJson(resolveRepoPath(root, output), result.report);
    writeEvidence(root, option(args, '--evidence-dir'), result.evidence);
    if (json) {
      print(result.report);
    } else {
      process.stdout.write(formatDoctorReport(result.report) + '\n');
      if (output) process.stdout.write('Wrote: ' + output + '\n');
    }
    if (result.report.states.valid === 'failed' || result.report.states.valid === 'stale') {
      process.exitCode = 1;
    }
    if (level === 'connected' && result.report.states.ready !== 'passed') {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'probe-prepare') {
    if (option(args, '--output')) {
      throw new Error(
        'Provider probe checkpoints are private runtime state and cannot be exported.'
      );
    }
    const lockPath = requiredOption(args, '--lock');
    const providerImplementation = requiredOption(args, '--provider');
    const prepared = await prepareDurableProviderProbeExecution({
      root,
      configurationBasis: requiredOption(args, '--configuration-basis'),
      lockPath,
      providerImplementation,
      probeId: option(args, '--probe-id'),
      at: createdAt,
      validForSeconds: Number(option(args, '--valid-for-seconds', '300'))
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared ' + prepared.checkpoint.id + ' in state ' + prepared.checkpoint.state + '.\n'
          + 'Provider operation: ' + call.transport.server + '/'
          + (call.transport.operation || 'none') + '\n'
          + 'Native host tool: ' + (call.transport.tool || 'none') + '\n'
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Raw provider response persistence: disabled by Core\n'
      );
    }
    if (prepared.checkpoint.state !== 'requested') process.exitCode = 1;
    return;
  }

  if (command === 'probe-complete') {
    if (option(args, '--checkpoint-output') || option(args, '--probe-output')) {
      throw new Error(
        'Provider probe checkpoints and results are private runtime state and cannot be exported.'
      );
    }
    const response = readPrivateJsonInput(root, requiredOption(args, '--response'));
    const completed = await completeDurableProviderProbeExecution({
      root,
      checkpointId: requiredOption(args, '--checkpoint'),
      callId: requiredOption(args, '--call'),
      response,
      at: createdAt
    });
    if (json) {
      print(completed);
    } else {
      const nextCall = completed.currentCall;
      process.stdout.write(
        'Advanced ' + completed.checkpoint.id + ' to state '
          + completed.checkpoint.state + '.\n'
          + 'Raw provider response persisted by Core: no\n'
          + (nextCall
            ? 'Next provider operation: ' + nextCall.transport.server + '/'
              + nextCall.transport.operation + '\n'
              + 'Next native host tool: ' + nextCall.transport.tool + '\n'
              + 'Next call ID: ' + nextCall.id + '\n'
            : '')
          + (completed.checkpoint.result
            ? 'Probe: ' + completed.checkpoint.result.id + '; capability compatibility remains '
              + completed.checkpoint.result.capabilities.map((item) => item.state).join(', ') + '.\n'
            : '')
      );
    }
    if (completed.checkpoint.state === 'failed') process.exitCode = 1;
    return;
  }

  if (command === 'capability-complete') {
    if (option(args, '--checkpoint-output') || option(args, '--output')) {
      throw new Error(
        'Capability checkpoints and normalized results are private runtime state and cannot be exported.'
      );
    }
    const completed = await completeDurableCapabilityExecution({
      root,
      checkpointId: requiredOption(args, '--checkpoint'),
      callId: option(args, '--call'),
      response: readPrivateJsonInput(root, requiredOption(args, '--response')),
      at: createdAt
    });
    if (json) {
      print(completed);
    } else {
      process.stdout.write(
        'Advanced ' + completed.checkpoint.id + ' to state '
          + completed.checkpoint.state + '.\n'
          + 'Raw provider response persisted by Core: no\n'
          + (completed.checkpoint.state === 'requested'
            ? 'Next exact call ID: ' + completed.checkpoint.call.id + '\n'
              + 'Next provider operation: ' + completed.checkpoint.call.transport.server + '/'
              + completed.checkpoint.call.transport.operation + '\n'
            : '')
      );
    }
    if (!['requested', 'completed'].includes(completed.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'plan-complete') {
    if (option(args, '--output')) {
      throw new Error(
        'Operation plan checkpoints are private runtime state and cannot be exported into the repository.'
      );
    }
    const completed = await completeDurableOperationPlanExecution({
      root,
      checkpointId: requiredOption(args, '--checkpoint'),
      callId: requiredOption(args, '--call'),
      response: readPrivateJsonInput(root, requiredOption(args, '--response')),
      at: createdAt
    });
    if (json) {
      print(completed);
    } else {
      const call = completed.currentCall;
      process.stdout.write(
        'Advanced operation plan ' + completed.checkpoint.plan.id + ' to state '
          + completed.checkpoint.state + '.\n'
          + 'Current step: ' + (completed.checkpoint.currentStepId || 'none') + '\n'
          + (call
            ? 'Next provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Next native host tool: ' + call.transport.tool + '\n'
              + 'Next exact call ID: ' + call.id + '\n'
            : 'Next host request emitted: no\n')
          + 'Raw provider response persisted by Core: no\n'
      );
    }
    if (!['requested', 'completed'].includes(completed.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'connected-transaction-prepare') {
    if (option(args, '--output')) {
      throw new Error(
        'Connected transaction checkpoints are private runtime state and cannot be exported into the repository.'
      );
    }
    const prepared = await prepareDurableConnectedTransactionExecution({
      root,
      approvalId: requiredOption(args, '--approval-id'),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared connected transaction ' + prepared.checkpoint.batch.id + ' in state '
          + prepared.checkpoint.state + '.\n'
          + 'Approval: ' + prepared.checkpoint.approval.id + ' (exact batch fingerprint matched)\n'
          + (call
            ? 'Provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Native host tool: ' + call.transport.tool + '\n'
              + 'Exact call ID: ' + call.id + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Raw provider response persistence: disabled by Core\n'
      );
    }
    if (prepared.checkpoint.state !== 'requested') process.exitCode = 1;
    return;
  }

  if (command === 'connected-approval-request') {
    const batch = readDocumentInput(root, requiredOption(args, '--batch'));
    const changeSet = readDocumentInput(root, requiredOption(args, '--change-set'));
    const begun = await beginProposalConnectedApprovalRequest({
      root,
      configurationBasis: requiredOption(args, '--configuration-basis'),
      lockPath: requiredOption(args, '--lock'),
      runPath: requiredOption(args, '--run'),
      batch,
      changeSet,
      id: requiredOption(args, '--request-id'),
      reason: requiredOption(args, '--reason'),
      createdAt,
      expiresAt: requiredOption(args, '--expires-at')
    });
    const result = {
      request: {
        id: begun.request.id,
        fingerprint: begun.request.requestFingerprint,
        requestedAt: begun.request.createdAt,
        expiresAt: begun.request.expiresAt,
        batchId: begun.request.batch.id,
        changeSetId: begun.request.changeSet.id
      },
      requestPath: begun.requestPath
    };
    if (json) print(result);
    else process.stdout.write(
      'Prepared exact connected approval request ' + begun.request.id + '.\n'
        + 'Expires: ' + begun.request.expiresAt + '\n'
        + 'Writes executed: 0\n'
    );
    return;
  }

  if (command === 'connected-approval-confirm') {
    const requestId = requiredOption(args, '--request-id');
    const confirmed = await confirmProposalConnectedApprovalRequest({
      root,
      requestId,
      approvalId: requiredOption(args, '--approval-id'),
      actor: requiredOption(args, '--actor'),
      reason: requiredOption(args, '--reason'),
      confirmedAt: createdAt
    });
    const result = {
      approval: {
        id: confirmed.approval.id,
        requestId: confirmed.approval.request.id,
        confirmedAt: confirmed.approval.createdAt,
        expiresAt: confirmed.approval.expiresAt,
        actor: confirmed.approval.actor,
        scope: confirmed.approval.scope
      },
      approvalPath: confirmed.approvalPath
    };
    if (json) print(result);
    else process.stdout.write(
      'Confirmed exact connected approval request '
        + confirmed.approval.request.id + '.\n'
        + 'Approval: ' + confirmed.approval.id + '\n'
        + 'Expires: ' + confirmed.approval.expiresAt + '\n'
        + 'Writes executed: 0\n'
    );
    return;
  }

  if (command === 'operator-inspect') {
    const requestId = option(args, '--request-id');
    const approvalId = option(args, '--approval-id');
    const checkpointId = option(args, '--checkpoint');
    if (!requestId && !approvalId && !checkpointId) {
      throw new Error('operator-inspect requires --request-id, --approval-id, or --checkpoint.');
    }
    const inspection = inspectConnectedOperatorActivity({
      root,
      requestId,
      approvalId,
      checkpointId,
      observedAt: createdAt
    });
    print(inspection);
    return;
  }

  if (command === 'operator-approval-review') {
    const material = inspectConnectedApprovalReviewMaterial({
      root,
      requestId: requiredOption(args, '--request-id')
    });
    print(material);
    return;
  }

  if (command === 'operator-prepare') {
    const work = await prepareAutomationRun({
      root,
      automationId: requiredOption(args, '--automation'),
      configurationName: requiredOption(args, '--configuration'),
      configurationBasis: requiredOption(args, '--configuration-basis'),
      preparationMode: option(args, '--preparation-mode', 'contained'),
      expectedHost: option(args, '--host'),
      input: readPrivateJsonInput(root, requiredOption(args, '--input')),
      createdAt
    });
    if (json) {
      print(work);
    } else {
      process.stdout.write(
        'Prepared private operator work ' + work.id + ' at state ' + work.state + '.\n'
          + 'Configuration basis: ' + work.configuration.configurationBasis + '\n'
          + 'Preparation mode: ' + (work.preparationMode || 'contained') + '\n'
          + 'Configuration applicability: ' + work.configuration.applicability + '\n'
          + 'External writes performed: no\n'
          + 'Approval requested: no\n'
      );
    }
    return;
  }

  if (command === 'operator-prepared-inspect') {
    const work = inspectPreparedAutomationWork({
      root,
      workId: requiredOption(args, '--work-id')
    });
    print(work);
    return;
  }

  if (command === 'operator-prepared-review') {
    const material = inspectPreparedAutomationReviewMaterial({
      root,
      workId: requiredOption(args, '--work-id')
    });
    print(material);
    return;
  }

  if (command === 'operator-prepared-derived-review') {
    const material = inspectPreparedAutomationDerivedReviewMaterial({
      root,
      workId: requiredOption(args, '--work-id')
    });
    print(material);
    return;
  }

  if (command === 'operator-acquisition-prepare') {
    assertExactCommandArguments(args, {
      valueOptions: ['--automation', '--work', '--host', '--at']
    });
    const prepared = await prepareDeclaredAutomationAcquisition({
      root,
      automationId: requiredOption(args, '--automation'),
      workId: requiredOption(args, '--work'),
      expectedHost: option(args, '--host'),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared declared connected acquisition ' + prepared.checkpoint.plan.id
          + ' in state ' + prepared.checkpoint.state + '.\n'
          + 'Current source: ' + (prepared.checkpoint.currentStepId || 'none') + '\n'
          + (call
            ? 'Native host tool: ' + call.transport.tool + '\n'
              + 'Exact call ID: ' + call.id + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Provider calls performed by Core: 0\n'
          + 'Approval, continuation, retry, or write authority granted: no\n'
      );
    }
    return;
  }

  if (command === 'operator-acquisition-recover') {
    assertExactCommandArguments(args, {
      valueOptions: [
        '--automation',
        '--work',
        '--checkpoint',
        '--checkpoint-fingerprint',
        '--step',
        '--call',
        '--call-fingerprint',
        '--host',
        '--at'
      ]
    });
    const recovered = await recoverDeclaredAutomationAcquisition({
      root,
      automationId: requiredOption(args, '--automation'),
      workId: requiredOption(args, '--work'),
      checkpointId: requiredOption(args, '--checkpoint'),
      checkpointFingerprint: requiredOption(args, '--checkpoint-fingerprint'),
      stepId: requiredOption(args, '--step'),
      callId: requiredOption(args, '--call'),
      callFingerprint: requiredOption(args, '--call-fingerprint'),
      expectedHost: option(args, '--host'),
      at: createdAt
    });
    if (json) {
      print(recovered);
    } else {
      if (!recovered.currentCall
        || recovered.currentCall.id !== recovered.recovery.replacementCallId) {
        throw new Error(
          'Connected-acquisition recovery did not return its exact pending replacement call.'
        );
      }
      process.stdout.write(
        'Recovered one exact failed read-only acquisition attempt.\n'
          + 'Recovery locator: ' + recovered.recovery.id + '\n'
          + 'Replacement attempt: ' + recovered.recovery.attempt + ' of '
          + recovered.recovery.retry.maxAttempts + '\n'
          + 'Exact call ID: ' + recovered.currentCall.id + '\n'
          + 'Provider calls performed by Core: 0\n'
          + 'Approval, reusable retry, or write authority granted: no\n'
      );
    }
    return;
  }

  if (command === 'operator-acquisition-finalize') {
    assertExactCommandArguments(args, {
      valueOptions: ['--automation', '--work', '--checkpoint', '--host']
    });
    const finalized = await finalizeDeclaredAutomationAcquisition({
      root,
      automationId: requiredOption(args, '--automation'),
      workId: requiredOption(args, '--work'),
      checkpointId: requiredOption(args, '--checkpoint'),
      expectedHost: option(args, '--host')
    });
    if (json) {
      print(finalized);
    } else {
      process.stdout.write(
        'Finalized the exact pack-declared connected acquisition.\n'
          + 'Provider calls performed by Core: 0\n'
          + 'Approval, continuation, retry, or write authority granted: no\n'
      );
    }
    return;
  }

  if (command === 'operator-acquisition-inspect'
    || command === 'operator-acquisition-private-inspect') {
    assertExactCommandArguments(args, {
      valueOptions: ['--automation', '--work', '--checkpoint', '--host']
    });
    const input = {
      root,
      automationId: requiredOption(args, '--automation'),
      workId: requiredOption(args, '--work'),
      checkpointId: requiredOption(args, '--checkpoint'),
      expectedHost: option(args, '--host')
    };
    const inspected = command === 'operator-acquisition-inspect'
      ? await inspectDeclaredAutomationAcquisitionPublic(input)
      : await inspectDeclaredAutomationAcquisitionPrivate(input);
    print(inspected);
    return;
  }

  if (command === 'operator-review-only-candidate-selection-create') {
    const selection = createReviewOnlyCandidateSelection({
      root,
      workId: requiredOption(args, '--work-id'),
      actionIds: options(args, '--action-id'),
      createdAt
    });
    if (json) {
      print(selection);
    } else {
      process.stdout.write(
        'Created immutable review-only candidate selection ' + selection.id + '.\n'
          + 'Selected actions: ' + selection.scope.selectedActionCount + ' of '
          + selection.scope.availableActionCount + '\n'
          + 'Partial subset: ' + (selection.scope.partial ? 'yes' : 'no') + '\n'
          + 'Approval, continuation, and execution authority: none\n'
      );
    }
    return;
  }

  if (command === 'operator-review-only-candidate-selection') {
    const material = inspectReviewOnlyCandidateSelectionMaterial({
      root,
      selectionId: requiredOption(args, '--selection-id')
    });
    print(material);
    return;
  }

  if (command === 'operator-review-only-candidate-preview-create') {
    const preview = await createReviewOnlyCandidatePreview({
      root,
      selectionId: requiredOption(args, '--selection-id'),
      createdAt
    });
    if (json) {
      print(preview);
    } else {
      process.stdout.write(
        'Created private review-only candidate preview ' + preview.id + '.\n'
          + 'Operations: ' + preview.operations.length + '\n'
          + 'Executable: no\n'
          + 'Approval, continuation, execution, and retry authority: none\n'
          + 'Blockers:\n  - ' + preview.blockers.join('\n  - ') + '\n'
      );
    }
    return;
  }

  if (command === 'operator-review-only-candidate-preview') {
    const preview = await inspectReviewOnlyCandidatePreview({
      root,
      candidatePreviewId: requiredOption(args, '--candidate-preview-id')
    });
    print(preview);
    return;
  }

  if (command === 'connected-transaction-complete') {
    if (option(args, '--output')) {
      throw new Error(
        'Connected transaction checkpoints are private runtime state and cannot be exported into the repository.'
      );
    }
    const completed = await completeDurableConnectedTransactionExecution({
      root,
      checkpointId: requiredOption(args, '--checkpoint'),
      callId: requiredOption(args, '--call'),
      response: readPrivateJsonInput(root, requiredOption(args, '--response')),
      at: createdAt
    });
    if (json) {
      print(completed);
    } else {
      const call = completed.currentCall;
      process.stdout.write(
        'Advanced connected transaction ' + completed.checkpoint.batch.id + ' to state '
          + completed.checkpoint.state + '.\n'
          + (call
            ? 'Next stage: ' + completed.checkpoint.current.stage + '\n'
              + 'Next provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Next native host tool: ' + call.transport.tool + '\n'
              + 'Next exact call ID: ' + call.id + '\n'
            : 'Next host request emitted: no\n')
          + 'Raw provider response persisted by Core: no\n'
      );
    }
    if (!['requested', 'completed'].includes(completed.checkpoint.state)) process.exitCode = 1;
    return;
  }

  if (command === 'connected-transaction-reconcile') {
    if (option(args, '--output')) {
      throw new Error(
        'Connected transaction checkpoints are private runtime state and cannot be exported into the repository.'
      );
    }
    const prepared = await prepareDurableConnectedTransactionReconciliation({
      root,
      checkpointId: requiredOption(args, '--checkpoint'),
      at: createdAt
    });
    if (json) {
      print(prepared);
    } else {
      const call = prepared.currentCall;
      process.stdout.write(
        'Prepared read-only reconciliation for ' + prepared.checkpoint.batch.id + '.\n'
          + (call
            ? 'Provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Native host tool: ' + call.transport.tool + '\n'
              + 'Exact call ID: ' + call.id + '\n'
            : 'Host request emitted: no\n')
          + 'Durable checkpoint: ' + prepared.checkpointPath + '\n'
          + 'Writes authorized or retried by reconciliation: 0\n'
      );
    }
    if (prepared.checkpoint.state !== 'requested') process.exitCode = 1;
    return;
  }

  if (command === 'task-capture-decision-inspect') {
    const inspected = inspectTaskCaptureDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      at: createdAt
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Task Capture decision basis ' + inspected.snapshot.id + '.\n'
          + 'Derived state: ' + inspected.outcome.state + '\n'
          + 'Duplicate candidates: ' + inspected.outcome.duplicateCandidateCount + '\n'
          + 'Task fingerprint: ' + inspected.outcome.taskAfterFingerprint + '\n'
          + 'Decision or write authority created: no\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'task-capture-decision-commit') {
    const committed = commitTaskCaptureDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(args, '--decision-id', 'decision.task-capture.' + idPart),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Task Capture decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Proposal, approval, continuation, or provider writes created: no\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'task-capture-proposal-inspect') {
    const inspected = inspectTaskCaptureProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Task Capture proposal basis ' + inspected.decision.id + '.\n'
          + 'Task fingerprint: ' + inspected.decision.taskAfterFingerprint + '\n'
          + 'Proposal, approval, continuation, and provider writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'task-capture-proposal-commit') {
    const committed = commitTaskCaptureProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(args, '--proposal-id', 'proposal.task-capture.' + idPart),
      input: {},
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Task Capture review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, and writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'task-capture-proposal-material') {
    const material = inspectTaskCaptureProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'organization-capture-decision-inspect') {
    const inspected = inspectOrganizationCaptureDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Organization Capture decision basis '
          + inspected.snapshot.id + '.\n'
          + 'Derived state: ' + inspected.outcome.state + '\n'
          + 'Duplicate candidates: ' + inspected.outcome.duplicateCandidateCount + '\n'
          + 'Schema fingerprint: ' + inspected.outcome.schemaFingerprint + '\n'
          + 'Organization fingerprint: '
            + inspected.outcome.organizationAfterFingerprint + '\n'
          + 'Decision or write authority created: no\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'organization-capture-decision-commit') {
    const committed = commitOrganizationCaptureDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(
        args,
        '--decision-id',
        'decision.organization-capture.' + idPart
      ),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Organization Capture decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Proposal, approval, continuation, or provider writes created: no\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'organization-capture-proposal-inspect') {
    const inspected = inspectOrganizationCaptureProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Organization Capture proposal basis '
          + inspected.decision.id + '.\n'
          + 'Organization fingerprint: '
            + inspected.decision.organizationAfterFingerprint + '\n'
          + 'Proposal, approval, continuation, and provider writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'organization-capture-proposal-commit') {
    const committed = commitOrganizationCaptureProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(
        args,
        '--proposal-id',
        'proposal.organization-capture.' + idPart
      ),
      input: {},
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Organization Capture review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, and writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'organization-capture-proposal-material') {
    const material = inspectOrganizationCaptureProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'project-capture-decision-inspect') {
    const inspected = inspectProjectCaptureDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Project Capture decision basis ' + inspected.snapshot.id + '.\n'
          + 'Derived state: ' + inspected.outcome.state + '\n'
          + 'Duplicate candidates: ' + inspected.outcome.duplicateCandidateCount + '\n'
          + 'Organization fingerprint: ' + inspected.outcome.organizationFingerprint + '\n'
          + 'Project fingerprint: ' + inspected.outcome.projectAfterFingerprint + '\n'
          + 'Decision or write authority created: no\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'project-capture-decision-commit') {
    const committed = commitProjectCaptureDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(args, '--decision-id', 'decision.project-capture.' + idPart),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Project Capture decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Proposal, approval, continuation, or provider writes created: no\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'project-capture-proposal-inspect') {
    const inspected = inspectProjectCaptureProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Project Capture proposal basis ' + inspected.decision.id + '.\n'
          + 'Project fingerprint: ' + inspected.decision.projectAfterFingerprint + '\n'
          + 'Proposal, approval, continuation, and provider writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'project-capture-proposal-commit') {
    const committed = commitProjectCaptureProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(args, '--proposal-id', 'proposal.project-capture.' + idPart),
      input: {},
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Project Capture review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, and writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'project-capture-proposal-material') {
    const material = inspectProjectCaptureProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'project-page-reconciliation-decision-inspect') {
    assertExactCommandArguments(args, { valueOptions: ['--lock', '--snapshot'] });
    const inspected = inspectProjectPageReconciliationDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Project Page Reconciliation decision basis '
          + inspected.snapshot.id + '.\n'
          + 'Derived state: ' + inspected.outcome.state + '\n'
          + 'Selected actions: ' + inspected.outcome.actionIds.length + '\n'
          + 'Preview fingerprint: ' + inspected.outcome.previewFingerprint + '\n'
          + 'Project fingerprint: ' + inspected.outcome.projectFingerprint + '\n'
          + 'Decision or write authority created: no\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'project-page-reconciliation-decision-commit') {
    assertExactCommandArguments(args, {
      valueOptions: ['--lock', '--snapshot', '--decision-id', '--actor', '--at']
    });
    const committed = commitProjectPageReconciliationDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(
        args,
        '--decision-id',
        'decision.project-page-reconciliation.' + idPart
      ),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Project Page Reconciliation decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Proposal, approval, continuation, or provider writes created: no\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'project-page-reconciliation-proposal-inspect') {
    assertExactCommandArguments(args, { valueOptions: ['--lock', '--decision'] });
    const inspected = inspectProjectPageReconciliationProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Project Page Reconciliation proposal basis '
          + inspected.decision.id + '.\n'
          + 'Selected actions: ' + inspected.decision.actionIds.length + '\n'
          + 'Preview fingerprint: ' + inspected.decision.previewFingerprint + '\n'
          + 'Proposal, approval, continuation, and provider writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'project-page-reconciliation-proposal-commit') {
    assertExactCommandArguments(args, {
      valueOptions: ['--lock', '--decision', '--proposal-id', '--actor', '--at']
    });
    const committed = commitProjectPageReconciliationProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(
        args,
        '--proposal-id',
        'proposal.project-page-reconciliation.' + idPart
      ),
      input: {},
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Project Page Reconciliation review proposal '
          + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, and writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'project-page-reconciliation-proposal-material') {
    assertExactCommandArguments(args, { valueOptions: ['--lock', '--proposal'] });
    const material = inspectProjectPageReconciliationProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'contact-capture-decision-inspect') {
    const inspected = inspectContactCaptureDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Contact Capture decision basis '
          + inspected.snapshot.id + '.\n'
          + 'Derived state: ' + inspected.outcome.state + '\n'
          + 'Duplicate candidates: ' + inspected.outcome.duplicateCandidateCount + '\n'
          + 'Schema fingerprint: ' + inspected.outcome.schemaFingerprint + '\n'
          + 'Contact fingerprint: ' + inspected.outcome.contactAfterFingerprint + '\n'
          + 'Decision or write authority created: no\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'contact-capture-decision-commit') {
    const committed = commitContactCaptureDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(args, '--decision-id', 'decision.contact-capture.' + idPart),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Contact Capture decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Proposal, approval, continuation, or provider writes created: no\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'contact-capture-proposal-inspect') {
    const inspected = inspectContactCaptureProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Contact Capture proposal basis '
          + inspected.decision.id + '.\n'
          + 'Contact fingerprint: ' + inspected.decision.contactAfterFingerprint + '\n'
          + 'Proposal, approval, continuation, and provider writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'contact-capture-proposal-commit') {
    const committed = commitContactCaptureProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(args, '--proposal-id', 'proposal.contact-capture.' + idPart),
      input: {},
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Contact Capture review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, and writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'contact-capture-proposal-material') {
    const material = inspectContactCaptureProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'project-pulse-decision-inspect') {
    const inspected = inspectProjectPulseDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Project Pulse decision basis ' + inspected.snapshot.id + '.\n'
          + 'Derived state: ' + inspected.outcome.state + '\n'
          + 'Promoted tasks: ' + inspected.outcome.taskCount + '\n'
          + 'Milestones: ' + inspected.outcome.milestoneCount + '\n'
          + 'Health: ' + inspected.outcome.health + '\n'
          + 'Proposed milestone changes: ' + inspected.outcome.milestoneChangeCount + '\n'
          + 'Decision or write authority created: no\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'project-pulse-decision-commit') {
    const committed = commitProjectPulseDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(args, '--decision-id', 'decision.project-pulse.' + idPart),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Project Pulse decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Proposal, approval, continuation, or provider writes created: no\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'project-pulse-proposal-inspect') {
    const inspected = inspectProjectPulseProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Project Pulse proposal basis ' + inspected.decision.id + '.\n'
          + 'Milestone changes: ' + inspected.decision.milestoneChangeCount + '\n'
          + 'Status fingerprint: ' + inspected.decision.statusAfterFingerprint + '\n'
          + 'Proposal, approval, continuation, and provider writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'project-pulse-proposal-commit') {
    const committed = commitProjectPulseProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(args, '--proposal-id', 'proposal.project-pulse.' + idPart),
      input: {},
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Project Pulse review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, and writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'project-pulse-proposal-material') {
    const material = inspectProjectPulseProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'meeting-intake-decision-inspect') {
    const inspected = inspectMeetingIntakeDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private meeting-intake decision context ' + inspected.snapshot.id + '.\n'
          + 'Transcript segments: ' + inspected.counts.transcriptSegments + '\n'
          + 'Task candidates: ' + inspected.counts.taskCandidates + '\n'
          + 'Applicable policies: ' + inspected.counts.applicablePolicies + '\n'
          + 'Template state: needs-input\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'email-triage-decision-inspect') {
    const inspected = inspectEmailTriageDecisionContext({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Email triage decision context ' + inspected.snapshot.id + '.\n'
          + 'Observed threads: ' + inspected.reduction.observedThreadCount + '\n'
          + 'Included candidates: ' + inspected.reduction.includedCount + '\n'
          + 'Excluded threads: ' + inspected.reduction.excludedCount + '\n'
          + 'Template state: needs-input\nProvider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'email-triage-decision-commit') {
    const committed = commitEmailTriageDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(
        args,
        '--decision-id',
        'decision.email-triage.' + idPart
      ),
      input: readDocumentInput(root, requiredOption(args, '--decision-input')),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Email triage decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Drafts, proposed changes, or write approval created: no\nProvider calls executed: 0\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'email-triage-proposal-inspect') {
    const inspected = inspectEmailTriageProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision')
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Email proposal basis ' + inspected.decision.id + '.\n'
          + 'Candidates requiring exact proposal input: '
          + inspected.inputTemplate.candidates.length + '\n'
          + 'Proposal, approval, continuation, and provider writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'email-triage-proposal-commit') {
    const committed = commitEmailTriageProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(args, '--proposal-id', 'proposal.email-triage.' + idPart),
      input: readPrivateJsonInput(root, requiredOption(args, '--proposal-input')),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Email review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, writes, and sending created: 0\n'
      );
    }
    return;
  }

  if (command === 'email-triage-proposal-material') {
    const material = inspectEmailTriageProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'meeting-intake-decision-commit') {
    const committed = commitMeetingIntakeDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      snapshotId: requiredOption(args, '--snapshot'),
      id: option(
        args,
        '--decision-id',
        'decision.meeting-intake.' + idPart
      ),
      input: readDocumentInput(root, requiredOption(args, '--decision-input')),
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed meeting-intake decision ' + committed.decision.id + '.\n'
          + 'State: ' + committed.decision.state + '\n'
          + 'Decision fingerprint: ' + committed.decision.decisionFingerprint + '\n'
          + 'Private decision: ' + committed.decisionPath + '\n'
          + 'Write approval created: no\nProvider calls executed: 0\n'
      );
    }
    if (committed.decision.state !== 'ready') process.exitCode = 1;
    return;
  }

  if (command === 'meeting-intake-proposal-inspect') {
    const inspected = inspectMeetingIntakeProposalDecision({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
    });
    if (json) {
      print(inspected);
    } else {
      process.stdout.write(
        'Inspected private Meeting Intake proposal basis ' + inspected.decision.id + '.\n'
          + 'Grounded summary segments: ' + inspected.decision.summarySegmentCount + '\n'
          + 'Existing task folds: ' + inspected.decision.foldedTaskCount + '\n'
          + 'Proposal, approval, continuation, provider calls, or writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'meeting-intake-proposal-commit') {
    const committed = commitMeetingIntakeProposal({
      root,
      lockPath: requiredOption(args, '--lock'),
      decisionId: requiredOption(args, '--decision'),
      id: option(args, '--proposal-id', 'proposal.meeting-intake.' + idPart),
      input: {},
      producer: {
        kind: 'user',
        id: option(args, '--actor', 'user'),
        host: null
      },
      at: createdAt
    });
    if (json) {
      print(committed);
    } else {
      process.stdout.write(
        'Committed Meeting Intake review proposal ' + committed.proposal.id + '.\n'
          + 'Proposal fingerprint: ' + committed.proposal.proposalFingerprint + '\n'
          + 'Private proposal: ' + committed.proposalPath + '\n'
          + 'Selected private material: ' + committed.materialPath + '\n'
          + 'Approval, continuation, provider calls, and writes created: 0\n'
      );
    }
    return;
  }

  if (command === 'meeting-intake-proposal-material') {
    const material = inspectMeetingIntakeProposalMaterial({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal')
    });
    print(material);
    return;
  }

  if (command === 'host-fail') {
    const checkpointId = requiredOption(args, '--checkpoint');
    if (option(args, '--output')) {
      throw new Error(
        'Host-call checkpoints are private runtime state and cannot be exported.'
      );
    }
    assertExactCommandArguments(args, {
      valueOptions: ['--checkpoint', '--call', '--kind', '--at']
    });
    const failed = await failDurableHostExecution({
      root,
      checkpointId,
      errorKind: requiredOption(args, '--kind'),
      callId: option(args, '--call'),
      at: createdAt
    });
    if (json) {
      print(failed);
    } else {
      const call = failed.currentCall;
      process.stdout.write(
        'Recorded ' + failed.checkpoint.id + ' in state '
          + failed.checkpoint.state + '.\n'
          + (call
            ? 'Next provider operation: ' + call.transport.server + '/'
              + call.transport.operation + '\n'
              + 'Next native host tool: ' + call.transport.tool + '\n'
              + 'Next exact call ID: ' + call.id + '\n'
            : '')
      );
    }
    return;
  }

  if (command === 'host-get') {
    const checkpoint = getDurableHostExecution({
      root,
      checkpointId: requiredOption(args, '--checkpoint')
    });
    print(checkpoint);
    return;
  }

  if (command === 'host-list') {
    const checkpoints = listDurableHostExecutions({
      root,
      state: option(args, '--state')
    });
    print(checkpoints);
    return;
  }

  if (command === 'proposal-connected-batch-preview') {
    const preview = await createProposalConnectedBatch({
      root,
      lockPath: requiredOption(args, '--lock'),
      proposalId: requiredOption(args, '--proposal'),
      actionIds: options(args, '--action-id'),
      changeSetId: option(args, '--change-set-id', 'changeset.email-triage.' + idPart),
      batchId: option(args, '--batch-id', 'batch.email-triage.' + idPart),
      createdAt,
      expectedHost: option(args, '--host')
    });
    if (json) {
      print(preview);
    } else {
      process.stdout.write(
        'Compiled exact proposal batch ' + preview.batch.id + '.\n'
          + 'Selected actions: ' + preview.selection.selectedActionCount + ' of '
            + preview.selection.availableActionCount + '\n'
          + 'Partial subset: ' + (preview.selection.partial ? 'yes' : 'no') + '\n'
          + 'Approval authority created: no\n'
          + 'Provider calls executed: 0\n'
      );
    }
    return;
  }

  if (command === 'development-candidate-lock') {
    const materialized = materializeDevelopmentCandidateLock({
      root,
      configPath: requiredOption(args, '--config'),
      workflowId: requiredOption(args, '--workflow'),
      host: requiredOption(args, '--host')
    });
    const inspection = {
      path: materialized.path,
      lockFingerprint: materialized.lockFingerprint,
      graphFingerprint: materialized.graphFingerprint,
      workflow: materialized.workflow,
      host: materialized.host,
      authority: materialized.authority
    };
    if (json) print(inspection);
    else {
      process.stdout.write(
        'Created exact private development candidate lock.\n'
          + 'Path: ' + inspection.path + '\n'
          + 'Workflow: ' + inspection.workflow.id + '@' + inspection.workflow.version + '\n'
          + 'Host: ' + inspection.host.id + '\n'
          + 'Lock fingerprint: ' + inspection.lockFingerprint + '\n'
          + 'Execution, provider, merge, realization, or promotion authority: none\n'
      );
    }
    return;
  }

  if (command === 'development-request-create') {
    const workflowId = requiredOption(args, '--workflow');
    const invocationPath = option(args, '--invocation');
    const exactEvaluationSuite = args.includes('--evaluation-suite');
    if ((invocationPath ? 1 : 0) + (exactEvaluationSuite ? 1 : 0) !== 1) {
      throw new Error('development-request-create requires exactly one of --invocation or --evaluation-suite.');
    }
    const invocation = exactEvaluationSuite
      ? buildDevelopmentEvaluationInvocation({ root, workflowId })
      : readPrivateJsonInput(root, invocationPath);
    const prepared = prepareDevelopmentRequest({
      root,
      lockPath: requiredOption(args, '--lock'),
      workflowId,
      requestId: requiredOption(args, '--request-id'),
      invocation,
      createdAt: args.includes('--at') ? createdAt : null
    });
    if (json) print(prepared.inspection);
    else {
      process.stdout.write(
        'Created exact private development request ' + prepared.inspection.request.id + '.\n'
          + 'Workflow: ' + prepared.inspection.workflow.id + '\n'
          + 'Host: ' + prepared.inspection.host.id + '\n'
          + 'Provider transaction authority: none\n'
      );
    }
    return;
  }

  if (command === 'development-result-record') {
    const outcome = readPrivateJsonInput(root, requiredOption(args, '--outcome'));
    const recorded = recordDevelopmentResult({
      root,
      lockPath: requiredOption(args, '--lock'),
      requestId: requiredOption(args, '--request-id'),
      outcome,
      completedAt: args.includes('--at') ? createdAt : null
    });
    if (json) print(recorded.inspection);
    else {
      process.stdout.write(
        'Recorded scoped development evidence for ' + recorded.inspection.request.id + '.\n'
          + 'State: ' + recorded.inspection.progress.state + '\n'
          + 'Promotion authority: none\n'
      );
    }
    return;
  }

  if (command === 'development-host-result-record') {
    const input = parseDevelopmentHostResultArguments(args);
    const recorded = recordHostDevelopmentResult({
      root,
      requestId: input.requestId,
      state: input.state,
      checks: input.checks,
      localEffects: input.localEffects,
      completedAt: input.at
    });
    if (input.json) print(recorded.inspection);
    else {
      process.stdout.write(
        'Recorded one path-free host development result.\n'
          + 'State: ' + recorded.inspection.progress.state + '\n'
          + 'Promotion authority: none\n'
      );
    }
    return;
  }

  if (command === 'development-host-evaluate') {
    const evaluated = runDevelopmentHostEvaluation({
      root,
      requestId: requiredOption(args, '--request-id'),
      executablePath: requiredOption(args, '--executable')
    });
    if (json) print(evaluated.summary);
    else {
      process.stdout.write(
        'Completed isolated ' + evaluated.summary.host + ' evaluation ' + evaluated.summary.id + '.\n'
          + 'Fresh worker processes: ' + evaluated.summary.runCount + '\n'
          + 'Independent judgment required: yes\n'
          + 'Raw prompts and transcripts returned or inspected: no\n'
          + 'Activation or promotion authority: none\n'
      );
    }
    return;
  }

  if (command === 'development-host-judge') {
    const judged = runDevelopmentHostJudgment({
      root,
      requestId: requiredOption(args, '--request-id'),
      executablePath: requiredOption(args, '--executable')
    });
    if (json) print(judged.summary);
    else {
      process.stdout.write(
        'Completed isolated independent ' + judged.summary.host + ' judgment ' + judged.summary.id + '.\n'
          + 'Fresh judge processes: ' + judged.summary.reviewCount + '\n'
          + 'Guided cases passed: ' + (judged.summary.guidedPassed ? 'yes' : 'no') + '\n'
          + 'Worker self-report accepted as judgment: no\n'
          + 'Activation or promotion authority: none\n'
      );
    }
    return;
  }

  if (command === 'development-host-finalize') {
    const judgmentPath = option(args, '--judgment');
    const finalized = finalizeDevelopmentHostEvaluation({
      root,
      requestId: requiredOption(args, '--request-id'),
      judgment: judgmentPath ? readPrivateJsonInput(root, judgmentPath) : null
    });
    if (json) print(finalized.observation);
    else {
      process.stdout.write(
        'Recorded independently judged host observation ' + finalized.observation.id + '.\n'
          + 'Host: ' + finalized.observation.host.id + '\n'
          + 'Guided runs: ' + finalized.observation.runs.filter((run) => run.arm === 'guided').length + '\n'
          + 'Worker self-report accepted as judgment: no\n'
          + 'Activation or promotion authority: none\n'
      );
    }
    return;
  }

  if (command === 'development-run-inspect') {
    const inspection = inspectDevelopmentRun({
      root,
      requestId: requiredOption(args, '--request-id')
    });
    if (json) print(inspection);
    else {
      process.stdout.write(
        'Development run ' + inspection.request.id + ': ' + inspection.progress.state + '.\n'
          + 'Workflow: ' + inspection.workflow.id + '\n'
          + 'Host: ' + inspection.host.id + '\n'
          + 'Private paths, outcomes, diffs, transcripts, and provider responses included: no\n'
      );
    }
    return;
  }

  if (command === 'selftest') {
    const { selftest } = await import('./selftest.mjs');
    const { selftestPrivateJsonInput } = await import('./lib/canonical-json.selftest.mjs');
    const { selftestPreparedWork } = await import('./prepared-work.selftest.mjs');
    const { selftestReviewOnlyCandidateSelections } = await import(
      './review-only-candidate-selections.selftest.mjs'
    );
    const { selftestReviewOnlyCandidatePreviews } = await import(
      './review-only-candidate-previews.selftest.mjs'
    );
    const { selftestAutomationProposals } = await import('./automation-proposals.selftest.mjs');
    const { selftestConfigurationTransactions } = await import('./configuration-transactions.selftest.mjs');
    const { selftestHostRealizations } = await import('./host-realizations.selftest.mjs');
    const { selftestPackInstalls } = await import('./pack-installs.selftest.mjs');
    const { selftestDevelopmentCandidateLocks } = await import(
      './development-candidate-locks.selftest.mjs'
    );
    const { selftestDevelopmentRuns } = await import('./development-runs.selftest.mjs');
    const { selftestDevelopmentHostObservations } = await import(
      './development-host-observations.selftest.mjs'
    );
    const { selftestDevelopmentHostRunner } = await import(
      './development-host-runner.selftest.mjs'
    );
    const { selftestEmailConnectedContext } = await import(
      '../automations/email-triage/connected-context.selftest.mjs'
    );
    const { selftestTaskCaptureConnectedContext } = await import(
      '../automations/task-capture/connected-context.selftest.mjs'
    );
    const { selftestProjectPulseConnectedContext } = await import(
      '../automations/project-pulse/connected-context.selftest.mjs'
    );
    const { selftestOrganizationCapture } = await import(
      '../automations/organization-capture/organization-capture.selftest.mjs'
    );
    const { selftestOrganizationCaptureConnectedContext } = await import(
      '../automations/organization-capture/connected-context.selftest.mjs'
    );
    const { selftestProjectCapture } = await import(
      '../automations/project-capture/project-capture.selftest.mjs'
    );
    const { selftestProjectCaptureConnectedContext } = await import(
      '../automations/project-capture/connected-context.selftest.mjs'
    );
    const { selftestProjectPageReconciliation } = await import(
      '../automations/project-page-reconciliation/project-page-reconciliation.selftest.mjs'
    );
    const { selftestProjectPageReconciliationConnectedContext } = await import(
      '../automations/project-page-reconciliation/connected-context.selftest.mjs'
    );
    const { selftestContactCapture } = await import(
      '../automations/contact-capture/contact-capture.selftest.mjs'
    );
    const { selftestContactCaptureConnectedContext } = await import(
      '../automations/contact-capture/connected-context.selftest.mjs'
    );
    const { selftestDriveFiling } = await import(
      '../automations/filing-a-drive-artifact/filing-a-drive-artifact.selftest.mjs'
    );
    const { selftestFeatureCapture } = await import(
      '../automations/feature-capture/feature-capture.selftest.mjs'
    );
    const { selftestFeatureDefinition } = await import(
      '../automations/feature-definition/feature-definition.selftest.mjs'
    );
    const { selftestRepositoryReview } = await import(
      '../automations/repository-review/repository-review.selftest.mjs'
    );
    const { selftestSlackChannelIngestion } = await import(
      '../automations/slack-channel-ingestion/slack-channel-ingestion.selftest.mjs'
    );
    const { selftestSlackConversationReviewConnectedContext } = await import(
      '../automations/slack-conversation-review/connected-context.selftest.mjs'
    );
    const { selftestProcessCapture } = await import(
      '../automations/process-capture/process-capture.selftest.mjs'
    );
    const { selftestProcessRedTeam } = await import(
      '../automations/process-red-team/process-red-team.selftest.mjs'
    );
    const { selftestProjectDecisionResolution } = await import(
      '../automations/project-decision-resolution/project-decision-resolution.selftest.mjs'
    );
    const { selftestProjectWorkPromotion } = await import(
      '../automations/project-work-promotion/project-work-promotion.selftest.mjs'
    );
    const { selftestNotionRecordMappings } = await import(
      '../integrations/notion/notion.selftest.mjs'
    );
    const suites = [
      ['core', () => selftest(root)],
      ['private-json-input', () => selftestPrivateJsonInput()],
      ['prepared-work', () => selftestPreparedWork(root)],
      ['review-only-candidate-selections', () => selftestReviewOnlyCandidateSelections(root)],
      ['review-only-candidate-previews', () => selftestReviewOnlyCandidatePreviews(root)],
      ['automation-proposals', () => selftestAutomationProposals(root)],
      ['configuration-transactions', () => selftestConfigurationTransactions(root)],
      ['host-realizations', () => selftestHostRealizations(root)],
      ['pack-installs', () => selftestPackInstalls(root)],
      ['development-candidate-locks', () => selftestDevelopmentCandidateLocks(root)],
      ['development-runs', () => selftestDevelopmentRuns(root)],
      ['development-host-observations', () => selftestDevelopmentHostObservations(root)],
      ['development-host-runner', () => selftestDevelopmentHostRunner(root)],
      ['email-connected-context', () => selftestEmailConnectedContext(root)],
      ['task-capture-connected-context', () => selftestTaskCaptureConnectedContext(root)],
      ['project-pulse-connected-context', () => selftestProjectPulseConnectedContext(root)],
      ['organization-capture', () => selftestOrganizationCapture(root)],
      [
        'organization-capture-connected-context',
        () => selftestOrganizationCaptureConnectedContext(root)
      ],
      ['project-capture', () => selftestProjectCapture(root)],
      ['project-capture-connected-context', () => selftestProjectCaptureConnectedContext(root)],
      ['project-page-reconciliation', () => selftestProjectPageReconciliation(root)],
      [
        'project-page-reconciliation-connected-context',
        () => selftestProjectPageReconciliationConnectedContext(root)
      ],
      ['contact-capture', () => selftestContactCapture(root)],
      ['contact-capture-connected-context', () => selftestContactCaptureConnectedContext(root)],
      ['drive-filing', () => selftestDriveFiling(root)],
      ['feature-capture', () => selftestFeatureCapture(root)],
      ['feature-definition', () => selftestFeatureDefinition(root)],
      ['repository-review', () => selftestRepositoryReview(root)],
      ['slack-channel-ingestion', () => selftestSlackChannelIngestion(root)],
      [
        'slack-conversation-review-connected-context',
        () => selftestSlackConversationReviewConnectedContext(root)
      ],
      ['process-capture', () => selftestProcessCapture(root)],
      ['process-red-team', () => selftestProcessRedTeam(root)],
      ['project-decision-resolution', () => selftestProjectDecisionResolution(root)],
      ['project-work-promotion', () => selftestProjectWorkPromotion(root)],
      ['notion-record-mappings', () => selftestNotionRecordMappings(root)]
    ];
    if (args.includes('--list-suites')) {
      process.stdout.write(suites.map(([name]) => name).join('\n') + '\n');
      return;
    }
    const selectedSuite = option(args, '--suite');
    if (selectedSuite !== null && !suites.some(([name]) => name === selectedSuite)) {
      throw new Error(
        'Unknown selftest suite ' + selectedSuite
          + '. Use --list-suites for the exact names.'
      );
    }
    const selected = selectedSuite === null
      ? suites
      : suites.filter(([name]) => name === selectedSuite);
    const failedSuites = [];
    for (const [name, run] of selected) {
      try {
        const result = await run();
        if (!result) {
          failedSuites.push(name);
          process.stderr.write('CORE SELFTEST SUITE FAIL: ' + name + ' returned no passing result.\n');
        }
      } catch (error) {
        failedSuites.push(name);
        process.stderr.write(
          'CORE SELFTEST SUITE FAIL: ' + name + ': '
            + (error?.stack || error?.message || String(error)) + '\n'
        );
      }
    }
    if (failedSuites.length) {
      process.stderr.write(
        'CORE SELFTEST SUMMARY: ' + failedSuites.length + ' of ' + selected.length
          + ' suites failed: ' + failedSuites.join(', ') + '.\n'
      );
    } else {
      process.stdout.write(
        'CORE SELFTEST SUMMARY: all ' + selected.length + ' suites passed.\n'
      );
    }
    process.exitCode = failedSuites.length ? 1 : 0;
    return;
  }

  if (command === 'fixtures') {
    const fixtureModes = args.filter((argument) => {
      return ['--check', '--update'].includes(argument);
    });
    if (fixtureModes.length !== 1) {
      throw new Error('fixtures requires exactly one of --check or --update.');
    }
    if (fixtureModes[0] === '--update') {
      const fixtures = await writeSoterFixtures(root);
      process.stdout.write('Updated ' + fixtures.size + ' generated Core fixtures.\n');
      return;
    }
    if (fixtureModes[0] === '--check') {
      const result = await checkSoterFixtures(root);
      if (json) {
        print({ matches: result.matches, mismatches: result.mismatches });
      } else if (result.matches) {
        process.stdout.write('Core fixtures: current.\n');
      } else {
        for (const mismatch of result.mismatches) {
          process.stderr.write('STALE ' + mismatch.path + ': ' + mismatch.reason + '\n');
        }
      }
      process.exitCode = result.matches ? 0 : 1;
      return;
    }
    throw new Error('fixtures requires --check or --update.');
  }

  throw new Error(
    'Usage: node soter/core/cli.mjs <resolve|config-inspect|development-candidate-lock|development-request-create|development-result-record|development-host-result-record|development-host-evaluate|development-host-judge|development-host-finalize|development-run-inspect|configuration-change-plan|configuration-change-request|configuration-change-confirm|configuration-change-start|configuration-change-execute|configuration-change-recover|configuration-change-inspect|host-realization-plan|host-realization-request|host-realization-confirm|host-realization-start|host-realization-execute|host-realization-recover|host-realization-inspect|pack-install-plan|pack-install-request|pack-install-confirm|pack-install-start|pack-install-execute|pack-install-recover|pack-install-inspect|operator-prepare|operator-prepared-inspect|operator-prepared-review|operator-prepared-derived-review|operator-acquisition-prepare|operator-acquisition-recover|operator-acquisition-finalize|operator-acquisition-inspect|operator-acquisition-private-inspect|operator-review-only-candidate-selection-create|operator-review-only-candidate-selection|operator-review-only-candidate-preview-create|operator-review-only-candidate-preview|operator-inspect|operator-approval-review|prepare|meeting-intake-decision-inspect|meeting-intake-decision-commit|meeting-intake-proposal-inspect|meeting-intake-proposal-commit|meeting-intake-proposal-material|email-triage-decision-inspect|email-triage-decision-commit|email-triage-proposal-inspect|email-triage-proposal-commit|email-triage-proposal-material|task-capture-decision-inspect|task-capture-decision-commit|task-capture-proposal-inspect|task-capture-proposal-commit|task-capture-proposal-material|organization-capture-decision-inspect|organization-capture-decision-commit|organization-capture-proposal-inspect|organization-capture-proposal-commit|organization-capture-proposal-material|project-capture-decision-inspect|project-capture-decision-commit|project-capture-proposal-inspect|project-capture-proposal-commit|project-capture-proposal-material|project-page-reconciliation-decision-inspect|project-page-reconciliation-decision-commit|project-page-reconciliation-proposal-inspect|project-page-reconciliation-proposal-commit|project-page-reconciliation-proposal-material|contact-capture-decision-inspect|contact-capture-decision-commit|contact-capture-proposal-inspect|contact-capture-proposal-commit|contact-capture-proposal-material|project-pulse-decision-inspect|project-pulse-decision-commit|project-pulse-proposal-inspect|project-pulse-proposal-commit|project-pulse-proposal-material|proposal-connected-batch-preview|connected-approval-request|connected-approval-confirm|connected-transaction-prepare|connected-transaction-complete|connected-transaction-reconcile|doctor|probe-prepare|probe-complete|capability-complete|plan-complete|host-fail|host-get|host-list|fixtures|selftest> [options]\n'
      + '  resolve [--config PATH] [--host ID] [--output PATH] [--json]\n'
      + '  config-inspect [--config PATH] [--host ID | --lock PATH] [--output PATH] [--json]\n'
      + '  development-candidate-lock --config PATH --workflow ID --host <codex|claude> [--json]\n'
      + '  development-request-create --lock PATH --workflow ID --request-id ID (--evaluation-suite | --invocation ABSOLUTE_PRIVATE_PATH) [--at TIME] [--json]\n'
      + '  development-result-record --lock PATH --request-id ID --outcome ABSOLUTE_PRIVATE_PATH [--at TIME] [--json]\n'
      + '  development-host-result-record --request-id ID --state passed|failed|blocked|partial [--check ID=STATE ...] --local-workspace-read STATE:COUNT --local-workspace-write STATE:COUNT --local-command STATE:COUNT --subagent-dispatch STATE:COUNT [--at TIME] [--json]\n'
      + '  development-host-evaluate --request-id ID --executable ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  development-host-judge --request-id ID --executable ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  development-host-finalize --request-id ID [--judgment ABSOLUTE_PRIVATE_HUMAN_ATTESTATION_PATH] [--json]\n'
      + '  development-run-inspect --request-id ID [--json]\n'
      + '  configuration-change-plan --configuration NAME --candidate ABSOLUTE_PRIVATE_PATH [--plan-id ID] [--at TIME] [--json]\n'
      + '  configuration-change-request --plan-id ID --reason TEXT --expires-at TIME [--request-id ID] [--at TIME] [--json]\n'
      + '  configuration-change-confirm --request-id ID --actor ID --reason TEXT [--confirmation-id ID] [--at TIME] [--json]\n'
      + '  configuration-change-start --confirmation-id ID [--checkpoint-id ID] [--at TIME] [--json]\n'
      + '  configuration-change-execute --checkpoint-id ID [--at TIME] [--json]\n'
      + '  configuration-change-recover --checkpoint-id ID [--at TIME] [--json]\n'
      + '  configuration-change-inspect --plan-id ID [--request-id ID] [--confirmation-id ID] [--consumption-id ID] [--checkpoint-id ID] [--at TIME] [--json]\n'
      + '  host-realization-plan --configuration NAME --valid-until TIME [--plan-id ID] [--at TIME] [--json]\n'
      + '  host-realization-request --plan-id ID --reason TEXT --expires-at TIME [--request-id ID] [--at TIME] [--json]\n'
      + '  host-realization-confirm --request-id ID --actor ID --reason TEXT [--confirmation-id ID] [--at TIME] [--json]\n'
      + '  host-realization-start --confirmation-id ID [--checkpoint-id ID] [--at TIME] [--json]\n'
      + '  host-realization-execute --checkpoint-id ID [--at TIME] [--json]\n'
      + '  host-realization-recover --checkpoint-id ID [--at TIME] [--json]\n'
      + '  host-realization-inspect --plan-id ID [--request-id ID] [--confirmation-id ID] [--consumption-id ID] [--checkpoint-id ID] [--at TIME] [--json]\n'
      + '  pack-install-plan --target ABSOLUTE_PRIVATE_TARGET --capsule ABSOLUTE_LOCAL_CAPSULE [--capsule PATH ...] --valid-until TIME [--bundle PATH] [--base-contract VERSION] [--plan-id ID] [--at TIME] [--json]\n'
      + '  pack-install-request --target ABSOLUTE_PRIVATE_TARGET --plan-id ID --reason TEXT --expires-at TIME [--request-id ID] [--at TIME] [--json]\n'
      + '  pack-install-confirm --target ABSOLUTE_PRIVATE_TARGET --request-id ID --actor ID --reason TEXT [--confirmation-id ID] [--at TIME] [--json]\n'
      + '  pack-install-start --target ABSOLUTE_PRIVATE_TARGET --confirmation-id ID [--checkpoint-id ID] [--at TIME] [--json]\n'
      + '  pack-install-execute --target ABSOLUTE_PRIVATE_TARGET --checkpoint-id ID [--at TIME] [--json]\n'
      + '  pack-install-recover --target ABSOLUTE_PRIVATE_TARGET --checkpoint-id ID [--at TIME] [--json]\n'
      + '  pack-install-inspect --target ABSOLUTE_PRIVATE_TARGET [--plan-id ID] [--request-id ID] [--confirmation-id ID] [--consumption-id ID] [--checkpoint-id ID] [--at TIME] [--json]\n'
      + '  operator-prepare --configuration NAME --configuration-basis tracked-contained|private-active --automation ID --input ABSOLUTE_PRIVATE_PATH [--preparation-mode contained|connected-acquisition] [--host ID] [--at TIME] [--json]\n'
      + '  operator-prepared-inspect --work-id ID [--json]\n'
      + '  operator-prepared-review --work-id ID [--json]\n'
      + '  operator-prepared-derived-review --work-id ID [--json]\n'
      + '  operator-acquisition-prepare --automation ID --work ID [--host ID] [--at TIME] [--json]\n'
      + '  operator-acquisition-recover --automation ID --work ID --checkpoint ID --checkpoint-fingerprint HASH --step ID --call ID --call-fingerprint HASH [--host ID] [--at TIME] [--json]\n'
      + '  operator-acquisition-finalize --automation ID --work ID --checkpoint ID [--host ID] [--json]\n'
      + '  operator-acquisition-inspect --automation ID --work ID --checkpoint ID [--host ID] [--json]\n'
      + '  operator-acquisition-private-inspect --automation ID --work ID --checkpoint ID [--host ID] [--json]\n'
      + '  operator-review-only-candidate-selection-create --work-id ID --action-id ID [--action-id ID ...] [--at TIME] [--json]\n'
      + '  operator-review-only-candidate-selection --selection-id ID [--json]\n'
      + '  operator-review-only-candidate-preview-create --selection-id ID [--at TIME] [--json]\n'
      + '  operator-review-only-candidate-preview --candidate-preview-id ID [--json]\n'
      + '  operator-inspect [--request-id ID | --approval-id ID | --checkpoint ID] [--at TIME] [--json]\n'
      + '  operator-approval-review --request-id ID [--json]\n'
      + '  prepare --lock PATH [--scenario PATH] [--output PATH] [--evidence-dir PATH] [--json]\n'
      + '  meeting-intake-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  meeting-intake-decision-commit --lock PATH --snapshot ID --decision-input PATH [--decision-id ID] [--actor ID] [--json]\n'
      + '  email-triage-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  email-triage-decision-commit --lock PATH --snapshot ID --decision-input PATH [--decision-id ID] [--actor ID] [--json]\n'
      + '  email-triage-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  email-triage-proposal-commit --lock PATH --decision ID --proposal-input ABSOLUTE_PATH [--proposal-id ID] [--actor ID] [--json]\n'
      + '  email-triage-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  task-capture-decision-inspect --lock PATH --snapshot ID [--at ISO] [--json]\n'
      + '  task-capture-decision-commit --lock PATH --snapshot ID [--decision-id ID] [--actor ID] [--json]\n'
      + '  task-capture-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  task-capture-proposal-commit --lock PATH --decision ID [--proposal-id ID] [--actor ID] [--json]\n'
      + '  task-capture-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  organization-capture-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  organization-capture-decision-commit --lock PATH --snapshot ID [--decision-id ID] [--actor ID] [--json]\n'
      + '  organization-capture-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  organization-capture-proposal-commit --lock PATH --decision ID [--proposal-id ID] [--actor ID] [--json]\n'
      + '  organization-capture-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  project-capture-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  project-capture-decision-commit --lock PATH --snapshot ID [--decision-id ID] [--actor ID] [--json]\n'
      + '  project-capture-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  project-capture-proposal-commit --lock PATH --decision ID [--proposal-id ID] [--actor ID] [--json]\n'
      + '  project-capture-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  project-page-reconciliation-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  project-page-reconciliation-decision-commit --lock PATH --snapshot ID [--decision-id ID] [--actor ID] [--at ISO] [--json]\n'
      + '  project-page-reconciliation-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  project-page-reconciliation-proposal-commit --lock PATH --decision ID [--proposal-id ID] [--actor ID] [--at ISO] [--json]\n'
      + '  project-page-reconciliation-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  contact-capture-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  contact-capture-decision-commit --lock PATH --snapshot ID [--decision-id ID] [--actor ID] [--json]\n'
      + '  contact-capture-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  contact-capture-proposal-commit --lock PATH --decision ID [--proposal-id ID] [--actor ID] [--json]\n'
      + '  contact-capture-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  project-pulse-decision-inspect --lock PATH --snapshot ID [--json]\n'
      + '  project-pulse-decision-commit --lock PATH --snapshot ID [--decision-id ID] [--actor ID] [--json]\n'
      + '  project-pulse-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  project-pulse-proposal-commit --lock PATH --decision ID [--proposal-id ID] [--actor ID] [--json]\n'
      + '  project-pulse-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  meeting-intake-proposal-inspect --lock PATH --decision ID [--json]\n'
      + '  meeting-intake-proposal-commit --lock PATH --decision ID [--proposal-id ID] [--actor ID] [--json]\n'
      + '  meeting-intake-proposal-material --lock PATH --proposal ID [--json]\n'
      + '  proposal-connected-batch-preview --lock PATH --proposal ID --action-id ID [--action-id ID] [--change-set-id ID] [--batch-id ID] [--json]\n'
      + '  connected-approval-request --configuration-basis private-active --lock PATH --run PATH --batch PATH --change-set PATH --request-id ID --reason TEXT --expires-at TIME [--json]\n'
      + '  connected-approval-confirm --request-id ID --approval-id ID --actor ACTOR --reason TEXT [--json]\n'
      + '  connected-transaction-prepare --approval-id ID [--json]\n'
      + '  connected-transaction-complete --checkpoint ID --call ID --response ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  connected-transaction-reconcile --checkpoint ID [--json]\n'
      + '  doctor --lock PATH [--level offline|connected] [--probe PATH ...] [--probe-checkpoint ID ...] [--config PATH] [--json]\n'
      + '  probe-prepare --configuration-basis private-active --lock PATH --provider ID [--json]\n'
      + '  probe-complete --checkpoint ID --call ID --response ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  capability-complete --checkpoint ID --response ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  plan-complete --checkpoint ID --call ID --response ABSOLUTE_PRIVATE_PATH [--json]\n'
      + '  host-fail --checkpoint ID [--call ID] --kind KIND [--at TIME] [--json]\n'
      + '  host-get --checkpoint ID\n'
      + '  host-list [--state requested|completed|failed|needs-attention|blocked]\n'
      + '  selftest [--suite NAME | --list-suites]\n'
      + '  fixtures <--check|--update> [--json]'
  );
}

main().catch((error) => {
  process.stderr.write('Soter Core: ' + error.message + '\n');
  process.exitCode = 1;
});
