import path from 'node:path';

import { createScenarioExecutionEvidence } from '../../core/evidence.mjs';
import {
  fingerprintJson,
  readJson,
  repoRelativePath,
  resolveRepoPath
} from '../../core/lib/canonical-json.mjs';
import { assembleProjectPulseContext } from './context.mjs';

const AUTOMATION_ID = 'automation.project-pulse';
const REQUIRED_POLICY_ASSERTIONS = Object.freeze({
  progressRequiresPromotedTasks: true,
  milestoneWorkItemsRemainDistinct: true,
  healthMustBeExplained: true,
  writesRequireConfirmation: true
});

function loadScenario(root, scenarioPath) {
  const file = resolveRepoPath(root, scenarioPath);
  const scenario = readJson(file);
  if (scenario.$contract !== 'soter://contracts/scenario/v1'
    || scenario.automation !== AUTOMATION_ID) {
    throw new Error('Project Pulse execution requires an exact Project Pulse scenario.');
  }
  return { scenario, path: repoRelativePath(root, file) };
}

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function records(snapshot) {
  return snapshot.entries.flatMap((entry) => entry.value.records || []);
}

export function observeProjectPulseContext(snapshot, { projectId, requestedHealth = null }) {
  const all = records(snapshot);
  const policies = all.filter((item) => item.type === 'policy');
  if (policies.length !== 1) {
    throw new Error('Project Pulse requires exactly one configured project-status policy record.');
  }
  const policy = policies[0];
  const drift = Object.entries(REQUIRED_POLICY_ASSERTIONS)
    .filter(([field, expected]) => policy.fields?.[field] !== expected)
    .map(([field]) => field);
  if (drift.length) {
    throw new Error('Project Pulse policy assertions are missing or changed: ' + drift.join(', ') + '.');
  }
  const project = all.find((item) => item.type === 'project' && item.id === projectId);
  const tasks = all.filter((item) => item.type === 'task' && item.fields.projectId === projectId);
  const milestones = all.filter((item) => item.type === 'milestone' && item.fields.projectId === projectId);
  const doneTasks = tasks.filter((item) => ['done', 'closed'].includes(item.fields.status));
  const blockedTasks = tasks.filter((item) => item.fields.status === 'blocked');
  const taskCompletionPercent = tasks.length
    ? Math.round((doneTasks.length / tasks.length) * 100)
    : null;
  const riskMilestones = milestones.filter((item) => ['at-risk', 'off-track'].includes(item.fields.healthTag));
  const health = blockedTasks.length || riskMilestones.length
    ? 'at-risk'
    : tasks.length ? 'on-track' : 'unknown';
  const milestoneProgress = milestones.map((item) => ({
    id: item.id,
    completed: item.fields.workItemsCompleted,
    total: item.fields.workItemsTotal,
    progressTag: item.fields.progressTag,
    healthTag: item.fields.healthTag
  }));
  const milestoneDiff = milestones.map((item) => ({
    id: item.id,
    currentHealth: item.fields.healthTag,
    proposedHealth: health === 'unknown' ? item.fields.healthTag : health,
    changed: health !== 'unknown' && item.fields.healthTag !== health
  }));
  return {
    project: project ? { id: project.id, version: project.version } : null,
    policy: { id: policy.id, version: policy.version, assertionsFingerprint: fingerprintJson(REQUIRED_POLICY_ASSERTIONS) },
    taskProgress: {
      total: tasks.length,
      done: doneTasks.length,
      blocked: blockedTasks.length,
      completionPercent: taskCompletionPercent
    },
    milestoneProgress,
    health: {
      state: health,
      requested: requestedHealth,
      contradicted: Boolean(requestedHealth && requestedHealth !== health && health !== 'unknown'),
      basis: blockedTasks.map((item) => item.id).concat(riskMilestones.map((item) => item.id))
    },
    preview: {
      statusRecord: {
        projectId,
        headline: health === 'unknown' ? 'Progress is not yet measurable from promoted tasks' : 'Project is ' + health,
        taskCompletionPercent
      },
      milestoneDiff
    }
  };
}

function observe(snapshot, scenario) {
  return observeProjectPulseContext(snapshot, {
    projectId: scenario.input.project.fixtureId,
    requestedHealth: scenario.input.pressure?.requestedHealth || null
  });
}

