import { fingerprintJson } from './lib/canonical-json.mjs';
import { fingerprintLock, RESOLVER_VERSION } from './resolve.mjs';
import { fingerprintPrivateContainedBasis } from '../kernel/private-contained-evidence.mjs';

const DEFAULT_RUNTIME = 'node';

function packDependencies(lock) {
  return lock.packs.map((pack) => ({
    id: pack.id,
    version: pack.version,
    fingerprint: pack.manifestFingerprint
  }));
}
function hostSummary(lock) {
  return {
    id: lock.host.id,
    adapter: lock.host.adapter,
    version: lock.host.version,
    manifestFingerprint: lock.host.manifestFingerprint
  };
}

function integrationSummaries(lock) {
  return lock.packs
    .filter((pack) => pack.layer === 'integration')
    .map((pack) => ({
      id: pack.id,
      version: pack.version,
      manifestFingerprint: pack.manifestFingerprint,
      evidenceMaturity: pack.evidenceMaturity
    }));
}

function authoritySummaries(lock) {
  return lock.authorities.map((authority) => ({
    id: authority.id,
    role: authority.role,
    subject: authority.subject,
    declarationFingerprint: authority.declarationFingerprint
  }));
}

function baseEvidence({
  id,
  createdAt,
  claimFamily,
  claim,
  subject,
  lock,
  evaluator,
  environment,
  acceptanceCriteria,
  result,
  outcomes = [],
  artifacts = [],
  effects = [],
  failures = [],
  warnings = [],
  skipped = [],
  limitations = [],
  privateContainedBasis = null
}) {
  return {
    $contract: 'soter://contracts/evidence/v2',
    contractVersion: '2.0.0',
    id,
    createdAt,
    claimFamily,
    claim,
    subject,
    configurationLockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint,
    dependencies: packDependencies(lock),
    host: hostSummary(lock),
    integrations: integrationSummaries(lock),
    authorities: authoritySummaries(lock),
    evaluator,
    environment,
    acceptanceCriteria,
    result,
    outcomes,
    artifacts,
    effects,
    failures,
    warnings,
    skipped,
    limitations,
    freshness: {
      policy: 'Valid only while every configuration-lock fingerprint remains unchanged.',
      validUntil: null
    },
    supersedes: null,
    privacy: {
      scope: 'private',
      redactions: ['Credential references and credential values are excluded.']
    },
    ...(privateContainedBasis === null ? {} : { privateContainedBasis })
  };
}

export function createResolutionEvidence({ lock, id, createdAt }) {
  return baseEvidence({
    id,
    createdAt,
    claimFamily: 'graph',
    claim: 'The desired configuration resolves to this exact, internally valid artifact graph.',
    subject: {
      type: 'configuration',
      id: lock.configuration.name,
      version: null
    },
    lock,
    evaluator: {
      id: 'core.resolver',
      version: RESOLVER_VERSION,
      level: 'graph'
    },
    environment: {
      containment: 'offline',
      runtime: DEFAULT_RUNTIME
    },
    acceptanceCriteria: [
      'Kernel validation reports no graph errors.',
      'Every selected pack, capability, host projection, authority, and policy is fingerprinted.',
      'Resolving unchanged inputs produces the same configuration lock fingerprint.',
      'Credential references and values are absent from the lock.'
    ],
    result: 'passed',
    outcomes: [
      { id: 'configuration.graph-resolved', state: 'passed' },
      { id: 'configuration.lock-deterministic', state: 'passed' },
      { id: 'configuration.lock-secret-free', state: 'passed' }
    ],
    artifacts: [
      {
        role: 'configuration',
        path: lock.configuration.path,
        fingerprint: lock.configuration.fingerprint
      },
      {
        role: 'configuration-lock',
        fingerprint: fingerprintLock(lock)
      }
    ],
    skipped: [
      'Host authentication and reachability were not checked offline.',
      'Integration capabilities were not invoked.',
      'Automation outcomes and external effects were not evaluated.'
    ],
    limitations: [
      'This evidence establishes graph validity and reproducibility only; it does not establish readiness, behavior verification, or live health.'
    ]
  });
}

