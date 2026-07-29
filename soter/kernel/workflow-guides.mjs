import { fingerprintJson } from '../core/lib/canonical-json.mjs';

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Return the complete legacy source set whose behavior is represented by one
 * host-guided workflow. The skill source and every evaluation source are one
 * atomic migration basis: candidate documents must all be present and final
 * documents must all be removed. A partial tombstone is never a valid basis.
 */
export function workflowLegacySourceProjection({ definition, guide, evaluations }) {
  const definitionSource = definition?.source;
  const guideSource = guide?.source;
  const cases = evaluations?.cases;
  if (!definitionSource || !guideSource || !Array.isArray(cases)
    || definitionSource.legacyPath !== guideSource.legacyPath
    || definitionSource.legacyFingerprint !== guideSource.legacyFingerprint
    || definitionSource.presence !== guideSource.presence) {
    throw new Error('Workflow definition and guide must bind one exact legacy procedural source.');
  }
  const sources = [{
    kind: 'workflow-guide',
    id: guide.id,
    path: definitionSource.legacyPath,
    fingerprint: definitionSource.legacyFingerprint,
    presence: definitionSource.presence
  }, ...cases.map((testCase) => ({
    kind: 'evaluation-case',
    id: testCase.id,
    path: testCase.source?.legacyPath,
    fingerprint: testCase.source?.legacyFingerprint,
    presence: testCase.source?.presence
  }))].sort((left, right) => compareText(left.path, right.path));
  if (sources.some((source) => {
    return typeof source.path !== 'string'
      || typeof source.fingerprint !== 'string'
      || !['present', 'removed'].includes(source.presence);
  })
    || new Set(sources.map((source) => source.path)).size !== sources.length
    || new Set(sources.map((source) => source.kind + ':' + source.id)).size !== sources.length
    || new Set(sources.map((source) => source.presence)).size !== 1) {
    throw new Error('Workflow legacy source tombstones must be complete, unique, and in one lifecycle state.');
  }
  return sources;
}

export function workflowGuideContentProjection(guide) {
  if (!guide || typeof guide !== 'object' || Array.isArray(guide)) {
    throw new Error('Workflow guide content fingerprint requires one guide object.');
  }
  const {
    contentFingerprint: _contentFingerprint,
    status: _status,
    ...content
  } = guide;
  return content;
}

export function fingerprintWorkflowGuideContent(guide) {
  return fingerprintJson(workflowGuideContentProjection(guide));
}

export function workflowGuideContentFingerprintMatches(guide) {
  return typeof guide?.contentFingerprint === 'string'
    && guide.contentFingerprint === fingerprintWorkflowGuideContent(guide);
}

export function workflowEvaluationCaseProjection(testCase) {
  if (!testCase || typeof testCase !== 'object' || Array.isArray(testCase)) {
    throw new Error('Workflow evaluation case fingerprint requires one case object.');
  }
  return {
    id: testCase.id,
    sequence: testCase.sequence,
    kind: testCase.kind,
    stimulus: structuredClone(testCase.stimulus),
    expectedObservations: structuredClone(testCase.expectedObservations),
    prohibitedOutcomes: structuredClone(testCase.prohibitedOutcomes)
  };
}

export function fingerprintWorkflowEvaluationCase(testCase) {
  return fingerprintJson(workflowEvaluationCaseProjection(testCase));
}

export function workflowEvaluationCriteria(testCase) {
  if (!testCase || typeof testCase !== 'object' || Array.isArray(testCase)
    || !Array.isArray(testCase.expectedObservations)
    || !Array.isArray(testCase.prohibitedOutcomes)) {
    throw new Error('Workflow evaluation criteria require one complete evaluation case.');
  }
  return [
    ...testCase.expectedObservations.map((_item, index) => ({
      id: `${testCase.id}.expected.${index + 1}`,
      kind: 'expected',
      sequence: index + 1
    })),
    ...testCase.prohibitedOutcomes.map((_item, index) => ({
      id: `${testCase.id}.prohibited.${index + 1}`,
      kind: 'prohibited',
      sequence: index + 1
    }))
  ];
}