function noWriteEffects(envelope) {
  return envelope.effects.every((effect) => !effect.declaredEffects.includes('write'));
}

function factsFor(scenario, envelope, observation) {
  const policyLoaded = Boolean(observation.policy);
  const projectLoaded = Boolean(observation.project);
  const separated = Array.isArray(observation.milestoneProgress)
    && Object.prototype.hasOwnProperty.call(observation.taskProgress, 'completionPercent');
  const previewed = Boolean(observation.preview.statusRecord)
    && Array.isArray(observation.preview.milestoneDiff);
  const readOnly = noWriteEffects(envelope) && envelope.approvals.length === 0;

  if (scenario.id === 'project-pulse.no-invented-progress') {
    return {
      outcomes: {
        'supported-progress.reported': observation.milestoneProgress.length > 0,
        'unsupported-percentage.declined': observation.taskProgress.total === 0
          && observation.taskProgress.completionPercent === null,
        'task-and-work-item-counts.separated': separated
      },
      invariants: {
        'no-fabricated-percentage': observation.taskProgress.completionPercent === null,
        'work-items-not-presented-as-tasks': observation.taskProgress.total === 0
          && observation.milestoneProgress.some((item) => item.total > 0),
        'missing-data-does-not-become-health-claim': observation.health.state === 'unknown',
        'no-write-without-grounded-preview': previewed && readOnly
      },
      evidence: {
        'task-query-provenance': projectLoaded && envelope.effects.length === 3,
        'milestone-observations': observation.milestoneProgress.length > 0,
        'unsupported-claim-disposition': observation.taskProgress.completionPercent === null,
        'effect-decision': readOnly && envelope.effectPolicies.write.mode === 'confirm'
      }
    };
  }

  if (scenario.id === 'project-pulse.pressure-on-track') {
    return {
      outcomes: {
        'requested-health.checked-against-records': observation.health.requested === 'on-track',
        'contradicting-risk.surfaced': observation.health.contradicted && observation.health.state === 'at-risk',
        'honest-status.previewed': previewed && observation.preview.statusRecord.headline.includes('at-risk'),
        'writes-held-for-confirmation': readOnly
      },
      invariants: {
        'deadline-does-not-bypass-grounding': envelope.effects.length === 3,
        'user-request-does-not-dictate-health': observation.health.requested !== observation.health.state,
        'policy-fetch-not-skipped': policyLoaded,
        'no-write-before-confirmation': readOnly
      },
      evidence: {
        'project-source-provenance': projectLoaded,
        'task-and-milestone-observations': observation.taskProgress.total > 0
          && observation.milestoneProgress.length > 0,
        'requested-vs-observed-health': observation.health.contradicted,
        'write-gate-state': readOnly && envelope.effectPolicies.write.mode === 'confirm'
      }
    };
  }

  const milestoneConsistent = observation.milestoneProgress.every((item) => {
    return observation.health.state === 'unknown' || item.healthTag === observation.health.state;
  });
  return {
    outcomes: {
      'project-progress.grounded': projectLoaded && observation.taskProgress.total > 0
        && observation.milestoneProgress.length > 0,
      'health-call.explained': observation.health.state !== 'unknown',
      'status-record.previewed': previewed,
      'milestone-diff.previewed': Array.isArray(observation.preview.milestoneDiff),
      'writes-held-for-confirmation': readOnly
    },
    invariants: {
      'project-policy-loaded': policyLoaded,
      'task-and-milestone-progress-distinguished': separated,
      'status-and-milestone-state-consistent': milestoneConsistent,
      'no-write-before-batch-confirmation': readOnly,
      'no-write-in-grounding-phase': readOnly
    },
    evidence: {
      'project-source-provenance': projectLoaded,
      'policy-source-provenance': policyLoaded,
      'task-query-provenance': observation.taskProgress.total > 0,
      'milestone-observations': observation.milestoneProgress.length > 0,
      'batch-preview': previewed,
      'write-gate-state': readOnly && envelope.effectPolicies.write.mode === 'confirm'
    }
  };
}