export function createRunPreparationEvidence({ lock, envelope, id, createdAt }) {
  return baseEvidence({
    id,
    createdAt,
    claimFamily: 'preparation',
    claim: 'The fixture run envelope captures resolved context declarations, bindings, and effect policy without executing effects.',
    subject: {
      type: 'run',
      id: envelope.id,
      version: null
    },
    lock,
    evaluator: {
      id: 'core.run-preparer',
      version: RESOLVER_VERSION,
      level: 'fixture'
    },
    environment: {
      containment: 'fixture',
      runtime: DEFAULT_RUNTIME
    },
    acceptanceCriteria: [
      'The envelope references the exact configuration lock and graph fingerprint.',
      'Every authority declaration records explicit provenance and unknown freshness.',
      'Every selected capability binding and effect policy is present.',
      'No provider capability or external effect is executed during preparation.'
    ],
    result: 'passed',
    outcomes: [
      { id: 'run.envelope-prepared', state: 'passed' },
      { id: 'run.external-effects-executed', state: 'not-applicable' }
    ],
    artifacts: [
      {
        role: 'run-envelope',
        id: envelope.id,
        graphFingerprint: envelope.graphFingerprint
      },
      ...(envelope.scenario ? [{
        role: 'scenario',
        path: envelope.scenario.path,
        fingerprint: envelope.scenario.fingerprint
      }] : [])
    ],
    skipped: [
      'Declared authorities were not loaded from provider systems.',
      'Authentication, provider reachability, and capability behavior were not checked.',
      'Expected scenario outcomes were not claimed or evaluated.'
    ],
    limitations: [
      'Fixture preparation proves envelope construction, not automation behavior or provider conformance.'
    ]
  });
}

export function createContextAssemblyEvidence({ lock, envelope, snapshot, id, createdAt }) {
  return baseEvidence({
    id,
    createdAt,
    claimFamily: 'context',
    claim: 'Fixture providers returned schema-valid CRM and transcript context with explicit authority, provenance, freshness, and effect records.',
    subject: {
      type: 'run',
      id: envelope.id,
      version: null
    },
    lock,
    evaluator: {
      id: 'core.context-assembler',
      version: RESOLVER_VERSION,
      level: 'fixture'
    },
    environment: {
      containment: 'fixture',
      runtime: DEFAULT_RUNTIME
    },
    acceptanceCriteria: [
      'Capability inputs and outputs satisfy their portable schemas.',
      'Each invocation selects one authority allowed by its resolved binding.',
      'Read and disclosure effects pass the configured policy before provider dispatch.',
      'Context values preserve provider provenance, observation time, freshness, and fingerprints.',
      'No connected provider, credential, write capability, or external effect is used.'
    ],
    result: 'passed',
    outcomes: [
      { id: 'context.crm-definition-loaded', state: 'passed' },
      { id: 'context.crm-instances-loaded', state: 'passed' },
      { id: 'context.meeting-transcript-loaded', state: 'passed' },
      { id: 'automation.outcome-executed', state: 'not-applicable' }
    ],
    artifacts: [
      {
        role: 'context-snapshot',
        id: snapshot.id,
        fingerprint: fingerprintJson(snapshot)
      }
    ],
    effects: envelope.effects,
    skipped: [
      'Notion and Otter authentication and network reachability were not checked.',
      'CRM create and update capabilities were not invoked.',
      'Meeting-intake summaries, tasks, links, and project updates were not produced.'
    ],
    limitations: [
      'This evidence proves fixture capability dispatch and context assembly only; it does not establish connected readiness or automation outcome verification.'
    ]
  });
}

