import assert from 'node:assert/strict';
import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { readJson } from './lib/canonical-json.mjs';

const root = process.cwd();
const schema = readJson(path.join(root, 'soter/contracts/automation-input.schema.json'));
const base = {
  $contract: 'soter://contracts/automation-input/v1', contractVersion: '1.0.0',
  id: 'input.automation.selftest', automation: 'automation.selftest', version: '1.0.0',
  additionalInputs: false
};
const field = { id: 'subject', label: 'Subject', description: 'A sufficiently descriptive operator field.', required: true, exposure: 'identifier' };
const valid = [
  { ...field, type: 'reference', reference: { subject: 'projects.records.project', authorityRole: 'instance' } },
  { ...field, type: 'enum', options: ['open', 'all'] },
  { ...field, type: 'string', constraints: { minLength: 2 } },
  {
    ...field,
    type: 'string-list',
    constraints: { minItems: 1, maxItems: 4, itemMinLength: 2, itemMaxLength: 40 },
    examples: [['alpha', 'beta']]
  },
  { ...field, type: 'boolean' },
  { ...field, type: 'date', examples: ['2026-07-16'] },
  { ...field, type: 'uri', examples: ['https://example.invalid/item'] }
];
for (const candidate of valid) {
  assert.deepEqual(validateJsonSchema({ ...base, fields: [candidate] }, schema), []);
}
for (const candidate of [
  { ...field, type: 'reference' },
  { ...field, type: 'enum' },
  { ...field, type: 'enum', options: [] },
  { ...field, type: 'string-list' },
  { ...field, type: 'string-list', constraints: { minItems: 0, maxItems: 2 }, examples: ['alpha'] },
  { ...field, type: 'boolean', options: ['true'] },
  { ...field, type: 'date', reference: { subject: 'projects.records.project', authorityRole: 'instance' } },
  { ...field, type: 'uri', constraints: { minLength: 3 } }
]) {
  assert(validateJsonSchema({ ...base, fields: [candidate] }, schema).length > 0);
}

process.stdout.write('Automation input contract self-test passed.\n');
