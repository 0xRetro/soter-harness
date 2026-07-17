import path from 'node:path';

import { fingerprintJson, readJson, repoRelativePath, resolveRepoPath } from './lib/canonical-json.mjs';
import { fingerprintLock, lockMatchesResolution } from './resolve.mjs';

function selectedAutomation(lock, automationId) {
  const candidates = lock.packs.filter((pack) => pack.layer === 'automation');
  const selected = automationId
    ? candidates.find((pack) => pack.id === automationId)
    : candidates.length === 1 ? candidates[0] : null;
  if (!selected) {
    throw new Error('Select exactly one automation pack for the run envelope.');
  }
  return selected;
}

function loadScenario(root, requestedPath) {
  if (!requestedPath) {
    return null;
  }
  const file = resolveRepoPath(root, requestedPath);
  const doc = readJson(file);
  if (doc.$contract !== 'soter://contracts/scenario/v1') {
    throw new Error('Not a Soter scenario: ' + requestedPath);
  }
  return { file, doc };
}

export function prepareRunEnvelope({
  root,
  lock,
  lockPath,
  scenarioPath,
  automationId,
  runId,
  createdAt,
  requestedOutcome,
  evidenceIds = []
}) {
  const resolvedRoot = path.resolve(root);
  const current = lockMatchesResolution({
    lock,
    root: resolvedRoot,
    configPath: lock.configuration.path
  });
  if (!current.matches) {
    throw new Error(
      'Configuration lock is stale: expected ' + current.expectedFingerprint
        + ' but observed ' + current.observedFingerprint + '.'
    );
  }
  const scenario = loadScenario(resolvedRoot, scenarioPath);
  const automation = selectedAutomation(lock, automationId || scenario?.doc.automation);
  if (scenario && scenario.doc.automation !== automation.id) {
    throw new Error('Scenario automation does not match selected automation ' + automation.id + '.');
  }

  const envelope = {
    $contract: 'soter://contracts/run-envelope/v1',
    contractVersion: '1.0.0',
    id: runId,
    createdAt,
    requestedOutcome: requestedOutcome || 'Prepare a fixture-contained ' + automation.id + ' run without executing provider effects.',
    initiation: 'user-requested',
    intent: scenario?.doc.intent || 'operate',
    lifecycleState: 'effects-established',
    automation: {
      id: automation.id,
      version: automation.version
    },
    configurationLock: {
      path: lockPath,
      fingerprint: fingerprintLock(lock)
    },
    graphFingerprint: lock.graphFingerprint,
    context: lock.authorities.map((authority) => ({
      subject: authority.subject,
      authority: authority.id,
      role: authority.role,
      uri: authority.uri,
      declarationFingerprint: authority.declarationFingerprint,
      status: 'declared',
      provenance: 'configuration-lock:' + fingerprintLock(lock),
      freshness: 'unknown'
    })),
    bindings: lock.bindings,
    host: lock.host,
    effectPolicies: lock.effectPolicies,
    approvals: [],
    checkpoints: [
      {
        id: 'effects-established',
        state: 'passed',
        details: 'Effect policy is resolved; no capability or external effect has executed.'
      }
    ],
    outputs: [],
    effects: [],
    evidenceIds: [...evidenceIds]
  };

  if (scenario) {
    envelope.scenario = {
      id: scenario.doc.id,
      path: repoRelativePath(resolvedRoot, scenario.file),
      fingerprint: fingerprintJson(scenario.doc)
    };
  }
  return envelope;
}