export function createAutomationPreparationEvidence({
  lock,
  envelope,
  snapshot,
  workId,
  inputSummaryFingerprint,
  previewFingerprint,
  id,
  createdAt
}) {
  return baseEvidence({
    id,
    createdAt,
    claimFamily: 'preparation',
    claim: 'A fixture-contained automation preparation validated sanitized inputs, grounded exact context reads, derived a review preview, and stopped before external writes.',
    subject: { type: 'run', id: envelope.id, version: null },
    lock,
    evaluator: {
      id: 'core.automation-preparer',
      version: RESOLVER_VERSION,
      level: 'fixture'
    },
    environment: { containment: 'fixture', runtime: DEFAULT_RUNTIME },
    acceptanceCriteria: [
      'The preparation binds one current exact configuration lock.',
      'Private operator inputs are represented only by fingerprints.',
      'Every context acquisition is a typed fixture-contained read.',
      'The normalized preview is fingerprinted and retains its evidence basis.',
      'No write, dispatch, destructive, connected-provider, approval, or execution authority is created.'
    ],
    result: 'passed',
    outcomes: [
      { id: 'preparation.input-validated', state: 'passed' },
      { id: 'preparation.context-grounded', state: 'passed' },
      { id: 'preparation.preview-derived', state: 'passed' },
      { id: 'preparation.external-write-executed', state: 'not-applicable' }
    ],
    artifacts: [
      { role: 'prepared-work', id: workId },
      { role: 'operator-input-summary', fingerprint: inputSummaryFingerprint },
      { role: 'run-envelope', id: envelope.id, graphFingerprint: envelope.graphFingerprint },
      { role: 'context-snapshot', id: snapshot.id, fingerprint: fingerprintJson(snapshot) },
      { role: 'automation-preview', fingerprint: previewFingerprint }
    ],
    effects: envelope.effects,
    skipped: [
      'No connected provider, credential, approval, write capability, or host execution was attempted.',
      'The prepared preview was not promoted to automation maturity, verification, or readiness evidence.'
    ],
    limitations: [
      'This receipt proves only fixture-contained preparation for one exact lock; it does not authorize or execute changes.'
    ]
  });
}

export function createContainedTransactionEvidence({
  lock,
  envelope,
  decision,
  changeSet,
  approval,
  id,
  createdAt
}) {
  return baseEvidence({
    id,
    createdAt,
    claimFamily: 'transaction',
    claim: 'One exactly approved fixture change set committed atomically and passed read-after-write verification without external effects.',
    subject: { type: 'run', id: envelope.id, version: null },
    lock,
    evaluator: {
      id: 'core.contained-transaction',
      version: RESOLVER_VERSION,
      level: 'fixture'
    },
    environment: { containment: 'fixture', runtime: DEFAULT_RUNTIME },
    acceptanceCriteria: [
      'The approval fingerprint matches the exact proposed operation scope.',
      'No write dispatches before approval.',
      'Create is deduplicated and updates enforce expected versions.',
      'All writes share one checkpoint and expose rollback state.',
      'A read-after-write confirms the source-linked summary and folded meeting-derived task.'
    ],
    result: changeSet.state === 'committed' && changeSet.verification.state === 'passed'
      ? 'passed' : 'failed',
    outcomes: [
      { id: 'meeting-summary.created-once', state: changeSet.verification.state },
      { id: 'grounded-task.folded', state: changeSet.verification.state },
      { id: 'source-meeting.attributed', state: changeSet.verification.state },
      { id: 'external-provider-effect', state: 'not-applicable' }
    ],
    artifacts: [
      {
        role: 'automation-decision',
        id: decision.id,
        fingerprint: decision.decisionFingerprint
      },
      { role: 'change-set', id: changeSet.id, fingerprint: fingerprintJson(changeSet) },
      { role: 'approval', id: approval.id, fingerprint: fingerprintJson(approval) }
    ],
    effects: envelope.effects,
    failures: changeSet.state === 'committed' ? [] : ['Contained transaction did not commit.'],
    skipped: [
      'No connected Notion workspace was authenticated or mutated.',
      'No live Otter transcript was read.',
      'Host behavior conformance was not evaluated.'
    ],
    limitations: [
      'This proves transaction mechanics against an in-memory provider fixture, not connected provider semantics or live rollback.'
    ]
  });
}