export function workflowEvaluationVerdict(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new Error('Workflow evaluation verdict requires criterion observations.');
  }
  let passed = true;
  let unknown = false;
  for (const criterion of criteria) {
    if (criterion?.kind === 'expected') {
      passed = passed && criterion.state === 'observed';
    } else if (criterion?.kind === 'prohibited') {
      passed = passed && criterion.state === 'not-observed';
    } else {
      throw new Error('Workflow evaluation verdict received an unknown criterion kind.');
    }
    unknown = unknown || criterion.state === 'unknown';
  }
  return passed ? 'passed' : unknown ? 'blocked' : 'failed';
}

export function workflowEvaluationRunPlan({ definition, evaluations }) {
  const baselineId = evaluations?.evaluationPolicy?.baselineCaseId;
  const cases = evaluations?.cases;
  const baseline = Array.isArray(cases)
    ? cases.find((testCase) => testCase.id === baselineId)
    : null;
  if (typeof definition?.id !== 'string' || !definition.id.startsWith('automation.')
    || !baseline || baselineId !== 'happy-path'
    || evaluations.evaluationPolicy?.baselineOutcome !== 'observed-not-gating') {
    throw new Error('Workflow evaluation run plan requires one exact non-gating happy-path baseline.');
  }
  const slug = definition.id.slice('automation.'.length);
  return [baseline, ...cases].map((testCase, index) => {
    const arm = index === 0 ? 'baseline' : 'guided';
    return {
      id: arm === 'baseline'
        ? `evaluation-run.${slug}.baseline`
        : `evaluation-run.${slug}.guided.${testCase.id}`,
      sequence: index + 1,
      caseId: testCase.id,
      caseFingerprint: fingerprintWorkflowEvaluationCase(testCase),
      stimulusFingerprint: fingerprintJson(testCase.stimulus),
      arm,
      guideState: arm === 'baseline' ? 'withheld' : 'candidate',
      criteria: workflowEvaluationCriteria(testCase)
    };
  });
}

export function inspectWorkflowEvaluationRunSet({ definition, evaluations, runs }) {
  let expected;
  try {
    expected = workflowEvaluationRunPlan({ definition, evaluations });
  } catch {
    return {
      coverageComplete: false,
      verdictsConsistent: false,
      guidedPassed: false,
      inputBoundaryPreserved: false,
      prohibitedOutcomesObserved: false
    };
  }
  const observed = Array.isArray(runs) ? runs : [];
  const unique = (values) => new Set(values).size === values.length;
  let coverageComplete = observed.length === expected.length
    && unique(observed.map((run) => run?.id))
    && unique(observed.map((run) => run?.worker?.id))
    && unique(observed.map((run) => run?.worker?.workerFingerprint))
    && unique(observed.map((run) => run?.worker?.dispatchFingerprint))
    && unique(observed.map((run) => run?.worker?.transcriptFingerprint))
    && unique(observed.map((run) => run?.judgment?.id));
  let verdictsConsistent = true;
  let guidedPassed = true;
  let inputBoundaryPreserved = true;
  let prohibitedOutcomesObserved = false;
  for (let index = 0; index < observed.length; index += 1) {
    const run = observed[index];
    const planned = expected[index];
    const criteria = Array.isArray(run?.judgment?.criteria) ? run.judgment.criteria : [];
    const criterionBasis = criteria.map(({ id, kind, sequence }) => ({ id, kind, sequence }));
    const runBasis = run && {
      id: run.id,
      sequence: run.sequence,
      caseId: run.caseId,
      caseFingerprint: run.caseFingerprint,
      stimulusFingerprint: run.stimulusFingerprint,
      arm: run.arm,
      guideState: run.guideState
    };
    coverageComplete = coverageComplete
      && fingerprintJson(runBasis) === fingerprintJson(planned && {
        id: planned.id,
        sequence: planned.sequence,
        caseId: planned.caseId,
        caseFingerprint: planned.caseFingerprint,
        stimulusFingerprint: planned.stimulusFingerprint,
        arm: planned.arm,
        guideState: planned.guideState
      })
      && fingerprintJson(criterionBasis) === fingerprintJson(planned?.criteria || []);
    let exactVerdict = null;
    try {
      exactVerdict = workflowEvaluationVerdict(criteria);
    } catch {
      verdictsConsistent = false;
    }
    verdictsConsistent = verdictsConsistent && run?.judgment?.verdict === exactVerdict;
    inputBoundaryPreserved = inputBoundaryPreserved
      && run?.worker?.expectationsIncluded === false
      && run?.worker?.answerKeyAccess === 'not-observed';
    prohibitedOutcomesObserved = prohibitedOutcomesObserved || criteria.some((criterion) => {
      return criterion.kind === 'prohibited' && criterion.state === 'observed';
    });
    if (run?.arm === 'guided') {
      guidedPassed = guidedPassed
        && run?.worker?.state === 'passed'
        && exactVerdict === 'passed'
        && run?.judgment?.verdict === 'passed';
    }
  }
  return {
    coverageComplete,
    verdictsConsistent,
    guidedPassed,
    inputBoundaryPreserved,
    prohibitedOutcomesObserved
  };
}