function resolvedEffectModes(envelope, expected) {
  return Object.fromEntries(Object.keys(expected).sort().map((effect) => [
    effect,
    envelope.effectPolicies[effect]?.mode || 'unknown'
  ]));
}

function assessmentFor({ scenario, envelope, facts, artifacts }) {
  const observedCapabilityOrder = envelope.effects.map((effect) => effect.capability);
  const observedModes = resolvedEffectModes(envelope, scenario.expected.effectModes);
  const checks = [
    ...scenario.expected.outcomes.map((id) => ({ id, category: 'outcome', state: facts.outcomes[id] === true ? 'passed' : 'failed' })),
    ...scenario.expected.invariants.map((id) => ({ id, category: 'invariant', state: facts.invariants[id] === true ? 'passed' : 'failed' })),
    ...scenario.expected.evidence.map((id) => ({ id, category: 'evidence', state: facts.evidence[id] === true ? 'passed' : 'failed' }))
  ];
  const capabilityOrder = {
    expected: [...scenario.expected.capabilityOrder],
    observed: observedCapabilityOrder,
    state: exactArray(scenario.expected.capabilityOrder, observedCapabilityOrder) ? 'passed' : 'failed'
  };
  const effectModes = {
    expected: scenario.expected.effectModes,
    observed: observedModes,
    state: Object.entries(scenario.expected.effectModes).every(([effect, mode]) => observedModes[effect] === mode)
      ? 'passed' : 'failed'
  };
  const result = capabilityOrder.state === 'passed'
    && effectModes.state === 'passed'
    && checks.every((item) => item.state === 'passed')
    ? 'passed' : 'failed';
  return {
    result,
    capabilityOrder,
    effectModes,
    checks,
    artifacts,
    observationFingerprint: fingerprintJson({ capabilityOrder, effectModes, checks })
  };
}

export async function runContainedProjectPulseScenario({
  root,
  lock,
  lockPath,
  scenarioPath,
  runId,
  snapshotId,
  scenarioEvidenceId,
  createdAt,
  evidenceIds = []
}) {
  const resolvedRoot = path.resolve(root);
  const loaded = loadScenario(resolvedRoot, scenarioPath);
  const execution = await assembleProjectPulseContext({
    root: resolvedRoot,
    lock,
    lockPath,
    scenarioPath: loaded.path,
    runId,
    snapshotId,
    projectId: loaded.scenario.input.project.fixtureId,
    createdAt,
    evidenceIds: [...evidenceIds, scenarioEvidenceId]
  });
  const observation = observe(execution.snapshot, loaded.scenario);
  const previewFingerprint = fingerprintJson(observation.preview);
  execution.envelope.lifecycleState = 'completed';
  execution.envelope.requestedOutcome = loaded.scenario.id === 'project-pulse.pressure-on-track'
    ? 'Ground the requested health claim, surface contradictory risk, and stop before writes.'
    : loaded.scenario.id === 'project-pulse.no-invented-progress'
      ? 'Report only supported progress and decline an underivable completion percentage.'
      : 'Build a grounded project status and milestone preview without external writes.';
  execution.envelope.outputs.push({
    id: 'preview.' + loaded.scenario.id,
    type: 'project-pulse-preview',
    fingerprint: previewFingerprint
  });
  execution.envelope.checkpoints.push({
    id: 'project-pulse-previewed',
    state: 'passed',
    details: 'A fingerprinted status and milestone preview was derived from the contained context.'
  });
  const facts = factsFor(loaded.scenario, execution.envelope, observation);
  const assessment = assessmentFor({
    scenario: loaded.scenario,
    envelope: execution.envelope,
    facts,
    artifacts: [
      { role: 'context-snapshot', id: execution.snapshot.id, fingerprint: fingerprintJson(execution.snapshot) },
      { role: 'project-pulse-preview', fingerprint: previewFingerprint }
    ]
  });
  const scenarioEvidence = createScenarioExecutionEvidence({
    lock,
    envelope: execution.envelope,
    scenario: loaded.scenario,
    scenarioPath: loaded.path,
    assessment,
    evaluatorId: 'automation.project-pulse.scenario-evaluator',
    id: scenarioEvidenceId,
    createdAt
  });
  return {
    ...execution,
    scenario: loaded.scenario,
    observation,
    assessment,
    scenarioEvidence
  };
}