export function createContainedConnectedWorkflowEvidence({
  lock,
  privateContainedBasis,
  id,
  createdAt,
  automationId,
  runId,
  work,
  decision,
  proposal,
  changeSet,
  batch,
  approval,
  approvalConsumption,
  checkpoint
}) {
  const lockFingerprint = fingerprintLock(lock);
  if (!privateContainedBasis
    || privateContainedBasis.kind !== 'private-active-contained'
    || privateContainedBasis.privateConfigurationFingerprint
      !== lock.configuration.fingerprint
    || privateContainedBasis.privateLockFingerprint !== lockFingerprint
    || privateContainedBasis.privateGraphFingerprint !== lock.graphFingerprint
    || privateContainedBasis.basisFingerprint
      !== fingerprintPrivateContainedBasis(privateContainedBasis)) {
    throw new Error(
      'Contained connected workflow evidence requires one exact private-contained lock basis.'
    );
  }
  const lockReferences = [
    work?.configuration?.lockFingerprint,
    decision?.configurationLockFingerprint,
    proposal?.configurationLockFingerprint,
    changeSet?.configurationLockFingerprint,
    batch?.configurationLockFingerprint,
    approval?.scope?.configurationLockFingerprint,
    approvalConsumption?.configurationLockFingerprint,
    checkpoint?.configurationLock?.fingerprint
  ];
  const graphReferences = [
    work?.configuration?.graphFingerprint,
    decision?.graphFingerprint,
    proposal?.graphFingerprint,
    checkpoint?.graphFingerprint
  ];
  const runReferences = [
    work?.checkpoint?.runId,
    decision?.runId,
    proposal?.runId,
    changeSet?.runId,
    batch?.runId,
    approval?.runId,
    approvalConsumption?.runId,
    checkpoint?.run?.id
  ];
  if (lockReferences.some((fingerprint) => fingerprint !== lockFingerprint)
    || graphReferences.some((fingerprint) => fingerprint !== lock.graphFingerprint)
    || runReferences.some((candidate) => candidate !== runId)
    || work?.configuration?.configurationBasis !== 'private-active'
    || approvalConsumption?.configuration?.configurationBasis !== 'private-active'
    || checkpoint?.configuration?.configurationBasis !== 'private-active') {
    throw new Error(
      'Contained connected workflow artifacts do not share the exact private execution basis.'
    );
  }
  const preparedState = (
    work?.state === 'ready-for-review'
      && !Object.hasOwn(work, 'preparationMode')
  ) || (
    work?.state === 'ready-for-acquisition'
      && work?.preparationMode === 'connected-acquisition'
  );
  const completed = preparedState
    && decision?.state === 'ready'
    && proposal?.state === 'ready-for-review'
    && approvalConsumption?.state === 'started'
    && checkpoint?.state === 'completed'
    && checkpoint?.result?.state === 'completed'
    && checkpoint.operations?.length === batch?.operations?.length
    && checkpoint.operations.every((operation) => operation.state === 'applied');
  return baseEvidence({
    id,
    createdAt,
    claimFamily: 'transaction',
    claim: 'One fixture-contained connected-route workflow preserved exact private review, approval, single-use start, write, and read-after-write verification boundaries without a live provider effect.',
    subject: { type: 'run', id: runId, version: null },
    lock,
    evaluator: {
      id: automationId + '.contained-connected-workflow',
      version: RESOLVER_VERSION,
      level: 'fixture'
    },
    environment: { containment: 'fixture', runtime: DEFAULT_RUNTIME },
    acceptanceCriteria: [
      'One current prepared-work basis produces a deterministic grounded decision and private review proposal.',
      'No write request exists before an expiring exact-scope request is confirmed.',
      'The exact approval is consumed once into one durable checkpoint rather than retained as reusable authority.',
      'The checkpoint observes its declared precondition, one approved write result, and exact read-after-write verification in order.',
      'The private execution lock derives only from the exact portable tracked template through a closed contained provider substitution.',
      'Only normalized provider outputs and fingerprints enter durable state or this evidence record.'
    ],
    result: completed ? 'passed' : 'failed',
    outcomes: [
      { id: 'connected-workflow.prepared', state: preparedState ? 'passed' : 'failed' },
      { id: 'connected-workflow.decision-grounded', state: decision?.state === 'ready' ? 'passed' : 'failed' },
      { id: 'connected-workflow.proposal-reviewed', state: proposal?.state === 'ready-for-review' ? 'passed' : 'failed' },
      { id: 'connected-workflow.approval-consumed-once', state: approvalConsumption?.state === 'started' ? 'passed' : 'failed' },
      { id: 'connected-workflow.verified', state: checkpoint?.state === 'completed' ? 'passed' : 'failed' },
      { id: 'connected-workflow.private-contained-basis', state: 'passed' },
      { id: 'connected-workflow.live-provider-effect', state: 'not-applicable' }
    ],
    artifacts: [
      { role: 'prepared-work', id: work.id, fingerprint: work.fingerprint },
      {
        role: 'automation-decision',
        id: decision.id,
        fingerprint: decision.decisionFingerprint
      },
      {
        role: 'automation-proposal',
        id: proposal.id,
        fingerprint: proposal.proposalFingerprint
      },
      { role: 'connected-change-set', id: changeSet.id, fingerprint: fingerprintJson(changeSet) },
      { role: 'connected-operation-batch', id: batch.id, fingerprint: fingerprintJson(batch) },
      { role: 'approval', id: approval.id, fingerprint: fingerprintJson(approval) },
      {
        role: 'approval-consumption',
        id: approvalConsumption.id,
        fingerprint: fingerprintJson(approvalConsumption)
      },
      {
        role: 'connected-transaction-checkpoint',
        id: checkpoint.id,
        fingerprint: checkpoint.checkpointFingerprint
      }
    ],
    effects: [],
    failures: completed ? [] : ['The contained connected-route workflow did not complete.'],
    skipped: [
      'No live provider authentication, permission, reachability, write, or health was evaluated.',
      'No readiness, connected verification, health, or proof maturity is promoted by this transaction evidence alone.'
    ],
    limitations: [
      'Host responses are deterministic contained fixtures passed through the connected provider translators; this proves local transaction behavior only.',
      'The exact private execution lock remains private; this record exposes only its fingerprints and mechanically checked portable applicability projection.'
    ],
    privateContainedBasis
  });
}

