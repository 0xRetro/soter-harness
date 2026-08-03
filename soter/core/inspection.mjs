import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema, verifySoter } from '../kernel/verify.mjs';
import { runOfflineDoctor } from './doctor.mjs';
import { fingerprintJson, readJson, repoRelativePath, resolveRepoPath } from './lib/canonical-json.mjs';
import { fingerprintLock, lockMatchesResolution } from './resolve.mjs';
import { evaluateConfigurationMaturity, loadMaturityEvidence } from './maturity.mjs';
import { getDurableHostExecution } from './service.mjs';
import { inspectConnectedOperatorActivity } from './operator-inspection.mjs';
import { assertPreparedWork, projectPreparedWorkApplicability } from './prepared-work.mjs';
import { inspectDevelopmentRun } from './development-runs.mjs';
import {
  hasPrivateConfigurationState,
  privateConfigurationStatePath
} from './private-configurations.mjs';
import {
  hasActiveConfigurationLockState,
  readActiveConfigurationLockState
} from './runtime-state.mjs';

const CONTRACT = 'soter://contracts/workspace-inspection/v1';
const VERSION = '1.0.0';
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EFFECT_ORDER = ['read', 'disclosure', 'write', 'dispatch', 'destructive'];

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en');
}

function sortById(items) {
  return items.sort((left, right) => compareText(left.id, right.id));
}

function walkJson(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkJson(file);
    return entry.isFile() && entry.name.endsWith('.json') ? [file] : [];
  }).sort(compareText);
}

