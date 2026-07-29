#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertTrackedConfigurationTemplatesPortable,
  CONFIGURATION_TEMPLATE_FIXTURE_PREFIX,
  inspectTrackedConfigurationTemplates
} from './configuration-template-portability.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), '..', '..');

function safeTemplate() {
  return {
    $contract: 'soter://contracts/configuration/v1',
    contractVersion: '1.0.0',
    name: 'portable-selftest',
    base: { kernel: 'kernel.soter', core: 'core.runtime' },
    packs: [],
    bindings: [{
      capability: 'tasks.records.read',
      providerPack: 'integration.notion',
      authorities: ['authority.tasks.instance'],
      secretRef: 'secret-ref.notion',
      reason: 'Stable identifiers and secret references are portable metadata.'
    }],
    sources: [{
      id: 'source.policy.tasks',
      capability: 'tasks.records.read',
      authority: 'authority.tasks.definition',
      input: { recordTypes: ['task-work-policy'], ids: ['policy.tasks'], limit: 2 },
      readiness: { mode: 'probe-read', reason: 'The exact source must be observed before connected use.' },
      consumers: [{
        pack: 'automation.task-capture',
        purpose: 'task-policy',
        subjects: ['task-capture'],
        reason: 'The stable policy identifier is not a raw provider record identity.'
      }],
      reason: 'Stable domain identifiers remain portable and provider-neutral.'
    }],
    authorities: [
      {
        id: 'authority.tasks.definition',
        role: 'definition',
        subject: 'tasks.records',
        uri: 'soter://context/tasks',
        reason: 'Portable Context identity is not provider authority.'
      },
      {
        id: 'authority.tasks.instance',
        role: 'instance',
        subject: 'tasks.records',
        uri: CONFIGURATION_TEMPLATE_FIXTURE_PREFIX + 'notion/collection/tasks',
        reason: 'The checked-in template uses an unmistakable deterministic fixture identity.'
      },
      {
        id: 'authority.run.evidence',
        role: 'evidence',
        subject: 'runtime.runs',
        uri: 'soter-state://runs',
        reason: 'The URI names a portable private-state family, not a private path or value.'
      }
    ],
    effectPolicies: {},
    secretRefs: [{ id: 'secret-ref.notion', provider: 'host', key: 'NOTION_OAUTH' }],
    host: {
      id: 'codex',
      adapter: 'host.codex',
      version: '0.3.1',
      reason: 'The host contract version remains exact.'
    },
    settings: {
      'integration.notion': {
        targets: {
          tasks: CONFIGURATION_TEMPLATE_FIXTURE_PREFIX + 'notion/collection/tasks'
        }
      },
      'integration.gmail': {
        selfAddresses: ['operator@soter.example']
      }
    }
  };
}

function withRoot(callback) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-config-portability-'));
  fs.mkdirSync(path.join(temporary, 'soter', 'configurations'), { recursive: true });
  try {
    return callback(temporary);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function writeTemplate(temporary, document) {
  fs.writeFileSync(
    path.join(temporary, 'soter', 'configurations', 'portable-selftest.config.json'),
    JSON.stringify(document, null, 2) + '\n'
  );
}

function expectViolation(mutate, code) {
  withRoot((temporary) => {
    const document = safeTemplate();
    mutate(document);
    writeTemplate(temporary, document);
    const inspection = inspectTrackedConfigurationTemplates(temporary);
    assert.equal(inspection.state, 'blocked');
    assert(
      inspection.violations.some((item) => item.code === code),
      `expected ${code}; got ${inspection.violations.map((item) => item.code).join(', ')}`
    );
  });
}

const repositoryInspection = assertTrackedConfigurationTemplatesPortable(root);
assert(repositoryInspection.templateCount > 0);
assert(repositoryInspection.templates.every((item) => {
  return item.startsWith('soter/configurations/') && item.endsWith('.config.json');
}));

withRoot((temporary) => {
  writeTemplate(temporary, safeTemplate());
  fs.mkdirSync(path.join(temporary, '.soter', 'state', 'configurations'), { recursive: true });
  fs.writeFileSync(
    path.join(temporary, '.soter', 'state', 'configurations', 'private.json'),
    JSON.stringify({
      accountId: 'T123456789',
      databaseId: '0123456789abcdef0123456789abcdef',
      email: 'operator@real-company.com',
      optionMappings: [{
        mapping: 'mapping.integration.notion.tasks-records',
        recordType: 'task',
        field: 'status',
        mode: 'exact-bijection',
        entries: [{ portable: 'To Do', provider: 'Workspace-only queued state' }]
      }],
      token: 'xoxb-private-runtime-value'
    })
  );
  const inspection = assertTrackedConfigurationTemplatesPortable(temporary);
  assert.equal(inspection.templateCount, 1);
  assert.deepEqual(inspection.templates, [
    'soter/configurations/portable-selftest.config.json'
  ]);
});

expectViolation((document) => {
  document.settings['integration.notion'].targets.tasks =
    'collection://01234567-89ab-cdef-0123-456789abcdef';
}, 'TRACKED_CONFIGURATION_FIXTURE_NAMESPACE');

expectViolation((document) => {
  document.settings['integration.notion'].optionMappings = [{
    mapping: 'mapping.integration.notion.tasks-records',
    recordType: 'task',
    field: 'status',
    mode: 'exact-bijection',
    entries: [{
      portable: 'To Do',
      provider: 'Workspace-only queued state'
    }]
  }];
}, 'TRACKED_CONFIGURATION_PROVIDER_OPTION_MAPPING');

expectViolation((document) => {
  document.authorities[1].uri = 'notion://workspace/0123456789abcdef0123456789abcdef';
}, 'TRACKED_CONFIGURATION_PROVIDER_URI');

expectViolation((document) => {
  document.sources[0].input.ids = ['0123456789abcdef0123456789abcdef'];
}, 'TRACKED_CONFIGURATION_PROVIDER_IDENTIFIER');

expectViolation((document) => {
  document.sources[0].input.ids = [
    'https://www.notion.so/0123456789abcdef0123456789abcdef'
  ];
}, 'TRACKED_CONFIGURATION_PROVIDER_URI');

expectViolation((document) => {
  document.authorities[1].uri = 'slack://T123456789/C123456789';
}, 'TRACKED_CONFIGURATION_PROVIDER_URI');

expectViolation((document) => {
  document.settings['integration.gmail'].selfAddresses = ['operator@real-company.com'];
}, 'TRACKED_CONFIGURATION_EMAIL_DOMAIN');

expectViolation((document) => {
  document.settings['integration.slack'] = { workspaceId: 'T123456789' };
}, 'TRACKED_CONFIGURATION_PROVIDER_IDENTIFIER');

expectViolation((document) => {
  document.settings['integration.slack'] = { token: 'xoxb-1234567890-private' };
}, 'TRACKED_CONFIGURATION_PRIVATE_VALUE_FIELD');

expectViolation((document) => {
  document.settings['integration.local'] = { sourceRoot: '/Users/operator/private-workspace' };
}, 'TRACKED_CONFIGURATION_ABSOLUTE_PATH');

expectViolation((document) => {
  document.authorities[1].uri = 'soter-fixture://not-reserved/provider';
}, 'TRACKED_CONFIGURATION_FIXTURE_NAMESPACE');

process.stdout.write(
  'Tracked configuration portability selftest passed: live Notion targets and option mappings, Slack, email, credential, and path values are rejected; portable URIs, stable identifiers, .example identities, and private override isolation remain exact.\n'
);
