import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { assembleProjectPulseContext } from './context.mjs';
import { observeProjectPulseContext } from './scenario.mjs';

function contextPlan(envelope, snapshot) {
  return snapshot.entries.map((entry, index) => {
    const invocation = envelope.effects[index];
    return {
      id: 'preparation.context.' + String(index + 1),
      sequence: index + 1,
      label: entry.role === 'definition' ? 'Load project-status policy'
        : index === 1 ? 'Load selected project' : 'Load project milestones and promoted tasks',
      capability: entry.capability,
      authority: entry.authority,
      containment: 'fixture',
      state: 'completed',
      inputFingerprint: invocation?.inputFingerprint || null,
      outputFingerprint: entry.valueFingerprint,
      limitation: 'This is a contained fixture read; it does not establish connected reachability or permission.'
    };
  });
}

function previewFor(observation) {
  const completion = observation.taskProgress.completionPercent;
  const riskBasis = observation.health.basis;
  const facts = [
    {
      id: 'project-reference',
      label: 'Project',
      value: observation.project?.id || null,
      state: observation.project ? 'supported' : 'unavailable',
      basisIds: observation.project ? ['context.project-pulse.project'] : []
    },
    {
      id: 'task-completion',
      label: 'Promoted task completion',
      value: completion,
      state: completion === null ? 'unavailable' : 'supported',
      basisIds: ['context.project-pulse.work']
    },
    {
      id: 'health',
      label: 'Explained health',
      value: observation.health.state,
      state: observation.health.state === 'unknown' ? 'unavailable' : 'supported',
      basisIds: riskBasis.length ? riskBasis : ['context.project-pulse.work']
    },
    {
      id: 'milestones',
      label: 'Milestones reviewed',
      value: observation.milestoneProgress.length,
      state: observation.milestoneProgress.length ? 'supported' : 'unavailable',
      basisIds: ['context.project-pulse.work']
    }
  ];
  const contradictions = observation.health.state === 'at-risk' ? [{
    id: 'risk-prevents-on-track-claim',
    claim: 'Blocked tasks or at-risk milestones prevent an unsupported on-track status.',
    state: 'observed',
    basisIds: riskBasis
  }] : [];
  const collections = [];
  const privateReview = {
    state: 'unavailable', kind: null, contractId: null,
    contractFingerprint: null, contentFingerprint: null
  };
  const proposedChanges = [];
  const preview = {
    kind: 'project-pulse-status',
    fingerprint: null,
    facts,
    contradictions,
    collections,
    privateReview,
    proposedChanges
  };
  preview.fingerprint = fingerprintJson({
    kind: preview.kind,
    facts,
    contradictions,
    collections,
    privateReview,
    proposedChanges
  });
  return preview;
}

export async function prepareProjectPulseRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt
}) {
  const runId = 'run.' + workId.slice('work.'.length);
  const snapshotId = 'context.' + workId.slice('work.'.length);
  const execution = await assembleProjectPulseContext({
    root,
    lock,
    lockPath,
    scenarioPath: null,
    runId,
    snapshotId,
    projectId: input.project,
    createdAt,
    evidenceIds: []
  });
  const observation = observeProjectPulseContext(execution.snapshot, { projectId: input.project });
  const preview = previewFor(observation);
  const unavailable = preview.facts.filter((item) => item.state === 'unavailable');
  return {
    envelope: execution.envelope,
    snapshot: execution.snapshot,
    contextPlan: contextPlan(execution.envelope, execution.snapshot),
    outcomes: [
      {
        id: 'project-status-preview',
        label: 'Grounded project status preview',
        state: observation.project ? 'supported' : 'blocked',
        basis: ['context.project-pulse.project', 'context.project-pulse.work'],
        limitation: 'The preview is private and fixture-contained; it is not a published status record.'
      },
      {
        id: 'milestone-review',
        label: 'Milestone and promoted-task review',
        state: observation.milestoneProgress.length ? 'supported' : 'blocked',
        basis: ['context.project-pulse.work'],
        limitation: 'Milestones remain distinct from promoted task completion.'
      },
      {
        id: 'contradiction-review',
        label: 'Contradictions and missing evidence surfaced',
        state: unavailable.length ? 'blocked' : 'supported',
        basis: preview.facts.flatMap((item) => item.basisIds),
        limitation: unavailable.length
          ? unavailable.map((item) => item.label).join(', ') + ' could not be derived.'
          : 'No missing normalized preview facts were observed in the contained fixture.'
      }
    ],
    preview
  };
}
