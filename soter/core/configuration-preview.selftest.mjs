import path from 'node:path';
import fs from 'node:fs';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { previewConfiguration } from './configuration-preview.mjs';
import { readJson } from './lib/canonical-json.mjs';
import { fingerprintLock, resolveConfigurationDocument } from './resolve.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findSensitiveKeys(value, at = '$', found = []) {
  const forbidden = new Set(['secretRef', 'secretRefs', 'settings', 'uri', 'input', 'output', 'response']);
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSensitiveKeys(item, at + '[' + index + ']', found));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) found.push(at + '.' + key);
      findSensitiveKeys(child, at + '.' + key, found);
    }
  }
  return found;
}

function main() {
  const root = process.cwd();
  const schema = readJson(path.join(root, 'soter/contracts/configuration-preview.schema.json'));
  const baseline = previewConfiguration({ root, name: 'meeting-intake' });
  const repeated = previewConfiguration({ root, name: 'meeting-intake' });
  assert(validateJsonSchema(baseline, schema).length === 0, 'Baseline configuration preview failed its schema.');
  assert(JSON.stringify(baseline) === JSON.stringify(repeated), 'Configuration preview was not deterministic.');
  assert(baseline.draft.valid && !baseline.draft.changed, 'The unchanged configuration did not preserve its exact lock.');
  assert(baseline.evidenceImpact.state === 'preserved', 'Unchanged configuration unexpectedly invalidated evidence.');

  const changed = previewConfiguration({
    root,
    name: 'meeting-intake',
    draft: { hostAdapter: 'host.claude' }
  });
  assert(validateJsonSchema(changed, schema).length === 0, 'Changed configuration preview failed its schema.');
  assert(changed.draft.valid && changed.draft.changed, 'Valid host change did not produce a changed lock.');
  assert(changed.changes.filter((item) => item.state === 'changed').length === 1,
    'Configuration preview did not scope the exact changed fields.');
  assert(changed.evidenceImpact.state === 'invalidated', 'Changed exact lock did not invalidate exact-lock evidence.');
  assert(changed.apply.supported === false, 'Configuration preview exposed an apply path.');
  const configurationPath = path.join(root, 'soter/configurations/meeting-intake.config.json');
  const configurationText = fs.readFileSync(configurationPath, 'utf8');
  const exactCandidateDocument = readJson(configurationPath);
  exactCandidateDocument.host = {
    id: 'claude',
    adapter: 'host.claude',
    version: '0.1.0',
    reason: 'Preview the same selected Soter systems through the claude host projection.'
  };
  const exactCandidateLock = resolveConfigurationDocument({
    root,
    configPath: configurationPath,
    configuration: exactCandidateDocument
  });
  assert(changed.draft.lockFingerprint === fingerprintLock(exactCandidateLock)
    && changed.draft.graphFingerprint === exactCandidateLock.graphFingerprint,
  'Configuration preview fingerprint did not come from the authoritative candidate resolver.');
  assert(fs.readFileSync(configurationPath, 'utf8') === configurationText,
    'In-memory configuration resolution changed the desired configuration file.');

  const policyConflict = previewConfiguration({
    root,
    name: 'meeting-intake',
    draft: { effectPolicies: { write: 'prohibit' } }
  });
  assert(!policyConflict.draft.valid
    && policyConflict.draft.lockFingerprint === null
    && policyConflict.draft.graphFingerprint === null,
  'Configuration preview exposed a synthetic lock for a Kernel-invalid effect policy.');
  assert(policyConflict.diagnostics.some((item) => {
    return item.code === 'SOTER_CONFIGURATION_PREVIEW_EFFECT_POLICY';
  }), 'Configuration preview did not project the authoritative effect-policy diagnostic.');

  const optionalPack = previewConfiguration({
    root,
    name: 'meeting-intake',
    draft: { addPacks: ['automation.project-pulse'] }
  });
  assert(validateJsonSchema(optionalPack, schema).length === 0, 'Optional-pack preview failed its schema.');
  assert(!optionalPack.draft.valid && !optionalPack.draft.changed,
    'Automation with an unsatisfied source requirement produced a candidate lock.');
  assert(optionalPack.draft.addedPacks.includes('automation.project-pulse'),
    'Optional automation was not identified as an added pack.');
  assert(optionalPack.changes.some((item) => item.category === 'pack'
    && item.subject === 'automation.project-pulse' && item.state === 'changed'),
  'Optional automation did not produce a scoped pack change.');
  assert(optionalPack.draft.lockFingerprint === null && optionalPack.draft.graphFingerprint === null,
    'An incomplete candidate exposed exact fingerprints.');
  assert(optionalPack.diagnostics.some((item) => item.code === 'SOTER_CONFIGURATION_PREVIEW_SOURCE_REQUIREMENT'),
    'Missing Project Pulse policy source did not produce a stable diagnostic.');
  assert(optionalPack.evidenceImpact.state === 'unknown',
    'Incomplete optional-pack selection claimed a determinate evidence impact.');

  const invalid = previewConfiguration({
    root,
    name: 'meeting-intake',
    draft: { hostAdapter: 'host.absent' }
  });
  assert(!invalid.draft.valid && invalid.draft.lockFingerprint === null,
    'Unknown host adapter produced a valid draft lock.');
  assert(invalid.diagnostics.some((item) => item.code === 'SOTER_CONFIGURATION_PREVIEW_HOST'),
    'Unknown host adapter did not produce a scoped diagnostic.');
  assert(invalid.evidenceImpact.state === 'unknown', 'Invalid draft claimed a determinate evidence impact.');

  const sensitive = findSensitiveKeys(changed);
  assert(sensitive.length === 0, 'Sensitive fields reached configuration preview: ' + sensitive.join(', '));
  const serialized = JSON.stringify(changed);
  assert(!serialized.includes('secret-ref.') && !serialized.includes('collection://'),
    'Secret references or authority target values reached configuration preview.');

  console.log('Soter configuration preview selftest passed.');
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
