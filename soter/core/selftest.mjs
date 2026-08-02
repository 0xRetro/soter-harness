import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createFixtureRuntimeState,
  evaluateEffectPolicy,
  invokeCapability
} from './capabilities.mjs';
import {
  buildConfigurationView,
  formatConfigurationView
} from './configuration-view.mjs';
import {
  finalizeMeetingIntakeConnectedContext,
  prepareMeetingIntakeConnectedContext
} from '../automations/meeting-intake/context.mjs';
import { runConnectedDoctor, runOfflineDoctor } from './doctor.mjs';
import { inspectWorkspace } from './inspection.mjs';
import {
  createMigrationBridgeEvidence,
  createMigrationCompletionEvidence,
  createResolutionEvidence,
  createRunPreparationEvidence
} from './evidence.mjs';
import { evaluateConfigurationMaturity } from './maturity.mjs';
import {
  fingerprintLock,
  lockMatchesResolution,
  resolveConfiguration
} from './resolve.mjs';
import {
  privateConfigurationStatePath,
  removePrivateConfigurationState,
  writePrivateConfigurationState
} from './private-configurations.mjs';
import { prepareRunEnvelope } from './run.mjs';
import { prepareAutomationRun } from './prepared-work.mjs';
import { materializeContainedPrivateConfiguration } from './contained-private-configurations.mjs';
import {
  ConnectedConfigurationError,
  selectExactConnectedConfiguration
} from './connected-configuration.mjs';
import { assertOperationPlanDocument } from './operation-plans.mjs';
import {
  commitDurableContextSnapshot,
  completeDurableProviderProbeExecution,
  completeDurableOperationPlanExecution,
  failDurableHostExecution,
  getDurableHostExecution,
  listDurableHostExecutions,
  prepareDurableProviderProbeExecution,
  prepareDurableOperationPlanExecution
} from './service.mjs';
import {
  completeHostToolCall,
  failHostToolCall,
  prepareHostToolCall
} from './host-tools.mjs';
import { fingerprintJson, readJson, repoRelativePath, writeJson } from './lib/canonical-json.mjs';
import { validateJsonSchema, verifySoter } from '../kernel/verify.mjs';
import {
  activeConfigurationLockStatePath,
  writeActiveConfigurationLockState,
  writeContextSnapshotState,
  writeRunState
} from './runtime-state.mjs';
import { selftestFixtureMaterialization } from './fixtures-materialization.selftest.mjs';
import {
  selftestDevelopmentHostEvidenceFinalizationPublication
} from './development-host-evidence-finalization.mjs';
import {
  selftestDevelopmentHistoricalEvidenceBatchPublication
} from './development-historical-evidence-batch.mjs';

const FIXTURE_TIME = '2026-07-15T12:00:00.000Z';

function notionProbeStepResponse(
  checkpoint,
  identityMarker,
  driftStepId = null,
  optionMappings = []
) {
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
      const property = { name: field.provider, type: field.providerType };
      if (['status', 'select', 'multi_select'].includes(field.providerType)) {
        const declaration = optionMappings.find((item) => {
          return item.mapping === source.scope.mappingId
            && item.recordType === source.scope.recordType
            && item.field === field.portable;
        });
        if (!declaration) {
          throw new Error(
            'Core selftest has no private option mapping for '
              + source.scope.recordType + '.' + field.portable + '.'
          );
        }
        property.options = declaration.entries.map((entry) => ({
          name: entry.provider
        }));
      }
      return [field.provider, property];
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
        has_more: false,
        ...(privateMarker ? { privateMarker } : {})
      }
    }
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
        has_more: false,
        ...(privateMarker ? { privateMarker } : {})
      }
    }
  };
}

function notionTaskVersion(id, fields) {
  return fingerprintJson({ type: 'task', id, fields });
}

function notionUpdateResponse(id, privateMarker = null) {
  return {
    structuredContent: {
      result: { id, ...(privateMarker ? { privateMarker } : {}) }
    }
  };
}

function notionCreateResponse(id, privateMarker = null) {
  return {
    structuredContent: {
      result: { url: id, ...(privateMarker ? { privateMarker } : {}) }
    }
  };
}

function notionOptionMapping(mapping, recordType, field, entries) {
  return {
    mapping,
    recordType,
    field,
    mode: 'exact-bijection',
    entries
  };
}

function materializePrivateNotionTargetLock(root, configurationName, host = 'codex') {
  return materializeContainedPrivateConfiguration({
    root,
    configurationName,
    host
  }).lock;
}

function notionPageResponse({ uri, title, body, privateMarker = null }) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        metadata: { type: 'page' },
        title,
        url: uri,
        text: 'Here is the result of "view" for the Page with URL ' + uri
          + ' as of 2026-07-15T06:22:07.615Z:\n'
          + '<page url="' + uri + '">\n'
          + '<ancestor-path></ancestor-path>\n'
          + '<properties>{"title":' + JSON.stringify(title) + '}</properties>\n'
          + body + '\n'
          + '</page>',
        ...(privateMarker ? { privateMarker } : {})
      })
    }],
    isError: false
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
      authority: source.authority,
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
    $contract: 'soter://contracts/provider-probe/v2',
    contractVersion: '2.0.0',
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
        },
        {
          id: 'authority.projects.definition',
          state: 'passed',
          details: 'The configured Projects definition authority was visible.'
        },
        {
          id: 'authority.projects.instance',
          state: 'passed',
          details: 'The configured Projects instance authority was visible.'
        },
        {
          id: 'authority.tasks.definition',
          state: 'passed',
          details: 'The configured Tasks definition authority was visible.'
        },
        {
          id: 'authority.tasks.instance',
          state: 'passed',
          details: 'The configured Tasks instance authority was visible.'
        },
        {
          id: 'authority.meetings.definition',
          state: 'passed',
          details: 'The configured Meetings definition authority was visible.'
        },
        {
          id: 'authority.meetings.instance',
          state: 'passed',
          details: 'The configured Meetings instance authority was visible.'
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
          id: 'projects.records.read',
          state: 'passed',
          method: 'read-only',
          details: 'A schema-compatible Projects read-only response was observed.'
        },
        {
          id: 'tasks.records.read',
          state: 'passed',
          method: 'read-only',
          details: 'A schema-compatible Tasks read-only response was observed.'
        },
        {
          id: 'meetings.records.read',
          state: 'passed',
          method: 'read-only',
          details: 'A schema-compatible Meetings read-only response was observed.'
        },
        {
          id: 'documents.content.read',
          state: 'passed',
          method: 'read-only',
          details: 'Every exact configured title-bound document source normalized successfully.'
        },
        {
          id: 'meetings.records.create',
          state: 'passed',
          method: 'permission-introspection',
          details: 'Required Meeting create permissions were reported without creating a record.'
        },
        {
          id: 'tasks.records.update',
          state: 'passed',
          method: 'permission-introspection',
          details: 'Required Task update permissions were reported without updating a record.'
        }
      ],
      checks: [
        {
          id: 'check.identity',
          stepId: 'step.identity',
          kind: 'identity',
          subject: 'provider.identity',
          scopeFingerprint: fingerprintJson({ provider: providers.notion.id }),
          state: 'passed',
          method: 'metadata',
          expectedFingerprint: null,
          observedFingerprint: fingerprintJson({ authenticated: true }),
          details: 'The contained selftest observed the exact minimized provider identity check.'
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
      ],
      checks: [
        {
          id: 'check.identity',
          stepId: 'step.identity',
          kind: 'identity',
          subject: 'provider.identity',
          scopeFingerprint: fingerprintJson({ provider: providers.otter.id }),
          state: 'passed',
          method: 'metadata',
          expectedFingerprint: null,
          observedFingerprint: fingerprintJson({ authenticated: true }),
          details: 'The contained selftest observed the exact minimized provider identity check.'
        }
      ]
    }
  ];
}

