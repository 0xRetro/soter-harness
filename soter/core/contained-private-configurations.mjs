import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  fingerprintFile,
  fingerprintJson,
  readJson,
  repoRelativePath,
  writeJson
} from './lib/canonical-json.mjs';
import {
  privateConfigurationStatePath,
  removePrivateConfigurationState,
  writePrivateConfigurationState
} from './private-configurations.mjs';
import { resolveConfiguration } from './resolve.mjs';
import { writeActiveConfigurationLockState } from './runtime-state.mjs';
import {
  PRIVATE_CONTAINED_BASIS_VERSION,
  fingerprintPrivateContainedBasis,
  fingerprintPrivateContainedLockProjection
} from '../kernel/private-contained-evidence.mjs';

const TEMPLATE_TARGET = /^soter-fixture:\/\/configuration-template\/notion\/collection\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEMPLATE_DOCUMENT = /^soter-fixture:\/\/configuration-template\/notion\/document\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPTION_MAPPING_ID = /^mapping\.integration\.notion\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPTION_RECORD_TYPE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const OPTION_FIELD = /^[A-Za-z][A-Za-z0-9]*$/;
const OPTION_VALUE = /^[^\u0000-\u001F\u007F]+$/;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deterministicProviderId(kind, name) {
  return fingerprintJson({ kind, name }).slice('sha256:'.length, 'sha256:'.length + 32);
}

function graphFingerprint(lock) {
  const unsigned = structuredClone(lock);
  delete unsigned.graphFingerprint;
  return fingerprintJson(unsigned);
}

function exactNotionOptionMappings(value) {
  if (!Array.isArray(value) || value.length > 200) {
    throw new Error('Contained Notion option mappings must be one bounded array.');
  }
  const scopes = new Set();
  return value.map((declaration) => {
    if (!declaration
      || typeof declaration !== 'object'
      || Array.isArray(declaration)
      || Object.keys(declaration).sort(compareText).join(',')
        !== 'entries,field,mapping,mode,recordType'
      || !OPTION_MAPPING_ID.test(declaration.mapping)
      || !OPTION_RECORD_TYPE.test(declaration.recordType)
      || !OPTION_FIELD.test(declaration.field)
      || declaration.mode !== 'exact-bijection'
      || !Array.isArray(declaration.entries)
      || declaration.entries.length < 1
      || declaration.entries.length > 200) {
      throw new Error('Contained Notion option mapping declaration is malformed.');
    }
    const scope = [
      declaration.mapping,
      declaration.recordType,
      declaration.field
    ].join(':');
    if (scopes.has(scope)) {
      throw new Error('Contained Notion option mapping scope is duplicated: ' + scope);
    }
    scopes.add(scope);
    const portable = new Set();
    const provider = new Set();
    const entries = declaration.entries.map((entry) => {
      if (!entry
        || typeof entry !== 'object'
        || Array.isArray(entry)
        || Object.keys(entry).sort(compareText).join(',') !== 'portable,provider'
        || typeof entry.portable !== 'string'
        || typeof entry.provider !== 'string'
        || entry.portable.length < 1
        || entry.portable.length > 200
        || entry.provider.length < 1
        || entry.provider.length > 200
        || entry.portable.trim() !== entry.portable
        || entry.provider.trim() !== entry.provider
        || !OPTION_VALUE.test(entry.portable)
        || !OPTION_VALUE.test(entry.provider)
        || portable.has(entry.portable)
        || provider.has(entry.provider)) {
        throw new Error(
          'Contained Notion option mapping entries must form one exact private bijection.'
        );
      }
      portable.add(entry.portable);
      provider.add(entry.provider);
      return { portable: entry.portable, provider: entry.provider };
    });
    return {
      mapping: declaration.mapping,
      recordType: declaration.recordType,
      field: declaration.field,
      mode: declaration.mode,
      entries
    };
  });
}