function labelFor(id) {
  return String(id)
    .split(/[.-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function scopedDiagnostic({ code, severity = 'error', source, subject, message, remediation }) {
  return { code, severity, source, subject, message, remediation };
}

function schemaMap(root, diagnostics) {
  const schemas = new Map();
  for (const file of walkJson(path.join(root, 'soter', 'contracts'))) {
    try {
      const schema = readJson(file);
      if (typeof schema.$id === 'string') schemas.set(schema.$id, schema);
    } catch (error) {
      diagnostics.push(scopedDiagnostic({
        code: 'SOTER_INSPECTION_SCHEMA_INVALID',
        source: 'canonical-artifact',
        subject: repoRelativePath(root, file),
        message: error.message,
        remediation: 'Repair the schema; the remainder of the workspace can still be inspected.'
      }));
    }
  }
  return schemas;
}

function loadArtifact(root, file, schemas, diagnostics) {
  let value;
  try {
    value = readJson(file);
  } catch (error) {
    diagnostics.push(scopedDiagnostic({
      code: 'SOTER_INSPECTION_JSON_INVALID',
      source: 'canonical-artifact',
      subject: repoRelativePath(root, file),
      message: error.message,
      remediation: 'Repair this JSON document; other valid workspace artifacts remain available.'
    }));
    return null;
  }
  const schema = schemas.get(value?.$contract);
  if (!schema) {
    diagnostics.push(scopedDiagnostic({
      code: 'SOTER_INSPECTION_CONTRACT_UNKNOWN',
      source: 'canonical-artifact',
      subject: repoRelativePath(root, file),
      message: 'No canonical schema is available for ' + String(value?.$contract || 'this document') + '.',
      remediation: 'Declare the document contract and add its canonical schema.'
    }));
    return null;
  }
  const failures = validateJsonSchema(value, schema);
  if (failures.length) {
    diagnostics.push(scopedDiagnostic({
      code: 'SOTER_INSPECTION_ARTIFACT_INVALID',
      source: 'canonical-artifact',
      subject: repoRelativePath(root, file),
      message: failures.slice(0, 4).map((item) => item.path + ' ' + item.message).join('; '),
      remediation: 'Repair this artifact so it satisfies ' + value.$contract + '.'
    }));
    return null;
  }
  return { file, value };
}

function loadDirectory(root, relativeDirectory, schemas, diagnostics) {
  return walkJson(path.join(root, relativeDirectory))
    .map((file) => loadArtifact(root, file, schemas, diagnostics))
    .filter(Boolean);
}

function verifierDiagnostic(root, violation) {
  const absolute = path.isAbsolute(violation.file) ? violation.file : path.join(root, violation.file);
  return scopedDiagnostic({
    code: violation.code,
    severity: violation.level === 'warn' ? 'warning' : 'error',
    source: 'kernel-verifier',
    subject: repoRelativePath(root, absolute),
    message: violation.what + ' ' + violation.why,
    remediation: violation.fix
  });
}

function doctorDiagnostic(item) {
  return scopedDiagnostic({
    code: item.code,
    severity: item.severity === 'warning' ? 'warning' : item.severity === 'info' ? 'info' : 'error',
    source: 'offline-doctor',
    subject: item.subject,
    message: item.observed || item.claim,
    remediation: item.remediation
  });
}

export function aggregateProofStates(observations) {
  return Object.fromEntries(Object.entries(observations).map(([dimension, values]) => [dimension,
    values.includes('failed') ? 'failed'
      : values.includes('stale') ? 'stale'
        : values.some((value) => value === 'unknown' || value === 'skipped') ? 'unknown'
          : values.length > 0 && values.every((value) => value === 'not-applicable') ? 'not-applicable'
            : 'passed'
  ]));
}

function selectedInspectionLock(root, configurationName, fixtureLocks) {
  const privatePath = privateConfigurationStatePath(root, configurationName);
  const desired = fs.existsSync(privatePath);
  const activeLock = hasActiveConfigurationLockState(root, configurationName);
  if (desired || activeLock) {
    if (!desired || !activeLock) {
      return {
        sourceKind: 'private-active',
        configurationBasis: 'private-active',
        lock: null,
        lockState: 'invalid'
      };
    }
    let lock = null;
    try {
      hasPrivateConfigurationState(root, configurationName);
      lock = readActiveConfigurationLockState(root, configurationName).lock;
      const expectedPath = repoRelativePath(
        root,
        privateConfigurationStatePath(root, configurationName)
      );
      if (lock.configuration?.name !== configurationName
        || lock.configuration?.path !== expectedPath) {
        return {
          sourceKind: 'private-active',
          configurationBasis: 'private-active',
          lock: null,
          lockState: 'invalid'
        };
      }
      const current = lockMatchesResolution({
        root,
        lock,
        configPath: expectedPath,
        host: lock.host.id
      });
      return {
        sourceKind: 'private-active',
        configurationBasis: 'private-active',
        lock,
        lockState: current.matches ? 'current' : 'stale'
      };
    } catch {
      return {
        sourceKind: 'private-active',
        configurationBasis: 'private-active',
        lock: null,
        lockState: 'invalid'
      };
    }
  }
  const matches = fixtureLocks.filter((candidate) => {
    return candidate.configuration.name === configurationName;
  });
  if (matches.length === 0) {
    return {
      sourceKind: 'tracked-template',
      configurationBasis: 'tracked-contained',
      lock: null,
      lockState: 'missing'
    };
  }
  const uniqueLocks = new Map(matches.map((candidate) => [
    fingerprintLock(candidate),
    candidate
  ]));
  if (uniqueLocks.size !== 1) {
    return {
      sourceKind: 'tracked-template',
      configurationBasis: 'tracked-contained',
      lock: null,
      lockState: 'invalid'
    };
  }
  const lock = [...uniqueLocks.values()][0];
  try {
    const current = lockMatchesResolution({ root, lock, configPath: lock.configuration.path });
    return {
      sourceKind: 'tracked-template',
      configurationBasis: 'tracked-contained',
      lock,
      lockState: current.matches ? 'current' : 'stale'
    };
  } catch {
    return {
      sourceKind: 'tracked-template',
      configurationBasis: 'tracked-contained',
      lock,
      lockState: 'invalid'
    };
  }
}

function operationalFixtureLocks(fixtureDocs) {
  return fixtureDocs
    .filter((entry) => entry.value.$contract === 'soter://contracts/lock/v1');
}

function proofSnapshot(root, verification, configurations, fixtureDocs, diagnostics) {
  const locks = operationalFixtureLocks(fixtureDocs);
  const offlineDoctors = fixtureDocs
    .filter((entry) => entry.value.$contract === 'soter://contracts/doctor-result/v1' && entry.value.level === 'offline')
    .sort((left, right) => compareText(left.value.createdAt, right.value.createdAt));
  const createdAt = offlineDoctors.at(-1)?.value.createdAt || '1970-01-01T00:00:00.000Z';
  const dimensions = ['valid', 'ready', 'verified', 'healthy'];
  const observations = Object.fromEntries(dimensions.map((dimension) => [dimension, [verification.health[dimension]]]));
  const checks = [{
    id: 'kernel.graph-valid',
    claim: 'Machine contracts and every desired configuration graph are internally valid.',
    state: verification.health.valid,
    details: verification.health.valid === 'passed'
      ? 'Kernel verification reported no graph errors.'
      : 'Kernel diagnostics identify contract or graph failures.',
    evidenceIds: []
  }];
  const proofDiagnostics = verification.violations.map((item) => verifierDiagnostic(root, item));
  const evidenceIds = [];
  let doctorCount = 0;
  let observedAt = null;

  for (const configuration of configurations) {
    const selection = selectedInspectionLock(
      root,
      configuration.name,
      locks.map((entry) => entry.value)
    );
    const lock = selection.lock;
    if (!lock || configuration.lockState !== 'current') {
      const unavailableStates = configuration.lockState === 'stale'
        ? { valid: 'stale', ready: 'stale', verified: 'unknown', healthy: 'unknown' }
        : configuration.lockState === 'invalid'
          ? { valid: 'failed', ready: 'failed', verified: 'unknown', healthy: 'unknown' }
          : { valid: 'unknown', ready: 'unknown', verified: 'unknown', healthy: 'unknown' };
      for (const dimension of dimensions) observations[dimension].push(unavailableStates[dimension]);
      checks.push({
        id: 'configuration.' + configuration.name + '.lock-current',
        claim: 'The desired configuration has one current exact lock before offline proof can apply.',
        state: unavailableStates.valid,
        details: 'Lock state is ' + configuration.lockState + '; no offline doctor result is treated as applicable.',
        evidenceIds: []
      });
      continue;
    }
    try {
      const { report } = runOfflineDoctor({
        root,
        configPath: lock.configuration.path,
        lock,
        doctorId: 'doctor.workspace-inspection.' + configuration.name + '.offline',
        evidenceId: 'evidence.workspace-inspection.' + configuration.name + '.resolution',
        createdAt
      });
      doctorCount += 1;
      observedAt = !observedAt || compareText(observedAt, report.createdAt) < 0 ? report.createdAt : observedAt;
      for (const dimension of dimensions) observations[dimension].push(report.states[dimension]);
      checks.push(...report.checks.map((check) => ({
        id: configuration.name + ':' + check.id,
        claim: check.claim,
        state: check.state,
        details: configuration.name + ': ' + check.details,
        evidenceIds: [...check.evidenceIds]
      })));
      proofDiagnostics.push(...report.diagnostics.map(doctorDiagnostic));
      evidenceIds.push(...report.evidenceIds);
    } catch (error) {
      for (const dimension of dimensions) observations[dimension].push('unknown');
      const failure = scopedDiagnostic({
        code: 'SOTER_INSPECTION_DOCTOR_FAILED',
        source: 'offline-doctor',
        subject: configuration.name,
        message: error.message,
        remediation: 'Repair this configuration or lock; other configuration proof remains visible.'
      });
      diagnostics.push(failure);
      proofDiagnostics.push(failure);
    }
  }
  const states = aggregateProofStates(observations);
  return {
    source: doctorCount ? 'offline-doctor' : 'kernel-verifier',
    observedAt,
    states,
    checks,
    diagnostics: proofDiagnostics,
    evidenceIds: [...new Set(evidenceIds)].sort(compareText)
  };
}

function configurationSnapshots(root, verification, fixtureDocs, maturityEvidence) {
  const locks = operationalFixtureLocks(fixtureDocs)
    .map((entry) => entry.value);
  return verification.resolvedConfigurations.map((configuration) => {
    const selection = selectedInspectionLock(root, configuration.name, locks);
    const { lock, lockState, sourceKind, configurationBasis } = selection;
    const templateFallbackAllowed = sourceKind === 'tracked-template';
    const projectedSelections = lock?.packs || (templateFallbackAllowed ? configuration.selections : []);
    const projectedBindings = lock?.bindings || (templateFallbackAllowed ? configuration.bindings : []);
    const projectedAuthorities = lock?.authorities || (templateFallbackAllowed ? configuration.authorities : []);
    const projectedEffectPolicies = lock?.effectPolicies
      || (templateFallbackAllowed ? configuration.effectPolicies : null);
    const projectedHost = lock?.host.id || (templateFallbackAllowed ? configuration.host.id : 'unavailable');
    const maturityConfiguration = lock ? {
      ...configuration,
      host: {
        ...configuration.host,
        id: lock.host.id,
        adapter: lock.host.adapter,
        version: lock.host.version
      },
      selections: lock.packs
    } : configuration;
    const maturity = evaluateConfigurationMaturity({
      lock,
      resolvedConfiguration: maturityConfiguration,
      evidenceRecords: maturityEvidence,
      lockState,
      at: new Date().toISOString()
    });
    return {
      name: configuration.name,
      status: configuration.status,
      lockState,
      configurationBasis,
      host: projectedHost,
      maturity: {
        verified: maturity.verified,
        reasonCode: maturity.reasonCode,
        host: maturity.host,
        selections: maturity.selections
      },
      selections: projectedSelections.map((selection) => ({
        id: selection.id,
        version: selection.version,
        layer: selection.layer,
        source: selection.source,
        reason: selection.reason
      })).sort((left, right) => compareText(left.id, right.id)),
      bindings: projectedBindings.map((binding) => ({
        capability: binding.capability,
        providerPack: binding.providerPack,
        authorities: [...binding.authorities].sort(compareText),
        effects: [...binding.effects].sort(compareText),
        reason: binding.reason
      })).sort((left, right) => compareText(left.capability, right.capability)),
      authorities: projectedAuthorities.map((authority) => ({
        id: authority.id,
        role: authority.role,
        subject: authority.subject,
        reason: authority.reason
      })).sort((left, right) => compareText(left.id, right.id)),
      effectPolicies: projectedEffectPolicies ? EFFECT_ORDER.map((effect) => ({
        effect,
        mode: projectedEffectPolicies[effect].mode,
        reason: projectedEffectPolicies[effect].reason
      })) : [],
      graphFingerprint: lock?.graphFingerprint || null,
      lockFingerprint: lock ? fingerprintLock(lock) : null
    };
  }).sort((left, right) => compareText(left.name, right.name));
}

function buildCatalog({ packs, capabilities, providers, hosts, configurations }) {
  const selected = new Set(configurations.flatMap((configuration) => configuration.selections.map((item) => item.id)));
  const items = [];
  for (const { value } of packs) {
    items.push({
      id: value.id,
      kind: 'pack',
      group: value.layer,
      label: labelFor(value.id),
      summary: value.summary,
      version: value.version,
      state: value.evidenceMaturity,
      selected: selected.has(value.id),
      effects: [...value.effects],
      limitations: []
    });
  }
  for (const { value } of capabilities) {
    items.push({
      id: value.id,
      kind: 'capability',
      group: 'capability',
      label: labelFor(value.id),
      summary: value.purpose,
      version: value.version,
      state: value.portability,
      selected: configurations.some((configuration) => configuration.bindings.some((binding) => binding.capability === value.id)),
      effects: [...value.effects],
      limitations: [...value.providerLimitations]
    });
  }
  for (const { value } of providers) {
    items.push({
      id: value.id,
      kind: 'provider',
      group: value.containment,
      label: labelFor(value.id),
      summary: value.pack + ' · ' + value.containment + ' provider implementation',
      version: value.version,
      state: value.containment,
      selected: selected.has(value.pack),
      effects: [...value.effects],
      limitations: [...value.limitations]
    });
  }
  for (const { value } of hosts) {
    items.push({
      id: value.id,
      kind: 'host',
      group: 'host',
      label: labelFor(value.id),
      summary: value.summary,
      version: value.version,
      state: value.evidenceMaturity,
      selected: configurations.some((configuration) => configuration.host === value.host),
      effects: [],
      limitations: [...value.limitations]
    });
  }
  for (const configuration of configurations) {
    items.push({
      id: 'configuration.' + configuration.name,
      kind: 'configuration',
      group: 'configuration',
      label: labelFor(configuration.name),
      summary: 'Exact selected packs, bindings, authorities, host, and effect policies.',
      version: null,
      state: configuration.lockState,
      selected: true,
      effects: configuration.effectPolicies.map((policy) => policy.effect),
      limitations: configuration.lockState === 'missing' ? ['No checked-in exact lock is available.'] : []
    });
  }
  return sortById(items);
}

function buildGraph({ catalog, packs, providers, configurations }) {
  const nodes = catalog.map((item) => ({
    id: item.id,
    kind: item.kind,
    group: item.group,
    label: item.label,
    summary: item.summary,
    selected: item.selected,
    state: item.state
  }));
  const edges = [];
  const addEdge = (kind, source, target, label, scope = null) => edges.push({
    id: kind + ':' + (scope ? scope + ':' : '') + source + ':' + target,
    kind,
    source,
    target,
    label
  });

  for (const { value } of packs) {
    for (const dependency of value.dependencies) addEdge('dependency', value.id, dependency.pack, dependency.version);
    for (const capability of value.capabilities.requires) addEdge('requires', value.id, capability.id, capability.version);
    for (const capability of value.capabilities.provides) addEdge('provides', value.id, capability.id, capability.version);
  }
  for (const { value } of providers) {
    addEdge('provider', value.id, value.pack, value.containment);
    for (const capability of value.capabilities) addEdge('implements', value.id, capability.id, capability.version);
  }
  for (const configuration of configurations) {
    const configurationId = 'configuration.' + configuration.name;
    for (const selection of configuration.selections) addEdge('selects', configurationId, selection.id, selection.source);
    addEdge('host', configurationId, 'host.' + configuration.host, 'launch host');
    for (const authority of configuration.authorities) {
      const authorityNodeId = configurationId + ':authority:' + authority.id;
      nodes.push({
        id: authorityNodeId,
        kind: 'authority',
        group: 'authority',
        label: labelFor(authority.id),
        summary: authority.role + ' authority for ' + authority.subject,
        selected: true,
        state: 'declared'
      });
    }
    for (const binding of configuration.bindings) {
      addEdge('binding', binding.capability, binding.providerPack, 'bound provider', configurationId);
      for (const authority of binding.authorities) {
        addEdge(
          'authority',
          binding.capability,
          configurationId + ':authority:' + authority,
          'authorized by',
          configurationId
        );
      }
    }
  }
  return { nodes: sortById(nodes), edges: sortById(edges) };
}

function isEvidence(value) {
  return value.$contract === 'soter://contracts/evidence/v2';
}

function scenarioExecution(entry, configuration, fixtureDocs) {
  if (!configuration?.lockFingerprint) return null;
  const scenarioFingerprint = fingerprintJson(entry.value);
  const runs = new Map(fixtureDocs
    .filter((candidate) => candidate.value.$contract === 'soter://contracts/run-envelope/v1')
    .map((candidate) => [candidate.value.id, candidate.value]));
  const candidates = fixtureDocs
    .filter((candidate) => isEvidence(candidate.value)
      && candidate.value.configurationLockFingerprint === configuration.lockFingerprint)
    .filter((candidate) => candidate.value.artifacts.some((artifact) => artifact.role === 'scenario'
      && artifact.id === entry.value.id
      && artifact.fingerprint === scenarioFingerprint))
    .map((candidate) => {
      const run = runs.get(candidate.value.subject.id);
      const assessment = candidate.value.artifacts.find((artifact) => artifact.role === 'scenario-assessment');
      if (!run
        || !assessment
        || !run.evidenceIds.includes(candidate.value.id)
        || run.scenario?.id !== entry.value.id
        || run.scenario?.fingerprint !== scenarioFingerprint
        || run.configurationLock.fingerprint !== configuration.lockFingerprint) return null;
      return { evidence: candidate.value, run, assessment };
    })
    .filter(Boolean)
    .sort((left, right) => compareText(right.evidence.createdAt, left.evidence.createdAt)
      || compareText(left.evidence.id, right.evidence.id));
  const selected = candidates[0];
  if (!selected) return null;
  const coverage = {};
  for (const category of ['outcome', 'invariant', 'evidence']) {
    const items = selected.evidence.outcomes.filter((item) => item.category === category);
    coverage[category] = {
      passed: items.filter((item) => item.state === 'passed').length,
      total: items.length
    };
  }
  return {
    source: 'fixture',
    result: selected.evidence.result,
    observedAt: selected.evidence.createdAt,
    runId: selected.run.id,
    evidenceIds: [selected.evidence.id],
    capabilityOrder: selected.assessment.capabilityOrder,
    effectModes: selected.assessment.effectModes,
    coverage,
    limitations: [...selected.evidence.limitations]
  };
}

function buildWorkflows({
  root,
  schemas,
  diagnostics,
  packs,
  hosts,
  scenarios,
  configurations,
  configurationMemberships,
  fixtureDocs
}) {
  return packs.filter(({ value }) => value.layer === 'automation').map(({ value: automation }) => {
    const configuration = configurations.find((candidate) => {
      const membership = configurationMemberships.find((item) => item.name === candidate.name);
      return membership?.selections.some((selection) => selection.id === automation.id);
    });
    const automationScenarios = scenarios.filter((entry) => entry.value.automation === automation.id);
    let operator = null;
    if (automation.operator) {
      const inputEntry = loadArtifact(root, resolveRepoPath(root, automation.operator.input), schemas, diagnostics);
      if (inputEntry?.value.$contract === 'soter://contracts/automation-input/v1'
        && inputEntry.value.automation === automation.id) {
        operator = {
          inputContract: {
            id: inputEntry.value.id,
            version: inputEntry.value.version,
            fields: inputEntry.value.fields.map((field) => {
              const projected = structuredClone(field);
              if (projected.exposure === 'private') delete projected.examples;
              return projected;
            }),
            additionalInputs: inputEntry.value.additionalInputs
          },
          preparation: {
            supported: Boolean(
              automation.operator.preparation || automation.operator.acquisition
            ),
            boundary: automation.operator.preparation || automation.operator.acquisition
              ? 'explicit private preparation modes only; mode facts grant no provider-call, approval, continuation, execution, write, readiness, verification, proof, or maturity authority'
              : 'input-definition-only; no canonical prepared-work receipt or transition authority',
            workStates: [
              ...(automation.operator.preparation
                ? ['draft', 'preparing', 'needs-input', 'ready-for-review']
                : []),
              ...(automation.operator.acquisition
                ? ['ready-for-acquisition']
                : [])
            ],
            modes: [
              ...(automation.operator.preparation
                ? [{
                  id: 'contained',
                  configurationBases: ['tracked-contained', 'private-active'],
                  resultState: 'ready-for-review',
                  availability: { state: 'available' },
                  boundary: 'private fixture-contained preparation only; no connected provider call, approval, execution, write, proof, or maturity authority'
                }]
                : []),
              ...(automation.operator.acquisition
                ? [{
                  id: 'connected-acquisition',
                  configurationBases: ['private-active'],
                  resultState: 'ready-for-acquisition',
                  availability: structuredClone(
                    automation.operator.acquisition.availability || { state: 'available' }
                  ),
                  boundary: 'stages exact private input and the current active lock only; no provider call, acquired context, approval, continuation, execution, write, readiness, verification, proof, or maturity authority'
                }]
                : [])
            ]
          }
        };
      }
    }
    return {
      id: automation.id,
      label: labelFor(automation.id),
      summary: automation.summary,
      version: automation.version,
      configuration: configuration?.name || null,
      configurationBasis: configuration?.configurationBasis || null,
      host: configuration?.host || null,
      hostCompatibility: Object.fromEntries(
        hosts
          .map((entry) => entry.value.host)
          .sort(compareText)
          .map((host) => {
            if (automation.compatibility.hosts.includes(host)) {
              return [host, { state: 'compatible' }];
            }
            const declared = (automation.compatibility.unavailableHosts || [])
              .find((item) => item.id === host);
            return [host, declared ? {
              state: 'unavailable',
              reasonCode: declared.reasonCode,
              reason: declared.reason
            } : {
              state: 'unavailable',
              reasonCode: 'AUTOMATION_HOST_NOT_DECLARED_COMPATIBLE',
              reason: 'The Automation manifest does not declare this host compatible.'
            }];
          })
      ),
      effects: [...automation.effects],
      requiredCapabilities: automation.capabilities.requires.map((item) => item.id).sort(compareText),
      dependencies: automation.dependencies.map((item) => item.pack).sort(compareText),
      bindings: (configuration?.bindings || []).map((item) => item.capability + ' → ' + item.providerPack).sort(compareText),
      operator,
      scenarios: automationScenarios.map((entry) => {
        const execution = scenarioExecution(entry, configuration, fixtureDocs);
        return {
          id: entry.value.id,
          status: execution ? 'executed-' + execution.result : 'declared-not-executed',
          intent: entry.value.intent,
          outcomes: [...entry.value.expected.outcomes],
          invariants: [...entry.value.expected.invariants],
          evidence: [...entry.value.expected.evidence],
          execution
        };
      }).sort((left, right) => compareText(left.id, right.id))
    };
  }).sort((left, right) => compareText(left.id, right.id));
}

function evidenceSummary(evidence) {
  return {
    id: evidence.id,
    claim: evidence.claim,
    result: evidence.result,
    level: evidence.evaluator.level,
    createdAt: evidence.createdAt,
    limitations: [...evidence.limitations]
  };
}

function fixtureActivity(fixtureDocs) {
  const evidenceById = new Map(fixtureDocs
    .filter((entry) => isEvidence(entry.value))
    .map((entry) => [entry.value.id, entry.value]));
  return fixtureDocs
    .filter((entry) => entry.value.$contract === 'soter://contracts/run-envelope/v1')
    .map(({ value: run }) => {
      const timeline = [];
      for (const checkpoint of run.checkpoints) {
        timeline.push({
          id: run.id + ':checkpoint:' + checkpoint.id,
          sequence: timeline.length + 1,
          label: labelFor(checkpoint.id),
          state: checkpoint.state,
          kind: 'checkpoint',
          at: run.createdAt,
          capability: null,
          provider: null,
          authority: null,
          inputFingerprint: null,
          outputFingerprint: null,
          details: checkpoint.details
        });
      }
      for (const effect of run.effects) {
        timeline.push({
          id: effect.id,
          sequence: timeline.length + 1,
          label: labelFor(effect.capability),
          state: effect.state,
          kind: 'effect',
          at: effect.completedAt,
          capability: effect.capability,
          provider: effect.providerImplementation,
          authority: effect.authority,
          inputFingerprint: effect.inputFingerprint,
          outputFingerprint: effect.outputFingerprint,
          details: effect.declaredEffects.join(' + ') + ' · ' + effect.containment
        });
      }
      for (const output of run.outputs) {
        timeline.push({
          id: run.id + ':output:' + output.id,
          sequence: timeline.length + 1,
          label: labelFor(output.id),
          state: 'observed',
          kind: 'output-reference',
          at: run.createdAt,
          capability: null,
          provider: null,
          authority: null,
          inputFingerprint: null,
          outputFingerprint: output.fingerprint,
          details: output.type
        });
      }
      return {
        id: run.id,
        source: 'fixture',
        kind: 'run',
        label: run.requestedOutcome,
        state: run.lifecycleState,
        createdAt: run.createdAt,
        updatedAt: run.createdAt,
        host: run.host.id,
        provider: null,
        capability: null,
        configurationLockFingerprint: run.configurationLock.fingerprint,
        graphFingerprint: run.graphFingerprint,
        recoveryId: null,
        timeline,
        evidence: run.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean).map(evidenceSummary)
      };
    });
}

function callForCheckpoint(checkpoint) {
  if (checkpoint.kind !== 'operation-plan') return checkpoint.call;
  return checkpoint.steps.find((step) => step.state === 'requested')?.call
    || [...checkpoint.steps].reverse().find((step) => step.call)?.call
    || null;
}

function operationPlanTimeline(checkpoint) {
  return checkpoint.steps.map((step) => {
    const source = checkpoint.plan.steps.find((candidate) => candidate.id === step.id);
    return {
      id: checkpoint.id + ':' + step.id,
      sequence: step.sequence,
      label: source?.reason || labelFor(step.id),
      state: step.state,
      kind: 'operation-step',
      at: step.call?.completedAt || step.call?.createdAt || checkpoint.updatedAt,
      capability: source?.capability || null,
      provider: source?.providerImplementation || null,
      authority: source?.authority || null,
      inputFingerprint: step.call?.inputFingerprint || null,
      outputFingerprint: step.outputFingerprint,
      details: step.error
        ? 'Stopped with a ' + (step.error.kind || 'normalized') + ' error; private message excluded.'
        : step.call?.pagination
          ? 'Cursor-paged capability; ' + step.call.pagination.pages.length
            + ' normalized page receipt(s); cursor values and private payload excluded.'
          : step.id === checkpoint.currentStepId ? 'Current step' : 'Sequential plan step'
    };
  });
}

function runtimeActivity(root, schemas, diagnostics) {
  const directory = path.join(root, '.soter', 'state', 'host-calls');
  const items = [];
  for (const file of walkJson(directory)) {
    let raw;
    try {
      raw = readJson(file);
    } catch (error) {
      diagnostics.push(scopedDiagnostic({
        code: 'SOTER_INSPECTION_RUNTIME_JSON_INVALID',
        source: 'runtime-state',
        subject: repoRelativePath(root, file),
        message: error.message,
        remediation: 'Remove or repair the malformed private checkpoint.'
      }));
      continue;
    }
    const schema = schemas.get(raw.$contract);
    const failures = schema ? validateJsonSchema(raw, schema) : [{ path: '$', message: 'unknown checkpoint contract' }];
    if (failures.length) {
      diagnostics.push(scopedDiagnostic({
        code: 'SOTER_INSPECTION_RUNTIME_INVALID',
        source: 'runtime-state',
        subject: repoRelativePath(root, file),
        message: failures.slice(0, 4).map((item) => item.path + ' ' + item.message).join('; '),
        remediation: 'Discard or repair this private checkpoint; other runtime activity remains available.'
      }));
      continue;
    }
    let checkpoint;
    try {
      checkpoint = getDurableHostExecution({ root, checkpointId: raw.id }).checkpoint;
    } catch (error) {
      diagnostics.push(scopedDiagnostic({
        code: 'SOTER_INSPECTION_RUNTIME_TAMPERED',
        source: 'runtime-state',
        subject: repoRelativePath(root, file),
        message: error.message,
        remediation: 'Do not resume this checkpoint; prepare the exact operation again.'
      }));
      continue;
    }
    const call = callForCheckpoint(checkpoint);
    const timeline = checkpoint.kind === 'operation-plan'
      ? operationPlanTimeline(checkpoint)
      : [{
          id: checkpoint.id + ':call',
          sequence: 1,
          label: checkpoint.kind === 'provider-probe' ? 'Provider probe' : labelFor(call?.capability?.id || checkpoint.id),
          state: checkpoint.state,
          kind: checkpoint.kind,
          at: call?.completedAt || call?.createdAt || checkpoint.updatedAt,
          capability: call?.capability?.id || null,
          provider: call?.provider?.implementation || null,
          authority: call?.authority || null,
          inputFingerprint: call?.inputFingerprint || null,
          outputFingerprint: call?.outputFingerprint || null,
          details: call?.error
            ? 'Stopped with a ' + (call.error.kind || 'normalized') + ' error; private message excluded.'
            : call?.pagination
              ? 'Cursor-paged capability; ' + call.pagination.pages.length
                + ' normalized page receipt(s); cursor values and private payload excluded.'
              : 'Private checkpoint metadata; payload excluded.'
        }];
    items.push({
      id: checkpoint.id,
      source: 'runtime',
      kind: checkpoint.kind,
      label: checkpoint.kind === 'operation-plan' ? labelFor(checkpoint.plan.id) : labelFor(checkpoint.id),
      state: checkpoint.state,
      createdAt: checkpoint.createdAt,
      updatedAt: checkpoint.updatedAt,
      host: checkpoint.host.id,
      provider: call?.provider?.implementation || null,
      capability: call?.capability?.id || null,
      configurationLockFingerprint: checkpoint.configurationLock.fingerprint,
      graphFingerprint: checkpoint.graphFingerprint,
      recoveryId: checkpoint.id,
      timeline,
      evidence: []
    });
  }
  return items;
}

function connectedTransactionActivity(root, diagnostics) {
  const directory = path.join(root, '.soter', 'state', 'approval-requests');
  const items = [];
  for (const file of walkJson(directory)) {
    let request;
    try {
      request = readJson(file);
    } catch (error) {
      diagnostics.push(scopedDiagnostic({
        code: 'SOTER_INSPECTION_APPROVAL_REQUEST_JSON_INVALID',
        source: 'runtime-state',
        subject: repoRelativePath(root, file),
        message: error.message,
        remediation: 'Discard or repair this private approval request; other connected activity remains visible.'
      }));
      continue;
    }
    let inspection;
    try {
      inspection = inspectConnectedOperatorActivity({ root, requestId: request.id });
    } catch (error) {
      diagnostics.push(scopedDiagnostic({
        code: 'SOTER_INSPECTION_CONNECTED_ACTIVITY_INVALID',
        source: 'runtime-state',
        subject: repoRelativePath(root, file),
        message: error.message,
        remediation: 'Do not continue this transaction; inspect or repair its canonical private state.'
      }));
      continue;
    }
    const timeline = [{
      id: inspection.approval.request.id,
      sequence: 1,
      label: 'Exact approval request',
      state: inspection.approval.state,
      kind: 'approval-request',
      at: inspection.approval.request.requestedAt,
      capability: null,
      provider: null,
      authority: inspection.scope.authorities[0] || null,
      inputFingerprint: inspection.scope.batch.fingerprint,
      outputFingerprint: inspection.approval.request.fingerprint,
      details: inspection.resume.reason
    }];
    if (inspection.approval.confirmation) {
      timeline.push({
        id: inspection.approval.confirmation.id,
        sequence: timeline.length + 1,
        label: 'Exact approval recorded',
        state: inspection.approval.state,
        kind: 'approval',
        at: inspection.approval.confirmation.confirmedAt,
        capability: null,
        provider: null,
        authority: inspection.scope.authorities[0] || null,
        inputFingerprint: inspection.approval.request.fingerprint,
        outputFingerprint: inspection.approval.confirmation.fingerprint,
        details: 'Approval is bound to this request and is not a reusable permission token.'
      });
    }
    for (const step of inspection.capabilities.steps) {
      timeline.push({
        id: inspection.activity.id + ':' + step.id,
        sequence: timeline.length + 1,
        label: labelFor(step.capability),
        state: step.state,
        kind: 'connected-operation',
        at: inspection.checkpoint?.updatedAt || inspection.generatedAt,
        capability: step.capability,
        provider: null,
        authority: step.authority,
        inputFingerprint: null,
        outputFingerprint: null,
        details: step.effects.join(' + ') + ' · canonical checkpoint projection'
      });
    }
    items.push({
      id: inspection.activity.id,
      automationId: inspection.activity.automationId,
      source: 'runtime',
      kind: 'connected-transaction',
      label: inspection.activity.automationId
        ? labelFor(inspection.activity.automationId)
        : labelFor(inspection.activity.workId),
      state: inspection.activity.workState,
      createdAt: inspection.approval.request.requestedAt,
      updatedAt: inspection.checkpoint?.updatedAt
        || inspection.approval.confirmation?.confirmedAt
        || inspection.approval.request.requestedAt,
      host: inspection.configuration.host,
      provider: null,
      capability: null,
      configurationLockFingerprint: inspection.configuration.lockFingerprint,
      graphFingerprint: inspection.configuration.graphFingerprint,
      recoveryId: inspection.checkpoint?.id || null,
      operatorRef: {
        requestId: inspection.approval.request.id,
        approvalId: inspection.approval.confirmation?.id || null,
        checkpointId: inspection.checkpoint?.id || null
      },
      timeline,
      evidence: []
    });
  }
  return items;
}

function preparedWorkActivity(root, schemas, diagnostics) {
  const directory = path.join(root, '.soter', 'state', 'prepared-work');
  const items = [];
  for (const file of walkJson(directory)) {
    let work;
    try {
      work = readJson(file);
    } catch (error) {
      diagnostics.push(scopedDiagnostic({
        code: 'SOTER_INSPECTION_PREPARED_WORK_JSON_INVALID',
        source: 'runtime-state',
        subject: repoRelativePath(root, file),
        message: error.message,
        remediation: 'Discard or repair this malformed private preparation checkpoint.'
      }));
      continue;
    }
    const schema = schemas.get(work.$contract);
    const failures = schema ? validateJsonSchema(work, schema) : [{ path: '$', message: 'unknown prepared-work contract' }];
    if (failures.length) {
      diagnostics.push(scopedDiagnostic({
        code: 'SOTER_INSPECTION_PREPARED_WORK_INVALID',
        source: 'runtime-state',
        subject: repoRelativePath(root, file),
        message: failures.slice(0, 4).map((item) => item.path + ' ' + item.message).join('; '),
        remediation: 'Discard or repair this private preparation checkpoint; other work remains visible.'
      }));
      continue;
    }
    try {
      assertPreparedWork(root, work);
      work = projectPreparedWorkApplicability(root, work);
    } catch (error) {
      diagnostics.push(scopedDiagnostic({
        code: 'SOTER_INSPECTION_PREPARED_WORK_TAMPERED',
        source: 'runtime-state',
        subject: repoRelativePath(root, file),
        message: error.message,
        remediation: 'Do not rely on this receipt; prepare the exact work again.'
      }));
      continue;
    }
    const timeline = work.history.map((item, index) => ({
      id: work.id + ':state:' + String(index + 1),
      sequence: index + 1,
      label: labelFor(item.state),
      state: item.state,
      kind: 'preparation-state',
      at: item.at,
      capability: null,
      provider: null,
      authority: null,
      inputFingerprint: work.inputSummary.inputContractFingerprint,
      outputFingerprint: index === work.history.length - 1 ? work.fingerprint : null,
      details: item.reasonCode
    }));
    for (const step of work.contextPlan) {
      timeline.push({
        id: work.id + ':context:' + step.id,
        sequence: timeline.length + 1,
        label: step.label,
        state: step.state,
        kind: 'context-read',
        at: work.updatedAt,
        capability: step.capability,
        provider: null,
        authority: step.authority,
        inputFingerprint: step.inputFingerprint,
        outputFingerprint: step.outputFingerprint,
        details: step.containment + ' · ' + step.limitation
      });
    }
    items.push({
      id: work.id,
      automationId: work.automation.id,
      source: 'runtime',
      kind: 'prepared-work',
      label: labelFor(work.automation.id),
      state: work.state,
      createdAt: work.createdAt,
      updatedAt: work.updatedAt,
      host: work.configuration.host,
      provider: null,
      capability: null,
      configurationLockFingerprint: work.configuration.lockFingerprint,
      graphFingerprint: work.configuration.graphFingerprint,
      recoveryId: work.checkpoint.id,
      preparedWorkRef: { workId: work.id },
      timeline,
      evidence: structuredClone(work.evidence)
    });
  }
  return items;
}

function developmentRunActivity(root, diagnostics) {
  const directory = path.join(root, '.soter', 'state', 'development-requests');
  const items = [];
  for (const file of walkJson(directory)) {
    let requestId;
    try {
      requestId = readJson(file).id;
      const inspection = inspectDevelopmentRun({ root, requestId });
      const timeline = [{
        id: inspection.request.id + ':request',
        sequence: 1,
        label: 'Exact private development request',
        state: 'requested',
        kind: 'development-request',
        at: inspection.request.createdAt,
        capability: null,
        provider: null,
        authority: 'request-scoped-development',
        inputFingerprint: inspection.request.fingerprint,
        outputFingerprint: null,
        details: inspection.invocation.kind + ' · private target paths and requested outcome excluded'
      }];
      if (inspection.result) {
        timeline.push({
          id: inspection.result.id,
          sequence: 2,
          label: 'Scoped development evidence',
          state: inspection.result.state,
          kind: 'development-result',
          at: inspection.result.completedAt,
          capability: null,
          provider: null,
          authority: 'development-evidence-only',
          inputFingerprint: inspection.request.fingerprint,
          outputFingerprint: inspection.result.fingerprint,
          details: String(inspection.progress.completedRuns) + ' of '
            + String(inspection.progress.totalRuns) + ' planned worker runs recorded'
        });
      }
      items.push({
        id: inspection.request.id,
        automationId: inspection.workflow.id,
        source: 'runtime',
        kind: 'development-run',
        label: labelFor(inspection.workflow.id),
        state: inspection.progress.state,
        createdAt: inspection.request.createdAt,
        updatedAt: inspection.result?.completedAt || inspection.request.createdAt,
        host: inspection.host.id,
        provider: null,
        capability: null,
        configurationLockFingerprint: inspection.configuration.lockFingerprint,
        graphFingerprint: inspection.configuration.graphFingerprint,
        recoveryId: null,
        developmentRef: {
          requestId: inspection.request.id,
          resultId: inspection.result?.id || null
        },
        timeline,
        evidence: []
      });
    } catch (error) {
      diagnostics.push(scopedDiagnostic({
        code: error?.code || 'SOTER_INSPECTION_DEVELOPMENT_RUN_INVALID',
        source: 'runtime-state',
        subject: requestId || repoRelativePath(root, file),
        message: 'Private development state is unavailable or invalid; private error details were withheld.',
        remediation: 'Inspect or repair the exact private development request and result state before relying on it.'
      }));
    }
  }
  return items;
}

export function inspectWorkspace({ root = DEFAULT_ROOT } = {}) {
  const resolvedRoot = path.resolve(root);
  const diagnostics = [];
  const schemas = schemaMap(resolvedRoot, diagnostics);
  const verification = verifySoter(resolvedRoot, { includeRuntimeArtifacts: false });
  const maturityVerification = verifySoter(resolvedRoot);
  diagnostics.push(...verification.violations.map((item) => verifierDiagnostic(resolvedRoot, item)));

  const packs = loadDirectory(resolvedRoot, 'soter/packs', schemas, diagnostics)
    .filter((entry) => entry.value.$contract === 'soter://contracts/pack/v1');
  const capabilities = loadDirectory(resolvedRoot, 'soter/capabilities', schemas, diagnostics)
    .filter((entry) => entry.value.$contract === 'soter://contracts/capability/v1');
  const providers = loadDirectory(resolvedRoot, 'soter/providers', schemas, diagnostics)
    .filter((entry) => entry.value.$contract === 'soter://contracts/capability-provider/v1');
  const hosts = loadDirectory(resolvedRoot, 'soter/hosts', schemas, diagnostics)
    .filter((entry) => entry.value.$contract === 'soter://contracts/host-adapter/v2');
  const scenarios = loadDirectory(resolvedRoot, 'soter/scenarios', schemas, diagnostics)
    .filter((entry) => entry.value.$contract === 'soter://contracts/scenario/v1');
  const fixtureDocs = loadDirectory(resolvedRoot, 'soter/fixtures', schemas, diagnostics);
  const maturityEvidence = loadMaturityEvidence(resolvedRoot);
  diagnostics.push(...maturityEvidence.diagnostics.map((item) => scopedDiagnostic({
    code: item.code,
    severity: 'warning',
    source: 'maturity-evidence',
    subject: item.subject,
    message: item.message,
    remediation: item.remediation
  })));
  const configurations = configurationSnapshots(
    resolvedRoot,
    maturityVerification,
    fixtureDocs,
    maturityEvidence.records
  );
  const proof = proofSnapshot(resolvedRoot, verification, configurations, fixtureDocs, diagnostics);
  const catalog = buildCatalog({ packs, capabilities, providers, hosts, configurations });
  const graph = buildGraph({ catalog, packs, providers, configurations });
  const workflows = buildWorkflows({
    root: resolvedRoot,
    schemas,
    diagnostics,
    packs,
    hosts,
    scenarios,
    configurations,
    configurationMemberships: maturityVerification.resolvedConfigurations,
    fixtureDocs
  });
  const activity = [
    ...fixtureActivity(fixtureDocs),
    ...runtimeActivity(resolvedRoot, schemas, diagnostics),
    ...preparedWorkActivity(resolvedRoot, schemas, diagnostics),
    ...developmentRunActivity(resolvedRoot, diagnostics),
    ...connectedTransactionActivity(resolvedRoot, diagnostics)
  ]
    .sort((left, right) => compareText(right.updatedAt || '', left.updatedAt || '') || compareText(left.id, right.id));

  return {
    $contract: CONTRACT,
    contractVersion: VERSION,
    workspace: { name: 'Soter Harness', root: '.', mode: 'read-only' },
    census: {
      configurations: configurations.length,
      packs: packs.length,
      capabilities: capabilities.length,
      providers: providers.length,
      hosts: hosts.length,
      scenarios: scenarios.length,
      fixtureActivity: activity.filter((item) => item.source === 'fixture').length,
      runtimeActivity: activity.filter((item) => item.source === 'runtime').length
    },
    proof,
    configurations,
    catalog,
    graph,
    workflows,
    activity,
    diagnostics: diagnostics.sort((left, right) => compareText(left.subject, right.subject) || compareText(left.code, right.code))
  };
}