export function createContainedConnectedReviewEvidence({
  lock,
  privateContainedBasis,
  id,
  createdAt,
  automationId,
  runId,
  work,
  decision,
  proposal,
  heldReasonCode
}) {
  const lockFingerprint = fingerprintLock(lock);
  if (!privateContainedBasis
    || privateContainedBasis.kind !== 'private-active-contained'
    || privateContainedBasis.privateConfigurationFingerprint
      !== lock.configuration.fingerprint
    || privateContainedBasis.privateLockFingerprint !== lockFingerprint
    || privateContainedBasis.privateGraphFingerprint !== lock.graphFingerprint
    || privateContainedBasis.basisFingerprint
      !== fingerprintPrivateContainedBasis(privateContainedBasis)) {
    throw new Error(
      'Contained connected review evidence requires one exact private-contained lock basis.'
    );
  }
  const lockReferences = [
    work?.configuration?.lockFingerprint,
    decision?.configurationLockFingerprint,
    proposal?.configurationLockFingerprint
  ];
  const graphReferences = [
    work?.configuration?.graphFingerprint,
    decision?.graphFingerprint,
    proposal?.graphFingerprint
  ];
  const runReferences = [
    work?.checkpoint?.runId,
    decision?.runId,
    proposal?.runId
  ];
  const reviewActions = proposal?.review?.collections
    ?.flatMap((collection) => collection.rows)
    .flatMap((row) => row.actions) || [];
  const heldActions = reviewActions.filter((action) => {
    return action.state === 'held' && action.reasonCode === heldReasonCode;
  });
  const preparedState = (
    work?.state === 'ready-for-review'
      && !Object.hasOwn(work, 'preparationMode')
  ) || (
    work?.state === 'ready-for-acquisition'
      && work?.preparationMode === 'connected-acquisition'
  );
  const completed = preparedState
    && decision?.state === 'ready'
    && proposal?.state === 'ready-for-review'
    && proposal?.review?.privateReview?.state === 'available'
    && proposal?.review?.proposedChanges?.length === 0
    && heldActions.length > 0
    && reviewActions.every((action) => action.state !== 'proposed')
    && proposal?.authority?.state === 'none';
  if (lockReferences.some((fingerprint) => fingerprint !== lockFingerprint)
    || graphReferences.some((fingerprint) => fingerprint !== lock.graphFingerprint)
    || runReferences.some((candidate) => candidate !== runId)
    || work?.configuration?.configurationBasis !== 'private-active') {
    throw new Error(
      'Contained connected review artifacts do not share the exact private execution basis.'
    );
  }
  return baseEvidence({
    id,
    createdAt,
    claimFamily: 'behavior',
    claim: 'One fixture-contained connected acquisition produced a grounded private review whose incomplete write-verification boundary remained mechanically held without creating execution authority.',
    subject: { type: 'run', id: runId, version: null },
    lock,
    evaluator: {
      id: automationId + '.contained-connected-review',
      version: RESOLVER_VERSION,
      level: 'fixture'
    },
    environment: { containment: 'fixture', runtime: DEFAULT_RUNTIME },
    acceptanceCriteria: [
      'One current prepared-work basis produces a deterministic grounded decision and private review proposal.',
      'Every incomplete write action is held under the exact stable reason code.',
      'The sanitized proposal contains no proposed change or reusable execution authority.',
      'No batch, approval request, confirmation, start authorization, checkpoint, provider write, or retry authority is created.',
      'Only normalized provider outputs and fingerprints enter durable state or this evidence record.'
    ],
    result: completed ? 'passed' : 'failed',
    outcomes: [
      { id: 'connected-review.prepared', state: preparedState ? 'passed' : 'failed' },
      {
        id: 'connected-review.decision-grounded',
        state: decision?.state === 'ready' ? 'passed' : 'failed'
      },
      {
        id: 'connected-review.private-material-available',
        state: proposal?.review?.privateReview?.state === 'available' ? 'passed' : 'failed'
      },
      {
        id: 'connected-review.write-authority-held',
        state: completed ? 'passed' : 'failed',
        reasonCode: heldReasonCode
      },
      { id: 'connected-review.private-contained-basis', state: 'passed' },
      { id: 'connected-review.live-provider-effect', state: 'not-applicable' }
    ],
    artifacts: [
      { role: 'prepared-work', id: work.id, fingerprint: work.fingerprint },
      {
        role: 'automation-decision',
        id: decision.id,
        fingerprint: decision.decisionFingerprint
      },
      {
        role: 'automation-proposal',
        id: proposal.id,
        fingerprint: proposal.proposalFingerprint
      }
    ],
    effects: [],
    failures: completed ? [] : ['The contained connected review did not preserve its held boundary.'],
    skipped: [
      'No batch, approval request, confirmation, one-time start, checkpoint, or provider write was created.',
      'No live provider authentication, permission, reachability, write, or health was evaluated.',
      'Complete multi-observation read-back verification is unavailable in Core v2.'
    ],
    limitations: [
      'This proves connected acquisition, grounded decision support, private review, and the exact held boundary against contained normalized responses.',
      'It does not prove connected write readiness, behavior verification, recovery, or health.'
    ],
    privateContainedBasis
  });
}

