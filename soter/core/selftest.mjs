import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createFixtureRuntimeState,
  evaluateEffectPolicy,
  invokeCapability
} from './capabilities.mjs';
import { assembleMeetingIntakeContext } from './context.mjs';
import {
  buildConfigurationView,
  formatConfigurationView
} from './configuration-view.mjs';
import {
  finalizeMeetingIntakeConnectedContext,
  prepareMeetingIntakeConnectedContext
} from '../automations/meeting-intake/context.mjs';
import { runConnectedDoctor, runOfflineDoctor } from './doctor.mjs';
import {
  approveConnectedOperationBatch as approveExactConnectedOperationBatch,
  assertConnectedOperationBatchApproval,
  createConnectedOperationBatchApprovalRequest,
  compileConnectedOperationBatch
} from './connected-transactions.mjs';
import {
  beginConnectedApprovalRequest,
  confirmConnectedApprovalRequest
} from './operator-authority.mjs';
import {
  assertConnectedApprovalReviewMaterial,
  inspectConnectedApprovalReviewMaterial
} from './connected-approval-review.mjs';
import {
  assertOperatorInspection,
  inspectConnectedOperatorActivity
} from './operator-inspection.mjs';
import { inspectWorkspace } from './inspection.mjs';
import {
  assertConnectedTransactionCheckpoint,
  completeConnectedTransactionCall,
  connectedTransactionCurrentCall,
  createConnectedTransactionCheckpoint,
  failConnectedTransactionCall,
  prepareConnectedTransactionReconciliation
} from './connected-transaction-runtime.mjs';
import {
  createContextAssemblyEvidence,
  createContainedTransactionEvidence,
  createResolutionEvidence,
  createRunPreparationEvidence,
  createScenarioExecutionEvidence
} from './evidence.mjs';
import { evaluateConfigurationMaturity } from './maturity.mjs';
import {
  fingerprintLock,
  lockMatchesResolution,
  resolveConfiguration
} from './resolve.mjs';
import { prepareRunEnvelope } from './run.mjs';
import { assertOperationPlanDocument } from './operation-plans.mjs';
import {
  commitDurableContextSnapshot,
  completeDurableProviderProbeExecution,
  completeDurableOperationPlanExecution,
  completeDurableConnectedTransactionExecution,
  failDurableHostExecution,
  getDurableHostExecution,
  prepareDurableConnectedTransactionExecution,
  prepareDurableConnectedTransactionReconciliation,
  prepareDurableProviderProbeExecution,
  prepareDurableOperationPlanExecution
} from './service.mjs';
import {
  completeHostToolCall,
  failHostToolCall,
  prepareHostToolCall
} from './host-tools.mjs';
import { fingerprintJson, readJson, writeJson } from './lib/canonical-json.mjs';
import {
  completeProviderProbeCall,
  failProviderProbeCall,
  prepareProviderProbeCall
} from './provider-probes.mjs';
import { validateJsonSchema, verifySoter } from '../kernel/verify.mjs';
import {
  approveChangeSet,
  changeSetScopeFingerprint
} from './transaction.mjs';
import {
  executeContainedMeetingIntakeChangeSet,
  proposeMeetingIntakeChangeSet,
  runContainedMeetingIntakeTransaction
} from '../automations/meeting-intake/transaction.mjs';
import { createMeetingIntakeDecision } from '../automations/meeting-intake/decision.mjs';
import { writeContextSnapshotState } from './runtime-state.mjs';

const FIXTURE_TIME = '2026-07-15T12:00:00.000Z';

function approveSelftestConnectedBatch({
  root,
  lock,
  lockPath,
  run = null,
  runPath = 'private/selftest.run.json',
  batch,
  changeSet,
  id,
  actor,
  reason,
  createdAt,
  expiresAt
}) {
  const sourceRun = run || { id: batch.runId };
  const request = createConnectedOperationBatchApprovalRequest({
    root,
    lock,
    lockPath,
    run: sourceRun,
    runPath,
    batch,
    changeSet,
    id: 'approval-request.' + id.slice('approval.'.length),
    reason: 'Request confirmation for ' + reason,
    createdAt,
    expiresAt
  });
  return approveExactConnectedOperationBatch({
    root,
    request,
    id,
    actor,
    reason,
    createdAt
  });
}

function notionProbeStepResponse(checkpoint, identityMarker, driftStepId = null) {
  const source = checkpoint.plan.steps.find((step) => step.id === checkpoint.currentStepId);
  if (source.kind === 'identity') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          metadata: { type: 'self' },
          self: {
            workspace: { id: 'workspace.selftest', name: identityMarker },
            user: { id: 'user.selftest', name: identityMarker }
          }
        })
      }],
      isError: false
    };
  }
  if (source.kind === 'schema') {
    const schema = Object.fromEntries(source.scope.expectedFields.map((field) => {
      return [field.provider, { name: field.provider, type: field.providerType }];
    }));
    if (source.id === driftStepId) {
      const field = source.scope.expectedFields[0];
      schema[field.provider].type = 'unexpected-selftest-type';
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          metadata: { type: 'data_source' },
          title: 'Private target title ' + identityMarker,
          url: 'https://notion.invalid/private-target',
          text: '<data-source url="{{' + source.scope.targetUri + '}}">\n'
            + '<data-source-state>\n'
            + JSON.stringify({ schema })
            + '\n</data-source-state>\n</data-source>'
        })
      }],
      isError: false
    };
  }
  if (source.kind === 'document') {
    return notionPageResponse({
      uri: source.scope.input.uri,
      title: source.id === driftStepId
        ? 'Drifted policy title'
        : source.scope.input.expectedTitle,
      body: '# Synthetic policy\n\nPrivate probe body ' + identityMarker + '.',
      privateMarker: identityMarker
    });
  }
  return {
    structuredContent: {
      result: { results: [], has_more: false }
    }
  };
}

function notionTaskReadResponse(id, fields, privateMarker = null) {
  return {
    structuredContent: {
      result: {
        results: [{
          __soterType: 'task',
          __soterId: id,
          __soterFields: JSON.stringify({
            ...fields,
            projectUris: JSON.stringify(fields.projectUris)
          })
        }],
        has_more: false
      }
    },
    ...(privateMarker ? { privateMarker } : {})
  };
}

function notionSummaryReadResponse(id, fields, privateMarker = null) {
  return {
    structuredContent: {
      result: {
        results: [{
          __soterType: 'meeting-summary',
          __soterId: id,
          __soterFields: JSON.stringify(fields)
        }],
        has_more: false
      }
    },
    ...(privateMarker ? { privateMarker } : {})
  };
}

function notionTaskVersion(id, fields) {
  return fingerprintJson({ type: 'task', id, fields });
}

function notionUpdateResponse(id, privateMarker = null) {
  return {
    structuredContent: { result: { id } },
    ...(privateMarker ? { privateMarker } : {})
  };
}

function notionCreateResponse(id, privateMarker = null) {
  return {
    structuredContent: { result: { url: id } },
    ...(privateMarker ? { privateMarker } : {})
  };
}

function notionPageResponse({ uri, title, body, privateMarker = null }) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        metadata: { type: 'page' },
        title,
        url: uri,
        text: 'Here is the result of "view" for the requested page.\n'
          + '<page url="' + uri + '">\n'
          + '<ancestor-path></ancestor-path>\n'
          + '<properties>{"title":' + JSON.stringify(title) + '}</properties>\n'
          + body + '\n'
          + '</page>'
      })
    }],
    isError: false,
    ...(privateMarker ? { privateMarker } : {})
  };
}

