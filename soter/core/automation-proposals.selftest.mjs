import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson } from './lib/canonical-json.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function selftestAutomationProposals(root = defaultRoot) {
  const review = readJson(path.join(root, 'soter/contracts/automation-review.schema.json'));
  const proposal = readJson(path.join(root, 'soter/contracts/automation-proposal.schema.json'));
  const material = readJson(
    path.join(root, 'soter/contracts/automation-proposal-material.schema.json')
  );
  const change = review.properties.proposedChanges.items;
  assert.equal(review.additionalProperties, false);
  assert.equal(change.additionalProperties, false);
  assert(!Object.hasOwn(change.properties, 'before'));
  assert(!Object.hasOwn(change.properties, 'after'));
  assert.equal(proposal.additionalProperties, false);
  assert.equal(proposal.properties.privacy.properties.privateValuesIncluded.const, false);
  assert.equal(proposal.properties.privacy.properties.workspaceInspectionIncluded.const, false);
  assert.equal(material.additionalProperties, false);
  assert.equal(material.properties.privacy.properties.projection.const, 'selected-proposal-only');
  assert.equal(material.properties.authority.properties.state.const, 'none');
  process.stdout.write('Automation proposal selftest passed.\n');
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestAutomationProposals().catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
