import path from 'node:path';

import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { validateJsonSchema } from '../../kernel/verify.mjs';

const POLICY_CONTRACT = 'soter://contexts/process/process-review-policy/v1';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactStrings(value, label, maximum = 100) {
  if (!Array.isArray(value)
    || value.length > maximum
    || value.some((item) => typeof item !== 'string' || !item || item.length > 500)
    || new Set(value).size !== value.length) {
    throw new Error(label + ' must be one bounded unique string list.');
  }
  return value;
}

export function loadProcessReviewPolicy(root) {
  const schema = readJson(path.join(root, 'soter', 'contracts', 'process-review-policy.schema.json'));
  const policy = readJson(path.join(root, 'soter', 'contexts', 'process', 'process-review.policy.json'));
  const failures = validateJsonSchema(policy, schema);
  if (policy.$contract !== POLICY_CONTRACT || failures.length) {
    throw new Error('Process review policy does not satisfy its Context contract'
      + (failures.length
        ? ': ' + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; ')
        : '.'));
  }
  return policy;
}

export function assertProcessReviewPolicySelection(output, policy) {
  const records = (output?.records || []).filter((record) => record.type === 'process-review-policy');
  if (records.length !== 1 || output.records.length !== 1
    || fingerprintJson(records[0].fields) !== fingerprintJson({ name: policy.name })) {
    throw new Error('Process review requires one exact normalized policy-selection record.');
  }
  return { record: records[0], definitionFingerprint: fingerprintJson(policy) };
}

function oneRecord(output, type, id, label) {
  const records = (output?.records || []).filter((record) => record.type === type && record.id === id);
  if (records.length !== 1 || output.records.length !== 1) {
    throw new Error(label + ' requires one exact normalized ' + type + ' record.');
  }
  return records[0];
}

export function assertProcessReviewSources({
  processOutput,
  policyOutput,
  runOutput,
  schemaOutput,
  processUri,
  includeLatestRun
}) {
  const process = oneRecord(processOutput, 'process', processUri, 'Process review target');
  const policyUris = exactStrings(process.fields?.relatedPolicyUris || [], 'Related policy identities');
  const targetTypes = exactStrings(process.fields?.writeTargetTypes || [], 'Write target types');
  const declaredClaims = exactStrings(process.fields?.declaredClaims || [], 'Process declared claims');
  if (!policyUris.length || targetTypes.length !== 1) {
    throw new Error('Process review target must declare exact policy identities and one bounded write-target schema.');
  }
  const policies = policyOutput?.records || [];
  if (policies.length !== policyUris.length
    || policies.some((record) => record.type !== 'process-policy-standard')
    || fingerprintJson(policies.map((record) => record.id).sort(compareCodepoint))
      !== fingerprintJson([...policyUris].sort(compareCodepoint))) {
    throw new Error('Process review policy source set does not match the target definition.');
  }
  for (const standard of policies) {
    exactStrings(standard.fields?.requiredClaims || [], 'Policy required claims');
    if (!(standard.fields?.relatedProcessUris || []).includes(processUri)) {
      throw new Error('Process review policy source is not related to the exact target process.');
    }
  }
  if (!schemaOutput?.schema || !targetTypes.includes(schemaOutput.schema.recordType)) {
    throw new Error('Process review schema observation does not match one declared write target.');
  }
  const expectedSchemaFingerprint = fingerprintJson({
    recordType: schemaOutput.schema.recordType,
    fields: schemaOutput.schema.fields
  });
  if (schemaOutput.schema.fingerprint !== expectedSchemaFingerprint) {
    throw new Error('Process review schema observation fingerprint is invalid.');
  }
  const runs = runOutput?.records || [];
  if (includeLatestRun && runs.length !== 1) {
    throw new Error('Process review requires one exact latest run when run evidence is requested.');
  }
  if (!includeLatestRun && runs.length !== 0) {
    throw new Error('Process review received undeclared run evidence.');
  }
  for (const run of runs) {
    if (run.type !== 'process-run' || run.fields?.processUri !== processUri) {
      throw new Error('Process review run evidence is not bound to the exact target process.');
    }
    exactStrings(run.fields?.observedClaims || [], 'Run observed claims');
  }
  return { process, policies, runs, declaredClaims, targetTypes };
}