// This is the behavior subject evaluated by host workers. It intentionally omits
// lifecycle state, activation evidence, legacy-source presence, and relational
// document fingerprints so the subject survives candidate -> active promotion
// and source tombstoning. Every field that can change the worker instructions,
// intended behavior, safeguards, stimulus, or judge criteria remains sealed.
export function workflowEvaluatedSubjectProjection({ definition, guide, evaluations }) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)
    || !guide || typeof guide !== 'object' || Array.isArray(guide)
    || !evaluations || typeof evaluations !== 'object' || Array.isArray(evaluations)) {
    throw new Error('Workflow evaluated subject requires one definition, guide, and evaluation set.');
  }
  return {
    contract: 'soter://subjects/workflow-evaluation/v1',
    workflow: {
      id: definition.id,
      version: definition.version,
      title: definition.title,
      summary: definition.summary,
      ownership: structuredClone(definition.ownership),
      intent: structuredClone(definition.intent),
      procedure: structuredClone(definition.procedure),
      safeguards: structuredClone(definition.safeguards),
      potentialEffects: structuredClone(definition.potentialEffects),
      effectBoundary: structuredClone(definition.lifecycle?.effectBoundary)
    },
    guide: {
      id: guide.id,
      skill: structuredClone(guide.skill),
      authority: structuredClone(guide.authority),
      stepDetails: structuredClone(guide.stepDetails),
      verification: structuredClone(guide.verification),
      gotchas: structuredClone(guide.gotchas),
      references: structuredClone(guide.references),
      privacy: structuredClone(guide.privacy),
      limitations: structuredClone(guide.limitations)
    },
    evaluation: {
      id: evaluations.id,
      workflow: evaluations.workflow,
      version: evaluations.version,
      cases: evaluations.cases.map(workflowEvaluationCaseProjection),
      policy: {
        freshWorkerPerCase: evaluations.evaluationPolicy?.freshWorkerPerCase,
        expectationsWithheld: evaluations.evaluationPolicy?.expectationsWithheld,
        baselineRequired: evaluations.evaluationPolicy?.baselineRequired,
        baselineCaseId: evaluations.evaluationPolicy?.baselineCaseId,
        baselineOutcome: evaluations.evaluationPolicy?.baselineOutcome,
        supportedHosts: structuredClone(evaluations.evaluationPolicy?.supportedHosts)
      }
    }
  };
}

export function fingerprintWorkflowEvaluatedSubject(subject) {
  return fingerprintJson(workflowEvaluatedSubjectProjection(subject));
}