export async function selftest(root) {
  const failures = [];
  try {
    selftestDevelopmentHostEvidenceFinalizationPublication();
  } catch (error) {
    failures.push('development host evidence finalization publication failed: ' + error.message);
  }
  try {
    selftestDevelopmentHistoricalEvidenceBatchPublication();
  } catch (error) {
    failures.push('development historical evidence batch publication failed: ' + error.message);
  }
  try {
    await selftestFixtureMaterialization();
  } catch (error) {
    failures.push('generated fixture exact-set materialization failed: ' + error.message);
  }
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
  const providerSchema = readJson(path.join(
    root,
    'soter/contracts/capability-provider.schema.json'
  ));
  const planProvider = readJson(path.join(
    root,
    'soter/providers/provider.integration.otter.mcp.json'
  ));
  const legacyProbeProvider = structuredClone(planProvider);
  legacyProbeProvider.runtime.probePrepareExport = 'prepareProbeMcp';
  const incompletePlanProvider = structuredClone(planProvider);
  delete incompletePlanProvider.runtime.probeFinalizeExport;
  if (!validateJsonSchema(legacyProbeProvider, providerSchema).length
    || !validateJsonSchema(incompletePlanProvider, providerSchema).length) {
    failures.push('MCP provider contract accepted legacy or incomplete provider probe runtime fields');
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
  const migrationEvidenceInput = {
    lock: first,
    createdAt: FIXTURE_TIME,
    subject: { type: 'configuration', id: 'configuration.meeting-intake', version: null },
    source: {
      role: 'migration-source',
      path: '.claude/skills/example.md',
      fingerprint: fingerprintJson({ source: 'configuration-migration-selftest' })
    },
    target: {
      role: 'migration-target',
      path: meetingIntakeConfigPath,
      fingerprint: first.configuration.fingerprint
    },
    supportingArtifacts: [{
      role: 'supporting-evidence',
      path: 'soter/fixtures/example.evidence.json',
      fingerprint: fingerprintJson({ support: 'configuration-migration-selftest' })
    }, {
      role: 'supporting-artifact',
      path: 'soter/fixtures/example.connected.evidence.json',
      fingerprint: fingerprintJson({ support: 'separate-private-configuration-selftest' })
    }],
    limitations: ['This synthetic record proves only configuration-subject validation.']
  };
  const configurationBridgeEvidence = createMigrationBridgeEvidence({
    ...migrationEvidenceInput,
    id: 'evidence.configuration-migration-bridge.selftest',
    checks: [{
      id: 'configuration-subject-supported',
      description: 'The exact configuration subject is accepted without pretending it is a versioned pack.',
      state: 'passed'
    }]
  });
  const configurationCompletionEvidence = createMigrationCompletionEvidence({
    ...migrationEvidenceInput,
    id: 'evidence.configuration-migration-completion.selftest',
    disposition: 'migrated',
    parity: 'intentional-change',
    checks: [
      {
        id: 'target-selected-in-exact-lock',
        description: 'The exact configuration target is selected by the lock.',
        state: 'passed'
      },
      {
        id: 'supporting-evidence-current',
        description: 'The supporting fixture evidence is current.',
        state: 'passed'
      },
      {
        id: 'legacy-dependencies-cleared',
        description: 'The legacy dependency is cleared for this synthetic responsibility.',
        state: 'passed'
      },
      {
        id: 'authority-transition-explicit',
        description: 'The configuration authority transition is explicit.',
        state: 'passed'
      }
    ]
  });
  const evidenceSchema = readJson(path.join(root, 'soter/contracts/evidence-v2.schema.json'));
  if (validateJsonSchema(configurationBridgeEvidence, evidenceSchema).length
    || validateJsonSchema(configurationCompletionEvidence, evidenceSchema).length
    || configurationCompletionEvidence.subject.version !== null) {
    failures.push('migration evidence could not represent an exact configuration subject');
  }
  let versionedConfigurationSubjectRejected = false;
  try {
    createMigrationBridgeEvidence({
      ...migrationEvidenceInput,
      id: 'evidence.configuration-migration-invalid.selftest',
      subject: { type: 'configuration', id: 'configuration.meeting-intake', version: '1.0.0' },
      checks: [{
        id: 'configuration-subject-invalid',
        description: 'A configuration subject cannot invent a package version.',
        state: 'passed'
      }]
    });
  } catch (error) {
    versionedConfigurationSubjectRejected = error.message.includes('configuration subject');
  }
  if (!versionedConfigurationSubjectRejected) {
    failures.push('migration evidence accepted a versioned configuration subject');
  }
  let invalidBridgeSupportingRoleRejected = false;
  try {
    createMigrationBridgeEvidence({
      ...migrationEvidenceInput,
      id: 'evidence.configuration-migration-invalid-support.selftest',
      supportingArtifacts: [{
        role: 'connected-evidence',
        path: 'soter/fixtures/example.connected.evidence.json',
        fingerprint: fingerprintJson({ support: 'invalid-role-selftest' })
      }],
      checks: [{
        id: 'configuration-support-invalid',
        description: 'A migration bridge accepts only closed supporting record roles.',
        state: 'passed'
      }]
    });
  } catch (error) {
    invalidBridgeSupportingRoleRejected = error.message.includes('supporting evidence or governed artifacts');
  }
  if (!invalidBridgeSupportingRoleRejected) {
    failures.push('migration bridge evidence accepted an undeclared supporting artifact role');
  }
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
        || source.authority !== (source.id === 'source.policy.tasks'
          ? 'authority.tasks.definition'
          : 'authority.meetings.definition')
        || source.readiness.mode !== 'probe-read'
        || source.consumers.length !== 1;
    })) {
    failures.push('resolved lock did not preserve exact portable source wiring and fingerprints');
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-core-'));
  try {
    fs.cpSync(path.join(root, 'soter'), path.join(temp, 'soter'), { recursive: true });
    copyExternalPackArtifacts(root, temp);
    fs.writeFileSync(
      path.join(temp, 'AGENTS.md'),
      '# Unmanaged developer output used only by the contained Core selftest\n'
    );
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
    const containedNotion = readJson(path.join(
      temp,
      'soter/providers/provider.integration.notion.fixture.json'
    ));
    const trackedConfiguration = readJson(path.join(temp, meetingIntakeConfigPath));
    const trackedLock = resolveConfiguration({
      root: temp,
      configPath: meetingIntakeConfigPath
    });
    const trackedLockPath = 'soter/fixtures/meeting-intake/meeting-intake.lock.json';
    writeJson(path.join(temp, trackedLockPath), trackedLock);
    const trackedSelection = selectExactConnectedConfiguration({
      root: temp,
      configurationBasis: 'tracked-contained',
      lockPath: trackedLockPath,
      expectedHost: 'codex',
      providerImplementations: [containedNotion.id]
    });
    const trackedResolutionEvidence = createResolutionEvidence({
      lock: trackedLock,
      id: 'evidence.meeting-intake.resolution.fixture',
      createdAt: FIXTURE_TIME
    });
    const trackedEnvelope = prepareRunEnvelope({
      root: temp,
      lock: trackedLock,
      lockPath: trackedLockPath,
      scenarioPath: 'soter/scenarios/meeting-intake/happy-path.scenario.json',
      runId: 'run.meeting-intake.fixture',
      createdAt: FIXTURE_TIME,
      evidenceIds: [
        trackedResolutionEvidence.id,
        'evidence.meeting-intake.preparation.fixture'
      ]
    });
    const trackedPreparationEvidence = createRunPreparationEvidence({
      lock: trackedLock,
      envelope: trackedEnvelope,
      id: 'evidence.meeting-intake.preparation.fixture',
      createdAt: FIXTURE_TIME
    });
    const trackedDoctor = runOfflineDoctor({
      root: temp,
      lock: trackedLock,
      doctorId: 'doctor.meeting-intake.fixture',
      evidenceId: 'evidence.meeting-intake.doctor.fixture',
      createdAt: FIXTURE_TIME
    });
    const trackedConnectedWithoutProbes = runConnectedDoctor({
      root: temp,
      lock: trackedLock,
      doctorId: 'doctor.meeting-intake.connected-fixture',
      evidenceId: 'evidence.meeting-intake.doctor.fixture',
      createdAt: FIXTURE_TIME,
      providerProbes: []
    });
    writeJson(
      path.join(temp, 'soter/fixtures/meeting-intake/preflight.run.json'),
      trackedEnvelope
    );
    writeJson(
      path.join(temp, 'soter/fixtures/meeting-intake/resolution.evidence.json'),
      trackedResolutionEvidence
    );
    writeJson(
      path.join(temp, 'soter/fixtures/meeting-intake/preparation.evidence.json'),
      trackedPreparationEvidence
    );
    writeJson(
      path.join(temp, 'soter/fixtures/meeting-intake/offline.doctor.json'),
      trackedDoctor.report
    );
    writeJson(
      path.join(temp, 'soter/fixtures/meeting-intake/connected.doctor.json'),
      trackedConnectedWithoutProbes.report
    );
    trackedDoctor.evidence.forEach((record) => {
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
    let trackedMcpRejected = false;
    try {
      selectExactConnectedConfiguration({
        root: temp,
        configurationBasis: 'tracked-contained',
        lockPath: trackedLockPath,
        expectedHost: 'codex',
        providerImplementations: [connectedNotion.id]
      });
    } catch (error) {
      trackedMcpRejected = error instanceof ConnectedConfigurationError
        && error.code === 'CONNECTED_CONFIGURATION_BASIS_PROHIBITED';
    }
    writePrivateConfigurationState(temp, trackedConfiguration.name, trackedConfiguration);
    let halfStateRejected = false;
    try {
      selectExactConnectedConfiguration({
        root: temp,
        configurationBasis: 'private-active',
        lockPath: repoRelativePath(
          temp,
          activeConfigurationLockStatePath(temp, trackedConfiguration.name)
        ),
        expectedHost: 'codex',
        providerImplementations: [connectedNotion.id]
      });
    } catch (error) {
      halfStateRejected = error instanceof ConnectedConfigurationError
        && error.code === 'CONNECTED_CONFIGURATION_HALF_STATE';
    }
    removePrivateConfigurationState(temp, trackedConfiguration.name);
    const privateTaskStatus = 'PRIVATE_PROVIDER_TASK_STATUS_CORE_SENTINEL';
    const privateTaskContext = 'PRIVATE_PROVIDER_TASK_CONTEXT_CORE_SENTINEL';
    const meetingOptionMappings = [
      notionOptionMapping(
        'mapping.integration.notion.crm-records',
        'organization',
        'organizationType',
        [{ portable: 'Client', provider: 'Client' }]
      ),
      notionOptionMapping(
        'mapping.integration.notion.crm-records',
        'organization',
        'tags',
        [{ portable: 'Important', provider: 'Important' }]
      ),
      notionOptionMapping(
        'mapping.integration.notion.projects-records',
        'project',
        'projectType',
        [{ portable: 'Client Project', provider: 'Client Project' }]
      ),
      notionOptionMapping(
        'mapping.integration.notion.projects-records',
        'project',
        'status',
        [{ portable: 'Active', provider: 'Active' }]
      ),
      notionOptionMapping(
        'mapping.integration.notion.tasks-records',
        'task',
        'status',
        [{ portable: 'Open', provider: 'Open' }]
      ),
      notionOptionMapping(
        'mapping.integration.notion.tasks-records',
        'task',
        'context',
        [{
          portable: 'Bound from the selected project only.',
          provider: 'Bound from the selected project only.'
        }, {
          portable: 'Derived only from the selected project relation.',
          provider: 'Derived only from the selected project relation.'
        }]
      ),
      notionOptionMapping(
        'mapping.integration.notion.meetings-records',
        'meeting',
        'meetingType',
        [
          { portable: 'Project Sync', provider: 'Project Sync' },
          { portable: 'General', provider: 'General' }
        ]
      ),
      notionOptionMapping(
        'mapping.integration.notion.meetings-records',
        'meeting-summary',
        'documentType',
        [{ portable: 'Meeting Summary', provider: 'Meeting Summary' }]
      )
    ];
    const containedMeetingConfiguration = materializeContainedPrivateConfiguration({
      root: temp,
      configurationName: trackedConfiguration.name,
      host: 'codex',
      notionOptionMappings: meetingOptionMappings
    });
    const lock = containedMeetingConfiguration.lock;
    const claudeLock = resolveConfiguration({
      root: temp,
      configPath: privateConfigurationStatePath(temp, trackedConfiguration.name),
      host: 'claude'
    });
    const projectPulseLock = materializeContainedPrivateConfiguration({
      root: temp,
      configurationName: 'project-pulse',
      host: 'codex',
      notionOptionMappings: [
        notionOptionMapping(
          'mapping.integration.notion.projects-records',
          'project',
          'projectType',
          [{ portable: 'Project', provider: 'Private Project Type' }]
        ),
        notionOptionMapping(
          'mapping.integration.notion.projects-records',
          'project',
          'status',
          [{ portable: 'active', provider: 'Private Active Project' }]
        ),
        notionOptionMapping(
          'mapping.integration.notion.tasks-records',
          'task',
          'status',
          [
            { portable: 'done', provider: 'Private Done Task' },
            { portable: 'open', provider: 'Private Open Task' }
          ]
        ),
        notionOptionMapping(
          'mapping.integration.notion.tasks-records',
          'task',
          'context',
          [{ portable: 'Project', provider: 'Private Project Task Context' }]
        ),
        notionOptionMapping(
          'mapping.integration.notion.projects-records',
          'project-feed-entry',
          'category',
          [{ portable: 'Status', provider: 'Private Status' }]
        ),
        notionOptionMapping(
          'mapping.integration.notion.projects-records',
          'project-feed-entry',
          'visibility',
          [{ portable: 'Internal', provider: 'Private Internal' }]
        )
      ]
    }).lock;
    const containedTaskConfiguration = materializeContainedPrivateConfiguration({
      root: temp,
      configurationName: 'task-capture',
      host: 'codex',
      notionOptionMappings: [
        notionOptionMapping(
          'mapping.integration.notion.tasks-records',
          'task',
          'status',
          [{ portable: 'To Do', provider: privateTaskStatus }]
        ),
        notionOptionMapping(
          'mapping.integration.notion.tasks-records',
          'task',
          'context',
          [{ portable: 'Project', provider: privateTaskContext }]
        ),
        notionOptionMapping(
          'mapping.integration.notion.projects-records',
          'project',
          'projectType',
          [{
            portable: 'Internal Project',
            provider: 'PRIVATE_PROVIDER_PROJECT_TYPE_CORE_SENTINEL'
          }]
        ),
        notionOptionMapping(
          'mapping.integration.notion.projects-records',
          'project',
          'status',
          [{
            portable: 'Active',
            provider: 'PRIVATE_PROVIDER_PROJECT_STATUS_CORE_SENTINEL'
          }]
        )
      ]
    });
    const taskCaptureLock = containedTaskConfiguration.lock;
    const slackConversationReviewLock = materializePrivateNotionTargetLock(
      temp,
      'slack-conversation-review'
    );
    writeActiveConfigurationLockState(
      temp,
      'slack-conversation-review',
      slackConversationReviewLock
    );
    const expectedTaskDataSourceId = taskCaptureLock.settings['integration.notion']
      .targets.tasks.slice('collection://'.length);
    const expectedUpdateDataSourceId = projectPulseLock.settings['integration.notion']
      .targets.updates.slice('collection://'.length);
    const lockPath = repoRelativePath(
      temp,
      activeConfigurationLockStatePath(temp, trackedConfiguration.name)
    );
    const privateSelection = selectExactConnectedConfiguration({
      root: temp,
      configurationBasis: 'private-active',
      lockPath,
      expectedHost: 'codex',
      providerImplementations: [connectedNotion.id]
    });
    let sourceSwitchRejected = false;
    try {
      selectExactConnectedConfiguration({
        root: temp,
        configurationBasis: 'tracked-contained',
        lockPath: trackedLockPath,
        expectedHost: 'codex',
        providerImplementations: [containedNotion.id]
      });
    } catch (error) {
      sourceSwitchRejected = error instanceof ConnectedConfigurationError
        && error.code === 'CONNECTED_CONFIGURATION_SOURCE_SWITCH';
    }
    if (trackedSelection.selection.configurationBasis !== 'tracked-contained'
      || privateSelection.selection.configurationBasis !== 'private-active'
      || !trackedMcpRejected
      || !halfStateRejected
      || !sourceSwitchRejected) {
      failures.push(
        'connected configuration guard did not enforce tracked fixture-only, private paired-state, and source-switch boundaries'
      );
    }

    const identityMarker = 'private-identity-selftest-marker';
    const preparedOtterProbe = await prepareDurableProviderProbeExecution({
      root: temp,
      lockPath,
      configurationBasis: 'private-active',
      providerImplementation: connectedProviders.otter.id,
      probeId: 'probe.integration.otter.identity-selftest',
      at: FIXTURE_TIME
    });
    const otterCall = preparedOtterProbe.currentCall;
    const currentOtterProbe = getDurableHostExecution({
      root: temp,
      checkpointId: preparedOtterProbe.checkpoint.id,
      expectedHost: 'codex'
    });
    const desiredConfigurationFile = privateConfigurationStatePath(
      temp,
      trackedConfiguration.name
    );
    const heldDesiredConfigurationFile = desiredConfigurationFile + '.selftest-held';
    fs.renameSync(desiredConfigurationFile, heldDesiredConfigurationFile);
    let deletedDesiredRejected = false;
    let deletedDesiredList = null;
    try {
      getDurableHostExecution({
        root: temp,
        checkpointId: preparedOtterProbe.checkpoint.id,
        expectedHost: 'codex'
      });
    } catch (error) {
      deletedDesiredRejected = error instanceof ConnectedConfigurationError
        && error.code === 'CONNECTED_CONFIGURATION_HALF_STATE';
    } finally {
      deletedDesiredList = listDurableHostExecutions({
        root: temp,
        expectedHost: 'codex'
      }).checkpoints.find((item) => item.id === preparedOtterProbe.checkpoint.id);
      fs.renameSync(heldDesiredConfigurationFile, desiredConfigurationFile);
    }
    const activeLockFile = activeConfigurationLockStatePath(
      temp,
      trackedConfiguration.name
    );
    const exactActiveLock = readJson(activeLockFile);
    const tamperedActiveLock = structuredClone(exactActiveLock);
    tamperedActiveLock.graphFingerprint = fingerprintJson({
      tampered: 'connected-configuration-lock-selftest'
    });
    writeActiveConfigurationLockState(
      temp,
      trackedConfiguration.name,
      tamperedActiveLock
    );
    let tamperedLockRejected = false;
    let tamperedLockList = null;
    try {
      getDurableHostExecution({
        root: temp,
        checkpointId: preparedOtterProbe.checkpoint.id,
        expectedHost: 'codex'
      });
    } catch (error) {
      tamperedLockRejected = error instanceof ConnectedConfigurationError
        && error.code === 'CONNECTED_CONFIGURATION_LOCK_STALE';
    } finally {
      tamperedLockList = listDurableHostExecutions({
        root: temp,
        expectedHost: 'codex'
      }).checkpoints.find((item) => item.id === preparedOtterProbe.checkpoint.id);
      writeActiveConfigurationLockState(
        temp,
        trackedConfiguration.name,
        exactActiveLock
      );
    }
    if (currentOtterProbe.currentCall?.id !== otterCall.id
      || !deletedDesiredRejected
      || deletedDesiredList?.availability !== 'unavailable'
      || deletedDesiredList?.reasonCode !== 'CONNECTED_CONFIGURATION_HALF_STATE'
      || deletedDesiredList?.callId !== null
      || deletedDesiredList?.provider !== null
      || !tamperedLockRejected
      || tamperedLockList?.availability !== 'unavailable'
      || tamperedLockList?.reasonCode !== 'CONNECTED_CONFIGURATION_LOCK_STALE'
      || tamperedLockList?.callId !== null
      || tamperedLockList?.provider !== null) {
      failures.push(
        'durable connected execution exposed a call or lost stable unavailable facts after configuration deletion or lock tamper'
      );
    }
    const completedOtterProbe = await completeDurableProviderProbeExecution({
      root: temp,
      checkpointId: preparedOtterProbe.checkpoint.id,
      callId: otterCall.id,
      response: {
        structuredContent: {
          result: identityMarker
        }
      },
      at: FIXTURE_TIME
    });
    const repeatedOtterProbe = await completeDurableProviderProbeExecution({
      root: temp,
      checkpointId: preparedOtterProbe.checkpoint.id,
      callId: otterCall.id,
      response: {
        structuredContent: {
          result: identityMarker
        }
      },
      at: FIXTURE_TIME
    });
    const durableOtterState = fs.readFileSync(
      path.join(temp, completedOtterProbe.checkpointPath),
      'utf8'
    );
    if (preparedOtterProbe.checkpoint.$contract
        !== 'soter://contracts/provider-probe-plan-checkpoint/v1'
      || preparedOtterProbe.checkpoint.state !== 'requested'
      || otterCall.transport.operation !== 'get_user_info'
      || otterCall.transport.tool !== 'mcp__otter__get_user_info'
      || Object.keys(otterCall.arguments).length !== 0
      || completedOtterProbe.checkpoint.state !== 'completed'
      || completedOtterProbe.checkpoint.result?.$contract
        !== 'soter://contracts/provider-probe/v2'
      || completedOtterProbe.checkpoint.result?.reachability.state !== 'passed'
      || completedOtterProbe.checkpoint.result?.capabilities[0]?.state !== 'unknown'
      || completedOtterProbe.currentCall !== null
      || repeatedOtterProbe.checkpoint.checkpointFingerprint
        !== completedOtterProbe.checkpoint.checkpointFingerprint
      || JSON.stringify(completedOtterProbe).includes(identityMarker)
      || durableOtterState.includes(identityMarker)) {
      failures.push('Otter identity probe did not preserve safe request scope and honest capability state');
    }
    let wrongOtterCallRejected = false;
    const wrongOtterProbe = await prepareDurableProviderProbeExecution({
      root: temp,
      lockPath,
      configurationBasis: 'private-active',
      providerImplementation: connectedProviders.otter.id,
      probeId: 'probe.integration.otter.wrong-call-selftest',
      at: FIXTURE_TIME
    });
    try {
      await completeDurableProviderProbeExecution({
        root: temp,
        checkpointId: wrongOtterProbe.checkpoint.id,
        callId: 'probecall.wrong.identity',
        response: { structuredContent: { result: 'synthetic identity' } },
        at: FIXTURE_TIME
      });
    } catch (error) {
      wrongOtterCallRejected = /exact current call/i.test(error.message);
    }
    if (!wrongOtterCallRejected) {
      failures.push('provider probe plan accepted a response without the exact current call');
    }

    const notionPlanMarker = 'private-notion-plan-selftest-marker';
    let notionPlan = await prepareDurableProviderProbeExecution({
      root: temp,
      lockPath,
      configurationBasis: 'private-active',
      providerImplementation: connectedProviders.notion.id,
      probeId: 'probe.integration.notion.plan-selftest',
      at: FIXTURE_TIME,
      validForSeconds: 300
    });
    const firstNotionPlanCall = notionPlan.currentCall;
    const firstNotionPlanResponse = notionProbeStepResponse(
      notionPlan.checkpoint,
      notionPlanMarker,
      null,
      meetingOptionMappings
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
        notionPlanMarker,
        null,
        meetingOptionMappings
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
    const notionMappingStep = (mapping, recordType, kind) => {
      return 'step.mapping.integration.notion.' + mapping + '-records.record.'
        + recordType + '.' + kind;
    };
    const taskSchemaStep = notionPlan.checkpoint.plan.steps.find((step) => {
      return step.id === notionMappingStep('tasks', 'task', 'schema');
    });
    const taskReadStep = notionPlan.checkpoint.plan.steps.find((step) => {
      return step.id === notionMappingStep('tasks', 'task', 'read');
    });
    const taskPolicyReadStep = notionPlan.checkpoint.plan.steps.find((step) => {
      return step.id === notionMappingStep('tasks', 'task-work-policy', 'read');
    });
    const organizationSchemaStep = notionPlan.checkpoint.plan.steps.find((step) => {
      return step.id === notionMappingStep('crm', 'organization', 'schema');
    });
    const organizationPolicyReadStep = notionPlan.checkpoint.plan.steps.find((step) => {
      return step.id === notionMappingStep('crm', 'organization-capture-policy', 'read');
    });
    const contactPolicyReadStep = notionPlan.checkpoint.plan.steps.find((step) => {
      return step.id === notionMappingStep('crm', 'contact-capture-policy', 'read');
    });
    const personSchemaStep = notionPlan.checkpoint.plan.steps.find((step) => {
      return step.id === notionMappingStep('crm', 'person', 'schema');
    });
    const notionPlanRecordTypes = new Set(notionPlan.checkpoint.plan.steps.flatMap((step) => {
      return step.scope?.recordType ? [step.scope.recordType] : [];
    }));
    const expectedNotionPlanSteps = notionPlan.checkpoint.plan.steps.length;
    if (notionPlanCalls !== expectedNotionPlanSteps
      || notionPlan.checkpoint.state !== 'completed'
      || notionPlan.checkpoint.result?.$contract !== 'soter://contracts/provider-probe/v2'
      || notionPlan.checkpoint.result?.checks.length !== expectedNotionPlanSteps
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
      || ['projects.records.read', 'tasks.records.read', 'meetings.records.read'].some((id) => {
        return notionPlan.checkpoint.result?.capabilities.find((item) => {
          return item.id === id;
        })?.state !== 'passed';
      })
      || notionPlan.checkpoint.result?.capabilities.filter((item) => {
        return item.id === 'meetings.records.create' || item.id === 'tasks.records.update';
      }).some((item) => item.state !== 'unknown')
      || taskSchemaStep?.scope.expectedFields.find((field) => {
        return field.portable === 'nextActionOn';
      })?.providerType !== 'date'
      || !taskReadStep?.arguments?.data?.query?.includes('date:Next Action:start')
      || taskPolicyReadStep !== undefined
      || organizationPolicyReadStep !== undefined
      || contactPolicyReadStep !== undefined
      || personSchemaStep !== undefined
      || JSON.stringify([...notionPlanRecordTypes].sort()) !== JSON.stringify([
        'meeting',
        'organization',
        'project',
        'task'
      ])
      || organizationSchemaStep?.scope.expectedFields.find((field) => {
        return field.portable === 'organizationType';
      })?.providerType !== 'select'
      || organizationSchemaStep?.scope.expectedFields.find((field) => {
        return field.portable === 'tags';
      })?.providerType !== 'multi_select'
      || organizationSchemaStep?.scope.expectedFields.find((field) => {
        return field.portable === 'website';
      })?.providerType !== 'url'
      || organizationSchemaStep?.scope.expectedFields.find((field) => {
        return field.portable === 'twitter';
      })?.providerType !== 'url'
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

    const taskScopedNotionPlan = await prepareDurableProviderProbeExecution({
      root: temp,
      lockPath: repoRelativePath(
        temp,
        activeConfigurationLockStatePath(temp, 'task-capture')
      ),
      configurationBasis: 'private-active',
      providerImplementation: connectedProviders.notion.id,
      probeId: 'probe.integration.notion.task-scope-selftest',
      at: FIXTURE_TIME,
      validForSeconds: 300
    });
    const taskScopedRecordTypes = new Set(
      taskScopedNotionPlan.checkpoint.plan.steps.flatMap((step) => {
        return step.scope?.recordType ? [step.scope.recordType] : [];
      })
    );
    const conversationScopedNotionPlan = await prepareDurableProviderProbeExecution({
      root: temp,
      lockPath: repoRelativePath(
        temp,
        activeConfigurationLockStatePath(temp, 'slack-conversation-review')
      ),
      configurationBasis: 'private-active',
      providerImplementation: connectedProviders.notion.id,
      probeId: 'probe.integration.notion.conversation-scope-selftest',
      at: FIXTURE_TIME,
      validForSeconds: 300
    });
    const conversationScopedRecordTypes = new Set(
      conversationScopedNotionPlan.checkpoint.plan.steps.flatMap((step) => {
        return step.scope?.recordType ? [step.scope.recordType] : [];
      })
    );
    if (JSON.stringify([...taskScopedRecordTypes].sort()) !== JSON.stringify([
      'project',
      'task',
      'task-work-policy'
    ])
      || JSON.stringify([...conversationScopedRecordTypes]) !== JSON.stringify([
        'conversation-review-policy'
      ])
      || JSON.stringify(taskScopedNotionPlan.checkpoint)
        .includes('operatorRecordRequirements')
      || JSON.stringify(conversationScopedNotionPlan.checkpoint)
        .includes('operatorRecordRequirements')) {
      failures.push(
        'Core did not privately narrow Notion probe planning to exact selected Automation record requirements'
      );
    }

    let driftedNotionPlan = await prepareDurableProviderProbeExecution({
      root: temp,
      lockPath,
      configurationBasis: 'private-active',
      providerImplementation: connectedProviders.notion.id,
      probeId: 'probe.integration.notion.schema-drift-selftest',
      at: FIXTURE_TIME,
      validForSeconds: 300
    });
    const driftStepId = notionMappingStep('crm', 'organization', 'schema');
    while (driftedNotionPlan.checkpoint.state === 'requested') {
      const currentCall = driftedNotionPlan.currentCall;
      const response = notionProbeStepResponse(
        driftedNotionPlan.checkpoint,
        notionPlanMarker,
        driftStepId,
        meetingOptionMappings
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
      configurationBasis: 'private-active',
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
          mismatchedDocumentStepId,
          meetingOptionMappings
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
    const privateEnvelopeRunPath = writeRunState(temp, envelope).path;
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
    const operationPlan = {
      $contract: 'soter://contracts/operation-plan/v2',
      contractVersion: '2.0.0',
      id: 'plan.meeting-intake.multi-target-selftest',
      runId: envelope.id,
      createdAt: FIXTURE_TIME,
      mode: 'sequential',
      failurePolicy: 'stop',
      reason: 'Prove that Core can resume two portable Notion reads without using cross-data-source SQL.',
      steps: [
        {
          id: 'step.read-meeting',
          capability: 'meetings.records.read',
          authority: 'authority.meetings.instance',
          providerImplementation: connectedProviders.notion.id,
          input: { recordTypes: ['meeting'], limit: 1 },
          inputBindings: [],
          reason: 'Read one meeting target through its portable capability.'
        },
        {
          id: 'step.read-task',
          capability: 'tasks.records.read',
          authority: 'authority.tasks.instance',
          providerImplementation: connectedProviders.notion.id,
          input: { recordTypes: ['task'], limit: 1 },
          inputBindings: [],
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
    const wrongAutomationRun = structuredClone(envelope);
    wrongAutomationRun.id = 'run.meeting-intake.wrong-automation-selftest';
    wrongAutomationRun.automation.id = 'automation.not-selected';
    const privateWrongAutomationRunPath = writeRunState(temp, wrongAutomationRun).path;
    const wrongAutomationPlan = structuredClone(operationPlan);
    wrongAutomationPlan.id = 'plan.meeting-intake.wrong-automation-selftest';
    wrongAutomationPlan.runId = wrongAutomationRun.id;
    let wrongAutomationRejected = false;
    try {
      await prepareDurableOperationPlanExecution({
        root: temp,
        lockPath,
        configurationBasis: 'private-active',
        runPath: privateWrongAutomationRunPath,
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
        configurationBasis: 'private-active',
        runPath: privateEnvelopeRunPath,
        plan: invalidTailPlan,
        at: FIXTURE_TIME,
        expectedHost: 'codex'
      });
    } catch (error) {
      invalidTailRejectedBeforeDispatch = error instanceof ConnectedConfigurationError
        && error.code === 'CONNECTED_CONFIGURATION_PROVIDER_SCOPE_INVALID';
    }
    const invalidTailCheckpoint = path.join(
      temp,
      '.soter/state/host-calls/checkpoint.plan.meeting-intake.invalid-tail-selftest.json'
    );
    let publicRunAdoptionRejected = false;
    try {
      await prepareDurableOperationPlanExecution({
        root: temp,
        lockPath,
        configurationBasis: 'private-active',
        runPath: 'soter/fixtures/meeting-intake/preflight.run.json',
        plan: operationPlan,
        at: FIXTURE_TIME,
        expectedHost: 'codex'
      });
    } catch (error) {
      publicRunAdoptionRejected = error.message.includes(
        'existing exact Core-owned private state file'
      );
    }
    const publicRunAdoptionCreatedCheckpoint = fs.existsSync(path.join(
      temp,
      '.soter/state/host-calls/checkpoint.plan.meeting-intake.multi-target-selftest.json'
    ));
    const preparedPlan = await prepareDurableOperationPlanExecution({
      root: temp,
      lockPath,
      configurationBasis: 'private-active',
      runPath: privateEnvelopeRunPath,
      plan: operationPlan,
      at: FIXTURE_TIME,
      expectedHost: 'codex'
    });
    const firstPlanCall = preparedPlan.currentCall;
    const durablePlanRunFile = path.join(temp, preparedPlan.runPath);
    const exactDurablePlanRun = readJson(durablePlanRunFile);
    const tamperedDurablePlanRun = structuredClone(exactDurablePlanRun);
    tamperedDurablePlanRun.lifecycleState = 'completed';
    writeJson(durablePlanRunFile, tamperedDurablePlanRun);
    let tamperedRunRejected = false;
    let tamperedRunList = null;
    try {
      getDurableHostExecution({
        root: temp,
        checkpointId: preparedPlan.checkpoint.id,
        expectedHost: 'codex'
      });
    } catch {
      tamperedRunRejected = true;
    } finally {
      tamperedRunList = listDurableHostExecutions({
        root: temp,
        expectedHost: 'codex'
      }).checkpoints.find((item) => item.id === preparedPlan.checkpoint.id);
      writeJson(durablePlanRunFile, exactDurablePlanRun);
    }
    if (!tamperedRunRejected
      || tamperedRunList?.availability !== 'unavailable'
      || tamperedRunList?.reasonCode !== 'CONNECTED_EXECUTION_STATE_STALE'
      || tamperedRunList?.callId !== null
      || tamperedRunList?.runId !== null) {
      failures.push(
        'durable run tamper did not fail closed or list as sanitized unavailable work'
      );
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(durablePlanRunFile, 0o644);
      let unsafeRunModeRejected = false;
      let unsafeRunModeList = null;
      try {
        getDurableHostExecution({
          root: temp,
          checkpointId: preparedPlan.checkpoint.id,
          expectedHost: 'codex'
        });
      } catch {
        unsafeRunModeRejected = true;
      } finally {
        unsafeRunModeList = listDurableHostExecutions({
          root: temp,
          expectedHost: 'codex'
        }).checkpoints.find((item) => item.id === preparedPlan.checkpoint.id);
        fs.chmodSync(durablePlanRunFile, 0o600);
      }
      if (!unsafeRunModeRejected
        || unsafeRunModeList?.availability !== 'unavailable'
        || unsafeRunModeList?.callId !== null
        || unsafeRunModeList?.runId !== null) {
        failures.push(
          'unsafe durable run permissions did not fail get and sanitize list authority'
        );
      }

      const durablePlanCheckpointFile = path.join(temp, preparedPlan.checkpointPath);
      fs.chmodSync(durablePlanCheckpointFile, 0o644);
      let unsafeCheckpointModeRejected = false;
      let unsafeCheckpointModeList = null;
      try {
        getDurableHostExecution({
          root: temp,
          checkpointId: preparedPlan.checkpoint.id,
          expectedHost: 'codex'
        });
      } catch {
        unsafeCheckpointModeRejected = true;
      } finally {
        unsafeCheckpointModeList = listDurableHostExecutions({
          root: temp,
          expectedHost: 'codex'
        }).checkpoints.find((item) => item.id === preparedPlan.checkpoint.id);
        fs.chmodSync(durablePlanCheckpointFile, 0o600);
      }
      if (!unsafeCheckpointModeRejected
        || unsafeCheckpointModeList?.availability !== 'unavailable'
        || unsafeCheckpointModeList?.callId !== null
        || unsafeCheckpointModeList?.runId !== null) {
        failures.push(
          'unsafe host checkpoint permissions did not fail get and sanitize list authority'
        );
      }
    }
    const malformedCheckpointFile = path.join(
      temp,
      '.soter/state/host-calls/checkpoint.malformed-selftest.json'
    );
    fs.writeFileSync(malformedCheckpointFile, '{"id":', { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(malformedCheckpointFile, 0o600);
    const malformedCheckpointList = listDurableHostExecutions({
      root: temp,
      expectedHost: 'codex'
    }).checkpoints;
    const malformedCheckpointRow = malformedCheckpointList.find((item) => {
      return item.id === 'checkpoint.malformed-selftest';
    });
    const currentCheckpointBesideMalformed = malformedCheckpointList.find((item) => {
      return item.id === preparedPlan.checkpoint.id;
    });
    fs.rmSync(malformedCheckpointFile);
    if (malformedCheckpointRow?.availability !== 'unavailable'
      || malformedCheckpointRow?.reasonCode !== 'CONNECTED_EXECUTION_STATE_INVALID'
      || malformedCheckpointRow?.callId !== null
      || malformedCheckpointRow?.runId !== null
      || currentCheckpointBesideMalformed?.availability !== 'current') {
      failures.push(
        'one malformed host checkpoint crashed or contaminated the sanitized execution list'
      );
    }
    const firstPlanResponse = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: [{
            __soterType: 'meeting',
            __soterId: 'https://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            __soterFields: JSON.stringify({
              title: 'Plan selftest meeting',
              meetingType: 'Project Sync',
              recordingUri: 'https://otter.ai/u/plan-selftest-meeting',
              organizationUris: '[]'
            })
          }],
          has_more: false,
          privateMarker: 'raw-plan-meeting-response-marker'
        })
      }],
      isError: false
    };
    const aliasCheckpointId = 'checkpoint.alias-selftest';
    const aliasCheckpointFile = path.join(
      temp,
      '.soter/state/host-calls/' + aliasCheckpointId + '.json'
    );
    fs.copyFileSync(path.join(temp, preparedPlan.checkpointPath), aliasCheckpointFile);
    if (process.platform !== 'win32') fs.chmodSync(aliasCheckpointFile, 0o600);
    let aliasCheckpointGetRejected = false;
    let aliasCheckpointContinuationRejected = false;
    try {
      getDurableHostExecution({
        root: temp,
        checkpointId: aliasCheckpointId,
        expectedHost: 'codex'
      });
    } catch (error) {
      aliasCheckpointGetRejected = error.message.includes(
        'identity does not match its exact private state path'
      );
    }
    try {
      await completeDurableOperationPlanExecution({
        root: temp,
        checkpointId: aliasCheckpointId,
        callId: firstPlanCall.id,
        response: firstPlanResponse,
        at: '2026-07-15T12:00:00.500Z',
        expectedHost: 'codex'
      });
    } catch (error) {
      aliasCheckpointContinuationRejected = error.message.includes(
        'identity does not match its exact private state path'
      );
    }
    const aliasCheckpointList = listDurableHostExecutions({
      root: temp,
      expectedHost: 'codex'
    }).checkpoints;
    const aliasCheckpointRow = aliasCheckpointList.find((item) => {
      return item.id === aliasCheckpointId;
    });
    const exactCheckpointRows = aliasCheckpointList.filter((item) => {
      return item.id === preparedPlan.checkpoint.id && item.availability === 'current';
    });
    fs.rmSync(aliasCheckpointFile);
    if (!aliasCheckpointGetRejected
      || !aliasCheckpointContinuationRejected
      || aliasCheckpointRow?.availability !== 'unavailable'
      || aliasCheckpointRow?.reasonCode !== 'CONNECTED_EXECUTION_STATE_INVALID'
      || aliasCheckpointRow?.callId !== null
      || aliasCheckpointRow?.runId !== null
      || exactCheckpointRows.length !== 1) {
      failures.push(
        'copied checkpoint alias bypassed exact identity or duplicated current execution state'
      );
    }
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
            __soterId: 'https://app.notion.com/p/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            __soterFields: JSON.stringify({
              title: 'Plan selftest task',
              status: 'Open',
              context: null,
              projectUris: '[]'
            })
          }],
          has_more: false,
          privateMarker: 'raw-plan-task-response-marker'
        }
      }
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
      || !publicRunAdoptionRejected
      || publicRunAdoptionCreatedCheckpoint
      || preparedPlan.checkpoint.state !== 'requested'
      || firstPlanCall?.capability.id !== 'meetings.records.read'
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
      || completedPlan.checkpoint.result?.stepResults.length !== 2
      || replayedFirstPlanStep.checkpoint.checkpointFingerprint
        !== completedPlan.checkpoint.checkpointFingerprint
      || JSON.stringify(completedPlan).includes('raw-plan-')) {
      failures.push('durable operation plan did not preserve exact sequential dispatch, recovery, idempotency, and response minimization');
    }
    const failedBindingRun = structuredClone(envelope);
    failedBindingRun.id = 'run.meeting-intake.failed-binding-selftest';
    const privateFailedBindingRunPath = writeRunState(temp, failedBindingRun).path;
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
          capability: 'meetings.records.read',
          authority: 'authority.meetings.instance',
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
        configurationBasis: 'private-active',
        runPath: privateFailedBindingRunPath,
        plan: invalidBoundTailPlan,
        at: FIXTURE_TIME,
        expectedHost: 'codex'
      });
    } catch (error) {
      invalidBoundTailRejected = error instanceof ConnectedConfigurationError
        && error.code === 'CONNECTED_CONFIGURATION_PROVIDER_SCOPE_INVALID';
    }
    const preparedFailedBinding = await prepareDurableOperationPlanExecution({
      root: temp,
      lockPath,
      configurationBasis: 'private-active',
      runPath: privateFailedBindingRunPath,
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
    const exactStringRun = structuredClone(envelope);
    exactStringRun.id = 'run.meeting-intake.exact-string-binding-selftest';
    const privateExactStringRunPath = writeRunState(temp, exactStringRun).path;
    const exactStringDocumentUri = 'https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const exactStringDocumentTitle = 'Exact bound meeting';
    const exactStringPlan = {
      $contract: 'soter://contracts/operation-plan/v2',
      contractVersion: '2.0.0',
      id: 'plan.meeting-intake.exact-string-binding-selftest',
      runId: exactStringRun.id,
      createdAt: FIXTURE_TIME,
      mode: 'sequential',
      failurePolicy: 'stop',
      reason: 'Prove one exact observed record identity and title bind a later document read without repeated operator input.',
      steps: [
        {
          id: 'step.exact-string-source',
          capability: 'meetings.records.read',
          authority: 'authority.meetings.instance',
          providerImplementation: connectedProviders.notion.id,
          input: {
            recordTypes: ['meeting'],
            filters: { title: exactStringDocumentTitle },
            limit: 2
          },
          inputBindings: [],
          reason: 'Resolve the exact meeting record and its provider resource identity.'
        },
        {
          id: 'step.exact-string-document',
          capability: 'documents.content.read',
          authority: 'authority.meetings.instance',
          providerImplementation: connectedProviders.notion.id,
          input: {},
          inputBindings: [
            {
              id: 'binding.exact-string-uri',
              sourceStepId: 'step.exact-string-source',
              sourcePath: ['records', '*', 'id'],
              targetPath: ['uri'],
              transform: 'exact-string',
              onEmpty: 'fail-plan'
            },
            {
              id: 'binding.exact-string-title',
              sourceStepId: 'step.exact-string-source',
              sourcePath: ['records', '*', 'fields', 'title'],
              targetPath: ['expectedTitle'],
              transform: 'exact-string',
              onEmpty: 'fail-plan'
            }
          ],
          reason: 'Read only the exact document identity and title observed in the prior Meeting result.'
        }
      ]
    };
    const preparedExactStringPlan = await prepareDurableOperationPlanExecution({
      root: temp,
      lockPath,
      configurationBasis: 'private-active',
      runPath: privateExactStringRunPath,
      plan: exactStringPlan,
      at: FIXTURE_TIME,
      expectedHost: 'codex'
    });
    const exactStringSourceResponse = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: [{
            __soterType: 'meeting',
            __soterId: exactStringDocumentUri,
            __soterFields: JSON.stringify({
              title: exactStringDocumentTitle,
              meetingType: 'Project Sync',
              occurredOn: '2026-07-15',
              recordingUri: 'https://otter.ai/u/exact-string-selftest',
              organizationUris: null,
              participantUris: null
            })
          }],
          has_more: false
        })
      }]
    };
    const advancedExactStringPlan = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedExactStringPlan.checkpoint.id,
      callId: preparedExactStringPlan.currentCall.id,
      response: exactStringSourceResponse,
      at: '2026-07-15T12:00:03.600Z',
      expectedHost: 'codex'
    });
    const completedExactStringPlan = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: advancedExactStringPlan.checkpoint.id,
      callId: advancedExactStringPlan.currentCall.id,
      response: notionPageResponse({
        uri: exactStringDocumentUri,
        title: exactStringDocumentTitle,
        body: '# Exact bound meeting\n\nOne exact bound document.'
      }),
      at: '2026-07-15T12:00:03.700Z',
      expectedHost: 'codex'
    });
    const exactStringRuntime = advancedExactStringPlan.checkpoint.steps[1];
    if (advancedExactStringPlan.currentCall?.capability?.id !== 'documents.content.read'
      || advancedExactStringPlan.currentCall?.arguments?.id !== 'b'.repeat(32)
      || exactStringRuntime.resolvedInput?.uri !== exactStringDocumentUri
      || exactStringRuntime.resolvedInput?.expectedTitle !== exactStringDocumentTitle
      || exactStringRuntime.bindingResolutions.length !== 2
      || exactStringRuntime.bindingResolutions.some((binding) => {
        return binding.transform !== 'exact-string'
          || binding.state !== 'bound'
          || binding.valueCount !== 1;
      })
      || completedExactStringPlan.checkpoint.state !== 'completed') {
      failures.push('exact-string operation-plan bindings did not preserve one exact observed identity and title');
    }
    const ambiguousExactStringRunPath = 'soter/fixtures/meeting-intake/ambiguous-exact-string-selftest.run.json';
    const ambiguousExactStringRun = structuredClone(exactStringRun);
    ambiguousExactStringRun.id = 'run.meeting-intake.ambiguous-exact-string-selftest';
    writeJson(path.join(temp, ambiguousExactStringRunPath), ambiguousExactStringRun);
    const privateAmbiguousExactStringRunPath = writeRunState(
      temp,
      ambiguousExactStringRun
    ).path;
    const ambiguousExactStringPlan = structuredClone(exactStringPlan);
    ambiguousExactStringPlan.id = 'plan.meeting-intake.ambiguous-exact-string-selftest';
    ambiguousExactStringPlan.runId = ambiguousExactStringRun.id;
    const preparedAmbiguousExactString = await prepareDurableOperationPlanExecution({
      root: temp,
      lockPath,
      configurationBasis: 'private-active',
      runPath: privateAmbiguousExactStringRunPath,
      plan: ambiguousExactStringPlan,
      at: FIXTURE_TIME,
      expectedHost: 'codex'
    });
    const ambiguousExactStringResponse = structuredClone(exactStringSourceResponse);
    const ambiguousPayload = JSON.parse(ambiguousExactStringResponse.content[0].text);
    ambiguousPayload.results.push({
      ...structuredClone(ambiguousPayload.results[0]),
      __soterId: 'https://www.notion.so/cccccccccccccccccccccccccccccccc'
    });
    ambiguousExactStringResponse.content[0].text = JSON.stringify(ambiguousPayload);
    const failedAmbiguousExactString = await completeDurableOperationPlanExecution({
      root: temp,
      checkpointId: preparedAmbiguousExactString.checkpoint.id,
      callId: preparedAmbiguousExactString.currentCall.id,
      response: ambiguousExactStringResponse,
      at: '2026-07-15T12:00:03.800Z',
      expectedHost: 'codex'
    });
    if (failedAmbiguousExactString.checkpoint.state !== 'failed'
      || failedAmbiguousExactString.currentCall !== null
      || failedAmbiguousExactString.checkpoint.steps[1]?.call !== null
      || failedAmbiguousExactString.checkpoint.steps[1]?.error?.kind !== 'validation'
      || failedAmbiguousExactString.checkpoint.steps[1]?.error?.code
        !== 'OPERATION_PLAN_BINDING_INVALID') {
      failures.push('ambiguous exact-string operation-plan binding emitted provider work');
    }
    const connectedContextRecording = 'https://otter.ai/u/meeting_fixture_001';
    const {
      lock: connectedContextLock,
      templateLock: connectedContextTemplateLock,
      privateContainedBasis: connectedContextBasis
    } = containedMeetingConfiguration;
    const serializedConnectedContextBasis = JSON.stringify(connectedContextBasis);
    const serializedTaskBasis = JSON.stringify(
      containedTaskConfiguration.privateContainedBasis
    );
    if (connectedContextBasis.privateLockFingerprint !== fingerprintJson(connectedContextLock)
      || connectedContextBasis.privateConfigurationFingerprint
        !== connectedContextLock.configuration.fingerprint
      || connectedContextBasis.privateGraphFingerprint !== connectedContextLock.graphFingerprint
      || connectedContextBasis.trackedTemplateLockFingerprint
        !== fingerprintJson(connectedContextTemplateLock)
      || connectedContextBasis.trackedTemplateGraphFingerprint
        !== connectedContextTemplateLock.graphFingerprint
      || connectedContextBasis.privateLockFingerprint
        === connectedContextBasis.trackedTemplateLockFingerprint
      || connectedContextBasis.substitutions.notionDocumentSourceCount < 1
      || connectedContextBasis.substitutions.notionOptionMappingScopeCount !== 8
      || connectedContextBasis.substitutions.notionOptionMappingEntryCount !== 10
      || connectedContextBasis.privacy.providerOptionValuesIncluded !== false
      || containedTaskConfiguration.privateContainedBasis.substitutions
        .notionOptionMappingScopeCount !== 4
      || containedTaskConfiguration.privateContainedBasis.substitutions
        .notionOptionMappingEntryCount !== 4
      || serializedTaskBasis.includes(privateTaskStatus)
      || serializedTaskBasis.includes(privateTaskContext)
      || serializedTaskBasis.includes('PRIVATE_PROVIDER_PROJECT_TYPE_CORE_SENTINEL')
      || serializedTaskBasis.includes('PRIVATE_PROVIDER_PROJECT_STATUS_CORE_SENTINEL')
      || serializedConnectedContextBasis.includes('collection://')
      || serializedConnectedContextBasis.includes('https://www.notion.so/')
      || serializedConnectedContextBasis.includes('.soter/state')) {
      failures.push(
        'contained private configuration did not produce one sanitized exact template derivation'
      );
    }
    const wrongTemplateLock = structuredClone(connectedContextTemplateLock);
    wrongTemplateLock.graphFingerprint = 'sha256:' + '0'.repeat(64);
    let wrongTemplateRejected = false;
    try {
      materializeContainedPrivateConfiguration({
        root: temp,
        configurationName: 'meeting-intake',
        host: 'codex',
        expectedTemplateLock: wrongTemplateLock
      });
    } catch (error) {
      wrongTemplateRejected = /expected tracked template lock/.test(error.message);
    }
    if (!wrongTemplateRejected) {
      failures.push('contained private configuration accepted a substituted template lock');
    }
    let duplicateOptionMappingRejected = false;
    try {
      materializeContainedPrivateConfiguration({
        root: temp,
        configurationName: 'task-capture',
        host: 'codex',
        notionOptionMappings: [
          notionOptionMapping(
            'mapping.integration.notion.tasks-records',
            'task',
            'status',
            [
              { portable: 'To Do', provider: 'Duplicate Provider Value' },
              { portable: 'Done', provider: 'Duplicate Provider Value' }
            ]
          )
        ]
      });
    } catch (error) {
      duplicateOptionMappingRejected = /exact private bijection/.test(error.message);
    }
    if (!duplicateOptionMappingRejected) {
      failures.push('contained private configuration accepted a non-bijective option mapping');
    }
    const currentDesiredConfiguration = readJson(desiredConfigurationFile);
    const replacementDesiredConfiguration = structuredClone(currentDesiredConfiguration);
    replacementDesiredConfiguration.host.reason +=
      ' Replaced only to prove durable binding invalidation.';
    writePrivateConfigurationState(
      temp,
      trackedConfiguration.name,
      replacementDesiredConfiguration
    );
    const replacementActiveLock = resolveConfiguration({
      root: temp,
      configPath: desiredConfigurationFile,
      host: 'codex'
    });
    writeActiveConfigurationLockState(
      temp,
      trackedConfiguration.name,
      replacementActiveLock
    );
    let replacedSelectionRejected = false;
    try {
      getDurableHostExecution({
        root: temp,
        checkpointId: preparedOtterProbe.checkpoint.id,
        expectedHost: 'codex'
      });
    } catch (error) {
      replacedSelectionRejected = error instanceof ConnectedConfigurationError
        && error.code === 'CONNECTED_CONFIGURATION_BINDING_STALE';
    }
    const replacedSelectionList = listDurableHostExecutions({
      root: temp,
      expectedHost: 'codex'
    }).checkpoints.find((item) => item.id === preparedOtterProbe.checkpoint.id);
    writePrivateConfigurationState(
      temp,
      trackedConfiguration.name,
      currentDesiredConfiguration
    );
    writeActiveConfigurationLockState(
      temp,
      trackedConfiguration.name,
      exactActiveLock
    );
    if (!replacedSelectionRejected
      || replacedSelectionList?.availability !== 'unavailable'
      || replacedSelectionList?.reasonCode !== 'CONNECTED_CONFIGURATION_BINDING_STALE'
      || replacedSelectionList?.callId !== null
      || replacedSelectionList?.provider !== null) {
      failures.push(
        'durable execution did not become sanitized unavailable work after exact configuration source replacement'
      );
    }
    const preparedConnectedWork = await prepareAutomationRun({
      root: temp,
      automationId: 'automation.meeting-intake',
      configurationName: 'meeting-intake',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        meeting: 'meeting.fixture-001',
        recordingUri: connectedContextRecording,
        operatorGoal: 'Exercise the primary connected-context Core integration path.'
      },
      createdAt: '2026-07-15T12:00:03.900Z'
    });
    const preparedConnectedContext = await prepareMeetingIntakeConnectedContext({
      root: temp,
      workId: preparedConnectedWork.id,
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
      .input.ids = ['https://app.notion.com/p/cccccccccccccccccccccccccccccccc'];
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
    const contextPolicyBindings = applicablePolicySources(connectedContextLock);
    const completedContextPolicies = await completeContextPolicyBodies({
      root: temp,
      execution: preparedConnectedContext,
      bindings: contextPolicyBindings,
      atSecond: '2026-07-15T12:00:05',
      markerPrefix: 'raw-connected-context-policy-body-marker-'
    });
    const connectedContextTranscript = completedContextPolicies.execution;
    const contextPolicyBodyMarkers = completedContextPolicies.markers;
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
    const contextOrganizationUri
      = 'https://www.notion.so/Organization-11111111111111111111111111111111';
    const contextProjectUri
      = 'https://www.notion.so/Project-22222222222222222222222222222222';
    const contextTaskUri
      = 'https://www.notion.so/Task-33333333333333333333333333333333';
    const contextMeetingResponse = {
      structuredContent: {
        result: {
          results: [{
            __soterType: 'meeting',
            __soterId: 'https://app.notion.com/p/dddddddddddddddddddddddddddddddd',
            __soterFields: JSON.stringify({
              title: 'Connected context selftest',
              meetingType: 'Project Sync',
              recordingUri: connectedContextRecording,
              organizationUris: JSON.stringify([contextOrganizationUri])
            })
          }],
          has_more: false,
          privateMarker: contextMeetingMarker
        }
      }
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
            has_more: false,
            privateMarker: contextOrganizationMarker
          }
        }
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
            has_more: false,
            privateMarker: contextProjectMarker
          }
        }
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
            has_more: false,
            privateMarker: contextTaskMarker
          }
        }
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
      || preparedConnectedContext.currentCall?.capability.id !== 'documents.content.read'
      || preparedConnectedContext.currentCall?.arguments?.id?.length !== 32
      || connectedContextTranscript.currentCall?.capability.id !== 'meeting.transcript.read'
      || connectedContextTranscript.currentCall?.arguments?.id !== 'meeting_fixture_001'
      || connectedContextTranscript.checkpoint.steps
        .filter((step) => step.id.startsWith('step.context-policy.'))
        .some((step) => step.state !== 'completed'
          || step.call?.capability.id !== 'documents.content.read')
      || connectedContextMeeting.currentCall?.capability.id !== 'meetings.records.read'
      || connectedContextMeeting.currentCall?.arguments?.data?.params?.[0]
        !== connectedContextRecording
      || connectedContextOrganization.checkpoint.currentStepId
        !== 'step.context-organizations'
      || connectedContextOrganization.currentCall?.arguments?.data?.params?.[0]
        !== contextOrganizationUri.slice(-32)
      || organizationRuntimeStep?.bindingResolutions[0]?.sourceOutputFingerprint
        !== meetingRuntimeStep?.outputFingerprint
      || connectedContextProject.checkpoint.currentStepId !== 'step.context-projects'
      || connectedContextProject.currentCall?.arguments?.data?.params?.[0]
        !== contextProjectUri.slice(-32)
      || connectedContextTask.checkpoint.currentStepId !== 'step.context-tasks'
      || connectedContextTask.currentCall?.arguments?.data?.params?.[0]
        !== contextTaskUri.slice(-32)
      || completedConnectedContext.checkpoint.state !== 'completed'
      || completedConnectedContext.checkpoint.result?.stepResults?.length !== 8
      || finalizedConnectedContext.snapshot.containment !== 'connected'
      || finalizedConnectedContext.snapshot.entries.length !== 8
      || connectedPolicyEntries.length !== 3
      || connectedPolicyEntries.some((entry) => {
        return entry.role !== 'definition'
          || entry.capability !== 'documents.content.read'
          || !entry.applicability.sourceId.startsWith('source.policy.')
          || entry.applicability.subjects.length !== 1
          || !entry.value.document.bodyFingerprint.startsWith('sha256:');
      })
      || finalizedConnectedContext.run.lifecycleState !== 'paused'
      || connectedAuthorities.get('authority.crm.instance') !== 'loaded'
      || connectedAuthorities.get('authority.meetings.definition') !== 'loaded'
      || connectedAuthorities.get('authority.meetings.instance') !== 'loaded'
      || connectedAuthorities.get('authority.tasks.definition') !== 'loaded'
      || connectedAuthorities.get('authority.tasks.instance') !== 'loaded'
      || connectedAuthorities.get('authority.otter.provider') !== 'loaded'
      || connectedAuthorities.get('authority.notion.provider') !== 'declared'
      || replayedConnectedContext.snapshotPath !== finalizedConnectedContext.snapshotPath
      || fingerprintJson(replayedConnectedContext.snapshot)
        !== fingerprintJson(finalizedConnectedContext.snapshot)
      || (process.platform !== 'win32'
        && (fs.statSync(connectedSnapshotFile).mode & 0o777) !== 0o600)
      || [
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
    const preparedMismatchWork = await prepareAutomationRun({
      root: temp,
      automationId: 'automation.meeting-intake',
      configurationName: 'meeting-intake',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        meeting: 'meeting.fixture-001',
        recordingUri: connectedContextRecording,
        operatorGoal: 'Exercise the mismatched connected meeting failure path.'
      },
      createdAt: '2026-07-15T12:00:07.900Z'
    });
    const preparedMismatchContext = await prepareMeetingIntakeConnectedContext({
      root: temp,
      workId: preparedMismatchWork.id,
      at: '2026-07-15T12:00:08.000Z',
      expectedHost: 'codex'
    });
    const mismatchTranscriptCall = (await completeContextPolicyBodies({
      root: temp,
      execution: preparedMismatchContext,
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
              __soterId: 'https://app.notion.com/p/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
              __soterFields: JSON.stringify({
                title: 'Mismatched connected context',
                meetingType: 'Project Sync',
                recordingUri: 'https://otter.ai/u/a-different-meeting',
                organizationUris: '[]'
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
    const preparedEmptyWork = await prepareAutomationRun({
      root: temp,
      automationId: 'automation.meeting-intake',
      configurationName: 'meeting-intake',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        meeting: 'meeting.fixture-001',
        recordingUri: connectedContextRecording,
        operatorGoal: 'Exercise the empty related-record connected-context path.'
      },
      createdAt: '2026-07-15T12:00:11.900Z'
    });
    const preparedEmptyContext = await prepareMeetingIntakeConnectedContext({
      root: temp,
      workId: preparedEmptyWork.id,
      at: '2026-07-15T12:00:12.000Z',
      expectedHost: 'codex'
    });
    const emptyContextTranscript = (await completeContextPolicyBodies({
      root: temp,
      execution: preparedEmptyContext,
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
              __soterId: 'https://app.notion.com/p/ffffffffffffffffffffffffffffffff',
              __soterFields: JSON.stringify({
                title: 'Meeting without related CRM records',
                meetingType: 'General',
                recordingUri: connectedContextRecording,
                organizationUris: '[]'
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
      || finalizedEmptyContext.snapshot.entries.length !== 5
      || finalizedEmptyContext.snapshot.effectIds.length !== 5) {
      failures.push('empty output bindings emitted a broad provider read or produced false related context');
    }
    const missingOrganizationUri
      = 'https://www.notion.so/Missing-organization-44444444444444444444444444444444';
    const preparedMissingRelationWork = await prepareAutomationRun({
      root: temp,
      automationId: 'automation.meeting-intake',
      configurationName: 'meeting-intake',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        meeting: 'meeting.fixture-001',
        recordingUri: connectedContextRecording,
        operatorGoal: 'Exercise the missing exact relation connected-context path.'
      },
      createdAt: '2026-07-15T12:00:15.900Z'
    });
    const preparedMissingRelation = await prepareMeetingIntakeConnectedContext({
      root: temp,
      workId: preparedMissingRelationWork.id,
      at: '2026-07-15T12:00:16.000Z',
      expectedHost: 'codex'
    });
    const missingRelationTranscript = (await completeContextPolicyBodies({
      root: temp,
      execution: preparedMissingRelation,
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
              __soterId: 'https://app.notion.com/p/11111111111111111111111111111111',
              __soterFields: JSON.stringify({
                title: 'Meeting with a missing organization relation',
                meetingType: 'Project Sync',
                recordingUri: connectedContextRecording,
                organizationUris: JSON.stringify([missingOrganizationUri])
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
        !== missingOrganizationUri.slice(-32)
      || completedMissingRelation.checkpoint.state !== 'completed'
      || missingTailSteps
        .some((step) => step.state !== 'skipped' || step.call !== null)
      || fs.existsSync(path.join(
        temp,
        '.soter/state/context-snapshots/context.meeting-intake.connected.missing-relation-selftest.json'
      ))) {
      failures.push('missing bound records were accepted as complete related context');
    }
    let blockedWritePlanRejected = false;
    try {
      await prepareDurableOperationPlanExecution({
        root: temp,
        lockPath,
        configurationBasis: 'private-active',
        runPath: privateEnvelopeRunPath,
        plan: {
        $contract: 'soter://contracts/operation-plan/v2',
        contractVersion: '2.0.0',
        id: 'plan.meeting-intake.blocked-write-selftest',
        runId: envelope.id,
        createdAt: '2026-07-15T12:00:04.000Z',
        mode: 'sequential',
        failurePolicy: 'stop',
        reason: 'Prove that a sequential plan cannot invent the removed Meeting-summary write binding.',
        steps: [{
          id: 'step.create-summary',
          capability: 'meetings.records.create',
          authority: 'authority.meetings.instance',
          providerImplementation: connectedProviders.notionWrites.id,
          input: {
            recordType: 'meeting-summary',
            deduplicationKey: 'selftest:operation-plan-blocked',
            fields: { title: 'Blocked plan summary' }
          },
          inputBindings: [],
          reason: 'Attempt one unavailable Meeting-summary write without a selected capability binding.'
        }]
      },
      at: '2026-07-15T12:00:04.000Z',
      expectedHost: 'codex'
      });
    } catch (error) {
      blockedWritePlanRejected = error.message.includes('cannot be prepared')
        && error.message.includes('No resolved binding for meetings.records.create.');
    }
    if (!blockedWritePlanRejected) {
      failures.push('operation plan invented a removed Meeting write binding or emitted a provider request');
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
      ids: ['https://www.notion.so/Meeting-selftest-55555555555555555555555555555555'],
      limit: 1
    };
    const preparedHostRead = await prepareHostToolCall({
      root: temp,
      lock,
      runId: 'run.meeting-intake.fixture',
      callId: 'toolcall.selftest.notion-read',
      capability: 'meetings.records.read',
      authority: 'authority.meetings.instance',
      providerImplementation: connectedProviders.notion.id,
      input: hostReadInput,
      at: FIXTURE_TIME
    });
    const preparedClaudeHostRead = await prepareHostToolCall({
      root: temp,
      lock: claudeLock,
      runId: 'run.meeting-intake.fixture',
      callId: 'toolcall.selftest.claude-notion-read',
      capability: 'meetings.records.read',
      authority: 'authority.meetings.instance',
      providerImplementation: connectedProviders.notion.id,
      input: hostReadInput,
      at: FIXTURE_TIME
    });
    const rejectedMultiTargetRead = await prepareHostToolCall({
      root: temp,
      lock,
      runId: 'run.meeting-intake.fixture',
      callId: 'toolcall.selftest.notion-multi-target-read',
      capability: 'meetings.records.read',
      authority: 'authority.meetings.instance',
      providerImplementation: connectedProviders.notion.id,
      input: { recordTypes: ['meeting', 'task'], limit: 1 },
      at: FIXTURE_TIME
    });
    const hostReadPayload = {
      results: [
        {
          __soterType: 'meeting',
          __soterId: 'https://www.notion.so/Provider-slug-55555555-5555-5555-5555-555555555555',
          __soterFields: JSON.stringify({
            title: 'Selftest meeting',
            meetingType: 'Project Sync',
            recordingUri: 'https://otter.ai/u/host-read-selftest',
            organizationUris: JSON.stringify([
              'https://app.notion.com/p/22222222222222222222222222222222'
            ]),
            privateProviderField: 'response-only-marker'
          })
        }
      ],
      has_more: false,
      data_source_ids: [
        lock.settings['integration.notion'].targets.meetings
          .slice('collection://'.length)
      ]
    };
    const hostReadResponse = {
      content: [{ type: 'text', text: JSON.stringify(hostReadPayload) }],
      isError: false
    };
    const completedHostRead = await completeHostToolCall({
      root: temp,
      lock,
      call: preparedHostRead.call,
      input: hostReadInput,
      response: hostReadResponse,
      at: FIXTURE_TIME
    });
    if (preparedClaudeHostRead.call.state !== 'requested') {
      throw new Error(
        'Claude Notion read preparation did not produce one exact requested host call.'
      );
    }
    const completedClaudeHostRead = await completeHostToolCall({
      root: temp,
      lock: claudeLock,
      call: preparedClaudeHostRead.call,
      input: hostReadInput,
      response: hostReadPayload,
      at: FIXTURE_TIME
    });
    if (preparedHostRead.call.state !== 'requested'
      || preparedHostRead.call.transport.server !== 'notion'
      || preparedHostRead.call.transport.operation !== 'query_data_sources'
      || preparedHostRead.call.transport.tool
        !== 'mcp__codex_apps__notion_query_data_sources'
      || completedHostRead.call.state !== 'completed'
      || completedHostRead.output?.records[0]?.id
        !== 'https://www.notion.so/55555555555555555555555555555555'
      || completedHostRead.output?.records[0]?.identityBinding?.state !== 'exact-request'
      || completedHostRead.output?.records[0]?.identityBinding?.requestedIdFingerprint
        !== fingerprintJson(hostReadInput.ids[0])
      || !completedHostRead.output?.records[0]?.version?.startsWith('sha256:')
      || completedHostRead.output?.records[0]?.fields?.organizationUris?.[0]
        !== 'https://www.notion.so/22222222222222222222222222222222'
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
    const definitionBinding = applicablePolicySources(lock)[0];
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
      authority: definitionBinding.authority,
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
      authority: definitionBinding.authority,
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
      authority: definitionBinding.authority,
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
    const documentUpdateUri = 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const documentUpdateTitle = 'Document update selftest';
    const documentBefore = '# Document update selftest\n\nKeep this prefix.\n\n'
      + 'Milestone: progress=pending health=unknown\n\nKeep this suffix.';
    const documentAfter = '# Document update selftest\n\nKeep this prefix.\n\n'
      + 'Milestone: progress=in-progress health=on-track\n\nKeep this suffix.';
    const documentUpdateInput = {
      uri: documentUpdateUri,
      expectedTitle: documentUpdateTitle,
      expectedBodyFingerprint: fingerprintJson(documentBefore),
      updates: [{
        id: 'milestone-state',
        oldText: 'Milestone: progress=pending health=unknown',
        newText: 'Milestone: progress=in-progress health=on-track',
        replaceAllMatches: false
      }]
    };
    const preparedDocumentUpdate = await prepareHostToolCall({
      root: temp,
      lock: projectPulseLock,
      runId: 'run.project-pulse.document-update-selftest',
      callId: 'toolcall.selftest.notion-document-update',
      capability: 'documents.content.update',
      authority: 'authority.projects.instance',
      providerImplementation: connectedProviders.notion.id,
      input: documentUpdateInput,
      at: FIXTURE_TIME,
      approvedEffects: ['write']
    });
    const completedDocumentUpdate = await completeHostToolCall({
      root: temp,
      lock: projectPulseLock,
      call: preparedDocumentUpdate.call,
      input: documentUpdateInput,
      response: {
        structuredContent: {
          result: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
        }
      },
      at: FIXTURE_TIME
    });
    const documentRuntimeState = createFixtureRuntimeState(temp);
    const fixtureDocumentUpdate = await invokeCapability({
      root: temp,
      lock: projectPulseLock,
      capability: 'documents.content.update',
      authority: 'authority.projects.instance',
      containment: 'fixture',
      input: documentUpdateInput,
      effectId: 'effect.project-pulse.document-update.fixture',
      at: FIXTURE_TIME,
      approvedEffects: ['write'],
      runtimeState: documentRuntimeState
    });
    const fixtureDocumentReadAfter = await invokeCapability({
      root: temp,
      lock: projectPulseLock,
      capability: 'documents.content.read',
      authority: 'authority.projects.instance',
      containment: 'fixture',
      input: { uri: documentUpdateUri, expectedTitle: documentUpdateTitle },
      effectId: 'effect.project-pulse.document-read-after.fixture',
      at: FIXTURE_TIME,
      runtimeState: documentRuntimeState
    });
    const fixtureDocumentReplay = await invokeCapability({
      root: temp,
      lock: projectPulseLock,
      capability: 'documents.content.update',
      authority: 'authority.projects.instance',
      containment: 'fixture',
      input: documentUpdateInput,
      effectId: 'effect.project-pulse.document-update-replay.fixture',
      at: FIXTURE_TIME,
      approvedEffects: ['write'],
      runtimeState: documentRuntimeState
    });
    if (preparedDocumentUpdate.call.transport.operation !== 'update_page'
      || preparedDocumentUpdate.call.transport.tool
        !== 'mcp__codex_apps__notion_notion_update_page'
      || preparedDocumentUpdate.call.arguments.command !== 'update_content'
      || preparedDocumentUpdate.call.arguments.content_updates?.length !== 1
      || preparedDocumentUpdate.call.arguments.content_updates[0].replace_all_matches !== false
      || completedDocumentUpdate.call.state !== 'completed'
      || completedDocumentUpdate.output?.accepted !== true
      || completedDocumentUpdate.output?.changeFingerprint !== fingerprintJson(documentUpdateInput)
      || fixtureDocumentUpdate.invocation.state !== 'passed'
      || fixtureDocumentReadAfter.invocation.state !== 'passed'
      || fixtureDocumentReadAfter.output?.document.body !== documentAfter
      || fixtureDocumentReadAfter.output?.document.bodyFingerprint !== fingerprintJson(documentAfter)
      || fixtureDocumentReplay.invocation.state !== 'failed'
      || fixtureDocumentReplay.invocation.error?.kind !== 'conflict') {
      failures.push('targeted document update did not preserve exact reviewed replacement, host translation, fixture mutation, read-back, and no-retry conflict semantics');
    }
    const blockedHostWrite = await prepareHostToolCall({
      root: temp,
      lock: taskCaptureLock,
      runId: 'run.task-capture.fixture',
      callId: 'toolcall.selftest.notion-write-blocked',
      capability: 'tasks.records.create',
      authority: 'authority.tasks.instance',
      providerImplementation: connectedProviders.notionWrites.id,
      input: {
        recordType: 'task',
        deduplicationKey: 'selftest:mcp-blocked',
        deduplicationFilter: {
          field: 'title',
          value: 'Blocked host write'
        },
        fields: {
          title: 'Blocked host write',
          status: 'To Do',
          context: 'Project',
          projectUris: ['https://www.notion.so/cccccccccccccccccccccccccccccccc']
        }
      },
      at: FIXTURE_TIME
    });
    if (blockedHostWrite.call.state !== 'blocked'
      || blockedHostWrite.call.transport.tool !== null
      || blockedHostWrite.call.arguments !== null) {
      failures.push('confirmation-required write emitted an MCP tool request before approval');
    }
    const mappedHostRunId = 'run.meeting-intake.fixture';
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
      lock: taskCaptureLock,
      runId: mappedHostRunId,
      callId: 'toolcall.selftest.notion-mapped-task-create',
      capability: 'tasks.records.create',
      authority: 'authority.tasks.instance',
      providerImplementation: connectedProviders.notion.id,
      input: mappedTaskCreateInput,
      at: FIXTURE_TIME,
      approvedEffects: ['write']
    });
    const completedMappedTaskCreate = await completeHostToolCall({
      root: temp,
      lock: taskCaptureLock,
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
    const mappedStatusCreateInput = {
      recordType: 'project-feed-entry',
      deduplicationKey: 'project.pulse-healthy:2026-07-20:Healthy launch is on track',
      deduplicationFilter: {
        field: 'headline',
        value: 'Healthy launch is on track'
      },
      fields: {
        headline: 'Healthy launch is on track',
        category: 'Status',
        date: '2026-07-20',
        summary: 'Done: launch brief approved.\nIn progress: publish the launch brief.',
        processed: false,
        visibility: 'Internal',
        projectIds: ['https://www.notion.so/cccccccccccccccccccccccccccccccc']
      }
    };
    const preparedMappedStatusCreate = await prepareHostToolCall({
      root: temp,
      lock: projectPulseLock,
      runId: mappedHostRunId,
      callId: 'toolcall.selftest.notion-mapped-status-create',
      capability: 'projects.records.create',
      authority: 'authority.projects.instance',
      providerImplementation: connectedProviders.notion.id,
      input: mappedStatusCreateInput,
      at: FIXTURE_TIME,
      approvedEffects: ['write']
    });
    const completedMappedStatusCreate = await completeHostToolCall({
      root: temp,
      lock: projectPulseLock,
      call: preparedMappedStatusCreate.call,
      input: mappedStatusCreateInput,
      response: {
        structuredContent: {
          result: { pages: [{ id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }] }
        }
      },
      at: FIXTURE_TIME
    });
    const mappedStatusProperties = preparedMappedStatusCreate.call.arguments?.pages?.[0]?.properties;
    const invalidMappedTaskDate = structuredClone(mappedTaskCreateInput);
    invalidMappedTaskDate.fields.nextActionOn = '2026-02-30';
    const rejectedMappedTaskDate = await prepareHostToolCall({
      root: temp,
      lock: taskCaptureLock,
      runId: mappedHostRunId,
      callId: 'toolcall.selftest.notion-invalid-task-date',
      capability: 'tasks.records.create',
      authority: 'authority.tasks.instance',
      providerImplementation: connectedProviders.notion.id,
      input: invalidMappedTaskDate,
      at: FIXTURE_TIME,
      approvedEffects: ['write']
    });
    if (preparedMappedTaskCreate.call.transport.operation !== 'create_pages'
      || preparedMappedTaskCreate.call.arguments.parent.data_source_id
        !== expectedTaskDataSourceId
      || mappedTaskProperties?.Name !== 'Prepare mapped task create'
      || mappedTaskProperties?.Status !== privateTaskStatus
      || mappedTaskProperties?.Context !== privateTaskContext
      || JSON.stringify(mappedTaskProperties?.Project)
        !== JSON.stringify(['https://www.notion.so/cccccccccccccccccccccccccccccccc'])
      || JSON.stringify(mappedTaskProperties?.['Assigned To'])
        !== JSON.stringify(['provider-person-selftest'])
      || mappedTaskProperties?.['date:Next Action:start'] !== '2026-07-24'
      || mappedTaskProperties?.['date:Next Action:is_datetime'] !== 0
      || completedMappedTaskCreate.call.state !== 'completed'
      || completedMappedTaskCreate.output?.record?.fields?.status !== 'To Do'
      || completedMappedTaskCreate.output?.record?.fields?.context !== 'Project'
      || completedMappedTaskCreate.output?.record?.fields?.nextActionOn !== '2026-07-24'
      || preparedMappedStatusCreate.call.transport.operation !== 'create_pages'
      || preparedMappedStatusCreate.call.arguments.parent.data_source_id
        !== expectedUpdateDataSourceId
      || mappedStatusProperties?.Update !== 'Healthy launch is on track'
      || mappedStatusProperties?.Category !== 'Private Status'
      || mappedStatusProperties?.['date:Date:start'] !== '2026-07-20'
      || mappedStatusProperties?.['date:Date:is_datetime'] !== 0
      || mappedStatusProperties?.Summary
        !== 'Done: launch brief approved.\nIn progress: publish the launch brief.'
      || mappedStatusProperties?.Processed !== '__NO__'
      || mappedStatusProperties?.Visibility !== 'Private Internal'
      || JSON.stringify(mappedStatusProperties?.['📁 [DB] Projects'])
        !== JSON.stringify(['https://www.notion.so/cccccccccccccccccccccccccccccccc'])
      || completedMappedStatusCreate.call.state !== 'completed'
      || completedMappedStatusCreate.output?.record?.type !== 'project-feed-entry'
      || rejectedMappedTaskDate.call.state !== 'failed'
      || rejectedMappedTaskDate.call.transport.tool !== null
      ) {
      failures.push('mapped supported Notion creates did not translate and normalize through exact native host routes');
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
      capability: 'meetings.records.read',
      authority: 'authority.meetings.instance',
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
    const calendarParticipantMarker = 'private-calendar-participant-marker@example.test';
    const actionItemMarker = 'private-provider-action-item-marker';
    const nestedRawProviderMarker = 'HOSTILE_NESTED_RAW_PROVIDER_RESPONSE';
    const completedOtterRead = await completeHostToolCall({
      root: temp,
      lock,
      call: preparedOtterRead.call,
      input: otterReadInput,
      response: {
        structuredContent: {
          result: {
            speakers: [
              {
                id: 'speaker.selftest',
                displayName: 'Selftest speaker',
                rawProviderResponse: nestedRawProviderMarker
              }
            ],
            segments: [
              {
                speakerId: 'speaker.selftest',
                text: 'Selftest transcript segment.',
                startSeconds: 0,
                rawProviderResponse: nestedRawProviderMarker
              }
            ],
            calendar_participants: [
              { name: 'Untrusted pairing', email: calendarParticipantMarker }
            ],
            action_items: [
              { text: actionItemMarker, assignee: 'Untrusted attribution' }
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
      || JSON.stringify(completedOtterRead).includes(transcriptMarker)
      || JSON.stringify(completedOtterRead).includes(calendarParticipantMarker)
      || JSON.stringify(completedOtterRead).includes(actionItemMarker)
      || JSON.stringify(completedOtterRead).includes(nestedRawProviderMarker)
      || JSON.stringify(Object.keys(completedOtterRead.output?.provenance || {}).sort())
        !== JSON.stringify([
          'authority', 'provider', 'sourceKind', 'sourceReferenceFingerprint'
        ])) {
      failures.push('Otter MCP bridge did not enforce exact fetch translation and minimized normalization');
    }
    const transcriptContract = readJson(path.join(
      temp,
      'soter/capabilities/meeting.transcript.read.json'
    ));
    const hostilePortableTranscript = {
      ...structuredClone(completedOtterRead.output),
      calendar_participants: [{ email: calendarParticipantMarker }],
      action_items: [{ text: actionItemMarker }]
    };
    if (validateJsonSchema(hostilePortableTranscript, transcriptContract.outputSchema).length === 0) {
      failures.push('portable transcript schema accepted untrusted provider annotations');
    }
    const hostileNestedProviderTranscript = structuredClone(completedOtterRead.output);
    hostileNestedProviderTranscript.provenance.rawProviderResponse = nestedRawProviderMarker;
    hostileNestedProviderTranscript.speakers[0].rawProviderResponse = nestedRawProviderMarker;
    if (validateJsonSchema(
      hostileNestedProviderTranscript,
      transcriptContract.outputSchema
    ).length < 2) {
      failures.push('portable transcript schema accepted nested raw provider escape properties');
    }
    const hostileOtterFixtureState = createFixtureRuntimeState(temp);
    const hostileFixtureTranscript = hostileOtterFixtureState[
      'provider.integration.otter.fixture'
    ].data.transcripts[0];
    hostileFixtureTranscript.rawProviderResponse = nestedRawProviderMarker;
    hostileFixtureTranscript.speakers[0].rawProviderResponse = nestedRawProviderMarker;
    hostileFixtureTranscript.segments[0].rawProviderResponse = nestedRawProviderMarker;
    const minimizedFixtureTranscript = await invokeCapability({
      root: temp,
      lock,
      capability: 'meeting.transcript.read',
      authority: 'authority.otter.provider',
      containment: 'fixture',
      input: {
        meetingId: hostileFixtureTranscript.meetingId,
        recordingUri: hostileFixtureTranscript.recordingUri
      },
      effectId: 'effect.meeting-intake.hostile-transcript.fixture',
      at: FIXTURE_TIME,
      runtimeState: hostileOtterFixtureState
    });
    if (minimizedFixtureTranscript.invocation.state !== 'passed'
      || JSON.stringify(minimizedFixtureTranscript.output).includes(nestedRawProviderMarker)
      || JSON.stringify(Object.keys(minimizedFixtureTranscript.output?.provenance || {}).sort())
        !== JSON.stringify([
          'authority', 'provider', 'sourceKind', 'sourceReferenceFingerprint'
        ])) {
      failures.push('Otter fixture bridge did not minimize nested provider data and provenance');
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
      recordType: 'task',
      deduplicationKey: 'Selftest replay task',
      deduplicationFilter: {
        field: 'title',
        value: 'Selftest replay task'
      },
      fields: {
        title: 'Selftest replay task',
        status: 'To Do',
        context: 'Project',
        projectUris: ['https://www.notion.so/cccccccccccccccccccccccccccccccc']
      }
    };
    const firstCreate = await invokeCapability({
      root: temp,
      lock: taskCaptureLock,
      capability: 'tasks.records.create',
      authority: 'authority.tasks.instance',
      containment: 'fixture',
      input: createInput,
      effectId: 'effect.selftest.create-first',
      at: FIXTURE_TIME,
      approvedEffects: ['write'],
      runtimeState: replayState
    });
    const replayCreate = await invokeCapability({
      root: temp,
      lock: taskCaptureLock,
      capability: 'tasks.records.create',
      authority: 'authority.tasks.instance',
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
    invalidContextCreateInput.deduplicationKey = 'Invalid task context field';
    invalidContextCreateInput.deduplicationFilter.value = invalidContextCreateInput.deduplicationKey;
    invalidContextCreateInput.fields.title = invalidContextCreateInput.deduplicationKey;
    invalidContextCreateInput.fields.transcriptGrounded = true;
    const invalidContextCreate = await invokeCapability({
      root: temp,
      lock: taskCaptureLock,
      capability: 'tasks.records.create',
      authority: 'authority.tasks.instance',
      containment: 'fixture',
      input: invalidContextCreateInput,
      effectId: 'effect.selftest.create-invalid-context-field',
      at: FIXTURE_TIME,
      approvedEffects: ['write'],
      runtimeState: replayState
    });
    if (invalidContextCreate.invocation.state !== 'failed'
      || invalidContextCreate.invocation.error?.kind !== 'validation'
      || invalidContextCreate.invocation.error?.code !== 'HOST_CALL_VALIDATION_FAILED'
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
    'CORE SELFTEST PASS: deterministic source-bound and host-selectable locks, fingerprinted explainable configuration views, portable Codex and Claude request/result projection, typed fixture reads/writes, grounded Automation decisions with explicit ambiguity and abstention, exact-scope approval with selected-activity private review, compiler-exact request batches, deduplication, compare-before-write preconditions, read-after-write verification, resumable fixed and bound sequential operation plans, approval-bound connected update transactions and terminal creates with exact record/content verification, no automatic write retry or invented compensation, and read-only ambiguity reconciliation, bounded connected context finalization with exact applicable policy bodies, resumable MCP host dispatch, exact-lock single and multi-step provider probes including minimized document reads, schema and identity drift rejection, exact subject-scoped maturity applicability, connected readiness, expiry, honest states, and stale-lock detection.\n'
  );
  return true;
}
