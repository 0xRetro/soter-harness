import path from 'node:path';

import { createScenarioExecutionEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { fingerprintLegacySource } from '../../kernel/legacy-inventory.mjs';
import { prepareRepositoryReviewRun } from './prepare.mjs';

const AUTOMATION_ID = 'automation.repository-review';

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.id !== 'repository-review.preparation'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Repository Review fixture execution requires the exact preparation scenario.');
  }
  return { scenario, path: repoRelativePath(root, file) };
}

function exactArray(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assessmentFor({ scenario, envelope, facts, artifacts }) {
  const observedCapabilities = envelope.effects.map((effect) => effect.capability);
  const observedModes = Object.fromEntries(Object.keys(scenario.expected.effectModes)
    .sort()
    .map((effect) => [effect, envelope.effectPolicies[effect]?.mode || 'unknown']));
  const checks = [
    ...scenario.expected.outcomes.map((id) => ({ id, category: 'outcome', state: facts.outcomes[id] === true ? 'passed' : 'failed' })),
    ...scenario.expected.invariants.map((id) => ({ id, category: 'invariant', state: facts.invariants[id] === true ? 'passed' : 'failed' })),
    ...scenario.expected.evidence.map((id) => ({ id, category: 'evidence', state: facts.evidence[id] === true ? 'passed' : 'failed' }))
  ];
  const capabilityOrder = {
    expected: [...scenario.expected.capabilityOrder],
    observed: observedCapabilities,
    state: exactArray(scenario.expected.capabilityOrder, observedCapabilities) ? 'passed' : 'failed'
  };
  const effectModes = {
    expected: scenario.expected.effectModes,
    observed: observedModes,
    state: Object.entries(scenario.expected.effectModes).every(([effect, mode]) => {
      return observedModes[effect] === mode;
    }) ? 'passed' : 'failed'
  };
  const result = capabilityOrder.state === 'passed'
    && effectModes.state === 'passed'
    && checks.every((check) => check.state === 'passed')
    ? 'passed'
    : 'failed';
  return {
    result,
    capabilityOrder,
    effectModes,
    checks,
    artifacts,
    observationFingerprint: fingerprintJson({ capabilityOrder, effectModes, checks })
  };
}

function noAuthority(execution) {
  return execution.envelope.lifecycleState === 'paused'
    && execution.envelope.approvals.length === 0
    && execution.preview.proposedChanges.length === 0
    && execution.envelope.effects.every((effect) => {
      return !effect.declaredEffects.includes('write')
        && !effect.declaredEffects.includes('dispatch')
        && !effect.declaredEffects.includes('destructive');
    });
}

export async function runContainedRepositoryReviewScenario({
  root,
  lock,
  lockPath,
  scenarioPath,
  workId,
  scenarioEvidenceId,
  createdAt
}) {
  const resolvedRoot = path.resolve(root);
  const loaded = loadScenario(resolvedRoot, scenarioPath);
  const sourceCaseArtifacts = loaded.scenario.sourceCases.map((sourcePath) => ({
    role: 'source-case',
    path: sourcePath,
    fingerprint: fingerprintLegacySource(resolvedRoot, sourcePath)
  }));
  const input = {
    repositoryUri: 'repo-fixture://process-platform',
    scope: 'product-capabilities'
  };
  const execution = await prepareRepositoryReviewRun({
    root: resolvedRoot,
    lock,
    lockPath,
    workId,
    scenarioPath: loaded.path,
    input,
    createdAt
  });
  const repositoryEntry = execution.snapshot.entries.find((entry) => {
    return entry.id === 'context.repository-review.snapshot';
  });
  const duplicateEntry = execution.snapshot.entries.find((entry) => {
    return entry.id === 'context.repository-review.duplicates';
  });
  const rows = execution.preview.collections[0].rows;
  const handoffRows = rows.filter((row) => row.actions[0].state === 'handoff');
  const duplicateRows = rows.filter((row) => {
    return row.flags.includes('REPOSITORY_FEATURE_DUPLICATE_OBSERVED');
  });
  const privateValues = repositoryEntry.value.capabilities.flatMap((candidate) => [
    candidate.id,
    candidate.name,
    candidate.why,
    candidate.summary,
    candidate.currentState,
    ...candidate.evidence.map((evidence) => evidence.relativePath)
  ]).concat(input.repositoryUri, duplicateEntry.value.candidateIds);
  const sanitized = JSON.stringify({ envelope: execution.envelope, preview: execution.preview });
  const facts = {
    outcomes: {
      'repository-source.grounded': Boolean(repositoryEntry),
      'source-backed-capabilities-observed': repositoryEntry.value.capabilities.length === 3,
      'consistent-product-altitude': rows.length === 3
        && rows.every((row) => row.group === 'product-capability'),
      'duplicate-visible-and-held': duplicateRows.length === 1
        && duplicateRows[0].actions[0].state === 'held',
      'feature-capture-handoffs-prepared': handoffRows.length === 2
        && handoffRows.every((row) => row.actions[0].kind === 'feature-capture-handoff'),
      'writes-prohibited': noAuthority(execution)
    },
    invariants: {
      'source-read-not-readme-only': repositoryEntry.value.repository.readmeObserved === true
        && repositoryEntry.value.capabilities.every((candidate) => {
          return candidate.evidence.some((item) => item.relativePath !== 'README.md');
        }),
      'candidate-set-complete': execution.preview.collections[0].coverage.complete === true
        && execution.preview.collections[0].coverage.observedCount === 3
        && execution.preview.collections[0].coverage.includedCount === 3,
      'existing-feature-not-proposed-as-new': duplicateRows.length === 1
        && duplicateRows[0].actions.every((action) => action.state !== 'handoff'),
      'handoff-does-not-create-target-work': execution.preview.proposedChanges.length === 0
        && execution.envelope.outputs.length === 1,
      'tooling-page-not-fabricated': !JSON.stringify(execution.derivedReview).includes('tooling-page')
        && !execution.envelope.effects.some((effect) => effect.capability.includes('create')),
      'no-write-or-approval-during-preparation': noAuthority(execution)
    },
    evidence: {
      'exact-lock': execution.envelope.configurationLock.fingerprint === fingerprintLock(lock)
        && execution.envelope.graphFingerprint === lock.graphFingerprint,
      'repository-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        repositoryEntry.value.repository.identityFingerprint
      ),
      'duplicate-query-fingerprint': /^sha256:[a-f0-9]{64}$/.test(
        duplicateEntry.value.providerOutputFingerprint
      ),
      'private-values-sanitized': privateValues.every((value) => !sanitized.includes(value)),
      'source-cases-exactly-fingerprinted': sourceCaseArtifacts.length === 4
        && sourceCaseArtifacts.every((artifact) => /^sha256:[a-f0-9]{64}$/.test(artifact.fingerprint))
    }
  };
  const assessment = assessmentFor({
    scenario: loaded.scenario,
    envelope: execution.envelope,
    facts,
    artifacts: [
      { role: 'context-snapshot', id: execution.snapshot.id, fingerprint: fingerprintJson(execution.snapshot) },
      { role: 'repository-review-preview', fingerprint: execution.preview.fingerprint }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: execution.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    sourceCaseArtifacts,
    assessment,
    evaluatorId: 'automation.repository-review.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return { ...execution, scenario: loaded.scenario, assessment, scenarioEvidence };
}
