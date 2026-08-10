#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptFile), '..', '..');

export const CONFIGURATION_TEMPLATE_FIXTURE_PREFIX =
  'soter-fixture://configuration-template/';

const CONFIGURATION_TEMPLATE_FIXTURE_RE =
  /^soter-fixture:\/\/configuration-template\/[a-z0-9]+(?:[./-][a-z0-9]+)*$/;
const CANONICAL_VERSION_RE =
  /^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)$/;
const PORTABLE_URI_PREFIXES = [
  'soter://',
  'soter-pack://',
  'soter-state://'
];
const SECRET_VALUE_RE = /\b(?:secret_[A-Za-z0-9]{24,}|ntn_[A-Za-z0-9]{24,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{24,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;
const EMAIL_RE = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Z0-9.-]+\.[A-Z]{2,}|[A-Z0-9.-]+\.example)\b/gi;
const UNIX_ABSOLUTE_PATH_RE = /(?:^|[\s"'(])\/(?:[^\s/"'<>:]+(?:\/[^\s"'<>:]*)*)/u;
const WINDOWS_ABSOLUTE_PATH_RE = /(?:^|[\s"'(])[A-Za-z]:[\\/][^\s"'<>]*/u;
const RAW_NOTION_ID_RE = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const RAW_SLACK_ID_RE = /^(?:T|C|D|G|U|W)[A-Z0-9]{8,}$/;
const PROVIDER_ID_KEYS = new Set([
  'accountid',
  'channelid',
  'conversationid',
  'databaseid',
  'datasourceid',
  'provideraccountid',
  'providerconversationid',
  'providerworkspaceid',
  'teamid',
  'workspaceid'
]);
const PRIVATE_VALUE_KEYS = new Set([
  'accesstoken',
  'credentialvalue',
  'password',
  'privateinputvalue',
  'providerresponse',
  'rawbody',
  'rawproviderresponse',
  'refreshtoken',
  'secretvalue',
  'token'
]);

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portable(relative) {
  return relative.split(path.sep).join('/');
}

function pointerSegment(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function normalizedKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fixtureIdentity(value) {
  return typeof value === 'string' && CONFIGURATION_TEMPLATE_FIXTURE_RE.test(value);
}

function portableUri(value) {
  return PORTABLE_URI_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function violation(file, pointer, code, message) {
  return { file, pointer, code, message };
}

function emailDomains(value) {
  const domains = [];
  EMAIL_RE.lastIndex = 0;
  for (const match of value.matchAll(EMAIL_RE)) domains.push(match[1].toLowerCase());
  return domains;
}

function inspectString(value, file, pointer, key, violations) {
  if (SECRET_VALUE_RE.test(value)) {
    violations.push(violation(
      file,
      pointer,
      'TRACKED_CONFIGURATION_CREDENTIAL_VALUE',
      'Tracked configuration templates may contain secret references, never credential values.'
    ));
  }

  const invalidEmail = emailDomains(value).some((domain) => {
    return domain !== 'example' && !domain.endsWith('.example');
  });
  if (invalidEmail) {
    violations.push(violation(
      file,
      pointer,
      'TRACKED_CONFIGURATION_EMAIL_DOMAIN',
      'Tracked email identities must use a reserved .example domain.'
    ));
  }

  if (value === '/' || UNIX_ABSOLUTE_PATH_RE.test(value) || WINDOWS_ABSOLUTE_PATH_RE.test(value)) {
    violations.push(violation(
      file,
      pointer,
      'TRACKED_CONFIGURATION_ABSOLUTE_PATH',
      'Tracked configuration templates may not contain an absolute local or provider path.'
    ));
  }

  if (value.includes('://')) {
    if (value.startsWith('soter-fixture://')) {
      if (!fixtureIdentity(value)) {
        violations.push(violation(
          file,
          pointer,
          'TRACKED_CONFIGURATION_FIXTURE_NAMESPACE',
          'Fixture identities must use the reserved deterministic configuration-template namespace.'
        ));
      }
    } else if (!portableUri(value)) {
      violations.push(violation(
        file,
        pointer,
        'TRACKED_CONFIGURATION_PROVIDER_URI',
        'Provider and external URIs are private configuration values, not tracked template values.'
      ));
    }
  }

  if ((RAW_NOTION_ID_RE.test(value) || RAW_SLACK_ID_RE.test(value)) && !fixtureIdentity(value)) {
    violations.push(violation(
      file,
      pointer,
      'TRACKED_CONFIGURATION_PROVIDER_IDENTIFIER',
      'A live-looking provider identifier must be replaced by a reserved fixture identity.'
    ));
  }

  if (PROVIDER_ID_KEYS.has(normalizedKey(key)) && !fixtureIdentity(value)) {
    violations.push(violation(
      file,
      pointer,
      'TRACKED_CONFIGURATION_PROVIDER_IDENTIFIER',
      'Provider account, workspace, conversation, and database identifiers must use the reserved fixture namespace.'
    ));
  }
}

function inspectValue(value, file, pointer, violations, key = '') {
  if (typeof value === 'string') {
    inspectString(value, file, pointer, key, violations);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      inspectValue(item, file, `${pointer}/${index}`, violations, key);
    });
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${pointerSegment(childKey)}`;
    if (PRIVATE_VALUE_KEYS.has(normalizedKey(childKey))) {
      violations.push(violation(
        file,
        childPointer,
        'TRACKED_CONFIGURATION_PRIVATE_VALUE_FIELD',
        'Tracked configuration templates cannot represent a credential, raw provider response, or private input value field.'
      ));
      continue;
    }
    inspectValue(child, file, childPointer, violations, childKey);
  }
}

function configurationFiles(root, violations) {
  const directory = path.join(root, 'soter', 'configurations');
  if (!fs.existsSync(directory)) {
    violations.push(violation(
      'soter/configurations',
      '',
      'TRACKED_CONFIGURATION_DIRECTORY_MISSING',
      'The governed tracked configuration-template directory is missing.'
    ));
    return [];
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.config.json'))
    .sort((left, right) => compareCodepoint(left.name, right.name));
  if (!entries.length) {
    violations.push(violation(
      'soter/configurations',
      '',
      'TRACKED_CONFIGURATION_TEMPLATES_MISSING',
      'At least one governed tracked configuration template is required.'
    ));
  }
  return entries.map((entry) => {
    const relative = portable(path.join('soter', 'configurations', entry.name));
    const absolute = path.join(directory, entry.name);
    if (!entry.isFile()) {
      violations.push(violation(
        relative,
        '',
        'TRACKED_CONFIGURATION_FILE_INVALID',
        'Tracked configuration templates must be regular files.'
      ));
      return null;
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      violations.push(violation(
        relative,
        '',
        'TRACKED_CONFIGURATION_FILE_INVALID',
        'Tracked configuration templates must be regular non-symlink, non-hardlinked files.'
      ));
      return null;
    }
    return { relative, absolute };
  }).filter(Boolean);
}

export function inspectTrackedConfigurationTemplates(root = defaultRoot) {
  const resolvedRoot = path.resolve(root);
  const violations = [];
  const files = configurationFiles(resolvedRoot, violations);
  for (const file of files) {
    let document;
    try {
      document = JSON.parse(fs.readFileSync(file.absolute, 'utf8'));
    } catch {
      violations.push(violation(
        file.relative,
        '',
        'TRACKED_CONFIGURATION_JSON_INVALID',
        'Tracked configuration templates must contain valid JSON.'
      ));
      continue;
    }
    if (document?.$contract !== 'soter://contracts/configuration/v1'
      || typeof document.name !== 'string'
      || !CANONICAL_VERSION_RE.test(document.host?.version || '')) {
      violations.push(violation(
        file.relative,
        '',
        'TRACKED_CONFIGURATION_TEMPLATE_IDENTITY',
        'Tracked templates require configuration/v1 identity, a stable name, and one canonical host adapter version.'
      ));
    }
    inspectValue(document, file.relative, '', violations);
    const targets = document?.settings?.['integration.notion']?.targets;
    for (const [target, identity] of Object.entries(targets || {})) {
      if (!fixtureIdentity(identity)) {
        violations.push(violation(
          file.relative,
          `/settings/integration.notion/targets/${pointerSegment(target)}`,
          'TRACKED_CONFIGURATION_FIXTURE_NAMESPACE',
          'Tracked provider targets must use the reserved deterministic configuration-template fixture namespace.'
        ));
      }
    }
    if (Object.hasOwn(
      document?.settings?.['integration.notion'] || {},
      'optionMappings'
    )) {
      violations.push(violation(
        file.relative,
        '/settings/integration.notion/optionMappings',
        'TRACKED_CONFIGURATION_PROVIDER_OPTION_MAPPING',
        'Exact provider option labels belong only in private configuration state.'
      ));
    }
    if (Object.hasOwn(
      document?.settings?.['integration.notion'] || {},
      'fieldBindings'
    )) {
      violations.push(violation(
        file.relative,
        '/settings/integration.notion/fieldBindings',
        'TRACKED_CONFIGURATION_PROVIDER_FIELD_BINDING',
        'Exact provider property names and unavailable-property declarations belong only in private configuration state.'
      ));
    }
    if (Object.hasOwn(
      document?.settings?.['integration.slack'] || {},
      'readinessProbe'
    )) {
      violations.push(violation(
        file.relative,
        '/settings/integration.slack/readinessProbe',
        'TRACKED_CONFIGURATION_PRIVATE_SLACK_READINESS_PROBE',
        'Exact Slack conversation, thread, and time-window probe identities belong only in private configuration state.'
      ));
    }
  }
  violations.sort((left, right) => {
    return compareCodepoint(
      `${left.file}\0${left.pointer}\0${left.code}`,
      `${right.file}\0${right.pointer}\0${right.code}`
    );
  });
  return {
    state: violations.length ? 'blocked' : 'passed',
    templateCount: files.length,
    templates: files.map((file) => file.relative),
    violations
  };
}

export function assertTrackedConfigurationTemplatesPortable(root = defaultRoot) {
  const inspection = inspectTrackedConfigurationTemplates(root);
  if (inspection.state !== 'passed') {
    const error = new Error(
      `Tracked configuration portability failed with ${inspection.violations.length} violation(s).`
    );
    error.code = 'TRACKED_CONFIGURATION_PORTABILITY_INVALID';
    error.violations = inspection.violations;
    throw error;
  }
  return inspection;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  const inspection = assertTrackedConfigurationTemplatesPortable(process.argv[2] || defaultRoot);
  process.stdout.write(
    `Tracked configuration portability passed: ${inspection.templateCount} synthetic templates, no live authority values.\n`
  );
}