function notionOptionMappingScope(optionMappings) {
  return optionMappings.map((declaration) => ({
    mapping: declaration.mapping,
    recordType: declaration.recordType,
    field: declaration.field,
    mode: declaration.mode,
    entryCount: declaration.entries.length
  })).sort((left, right) => compareText(
    [left.mapping, left.recordType, left.field].join(':'),
    [right.mapping, right.recordType, right.field].join(':')
  ));
}

function exactNotionFieldBindings(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) {
    throw new Error('Contained Notion field bindings must be one bounded non-empty array.');
  }
  const scopes = new Set();
  const providerFields = new Map();
  return value.map((declaration) => {
    if (!declaration
      || typeof declaration !== 'object'
      || Array.isArray(declaration)
      || Object.keys(declaration).sort(compareText).join(',')
        !== 'field,mapping,provider,recordType,state'
      || !OPTION_MAPPING_ID.test(declaration.mapping)
      || !OPTION_RECORD_TYPE.test(declaration.recordType)
      || !OPTION_FIELD.test(declaration.field)
      || declaration.state !== 'mapped'
      || typeof declaration.provider !== 'string'
      || declaration.provider.length < 1
      || declaration.provider.length > 200
      || declaration.provider.trim() !== declaration.provider
      || !OPTION_VALUE.test(declaration.provider)) {
      throw new Error('Contained Notion field binding declaration is malformed.');
    }
    const scope = [
      declaration.mapping,
      declaration.recordType,
      declaration.field
    ].join(':');
    if (scopes.has(scope)) {
      throw new Error('Contained Notion field binding scope is duplicated: ' + scope);
    }
    scopes.add(scope);
    const recordScope = [declaration.mapping, declaration.recordType].join(':');
    if (!providerFields.has(recordScope)) providerFields.set(recordScope, new Set());
    if (providerFields.get(recordScope).has(declaration.provider)) {
      throw new Error(
        'Contained Notion field bindings map multiple portable fields to one provider property.'
      );
    }
    providerFields.get(recordScope).add(declaration.provider);
    return {
      mapping: declaration.mapping,
      recordType: declaration.recordType,
      field: declaration.field,
      state: 'mapped',
      provider: declaration.provider
    };
  });
}

function containedNotionFieldBindings(root, configuration) {
  const notionSettings = configuration.settings?.['integration.notion'];
  const targets = notionSettings?.targets || {};
  const boundCapabilities = new Set(
    configuration.bindings
      .filter((binding) => binding.providerPack === 'integration.notion')
      .map((binding) => binding.capability)
  );
  const directory = path.join(root, 'soter/integrations/notion');
  const bindings = fs.readdirSync(directory)
    .filter((file) => file.endsWith('.mapping.json'))
    .sort(compareText)
    .flatMap((file) => {
      const mapping = readJson(path.join(directory, file));
      if (mapping?.$contract !== 'soter://contracts/provider-mapping/v1'
        || mapping.pack !== 'integration.notion') {
        return [];
      }
      return mapping.recordTypes.flatMap((record) => {
        if (!Object.hasOwn(targets, record.target)
          || !record.capabilities.some((capability) => boundCapabilities.has(capability))) {
          return [];
        }
        return record.fields.map((field) => ({
          mapping: mapping.id,
          recordType: record.id,
          field: field.portable,
          state: 'mapped',
          provider: field.provider
        }));
      });
    })
    .sort((left, right) => compareText(
      [left.mapping, left.recordType, left.field].join(':'),
      [right.mapping, right.recordType, right.field].join(':')
    ));
  return exactNotionFieldBindings(bindings);
}

function notionFieldBindingScope(fieldBindings) {
  return fieldBindings.map((declaration) => ({
    mapping: declaration.mapping,
    recordType: declaration.recordType,
    field: declaration.field,
    state: declaration.state
  }));
}

