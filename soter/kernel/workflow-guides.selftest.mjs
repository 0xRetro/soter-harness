import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprintJson } from '../core/lib/canonical-json.mjs';
import {
  fingerprintWorkflowEvaluatedSubject,
  fingerprintWorkflowEvaluationCase,
  fingerprintWorkflowGuideContent,
  inspectWorkflowEvaluationRunSet,
  workflowEvaluationCriteria,
  workflowEvaluationRunPlan,
  workflowEvaluationVerdict,
  workflowGuideContentFingerprintMatches
} from './workflow-guides.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowRoot = path.join(root, 'soter/automations');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hashFile(file) {
  return fingerprintJson(readJson(file));
}

const slugs = fs.readdirSync(workflowRoot).filter((slug) => {
  return fs.existsSync(path.join(workflowRoot, slug, 'definition.json'));
}).sort();

assert.deepEqual(slugs, [
  'auditing-a-schema-doc',
  'authoring-a-policy-standard',
  'forge',
  'promoting-pieces',
  'reviewing-forge-output',
  'running-evals',
  'validating-resources'
]);

for (const slug of slugs) {
  const base = path.join(workflowRoot, slug);
  const definitionPath = path.join(base, 'definition.json');
  const guidePath = path.join(base, 'guide.json');
  const evaluationPath = path.join(base, 'evaluations.json');
  const definition = readJson(definitionPath);
  const guide = readJson(guidePath);
  const evaluations = readJson(evaluationPath);

  assert.equal(definition.id, `automation.${slug}`);
  assert.equal(definition.lifecycle.state, 'active-host-guided');
  assert.equal(definition.lifecycle.reasonCode, 'WORKFLOW_HOST_GUIDANCE_ACTIVE');
  assert.equal(definition.lifecycle.delivery, 'host-skill');
  assert.deepEqual([...definition.lifecycle.development.supportedHosts].sort(), ['claude', 'codex']);
  assert.equal(definition.lifecycle.effectBoundary.authority, 'development-request-only');
  assert.equal(definition.lifecycle.effectBoundary.providerRead, 'separate-authority');
  assert.equal(definition.lifecycle.effectBoundary.providerWrite, 'separate-authority');

  assert.equal(guide.id, `workflow-guide.${slug}`);
  assert.equal(guide.workflow.id, definition.id);
  assert.equal(guide.workflow.version, definition.version);
  assert.equal(guide.workflow.definitionFingerprint, hashFile(definitionPath));
  assert.equal(guide.workflow.evaluationSetFingerprint, hashFile(evaluationPath));
  assert(workflowGuideContentFingerprintMatches(guide));
  assert.equal(guide.contentFingerprint, fingerprintWorkflowGuideContent(guide));
  assert.equal(guide.status.state, 'active');
  assert.equal(guide.status.delivery, 'host-skill');
  assert.equal(guide.authority.executionAuthority, 'none');
  assert.equal(guide.authority.effectAuthority, 'none');
  assert.equal(guide.authority.approvalAuthority, 'none');
  assert.equal(guide.authority.providerTransactionAuthority, 'none');

  assert.equal(evaluations.workflow, definition.id);
  assert.equal(evaluations.version, definition.version);
  assert.equal(evaluations.lifecycle.state, 'active-host-guided');
  assert.equal(evaluations.evaluationPolicy.baselineCaseId, 'happy-path');
  assert.equal(evaluations.evaluationPolicy.freshWorkerPerCase, true);
  assert.equal(evaluations.evaluationPolicy.expectationsWithheld, true);
  assert.deepEqual([...evaluations.evaluationPolicy.supportedHosts].sort(), ['claude', 'codex']);

  assert.equal(new Set(evaluations.cases.map((item) => item.id)).size, evaluations.cases.length);
  assert.deepEqual(evaluations.cases.map((item) => item.sequence),
    evaluations.cases.map((_item, index) => index + 1));
  assert(evaluations.cases.some((item) => item.kind === 'happy-path'));
  assert(evaluations.cases.some((item) => item.kind === 'pressure'));
  for (const testCase of evaluations.cases) {
    assert(testCase.expectedObservations.length > 0);
    assert(testCase.prohibitedOutcomes.length > 0);
    assert.match(fingerprintWorkflowEvaluationCase(testCase), /^sha256:[a-f0-9]{64}$/);
    assert.equal(workflowEvaluationCriteria(testCase).length,
      testCase.expectedObservations.length + testCase.prohibitedOutcomes.length);
  }

  const runPlan = workflowEvaluationRunPlan({ definition, evaluations });
  assert.equal(runPlan.length, evaluations.cases.length + 1);
  assert.equal(runPlan[0].arm, 'baseline');
  assert.equal(runPlan[0].guideState, 'withheld');
  assert.equal(runPlan[1].arm, 'guided');
  assert.match(fingerprintWorkflowEvaluatedSubject({ definition, guide, evaluations }),
    /^sha256:[a-f0-9]{64}$/);

}

const passedCriteria = [
  { id: 'case.expected.1', kind: 'expected', sequence: 1, state: 'observed' },
  { id: 'case.prohibited.1', kind: 'prohibited', sequence: 1, state: 'not-observed' }
];
assert.equal(workflowEvaluationVerdict(passedCriteria), 'passed');
assert.equal(workflowEvaluationVerdict([
  { ...passedCriteria[0], state: 'unknown' },
  passedCriteria[1]
]), 'blocked');
assert.equal(workflowEvaluationVerdict([
  passedCriteria[0],
  { ...passedCriteria[1], state: 'observed' }
]), 'failed');
assert.deepEqual(inspectWorkflowEvaluationRunSet({ definition: {}, evaluations: {}, runs: [] }), {
  coverageComplete: false,
  verdictsConsistent: false,
  guidedPassed: false,
  inputBoundaryPreserved: false,
  prohibitedOutcomesObserved: false
});

process.stdout.write(
  'Workflow guides selftest passed: seven active present-tense workflows, exact relational fingerprints, request-scoped authority, happy-path and pressure coverage, prohibited outcomes, and deterministic run planning passed.\n'
);