function applicablePolicySources(lock) {
  return lock.sources.flatMap((source) => {
    const consumer = source.consumers.find((item) => {
      return item.pack === 'automation.meeting-intake'
        && item.purpose === 'applicable-policy';
    });
    if (!consumer) return [];
    return [{
      id: source.id.slice('source.'.length),
      sourceId: source.id,
      subjects: consumer.subjects,
      title: source.input.expectedTitle,
      documentUri: source.input.uri,
      reason: consumer.reason
    }];
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

async function completeContextPolicyBodies({ root, execution, bindings, atSecond, markerPrefix }) {
  let current = execution;
  const markers = [];
  for (const [index, binding] of [...bindings]
    .sort((left, right) => left.id.localeCompare(right.id, 'en')).entries()) {
    const marker = markerPrefix ? markerPrefix + index : null;
    if (marker) markers.push(marker);
    current = await completeDurableOperationPlanExecution({
      root,
      checkpointId: current.checkpoint.id,
      callId: current.currentCall.id,
      response: notionPageResponse({
        uri: binding.documentUri,
        title: binding.title,
        body: '# ' + binding.title + '\n\nSynthetic applicable policy body ' + index + '.',
        privateMarker: marker
      }),
      at: atSecond + '.' + String(index + 1).padStart(3, '0') + 'Z',
      expectedHost: 'codex'
    });
  }
  return { execution: current, markers };
}

function copyExternalPackArtifacts(sourceRoot, targetRoot) {
  const packDir = path.join(sourceRoot, 'soter', 'packs');
  for (const entry of fs.readdirSync(packDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(packDir, entry.name, 'pack.json');
    if (!fs.existsSync(manifestPath)) continue;
    const pack = readJson(manifestPath);
    for (const artifact of pack.artifacts || []) {
      const source = path.resolve(sourceRoot, artifact.path);
      const relative = path.relative(sourceRoot, source);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
        || relative === 'soter' || relative.startsWith('soter' + path.sep)
        || !fs.existsSync(source)) {
        continue;
      }
      const target = path.resolve(targetRoot, artifact.path);
      const targetRelative = path.relative(targetRoot, target);
      if (targetRelative === '..' || targetRelative.startsWith('..' + path.sep)
        || path.isAbsolute(targetRelative)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.statSync(source).isDirectory()) {
        fs.cpSync(source, target, { recursive: true });
      } else {
        fs.copyFileSync(source, target);
      }
    }
  }
}

function selftestProviderProbes(lock, providers) {
  const base = {
    $contract: 'soter://contracts/provider-probe/v1',
    contractVersion: '1.0.0',
    probedAt: '2026-07-15T11:55:00.000Z',
    validUntil: '2026-07-15T12:05:00.000Z',
    configuration: {
      name: lock.configuration.name,
      lockFingerprint: fingerprintLock(lock)
    },
    reachability: {
      state: 'passed',
      details: 'Injected selftest transport responded without making a network request.',
      latencyMs: 0
    },
    secretValuesExcluded: true,
    limitations: [
      'Selftest observations prove Core aggregation behavior only, not a live provider connection.'
    ]
  };
  return [
    {
      ...structuredClone(base),
      id: 'probe.integration.notion.connected-selftest',
      provider: {
        pack: providers.notion.pack,
        implementation: providers.notion.id,
        version: providers.notion.version,
        containment: 'connected'
      },
      credentials: [
        {
          secretRefId: 'secret-ref.notion',
          state: 'passed',
          details: 'The injected resolver reported an authenticated Notion identity.'
        }
      ],
      authorities: [
        {
          id: 'authority.crm.definition',
          state: 'passed',
          details: 'The configured CRM definition authority was visible.'
        },
        {
          id: 'authority.crm.instance',
          state: 'passed',
          details: 'The configured CRM instance authority was visible.'
        }
      ],
      capabilities: [
        {
          id: 'crm.records.read',
          state: 'passed',
          method: 'read-only',
          details: 'A schema-compatible read-only response was observed.'
        },
        {
          id: 'documents.content.read',
          state: 'passed',
          method: 'read-only',
          details: 'Every exact configured title-bound document source normalized successfully.'
        },
        {
          id: 'crm.records.create',
          state: 'passed',
          method: 'permission-introspection',
          details: 'Required create permissions were reported without creating a record.'
        },
        {
          id: 'crm.records.update',
          state: 'passed',
          method: 'permission-introspection',
          details: 'Required update permissions were reported without updating a record.'
        }
      ]
    },
    {
      ...structuredClone(base),
      id: 'probe.integration.otter.connected-selftest',
      provider: {
        pack: providers.otter.pack,
        implementation: providers.otter.id,
        version: providers.otter.version,
        containment: 'connected'
      },
      credentials: [
        {
          secretRefId: 'secret-ref.otter',
          state: 'passed',
          details: 'The injected resolver reported an authenticated Otter identity.'
        }
      ],
      authorities: [
        {
          id: 'authority.otter.provider',
          state: 'passed',
          details: 'The configured transcript authority was visible.'
        }
      ],
      capabilities: [
        {
          id: 'meeting.transcript.read',
          state: 'passed',
          method: 'read-only',
          details: 'A schema-compatible read-only transcript response was observed.'
        }
      ]
    }
  ];
}

export async function selftest(root) {
  const failures = [];
  const meetingIntakeConfigPath = 'soter/configurations/meeting-intake.config.json';
  const inputSummary = readJson(path.join(
    root,
    'soter/fixtures/operator-inspection/input-summary.json'
  ));
  const hostileInputSummary = structuredClone(inputSummary);
  hostileInputSummary.fields.find((field) => field.exposure === 'private').value
    = 'private-input-value-sentinel';
  const hostileInputFailures = validateJsonSchema(
    hostileInputSummary,
    readJson(path.join(root, 'soter/contracts/operator-input-summary.schema.json'))
  );
  if (!hostileInputFailures.length) {
    failures.push('private operator input summary represented a raw private value');
  }
  let ambiguousDefaultRejected = false;
  try {
    resolveConfiguration({ root });
  } catch (error) {
    ambiguousDefaultRejected = error.message.includes('Expected exactly one default configuration');
  }
  if (!ambiguousDefaultRejected) failures.push('resolver selected an implicit default with multiple configurations');
  const first = resolveConfiguration({ root, configPath: meetingIntakeConfigPath });
  const second = resolveConfiguration({ root, configPath: meetingIntakeConfigPath });
  const projectPulse = resolveConfiguration({
    root,
    configPath: 'soter/configurations/project-pulse.config.json'
  });
  const claude = resolveConfiguration({ root, configPath: meetingIntakeConfigPath, host: 'claude' });
  const claudeMatch = lockMatchesResolution({ lock: claude, root });
  const meetingMatch = lockMatchesResolution({ lock: first, root });
  const projectPulseMatch = lockMatchesResolution({ lock: projectPulse, root });
  const defaultView = buildConfigurationView({ root, lock: first });
  const repeatedView = buildConfigurationView({ root, lock: second });
  const claudeView = buildConfigurationView({ root, lock: claude });
  const lockedView = buildConfigurationView({ root, lock: first, basis: 'lock' });
  const formattedView = formatConfigurationView(defaultView);
  if (fingerprintLock(first) !== fingerprintLock(second)) {
    failures.push('unchanged inputs did not produce a deterministic lock');
  }
  const staticVerification = verifySoter(root, { includeRuntimeArtifacts: false });
  const promotedResolution = structuredClone(staticVerification.resolvedConfigurations.find((item) => {
    return item.name === first.configuration.name;
  }));
  promotedResolution.host.evidenceMaturity = 'fixture-proven';
  promotedResolution.selections.forEach((selection) => {
    selection.evidenceMaturity = 'fixture-proven';
  });
  const promotedLock = structuredClone(first);
  promotedLock.packs.forEach((pack) => {
    pack.evidenceMaturity = 'fixture-proven';
  });
  delete promotedLock.graphFingerprint;
  promotedLock.graphFingerprint = fingerprintJson(promotedLock);
  const maturityEvidence = ({ kind, id, version, evidenceId }) => {
    const record = createResolutionEvidence({
      lock: promotedLock,
      id: evidenceId,
      createdAt: '2026-07-16T12:00:00.000Z'
    });
    return {
      ...record,
      claimFamily: 'behavior',
      claim: 'The exact selected component passed its declared fixture behavior evaluation.',
      subject: { type: kind, id, version },
      evaluator: { id: 'core.maturity-selftest', version: '1.0.0', level: 'fixture' },
      environment: { containment: 'fixture', runtime: 'node' },
      acceptanceCriteria: ['The selected component satisfied every declared fixture behavior criterion.'],
      result: 'passed',
      outcomes: [{ id: 'component.behavior', state: 'passed' }],
      artifacts: [],
      effects: [],
      failures: [],
      warnings: [],
      skipped: [],
      limitations: ['Synthetic selftest evidence proves applicability rules only.']
    };
  };
  const exactMaturityEvidence = [
    maturityEvidence({
      kind: 'host',
      id: promotedResolution.host.adapter,
      version: promotedResolution.host.version,
      evidenceId: 'evidence.maturity.host.fixture'
    }),
    ...promotedResolution.selections.map((selection, index) => maturityEvidence({
      kind: 'pack',
      id: selection.id,
      version: selection.version,
      evidenceId: 'evidence.maturity.pack-' + String(index + 1) + '.fixture'
    }))
  ];
  const supportedMaturity = evaluateConfigurationMaturity({
    lock: promotedLock,
    resolvedConfiguration: promotedResolution,
    evidenceRecords: exactMaturityEvidence,
    at: '2026-07-16T12:00:00.000Z'
  });
  const labelOnlyMaturity = evaluateConfigurationMaturity({
    lock: promotedLock,
    resolvedConfiguration: promotedResolution,
    evidenceRecords: [],
    at: '2026-07-16T12:00:00.000Z'
  });
  const dependencyDriftEvidence = structuredClone(exactMaturityEvidence);
  dependencyDriftEvidence[0].dependencies[0].fingerprint = 'sha256:' + '0'.repeat(64);
  const driftedMaturity = evaluateConfigurationMaturity({
    lock: promotedLock,
    resolvedConfiguration: promotedResolution,
    evidenceRecords: dependencyDriftEvidence,
    at: '2026-07-16T12:00:00.000Z'
  });
  const failedEvidence = structuredClone(exactMaturityEvidence);
  failedEvidence[0].result = 'failed';
  failedEvidence[0].failures = ['Planted behavior failure.'];
  const failedMaturity = evaluateConfigurationMaturity({
    lock: promotedLock,
    resolvedConfiguration: promotedResolution,
    evidenceRecords: failedEvidence,
    at: '2026-07-16T12:00:00.000Z'
  });
  const staleEvidence = structuredClone(exactMaturityEvidence);
  staleEvidence[0].freshness.validUntil = '2026-07-15T12:00:00.000Z';
  const staleMaturity = evaluateConfigurationMaturity({
    lock: promotedLock,
    resolvedConfiguration: promotedResolution,
    evidenceRecords: staleEvidence,
    at: '2026-07-16T12:00:00.000Z'
  });
  const runScopedEvidence = exactMaturityEvidence.map((record, index) => ({
    ...record,
    id: 'evidence.maturity.run-' + String(index + 1) + '.fixture',
    subject: { type: 'run', id: 'run.maturity-selftest', version: null }
  }));
  const runScopedMaturity = evaluateConfigurationMaturity({
    lock: promotedLock,
    resolvedConfiguration: promotedResolution,
    evidenceRecords: runScopedEvidence,
    at: '2026-07-16T12:00:00.000Z'
  });
  if (supportedMaturity.verified !== 'passed'
    || supportedMaturity.reasonCode !== 'CONFIGURATION_MATURITY_SUPPORTED'
    || [supportedMaturity.host, ...supportedMaturity.selections].some((item) => {
      return item.state !== 'supported' || item.reasonCode !== 'MATURITY_EVIDENCE_APPLIES';
    })
    || labelOnlyMaturity.verified !== 'unknown'
    || [labelOnlyMaturity.host, ...labelOnlyMaturity.selections].some((item) => item.state !== 'unsupported')
    || driftedMaturity.verified !== 'unknown'
    || failedMaturity.verified !== 'failed'
    || staleMaturity.verified !== 'stale'
    || runScopedMaturity.verified !== 'unknown') {
    failures.push('maturity support was inferred without exact applicable subject-scoped evidence');
  }
  const portableLockFields = [
    'packs', 'dependencies', 'capabilities', 'bindings', 'sources', 'authorities',
    'effectPolicies', 'settings'
  ];
  if (first.configuration.hostSelection.source !== 'configuration'
    || claude.configuration.hostSelection.id !== 'claude'
    || claude.configuration.hostSelection.source !== 'override'
    || first.host.id !== 'codex'
    || claude.host.id !== 'claude'
    || first.configuration.fingerprint !== claude.configuration.fingerprint
    || portableLockFields.some((field) => {
      return fingerprintJson(first[field]) !== fingerprintJson(claude[field]);
    })
    || fingerprintJson(first.projections) === fingerprintJson(claude.projections)
    || !claudeMatch.matches
    || !meetingMatch.matches
    || !projectPulseMatch.matches
    || meetingMatch.expected.configuration.name !== 'meeting-intake'
    || projectPulseMatch.expected.configuration.name !== 'project-pulse') {
    failures.push('explicit host selection changed portable configuration or could not reproduce its own lock');
  }
  let unknownHostRejected = false;
  try {
    resolveConfiguration({ root, configPath: meetingIntakeConfigPath, host: 'not-a-host' });
  } catch (error) {
    unknownHostRejected = error.message.includes('Unknown Soter host');
  }
  if (!unknownHostRejected) {
    failures.push('resolver accepted an unknown host override');
  }
  if (defaultView.viewFingerprint !== repeatedView.viewFingerprint
    || defaultView.basis.lockFingerprint !== fingerprintLock(first)
    || defaultView.systems.length !== first.packs.length
    || defaultView.systems.some((system) => !system.summary || !system.selection.reason)
    || defaultView.host.selectionSource !== 'configuration'
    || claudeView.host.selectionSource !== 'override'
    || claudeView.host.id !== 'claude'
    || claudeView.configuration.configuredDefaultHost !== 'codex'
    || claudeView.viewFingerprint === defaultView.viewFingerprint
    || lockedView.basis.kind !== 'lock'
    || lockedView.viewFingerprint === defaultView.viewFingerprint
    || defaultView.states.valid !== 'passed'
    || ['ready', 'verified', 'healthy'].some((state) => {
      return defaultView.states[state] !== 'unknown';
    })
    || !formattedView.includes('Included by base:')
    || !formattedView.includes('write=confirm')
    || !formattedView.includes('ready=unknown')) {
    failures.push('configuration view was not deterministic, explainable, host-aware, and honest');
  }
  if (JSON.stringify(first).includes('secret-ref') || JSON.stringify(first).includes('OAUTH')) {
    failures.push('configuration lock contains credential-reference material');
  }
  if (first.sources.length !== 3
    || first.sources.some((source) => {
      return source.inputFingerprint !== fingerprintJson(source.input)
        || source.capability !== 'documents.content.read'
        || source.authority !== 'authority.crm.definition'
        || source.readiness.mode !== 'probe-read'
        || source.consumers.length !== 1;
    })) {
    failures.push('resolved lock did not preserve exact portable source wiring and fingerprints');
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-core-'));
  try {
    fs.cpSync(path.join(root, 'soter'), path.join(temp, 'soter'), { recursive: true });
    copyExternalPackArtifacts(root, temp);
    fs.copyFileSync(path.join(root, 'AGENTS.md'), path.join(temp, 'AGENTS.md'));
    fs.copyFileSync(path.join(root, 'CLAUDE.md'), path.join(temp, 'CLAUDE.md'));
    fs.cpSync(path.join(root, '.codex'), path.join(temp, '.codex'), { recursive: true });
    fs.cpSync(path.join(root, '.claude'), path.join(temp, '.claude'), { recursive: true });
    const connectedNotion = readJson(path.join(
      temp,
      'soter/providers/provider.integration.notion.mcp.json'
    ));
    const connectedProviders = {
      notion: connectedNotion,
      notionWrites: connectedNotion,
      otter: readJson(path.join(
        temp,
        'soter/providers/provider.integration.otter.mcp.json'
      ))
    };
    const lock = resolveConfiguration({ root: temp, configPath: meetingIntakeConfigPath });
    const claudeLock = resolveConfiguration({ root: temp, configPath: meetingIntakeConfigPath, host: 'claude' });
    const lockPath = 'soter/fixtures/meeting-intake/meeting-intake.lock.json';
    writeJson(path.join(temp, lockPath), lock);

    const preparedOtterProbe = await prepareProviderProbeCall({
      root: temp,
      lock,
      providerImplementation: connectedProviders.otter.id,
      callId: 'probecall.selftest.otter-identity',
      probeId: 'probe.integration.otter.identity-selftest',
      at: FIXTURE_TIME
    });
    const identityMarker = 'private-identity-selftest-marker';
    const completedOtterProbe = await completeProviderProbeCall({
      root: temp,
      lock,
      call: preparedOtterProbe.call,
      response: {
        structuredContent: {
          result: identityMarker
        }
      },
      at: FIXTURE_TIME
    });
    if (preparedOtterProbe.call.state !== 'requested'
      || preparedOtterProbe.call.transport.operation !== 'get_user_info'
      || preparedOtterProbe.call.transport.tool !== 'mcp__otter__get_user_info'
      || Object.keys(preparedOtterProbe.call.arguments).length !== 0
      || completedOtterProbe.call.state !== 'completed'
      || completedOtterProbe.probe?.reachability.state !== 'passed'
      || completedOtterProbe.probe?.capabilities[0]?.state !== 'unknown'
      || JSON.stringify(completedOtterProbe).includes(identityMarker)) {
      failures.push('Otter identity probe did not preserve safe request scope and honest capability state');
    }
    const widenedOtterProbe = await completeProviderProbeCall({
      root: temp,
      lock,
      call: preparedOtterProbe.call,
      response: { structuredContent: { result: 'synthetic identity' } },
      at: FIXTURE_TIME,
      translator: {
        completeProbeMcp({ plan }) {
          return {
            credentials: plan.credentialRefs.map((secretRefId) => ({
              secretRefId,
              state: 'passed',
              details: 'Synthetic credential observation.'
            })),
            reachability: {
              state: 'passed',
              details: 'Synthetic reachability observation.'
            },
            authorities: plan.authorities.map((id) => ({
              id,
              state: 'passed',
              details: 'Synthetic authority observation.'
            })),
            capabilities: [
              ...plan.capabilities.map((id) => ({
                id,
                state: 'unknown',
                method: 'metadata',
                details: 'Synthetic capability observation.'
              })),
              {
                id: 'crm.records.read',
                state: 'passed',
                method: 'metadata',
                details: 'This observation is deliberately outside the probe plan.'
              }
            ],
            limitations: ['Synthetic widened-scope probe must fail.']
          };
        }
      }
    });
    if (widenedOtterProbe.call.state !== 'failed'
      || widenedOtterProbe.call.error.kind !== 'validation') {
      failures.push('provider probe translator widened the exact locked observation plan');
    }
    const failedOtterProbe = failProviderProbeCall({
      root: temp,
      lock,
      call: preparedOtterProbe.call,
      error: Object.assign(new Error('Injected probe transport failure.'), {
        kind: 'unavailable'
      }),
      at: FIXTURE_TIME
    });
    if (failedOtterProbe.state !== 'failed'
      || failedOtterProbe.error.kind !== 'unavailable') {
      failures.push('provider probe host failure was not normalized into the portable error vocabulary');
    }

    const preparedNotionProbe = await prepareProviderProbeCall({
      root: temp,
      lock,
      providerImplementation: connectedProviders.notion.id,
      callId: 'probecall.selftest.notion-identity',
      probeId: 'probe.integration.notion.identity-selftest',
      at: FIXTURE_TIME
    });
    const notionIdentityMarker = 'private-notion-identity-selftest-marker';
    const completedNotionProbe = await completeProviderProbeCall({
      root: temp,
      lock,
      call: preparedNotionProbe.call,
      response: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              metadata: { type: 'self' },
              self: {
                workspace: { id: 'workspace.selftest', name: notionIdentityMarker },
                user: { id: 'user.selftest', name: notionIdentityMarker }
              }
            })
          }
        ],
        isError: false
      },
      at: FIXTURE_TIME
    });
    if (preparedNotionProbe.call.state !== 'requested'
      || preparedNotionProbe.call.transport.operation !== 'fetch'
      || preparedNotionProbe.call.transport.tool !== 'mcp__codex_apps__notion_fetch'
      || preparedNotionProbe.call.arguments.id !== 'self'
      || completedNotionProbe.call.state !== 'completed'
      || completedNotionProbe.probe?.reachability.state !== 'passed'
      || completedNotionProbe.probe?.authorities.some((item) => item.state !== 'unknown')
      || completedNotionProbe.probe?.capabilities.some((item) => item.state !== 'unknown')
      || JSON.stringify(completedNotionProbe).includes(notionIdentityMarker)) {
      failures.push('Notion identity probe did not preserve native routing, minimization, and honest unknown states');
    }

    const notionPlanMarker = 'private-notion-plan-selftest-marker';
    let notionPlan = await prepareDurableProviderProbeExecution({
      root: temp,
      lockPath,
      providerImplementation: connectedProviders.notion.id,
      probeId: 'probe.integration.notion.plan-selftest',
      at: FIXTURE_TIME,
      validForSeconds: 300
    });
    const firstNotionPlanCall = notionPlan.currentCall;
    const firstNotionPlanResponse = notionProbeStepResponse(
      notionPlan.checkpoint,
      notionPlanMarker
    );
    notionPlan = await completeDurableProviderProbeExecution({
      root: temp,
      checkpointId: notionPlan.checkpoint.id,
      callId: firstNotionPlanCall.id,
      response: firstNotionPlanResponse,
      at: FIXTURE_TIME
    });
    const repeatedNotionPlanStep = await completeDurableProviderProbeExecution({
      root: temp,
      checkpointId: notionPlan.checkpoint.id,
      callId: firstNotionPlanCall.id,
      response: firstNotionPlanResponse,
      at: FIXTURE_TIME
    });
    if (repeatedNotionPlanStep.checkpoint.checkpointFingerprint
      !== notionPlan.checkpoint.checkpointFingerprint
      || repeatedNotionPlanStep.currentCall?.id !== notionPlan.currentCall?.id) {
      failures.push('Notion probe plan did not idempotently recover a repeated completed step response');
    }
    let notionPlanCalls = 1;
    while (notionPlan.checkpoint.state === 'requested') {
      const currentCall = notionPlan.currentCall;
      const response = notionProbeStepResponse(
        notionPlan.checkpoint,
        notionPlanMarker
      );
      notionPlan = await completeDurableProviderProbeExecution({
        root: temp,
        checkpointId: notionPlan.checkpoint.id,
        callId: currentCall.id,
        response,
        at: FIXTURE_TIME
      });
      notionPlanCalls += 1;
    }
    const notionPlanState = fs.readFileSync(
      path.join(temp, notionPlan.checkpointPath),
      'utf8'
    );
    const taskSchemaStep = notionPlan.checkpoint.plan.steps.find((step) => {
      return step.id === 'step.record.task.schema';
    });
    const taskReadStep = notionPlan.checkpoint.plan.steps.find((step) => {
      return step.id === 'step.record.task.read';
    });
    const taskPolicyReadStep = notionPlan.checkpoint.plan.steps.find((step) => {
      return step.id === 'step.record.task-capture-policy.read';
    });
    const policyReadStep = notionPlan.checkpoint.plan.steps.find((step) => {
      return step.id === 'step.record.policy.read';
    });
    if (notionPlanCalls !== 20
      || notionPlan.checkpoint.state !== 'completed'
      || notionPlan.checkpoint.result?.$contract !== 'soter://contracts/provider-probe/v2'
      || notionPlan.checkpoint.result?.checks.length !== 20
      || notionPlan.checkpoint.result?.checks.some((check) => check.state !== 'passed')
      || notionPlan.checkpoint.result?.checks.filter((check) => {
        return check.kind === 'document' && check.method === 'read-only';
      }).length !== 3
      || notionPlan.checkpoint.result?.capabilities.find((item) => {
        return item.id === 'crm.records.read';
      })?.state !== 'passed'
      || notionPlan.checkpoint.result?.capabilities.find((item) => {
        return item.id === 'documents.content.read';
      })?.state !== 'passed'
      || notionPlan.checkpoint.result?.capabilities.filter((item) => {
        return item.id === 'crm.records.create' || item.id === 'crm.records.update';
      }).some((item) => item.state !== 'unknown')
      || taskSchemaStep?.scope.expectedFields.find((field) => {
        return field.portable === 'nextActionOn';
      })?.providerType !== 'date'
      || !taskReadStep?.arguments?.data?.query?.includes('date:Next Action:start')
      || taskPolicyReadStep?.scope.targetUri !== policyReadStep?.scope.targetUri
      || notionPlan.currentCall !== null
      || JSON.stringify(notionPlan).includes(notionPlanMarker)
      || notionPlanState.includes(notionPlanMarker)
      || notionPlanState.includes('automation.meeting-intake')
      || notionPlanState.includes('"consumers"')) {
      failures.push(
        'Notion probe plan did not sequence, minimize, and close exact schema, record-read, and document-read checks: '
          + JSON.stringify({
            calls: notionPlanCalls,
            state: notionPlan.checkpoint.state,
            contract: notionPlan.checkpoint.result?.$contract || null,
            checks: notionPlan.checkpoint.result?.checks?.length || null,
            capabilities: notionPlan.checkpoint.result?.capabilities || null,
            currentCall: notionPlan.currentCall?.id || null,
            markerInResult: JSON.stringify(notionPlan).includes(notionPlanMarker),
            markerInState: notionPlanState.includes(notionPlanMarker),
            consumerWiringInState: notionPlanState.includes('automation.meeting-intake')
              || notionPlanState.includes('"consumers"'),
            failedStep: notionPlan.checkpoint.steps.find((step) => step.state === 'failed')?.id || null,
            error: notionPlan.checkpoint.steps.find((step) => step.state === 'failed')?.error || null
          })
      );
    }

    let driftedNotionPlan = await prepareDurableProviderProbeExecution({
      root: temp,
      lockPath,
      providerImplementation: connectedProviders.notion.id,
      probeId: 'probe.integration.notion.schema-drift-selftest',
      at: FIXTURE_TIME,
      validForSeconds: 300
    });
    const driftStepId = 'step.record.organization.schema';
    while (driftedNotionPlan.checkpoint.state === 'requested') {
      const currentCall = driftedNotionPlan.currentCall;
      const response = notionProbeStepResponse(
        driftedNotionPlan.checkpoint,
        notionPlanMarker,
        driftStepId
      );
      driftedNotionPlan = await completeDurableProviderProbeExecution({
        root: temp,
        checkpointId: driftedNotionPlan.checkpoint.id,
        callId: currentCall.id,
        response,
        at: FIXTURE_TIME
      });
    }
    const driftedStep = driftedNotionPlan.checkpoint.steps.find((step) => {
      return step.id === driftStepId;
    });
    if (driftedNotionPlan.checkpoint.state !== 'failed'
      || driftedStep?.error?.kind !== 'validation'
      || driftedNotionPlan.checkpoint.result !== null) {
      failures.push('Notion probe plan did not fail closed on mapped provider schema drift');
    }

    let mismatchedDocumentPlan = await prepareDurableProviderProbeExecution({
      root: temp,
      lockPath,
      providerImplementation: connectedProviders.notion.id,
      probeId: 'probe.integration.notion.document-mismatch-selftest',
      at: FIXTURE_TIME,
      validForSeconds: 300
    });
    const mismatchedDocumentStepId = 'step.source.policy.meetings.document';
    while (mismatchedDocumentPlan.checkpoint.state === 'requested') {
      const currentCall = mismatchedDocumentPlan.currentCall;
      mismatchedDocumentPlan = await completeDurableProviderProbeExecution({
        root: temp,
        checkpointId: mismatchedDocumentPlan.checkpoint.id,
        callId: currentCall.id,
        response: notionProbeStepResponse(
          mismatchedDocumentPlan.checkpoint,
          notionPlanMarker,
          mismatchedDocumentStepId
        ),
        at: FIXTURE_TIME
      });
    }
    const mismatchedDocumentStep = mismatchedDocumentPlan.checkpoint.steps.find((step) => {
      return step.id === mismatchedDocumentStepId;
    });
    if (mismatchedDocumentPlan.checkpoint.state !== 'failed'
      || mismatchedDocumentStep?.error?.kind !== 'conflict'
      || mismatchedDocumentPlan.checkpoint.result !== null) {
      failures.push('Notion probe plan did not fail closed on exact document title mismatch');
    }

    const resolutionEvidence = createResolutionEvidence({
      lock,
      id: 'evidence.meeting-intake.resolution.fixture',
      createdAt: FIXTURE_TIME
    });
    const envelope = prepareRunEnvelope({
      root: temp,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/meeting-intake/happy-path.scenario.json',
      runId: 'run.meeting-intake.fixture',
      createdAt: FIXTURE_TIME,
      evidenceIds: [
        resolutionEvidence.id,
        'evidence.meeting-intake.preparation.fixture'
      ]
    });
    const preparationEvidence = createRunPreparationEvidence({
      lock,
      envelope,
      id: 'evidence.meeting-intake.preparation.fixture',
      createdAt: FIXTURE_TIME
    });
    const doctor = runOfflineDoctor({
      root: temp,
      lock,
      doctorId: 'doctor.meeting-intake.fixture',
      evidenceId: 'evidence.meeting-intake.doctor.fixture',
      createdAt: FIXTURE_TIME
    });
    const connectedWithoutProbes = runConnectedDoctor({
      root: temp,
      lock,
      doctorId: 'doctor.meeting-intake.connected-fixture',
      evidenceId: 'evidence.meeting-intake.doctor.fixture',
      createdAt: FIXTURE_TIME,
      providerProbes: []
    });
    const probes = selftestProviderProbes(lock, connectedProviders);
    const connected = runConnectedDoctor({
      root: temp,
      lock,
      doctorId: 'doctor.meeting-intake.connected-selftest',
      evidenceId: 'evidence.meeting-intake.doctor.fixture',
      createdAt: FIXTURE_TIME,
      providerProbes: probes
    });
    const failedOtterAttempt = {
      $contract: 'soter://contracts/provider-probe-attempt/v1',
      contractVersion: '1.0.0',
      id: 'probeattempt.selftest.otter-unavailable',
      probeId: 'probe.integration.otter.unavailable-selftest',
      checkpointId: 'checkpoint.probecall.selftest.otter-unavailable',
      attemptedAt: '2026-07-15T11:58:00.000Z',
      failedAt: '2026-07-15T11:59:00.000Z',
      validUntil: '2026-07-15T12:04:00.000Z',
      state: 'failed',
      configuration: {
        name: lock.configuration.name,
        lockFingerprint: fingerprintLock(lock)
      },
      host: {
        id: lock.host.id,
        adapter: lock.host.adapter,
        version: lock.host.version
      },
      provider: {
        pack: connectedProviders.otter.pack,
        implementation: connectedProviders.otter.id,
        version: connectedProviders.otter.version,
        containment: 'connected'
      },
      scope: {
        credentialRefs: ['secret-ref.otter'],
        authorities: ['authority.otter.provider'],
        capabilities: ['meeting.transcript.read']
      },
      failure: {
        kind: 'unavailable',
        errorFingerprint: 'sha256:' + '1'.repeat(64),
        step: null,
        callId: 'probecall.selftest.otter-unavailable',
        transport: {
          protocol: 'mcp',
          server: 'otter',
          operation: 'get_user_info',
          tool: 'mcp__otter__get_user_info'
        }
      },
      sourceCheckpointFingerprint: 'sha256:' + '2'.repeat(64),
      privacy: {
        scope: 'private',
        rawProviderResponsePersisted: false,
        hostCredentialValuesPersisted: false,
        providerArgumentsIncluded: false,
        providerErrorMessageIncluded: false
      }
    };
    const connectedWithFailedAttempt = runConnectedDoctor({
      root: temp,
      lock,
      doctorId: 'doctor.meeting-intake.failed-attempt-selftest',
      evidenceId: 'evidence.meeting-intake.doctor.fixture',
      createdAt: FIXTURE_TIME,
      providerProbes: probes.filter((probe) => {
        return probe.provider.implementation !== connectedProviders.otter.id;
      }),
      providerProbeAttempts: [failedOtterAttempt]
    });
    const expiredOtterAttempt = structuredClone(failedOtterAttempt);
    expiredOtterAttempt.validUntil = '2026-07-15T11:59:30.000Z';
    const connectedWithExpiredAttempt = runConnectedDoctor({
      root: temp,
      lock,
      doctorId: 'doctor.meeting-intake.expired-attempt-selftest',
      evidenceId: 'evidence.meeting-intake.doctor.fixture',
      createdAt: FIXTURE_TIME,
      providerProbes: probes.filter((probe) => {
        return probe.provider.implementation !== connectedProviders.otter.id;
      }),
      providerProbeAttempts: [expiredOtterAttempt]
    });
    const contained = await assembleMeetingIntakeContext({
      root: temp,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/meeting-intake/happy-path.scenario.json',
      runId: 'run.meeting-intake.contained-fixture',
      snapshotId: 'context.meeting-intake.contained-fixture',
      createdAt: FIXTURE_TIME,
      meetingId: 'meeting.fixture-001',
      recordingUri: 'otter://fixture/meeting.fixture-001',
      evidenceIds: [
        resolutionEvidence.id,
        'evidence.meeting-intake.context.fixture'
      ]
    });
    const contextEvidence = createContextAssemblyEvidence({
      lock,
      envelope: contained.envelope,
      snapshot: contained.snapshot,
      id: 'evidence.meeting-intake.context.fixture',
      createdAt: FIXTURE_TIME
    });
    const transaction = await runContainedMeetingIntakeTransaction({
      root: temp,
      lock,
      lockPath,
      scenarioPath: 'soter/scenarios/meeting-intake/happy-path.scenario.json',
      runId: 'run.meeting-intake.transaction-fixture',
      snapshotId: 'context.meeting-intake.transaction-fixture',
      decisionId: 'decision.meeting-intake.transaction-fixture',
      changeSetId: 'changeset.meeting-intake.transaction-fixture',
      approvalId: 'approval.meeting-intake.transaction-fixture',
      createdAt: FIXTURE_TIME,
      actor: 'fixture.user',
      approved: true,
      evidenceIds: [
        resolutionEvidence.id,
        'evidence.meeting-intake.transaction.fixture'
      ]
    });
    const scenario = readJson(path.join(temp, 'soter/scenarios/meeting-intake/happy-path.scenario.json'));
    const scenarioChecks = [
      ...scenario.expected.outcomes.map((id) => ({ id, category: 'outcome', state: 'passed' })),
      ...scenario.expected.invariants.map((id) => ({ id, category: 'invariant', state: 'passed' })),
      ...scenario.expected.evidence.map((id) => ({ id, category: 'evidence', state: 'passed' }))
    ];
    const scenarioAssessment = {
      result: 'passed',
      checks: scenarioChecks,
      capabilityOrder: {
        expected: [...scenario.expected.capabilityOrder],
        observed: transaction.envelope.effects.map((effect) => effect.capability),
        state: 'passed'
      },
      effectModes: {
        expected: { ...scenario.expected.effectModes },
        observed: Object.fromEntries(Object.keys(scenario.expected.effectModes).sort().map((effect) => [
          effect,
          transaction.envelope.effectPolicies[effect].mode
        ])),
        state: 'passed'
      },
      observationFingerprint: fingerprintJson({ scenario: scenario.id, state: 'passed' }),
      artifacts: []
    };
    const scenarioEvidenceArguments = {
      lock,
      envelope: transaction.envelope,
      scenario,
      scenarioPath: 'soter/scenarios/meeting-intake/happy-path.scenario.json',
      assessment: scenarioAssessment,
      evaluatorId: 'core.scenario-evidence-selftest',
      id: 'evidence.meeting-intake.scenario-builder-selftest',
      createdAt: FIXTURE_TIME
    };
    const scenarioEvidence = createScenarioExecutionEvidence(scenarioEvidenceArguments);
    const scenarioEvidenceFailures = validateJsonSchema(
      scenarioEvidence,
      readJson(path.join(temp, 'soter/contracts/evidence-v2.schema.json'))
    );
    if (scenarioEvidenceFailures.length) {
      failures.push('scenario evidence builder failed evidence/v1: '
        + scenarioEvidenceFailures.map((item) => item.path + ' ' + item.message).join('; '));
    }
    const hostileScenarioEvidence = [
      {
        label: 'scenario fingerprint drift',
        envelope: { ...transaction.envelope, scenario: { ...transaction.envelope.scenario, fingerprint: fingerprintJson({ drift: true }) } },
        assessment: scenarioAssessment
      },
      {
        label: 'connected containment',
        envelope: {
          ...transaction.envelope,
          effects: transaction.envelope.effects.map((effect, index) => index === 0 ? { ...effect, containment: 'connected' } : effect)
        },
        assessment: scenarioAssessment
      },
      {
        label: 'missing declared check',
        envelope: transaction.envelope,
        assessment: { ...scenarioAssessment, checks: scenarioAssessment.checks.slice(1) }
      }
    ];
    for (const hostile of hostileScenarioEvidence) {
      try {
        createScenarioExecutionEvidence({
          ...scenarioEvidenceArguments,
          envelope: hostile.envelope,
          assessment: hostile.assessment
        });
        failures.push('scenario evidence builder accepted ' + hostile.label);
      } catch {
        // Expected: scenario evidence is an independently validated trust boundary.
      }
    }
    const transactionEvidence = createContainedTransactionEvidence({
      lock,
      envelope: transaction.envelope,
      decision: transaction.decision,
      changeSet: transaction.changeSet,
      approval: transaction.approval,
      id: 'evidence.meeting-intake.transaction.fixture',
      createdAt: FIXTURE_TIME
    });
    const tamperedDecision = structuredClone(transaction.decision);
    tamperedDecision.payload.summary.segmentReferences[0].segmentFingerprint
      = fingerprintJson({ planted: 'tamper' });
    let tamperedDecisionRejected = false;
    try {
      proposeMeetingIntakeChangeSet({
        root: temp,
        lock,
        snapshot: transaction.snapshot,
        decision: tamperedDecision,
        id: 'changeset.meeting-intake.tampered-decision',
        runId: transaction.envelope.id,
        createdAt: FIXTURE_TIME
      });
    } catch (error) {
      tamperedDecisionRejected = error.message.includes('exact context records')
        || error.message.includes('decision fingerprint');
    }
    const ambiguousSnapshot = structuredClone(transaction.snapshot);
    const instanceEntry = ambiguousSnapshot.entries.find((entry) => {
      return entry.id === 'context.crm.instances';
    });
    instanceEntry.value.records.push({
      type: 'task',
      id: 'soter-fixture://crm/task/secondary-deck',
      version: '1',
      fields: {
        title: 'Archive prior launch deck',
        status: 'open',
        projectUris: ['soter-fixture://crm/project/launch']
      }
    });
    instanceEntry.valueFingerprint = fingerprintJson(instanceEntry.value);
    const ambiguousDecision = createMeetingIntakeDecision({
      root: temp,
      lock,
      snapshot: ambiguousSnapshot,
      id: 'decision.meeting-intake.ambiguous-selftest',
      createdAt: FIXTURE_TIME,
      producer: { kind: 'fixture', id: 'fixture.ambiguous-selftest', host: null },
      input: {
        state: 'ready',
        meetingRecordId: transaction.decision.payload.meeting.recordId,
        summarySegmentIndexes: [0, 1],
        tasks: [
          {
            recordId: transaction.decision.payload.tasks[0].recordId,
            disposition: 'fold',
            reason: 'The cited request is the existing launch-deck delivery task, so it should be folded.',
            segmentIndexes: [0]
          },
          {
            recordId: 'soter-fixture://crm/task/secondary-deck',
            disposition: 'ignore',
            reason: 'The cited request concerns sending the updated deck, not archiving a prior deck.',
            segmentIndexes: [0]
          }
        ],
        policies: [],
        issues: [],
        limitations: [
          'This contained ambiguity trial proves explicit candidate disposition, not connected host judgment quality.'
        ]
      }
    });
    const ambiguousProposal = proposeMeetingIntakeChangeSet({
      root: temp,
      lock,
      snapshot: ambiguousSnapshot,
      decision: ambiguousDecision,
      id: 'changeset.meeting-intake.ambiguous-selftest',
      runId: ambiguousSnapshot.runId,
      createdAt: FIXTURE_TIME
    });
    const abstainingDecision = createMeetingIntakeDecision({
      root: temp,
      lock,
      snapshot: ambiguousSnapshot,
      id: 'decision.meeting-intake.abstaining-selftest',
      createdAt: FIXTURE_TIME,
      producer: { kind: 'fixture', id: 'fixture.abstaining-selftest', host: null },
      input: {
        state: 'needs-input',
        meetingRecordId: transaction.decision.payload.meeting.recordId,
        summarySegmentIndexes: [0],
        tasks: ambiguousDecision.payload.tasks.map((task) => ({
          recordId: task.recordId,
          disposition: 'review',
          reason: 'The bounded candidates remain ambiguous and require an explicit user choice before writes.',
          segmentIndexes: [0]
        })),
        policies: [],
        issues: ['Two bounded task candidates remain plausible and require user selection.'],
        limitations: [
          'No task selection or write proposal is valid until the ambiguity is resolved.'
        ]
      }
    });
    let abstentionProposalRejected = false;
    try {
      proposeMeetingIntakeChangeSet({
        root: temp,
        lock,
        snapshot: ambiguousSnapshot,
        decision: abstainingDecision,
        id: 'changeset.meeting-intake.abstaining-selftest',
        runId: ambiguousSnapshot.runId,
        createdAt: FIXTURE_TIME
      });
    } catch (error) {
      abstentionProposalRejected = error.message.includes('requires a ready');
    }
    if (!tamperedDecisionRejected
      || ambiguousProposal.operations.length !== 2
      || ambiguousProposal.operations[0].input.id
        !== transaction.decision.payload.tasks[0].recordId
      || ambiguousProposal.basis.fingerprint !== ambiguousDecision.decisionFingerprint
      || !abstentionProposalRejected) {
      failures.push('Automation decision boundary did not bind exact grounding, explicit ambiguity resolution, and abstention');
    }
    const connectedProposal = proposeMeetingIntakeChangeSet({
      root: temp,
      lock,
      snapshot: transaction.snapshot,
      decision: transaction.decision,
      id: 'changeset.meeting-intake.connected-compile-selftest',
      runId: transaction.decision.runId,
      createdAt: FIXTURE_TIME
    });
    const connectedMeetingIntakeBatch = compileConnectedOperationBatch({
      root: temp,
      lock,
      changeSet: connectedProposal,
      id: 'batch.meeting-intake.connected-compile-selftest',
      createdAt: FIXTURE_TIME
    });
    if (connectedMeetingIntakeBatch.state !== 'proposed'
      || !connectedMeetingIntakeBatch.executable
      || connectedMeetingIntakeBatch.blockers.length
      || connectedMeetingIntakeBatch.operations.at(-1).id !== 'operation.summary.create'
      || connectedMeetingIntakeBatch.operations.at(-1).recovery.mode
        !== 'terminal-idempotent-create'
      || connectedMeetingIntakeBatch.operations.at(-1).contentVerification?.capability
        !== 'documents.content.read') {
      failures.push('connected compiler did not make the deduplicated, content-verifiable create an executable terminal effect');
    }
    writeContextSnapshotState(temp, transaction.snapshot);
    const approvalReviewRunPath = '.soter/state/review-inputs/approval-review-selftest.run.json';
    fs.mkdirSync(path.dirname(path.join(temp, approvalReviewRunPath)), {
      recursive: true,
      mode: 0o700
    });
    writeJson(path.join(temp, approvalReviewRunPath), transaction.envelope);
    const handBuiltBatch = structuredClone(connectedMeetingIntakeBatch);
    handBuiltBatch.operations[0].recovery.reason
      = 'A hand-built recovery explanation must not pass as compiler output.';
    const unsignedHandBuiltBatch = structuredClone(handBuiltBatch);
    delete unsignedHandBuiltBatch.batchFingerprint;
    handBuiltBatch.batchFingerprint = fingerprintJson(unsignedHandBuiltBatch);
    let handBuiltBatchRejected = false;
    try {
      beginConnectedApprovalRequest({
        root: temp,
        lockPath,
        runPath: approvalReviewRunPath,
        batch: handBuiltBatch,
        changeSet: connectedProposal,
        id: 'approval-request.meeting-intake.hand-built-batch-selftest',
        reason: 'A hand-built batch must fail before private review or confirmation.',
        createdAt: FIXTURE_TIME,
        expiresAt: '2026-07-15T12:05:00.000Z'
      });
    } catch (error) {
      handBuiltBatchRejected = error.message.includes('one exact lock, run, batch, and change set');
    }
    const approvalReviewRequestId = 'approval-request.meeting-intake.private-review-selftest';
    beginConnectedApprovalRequest({
      root: temp,
      lockPath,
      runPath: approvalReviewRunPath,
      batch: connectedMeetingIntakeBatch,
      changeSet: connectedProposal,
      id: approvalReviewRequestId,
      reason: 'Request private review of the exact connected batch without granting authority.',
      createdAt: FIXTURE_TIME,
      expiresAt: '2026-07-15T12:05:00.000Z'
    });
    const approvalReview = inspectConnectedApprovalReviewMaterial({
      root: temp,
      requestId: approvalReviewRequestId
    });
    const approvalReviewInspection = inspectConnectedOperatorActivity({
      root: temp,
      requestId: approvalReviewRequestId,
      observedAt: FIXTURE_TIME
    });
    const approvalReviewWorkspaceInspection = inspectWorkspace({ root: temp });
    const updateReview = approvalReview.operations.find((operation) => {
      return operation.capability === 'crm.records.update';
    });
    const createReview = approvalReview.operations.find((operation) => {
      return operation.capability === 'crm.records.create';
    });
    const privateApprovalReviewSentinel = createReview?.after.reviewValue.body;
    let privateReviewBoundariesPassed = handBuiltBatchRejected
      && approvalReview.$contract
        === 'soter://contracts/connected-approval-review-material/v1'
      && approvalReview.configuration.applicability.state === 'current'
      && approvalReview.completeness.state === 'complete'
      && updateReview?.before.reviewValue.fields.context === 'Project'
      && updateReview?.after.reviewValue.fields.context === 'Meeting'
      && createReview?.before.state === 'absent-required'
      && typeof privateApprovalReviewSentinel === 'string'
      && privateApprovalReviewSentinel.length > 0
      && !JSON.stringify(approvalReviewInspection).includes(privateApprovalReviewSentinel)
      && !JSON.stringify(approvalReviewWorkspaceInspection).includes(privateApprovalReviewSentinel)
      && approvalReview.privacy.authority === 'none'
      && !Object.hasOwn(approvalReview, 'approval')
      && !Object.hasOwn(approvalReview, 'continuationRequest')
      && !Object.hasOwn(approvalReview, 'permittedNextAction')
      && !fs.existsSync(path.join(temp, '.soter/state/connected-approval-review'));
    const resignApprovalReview = (material) => {
      for (const operation of material.operations) {
        const unsignedOperation = structuredClone(operation);
        delete unsignedOperation.operationFingerprint;
        operation.operationFingerprint = fingerprintJson(unsignedOperation);
      }
      const unsignedMaterial = structuredClone(material);
      delete unsignedMaterial.fingerprint;
      delete unsignedMaterial.configuration.applicability;
      material.fingerprint = fingerprintJson(unsignedMaterial);
      return material;
    };
    const rawProviderReview = structuredClone(approvalReview);
    rawProviderReview.operations[0].after.rawProviderResponse = 'HOSTILE_RAW_PROVIDER_RESPONSE';
    try {
      assertConnectedApprovalReviewMaterial(
        temp,
        rawProviderReview,
        readJson(path.join(
          temp,
          '.soter/state/approval-requests/' + approvalReviewRequestId + '.json'
        ))
      );
      privateReviewBoundariesPassed = false;
    } catch (error) {
      privateReviewBoundariesPassed &&=
        error.code === 'CONNECTED_APPROVAL_REVIEW_MATERIAL_MALFORMED';
    }
    const reboundReview = structuredClone(approvalReview);
    reboundReview.operations[0].after.reviewValue.fields.context = 'HOSTILE_REBOUND_VALUE';
    reboundReview.operations[0].after.fingerprint = fingerprintJson(
      reboundReview.operations[0].after.reviewValue
    );
    resignApprovalReview(reboundReview);
    try {
      assertConnectedApprovalReviewMaterial(
        temp,
        reboundReview,
        readJson(path.join(
          temp,
          '.soter/state/approval-requests/' + approvalReviewRequestId + '.json'
        ))
      );
      privateReviewBoundariesPassed = false;
    } catch (error) {
      privateReviewBoundariesPassed &&=
        error.code === 'CONNECTED_APPROVAL_REVIEW_MATERIAL_BINDING_INVALID';
    }
    const credentialReview = structuredClone(approvalReview);
    credentialReview.operations[0].after.reviewValue.secret = 'private-credential-sentinel';
    credentialReview.operations[0].after.fingerprint = fingerprintJson(
      credentialReview.operations[0].after.reviewValue
    );
    resignApprovalReview(credentialReview);
    try {
      assertConnectedApprovalReviewMaterial(
        temp,
        credentialReview,
        readJson(path.join(
          temp,
          '.soter/state/approval-requests/' + approvalReviewRequestId + '.json'
        ))
      );
      privateReviewBoundariesPassed = false;
    } catch (error) {
      privateReviewBoundariesPassed &&=
        error.code === 'CONNECTED_APPROVAL_REVIEW_MATERIAL_CREDENTIAL_REJECTED';
    }
    try {
      inspectConnectedApprovalReviewMaterial({
        root: temp,
        requestId: 'approval-request.meeting-intake.missing-private-review'
      });
      privateReviewBoundariesPassed = false;
    } catch (error) {
      privateReviewBoundariesPassed &&=
        error.code === 'CONNECTED_APPROVAL_REVIEW_MATERIAL_MISSING';
    }
    const governedCapabilityPath = path.join(temp, 'soter/capabilities/crm.records.read.json');
    const governedCapabilitySource = fs.readFileSync(governedCapabilityPath, 'utf8');
    const driftedCapability = JSON.parse(governedCapabilitySource);
    driftedCapability.purpose += ' Planted private-review applicability drift.';
    writeJson(governedCapabilityPath, driftedCapability);
    const staleApprovalReview = inspectConnectedApprovalReviewMaterial({
      root: temp,
      requestId: approvalReviewRequestId
    });
    privateReviewBoundariesPassed &&=
      staleApprovalReview.configuration.applicability.state === 'stale'
      && staleApprovalReview.fingerprint === approvalReview.fingerprint;
    try {
      confirmConnectedApprovalRequest({
        root: temp,
        requestId: approvalReviewRequestId,
        approvalId: 'approval.meeting-intake.stale-private-review-selftest',
        actor: 'fixture.user',
        reason: 'A stale exact request must not become an approval.',
        confirmedAt: FIXTURE_TIME
      });
      privateReviewBoundariesPassed = false;
    } catch (error) {
      privateReviewBoundariesPassed &&=
        error.message.includes('request exact lock to remain current');
    }
    fs.writeFileSync(governedCapabilityPath, governedCapabilitySource);
    if (!privateReviewBoundariesPassed) {
      failures.push('selected-activity private approval review did not preserve exact bindings, privacy, applicability, and no-authority semantics');
    }
    const updateProposal = structuredClone(connectedProposal);
    updateProposal.runId = 'run.meeting-intake.connected-update-selftest';
    delete updateProposal.basis;
    const updateRecordId = 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const updatePriorFields = {
      title: 'Connected transaction selftest task',
      status: 'Backlog',
      context: null,
      projectUris: [],
      assigneeIds: null,
      nextActionOn: null
    };
    updateProposal.id = 'changeset.meeting-intake.connected-update-selftest';
    updateProposal.operations = [{
      ...structuredClone(connectedProposal.operations[0]),
      id: 'operation.task.status-update',
      input: {
        recordType: 'task',
        id: updateRecordId,
        expectedVersion: notionTaskVersion(updateRecordId, updatePriorFields),
        patch: { status: 'Open' }
      }
    }];
    updateProposal.operations[0].inputFingerprint = fingerprintJson(updateProposal.operations[0].input);
    updateProposal.scopeFingerprint = changeSetScopeFingerprint(updateProposal);
    const updateBatch = compileConnectedOperationBatch({
      root: temp,
      lock,
      changeSet: updateProposal,
      id: 'batch.meeting-intake.connected-update-selftest',
      createdAt: FIXTURE_TIME
    });
    const connectedApproval = approveSelftestConnectedBatch({
      root: temp,
      lock,
      lockPath,
      batch: updateBatch,
      changeSet: updateProposal,
      id: 'approval.meeting-intake.connected-update-selftest',
      actor: 'fixture.user',
      reason: 'Approve the exact mapped update batch for compiler verification only.',
      createdAt: FIXTURE_TIME,
      expiresAt: '2026-07-15T12:05:00.000Z'
    });
    const tamperedConnectedApproval = structuredClone(connectedApproval);
    tamperedConnectedApproval.actor = 'different.fixture.user';
    let tamperedConnectedApprovalRejected = false;
    try {
      assertConnectedOperationBatchApproval({
        root: temp,
        batch: updateBatch,
        changeSet: updateProposal,
        approval: tamperedConnectedApproval,
        at: FIXTURE_TIME
      });
    } catch (error) {
      tamperedConnectedApprovalRejected = error.message.includes('does not match');
    }
    if (!tamperedConnectedApprovalRejected) {
      failures.push('connected approval accepted a tampered confirmation identity');
    }
    const transactionRun = { id: updateProposal.runId };
    let connectedCheckpoint = await createConnectedTransactionCheckpoint({
      root: temp,
      lock,
      lockPath,
      run: transactionRun,
      runSourcePath: 'soter/fixtures/meeting-intake/connected-transaction-selftest.run.json',
      runStatePath: '.soter/state/runs/' + transactionRun.id + '.json',
      batch: updateBatch,
      changeSet: updateProposal,
      approval: connectedApproval,
      at: FIXTURE_TIME
    });
    const compareCall = connectedTransactionCurrentCall(connectedCheckpoint);
    if (!compareCall) {
      throw new Error(
        'Connected transaction did not issue its initial compare call: '
          + JSON.stringify({ state: connectedCheckpoint.state, result: connectedCheckpoint.result })
      );
    }
    const compareResponse = notionTaskReadResponse(
      updateRecordId,
      updatePriorFields,
      'private-connected-compare-marker'
    );
    connectedCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: connectedCheckpoint,
      callId: compareCall.id,
      response: compareResponse,
      at: '2026-07-15T12:00:01.000Z'
    })).checkpoint;
    const updateCall = connectedTransactionCurrentCall(connectedCheckpoint);
    if (!updateCall) {
      throw new Error(
        'Connected transaction compare did not issue its write call: '
          + JSON.stringify({ state: connectedCheckpoint.state, result: connectedCheckpoint.result })
      );
    }
    connectedCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: connectedCheckpoint,
      callId: updateCall.id,
      response: notionUpdateResponse(updateRecordId, 'private-connected-write-marker'),
      at: '2026-07-15T12:00:02.000Z'
    })).checkpoint;
    const verifyCall = connectedTransactionCurrentCall(connectedCheckpoint);
    connectedCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: connectedCheckpoint,
      callId: verifyCall.id,
      response: notionTaskReadResponse(updateRecordId, {
        ...updatePriorFields,
        status: 'Open'
      }),
      at: '2026-07-15T12:00:03.000Z'
    })).checkpoint;
    const replayedCompare = await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: connectedCheckpoint,
      callId: compareCall.id,
      response: compareResponse,
      at: '2026-07-15T12:00:04.000Z'
    });
    let alteredReplayRejected = false;
    try {
      await completeConnectedTransactionCall({
        root: temp,
        lock,
        checkpoint: connectedCheckpoint,
        callId: compareCall.id,
        response: notionTaskReadResponse(updateRecordId, {
          ...updatePriorFields,
          title: 'Altered replay'
        }),
        at: '2026-07-15T12:00:04.000Z'
      });
    } catch (error) {
      alteredReplayRejected = error.message.includes('replay does not match');
    }
    const tamperedCheckpoint = structuredClone(connectedCheckpoint);
    tamperedCheckpoint.operations[0].priorFields.status = 'Tampered';
    let tamperedCheckpointRejected = false;
    try {
      assertConnectedTransactionCheckpoint(temp, tamperedCheckpoint);
    } catch (error) {
      tamperedCheckpointRejected = error.message.includes('stale');
    }
    if (connectedCheckpoint.state !== 'completed'
      || connectedCheckpoint.result?.appliedOperationIds[0] !== 'operation.task.status-update'
      || connectedCheckpoint.operations[0].priorFields.status !== 'Backlog'
      || connectedCheckpoint.operations[0].appliedVersion
        !== notionTaskVersion(updateRecordId, { ...updatePriorFields, status: 'Open' })
      || replayedCompare.idempotent !== true
      || !alteredReplayRejected
      || !tamperedCheckpointRejected
      || JSON.stringify(connectedCheckpoint).includes('private-connected')) {
      failures.push('connected transaction did not compare, write, verify, minimize, seal, and replay exactly');
    }

    let expiredCheckpoint = await createConnectedTransactionCheckpoint({
      root: temp,
      lock,
      lockPath,
      run: transactionRun,
      runSourcePath: 'soter/fixtures/meeting-intake/connected-expiry-selftest.run.json',
      runStatePath: '.soter/state/runs/' + transactionRun.id + '.json',
      batch: updateBatch,
      changeSet: updateProposal,
      approval: connectedApproval,
      at: '2026-07-15T12:04:59.000Z'
    });
    expiredCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: expiredCheckpoint,
      callId: connectedTransactionCurrentCall(expiredCheckpoint).id,
      response: notionTaskReadResponse(updateRecordId, updatePriorFields),
      at: '2026-07-15T12:05:01.000Z'
    })).checkpoint;
    if (expiredCheckpoint.state !== 'requested'
      || expiredCheckpoint.startedAt !== '2026-07-15T12:04:59.000Z'
      || expiredCheckpoint.current?.stage !== 'write') {
      failures.push('connected transaction did not preserve its one-time start across later approval expiry');
    }

    const ambiguousCheckpointStart = await createConnectedTransactionCheckpoint({
      root: temp,
      lock,
      lockPath,
      run: transactionRun,
      runSourcePath: 'soter/fixtures/meeting-intake/connected-ambiguous-selftest.run.json',
      runStatePath: '.soter/state/runs/' + transactionRun.id + '.json',
      batch: updateBatch,
      changeSet: updateProposal,
      approval: connectedApproval,
      at: FIXTURE_TIME
    });
    const ambiguousWriteCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: ambiguousCheckpointStart,
      callId: connectedTransactionCurrentCall(ambiguousCheckpointStart).id,
      response: notionTaskReadResponse(updateRecordId, updatePriorFields),
      at: '2026-07-15T12:00:01.000Z'
    })).checkpoint;
    const ambiguousCheckpoint = await failConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: ambiguousWriteCheckpoint,
      callId: connectedTransactionCurrentCall(ambiguousWriteCheckpoint).id,
      error: { kind: 'unavailable', message: 'Injected write transport ambiguity.' },
      at: '2026-07-15T12:00:02.000Z'
    });
    const replayedAmbiguousFailure = await failConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: ambiguousCheckpoint,
      callId: connectedTransactionCurrentCall(ambiguousWriteCheckpoint).id,
      error: { kind: 'unavailable', message: 'Injected write transport ambiguity.' },
      at: '2026-07-15T12:00:03.000Z'
    });
    if (ambiguousCheckpoint.state !== 'needs-attention'
      || ambiguousCheckpoint.operations[0].state !== 'needs-attention'
      || replayedAmbiguousFailure.checkpointFingerprint
        !== ambiguousCheckpoint.checkpointFingerprint) {
      failures.push('connected transaction overstated a failed write transport as safely rolled back');
    }
    let reconciledApproved = await prepareConnectedTransactionReconciliation({
      root: temp,
      lock,
      checkpoint: ambiguousCheckpoint,
      at: '2026-07-15T12:00:03.000Z'
    });
    const approvedReconciliationCall = connectedTransactionCurrentCall(reconciledApproved);
    const approvedReconciliationResponse = notionTaskReadResponse(updateRecordId, {
      ...updatePriorFields,
      status: 'Open'
    }, 'private-connected-reconciliation-marker');
    reconciledApproved = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: reconciledApproved,
      callId: approvedReconciliationCall.id,
      response: approvedReconciliationResponse,
      at: '2026-07-15T12:00:04.000Z'
    })).checkpoint;
    const replayedReconciliation = await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: reconciledApproved,
      callId: approvedReconciliationCall.id,
      response: approvedReconciliationResponse,
      at: '2026-07-15T12:00:05.000Z'
    });
    const tamperedReconciliation = structuredClone(reconciledApproved);
    tamperedReconciliation.operations[0].reconciliations[0].outcome = 'diverged';
    delete tamperedReconciliation.checkpointFingerprint;
    tamperedReconciliation.checkpointFingerprint = fingerprintJson(tamperedReconciliation);
    let tamperedReconciliationRejected = false;
    try {
      assertConnectedTransactionCheckpoint(temp, tamperedReconciliation);
    } catch (error) {
      tamperedReconciliationRejected = error.message.includes('reconciliation');
    }
    if (reconciledApproved.state !== 'completed'
      || reconciledApproved.operations[0].ambiguities[0].resolution !== 'approved-fields'
      || reconciledApproved.operations[0].reconciliations[0].outcome !== 'approved-fields'
      || reconciledApproved.operations[0].appliedVersion
        !== notionTaskVersion(updateRecordId, { ...updatePriorFields, status: 'Open' })
      || replayedReconciliation.idempotent !== true
      || !tamperedReconciliationRejected
      || JSON.stringify(reconciledApproved).includes('private-connected-reconciliation-marker')) {
      failures.push('connected reconciliation did not prove and resume an ambiguous approved update exactly');
    }

    let reconciledPrior = await prepareConnectedTransactionReconciliation({
      root: temp,
      lock,
      checkpoint: ambiguousCheckpoint,
      at: '2026-07-15T12:00:03.000Z'
    });
    reconciledPrior = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: reconciledPrior,
      callId: connectedTransactionCurrentCall(reconciledPrior).id,
      response: notionTaskReadResponse(updateRecordId, updatePriorFields),
      at: '2026-07-15T12:00:04.000Z'
    })).checkpoint;
    if (reconciledPrior.state !== 'failed'
      || reconciledPrior.operations[0].ambiguities[0].resolution !== 'prior-fields') {
      failures.push('connected reconciliation did not close a proved no-change ambiguity without retrying the write');
    }

    let reconciledDiverged = await prepareConnectedTransactionReconciliation({
      root: temp,
      lock,
      checkpoint: ambiguousCheckpoint,
      at: '2026-07-15T12:00:03.000Z'
    });
    reconciledDiverged = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: reconciledDiverged,
      callId: connectedTransactionCurrentCall(reconciledDiverged).id,
      response: notionTaskReadResponse(updateRecordId, {
        ...updatePriorFields,
        status: 'Unexpected concurrent value'
      }),
      at: '2026-07-15T12:00:04.000Z'
    })).checkpoint;
    reconciledDiverged = await prepareConnectedTransactionReconciliation({
      root: temp,
      lock,
      checkpoint: reconciledDiverged,
      at: '2026-07-15T12:00:05.000Z'
    });
    reconciledDiverged = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: reconciledDiverged,
      callId: connectedTransactionCurrentCall(reconciledDiverged).id,
      response: notionTaskReadResponse(updateRecordId, updatePriorFields),
      at: '2026-07-15T12:00:06.000Z'
    })).checkpoint;
    if (reconciledDiverged.state !== 'failed'
      || reconciledDiverged.operations[0].reconciliations.length !== 2
      || reconciledDiverged.operations[0].reconciliations[0].outcome !== 'diverged'
      || reconciledDiverged.operations[0].reconciliations[1].outcome !== 'prior-fields') {
      failures.push('connected reconciliation guessed at divergent state or could not retry its read safely');
    }
    let reconciledMissing = await prepareConnectedTransactionReconciliation({
      root: temp,
      lock,
      checkpoint: ambiguousCheckpoint,
      at: '2026-07-15T12:00:03.000Z'
    });
    reconciledMissing = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: reconciledMissing,
      callId: connectedTransactionCurrentCall(reconciledMissing).id,
      response: { structuredContent: { result: { results: [], has_more: false } } },
      at: '2026-07-15T12:00:04.000Z'
    })).checkpoint;
    let failedReconciliationRead = await prepareConnectedTransactionReconciliation({
      root: temp,
      lock,
      checkpoint: ambiguousCheckpoint,
      at: '2026-07-15T12:00:03.000Z'
    });
    const failedReconciliationCall = connectedTransactionCurrentCall(failedReconciliationRead);
    failedReconciliationRead = await failConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: failedReconciliationRead,
      callId: failedReconciliationCall.id,
      error: { kind: 'unavailable', message: 'Injected reconciliation read failure.' },
      at: '2026-07-15T12:00:04.000Z'
    });
    const replayedReconciliationFailure = await failConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: failedReconciliationRead,
      callId: failedReconciliationCall.id,
      error: { kind: 'unavailable', message: 'Injected reconciliation read failure.' },
      at: '2026-07-15T12:00:05.000Z'
    });
    if (reconciledMissing.state !== 'needs-attention'
      || reconciledMissing.operations[0].reconciliations[0].outcome !== 'missing'
      || failedReconciliationRead.state !== 'needs-attention'
      || failedReconciliationRead.operations[0].reconciliations[0].outcome !== 'read-failed'
      || replayedReconciliationFailure.checkpointFingerprint
        !== failedReconciliationRead.checkpointFingerprint) {
      failures.push('connected reconciliation did not preserve missing or failed read ambiguity for safe retry');
    }

    const rollbackProposal = structuredClone(updateProposal);
    const rollbackRecordId = 'https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const rollbackPriorFields = {
      title: 'Connected rollback selftest task',
      status: 'Backlog',
      context: null,
      projectUris: [],
      assigneeIds: null,
      nextActionOn: null
    };
    rollbackProposal.id = 'changeset.meeting-intake.connected-rollback-selftest';
    rollbackProposal.operations = [
      structuredClone(updateProposal.operations[0]),
      structuredClone(updateProposal.operations[0])
    ];
    rollbackProposal.operations[0].id = 'operation.task.first-status-update';
    rollbackProposal.operations[1].id = 'operation.task.second-status-update';
    rollbackProposal.operations[1].input.id = rollbackRecordId;
    rollbackProposal.operations[1].input.expectedVersion = notionTaskVersion(
      rollbackRecordId,
      rollbackPriorFields
    );
    rollbackProposal.operations.forEach((operation) => {
      operation.inputFingerprint = fingerprintJson(operation.input);
    });
    rollbackProposal.scopeFingerprint = changeSetScopeFingerprint(rollbackProposal);
    const rollbackBatch = compileConnectedOperationBatch({
      root: temp,
      lock,
      changeSet: rollbackProposal,
      id: 'batch.meeting-intake.connected-rollback-selftest',
      createdAt: FIXTURE_TIME
    });
    const connectedRollbackApproval = approveSelftestConnectedBatch({
      root: temp,
      lock,
      lockPath,
      batch: rollbackBatch,
      changeSet: rollbackProposal,
      id: 'approval.meeting-intake.connected-rollback-selftest',
      actor: 'fixture.user',
      reason: 'Approve two exact mapped updates to prove reverse compensation.',
      createdAt: FIXTURE_TIME,
      expiresAt: '2026-07-15T12:05:00.000Z'
    });
    const invalidTailProposal = structuredClone(rollbackProposal);
    invalidTailProposal.id = 'changeset.meeting-intake.connected-invalid-tail-selftest';
    invalidTailProposal.operations[1].input.id = 'not-a-provider-record-id';
    invalidTailProposal.operations[1].inputFingerprint = fingerprintJson(
      invalidTailProposal.operations[1].input
    );
    invalidTailProposal.scopeFingerprint = changeSetScopeFingerprint(invalidTailProposal);
    const invalidTailBatch = compileConnectedOperationBatch({
      root: temp,
      lock,
      changeSet: invalidTailProposal,
      id: 'batch.meeting-intake.connected-invalid-tail-selftest',
      createdAt: FIXTURE_TIME
    });
    const invalidTailApproval = approveSelftestConnectedBatch({
      root: temp,
      lock,
      lockPath,
      batch: invalidTailBatch,
      changeSet: invalidTailProposal,
      id: 'approval.meeting-intake.connected-invalid-tail-selftest',
      actor: 'fixture.user',
      reason: 'This invalid provider target must fail complete preflight before the first effect.',
      createdAt: FIXTURE_TIME,
      expiresAt: '2026-07-15T12:05:00.000Z'
    });
    let connectedInvalidTailRejected = false;
    try {
      await createConnectedTransactionCheckpoint({
        root: temp,
        lock,
        lockPath,
        run: { id: invalidTailProposal.runId },
        runSourcePath: 'soter/fixtures/meeting-intake/connected-invalid-tail-selftest.run.json',
        runStatePath: '.soter/state/runs/' + invalidTailProposal.runId + '.json',
        batch: invalidTailBatch,
        changeSet: invalidTailProposal,
        approval: invalidTailApproval,
        at: FIXTURE_TIME
      });
    } catch (error) {
      connectedInvalidTailRejected = error.message.includes(
        'operation.task.second-status-update/write'
      );
    }
    if (!connectedInvalidTailRejected) {
      failures.push('connected transaction did not preflight every provider route before the first effect');
    }
    let rollbackCheckpoint = await createConnectedTransactionCheckpoint({
      root: temp,
      lock,
      lockPath,
      run: { id: rollbackProposal.runId },
      runSourcePath: 'soter/fixtures/meeting-intake/connected-rollback-selftest.run.json',
      runStatePath: '.soter/state/runs/' + rollbackProposal.runId + '.json',
      batch: rollbackBatch,
      changeSet: rollbackProposal,
      approval: connectedRollbackApproval,
      at: FIXTURE_TIME
    });
    rollbackCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: rollbackCheckpoint,
      callId: connectedTransactionCurrentCall(rollbackCheckpoint).id,
      response: notionTaskReadResponse(updateRecordId, updatePriorFields),
      at: '2026-07-15T12:00:01.000Z'
    })).checkpoint;
    rollbackCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: rollbackCheckpoint,
      callId: connectedTransactionCurrentCall(rollbackCheckpoint).id,
      response: notionUpdateResponse(updateRecordId),
      at: '2026-07-15T12:00:02.000Z'
    })).checkpoint;
    rollbackCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: rollbackCheckpoint,
      callId: connectedTransactionCurrentCall(rollbackCheckpoint).id,
      response: notionTaskReadResponse(updateRecordId, {
        ...updatePriorFields,
        status: 'Open'
      }),
      at: '2026-07-15T12:00:03.000Z'
    })).checkpoint;
    rollbackCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: rollbackCheckpoint,
      callId: connectedTransactionCurrentCall(rollbackCheckpoint).id,
      response: notionTaskReadResponse(rollbackRecordId, {
        ...rollbackPriorFields,
        status: 'Unexpected concurrent value'
      }),
      at: '2026-07-15T12:00:04.000Z'
    })).checkpoint;
    const compensationCall = connectedTransactionCurrentCall(rollbackCheckpoint);
    const compensationAmbiguityStart = structuredClone(rollbackCheckpoint);
    rollbackCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: rollbackCheckpoint,
      callId: compensationCall.id,
      response: notionUpdateResponse(updateRecordId),
      at: '2026-07-15T12:00:05.000Z'
    })).checkpoint;
    rollbackCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: rollbackCheckpoint,
      callId: connectedTransactionCurrentCall(rollbackCheckpoint).id,
      response: notionTaskReadResponse(updateRecordId, updatePriorFields),
      at: '2026-07-15T12:00:06.000Z'
    })).checkpoint;
    if (compensationCall.capability.id !== 'crm.records.update'
      || compensationCall.arguments.properties.Status !== 'Backlog'
      || rollbackCheckpoint.state !== 'rolled-back'
      || rollbackCheckpoint.operations[0].state !== 'compensated'
      || rollbackCheckpoint.operations[1].state !== 'failed'
      || rollbackCheckpoint.result?.compensatedOperationIds[0]
        !== 'operation.task.first-status-update'
      || rollbackCheckpoint.result?.error?.kind !== 'conflict') {
      failures.push('connected transaction did not compensate verified updates in reverse after a later conflict');
    }
    let reconciledCompensation = await failConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: compensationAmbiguityStart,
      callId: compensationCall.id,
      error: { kind: 'unavailable', message: 'Injected compensation transport ambiguity.' },
      at: '2026-07-15T12:00:05.000Z'
    });
    const unresolvedCompensation = structuredClone(reconciledCompensation);
    reconciledCompensation = await prepareConnectedTransactionReconciliation({
      root: temp,
      lock,
      checkpoint: reconciledCompensation,
      at: '2026-07-15T12:00:06.000Z'
    });
    reconciledCompensation = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: reconciledCompensation,
      callId: connectedTransactionCurrentCall(reconciledCompensation).id,
      response: notionTaskReadResponse(updateRecordId, updatePriorFields),
      at: '2026-07-15T12:00:07.000Z'
    })).checkpoint;
    let compensationStillApplied = await prepareConnectedTransactionReconciliation({
      root: temp,
      lock,
      checkpoint: unresolvedCompensation,
      at: '2026-07-15T12:00:06.000Z'
    });
    compensationStillApplied = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: compensationStillApplied,
      callId: connectedTransactionCurrentCall(compensationStillApplied).id,
      response: notionTaskReadResponse(updateRecordId, {
        ...updatePriorFields,
        status: 'Open'
      }),
      at: '2026-07-15T12:00:07.000Z'
    })).checkpoint;
    if (reconciledCompensation.state !== 'rolled-back'
      || reconciledCompensation.operations[0].ambiguities[0].resolution !== 'prior-fields'
      || compensationStillApplied.state !== 'needs-attention'
      || compensationStillApplied.operations[0].reconciliations[0].outcome
        !== 'approved-fields') {
      failures.push('connected reconciliation overstated or failed to prove an ambiguous compensation');
    }

    const durableConnectedRun = structuredClone(envelope);
    durableConnectedRun.id = updateProposal.runId;
    const durableConnectedRunPath = 'soter/fixtures/meeting-intake/connected-transaction-selftest.run.json';
    writeJson(path.join(temp, durableConnectedRunPath), durableConnectedRun);
    beginConnectedApprovalRequest({
      root: temp,
      lockPath,
      runPath: durableConnectedRunPath,
      batch: updateBatch,
      changeSet: updateProposal,
      id: 'approval-request.meeting-intake.durable-connected-selftest',
      reason: 'Request confirmation for the exact durable connected selftest update.',
      createdAt: FIXTURE_TIME,
      expiresAt: '2026-07-15T12:05:00.000Z'
    });
    const incompleteDurableReview = inspectConnectedApprovalReviewMaterial({
      root: temp,
      requestId: 'approval-request.meeting-intake.durable-connected-selftest'
    });
    if (incompleteDurableReview.completeness.state !== 'incomplete'
      || incompleteDurableReview.completeness.reasonCodes[0]
        !== 'SOURCE_CONTEXT_UNAVAILABLE'
      || incompleteDurableReview.operations[0].before.state !== 'unavailable') {
      failures.push('selected-activity private review did not report missing bound prior context honestly');
    }
    const durableConnectedApproval = confirmConnectedApprovalRequest({
      root: temp,
      requestId: 'approval-request.meeting-intake.durable-connected-selftest',
      approvalId: 'approval.meeting-intake.durable-connected-selftest',
      actor: 'fixture.user',
      reason: 'Confirm the exact durable connected selftest update.',
      confirmedAt: FIXTURE_TIME
    }).approval;
    const approvedOperatorInspection = inspectConnectedOperatorActivity({
      root: temp,
      approvalId: durableConnectedApproval.id,
      observedAt: FIXTURE_TIME
    });
    const expiredOperatorInspection = inspectConnectedOperatorActivity({
      root: temp,
      approvalId: durableConnectedApproval.id,
      observedAt: '2026-07-15T12:06:00.000Z'
    });
    let durableConnected = await prepareDurableConnectedTransactionExecution({
      root: temp,
      approvalId: durableConnectedApproval.id,
      at: FIXTURE_TIME,
      expectedHost: 'codex'
    });
    const runningOperatorInspection = inspectConnectedOperatorActivity({
      root: temp,
      checkpointId: durableConnected.checkpoint.id,
      observedAt: FIXTURE_TIME
    });
    const duplicateDurableConnected = await prepareDurableConnectedTransactionExecution({
      root: temp,
      approvalId: durableConnectedApproval.id,
      at: FIXTURE_TIME,
      expectedHost: 'codex'
    });
    durableConnected = await completeDurableConnectedTransactionExecution({
      root: temp,
      checkpointId: durableConnected.checkpoint.id,
      callId: durableConnected.currentCall.id,
      response: notionTaskReadResponse(
        updateRecordId,
        updatePriorFields,
        'private-durable-connected-compare-marker'
      ),
      at: '2026-07-15T12:00:01.000Z',
      expectedHost: 'codex'
    });
    const rehydratedConnected = getDurableHostExecution({
      root: temp,
      checkpointId: durableConnected.checkpoint.id,
      expectedHost: 'codex'
    });
    durableConnected = await completeDurableConnectedTransactionExecution({
      root: temp,
      checkpointId: durableConnected.checkpoint.id,
      callId: rehydratedConnected.currentCall.id,
      response: notionUpdateResponse(
        updateRecordId,
        'private-durable-connected-write-marker'
      ),
      at: '2026-07-15T12:00:02.000Z',
      expectedHost: 'codex'
    });
    durableConnected = await completeDurableConnectedTransactionExecution({
      root: temp,
      checkpointId: durableConnected.checkpoint.id,
      callId: durableConnected.currentCall.id,
      response: notionTaskReadResponse(updateRecordId, {
        ...updatePriorFields,
        status: 'Open'
      }, 'private-durable-connected-verify-marker'),
      at: '2026-07-15T12:00:03.000Z',
      expectedHost: 'codex'
    });
    const durableConnectedCheckpointText = fs.readFileSync(
      path.join(temp, durableConnected.checkpointPath),
      'utf8'
    );
    const durableConnectedRunText = fs.readFileSync(
      path.join(temp, durableConnected.runPath),
      'utf8'
    );
    const durableTransactionEntry = durableConnected.run.checkpoints.find((item) => {
      return item.id === 'connected-transaction.' + updateBatch.id;
    });
    const completedOperatorInspection = inspectConnectedOperatorActivity({
      root: temp,
      checkpointId: durableConnected.checkpoint.id,
      observedAt: '2026-07-15T12:00:03.000Z'
    });
    const forbiddenOperatorFields = [
      ['rawProviderResponse', { private: 'raw-provider-response-sentinel' }],
      ['privateInput', 'private-input-sentinel'],
      ['secret', 'secret-value-sentinel']
    ];
    let forbiddenOperatorFieldsRejected = true;
    for (const [field, value] of forbiddenOperatorFields) {
      const tampered = structuredClone(completedOperatorInspection);
      tampered[field] = value;
      try {
        assertOperatorInspection(temp, tampered);
        forbiddenOperatorFieldsRejected = false;
      } catch (error) {
        forbiddenOperatorFieldsRejected &&= error.message.includes('contract');
      }
    }
    const rawChangeInspection = structuredClone(completedOperatorInspection);
    rawChangeInspection.scope.changes[0].before = 'private-before-value-sentinel';
    rawChangeInspection.scope.changes[0].after = 'private-after-value-sentinel';
    try {
      assertOperatorInspection(temp, rawChangeInspection);
      forbiddenOperatorFieldsRejected = false;
    } catch (error) {
      forbiddenOperatorFieldsRejected &&= error.message.includes('contract');
    }
    if (approvedOperatorInspection.activity.workState !== 'approved-not-started'
      || approvedOperatorInspection.resume.permittedNextAction !== 'start-transaction'
      || approvedOperatorInspection.continuationRequest !== null
      || expiredOperatorInspection.approval.state !== 'expired'
      || expiredOperatorInspection.resume.reasonCode !== 'APPROVAL_REQUEST_EXPIRED'
      || runningOperatorInspection.activity.workState !== 'running'
      || runningOperatorInspection.resume.permittedNextAction !== 'execute-current-call'
      || runningOperatorInspection.continuationRequest?.kind !== 'execute-current-call'
      || runningOperatorInspection.continuationRequest?.callId
        !== runningOperatorInspection.capabilities.current?.callId
      || completedOperatorInspection.activity.workState !== 'completed'
      || completedOperatorInspection.resume.classification !== 'unavailable'
      || completedOperatorInspection.continuationRequest !== null
      || completedOperatorInspection.verification.state !== 'verified'
      || completedOperatorInspection.families.proof.state !== 'not-evaluated'
      || completedOperatorInspection.families.maturity.state !== 'not-evaluated'
      || completedOperatorInspection.families.migration.state !== 'not-evaluated'
      || !forbiddenOperatorFieldsRejected
      || JSON.stringify(completedOperatorInspection).includes('private-durable-connected')
      || duplicateDurableConnected.checkpoint.id !== durableConnected.checkpoint.id
      || duplicateDurableConnected.approvalConsumption.state !== 'started'
      || rehydratedConnected.currentCall?.transport.operation !== 'update_page'
      || durableConnected.checkpoint.state !== 'completed'
      || durableConnected.run.approvals.length !== 1
      || durableConnected.run.approvals[0].id !== durableConnectedApproval.id
      || durableConnected.run.effects.length !== 3
      || durableTransactionEntry?.state !== 'completed'
      || durableConnectedCheckpointText.includes('private-durable-connected')
      || durableConnectedRunText.includes('private-durable-connected')) {
      failures.push('durable connected transaction did not persist, recover, minimize, and synchronize its exact run');
    }

    const durableReconciliationProposal = structuredClone(updateProposal);
    durableReconciliationProposal.id = 'changeset.meeting-intake.durable-reconciliation-selftest';
    durableReconciliationProposal.runId = 'run.meeting-intake.durable-reconciliation-selftest';
    durableReconciliationProposal.scopeFingerprint = changeSetScopeFingerprint(
      durableReconciliationProposal
    );
    const durableReconciliationBatch = compileConnectedOperationBatch({
      root: temp,
      lock,
      changeSet: durableReconciliationProposal,
      id: 'batch.meeting-intake.durable-reconciliation-selftest',
      createdAt: FIXTURE_TIME
    });
    const durableReconciliationRun = structuredClone(envelope);
    durableReconciliationRun.id = durableReconciliationProposal.runId;
    const durableReconciliationRunPath = 'soter/fixtures/meeting-intake/durable-reconciliation-selftest.run.json';
    writeJson(path.join(temp, durableReconciliationRunPath), durableReconciliationRun);
    beginConnectedApprovalRequest({
      root: temp,
      lockPath,
      runPath: durableReconciliationRunPath,
      batch: durableReconciliationBatch,
      changeSet: durableReconciliationProposal,
      id: 'approval-request.meeting-intake.durable-reconciliation-selftest',
      reason: 'Request confirmation for one exact durable reconciliation update.',
      createdAt: FIXTURE_TIME,
      expiresAt: '2026-07-15T12:05:00.000Z'
    });
    const durableReconciliationApproval = confirmConnectedApprovalRequest({
      root: temp,
      requestId: 'approval-request.meeting-intake.durable-reconciliation-selftest',
      approvalId: 'approval.meeting-intake.durable-reconciliation-selftest',
      actor: 'fixture.user',
      reason: 'Confirm one exact update for durable reconciliation proof.',
      confirmedAt: FIXTURE_TIME
    }).approval;
    let durableReconciliation = await prepareDurableConnectedTransactionExecution({
      root: temp,
      approvalId: durableReconciliationApproval.id,
      at: FIXTURE_TIME,
      expectedHost: 'codex'
    });
    durableReconciliation = await completeDurableConnectedTransactionExecution({
      root: temp,
      checkpointId: durableReconciliation.checkpoint.id,
      callId: durableReconciliation.currentCall.id,
      response: notionTaskReadResponse(updateRecordId, updatePriorFields),
      at: '2026-07-15T12:00:01.000Z',
      expectedHost: 'codex'
    });
    durableReconciliation = await failDurableHostExecution({
      root: temp,
      checkpointId: durableReconciliation.checkpoint.id,
      callId: durableReconciliation.currentCall.id,
      errorKind: 'unavailable',
      message: 'Injected durable write ambiguity.',
      at: '2026-07-15T12:00:02.000Z',
      expectedHost: 'codex'
    });
    durableReconciliation = await prepareDurableConnectedTransactionReconciliation({
      root: temp,
      checkpointId: durableReconciliation.checkpoint.id,
      at: '2026-07-15T12:00:03.000Z',
      expectedHost: 'codex'
    });
    const duplicateDurableReconciliation = await prepareDurableConnectedTransactionReconciliation({
      root: temp,
      checkpointId: durableReconciliation.checkpoint.id,
      at: '2026-07-15T12:00:03.500Z',
      expectedHost: 'codex'
    });
    const rehydratedDurableReconciliation = getDurableHostExecution({
      root: temp,
      checkpointId: durableReconciliation.checkpoint.id,
      expectedHost: 'codex'
    });
    durableReconciliation = await completeDurableConnectedTransactionExecution({
      root: temp,
      checkpointId: durableReconciliation.checkpoint.id,
      callId: rehydratedDurableReconciliation.currentCall.id,
      response: notionTaskReadResponse(updateRecordId, {
        ...updatePriorFields,
        status: 'Open'
      }, 'private-durable-reconciliation-marker'),
      at: '2026-07-15T12:00:04.000Z',
      expectedHost: 'codex'
    });
    const durableReconciliationText = [
      durableReconciliation.checkpointPath,
      durableReconciliation.runPath
    ].map((file) => fs.readFileSync(path.join(temp, file), 'utf8')).join('\n');
    if (duplicateDurableReconciliation.checkpoint.checkpointFingerprint
        !== rehydratedDurableReconciliation.checkpoint.checkpointFingerprint
      || rehydratedDurableReconciliation.currentCall?.transport.operation
        !== 'query_data_sources'
      || durableReconciliation.checkpoint.state !== 'completed'
      || durableReconciliation.run.effects.length !== 3
      || durableReconciliation.run.lifecycleState !== 'executing'
      || durableReconciliationText.includes('private-durable-reconciliation-marker')) {
      failures.push('durable connected reconciliation did not recover, resume, minimize, and synchronize its exact run');
    }
    const createProposal = structuredClone(connectedProposal);
    createProposal.id = 'changeset.meeting-intake.connected-create-selftest';
    createProposal.operations = [{
      ...structuredClone(connectedProposal.operations[1]),
      id: 'operation.summary.mapped-create',
      input: {
        recordType: 'meeting-summary',
        deduplicationKey: 'https://otter.ai/u/fixture-summary',
        deduplicationFilter: {
          field: 'link',
          value: 'https://otter.ai/u/fixture-summary'
        },
        fields: {
          title: 'Mapped fixture summary',
          documentType: 'Meeting Summary',
          description: 'Grounded fixture summary.',
          link: 'https://otter.ai/u/fixture-summary'
        },
        body: 'Grounded fixture summary.'
      }
    }];
    createProposal.operations[0].inputFingerprint = fingerprintJson(createProposal.operations[0].input);
    createProposal.scopeFingerprint = changeSetScopeFingerprint(createProposal);
    const createBatch = compileConnectedOperationBatch({
      root: temp,
      lock,
      changeSet: createProposal,
      id: 'batch.meeting-intake.connected-create-selftest',
      createdAt: FIXTURE_TIME
    });
    if (!updateBatch.executable || updateBatch.state !== 'proposed'
      || connectedApproval.scope.operationBatchFingerprint !== updateBatch.batchFingerprint
      || connectedApproval.scope.changeSetFingerprint !== updateProposal.scopeFingerprint
      || !createBatch.executable || createBatch.state !== 'proposed'
      || createBatch.operations[0].recovery.mode !== 'terminal-idempotent-create'
      || createBatch.operations[0].contentVerification?.expectedBodyFingerprint
        !== fingerprintJson(createProposal.operations[0].input.body)) {
      failures.push('connected operation-batch compilation did not bind exact approval or terminal create verification');
    }
    const createApproval = approveSelftestConnectedBatch({
      root: temp,
      lock,
      lockPath,
      batch: createBatch,
      changeSet: createProposal,
      id: 'approval.meeting-intake.connected-create-selftest',
      actor: 'fixture.user',
      reason: 'Approve one exact deduplicated terminal create with record and content verification.',
      createdAt: FIXTURE_TIME,
      expiresAt: '2026-07-15T12:05:00.000Z'
    });
    if (createApproval.scope.operationBatchFingerprint !== createBatch.batchFingerprint) {
      failures.push('connected approval did not bind the exact executable terminal create');
    }

    const mixedProposal = structuredClone(updateProposal);
    mixedProposal.id = 'changeset.meeting-intake.connected-terminal-create-selftest';
    mixedProposal.runId = 'run.meeting-intake.connected-terminal-create-selftest';
    mixedProposal.operations = [
      structuredClone(updateProposal.operations[0]),
      structuredClone(createProposal.operations[0])
    ];
    mixedProposal.scopeFingerprint = changeSetScopeFingerprint(mixedProposal);
    const mixedBatch = compileConnectedOperationBatch({
      root: temp,
      lock,
      changeSet: mixedProposal,
      id: 'batch.meeting-intake.connected-terminal-create-selftest',
      createdAt: FIXTURE_TIME
    });
    const nonterminalCreateProposal = structuredClone(mixedProposal);
    nonterminalCreateProposal.id = 'changeset.meeting-intake.connected-nonterminal-create-selftest';
    nonterminalCreateProposal.operations.reverse();
    nonterminalCreateProposal.scopeFingerprint = changeSetScopeFingerprint(
      nonterminalCreateProposal
    );
    const nonterminalCreateBatch = compileConnectedOperationBatch({
      root: temp,
      lock,
      changeSet: nonterminalCreateProposal,
      id: 'batch.meeting-intake.connected-nonterminal-create-selftest',
      createdAt: FIXTURE_TIME
    });
    if (nonterminalCreateBatch.executable
      || nonterminalCreateBatch.state !== 'blocked'
      || !nonterminalCreateBatch.blockers.some((item) => item.includes('final operation'))) {
      failures.push('connected compiler did not prohibit effects after an uncompensated create');
    }
    const mixedApproval = approveSelftestConnectedBatch({
      root: temp,
      lock,
      lockPath,
      batch: mixedBatch,
      changeSet: mixedProposal,
      id: 'approval.meeting-intake.connected-terminal-create-selftest',
      actor: 'fixture.user',
      reason: 'Approve one reversible task update followed by one exact deduplicated terminal summary create.',
      createdAt: FIXTURE_TIME,
      expiresAt: '2026-07-15T12:05:00.000Z'
    });
    const mismatchedSourceBatch = structuredClone(mixedBatch);
    mismatchedSourceBatch.operations[0].input.patch.status = 'Different approved value';
    mismatchedSourceBatch.operations[0].inputFingerprint = fingerprintJson(
      mismatchedSourceBatch.operations[0].input
    );
    delete mismatchedSourceBatch.batchFingerprint;
    mismatchedSourceBatch.batchFingerprint = fingerprintJson(mismatchedSourceBatch);
    let mismatchedSourceBatchRejected = false;
    try {
      approveSelftestConnectedBatch({
        root: temp,
        lock,
        lockPath,
        batch: mismatchedSourceBatch,
        changeSet: mixedProposal,
        id: 'approval.meeting-intake.connected-source-mismatch-selftest',
        actor: 'fixture.user',
        reason: 'This batch no longer corresponds to its claimed source change set.',
        createdAt: FIXTURE_TIME,
        expiresAt: '2026-07-15T12:05:00.000Z'
      });
    } catch (error) {
      mismatchedSourceBatchRejected = error.message.includes('does not match');
    }
    if (!mismatchedSourceBatchRejected) {
      failures.push('connected approval did not mechanically link compiled operations to the exact source change set');
    }
    const staleDerivedBatch = structuredClone(mixedBatch);
    staleDerivedBatch.operations[1].precondition.readInput.filters.link = 'different-key';
    delete staleDerivedBatch.batchFingerprint;
    staleDerivedBatch.batchFingerprint = fingerprintJson(staleDerivedBatch);
    let staleDerivedBatchRejected = false;
    try {
      approveSelftestConnectedBatch({
        root: temp,
        lock,
        lockPath,
        batch: staleDerivedBatch,
        changeSet: mixedProposal,
        id: 'approval.meeting-intake.connected-derived-mismatch-selftest',
        actor: 'fixture.user',
        reason: 'This batch no longer derives its precondition from its approved input.',
        createdAt: FIXTURE_TIME,
        expiresAt: '2026-07-15T12:05:00.000Z'
      });
    } catch (error) {
      staleDerivedBatchRejected = error.message.includes('does not match');
    }
    if (!staleDerivedBatchRejected) {
      failures.push('connected approval accepted a stale derived precondition');
    }
    const mixedRun = { id: mixedProposal.runId };
    const summaryRecordId = 'https://www.notion.so/cccccccccccccccccccccccccccccccc';
    const summaryFields = mixedProposal.operations[1].input.fields;
    const summaryBody = mixedProposal.operations[1].input.body;
    const emptyReadResponse = {
      structuredContent: { result: { results: [], has_more: false } }
    };
    let mixedCheckpoint = await createConnectedTransactionCheckpoint({
      root: temp,
      lock,
      lockPath,
      run: mixedRun,
      runSourcePath: 'soter/fixtures/meeting-intake/connected-terminal-create-selftest.run.json',
      runStatePath: '.soter/state/runs/' + mixedRun.id + '.json',
      batch: mixedBatch,
      changeSet: mixedProposal,
      approval: mixedApproval,
      at: FIXTURE_TIME
    });
    const mixedResponses = [
      notionTaskReadResponse(updateRecordId, updatePriorFields),
      notionUpdateResponse(updateRecordId),
      notionTaskReadResponse(updateRecordId, { ...updatePriorFields, status: 'Open' }),
      emptyReadResponse,
      notionCreateResponse(summaryRecordId, 'private-terminal-create-write-marker'),
      notionSummaryReadResponse(summaryRecordId, summaryFields),
      notionPageResponse({
        uri: summaryRecordId,
        title: summaryFields.title,
        body: summaryBody,
        privateMarker: 'private-terminal-create-content-marker'
      })
    ];
    const expectedMixedStages = [
      'compare', 'write', 'verify', 'compare', 'write', 'verify', 'content-verify'
    ];
    const observedMixedStages = [];
    let terminalContentCall;
    let terminalContentResponse;
    for (const [index, response] of mixedResponses.entries()) {
      observedMixedStages.push(mixedCheckpoint.current?.stage);
      const call = connectedTransactionCurrentCall(mixedCheckpoint);
      if (mixedCheckpoint.current?.stage === 'content-verify') {
        terminalContentCall = call;
        terminalContentResponse = response;
      }
      mixedCheckpoint = (await completeConnectedTransactionCall({
        root: temp,
        lock,
        checkpoint: mixedCheckpoint,
        callId: call.id,
        response,
        at: '2026-07-15T12:00:0' + (index + 1) + '.000Z'
      })).checkpoint;
    }
    const replayedTerminalContent = await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: mixedCheckpoint,
      callId: terminalContentCall.id,
      response: terminalContentResponse,
      at: '2026-07-15T12:00:08.000Z'
    });
    const mixedCreateRuntime = mixedCheckpoint.operations[1];
    if (fingerprintJson(observedMixedStages) !== fingerprintJson(expectedMixedStages)
      || mixedCheckpoint.state !== 'completed'
      || mixedCheckpoint.operations.some((operation) => operation.state !== 'applied')
      || mixedCreateRuntime.createdRecordId !== summaryRecordId
      || mixedCreateRuntime.contentVerification?.output?.document?.bodyFingerprint
        !== fingerprintJson(summaryBody)
      || replayedTerminalContent.idempotent !== true
      || JSON.stringify(mixedCheckpoint).includes('private-terminal-create')) {
      failures.push('connected terminal create did not execute and verify exact record fields and page content after reversible updates');
    }

    let absentCreateCheckpoint = await createConnectedTransactionCheckpoint({
      root: temp,
      lock,
      lockPath,
      run: mixedRun,
      runSourcePath: 'soter/fixtures/meeting-intake/connected-terminal-create-absent-selftest.run.json',
      runStatePath: '.soter/state/runs/' + mixedRun.id + '.json',
      batch: mixedBatch,
      changeSet: mixedProposal,
      approval: mixedApproval,
      at: FIXTURE_TIME
    });
    for (const [index, response] of mixedResponses.slice(0, 4).entries()) {
      const call = connectedTransactionCurrentCall(absentCreateCheckpoint);
      absentCreateCheckpoint = (await completeConnectedTransactionCall({
        root: temp,
        lock,
        checkpoint: absentCreateCheckpoint,
        callId: call.id,
        response,
        at: '2026-07-15T12:01:0' + (index + 1) + '.000Z'
      })).checkpoint;
    }
    const ambiguousCreateCall = connectedTransactionCurrentCall(absentCreateCheckpoint);
    absentCreateCheckpoint = await failConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: absentCreateCheckpoint,
      callId: ambiguousCreateCall.id,
      error: { kind: 'unavailable', message: 'Injected terminal create transport ambiguity.' },
      at: '2026-07-15T12:01:05.000Z'
    });
    absentCreateCheckpoint = await prepareConnectedTransactionReconciliation({
      root: temp,
      lock,
      checkpoint: absentCreateCheckpoint,
      at: '2026-07-15T12:01:06.000Z'
    });
    absentCreateCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: absentCreateCheckpoint,
      callId: connectedTransactionCurrentCall(absentCreateCheckpoint).id,
      response: emptyReadResponse,
      at: '2026-07-15T12:01:07.000Z'
    })).checkpoint;
    const rollbackAfterAbsentCreate = connectedTransactionCurrentCall(absentCreateCheckpoint);
    absentCreateCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: absentCreateCheckpoint,
      callId: rollbackAfterAbsentCreate.id,
      response: notionUpdateResponse(updateRecordId),
      at: '2026-07-15T12:01:08.000Z'
    })).checkpoint;
    absentCreateCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: absentCreateCheckpoint,
      callId: connectedTransactionCurrentCall(absentCreateCheckpoint).id,
      response: notionTaskReadResponse(updateRecordId, updatePriorFields),
      at: '2026-07-15T12:01:09.000Z'
    })).checkpoint;
    if (ambiguousCreateCall.capability.id !== 'crm.records.create'
      || absentCreateCheckpoint.state !== 'rolled-back'
      || absentCreateCheckpoint.operations[0].state !== 'compensated'
      || absentCreateCheckpoint.operations[1].state !== 'failed'
      || absentCreateCheckpoint.operations[1].ambiguities[0].resolution !== 'absent'
      || absentCreateCheckpoint.operations[1].reconciliations[0].outcome !== 'absent'
      || rollbackAfterAbsentCreate.capability.id !== 'crm.records.update') {
      failures.push('ambiguous terminal create did not reconcile absence and compensate prior updates without replay or deletion');
    }

    let foundCreateCheckpoint = await createConnectedTransactionCheckpoint({
      root: temp,
      lock,
      lockPath,
      run: mixedRun,
      runSourcePath: 'soter/fixtures/meeting-intake/connected-terminal-create-found-selftest.run.json',
      runStatePath: '.soter/state/runs/' + mixedRun.id + '.json',
      batch: mixedBatch,
      changeSet: mixedProposal,
      approval: mixedApproval,
      at: FIXTURE_TIME
    });
    for (const [index, response] of mixedResponses.slice(0, 4).entries()) {
      const call = connectedTransactionCurrentCall(foundCreateCheckpoint);
      foundCreateCheckpoint = (await completeConnectedTransactionCall({
        root: temp,
        lock,
        checkpoint: foundCreateCheckpoint,
        callId: call.id,
        response,
        at: '2026-07-15T12:02:0' + (index + 1) + '.000Z'
      })).checkpoint;
    }
    const foundAmbiguousCreateCall = connectedTransactionCurrentCall(foundCreateCheckpoint);
    foundCreateCheckpoint = await failConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: foundCreateCheckpoint,
      callId: foundAmbiguousCreateCall.id,
      error: { kind: 'unavailable', message: 'Injected terminal create result loss.' },
      at: '2026-07-15T12:02:05.000Z'
    });
    foundCreateCheckpoint = await prepareConnectedTransactionReconciliation({
      root: temp,
      lock,
      checkpoint: foundCreateCheckpoint,
      at: '2026-07-15T12:02:06.000Z'
    });
    foundCreateCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: foundCreateCheckpoint,
      callId: connectedTransactionCurrentCall(foundCreateCheckpoint).id,
      response: notionSummaryReadResponse(summaryRecordId, summaryFields),
      at: '2026-07-15T12:02:07.000Z'
    })).checkpoint;
    const foundCreateContentCall = connectedTransactionCurrentCall(foundCreateCheckpoint);
    foundCreateCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: foundCreateCheckpoint,
      callId: foundCreateContentCall.id,
      response: notionPageResponse({
        uri: summaryRecordId,
        title: summaryFields.title,
        body: summaryBody
      }),
      at: '2026-07-15T12:02:08.000Z'
    })).checkpoint;
    if (foundCreateCheckpoint.state !== 'completed'
      || foundCreateCheckpoint.operations[1].ambiguities[0].resolution !== 'approved-fields'
      || foundCreateCheckpoint.operations[1].createdRecordId !== summaryRecordId
      || foundCreateContentCall.capability.id !== 'documents.content.read'
      || foundCreateCheckpoint.operations[1].write.call.id !== foundAmbiguousCreateCall.id) {
      failures.push('ambiguous terminal create did not resume from exact record and content proof without retrying the write');
    }

    let contentMismatchCheckpoint = await createConnectedTransactionCheckpoint({
      root: temp,
      lock,
      lockPath,
      run: mixedRun,
      runSourcePath: 'soter/fixtures/meeting-intake/connected-terminal-create-content-selftest.run.json',
      runStatePath: '.soter/state/runs/' + mixedRun.id + '.json',
      batch: mixedBatch,
      changeSet: mixedProposal,
      approval: mixedApproval,
      at: FIXTURE_TIME
    });
    for (const [index, response] of mixedResponses.slice(0, 6).entries()) {
      const call = connectedTransactionCurrentCall(contentMismatchCheckpoint);
      contentMismatchCheckpoint = (await completeConnectedTransactionCall({
        root: temp,
        lock,
        checkpoint: contentMismatchCheckpoint,
        callId: call.id,
        response,
        at: '2026-07-15T12:03:0' + (index + 1) + '.000Z'
      })).checkpoint;
    }
    const mismatchedContentCall = connectedTransactionCurrentCall(contentMismatchCheckpoint);
    contentMismatchCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: contentMismatchCheckpoint,
      callId: mismatchedContentCall.id,
      response: notionPageResponse({
        uri: summaryRecordId,
        title: summaryFields.title,
        body: 'Unexpected provider body.'
      }),
      at: '2026-07-15T12:03:07.000Z'
    })).checkpoint;
    contentMismatchCheckpoint = await prepareConnectedTransactionReconciliation({
      root: temp,
      lock,
      checkpoint: contentMismatchCheckpoint,
      at: '2026-07-15T12:03:08.000Z'
    });
    const contentReconciliationCall = connectedTransactionCurrentCall(contentMismatchCheckpoint);
    contentMismatchCheckpoint = (await completeConnectedTransactionCall({
      root: temp,
      lock,
      checkpoint: contentMismatchCheckpoint,
      callId: contentReconciliationCall.id,
      response: notionPageResponse({
        uri: summaryRecordId,
        title: summaryFields.title,
        body: summaryBody
      }),
      at: '2026-07-15T12:03:09.000Z'
    })).checkpoint;
    if (mismatchedContentCall.capability.id !== 'documents.content.read'
      || contentReconciliationCall.capability.id !== 'documents.content.read'
      || contentMismatchCheckpoint.state !== 'completed'
      || contentMismatchCheckpoint.operations[1].ambiguities[0].resolution
        !== 'approved-content'
      || contentMismatchCheckpoint.operations[1].reconciliations[0].outcome
        !== 'approved-content') {
      failures.push('terminal create content mismatch did not stay ambiguous until exact body reconciliation succeeded');
    }

    writeJson(path.join(temp, 'soter/fixtures/meeting-intake/preflight.run.json'), envelope);
    writeJson(path.join(temp, 'soter/fixtures/meeting-intake/resolution.evidence.json'), resolutionEvidence);
    writeJson(path.join(temp, 'soter/fixtures/meeting-intake/preparation.evidence.json'), preparationEvidence);
    writeJson(path.join(temp, 'soter/fixtures/meeting-intake/offline.doctor.json'), doctor.report);
    writeJson(
      path.join(temp, 'soter/fixtures/meeting-intake/connected.doctor.json'),
      connectedWithoutProbes.report
    );
    writeJson(path.join(temp, 'soter/fixtures/meeting-intake/contained.run.json'), contained.envelope);
    writeJson(path.join(temp, 'soter/fixtures/meeting-intake/contained.context.json'), contained.snapshot);
    writeJson(path.join(temp, 'soter/fixtures/meeting-intake/contained.evidence.json'), contextEvidence);
    writeJson(path.join(temp, 'soter/fixtures/meeting-intake/transaction.run.json'), transaction.envelope);
    writeJson(path.join(temp, 'soter/fixtures/meeting-intake/transaction.context.json'), transaction.snapshot);
    writeJson(path.join(temp, 'soter/fixtures/meeting-intake/transaction.decision.json'), transaction.decision);
    writeJson(path.join(temp, 'soter/fixtures/meeting-intake/transaction.changeset.json'), transaction.changeSet);
    writeJson(path.join(temp, 'soter/fixtures/meeting-intake/transaction.approval.json'), transaction.approval);
    writeJson(path.join(temp, 'soter/fixtures/meeting-intake/transaction.evidence.json'), transactionEvidence);
    doctor.evidence.forEach((record) => {
      writeJson(path.join(temp, 'soter/fixtures/meeting-intake/' + record.id + '.json'), record);
    });

    const verifiedFixtures = verifySoter(temp);
    if (verifiedFixtures.health.valid !== 'passed') {
      failures.push(
        'generated Core artifacts failed contracts: '
          + verifiedFixtures.violations.map((item) => {
            return item.code + ':' + path.relative(temp, item.file) + ':' + item.what;
          }).join(', ')
      );
    }
    if (doctor.report.states.valid !== 'passed'
      || doctor.report.states.ready !== 'unknown'
      || doctor.report.states.verified !== 'unknown'
      || doctor.report.states.healthy !== 'unknown') {
      failures.push('offline doctor overstated or understated its result states');
    }
    if (connectedWithoutProbes.report.states.ready !== 'unknown'
      || connectedWithoutProbes.report.checks.find((item) => {
        return item.id === 'integrations.implementations-ready';
      })?.state !== 'passed') {
      failures.push('connected doctor confused missing probes with missing provider implementations');
    }
    if (connected.report.states.valid !== 'passed'
      || connected.report.states.ready !== 'passed'
      || connected.report.states.verified !== 'unknown'
      || connected.report.states.healthy !== 'unknown'
      || connected.report.providerProbeIds.length !== 2) {
      failures.push('connected doctor did not derive readiness without overstating verification or health');
    }
    if (connectedWithFailedAttempt.report.states.ready !== 'failed'
      || !connectedWithFailedAttempt.report.diagnostics.some((item) => {
        return item.code === 'SOTER_PROVIDER_PROBE_UNAVAILABLE'
          && item.subject === connectedProviders.otter.id;
      })
      || connectedWithFailedAttempt.report.diagnostics.some((item) => {
        return item.code === 'SOTER_PROVIDER_PROBE_MISSING'
          && item.subject === connectedProviders.otter.id;
      })
      || connectedWithFailedAttempt.report.checks.find((item) => {
        return item.id === 'integrations.probes-complete';
      })?.state !== 'failed') {
      failures.push('connected doctor collapsed an exact failed provider attempt into a missing probe');
    }
    if (connectedWithExpiredAttempt.report.states.ready !== 'stale'
      || !connectedWithExpiredAttempt.report.diagnostics.some((item) => {
        return item.code === 'SOTER_PROVIDER_PROBE_ATTEMPT_STALE';
      })) {
      failures.push('connected doctor treated an expired provider failure as current');
    }
    const expiredProbes = structuredClone(probes);
    expiredProbes[0].probedAt = '2026-07-15T11:00:00.000Z';
    expiredProbes[0].validUntil = '2026-07-15T11:30:00.000Z';
    const expired = runConnectedDoctor({
      root: temp,
      lock,
      doctorId: 'doctor.meeting-intake.expired-selftest',
      evidenceId: 'evidence.meeting-intake.doctor.fixture',
      createdAt: FIXTURE_TIME,
      providerProbes: expiredProbes
    });
    if (expired.report.states.ready !== 'stale'
      || !expired.report.diagnostics.some((item) => item.code === 'SOTER_PROVIDER_PROBE_STALE')) {
      failures.push('connected doctor accepted an expired provider probe as current readiness');
    }
    const mismatchedProbes = structuredClone(probes);
    mismatchedProbes[0].configuration.lockFingerprint = 'sha256:' + '0'.repeat(64);
    const mismatched = runConnectedDoctor({
      root: temp,
      lock,
      doctorId: 'doctor.meeting-intake.mismatched-selftest',
      evidenceId: 'evidence.meeting-intake.doctor.fixture',
      createdAt: FIXTURE_TIME,
      providerProbes: mismatchedProbes
    });
    if (mismatched.report.states.ready !== 'failed'
      || !mismatched.report.diagnostics.some((item) => item.code === 'SOTER_PROVIDER_PROBE_LINK')) {
      failures.push('connected doctor reused a provider probe from a different lock');
    }
    if (envelope.effects.length || envelope.outputs.length || envelope.approvals.length) {
      failures.push('fixture preparation recorded effects, outputs, or approvals that did not occur');
    }
    if (envelope.context.some((item) => item.status !== 'declared' || item.freshness !== 'unknown')) {
      failures.push('fixture envelope represented unloaded context as loaded or fresh');
    }
    if (contained.envelope.lifecycleState !== 'paused'
      || contained.envelope.effects.length !== 3
      || contained.envelope.effects.some((item) => item.state !== 'passed')) {
      failures.push('contained context run did not record three successful typed read invocations and pause');
    }
    if (contained.snapshot.entries.length !== 3
      || contained.snapshot.entries.some((item) => item.freshness !== 'passed')) {
      failures.push('contained context snapshot omitted a source or overstated fixture freshness');
    }
    if (transaction.envelope.lifecycleState !== 'completed'
      || transaction.changeSet.state !== 'committed'
      || transaction.changeSet.verification.state !== 'passed'
      || transaction.changeSet.operations.some((item) => item.state !== 'passed')) {
      failures.push('approved contained transaction did not commit and verify every operation');
    }
    const operationPlan = {
      $contract: 'soter://contracts/operation-plan/v1',
      contractVersion: '1.0.0',
      id: 'plan.meeting-intake.multi-target-selftest',
      runId: envelope.id,
      createdAt: FIXTURE_TIME,
      mode: 'sequential',
      failurePolicy: 'stop',
      reason: 'Prove that Core can resume two portable Notion reads without using cross-data-source SQL.',
      steps: [
        {
          id: 'step.read-meeting',
          capability: 'crm.records.read',
          authority: 'authority.crm.instance',
          providerImplementation: connectedProviders.notion.id,
          input: { recordTypes: ['meeting'], limit: 1 },
          reason: 'Read one meeting target through its portable capability.'
        },
        {
          id: 'step.read-task',
          capability: 'crm.records.read',
          authority: 'authority.crm.instance',
          providerImplementation: connectedProviders.notion.id,
          input: { recordTypes: ['task'], limit: 1 },
          reason: 'Read one task target after the meeting step completes.'
        }
      ]
    };
    const duplicateStepPlan = structuredClone(operationPlan);
    duplicateStepPlan.steps[1].id = duplicateStepPlan.steps[0].id;
    let duplicatePlanStepRejected = false;
    try {
      assertOperationPlanDocument(temp, duplicateStepPlan);
    } catch (error) {
      duplicatePlanStepRejected = error.message.includes('identifiers must be unique');
    }
    const wrongAutomationRunPath = 'soter/fixtures/meeting-intake/wrong-automation-selftest.run.json';
    const wrongAutomationRun = readJson(
      path.join(temp, 'soter/fixtures/meeting-intake/preflight.run.json')
    );
    wrongAutomationRun.id = 'run.meeting-intake.wrong-automation-selftest';
    wrongAutomationRun.automation.id = 'automation.not-selected';
    writeJson(path.join(temp, wrongAutomationRunPath), wrongAutomationRun);
    const wrongAutomationPlan = structuredClone(operationPlan);
    wrongAutomationPlan.id = 'plan.meeting-intake.wrong-automation-selftest';
    wrongAutomationPlan.runId = wrongAutomationRun.id;
    let wrongAutomationRejected = false;
    try {
      await prepareDurableOperationPlanExecution({
        root: temp,
        lockPath,
        runPath: wrongAutomationRunPath,
        plan: wrongAutomationPlan,
        at: FIXTURE_TIME,
        expectedHost: 'codex'
      });
    } catch (error) {
      wrongAutomationRejected = error.message.includes(
        'exact selected automation and authority declarations'
      );
    }
    const invalidTailPlan = structuredClone(operationPlan);
    invalidTailPlan.id = 'plan.meeting-intake.invalid-tail-selftest';
    invalidTailPlan.steps[1].providerImplementation = 'provider.missing.connected';
    let invalidTailRejectedBeforeDispatch = false;
    try {
      await prepareDurableOperationPlanExecution({
        root: temp,
        lockPath,
        runPath: 'soter/fixtures/meeting-intake/preflight.run.json',
        plan: invalidTailPlan,
        at: FIXTURE_TIME,
        expectedHost: 'codex'
      });
    } catch (error) {
      invalidTailRejectedBeforeDispatch = error.message.includes(
        'step.read-task cannot be prepared'
      );
    }
    const invalidTailCheckpoint = path.join(
      temp,
      '.soter/state/host-calls/checkpoint.plan.meeting-intake.invalid-tail-selftest.json'
    );
    const preparedPlan = await prepareDurableOperationPlanExecution({
      root: temp,
      lockPath,
      runPath: 'soter/fixtures/meeting-intake/preflight.run.json',
      plan: operationPlan,
      at: FIXTURE_TIME,
      expectedHost: 'codex'
    });
    const firstPlanCall = preparedPlan.currentCall;
    const firstPlanResponse = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: [{
            __soterType: 'meeting',
            __soterId: 'https://app.notion.com/plan-meeting-selftest',
            __soterFields: JSON.stringify({
              title: 'Plan selftest meeting',
              meetingType: 'Project Sync',
              recordingUri: 'https://otter.ai/u/plan-selftest-meeting',
              organizationUris: '[]',
              participantIds: '[]'
            })
          }],
          has_more: false
        })
      }],
      privateMarker: 'raw-plan-meeting-response-marker'
    };
    const advancedPlan = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedPlan.checkpoint.id,
      callId: firstPlanCall.id,
      response: firstPlanResponse,
      at: '2026-07-15T12:00:01.000Z',
      expectedHost: 'codex'
    });
    const secondPlanCall = advancedPlan.currentCall;
    const rehydratedPlan = getDurableHostExecution({
      root: temp,
      checkpointId: preparedPlan.checkpoint.id,
      expectedHost: 'codex'
    });
    let wrongPlanCallRejected = false;
    try {
      await completeDurableOperationPlanExecution({
        root: temp,
        checkpointId: preparedPlan.checkpoint.id,
        callId: 'toolcall.wrong-plan-step',
        response: firstPlanResponse,
        at: '2026-07-15T12:00:01.500Z',
        expectedHost: 'codex'
      });
    } catch (error) {
      wrongPlanCallRejected = error.message.includes('exact current step call');
    }
    const secondPlanResponse = {
      structuredContent: {
        result: {
          results: [{
            __soterType: 'task',
            __soterId: 'https://app.notion.com/plan-task-selftest',
            __soterFields: JSON.stringify({
              title: 'Plan selftest task',
              status: 'Open',
              context: null,
              projectUris: '[]'
            })
          }],
          has_more: false
        }
      },
      privateMarker: 'raw-plan-task-response-marker'
    };
    const completedPlan = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedPlan.checkpoint.id,
      callId: secondPlanCall.id,
      response: secondPlanResponse,
      at: '2026-07-15T12:00:02.000Z',
      expectedHost: 'codex'
    });
    const replayedFirstPlanStep = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedPlan.checkpoint.id,
      callId: firstPlanCall.id,
      response: firstPlanResponse,
      at: '2026-07-15T12:00:03.000Z',
      expectedHost: 'codex'
    });
    if (!duplicatePlanStepRejected
      || !wrongAutomationRejected
      || !invalidTailRejectedBeforeDispatch
      || fs.existsSync(invalidTailCheckpoint)
      || preparedPlan.checkpoint.state !== 'requested'
      || firstPlanCall?.capability.id !== 'crm.records.read'
      || firstPlanCall?.arguments?.data?.data_source_urls?.length !== 1
      || advancedPlan.checkpoint.state !== 'requested'
      || advancedPlan.checkpoint.currentStepId !== 'step.read-task'
      || advancedPlan.checkpoint.steps[0]?.state !== 'completed'
      || secondPlanCall?.id === firstPlanCall?.id
      || rehydratedPlan.checkpoint.currentStepId !== 'step.read-task'
      || !wrongPlanCallRejected
      || completedPlan.checkpoint.state !== 'completed'
      || completedPlan.checkpoint.currentStepId !== null
      || completedPlan.checkpoint.steps.some((step) => step.state !== 'completed')
      || completedPlan.checkpoint.result?.outputFingerprints.length !== 2
      || replayedFirstPlanStep.checkpoint.checkpointFingerprint
        !== completedPlan.checkpoint.checkpointFingerprint
      || JSON.stringify(completedPlan).includes('raw-plan-')) {
      failures.push('durable operation plan did not preserve exact sequential dispatch, recovery, idempotency, and response minimization');
    }
    const failedBindingRunPath = 'soter/fixtures/meeting-intake/failed-binding-selftest.run.json';
    const failedBindingRun = readJson(
      path.join(temp, 'soter/fixtures/meeting-intake/preflight.run.json')
    );
    failedBindingRun.id = 'run.meeting-intake.failed-binding-selftest';
    writeJson(path.join(temp, failedBindingRunPath), failedBindingRun);
    const failedBindingPlan = {
      $contract: 'soter://contracts/operation-plan/v2',
      contractVersion: '2.0.0',
      id: 'plan.meeting-intake.failed-binding-selftest',
      runId: failedBindingRun.id,
      createdAt: FIXTURE_TIME,
      mode: 'sequential',
      failurePolicy: 'stop',
      reason: 'Prove empty fail-plan bindings stop deterministically without emitting a broad provider request.',
      steps: [
        {
          id: 'step.binding-source-meeting',
          capability: 'crm.records.read',
          authority: 'authority.crm.instance',
          providerImplementation: connectedProviders.notion.id,
          input: { recordTypes: ['meeting'], limit: 1 },
          inputBindings: [],
          reason: 'Read one meeting that has no organization relations.'
        },
        {
          id: 'step.binding-required-organizations',
          capability: 'crm.records.read',
          authority: 'authority.crm.instance',
          providerImplementation: connectedProviders.notion.id,
          input: { recordTypes: ['organization'], limit: 100 },
          inputBindings: [{
            id: 'binding.required-organization-uris',
            sourceStepId: 'step.binding-source-meeting',
            sourcePath: ['records', '*', 'fields', 'organizationUris'],
            targetPath: ['ids'],
            transform: 'unique-string-list',
            onEmpty: 'fail-plan'
          }],
          reason: 'Require at least one referenced organization without allowing an unfiltered read.'
        }
      ]
    };
    const invalidBoundTailPlan = structuredClone(failedBindingPlan);
    invalidBoundTailPlan.id = 'plan.meeting-intake.invalid-bound-tail-selftest';
    invalidBoundTailPlan.steps[1].providerImplementation = 'provider.missing.connected';
    let invalidBoundTailRejected = false;
    try {
      await prepareDurableOperationPlanExecution({
        root: temp,
        lockPath,
        runPath: failedBindingRunPath,
        plan: invalidBoundTailPlan,
        at: FIXTURE_TIME,
        expectedHost: 'codex'
      });
    } catch (error) {
      invalidBoundTailRejected = error.message.includes(
        'step.binding-required-organizations cannot be prepared'
      );
    }
    const preparedFailedBinding = await prepareDurableOperationPlanExecution({
      root: temp,
      lockPath,
      runPath: failedBindingRunPath,
      plan: failedBindingPlan,
      at: FIXTURE_TIME,
      expectedHost: 'codex'
    });
    const completedFailedBinding = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedFailedBinding.checkpoint.id,
      callId: preparedFailedBinding.currentCall.id,
      response: firstPlanResponse,
      at: '2026-07-15T12:00:03.500Z',
      expectedHost: 'codex'
    });
    if (!invalidBoundTailRejected
      || fs.existsSync(path.join(
        temp,
        '.soter/state/host-calls/checkpoint.plan.meeting-intake.invalid-bound-tail-selftest.json'
      ))
      || completedFailedBinding.checkpoint.state !== 'failed'
      || completedFailedBinding.currentCall !== null
      || completedFailedBinding.checkpoint.steps[1]?.state !== 'failed'
      || completedFailedBinding.checkpoint.steps[1]?.call !== null
      || completedFailedBinding.checkpoint.steps[1]?.resolvedInput?.ids?.length !== 0
      || completedFailedBinding.checkpoint.steps[1]?.bindingResolutions[0]?.state !== 'empty') {
      failures.push('bound plan preflight or empty fail-plan semantics allowed unsafe provider work');
    }
    const connectedContextRecording = 'https://otter.ai/u/context-selftest';
    const connectedContextRunPath = 'soter/fixtures/meeting-intake/connected-context-selftest.run.json';
    const connectedContextRun = readJson(
      path.join(temp, 'soter/fixtures/meeting-intake/preflight.run.json')
    );
    connectedContextRun.id = 'run.meeting-intake.connected-context-selftest';
    writeJson(path.join(temp, connectedContextRunPath), connectedContextRun);
    const preparedConnectedContext = await prepareMeetingIntakeConnectedContext({
      root: temp,
      lockPath,
      runPath: connectedContextRunPath,
      snapshotId: 'context.meeting-intake.connected.selftest',
      meetingId: 'meeting.context-selftest',
      recordingUri: connectedContextRecording,
      at: '2026-07-15T12:00:04.000Z',
      expectedHost: 'codex'
    });
    const forwardBoundPlan = structuredClone(preparedConnectedContext.checkpoint.plan);
    const connectedOrganizationsIndex = forwardBoundPlan.steps.findIndex((step) => {
      return step.id === 'step.context-organizations';
    });
    forwardBoundPlan.steps[connectedOrganizationsIndex]
      .inputBindings[0].sourceStepId = 'step.context-tasks';
    let forwardBindingRejected = false;
    try {
      assertOperationPlanDocument(temp, forwardBoundPlan);
    } catch (error) {
      forwardBindingRejected = error.message.includes('earlier step');
    }
    const overwritingBoundPlan = structuredClone(preparedConnectedContext.checkpoint.plan);
    overwritingBoundPlan.steps[connectedOrganizationsIndex]
      .input.ids = ['https://app.notion.com/fixed-broad-id'];
    let bindingOverwriteRejected = false;
    try {
      assertOperationPlanDocument(temp, overwritingBoundPlan);
    } catch (error) {
      bindingOverwriteRejected = error.message.includes('cannot overwrite');
    }
    const overlappingBoundPlan = structuredClone(preparedConnectedContext.checkpoint.plan);
    overlappingBoundPlan.steps[connectedOrganizationsIndex].inputBindings.push({
      id: 'binding.context-overlapping-organization-uris',
      sourceStepId: 'step.context-meeting-record',
      sourcePath: ['records', '*', 'fields', 'organizationUris'],
      targetPath: ['ids', 'nested'],
      transform: 'unique-string-list',
      onEmpty: 'skip-step'
    });
    let bindingOverlapRejected = false;
    try {
      assertOperationPlanDocument(temp, overlappingBoundPlan);
    } catch (error) {
      bindingOverlapRejected = error.message.includes('duplicate or overlap');
    }
    let incompleteContextRejected = false;
    try {
      finalizeMeetingIntakeConnectedContext({
        root: temp,
        checkpointId: preparedConnectedContext.checkpoint.id,
        expectedHost: 'codex'
      });
    } catch (error) {
      incompleteContextRejected = error.message.includes('completed operation plan');
    }
    const contextPolicyMarker = 'raw-connected-context-policy-marker';
    const contextPolicyBindings = applicablePolicySources(lock);
    const contextPolicyResponse = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: contextPolicyBindings.map((binding) => ({
            __soterType: 'policy',
            __soterId: binding.documentUri,
            __soterFields: JSON.stringify({ name: binding.title })
          })),
          has_more: false
        })
      }],
      privateMarker: contextPolicyMarker
    };
    let connectedContextPolicy = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedConnectedContext.checkpoint.id,
      callId: preparedConnectedContext.currentCall.id,
      response: contextPolicyResponse,
      at: '2026-07-15T12:00:05.000Z',
      expectedHost: 'codex'
    });
    const contextPolicyBodyMarkers = [];
    for (const [index, binding] of [...contextPolicyBindings]
      .sort((left, right) => left.id.localeCompare(right.id, 'en')).entries()) {
      const marker = 'raw-connected-context-policy-body-marker-' + index;
      contextPolicyBodyMarkers.push(marker);
      connectedContextPolicy = await completeDurableOperationPlanExecution({
        root: temp,
        checkpointId: preparedConnectedContext.checkpoint.id,
        callId: connectedContextPolicy.currentCall.id,
        response: notionPageResponse({
          uri: binding.documentUri,
          title: binding.title,
          body: '# ' + binding.title + '\n\nSynthetic applicable policy body ' + index + '.',
          privateMarker: marker
        }),
        at: '2026-07-15T12:00:05.' + String(index + 1).padStart(3, '0') + 'Z',
        expectedHost: 'codex'
      });
    }
    const connectedContextTranscript = connectedContextPolicy;
    const contextTranscriptMarker = 'raw-connected-context-transcript-marker';
    const contextTranscriptResponse = {
      structuredContent: {
        result: {
          speakers: [
            { id: 'speaker.retro', displayName: 'Retro' },
            { id: 'speaker.maya', displayName: 'Maya' }
          ],
          segments: [{
            speakerId: 'speaker.maya',
            text: 'Please send the grounded follow-up.',
            startSeconds: 12
          }]
        }
      },
      privateMarker: contextTranscriptMarker
    };
    const connectedContextMeeting = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedConnectedContext.checkpoint.id,
      callId: connectedContextTranscript.currentCall.id,
      response: contextTranscriptResponse,
      at: '2026-07-15T12:00:06.000Z',
      expectedHost: 'codex'
    });
    const contextMeetingMarker = 'raw-connected-context-meeting-marker';
    const contextOrganizationMarker = 'raw-connected-context-organization-marker';
    const contextProjectMarker = 'raw-connected-context-project-marker';
    const contextTaskMarker = 'raw-connected-context-task-marker';
    const contextOrganizationUri = 'https://app.notion.com/context-organization-selftest';
    const contextProjectUri = 'https://app.notion.com/context-project-selftest';
    const contextTaskUri = 'https://app.notion.com/context-task-selftest';
    const contextMeetingResponse = {
      structuredContent: {
        result: {
          results: [{
            __soterType: 'meeting',
            __soterId: 'https://app.notion.com/context-meeting-selftest',
            __soterFields: JSON.stringify({
              title: 'Connected context selftest',
              meetingType: 'Project Sync',
              recordingUri: connectedContextRecording,
              organizationUris: JSON.stringify([contextOrganizationUri]),
              participantIds: JSON.stringify(['person.retro'])
            })
          }],
          has_more: false
        }
      },
      privateMarker: contextMeetingMarker
    };
    const connectedContextOrganization = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedConnectedContext.checkpoint.id,
      callId: connectedContextMeeting.currentCall.id,
      response: contextMeetingResponse,
      at: '2026-07-15T12:00:07.000Z',
      expectedHost: 'codex'
    });
    const connectedContextProject = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedConnectedContext.checkpoint.id,
      callId: connectedContextOrganization.currentCall.id,
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'organization',
              __soterId: contextOrganizationUri,
              __soterFields: JSON.stringify({
                name: 'Bound organization',
                organizationType: 'Client',
                tags: '[]',
                projectUris: JSON.stringify([contextProjectUri]),
                contactUris: '[]'
              })
            }],
            has_more: false
          }
        },
        privateMarker: contextOrganizationMarker
      },
      at: '2026-07-15T12:00:08.000Z',
      expectedHost: 'codex'
    });
    const connectedContextTask = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedConnectedContext.checkpoint.id,
      callId: connectedContextProject.currentCall.id,
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'project',
              __soterId: contextProjectUri,
              __soterFields: JSON.stringify({
                name: 'Bound project',
                projectType: 'Client Project',
                status: 'Active',
                organizationUris: JSON.stringify([contextOrganizationUri]),
                taskUris: JSON.stringify([contextTaskUri])
              })
            }],
            has_more: false
          }
        },
        privateMarker: contextProjectMarker
      },
      at: '2026-07-15T12:00:09.000Z',
      expectedHost: 'codex'
    });
    const completedConnectedContext = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedConnectedContext.checkpoint.id,
      callId: connectedContextTask.currentCall.id,
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'task',
              __soterId: contextTaskUri,
              __soterFields: JSON.stringify({
                title: 'Bound task',
                status: 'Open',
                context: 'Derived only from the selected project relation.',
                projectUris: JSON.stringify([contextProjectUri])
              })
            }],
            has_more: false
          }
        },
        privateMarker: contextTaskMarker
      },
      at: '2026-07-15T12:00:10.000Z',
      expectedHost: 'codex'
    });
    const finalizedConnectedContext = finalizeMeetingIntakeConnectedContext({
      root: temp,
      checkpointId: preparedConnectedContext.checkpoint.id,
      expectedHost: 'codex'
    });
    const replayedConnectedContext = finalizeMeetingIntakeConnectedContext({
      root: temp,
      checkpointId: preparedConnectedContext.checkpoint.id,
      expectedHost: 'codex'
    });
    const connectedSnapshotFile = path.join(temp, finalizedConnectedContext.snapshotPath);
    const connectedDurableContents = [
      finalizedConnectedContext.snapshotPath,
      finalizedConnectedContext.checkpointPath,
      finalizedConnectedContext.runPath
    ].map((file) => fs.readFileSync(path.join(temp, file), 'utf8')).join('\n');
    const connectedAuthorities = new Map(
      finalizedConnectedContext.run.context.map((item) => [item.authority, item.status])
    );
    const organizationRuntimeStep = connectedContextOrganization.checkpoint.steps.find((step) => {
      return step.id === 'step.context-organizations';
    });
    const meetingRuntimeStep = connectedContextOrganization.checkpoint.steps.find((step) => {
      return step.id === 'step.context-meeting-record';
    });
    const connectedPolicyEntries = finalizedConnectedContext.snapshot.entries.filter((entry) => {
      return entry.applicability?.state === 'applicable';
    });
    if (!incompleteContextRejected
      || !forwardBindingRejected
      || !bindingOverwriteRejected
      || !bindingOverlapRejected
      || preparedConnectedContext.checkpoint.$contract
        !== 'soter://contracts/operation-plan-checkpoint/v2'
      || preparedConnectedContext.currentCall?.capability.id !== 'crm.records.read'
      || preparedConnectedContext.currentCall?.arguments?.data?.data_source_urls?.length !== 1
      || connectedContextTranscript.currentCall?.capability.id !== 'meeting.transcript.read'
      || connectedContextTranscript.currentCall?.arguments?.id !== 'context-selftest'
      || connectedContextTranscript.checkpoint.steps
        .filter((step) => step.id.startsWith('step.context-policy.'))
        .some((step) => step.state !== 'completed'
          || step.call?.capability.id !== 'documents.content.read')
      || connectedContextMeeting.currentCall?.capability.id !== 'crm.records.read'
      || connectedContextMeeting.currentCall?.arguments?.data?.params?.[0]
        !== connectedContextRecording
      || connectedContextOrganization.checkpoint.currentStepId
        !== 'step.context-organizations'
      || connectedContextOrganization.currentCall?.arguments?.data?.params?.[0]
        !== contextOrganizationUri
      || organizationRuntimeStep?.bindingResolutions[0]?.sourceOutputFingerprint
        !== meetingRuntimeStep?.outputFingerprint
      || connectedContextProject.checkpoint.currentStepId !== 'step.context-projects'
      || connectedContextProject.currentCall?.arguments?.data?.params?.[0]
        !== contextProjectUri
      || connectedContextTask.checkpoint.currentStepId !== 'step.context-tasks'
      || connectedContextTask.currentCall?.arguments?.data?.params?.[0]
        !== contextTaskUri
      || completedConnectedContext.checkpoint.state !== 'completed'
      || completedConnectedContext.checkpoint.result?.stepResults?.length !== 9
      || finalizedConnectedContext.snapshot.containment !== 'connected'
      || finalizedConnectedContext.snapshot.entries.length !== 9
      || connectedPolicyEntries.length !== 3
      || connectedPolicyEntries.some((entry) => {
        return entry.role !== 'definition'
          || entry.capability !== 'documents.content.read'
          || !entry.applicability.sourceId.startsWith('source.policy.')
          || entry.applicability.subjects.length !== 1
          || !entry.value.document.bodyFingerprint.startsWith('sha256:');
      })
      || finalizedConnectedContext.run.lifecycleState !== 'paused'
      || connectedAuthorities.get('authority.crm.definition') !== 'loaded'
      || connectedAuthorities.get('authority.crm.instance') !== 'loaded'
      || connectedAuthorities.get('authority.otter.provider') !== 'loaded'
      || connectedAuthorities.get('authority.notion.provider') !== 'declared'
      || replayedConnectedContext.snapshotPath !== finalizedConnectedContext.snapshotPath
      || fingerprintJson(replayedConnectedContext.snapshot)
        !== fingerprintJson(finalizedConnectedContext.snapshot)
      || (process.platform !== 'win32'
        && (fs.statSync(connectedSnapshotFile).mode & 0o777) !== 0o600)
      || [
        contextPolicyMarker,
        contextTranscriptMarker,
        contextMeetingMarker,
        contextOrganizationMarker,
        contextProjectMarker,
        contextTaskMarker,
        ...contextPolicyBodyMarkers
      ]
        .some((marker) => connectedDurableContents.includes(marker))) {
      failures.push('connected context did not preserve bounded sources, exact identities, private durable recovery, and honest authority state');
    }
    const unboundSnapshot = structuredClone(finalizedConnectedContext.snapshot);
    unboundSnapshot.id = 'context.meeting-intake.connected.unbound-selftest';
    unboundSnapshot.entries[0].value.unboundMutation = true;
    const unboundContextUpdates = [...new Set(
      finalizedConnectedContext.snapshot.entries.map((entry) => entry.authority)
    )].map((authority) => {
      const current = finalizedConnectedContext.run.context.find((item) => {
        return item.authority === authority;
      });
      return {
        authority,
        status: current.status,
        provenance: current.provenance,
        freshness: current.freshness
      };
    });
    let unboundSnapshotRejected = false;
    try {
      commitDurableContextSnapshot({
        root: temp,
        checkpointId: preparedConnectedContext.checkpoint.id,
        snapshot: unboundSnapshot,
        contextUpdates: unboundContextUpdates,
        checkpointDetails: 'Reject a snapshot value that is not the normalized plan output.',
        expectedHost: 'codex'
      });
    } catch (error) {
      unboundSnapshotRejected = error.message.includes('normalized operation-plan output');
    }
    if (!unboundSnapshotRejected
      || fs.existsSync(path.join(
        temp,
        '.soter/state/context-snapshots/context.meeting-intake.connected.unbound-selftest.json'
      ))) {
      failures.push('Core accepted context that was not mechanically bound to normalized plan output');
    }
    const mismatchContextRunPath = 'soter/fixtures/meeting-intake/mismatch-context-selftest.run.json';
    const mismatchContextRun = structuredClone(connectedContextRun);
    mismatchContextRun.id = 'run.meeting-intake.mismatch-context-selftest';
    writeJson(path.join(temp, mismatchContextRunPath), mismatchContextRun);
    const preparedMismatchContext = await prepareMeetingIntakeConnectedContext({
      root: temp,
      lockPath,
      runPath: mismatchContextRunPath,
      snapshotId: 'context.meeting-intake.connected.mismatch-selftest',
      meetingId: 'meeting.mismatch-context-selftest',
      recordingUri: connectedContextRecording,
      at: '2026-07-15T12:00:08.000Z',
      expectedHost: 'codex'
    });
    let mismatchTranscriptCall = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedMismatchContext.checkpoint.id,
      callId: preparedMismatchContext.currentCall.id,
      response: contextPolicyResponse,
      at: '2026-07-15T12:00:09.000Z',
      expectedHost: 'codex'
    });
    mismatchTranscriptCall = (await completeContextPolicyBodies({
      root: temp,
      execution: mismatchTranscriptCall,
      bindings: contextPolicyBindings,
      atSecond: '2026-07-15T12:00:09'
    })).execution;
    const mismatchMeetingCall = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedMismatchContext.checkpoint.id,
      callId: mismatchTranscriptCall.currentCall.id,
      response: contextTranscriptResponse,
      at: '2026-07-15T12:00:10.000Z',
      expectedHost: 'codex'
    });
    const completedMismatchContext = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedMismatchContext.checkpoint.id,
      callId: mismatchMeetingCall.currentCall.id,
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'meeting',
              __soterId: 'https://app.notion.com/mismatch-context-meeting',
              __soterFields: JSON.stringify({
                title: 'Mismatched connected context',
                meetingType: 'Project Sync',
                recordingUri: 'https://otter.ai/u/a-different-meeting',
                organizationUris: '[]',
                participantIds: '[]'
              })
            }],
            has_more: false
          }
        }
      },
      at: '2026-07-15T12:00:11.000Z',
      expectedHost: 'codex'
    });
    let mismatchedMeetingRejected = false;
    try {
      finalizeMeetingIntakeConnectedContext({
        root: temp,
        checkpointId: preparedMismatchContext.checkpoint.id,
        expectedHost: 'codex'
      });
    } catch (error) {
      mismatchedMeetingRejected = error.message.includes('completed operation plan');
    }
    const mismatchMeetingStep = completedMismatchContext.checkpoint.steps.find((step) => {
      return step.id === 'step.context-meeting-record';
    });
    const mismatchRelatedSteps = completedMismatchContext.checkpoint.steps.filter((step) => {
      return ['step.context-organizations', 'step.context-projects', 'step.context-tasks']
        .includes(step.id);
    });
    if (!mismatchedMeetingRejected
      || completedMismatchContext.checkpoint.state !== 'failed'
      || completedMismatchContext.currentCall !== null
      || mismatchMeetingStep?.state !== 'failed'
      || mismatchRelatedSteps
        .some((step) => step.state !== 'pending' || step.call !== null)
      || fs.existsSync(path.join(
        temp,
        '.soter/state/context-snapshots/context.meeting-intake.connected.mismatch-selftest.json'
      ))) {
      failures.push('connected context accepted a CRM meeting that did not match the selected recording identity');
    }
    const emptyContextRunPath = 'soter/fixtures/meeting-intake/empty-context-selftest.run.json';
    const emptyContextRun = structuredClone(connectedContextRun);
    emptyContextRun.id = 'run.meeting-intake.empty-context-selftest';
    writeJson(path.join(temp, emptyContextRunPath), emptyContextRun);
    const preparedEmptyContext = await prepareMeetingIntakeConnectedContext({
      root: temp,
      lockPath,
      runPath: emptyContextRunPath,
      snapshotId: 'context.meeting-intake.connected.empty-selftest',
      meetingId: 'meeting.empty-context-selftest',
      recordingUri: connectedContextRecording,
      at: '2026-07-15T12:00:12.000Z',
      expectedHost: 'codex'
    });
    let emptyContextTranscript = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedEmptyContext.checkpoint.id,
      callId: preparedEmptyContext.currentCall.id,
      response: contextPolicyResponse,
      at: '2026-07-15T12:00:13.000Z',
      expectedHost: 'codex'
    });
    emptyContextTranscript = (await completeContextPolicyBodies({
      root: temp,
      execution: emptyContextTranscript,
      bindings: contextPolicyBindings,
      atSecond: '2026-07-15T12:00:13'
    })).execution;
    const emptyContextMeeting = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedEmptyContext.checkpoint.id,
      callId: emptyContextTranscript.currentCall.id,
      response: contextTranscriptResponse,
      at: '2026-07-15T12:00:14.000Z',
      expectedHost: 'codex'
    });
    const completedEmptyContext = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedEmptyContext.checkpoint.id,
      callId: emptyContextMeeting.currentCall.id,
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'meeting',
              __soterId: 'https://app.notion.com/empty-context-meeting',
              __soterFields: JSON.stringify({
                title: 'Meeting without related CRM records',
                meetingType: 'General',
                recordingUri: connectedContextRecording,
                organizationUris: '[]',
                participantIds: '[]'
              })
            }],
            has_more: false
          }
        }
      },
      at: '2026-07-15T12:00:15.000Z',
      expectedHost: 'codex'
    });
    const finalizedEmptyContext = finalizeMeetingIntakeConnectedContext({
      root: temp,
      checkpointId: preparedEmptyContext.checkpoint.id,
      expectedHost: 'codex'
    });
    const emptyRelatedSteps = completedEmptyContext.checkpoint.steps.filter((step) => {
      return ['step.context-organizations', 'step.context-projects', 'step.context-tasks']
        .includes(step.id);
    });
    if (completedEmptyContext.checkpoint.state !== 'completed'
      || completedEmptyContext.currentCall !== null
      || emptyRelatedSteps
        .some((step) => step.state !== 'skipped'
          || step.call !== null
          || step.bindingResolutions[0]?.state !== 'empty')
      || finalizedEmptyContext.snapshot.entries.length !== 6
      || finalizedEmptyContext.snapshot.effectIds.length !== 6) {
      failures.push('empty output bindings emitted a broad provider read or produced false related context');
    }
    const missingRelationRunPath = 'soter/fixtures/meeting-intake/missing-relation-selftest.run.json';
    const missingRelationRun = structuredClone(connectedContextRun);
    missingRelationRun.id = 'run.meeting-intake.missing-relation-selftest';
    writeJson(path.join(temp, missingRelationRunPath), missingRelationRun);
    const missingOrganizationUri = 'https://app.notion.com/missing-bound-organization';
    const preparedMissingRelation = await prepareMeetingIntakeConnectedContext({
      root: temp,
      lockPath,
      runPath: missingRelationRunPath,
      snapshotId: 'context.meeting-intake.connected.missing-relation-selftest',
      meetingId: 'meeting.missing-relation-selftest',
      recordingUri: connectedContextRecording,
      at: '2026-07-15T12:00:16.000Z',
      expectedHost: 'codex'
    });
    let missingRelationTranscript = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedMissingRelation.checkpoint.id,
      callId: preparedMissingRelation.currentCall.id,
      response: contextPolicyResponse,
      at: '2026-07-15T12:00:17.000Z',
      expectedHost: 'codex'
    });
    missingRelationTranscript = (await completeContextPolicyBodies({
      root: temp,
      execution: missingRelationTranscript,
      bindings: contextPolicyBindings,
      atSecond: '2026-07-15T12:00:17'
    })).execution;
    const missingRelationMeeting = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedMissingRelation.checkpoint.id,
      callId: missingRelationTranscript.currentCall.id,
      response: contextTranscriptResponse,
      at: '2026-07-15T12:00:18.000Z',
      expectedHost: 'codex'
    });
    const missingRelationOrganization = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedMissingRelation.checkpoint.id,
      callId: missingRelationMeeting.currentCall.id,
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'meeting',
              __soterId: 'https://app.notion.com/missing-relation-meeting',
              __soterFields: JSON.stringify({
                title: 'Meeting with a missing organization relation',
                meetingType: 'Project Sync',
                recordingUri: connectedContextRecording,
                organizationUris: JSON.stringify([missingOrganizationUri]),
                participantIds: '[]'
              })
            }],
            has_more: false
          }
        }
      },
      at: '2026-07-15T12:00:19.000Z',
      expectedHost: 'codex'
    });
    const completedMissingRelation = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedMissingRelation.checkpoint.id,
      callId: missingRelationOrganization.currentCall.id,
      response: {
        structuredContent: { result: { results: [], has_more: false } }
      },
      at: '2026-07-15T12:00:20.000Z',
      expectedHost: 'codex'
    });
    let missingRelationRejected = false;
    try {
      finalizeMeetingIntakeConnectedContext({
        root: temp,
        checkpointId: preparedMissingRelation.checkpoint.id,
        expectedHost: 'codex'
      });
    } catch (error) {
      missingRelationRejected = error.message.includes('every and only the records referenced');
    }
    const missingTailSteps = completedMissingRelation.checkpoint.steps.filter((step) => {
      return ['step.context-projects', 'step.context-tasks'].includes(step.id);
    });
    if (!missingRelationRejected
      || missingRelationOrganization.currentCall?.arguments?.data?.params?.[0]
        !== missingOrganizationUri
      || completedMissingRelation.checkpoint.state !== 'completed'
      || missingTailSteps
        .some((step) => step.state !== 'skipped' || step.call !== null)
      || fs.existsSync(path.join(
        temp,
        '.soter/state/context-snapshots/context.meeting-intake.connected.missing-relation-selftest.json'
      ))) {
      failures.push('missing bound records were accepted as complete related context');
    }
    const blockedWritePlan = await prepareDurableOperationPlanExecution({
      root: temp,
      lockPath,
      runPath: 'soter/fixtures/meeting-intake/preflight.run.json',
      plan: {
        $contract: 'soter://contracts/operation-plan/v1',
        contractVersion: '1.0.0',
        id: 'plan.meeting-intake.blocked-write-selftest',
        runId: envelope.id,
        createdAt: '2026-07-15T12:00:04.000Z',
        mode: 'sequential',
        failurePolicy: 'stop',
        reason: 'Prove that a sequential plan cannot grant itself confirmation-gated write authority.',
        steps: [{
          id: 'step.create-summary',
          capability: 'crm.records.create',
          authority: 'authority.crm.instance',
          providerImplementation: connectedProviders.notionWrites.id,
          input: {
            recordType: 'meeting-summary',
            deduplicationKey: 'selftest:operation-plan-blocked',
            fields: { title: 'Blocked plan summary' }
          },
          reason: 'Attempt one confirmation-gated write without an approval binding.'
        }]
      },
      at: '2026-07-15T12:00:04.000Z',
      expectedHost: 'codex'
    });
    if (blockedWritePlan.checkpoint.state !== 'blocked'
      || blockedWritePlan.currentCall !== null
      || blockedWritePlan.checkpoint.steps[0]?.call?.arguments !== null) {
      failures.push('operation plan widened authorization or emitted a blocked write request');
    }
    const conflicting = proposeMeetingIntakeChangeSet({
      root: temp,
      lock,
      snapshot: transaction.snapshot,
      decision: transaction.decision,
      id: 'changeset.meeting-intake.rollback-fixture',
      runId: transaction.envelope.id,
      createdAt: FIXTURE_TIME
    });
    conflicting.operations[0].input.expectedVersion = '999';
    conflicting.operations[0].inputFingerprint = fingerprintJson(conflicting.operations[0].input);
    conflicting.scopeFingerprint = changeSetScopeFingerprint(conflicting);
    const rollbackApproval = approveChangeSet({
      changeSet: conflicting,
      id: 'approval.meeting-intake.rollback-fixture',
      runId: conflicting.runId,
      createdAt: FIXTURE_TIME,
      actor: 'fixture.user',
      reason: 'Approve the planted-conflict batch to prove contained rollback behavior.'
    });
    const rolledBack = await executeContainedMeetingIntakeChangeSet({
      root: temp,
      lock,
      changeSet: conflicting,
      approval: rollbackApproval,
      at: FIXTURE_TIME
    });
    if (rolledBack.changeSet.state !== 'rolled-back'
      || rolledBack.changeSet.transaction.rollbackState !== 'passed'
      || rolledBack.changeSet.transaction.restoredFingerprint
        !== rolledBack.changeSet.transaction.checkpointFingerprint) {
      failures.push('planted expected-version conflict did not restore the fixture checkpoint');
    }
    const writeDecision = evaluateEffectPolicy(lock, ['write']);
    if (writeDecision[0].decision !== 'blocked') {
      failures.push('confirmation-required write was not blocked without explicit approval');
    }
    const prohibitedDecision = evaluateEffectPolicy(lock, ['destructive'], ['destructive']);
    if (prohibitedDecision[0].decision !== 'blocked') {
      failures.push('prohibited destructive effect was bypassed by an approval token');
    }
    const hostReadInput = {
      recordTypes: ['meeting'],
      ids: ['https://app.notion.com/meeting-selftest'],
      limit: 1
    };
    const preparedHostRead = await prepareHostToolCall({
      root: temp,
      lock,
      runId: 'run.meeting-intake.fixture',
      callId: 'toolcall.selftest.notion-read',
      capability: 'crm.records.read',
      authority: 'authority.crm.instance',
      providerImplementation: connectedProviders.notion.id,
      input: hostReadInput,
      at: FIXTURE_TIME
    });
    const preparedClaudeHostRead = await prepareHostToolCall({
      root: temp,
      lock: claudeLock,
      runId: 'run.meeting-intake.fixture',
      callId: 'toolcall.selftest.claude-notion-read',
      capability: 'crm.records.read',
      authority: 'authority.crm.instance',
      providerImplementation: connectedProviders.notion.id,
      input: hostReadInput,
      at: FIXTURE_TIME
    });
    const rejectedMultiTargetRead = await prepareHostToolCall({
      root: temp,
      lock,
      runId: 'run.meeting-intake.fixture',
      callId: 'toolcall.selftest.notion-multi-target-read',
      capability: 'crm.records.read',
      authority: 'authority.crm.instance',
      providerImplementation: connectedProviders.notion.id,
      input: { recordTypes: ['meeting', 'task'], limit: 1 },
      at: FIXTURE_TIME
    });
    const hostReadResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: [
              {
                __soterType: 'meeting',
                __soterId: 'https://app.notion.com/meeting-selftest',
                __soterFields: JSON.stringify({
                  title: 'Selftest meeting',
                  meetingType: 'Project Sync',
                  recordingUri: 'https://otter.ai/u/host-read-selftest',
                  organizationUris: JSON.stringify(['https://app.notion.com/org-selftest']),
                  participantIds: JSON.stringify(['user.selftest'])
                })
              }
            ],
            has_more: false,
            data_source_ids: ['selftest']
          })
        }
      ],
      isError: false,
      providerSecretMaterial: 'response-only-marker'
    };
    const completedHostRead = await completeHostToolCall({
      root: temp,
      lock,
      call: preparedHostRead.call,
      input: hostReadInput,
      response: hostReadResponse,
      at: FIXTURE_TIME
    });
    const completedClaudeHostRead = await completeHostToolCall({
      root: temp,
      lock: claudeLock,
      call: preparedClaudeHostRead.call,
      input: hostReadInput,
      response: hostReadResponse,
      at: FIXTURE_TIME
    });
    if (preparedHostRead.call.state !== 'requested'
      || preparedHostRead.call.transport.server !== 'notion'
      || preparedHostRead.call.transport.operation !== 'query_data_sources'
      || preparedHostRead.call.transport.tool
        !== 'mcp__codex_apps__notion_notion_query_data_sources'
      || completedHostRead.call.state !== 'completed'
      || completedHostRead.output?.records[0]?.id
        !== 'https://app.notion.com/meeting-selftest'
      || !completedHostRead.output?.records[0]?.version?.startsWith('sha256:')
      || completedHostRead.output?.records[0]?.fields?.organizationUris?.[0]
        !== 'https://app.notion.com/org-selftest'
      || JSON.stringify(completedHostRead.call).includes('response-only-marker')) {
      failures.push('Notion read bridge did not preserve mapped native dispatch, typed normalization, and response minimization');
    }
    if (preparedClaudeHostRead.call.state !== 'requested'
      || preparedClaudeHostRead.call.transport.tool !== 'Notion:notion-query-data-sources'
      || preparedClaudeHostRead.call.host.id !== 'claude'
      || preparedHostRead.call.inputFingerprint !== preparedClaudeHostRead.call.inputFingerprint
      || fingerprintJson(completedHostRead.output)
        !== fingerprintJson(completedClaudeHostRead.output)
      || completedClaudeHostRead.call.outputFingerprint
        !== completedHostRead.call.outputFingerprint) {
      failures.push('Codex and Claude host adapters did not preserve one portable call and normalized result');
    }
    if (rejectedMultiTargetRead.call.state !== 'failed'
      || rejectedMultiTargetRead.call.transport.operation !== null
      || rejectedMultiTargetRead.call.transport.tool !== null
      || rejectedMultiTargetRead.call.error?.kind !== 'validation') {
      failures.push('Notion read bridge silently relied on plan-gated cross-data-source SQL');
    }
    const definitionBinding = contextPolicyBindings[0];
    const definitionInput = {
      uri: definitionBinding.documentUri,
      expectedTitle: definitionBinding.title
    };
    const preparedDefinitionRead = await prepareHostToolCall({
      root: temp,
      lock,
      runId: 'run.meeting-intake.fixture',
      callId: 'toolcall.selftest.notion-definition-read',
      capability: 'documents.content.read',
      authority: 'authority.crm.definition',
      providerImplementation: connectedProviders.notion.id,
      input: definitionInput,
      at: FIXTURE_TIME
    });
    const definitionRawMarker = 'private-definition-read-marker';
    const completedDefinitionRead = await completeHostToolCall({
      root: temp,
      lock,
      call: preparedDefinitionRead.call,
      input: definitionInput,
      response: notionPageResponse({
        uri: definitionBinding.documentUri,
        title: definitionBinding.title,
        body: '# ' + definitionBinding.title + '\n\nExact policy body.',
        privateMarker: definitionRawMarker
      }),
      at: FIXTURE_TIME
    });
    const preparedMismatchedDefinition = await prepareHostToolCall({
      root: temp,
      lock,
      runId: 'run.meeting-intake.fixture',
      callId: 'toolcall.selftest.notion-definition-mismatch',
      capability: 'documents.content.read',
      authority: 'authority.crm.definition',
      providerImplementation: connectedProviders.notion.id,
      input: definitionInput,
      at: FIXTURE_TIME
    });
    const mismatchedDefinition = await completeHostToolCall({
      root: temp,
      lock,
      call: preparedMismatchedDefinition.call,
      input: definitionInput,
      response: notionPageResponse({
        uri: definitionBinding.documentUri,
        title: 'Unexpected policy title',
        body: '# Unexpected\n\nWrong policy identity.'
      }),
      at: FIXTURE_TIME
    });
    const fixtureDefinitionRead = await invokeCapability({
      root: temp,
      lock,
      capability: 'documents.content.read',
      authority: 'authority.crm.definition',
      containment: 'fixture',
      input: definitionInput,
      effectId: 'effect.meeting-intake.definition-read.fixture',
      at: FIXTURE_TIME
    });
    if (preparedDefinitionRead.call.transport.operation !== 'fetch'
      || preparedDefinitionRead.call.transport.tool !== 'mcp__codex_apps__notion_fetch'
      || preparedDefinitionRead.call.arguments.id
        !== definitionBinding.documentUri.slice(-32)
      || completedDefinitionRead.call.state !== 'completed'
      || completedDefinitionRead.output?.document.uri !== definitionBinding.documentUri
      || !completedDefinitionRead.output?.document.bodyFingerprint?.startsWith('sha256:')
      || JSON.stringify(completedDefinitionRead).includes(definitionRawMarker)
      || mismatchedDefinition.call.state !== 'failed'
      || mismatchedDefinition.call.error?.kind !== 'conflict'
      || fixtureDefinitionRead.invocation.state !== 'passed'
      || fixtureDefinitionRead.output?.document.title !== definitionBinding.title) {
      failures.push('document definition read did not preserve exact identity, bounded normalization, fixture parity, and mismatch rejection');
    }
    const blockedHostWrite = await prepareHostToolCall({
      root: temp,
      lock,
      runId: 'run.meeting-intake.fixture',
      callId: 'toolcall.selftest.notion-write-blocked',
      capability: 'crm.records.create',
      authority: 'authority.crm.instance',
      providerImplementation: connectedProviders.notionWrites.id,
      input: {
        recordType: 'meeting-summary',
        deduplicationKey: 'selftest:mcp-blocked',
        fields: { title: 'Blocked host write' }
      },
      at: FIXTURE_TIME
    });
    if (blockedHostWrite.call.state !== 'blocked'
      || blockedHostWrite.call.transport.tool !== null
      || blockedHostWrite.call.arguments !== null) {
      failures.push('confirmation-required write emitted an MCP tool request before approval');
    }
    const mappedCreateInput = createProposal.operations[0].input;
    const preparedMappedCreate = await prepareHostToolCall({
      root: temp,
      lock,
      runId: createProposal.runId,
      callId: 'toolcall.selftest.notion-mapped-create',
      capability: 'crm.records.create',
      authority: 'authority.crm.instance',
      providerImplementation: connectedProviders.notion.id,
      input: mappedCreateInput,
      at: FIXTURE_TIME,
      approvedEffects: ['write']
    });
    const completedMappedCreate = await completeHostToolCall({
      root: temp,
      lock,
      call: preparedMappedCreate.call,
      input: mappedCreateInput,
      response: {
        structuredContent: {
          result: { pages: [{ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }] }
        }
      },
      at: FIXTURE_TIME
    });
    const mappedTaskCreateInput = {
      recordType: 'task',
      deduplicationKey: 'Prepare mapped task create',
      deduplicationFilter: {
        field: 'title',
        value: 'Prepare mapped task create'
      },
      fields: {
        title: 'Prepare mapped task create',
        status: 'To Do',
        context: 'Project',
        projectUris: ['https://www.notion.so/cccccccccccccccccccccccccccccccc'],
        assigneeIds: ['provider-person-selftest'],
        nextActionOn: '2026-07-24'
      }
    };
    const preparedMappedTaskCreate = await prepareHostToolCall({
      root: temp,
      lock,
      runId: createProposal.runId,
      callId: 'toolcall.selftest.notion-mapped-task-create',
      capability: 'crm.records.create',
      authority: 'authority.crm.instance',
      providerImplementation: connectedProviders.notion.id,
      input: mappedTaskCreateInput,
      at: FIXTURE_TIME,
      approvedEffects: ['write']
    });
    const completedMappedTaskCreate = await completeHostToolCall({
      root: temp,
      lock,
      call: preparedMappedTaskCreate.call,
      input: mappedTaskCreateInput,
      response: {
        structuredContent: {
          result: { pages: [{ id: 'dddddddddddddddddddddddddddddddd' }] }
        }
      },
      at: FIXTURE_TIME
    });
    const mappedTaskProperties = preparedMappedTaskCreate.call.arguments?.pages?.[0]?.properties;
    const invalidMappedTaskDate = structuredClone(mappedTaskCreateInput);
    invalidMappedTaskDate.fields.nextActionOn = '2026-02-30';
    const rejectedMappedTaskDate = await prepareHostToolCall({
      root: temp,
      lock,
      runId: createProposal.runId,
      callId: 'toolcall.selftest.notion-invalid-task-date',
      capability: 'crm.records.create',
      authority: 'authority.crm.instance',
      providerImplementation: connectedProviders.notion.id,
      input: invalidMappedTaskDate,
      at: FIXTURE_TIME,
      approvedEffects: ['write']
    });
    const mappedUpdateInput = updateProposal.operations[0].input;
    const preparedMappedUpdate = await prepareHostToolCall({
      root: temp,
      lock,
      runId: updateProposal.runId,
      callId: 'toolcall.selftest.notion-mapped-update',
      capability: 'crm.records.update',
      authority: 'authority.crm.instance',
      providerImplementation: connectedProviders.notion.id,
      input: mappedUpdateInput,
      at: FIXTURE_TIME,
      approvedEffects: ['write']
    });
    const completedMappedUpdate = await completeHostToolCall({
      root: temp,
      lock,
      call: preparedMappedUpdate.call,
      input: mappedUpdateInput,
      response: {
        structuredContent: { result: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }
      },
      at: FIXTURE_TIME
    });
    if (preparedMappedCreate.call.transport.operation !== 'create_pages'
      || preparedMappedCreate.call.transport.tool
        !== 'mcp__codex_apps__notion_notion_create_pages'
      || preparedMappedCreate.call.arguments.pages.length !== 1
      || completedMappedCreate.call.state !== 'completed'
      || completedMappedCreate.output?.created !== true
      || preparedMappedTaskCreate.call.transport.operation !== 'create_pages'
      || preparedMappedTaskCreate.call.arguments.parent.data_source_id
        !== '2abd79b5-de38-80f8-9470-000b7181b18d'
      || mappedTaskProperties?.Name !== 'Prepare mapped task create'
      || mappedTaskProperties?.Status !== 'To Do'
      || mappedTaskProperties?.Context !== 'Project'
      || mappedTaskProperties?.Project
        !== JSON.stringify(['https://www.notion.so/cccccccccccccccccccccccccccccccc'])
      || mappedTaskProperties?.['Assigned To'] !== JSON.stringify(['provider-person-selftest'])
      || mappedTaskProperties?.['date:Next Action:start'] !== '2026-07-24'
      || mappedTaskProperties?.['date:Next Action:is_datetime'] !== 0
      || completedMappedTaskCreate.call.state !== 'completed'
      || completedMappedTaskCreate.output?.record?.fields?.nextActionOn !== '2026-07-24'
      || rejectedMappedTaskDate.call.state !== 'failed'
      || rejectedMappedTaskDate.call.transport.tool !== null
      || preparedMappedUpdate.call.transport.operation !== 'update_page'
      || preparedMappedUpdate.call.transport.tool
        !== 'mcp__codex_apps__notion_notion_update_page'
      || preparedMappedUpdate.call.arguments.command !== 'update_properties'
      || completedMappedUpdate.call.state !== 'completed'
      || completedMappedUpdate.output?.changedFields?.[0] !== 'status') {
      failures.push('mapped Notion writes did not translate and normalize through exact native host routes');
    }
    const failedHostRead = failHostToolCall({
      root: temp,
      lock,
      call: preparedHostRead.call,
      error: Object.assign(new Error('Injected host transport failure.'), { kind: 'unavailable' }),
      at: FIXTURE_TIME
    });
    if (failedHostRead.state !== 'failed' || failedHostRead.error.kind !== 'unavailable') {
      failures.push('host MCP transport failure was not normalized into the portable error vocabulary');
    }
    const credentialLeakAttempt = await prepareHostToolCall({
      root: temp,
      lock,
      runId: 'run.meeting-intake.fixture',
      callId: 'toolcall.selftest.credential-leak',
      capability: 'crm.records.read',
      authority: 'authority.crm.instance',
      providerImplementation: connectedProviders.notion.id,
      input: hostReadInput,
      at: FIXTURE_TIME,
      translator: {
        prepareMcp() {
          return {
            tool: 'query_data_sources',
            arguments: { authorization: 'Bearer should-never-leave-the-host' }
          };
        }
      }
    });
    if (credentialLeakAttempt.call.state !== 'failed'
      || credentialLeakAttempt.call.arguments !== null
      || credentialLeakAttempt.call.error.kind !== 'validation') {
      failures.push('MCP bridge allowed credential-like material into provider arguments');
    }
    const otterReadInput = {
      meetingId: 'meeting.selftest',
      recordingUri: 'https://otter.ai/u/conversation_selftest'
    };
    const preparedOtterRead = await prepareHostToolCall({
      root: temp,
      lock,
      runId: 'run.meeting-intake.fixture',
      callId: 'toolcall.selftest.otter-read',
      capability: 'meeting.transcript.read',
      authority: 'authority.otter.provider',
      providerImplementation: connectedProviders.otter.id,
      input: otterReadInput,
      at: FIXTURE_TIME
    });
    const transcriptMarker = 'private-transcript-response-marker';
    const completedOtterRead = await completeHostToolCall({
      root: temp,
      lock,
      call: preparedOtterRead.call,
      input: otterReadInput,
      response: {
        structuredContent: {
          result: {
            speakers: [
              { id: 'speaker.selftest', displayName: 'Selftest speaker' }
            ],
            segments: [
              {
                speakerId: 'speaker.selftest',
                text: 'Selftest transcript segment.',
                startSeconds: 0
              }
            ],
            ignoredPrivateField: transcriptMarker
          }
        }
      },
      at: FIXTURE_TIME
    });
    if (preparedOtterRead.call.state !== 'requested'
      || preparedOtterRead.call.transport.operation !== 'fetch'
      || preparedOtterRead.call.transport.tool !== 'mcp__otter__fetch'
      || preparedOtterRead.call.arguments.id !== 'conversation_selftest'
      || completedOtterRead.call.state !== 'completed'
      || completedOtterRead.output?.meetingId !== 'meeting.selftest'
      || JSON.stringify(completedOtterRead).includes(transcriptMarker)) {
      failures.push('Otter MCP bridge did not enforce exact fetch translation and minimized normalization');
    }
    const invalidOtterRead = await prepareHostToolCall({
      root: temp,
      lock,
      runId: 'run.meeting-intake.fixture',
      callId: 'toolcall.selftest.otter-invalid-uri',
      capability: 'meeting.transcript.read',
      authority: 'authority.otter.provider',
      providerImplementation: connectedProviders.otter.id,
      input: {
        meetingId: 'meeting.selftest',
        recordingUri: 'https://example.com/not-an-otter-meeting'
      },
      at: FIXTURE_TIME
    });
    if (invalidOtterRead.call.state !== 'failed'
      || invalidOtterRead.call.arguments !== null
      || invalidOtterRead.call.error.kind !== 'validation') {
      failures.push('Otter MCP bridge emitted a provider request for an invalid recording URI');
    }
    const missingTranscript = await invokeCapability({
      root: temp,
      lock,
      capability: 'meeting.transcript.read',
      authority: 'authority.otter.provider',
      containment: 'fixture',
      input: {
        meetingId: 'meeting.missing',
        recordingUri: 'otter://fixture/meeting.missing'
      },
      effectId: 'effect.meeting-intake.transcript-missing.fixture',
      at: FIXTURE_TIME
    });
    if (missingTranscript.invocation.state !== 'failed'
      || missingTranscript.invocation.error.kind !== 'not-found') {
      failures.push('fixture provider did not normalize missing transcript as not-found');
    }
    const replayState = createFixtureRuntimeState(temp);
    const createInput = {
      recordType: 'meeting-summary',
      deduplicationKey: 'https://otter.ai/u/selftest-deduplication',
      deduplicationFilter: {
        field: 'link',
        value: 'https://otter.ai/u/selftest-deduplication'
      },
      fields: {
        title: 'Selftest summary',
        documentType: 'Meeting Summary',
        description: 'A grounded summary used to prove fixture replay safety.',
        link: 'https://otter.ai/u/selftest-deduplication'
      },
      body: 'A grounded summary used to prove fixture replay safety.'
    };
    const firstCreate = await invokeCapability({
      root: temp,
      lock,
      capability: 'crm.records.create',
      authority: 'authority.crm.instance',
      containment: 'fixture',
      input: createInput,
      effectId: 'effect.selftest.create-first',
      at: FIXTURE_TIME,
      approvedEffects: ['write'],
      runtimeState: replayState
    });
    const replayCreate = await invokeCapability({
      root: temp,
      lock,
      capability: 'crm.records.create',
      authority: 'authority.crm.instance',
      containment: 'fixture',
      input: createInput,
      effectId: 'effect.selftest.create-replay',
      at: FIXTURE_TIME,
      approvedEffects: ['write'],
      runtimeState: replayState
    });
    if (firstCreate.output?.created !== true
      || replayCreate.output?.created !== false
      || firstCreate.output?.record.id !== replayCreate.output?.record.id) {
      failures.push('fixture create did not deduplicate an identical replay');
    }
    const beforeInvalidContextWrite = fingerprintJson(replayState);
    const invalidContextCreateInput = structuredClone(createInput);
    invalidContextCreateInput.deduplicationKey = 'https://otter.ai/u/invalid-context-field';
    invalidContextCreateInput.deduplicationFilter.value = invalidContextCreateInput.deduplicationKey;
    invalidContextCreateInput.fields.link = invalidContextCreateInput.deduplicationKey;
    invalidContextCreateInput.fields.transcriptGrounded = true;
    const invalidContextCreate = await invokeCapability({
      root: temp,
      lock,
      capability: 'crm.records.create',
      authority: 'authority.crm.instance',
      containment: 'fixture',
      input: invalidContextCreateInput,
      effectId: 'effect.selftest.create-invalid-context-field',
      at: FIXTURE_TIME,
      approvedEffects: ['write'],
      runtimeState: replayState
    });
    if (invalidContextCreate.invocation.state !== 'failed'
      || invalidContextCreate.invocation.error?.kind !== 'validation'
      || !invalidContextCreate.invocation.error?.message.includes('Context record model')
      || fingerprintJson(replayState) !== beforeInvalidContextWrite) {
      failures.push('Core did not reject a provider-neutral write field absent from Context before fixture dispatch');
    }

    fs.appendFileSync(path.join(temp, 'AGENTS.md'), '\nselftest projection change\n');
    const liveOutputIgnored = runOfflineDoctor({
      root: temp,
      lock,
      doctorId: 'doctor.meeting-intake.live-output-ignored',
      evidenceId: 'evidence.meeting-intake.live-output-ignored',
      createdAt: FIXTURE_TIME
    });
    if (liveOutputIgnored.report.states.valid !== 'passed') {
      failures.push('doctor treated a developer host output as deterministic candidate authority');
    }
    fs.appendFileSync(
      path.join(temp, 'soter/hosts/codex/templates/AGENTS.md.tmpl'),
      '\nselftest canonical template change\n'
    );
    const stale = runOfflineDoctor({
      root: temp,
      lock,
      doctorId: 'doctor.meeting-intake.stale',
      evidenceId: 'evidence.meeting-intake.stale',
      createdAt: FIXTURE_TIME
    });
    if (stale.report.states.valid !== 'stale'
      || !stale.report.diagnostics.some((item) => item.code === 'SOTER_LOCK_STALE')) {
      failures.push('doctor did not detect a changed canonical host projection template');
    }

    const automationPackPath = path.join(
      temp,
      'soter/packs/automation.meeting-intake/pack.json'
    );
    const incompatibleAutomationPack = readJson(automationPackPath);
    incompatibleAutomationPack.compatibility.hosts = ['codex'];
    writeJson(automationPackPath, incompatibleAutomationPack);
    let incompatibleHostRejected = false;
    try {
      resolveConfiguration({ root: temp, configPath: meetingIntakeConfigPath, host: 'claude' });
    } catch (error) {
      incompatibleHostRejected = error.message.includes(
        'Selected host claude is incompatible with pack(s): automation.meeting-intake.'
      );
    }
    if (!incompatibleHostRejected) {
      failures.push('resolver accepted a host override incompatible with a selected pack');
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  if (failures.length) {
    failures.forEach((failure) => process.stderr.write('CORE SELFTEST FAIL: ' + failure + '\n'));
    return false;
  }
  process.stdout.write(
    'CORE SELFTEST PASS: deterministic source-bound and host-selectable locks, fingerprinted explainable configuration views, portable Codex and Claude request/result projection, typed fixture reads/writes, grounded Automation decisions with explicit ambiguity and abstention, exact-scope approval with selected-activity private review, compiler-exact request batches, deduplication, expected-version conflicts, rollback, read-after-write verification, resumable fixed and bound sequential operation plans, approval-bound connected update transactions and terminal creates with exact record/content verification, reverse compensation, and read-only ambiguity reconciliation, bounded connected context finalization with exact applicable policy bodies, resumable MCP host dispatch, exact-lock single and multi-step provider probes including minimized document reads, schema and identity drift rejection, exact subject-scoped maturity applicability, connected readiness, expiry, honest states, and stale-lock detection.\n'
  );
  return true;
}