function exactContainedRealization({
  root,
  configuration,
  templateLock,
  privateLock,
  notion,
  notionOptionMappings,
  notionFieldBindings
}) {
  const expected = structuredClone(templateLock);
  expected.configuration.path = repoRelativePath(
    root,
    privateConfigurationStatePath(root, configuration.name)
  );
  expected.configuration.fingerprint = fingerprintJson(configuration);

  const expectedTargets = expected.settings?.['integration.notion']?.targets;
  if (!expectedTargets
    || fingerprintJson(Object.keys(expectedTargets).sort())
      !== fingerprintJson(Object.keys(notion.targets).sort())) {
    throw new Error('Contained private target keys do not match the tracked template lock.');
  }
  for (const [key, privateValue] of Object.entries(notion.targets)) {
    if (!TEMPLATE_TARGET.test(expectedTargets[key])
      || privateLock.settings?.['integration.notion']?.targets?.[key] !== privateValue) {
      throw new Error('Contained private target substitution is not exact: ' + key);
    }
    expectedTargets[key] = privateValue;
  }
  const expectedNotionSettings = expected.settings?.['integration.notion'];
  if (!expectedNotionSettings
    || Object.hasOwn(expectedNotionSettings, 'optionMappings')
    || Object.hasOwn(expectedNotionSettings, 'fieldBindings')
    || fingerprintJson(notionOptionMappings)
      !== fingerprintJson(configuration.settings['integration.notion'].optionMappings || [])
    || fingerprintJson(notionFieldBindings)
      !== fingerprintJson(configuration.settings['integration.notion'].fieldBindings || [])) {
    throw new Error(
      'Contained private Notion mappings do not derive from one mapping-free tracked template.'
    );
  }
  if (notionOptionMappings.length > 0) {
    expectedNotionSettings.optionMappings = structuredClone(notionOptionMappings);
  }
  expectedNotionSettings.fieldBindings = structuredClone(notionFieldBindings);

  for (let index = 0; index < expected.sources.length; index += 1) {
    const expectedSource = expected.sources[index];
    const privateSource = privateLock.sources[index];
    const templateUri = expectedSource.input?.uri;
    const privateUri = notion.documentUris[templateUri];
    if (privateUri) {
      expectedSource.input.uri = privateUri;
      expectedSource.inputFingerprint = fingerprintJson(expectedSource.input);
    }
    if (Array.isArray(expectedSource.input?.ids)) {
      expectedSource.input.ids = expectedSource.input.ids.map((id) => {
        return notion.recordUris[id] || id;
      });
      expectedSource.inputFingerprint = fingerprintJson(expectedSource.input);
    }
    if (fingerprintJson(expectedSource) !== fingerprintJson(privateSource)) {
      throw new Error(
        'Contained private source substitution changed undeclared semantics: '
          + expectedSource.id
      );
    }
  }

  if (Object.keys(notion.documentUris).length > 0) {
    const notionPack = expected.packs.find((pack) => pack.id === 'integration.notion');
    const fixtureArtifacts = notionPack?.artifacts.filter((artifact) => {
      return artifact.path === 'soter/fixtures/providers/notion/workspace-records.json'
        && artifact.role === 'fixture';
    }) || [];
    if (fixtureArtifacts.length !== 1) {
      throw new Error('Contained private document realization requires one exact Notion fixture.');
    }
    fixtureArtifacts[0].fingerprint = fingerprintFile(path.join(
      root,
      'soter/fixtures/providers/notion/workspace-records.json'
    ));
  }

  expected.graphFingerprint = graphFingerprint(expected);
  if (fingerprintJson(expected) !== fingerprintJson(privateLock)) {
    throw new Error(
      'Contained private configuration changed fields outside its closed provider substitution.'
    );
  }
  const templateProjectionFingerprint
    = fingerprintPrivateContainedLockProjection(templateLock);
  const privateProjectionFingerprint
    = fingerprintPrivateContainedLockProjection(privateLock);
  if (templateProjectionFingerprint !== privateProjectionFingerprint) {
    throw new Error(
      'Contained private configuration changed portable lock semantics.'
    );
  }

  const optionMappingScope = notionOptionMappingScope(notionOptionMappings);
  const fieldBindingScope = notionFieldBindingScope(notionFieldBindings);
  const basis = {
    kind: 'private-active-contained',
    version: PRIVATE_CONTAINED_BASIS_VERSION,
    configurationName: configuration.name,
    privateConfigurationFingerprint: fingerprintJson(configuration),
    privateLockFingerprint: fingerprintJson(privateLock),
    privateGraphFingerprint: privateLock.graphFingerprint,
    trackedTemplateLockFingerprint: fingerprintJson(templateLock),
    trackedTemplateGraphFingerprint: templateLock.graphFingerprint,
    applicabilityProjectionFingerprint: privateProjectionFingerprint,
    substitutions: {
      notionTargetCount: Object.keys(notion.targets).length,
      notionDocumentSourceCount: Object.keys(notion.documentUris).length,
      providerFixtureDocumentCount: Object.keys(notion.documentUris).length,
      notionOptionMappingScopeCount: optionMappingScope.length,
      notionOptionMappingEntryCount: optionMappingScope.reduce(
        (count, scope) => count + scope.entryCount,
        0
      ),
      notionOptionMappingScopeFingerprint: fingerprintJson(optionMappingScope),
      notionFieldBindingScopeCount: fieldBindingScope.length,
      notionFieldBindingScopeFingerprint: fingerprintJson(fieldBindingScope)
    },
    privacy: {
      fullPrivateLockIncluded: false,
      privateConfigurationPathIncluded: false,
      providerTargetValuesIncluded: false,
      providerSourceValuesIncluded: false,
      providerOptionValuesIncluded: false,
      providerFieldNamesIncluded: false,
      rawProviderResponsesIncluded: false,
      privateInputsIncluded: false
    }
  };
  basis.basisFingerprint = fingerprintPrivateContainedBasis(basis);
  return basis;
}

