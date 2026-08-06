#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson } from '../core/lib/canonical-json.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), '..', '..');
const policyPath = 'soter/kernel/development-governance.json';
const schemaPath = 'soter/contracts/development-governance.schema.json';
const selftestPath = 'soter/kernel/development-governance.selftest.mjs';
const packPath = 'soter/packs/kernel.soter/pack.json';

const policy = readJson(path.join(root, policyPath));
const pack = readJson(path.join(root, packPath));

assert.equal(policy.intent, 'develop');
assert.deepEqual(Object.keys(policy.ownership), [
  'kernel',
  'core',
  'automation',
  'integration',
  'host',
  'configuration'
]);
assert(policy.ownership.kernel.includes('contract-shapes'));
assert(policy.ownership.core.includes('effect-policy'));
assert(policy.ownership.automation.includes('development-outcome-orchestration'));
assert(policy.ownership.integration.includes('provider-translation-and-effects'));
assert(policy.ownership.host.includes('isolated-task-delivery'));
assert(policy.ownership.configuration.includes('workspace-development-policy'));

assert.deepEqual(policy.artifactModel.roles, [
  'definition',
  'implementation',
  'projection',
  'evaluation',
  'fixture'
]);
assert.equal(policy.artifactModel.scaffolding, 'derived-from-governing-contract');
assert(policy.artifactModel.governingContracts.includes(
  'soter://contracts/development-target-material/v1'
));

assert.deepEqual(
  policy.lifecycle.map((item) => item.sequence),
  [1, 2, 3, 4, 5, 6, 7, 8, 9]
);
assert.deepEqual(
  policy.lifecycle.map((item) => item.id),
  ['observe', 'classify', 'reproduce', 'specify', 'implement', 'evaluate', 'review', 'promote', 'monitor']
);
assert.deepEqual(
  policy.instructionProfiles.map((item) => item.id),
  ['exact', 'bounded', 'open']
);
assert.equal(policy.evaluationPolicy.workerContext, 'fresh-and-expectations-withheld');
assert.equal(policy.evaluationPolicy.verdictBasis, 'observable-artifacts-and-effects');
assert.equal(policy.evaluationPolicy.selfReportSufficient, false);
assert.equal(policy.governance.decisionRecords, 'optional-for-ordinary-development');

const contractIds = new Set(
  fs.readdirSync(path.join(root, 'soter/contracts'))
    .filter((name) => name.endsWith('.schema.json'))
    .map((name) => readJson(path.join(root, 'soter/contracts', name)).$id)
);
for (const contractId of policy.artifactModel.governingContracts) {
  assert(contractIds.has(contractId), `missing governing contract ${contractId}`);
}

for (const [artifactPath, role] of [
  [schemaPath, 'definition'],
  ['soter/contracts/development-target-material.schema.json', 'definition'],
  [policyPath, 'definition'],
  [selftestPath, 'evaluation']
]) {
  assert(pack.artifacts.some((artifact) => {
    return artifact.path === artifactPath && artifact.role === role;
  }), `Kernel pack does not govern ${artifactPath}`);
}
assert.deepEqual(pack.capabilities, { requires: [], provides: [] });
assert.deepEqual(pack.authorities, []);
assert.deepEqual(pack.effects, []);

const serialized = JSON.stringify(policy);
for (const forbidden of ['.claude/', 'notion', 'slack', 'gmail']) {
  assert(!serialized.includes(forbidden), `development policy contains provider coupling: ${forbidden}`);
}
assert(!/(?:^|[\s"'])\/(?:[^/\s"']+\/)*[^/\s"']+/.test(serialized), 'development policy contains an absolute workspace path');

process.stdout.write('Development governance selftest passed: ownership, contract-derived scaffolding, present-tense lifecycle, evaluation isolation, privacy, and zero authority remain exact.\n');
