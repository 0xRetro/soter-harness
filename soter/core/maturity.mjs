import fs from 'node:fs';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { fingerprintJson, readJson, repoRelativePath } from './lib/canonical-json.mjs';
import { fingerprintLock } from './resolve.mjs';

const LEVELS = ['static', 'graph', 'fixture', 'agent', 'contained', 'canary', 'monitored'];
const MATURITY_FLOORS = new Map([
  ['fixture-proven', 'fixture'],
  ['contained-proven', 'contained'],
  ['live-proven', 'canary']
]);
const CONTAINMENT = new Map([
  ['fixture-proven', new Set(['fixture', 'connected', 'canary', 'live'])],
  ['contained-proven', new Set(['connected', 'canary', 'live'])],
  ['live-proven', new Set(['canary', 'live'])]
]);

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en');
}

function walkJson(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkJson(target);
    return entry.isFile() && entry.name.endsWith('.json') ? [target] : [];
  }).sort(compareText);
}

function diagnostic(code, subject, message, remediation) {
  return { code, subject, message, remediation };
}

export function loadMaturityEvidence(root) {
  const resolvedRoot = path.resolve(root);
  const schema = readJson(path.join(resolvedRoot, 'soter/contracts/evidence-v2.schema.json'));
  const directories = [
    { path: path.join(resolvedRoot, 'soter/evidence'), evidenceOnly: true },
    { path: path.join(resolvedRoot, 'soter/fixtures'), evidenceOnly: false },
    { path: path.join(resolvedRoot, '.soter/state/evidence'), evidenceOnly: true }
  ];
  const candidates = [];
  const diagnostics = [];
  for (const { path: directory, evidenceOnly } of directories) {
    for (const file of walkJson(directory)) {
      if (!evidenceOnly && !file.endsWith('.evidence.json')) continue;
      let value;
      try {
        value = readJson(file);
      } catch (error) {
        diagnostics.push(diagnostic(
          'SOTER_MATURITY_EVIDENCE_JSON_INVALID',
          repoRelativePath(resolvedRoot, file),
          error.message,
          'Repair or remove the malformed evidence record; it cannot support maturity.'
        ));
        continue;
      }
      if (value?.$contract !== 'soter://contracts/evidence/v2') continue;
      const failures = validateJsonSchema(value, schema);
      if (failures.length) {
        diagnostics.push(diagnostic(
          'SOTER_MATURITY_EVIDENCE_INVALID',
          repoRelativePath(resolvedRoot, file),
          failures.slice(0, 4).map((item) => item.path + ' ' + item.message).join('; '),
          'Regenerate the record from the versioned evidence contract.'
        ));
        continue;
      }
      candidates.push({ file, value });
    }
  }
  const counts = new Map();
  for (const candidate of candidates) {
    counts.set(candidate.value.id, (counts.get(candidate.value.id) || 0) + 1);
  }
  const records = [];
  const duplicateDiagnostics = new Set();
  for (const candidate of candidates) {
    if (counts.get(candidate.value.id) > 1) {
      if (!duplicateDiagnostics.has(candidate.value.id)) {
        diagnostics.push(diagnostic(
          'SOTER_MATURITY_EVIDENCE_DUPLICATE',
          candidate.value.id,
          'More than one evidence/v2 record uses this identity.',
          'Retain one immutable record per evidence identity; use supersedes for replacement evidence.'
        ));
        duplicateDiagnostics.add(candidate.value.id);
      }
      continue;
    }
    records.push(candidate.value);
  }
  return {
    records: records.sort((left, right) => compareText(left.id, right.id)),
    diagnostics
  };
}

function expectedDependencies(lock) {
  return lock.packs.map((pack) => ({
    id: pack.id,
    version: pack.version,
    fingerprint: pack.manifestFingerprint
  })).sort((left, right) => compareText(left.id, right.id));
}

function expectedHost(lock) {
  return {
    id: lock.host.id,
    adapter: lock.host.adapter,
    version: lock.host.version,
    manifestFingerprint: lock.host.manifestFingerprint
  };
}

function expectedIntegrations(lock) {
  return lock.packs.filter((pack) => pack.layer === 'integration').map((pack) => ({
    id: pack.id,
    version: pack.version,
    manifestFingerprint: pack.manifestFingerprint,
    evidenceMaturity: pack.evidenceMaturity
  })).sort((left, right) => compareText(left.id, right.id));
}

