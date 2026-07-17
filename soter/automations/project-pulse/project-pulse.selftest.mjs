import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { observeProjectPulseContext } from './scenario.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const snapshot = JSON.parse(fs.readFileSync(
  path.join(root, 'soter/fixtures/meeting-intake/contained.context.json'),
  'utf8'
));
const policyEntry = snapshot.entries.find((entry) => entry.authority === 'authority.crm.definition');
policyEntry.value.records = [{
  id: 'fixture-policy-id-is-not-domain-authority',
  type: 'policy',
  version: 1,
  fields: {
    progressRequiresPromotedTasks: true,
    milestoneWorkItemsRemainDistinct: true,
    healthMustBeExplained: true,
    writesRequireConfirmation: true
  }
}];

const projectEntry = snapshot.entries.find((entry) => entry.authority === 'authority.crm.instance');
projectEntry.value.records = [{ id: 'project.fixture', type: 'project', version: 1, fields: {} }];
assert.doesNotThrow(() => observeProjectPulseContext(snapshot, { projectId: 'project.fixture' }));

const drifted = structuredClone(snapshot);
drifted.entries.find((entry) => entry.authority === 'authority.crm.definition')
  .value.records[0].fields.healthMustBeExplained = false;
assert.throws(
  () => observeProjectPulseContext(drifted, { projectId: 'project.fixture' }),
  /policy assertions are missing or changed: healthMustBeExplained/
);

process.stdout.write('Project Pulse policy enforcement self-test passed.\n');