export function createScenarioExecutionEvidence({
  lock,
  envelope,
  scenario,
  scenarioPath,
  assessment,
  evaluatorId,
  id,
  createdAt
}) {
  const scenarioFingerprint = fingerprintJson(scenario);
  if (envelope.automation.id !== scenario.automation
    || envelope.scenario?.id !== scenario.id
    || envelope.scenario?.path !== scenarioPath
    || envelope.scenario?.fingerprint !== scenarioFingerprint) {
    throw new Error('Scenario evidence requires the exact automation, scenario ID, path, and fingerprint in the run envelope.');
  }
  if (envelope.configurationLock.fingerprint !== fingerprintLock(lock)
    || envelope.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Scenario evidence requires the exact supplied configuration lock and graph.');
  }
  if (envelope.effects.some((effect) => effect.containment !== 'fixture')) {
    throw new Error('Scenario evidence at fixture level rejects non-fixture effects.');
  }
  const observedCapabilityOrder = envelope.effects.map((effect) => effect.capability);
  if (fingerprintJson(assessment.capabilityOrder.expected) !== fingerprintJson(scenario.expected.capabilityOrder)
    || fingerprintJson(assessment.capabilityOrder.observed) !== fingerprintJson(observedCapabilityOrder)
    || fingerprintJson(observedCapabilityOrder) !== fingerprintJson(scenario.expected.capabilityOrder)
    || assessment.capabilityOrder.state !== 'passed') {
    throw new Error('Scenario evidence requires exact declared and observed capability order.');
  }
  const observedEffectModes = Object.fromEntries(Object.keys(scenario.expected.effectModes).sort().map((effect) => [
    effect,
    envelope.effectPolicies[effect]?.mode || 'unknown'
  ]));
  if (fingerprintJson(assessment.effectModes.expected) !== fingerprintJson(scenario.expected.effectModes)
    || fingerprintJson(assessment.effectModes.observed) !== fingerprintJson(observedEffectModes)
    || fingerprintJson(observedEffectModes) !== fingerprintJson(scenario.expected.effectModes)
    || assessment.effectModes.state !== 'passed') {
    throw new Error('Scenario evidence requires exact declared and observed effect modes.');
  }
  const declaredChecks = [
    ...scenario.expected.outcomes.map((checkId) => 'outcome:' + checkId),
    ...scenario.expected.invariants.map((checkId) => 'invariant:' + checkId),
    ...scenario.expected.evidence.map((checkId) => 'evidence:' + checkId)
  ].sort();
  const observedChecks = assessment.checks.map((item) => item.category + ':' + item.id).sort();
  if (new Set(observedChecks).size !== observedChecks.length
    || fingerprintJson(observedChecks) !== fingerprintJson(declaredChecks)) {
    throw new Error('Scenario evidence requires exactly one categorized check for every declared outcome, invariant, and evidence item.');
  }
  const failedChecks = assessment.checks.filter((item) => item.state !== 'passed');
  const derivedResult = failedChecks.length ? 'failed' : 'passed';
  if (assessment.result !== derivedResult) {
    throw new Error('Scenario assessment result does not match its complete declared check set.');
  }
  return baseEvidence({
    id,
    createdAt,
    claimFamily: 'behavior',
    claim: 'The exact declared scenario was executed against fixture providers and assessed from observed capability, policy, outcome, invariant, and evidence states.',
    subject: { type: 'run', id: envelope.id, version: null },
    lock,
    evaluator: {
      id: evaluatorId,
      version: envelope.automation.version,
      level: 'fixture'
    },
    environment: { containment: 'fixture', runtime: DEFAULT_RUNTIME },
    acceptanceCriteria: [
      'The scenario fingerprint and configuration lock exactly match the assessed run.',
      'Observed capability order exactly matches the declared capability order.',
      'Resolved effect policy modes exactly match the declared scenario modes.',
      'Every declared outcome, invariant, and evidence requirement has an observed assessment.'
    ],
    result: derivedResult,
    outcomes: assessment.checks.map((item) => ({
      id: item.id,
      category: item.category,
      state: item.state
    })),
    artifacts: [
      {
        role: 'scenario',
        id: scenario.id,
        path: scenarioPath,
        fingerprint: scenarioFingerprint
      },
      {
        role: 'scenario-assessment',
        runId: envelope.id,
        capabilityOrder: assessment.capabilityOrder,
        effectModes: assessment.effectModes,
        observationFingerprint: assessment.observationFingerprint
      },
      ...assessment.artifacts
    ],
    effects: envelope.effects,
    failures: failedChecks.map((item) => item.category + ':' + item.id),
    skipped: [],
    limitations: [
      'This is deterministic fixture evidence. It does not establish connected credentials, provider reachability, host conformance, or live behavior.'
    ]
  });
}