export function evaluateProcessReview({ policy, sources, fixRequested }) {
  const findings = [];
  const declared = new Set(sources.declaredClaims);
  const observed = new Set(sources.runs.flatMap((run) => run.fields.observedClaims || []));
  const verifiedOutcomeObserved = sources.runs.some((run) => {
    return run.fields.state === 'Completed'
      && (run.fields.observedClaims || []).includes('destination.marked-verified');
  });
  const requirements = sources.policies.flatMap((standard) => {
    return (standard.fields.requiredClaims || []).map((claim) => ({
      claim,
      policyId: standard.id,
      policyFingerprint: fingerprintJson(standard)
    }));
  }).sort((left, right) => compareCodepoint(left.claim, right.claim));
  for (const requirement of requirements) {
    if (declared.has(requirement.claim)) continue;
    const reproduced = verifiedOutcomeObserved && !observed.has(requirement.claim);
    findings.push({
      id: 'finding.missing-required-claim.' + String(findings.length + 1).padStart(2, '0'),
      severity: reproduced ? 'critical' : 'should-fix',
      lens: reproduced ? 'adversarial' : 'completeness',
      reasonCode: reproduced
        ? 'PROCESS_CRITICAL_REQUIRED_CONTROL_REPRODUCED'
        : 'PROCESS_REQUIRED_CONTROL_MISSING',
      title: reproduced
        ? 'A success state is reachable without one policy-required control'
        : 'The process definition omits one policy-required control',
      finding: 'The process definition does not declare the required claim ' + requirement.claim + '.',
      reproduction: reproduced
        ? 'The exact completed run reached the verified outcome without observing the required claim.'
        : 'The missing claim is reproduced against the exact process and policy sources; no qualifying run proves exploitation.',
      proposedFix: 'Add an operator-checkable work-item for the required claim, then separately review the definition change and re-run this review.',
      sourceIds: [sources.process.id, requirement.policyId, ...sources.runs.map((run) => run.id)],
      sourceFingerprint: fingerprintJson({
        process: fingerprintJson(sources.process),
        policy: requirement.policyFingerprint,
        runs: sources.runs.map((run) => fingerprintJson(run))
      }),
      reproduced,
      disposition: fixRequested ? 'reported-fix-request-withheld' : 'reported-for-decision'
    });
  }
  if (/do not independently re-read the full address/i.test(String(sources.process.body || ''))) {
    findings.push({
      id: 'finding.operator-instruction-undermines-control',
      severity: 'should-fix',
      lens: 'operator-execution',
      reasonCode: 'PROCESS_OPERATOR_INSTRUCTION_CONTRADICTS_POLICY',
      title: 'The operator instruction explicitly bypasses the policy control',
      finding: 'The exact process body tells the operator not to perform the independent full-address read required by policy.',
      reproduction: 'The contradiction is present in the exact process and policy bodies.',
      proposedFix: 'Replace the contradictory instruction with an exact independent full-address comparison work-item after human approval.',
      sourceIds: [sources.process.id, ...sources.policies.map((standard) => standard.id)],
      sourceFingerprint: fingerprintJson({
        process: fingerprintJson(sources.process),
        policies: sources.policies.map((standard) => fingerprintJson(standard))
      }),
      reproduced: true,
      disposition: fixRequested ? 'reported-fix-request-withheld' : 'reported-for-decision'
    });
  }
  const rank = new Map(policy.severityOrder.map((severity, index) => [severity, index]));
  findings.sort((left, right) => (rank.get(left.severity) - rank.get(right.severity))
    || compareCodepoint(left.id, right.id));
  if (!findings.length || findings.length > policy.maximumFindings
    || findings.some((finding) => finding.severity === 'critical' && !finding.reproduced)) {
    throw new Error('Process review findings are incomplete or contain an unverified critical.');
  }
  return findings;
}