/**
 * Materialize provider-shaped identities only inside a copied, contained test
 * root. Tracked configuration templates remain portable placeholders; this
 * private state models the exact boundary required before connected preflight.
 */
export function materializeContainedPrivateConfiguration({
  root,
  configurationName,
  host = 'codex',
  expectedTemplateLock = null,
  notionOptionMappings = [],
  ...unknown
} = {}) {
  const exactOptionMappings = exactNotionOptionMappings(notionOptionMappings);
  if (Object.keys(unknown).length
    || typeof configurationName !== 'string'
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(configurationName)
    || !['codex', 'claude'].includes(host)
    || (expectedTemplateLock !== null
      && (!expectedTemplateLock || typeof expectedTemplateLock !== 'object'))) {
    throw new Error('Contained private configuration requires one exact configuration and host.');
  }
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const temporaryRelative = path.relative(temporaryRoot, resolvedRoot);
  if (!temporaryRelative
    || temporaryRelative === '..'
    || temporaryRelative.startsWith('..' + path.sep)
    || path.isAbsolute(temporaryRelative)
    || fs.existsSync(path.join(resolvedRoot, '.git'))) {
    throw new Error('Contained private configuration may run only in one copied temporary non-Git root.');
  }
  const configurationPath = path.join(
    resolvedRoot,
    'soter/configurations',
    configurationName + '.config.json'
  );
  const configuration = structuredClone(readJson(configurationPath));
  if (configuration.name !== configurationName || configuration.host?.id !== host) {
    throw new Error('Contained private configuration identity does not match its tracked template.');
  }
  const templateLock = resolveConfiguration({
    root: resolvedRoot,
    configPath: configurationPath,
    host
  });
  if (expectedTemplateLock
    && fingerprintJson(expectedTemplateLock) !== fingerprintJson(templateLock)) {
    throw new Error(
      'Contained private configuration does not derive from the expected tracked template lock.'
    );
  }
  if (Object.hasOwn(
    configuration.settings?.['integration.notion'] || {},
    'optionMappings'
  ) || Object.hasOwn(
    configuration.settings?.['integration.notion'] || {},
    'fieldBindings'
  )) {
    throw new Error(
      'Contained private Notion mappings must not originate in the tracked template.'
    );
  }
  const notion = { targets: {}, documentUris: {}, recordUris: {} };
  const targets = configuration.settings?.['integration.notion']?.targets || {};
  if (Object.keys(targets).length === 0) {
    throw new Error('Contained private configuration has no exact Notion target declarations.');
  }
  for (const [key, value] of Object.entries(targets)) {
    if (!TEMPLATE_TARGET.test(value)) {
      throw new Error('Contained Notion target is not one reserved tracked template identity: ' + key);
    }
    const privateValue = 'collection://' + deterministicProviderId(
      'notion-collection',
      configurationName + ':' + key
    );
    targets[key] = privateValue;
    notion.targets[key] = privateValue;
  }
  for (const source of configuration.sources || []) {
    const value = source.input?.uri;
    if (typeof value !== 'string' || !value.startsWith('soter-fixture://')) continue;
    if (!TEMPLATE_DOCUMENT.test(value)) {
      throw new Error('Contained Notion document source is not one reserved tracked template identity.');
    }
    const privateValue = 'https://www.notion.so/' + deterministicProviderId(
      'notion-document',
      configurationName + ':' + source.id
    );
    notion.documentUris[value] = privateValue;
    source.input.uri = privateValue;
  }
  for (const source of configuration.sources || []) {
    if (!Array.isArray(source.input?.ids)) continue;
    source.input.ids = source.input.ids.map((id) => {
      if (typeof id !== 'string' || !id || id.trim() !== id) {
        throw new Error('Contained Notion record source has an invalid exact identity.');
      }
      const privateValue = notion.recordUris[id]
        || 'https://www.notion.so/' + deterministicProviderId(
          'notion-record',
          configurationName + ':' + id
        );
      notion.recordUris[id] = privateValue;
      return privateValue;
    });
  }
  if (exactOptionMappings.length > 0) {
    configuration.settings['integration.notion'].optionMappings
      = structuredClone(exactOptionMappings);
  }
  const exactFieldBindings = containedNotionFieldBindings(resolvedRoot, configuration);
  configuration.settings['integration.notion'].fieldBindings
    = structuredClone(exactFieldBindings);
  const fixturePath = path.join(resolvedRoot, 'soter/fixtures/providers/notion/workspace-records.json');
  let originalFixture = null;
  if (Object.keys(notion.documentUris).length) {
    const fixture = readJson(fixturePath);
    originalFixture = structuredClone(fixture);
    const occurrences = new Map(Object.keys(notion.documentUris).map((uri) => [uri, 0]));
    for (const document of fixture.data?.documents || []) {
      if (notion.documentUris[document.uri]) {
        occurrences.set(document.uri, occurrences.get(document.uri) + 1);
        document.uri = notion.documentUris[document.uri];
      }
    }
    if ([...occurrences.values()].some((count) => count !== 1)) {
      throw new Error('Contained Notion document templates are missing, duplicated, or substituted.');
    }
    writeJson(fixturePath, fixture);
  }
  let lock;
  try {
    writePrivateConfigurationState(resolvedRoot, configurationName, configuration);
    lock = resolveConfiguration({
      root: resolvedRoot,
      configPath: privateConfigurationStatePath(resolvedRoot, configurationName),
      host
    });
  } catch (error) {
    removePrivateConfigurationState(resolvedRoot, configurationName);
    if (originalFixture) writeJson(fixturePath, originalFixture);
    throw error;
  }
  const privateContainedBasis = exactContainedRealization({
    root: resolvedRoot,
    configuration,
    templateLock,
    privateLock: lock,
    notion,
    notionOptionMappings: exactOptionMappings,
    notionFieldBindings: exactFieldBindings
  });
  writeActiveConfigurationLockState(resolvedRoot, configurationName, lock);
  return {
    configuration,
    lock,
    notion,
    templateLock,
    privateContainedBasis
  };
}