function expectedAuthorities(lock) {
  return lock.authorities.map((authority) => ({
    id: authority.id,
    role: authority.role,
    subject: authority.subject,
    declarationFingerprint: authority.declarationFingerprint
  })).sort((left, right) => compareText(left.id, right.id));
}

function exactArray(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function evidenceApplies({ evidence, component, lock, requiredLevel }) {
  const subjectType = component.kind === 'host' ? 'host' : 'pack';
  if (evidence.$contract !== 'soter://contracts/evidence/v2'
    || evidence.claimFamily !== 'behavior'
    || evidence.subject.type !== subjectType
    || evidence.subject.id !== component.id
    || evidence.subject.version !== component.version
    || evidence.configurationLockFingerprint !== fingerprintLock(lock)
    || evidence.graphFingerprint !== lock.graphFingerprint
    || !exactArray(
      [...evidence.dependencies].sort((left, right) => compareText(left.id, right.id)),
      expectedDependencies(lock)
    )
    || fingerprintJson(evidence.host) !== fingerprintJson(expectedHost(lock))
    || !exactArray(
      [...evidence.integrations].sort((left, right) => compareText(left.id, right.id)),
      expectedIntegrations(lock)
    )
    || !exactArray(
      [...evidence.authorities].sort((left, right) => compareText(left.id, right.id)),
      expectedAuthorities(lock)
    )
    || LEVELS.indexOf(evidence.evaluator.level) < LEVELS.indexOf(requiredLevel)
    || !CONTAINMENT.get(component.claim)?.has(evidence.environment.containment)) {
    return false;
  }
  return true;
}

function resultAt(evidence, at) {
  if (evidence.result === 'failed') return 'failed';
  if (evidence.result === 'stale') return 'stale';
  if (evidence.result === 'passed' && evidence.freshness.validUntil !== null) {
    const validUntil = Date.parse(evidence.freshness.validUntil);
    const observedAt = Date.parse(at);
    if (!Number.isFinite(validUntil) || !Number.isFinite(observedAt) || validUntil < observedAt) {
      return 'stale';
    }
  }
  if (evidence.result === 'passed') return 'passed';
  return 'unknown';
}

function aggregateResults(results) {
  if (results.includes('failed')) return 'failed';
  if (results.includes('stale')) return 'stale';
  if (!results.length || results.includes('unknown')) return 'unknown';
  return results.every((result) => result === 'passed') ? 'passed' : 'unknown';
}

function evidenceSummary(evidence, result) {
  return {
    id: evidence.id,
    claimFamily: evidence.claimFamily,
    claim: evidence.claim,
    result,
    level: evidence.evaluator.level,
    createdAt: evidence.createdAt,
    validUntil: evidence.freshness.validUntil,
    limitations: [...evidence.limitations]
  };
}

function declaredProjection(component) {
  return {
    id: component.id,
    claim: component.claim,
    state: 'declared',
    result: 'unknown',
    reasonCode: 'MATURITY_DECLARED',
    requiredLevel: null,
    evidenceIds: [],
    evidence: [],
    basis: 'The manifest declares this component without claiming behavior support.',
    limitations: ['Declared artifacts and test capacity do not establish applicable behavior evidence.'],
    remediation: 'Promote the claim only with exact subject-scoped behavior evidence.'
  };
}

function unsupportedProjection(component, result, reasonCode, requiredLevel, evidence = []) {
  const summaries = evidence.map((item) => evidenceSummary(item.evidence, item.result));
  const messages = {
    MATURITY_LOCK_NOT_CURRENT: 'The exact configuration lock is not current, so no maturity evidence can apply.',
    MATURITY_EVIDENCE_MISSING: 'No active evidence record matches the exact subject, lock, graph, dependency set, host, level, and containment.',
    MATURITY_EVIDENCE_FAILED: 'Applicable active behavior evidence failed.',
    MATURITY_EVIDENCE_STALE: 'Applicable behavior evidence is stale under its result or freshness boundary.',
    MATURITY_EVIDENCE_INCONCLUSIVE: 'Applicable behavior evidence is unknown, skipped, or otherwise inconclusive.'
  };
  return {
    id: component.id,
    claim: component.claim,
    state: 'unsupported',
    result,
    reasonCode,
    requiredLevel,
    evidenceIds: summaries.map((item) => item.id),
    evidence: summaries,
    basis: messages[reasonCode],
    limitations: ['A manifest label, scenario file, run completion, or lower-level evidence cannot substitute for this exact claim.'],
    remediation: reasonCode === 'MATURITY_LOCK_NOT_CURRENT'
      ? 'Resolve and review a current exact lock before evaluating maturity evidence.'
      : 'Produce or supersede subject-scoped behavior evidence at the required level for this exact lock.'
  };
}

function componentProjection({ component, lock, lockState, records, at }) {
  if (component.claim === 'declared') return declaredProjection(component);
  const requiredLevel = MATURITY_FLOORS.get(component.claim);
  if (lockState !== 'current') {
    return unsupportedProjection(
      component,
      lockState === 'stale' ? 'stale' : 'unknown',
      'MATURITY_LOCK_NOT_CURRENT',
      requiredLevel
    );
  }
  const candidates = records.filter((evidence) => evidenceApplies({
    evidence,
    component,
    lock,
    requiredLevel
  }));
  const superseded = new Set(candidates.map((evidence) => evidence.supersedes).filter(Boolean));
  const active = candidates.filter((evidence) => !superseded.has(evidence.id));
  if (!active.length) {
    return unsupportedProjection(component, 'unknown', 'MATURITY_EVIDENCE_MISSING', requiredLevel);
  }
  const evaluated = active.map((evidence) => ({ evidence, result: resultAt(evidence, at) }));
  const result = aggregateResults(evaluated.map((item) => item.result));
  if (result === 'passed') {
    const summaries = evaluated.map((item) => evidenceSummary(item.evidence, item.result));
    return {
      id: component.id,
      claim: component.claim,
      state: 'supported',
      result,
      reasonCode: 'MATURITY_EVIDENCE_APPLIES',
      requiredLevel,
      evidenceIds: summaries.map((item) => item.id),
      evidence: summaries,
      basis: 'Active behavior evidence matches the exact subject, lock, graph, dependency set, host, level, containment, and freshness boundary.',
      limitations: summaries.flatMap((item) => item.limitations),
      remediation: 'Re-evaluate when the lock, subject, dependencies, host, evaluator, or freshness boundary changes.'
    };
  }
  const reasonCode = result === 'failed'
    ? 'MATURITY_EVIDENCE_FAILED'
    : result === 'stale'
      ? 'MATURITY_EVIDENCE_STALE'
      : 'MATURITY_EVIDENCE_INCONCLUSIVE';
  return unsupportedProjection(component, result, reasonCode, requiredLevel, evaluated);
}

export function evaluateConfigurationMaturity({
  lock,
  resolvedConfiguration,
  evidenceRecords = [],
  lockState = 'current',
  at = new Date().toISOString()
}) {
  if (!resolvedConfiguration
    || (lock && lock.configuration.name !== resolvedConfiguration.name)
    || (!lock && lockState === 'current')) {
    throw new Error('Maturity evaluation requires one resolved configuration and its matching lock when current.');
  }
  const host = componentProjection({
    component: {
      kind: 'host',
      id: resolvedConfiguration.host.adapter,
      version: resolvedConfiguration.host.version,
      claim: resolvedConfiguration.host.evidenceMaturity
    },
    lock,
    lockState,
    records: evidenceRecords,
    at
  });
  const selections = resolvedConfiguration.selections.map((selection) => componentProjection({
    component: {
      kind: 'pack',
      id: selection.id,
      version: selection.version,
      claim: selection.evidenceMaturity
    },
    lock,
    lockState,
    records: evidenceRecords,
    at
  })).sort((left, right) => compareText(left.id, right.id));
  const projections = [host, ...selections];
  return {
    verified: aggregateResults(projections.map((projection) => projection.result)),
    reasonCode: projections.every((projection) => projection.result === 'passed')
      ? 'CONFIGURATION_MATURITY_SUPPORTED'
      : projections.some((projection) => projection.result === 'failed')
        ? 'CONFIGURATION_MATURITY_FAILED'
        : projections.some((projection) => projection.result === 'stale')
          ? 'CONFIGURATION_MATURITY_STALE'
          : 'CONFIGURATION_MATURITY_INCOMPLETE',
    host,
    selections,
    evidenceIds: [...new Set(projections.flatMap((projection) => projection.evidenceIds))].sort(compareText)
  };
}
