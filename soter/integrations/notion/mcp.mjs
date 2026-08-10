import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { parseRecordCapability } from '../../kernel/record-capabilities.mjs';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function providerError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw providerError('validation', label + ' must be an object.');
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw providerError('validation', label + ' must be a non-empty string.');
  }
  return value;
}

function parseJsonText(value, label) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw providerError('validation', label + ' did not contain valid JSON.');
  }
}

const CODEX_RESPONSE_PROFILE = 'notion.codex.connector.v1';
const CLAUDE_RESPONSE_PROFILE = 'notion.claude.plugin.v1';
const RESPONSE_PROFILES = new Set([
  CODEX_RESPONSE_PROFILE,
  CLAUDE_RESPONSE_PROFILE
]);
const NOTION_MARKDOWN_COLORS = new Set([
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
  'gray_bg',
  'brown_bg',
  'orange_bg',
  'yellow_bg',
  'green_bg',
  'blue_bg',
  'purple_bg',
  'pink_bg',
  'red_bg'
]);
const CLAUDE_TOOL_ACCESS_STATUSES = new Set([
  'available',
  'limited_free_trial',
  'upgrade_required',
  'not_enabled'
]);

function exactResponseProfile(value) {
  if (!RESPONSE_PROFILES.has(value)) {
    throw providerError('validation', 'Notion returned an undeclared response profile.');
  }
  return value;
}

function exactKeys(value, required, allowed) {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.includes(key));
}

function optionalString(value) {
  return value === undefined || typeof value === 'string';
}

function nonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function exactIdentitySubject(value, allowed) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && exactKeys(value, ['id'], allowed)
    && nonEmptyString(value.id)
    && Object.entries(value).every(([key, child]) => {
      return key === 'id' || typeof child === 'string';
    });
}

function exactMetadata(value, type) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && exactKeys(value, ['type'], ['type'])
    && value.type === type;
}

function exactHttpsUrl(value) {
  const parsed = parsedUrl(value);
  return parsed !== null
    && parsed.protocol === 'https:'
    && Boolean(parsed.hostname)
    && !parsed.username
    && !parsed.password;
}

function exactClaudeToolAccess(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0
    && entries.length <= 100
    && entries.every(([tool, access]) => {
      return /^[a-z][a-z0-9_]{0,63}$/.test(tool)
        && access
        && typeof access === 'object'
        && !Array.isArray(access)
        && exactKeys(access, ['status'], ['status', 'upgrade_url'])
        && CLAUDE_TOOL_ACCESS_STATUSES.has(access.status)
        && (access.upgrade_url === undefined
          || exactHttpsUrl(access.upgrade_url));
    });
}

function exactQueryRow(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && exactKeys(
      value,
      ['__soterType', '__soterId', '__soterFields'],
      ['__soterType', '__soterId', '__soterFields']
    )
    && nonEmptyString(value.__soterType)
    && nonEmptyString(value.__soterId)
    && typeof value.__soterFields === 'string';
}

function directClaudePayload(response, kind) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  if (kind === 'self') {
    return exactKeys(
      response,
      ['metadata', 'self'],
      ['metadata', 'title', 'url', 'text', 'self']
    )
      && exactMetadata(response.metadata, 'self')
      && response.self
      && typeof response.self === 'object'
      && !Array.isArray(response.self)
      && exactKeys(
        response.self,
        ['workspace', 'user', 'current_tool_access'],
        ['workspace', 'user', 'current_tool_access']
      )
      && exactIdentitySubject(response.self.workspace, ['id', 'name'])
      && exactIdentitySubject(response.self.user, ['id', 'email', 'name', 'type'])
      && exactClaudeToolAccess(response.self.current_tool_access)
      && optionalString(response.title)
      && optionalString(response.url)
      && optionalString(response.text);
  }
  if (kind === 'page' || kind === 'data-source') {
    return exactKeys(
      response,
      ['metadata', 'text'],
      ['metadata', 'title', 'url', 'text']
    )
      && exactMetadata(response.metadata, kind === 'page' ? 'page' : 'data_source')
      && optionalString(response.title)
      && optionalString(response.url)
      && typeof response.text === 'string';
  }
  if (kind === 'query') {
    return exactKeys(
      response,
      ['results', 'has_more', 'data_source_ids'],
      ['results', 'has_more', 'data_source_ids', 'next_cursor']
    )
      && Array.isArray(response.results)
      && response.results.every(exactQueryRow)
      && typeof response.has_more === 'boolean'
      && Array.isArray(response.data_source_ids)
      && response.data_source_ids.length === 1
      && response.data_source_ids.every((value) => {
        return nonEmptyString(value);
      })
      && (response.has_more
        ? nonEmptyString(response.next_cursor)
        : !Object.hasOwn(response, 'next_cursor') || response.next_cursor === null);
  }
  if (kind === 'create') {
    return exactKeys(response, ['pages'], ['pages'])
      && Array.isArray(response.pages)
      && response.pages.length === 1
      && exactKeys(
        response.pages[0],
        ['id', 'properties', 'url'],
        ['id', 'properties', 'url']
      )
      && nonEmptyString(response.pages[0].id)
      && response.pages[0].properties
      && typeof response.pages[0].properties === 'object'
      && !Array.isArray(response.pages[0].properties)
      && nonEmptyString(response.pages[0].url);
  }
  if (kind === 'update') {
    return exactKeys(response, ['page_id'], ['page_id'])
      && nonEmptyString(response.page_id);
  }
  return false;
}

function directPayloadKind(capability, input = null) {
  if (capability === 'workspace.identity.read') return 'self';
  if (capability === 'documents.content.read') return 'page';
  if (capability === 'documents.content.update') return 'update';
  const descriptor = parseRecordCapability(capability);
  if (descriptor?.operation === 'schema-read') return 'data-source';
  if (descriptor?.operation === 'read') return input?.content ? 'page' : 'query';
  if (descriptor?.operation === 'create') return 'create';
  if (descriptor?.operation === 'update') return 'update';
  return null;
}

function hasDirectClaudeSurface(response) {
  return response
    && typeof response === 'object'
    && !Array.isArray(response)
    && ['metadata', 'self', 'results', 'has_more', 'pages', 'page_id', 'object', 'status']
      .some((key) => {
        return Object.hasOwn(response, key);
      });
}

function exactJsonTextContent(response) {
  if (!Array.isArray(response?.content)
    || response.content.length !== 1
    || !exactKeys(response.content[0], ['type', 'text'], ['type', 'text'])
    || response.content[0].type !== 'text'
    || typeof response.content[0].text !== 'string') {
    throw providerError('validation', 'Notion did not return one exact JSON text result.');
  }
  return parseJsonText(response.content[0].text, 'Notion text result');
}

function exactCodexPayload(response) {
  if (!exactKeys(response, [], ['content', 'structuredContent', 'isError'])) {
    throw providerError('validation', 'Notion returned an invalid Codex response envelope.');
  }
  const hasContent = Object.hasOwn(response, 'content');
  const hasStructured = Object.hasOwn(response, 'structuredContent');
  if (hasContent === hasStructured) {
    throw providerError(
      'validation',
      'Notion Codex responses must contain exactly one governed result representation.'
    );
  }
  if (hasStructured) {
    if (!response.structuredContent
      || typeof response.structuredContent !== 'object'
      || Array.isArray(response.structuredContent)
      || !exactKeys(response.structuredContent, ['result'], ['result'])) {
      throw providerError('validation', 'Notion returned an invalid Codex structured result.');
    }
    return parseJsonText(response.structuredContent.result, 'Notion structured result');
  }
  return exactJsonTextContent(response);
}

function exactErrorFlag(response, profile) {
  const flag = profile === CODEX_RESPONSE_PROFILE ? 'isError' : 'is_error';
  const foreignFlag = profile === CODEX_RESPONSE_PROFILE ? 'is_error' : 'isError';
  if (Object.hasOwn(response, foreignFlag)
    || !Object.hasOwn(response, flag)
    || typeof response[flag] !== 'boolean') {
    throw providerError('validation', 'Notion returned an invalid host error flag.');
  }
  return response[flag];
}

function nativePayload(response, responseProfile, directKind = null) {
  const profile = exactResponseProfile(responseProfile);
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw providerError('validation', 'Notion did not return an object response.');
  }
  const profileFlag = profile === CODEX_RESPONSE_PROFILE ? 'isError' : 'is_error';
  const foreignFlag = profile === CODEX_RESPONSE_PROFILE ? 'is_error' : 'isError';
  // MCP success results may omit the host error flag. When either profile's
  // flag is present, its exact name and boolean type are still mandatory.
  if (Object.hasOwn(response, profileFlag) || Object.hasOwn(response, foreignFlag)) {
    const isError = exactErrorFlag(response, profile);
    if (isError) {
      const errorCode = response?.structuredContent?.error_code;
      throw providerError(
        profile === CODEX_RESPONSE_PROFILE && errorCode === 'RATE_LIMITED'
          ? 'rate-limit'
          : 'unknown',
        'The Notion host tool returned an error result.'
      );
    }
  }
  if (profile === CLAUDE_RESPONSE_PROFILE
    && directClaudePayload(response, directKind)) {
    return response;
  }
  if (profile === CLAUDE_RESPONSE_PROFILE && hasDirectClaudeSurface(response)) {
    const hasWrapper = Object.hasOwn(response, 'result')
      || Object.hasOwn(response, 'structuredContent')
      || Object.hasOwn(response, 'content');
    if (hasWrapper) {
      throw providerError(
        'validation',
        'Notion returned a hybrid direct and wrapped response.'
      );
    }
    throw providerError('validation', 'Notion returned an invalid direct Claude result.');
  }
  if (profile === CODEX_RESPONSE_PROFILE) {
    return exactCodexPayload(response);
  }
  throw providerError(
    'validation',
    'Notion Claude responses must use the exact direct result shape.'
  );
}

function mappingDocument(mappings, capability) {
  const matches = (mappings || []).filter((mapping) => {
    return mapping?.$contract === 'soter://contracts/provider-mapping/v1'
      && mapping.capabilities?.includes(capability);
  });
  if (matches.length !== 1) {
    throw providerError(
      'validation',
      'Expected one provider mapping for ' + capability + '; found ' + matches.length + '.'
    );
  }
  return matches[0];
}

const CHOICE_PROVIDER_TYPES = new Set(['select', 'multi_select', 'status']);

function notionConfiguration(settings) {
  return requiredObject(settings?.['integration.notion'], 'integration.notion settings');
}

function notionSettings(settings) {
  return requiredObject(
    notionConfiguration(settings).targets,
    'integration.notion.targets'
  );
}

function optionMappingKey(mapping, recordType, field) {
  return [mapping, recordType, field].join('\0');
}

function exactOptionName(value, label) {
  if (typeof value !== 'string'
    || !value
    || value.trim() !== value
    || value.length > 200
    || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw providerError('validation', label + ' is invalid.');
  }
  return value;
}

function configuredOptionMappings(settings, mappings) {
  const configured = notionConfiguration(settings);
  const declarations = configured.optionMappings || [];
  if (!Array.isArray(declarations)) {
    throw providerError('validation', 'integration.notion.optionMappings must be an array.');
  }
  const mappingById = new Map((mappings || []).map((mapping) => [mapping.id, mapping]));
  const unavailableFieldScopes = new Set((configured.fieldBindings || [])
    .filter((binding) => binding?.state === 'unavailable')
    .map((binding) => optionMappingKey(
      binding.mapping,
      binding.recordType,
      binding.field
    )));
  const scopes = new Map();
  for (const declaration of declarations) {
    const mapping = mappingById.get(declaration?.mapping);
    const record = mapping?.recordTypes?.find((item) => {
      return item.id === declaration?.recordType;
    });
    const field = record?.fields?.find((item) => item.portable === declaration?.field);
    if (!mapping
      || !record
      || !field
      || !CHOICE_PROVIDER_TYPES.has(field.providerType)
      || field.valueMapping !== 'configured-bijection'
      || declaration.mode !== 'exact-bijection'
      || !Array.isArray(declaration.entries)
      || declaration.entries.length < 1
      || declaration.entries.length > 200) {
      throw providerError(
        'validation',
        'A configured Notion option mapping does not resolve one exact declared choice field.'
      );
    }
    const key = optionMappingKey(mapping.id, record.id, field.portable);
    if (scopes.has(key)) {
      throw providerError(
        'validation',
        'Configured Notion option mappings contain a duplicate field scope.'
      );
    }
    if (unavailableFieldScopes.has(key)) {
      throw providerError(
        'validation',
        'Private Notion configuration maps option values for an unavailable provider field.'
      );
    }
    const portableToProvider = new Map();
    const providerToPortable = new Map();
    for (const entry of declaration.entries) {
      const portable = exactOptionName(entry?.portable, 'Portable Notion option');
      const provider = exactOptionName(entry?.provider, 'Provider Notion option');
      if (portableToProvider.has(portable) || providerToPortable.has(provider)) {
        throw providerError(
          'validation',
          'Configured Notion option mappings must be exact bijections.'
        );
      }
      portableToProvider.set(portable, provider);
      providerToPortable.set(provider, portable);
    }
    scopes.set(key, { portableToProvider, providerToPortable });
  }
  return scopes;
}

function exactOptionMapping(scopes, mapping, definition, field) {
  if (!CHOICE_PROVIDER_TYPES.has(field.providerType)
    || field.valueMapping !== 'configured-bijection') {
    throw providerError(
      'validation',
      'Notion choice translation requires one declared configured-bijection field.'
    );
  }
  const scope = scopes.get(optionMappingKey(mapping.id, definition.id, field.portable));
  if (!scope) {
    throw providerError(
      'validation',
      'Private Notion configuration does not map one required portable choice field.'
    );
  }
  return scope;
}

function mappedOptionValue(scopes, mapping, definition, field, value, direction) {
  if (value === null) return null;
  const scope = exactOptionMapping(scopes, mapping, definition, field);
  const selected = direction === 'provider'
    ? scope.portableToProvider
    : scope.providerToPortable;
  const mapped = selected.get(exactOptionName(
    value,
    direction === 'provider' ? 'Portable Notion option' : 'Provider Notion option'
  ));
  if (mapped === undefined) {
    throw providerError(
      'validation',
      'Private Notion configuration does not map one exact choice value.'
    );
  }
  return mapped;
}

function mappedChoiceValue(scopes, mapping, definition, field, value, direction) {
  if (!CHOICE_PROVIDER_TYPES.has(field.providerType) || value === null) return value;
  if (field.providerType === 'multi_select') {
    if (!Array.isArray(value)) {
      throw providerError(
        'validation',
        'Notion multi-select translation requires an array of portable values.'
      );
    }
    return value.map((item) => {
      return mappedOptionValue(scopes, mapping, definition, field, item, direction);
    });
  }
  return mappedOptionValue(scopes, mapping, definition, field, value, direction);
}

function sqlIdentifier(value) {
  return '"' + String(value).replaceAll('"', '""') + '"';
}

function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function declaredRecordMapping(mapping, type, capability) {
  const matches = mapping.recordTypes.filter((item) => {
    return item.id === type && item.capabilities?.includes(capability);
  });
  if (matches.length !== 1) {
    throw providerError('validation', 'Notion mapping does not declare record type ' + type + '.');
  }
  return matches[0];
}

function fieldBindingKey(mapping, recordType, field) {
  return [mapping, recordType, field].join('\0');
}

function configuredFieldBindings(settings, mappings) {
  const configured = notionConfiguration(settings);
  const declarations = configured.fieldBindings;
  if (declarations === undefined) return new Map();
  if (!Array.isArray(declarations)
    || declarations.length < 1
    || declarations.length > 500) {
    throw providerError(
      'validation',
      'integration.notion.fieldBindings must be one bounded non-empty array.'
    );
  }
  const mappingById = new Map((mappings || []).map((mapping) => [mapping.id, mapping]));
  const scopes = new Map();
  const providerFields = new Map();
  for (const declaration of declarations) {
    const mapped = declaration?.state === 'mapped';
    const unavailable = declaration?.state === 'unavailable';
    const validKeys = mapped
      ? exactKeys(
        declaration,
        ['mapping', 'recordType', 'field', 'state', 'provider'],
        ['mapping', 'recordType', 'field', 'state', 'provider']
      )
      : unavailable && exactKeys(
        declaration,
        ['mapping', 'recordType', 'field', 'state', 'reasonCode'],
        ['mapping', 'recordType', 'field', 'state', 'reasonCode']
      );
    const mapping = mappingById.get(declaration?.mapping);
    const records = mapping?.recordTypes?.filter((item) => {
      return item.id === declaration?.recordType;
    }) || [];
    const fields = records.flatMap((record) => {
      return record.fields.filter((field) => field.portable === declaration?.field);
    });
    if (!validKeys
      || !mapping
      || records.length !== 1
      || fields.length !== 1
      || (unavailable
        && declaration.reasonCode !== 'PROVIDER_PROPERTY_UNAVAILABLE')) {
      throw providerError(
        'validation',
        'A configured Notion field binding does not resolve one exact declared portable field.'
      );
    }
    const key = fieldBindingKey(
      declaration.mapping,
      declaration.recordType,
      declaration.field
    );
    if (scopes.has(key)) {
      throw providerError(
        'validation',
        'Configured Notion field bindings contain a duplicate field scope.'
      );
    }
    if (mapped) {
      const provider = exactOptionName(
        declaration.provider,
        'Configured Notion provider property'
      );
      const recordKey = [declaration.mapping, declaration.recordType].join('\0');
      if (!providerFields.has(recordKey)) providerFields.set(recordKey, new Set());
      if (providerFields.get(recordKey).has(provider)) {
        throw providerError(
          'validation',
          'Configured Notion field bindings map multiple portable fields to one provider property.'
        );
      }
      providerFields.get(recordKey).add(provider);
      scopes.set(key, { state: 'mapped', provider });
      continue;
    }
    scopes.set(key, {
      state: 'unavailable',
      reasonCode: declaration.reasonCode
    });
  }
  return scopes;
}

function recordMapping(mapping, type, capability, settings, mappings) {
  const definition = declaredRecordMapping(mapping, type, capability);
  const target = notionSettings(settings)[definition.target];
  if (typeof target !== 'string' || !target.startsWith('collection://')) {
    return definition;
  }
  const bindings = configuredFieldBindings(settings, mappings);
  const fields = definition.fields.flatMap((field) => {
    const binding = bindings.get(fieldBindingKey(mapping.id, definition.id, field.portable));
    if (!binding) {
      throw providerError(
        'validation',
        'Private Notion configuration omits one required connected field binding: '
          + mapping.id + '/' + definition.id + '/' + field.portable + '.'
      );
    }
    return binding.state === 'mapped'
      ? [{ ...field, provider: binding.provider }]
      : [];
  });
  if (fields.length < 1) {
    throw providerError(
      'validation',
      'Private Notion configuration makes every field unavailable for '
        + mapping.id + '/' + definition.id + '.'
    );
  }
  return { ...definition, fields };
}

function requestLimit(input) {
  const value = input.limit ?? 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw providerError('validation', 'Notion record reads require limit from 1 through 100.');
  }
  return value;
}

function requestedRecordTypes(input) {
  const plural = Array.isArray(input?.recordTypes) ? input.recordTypes : null;
  const singular = typeof input?.recordType === 'string' ? [input.recordType] : null;
  if ((plural && singular) || (!plural && !singular)) {
    throw providerError(
      'validation',
      'Notion record reads require exactly one declared recordType or recordTypes shape.'
    );
  }
  const recordTypes = plural || singular;
  if (recordTypes.length !== 1
    || recordTypes.some((recordType) => typeof recordType !== 'string' || !recordType.trim())) {
    throw providerError(
      'validation',
      'Connected Notion record reads require exactly one non-empty record type per host call.'
    );
  }
  return recordTypes;
}

function exactRecordUpdatePatch(input) {
  requiredObject(input, 'Notion record update');
  if (!exactKeys(
    input,
    ['recordType', 'id', 'expectedVersion', 'patch'],
    ['recordType', 'id', 'expectedVersion', 'patch']
  )) {
    throw providerError(
      'validation',
      'Notion record updates require one closed exact record identity, expected version, and patch.'
    );
  }
  requiredString(input.recordType, 'Notion update record type');
  requiredString(input.id, 'Notion update record identity');
  requiredString(input.expectedVersion, 'Notion update expected version');
  if (input.recordType.trim() !== input.recordType
    || input.id.trim() !== input.id
    || input.expectedVersion.trim() !== input.expectedVersion) {
    throw providerError(
      'validation',
      'Notion record update identities and expected versions must be exact trimmed values.'
    );
  }
  const patch = requiredObject(input.patch, 'Notion update patch');
  const changedFields = Object.keys(patch).sort(compareCodepoint);
  if (changedFields.length < 1) {
    throw providerError('validation', 'Notion update patch must contain at least one exact field.');
  }
  return changedFields;
}

function exactProjectContentRead(capability, input, mapping, settings, mappings) {
  if (!Object.hasOwn(input || {}, 'content')) return null;
  const content = input.content;
  const recordTypes = requestedRecordTypes(input);
  if (capability !== 'projects.records.read'
    || !content
    || typeof content !== 'object'
    || Array.isArray(content)
    || !exactKeys(content, ['expectedTitle'], ['expectedTitle'])
    || typeof content.expectedTitle !== 'string'
    || !content.expectedTitle
    || content.expectedTitle.trim() !== content.expectedTitle
    || content.expectedTitle.length > 200
    || !Array.isArray(input.ids)
    || input.ids.length !== 1
    || input.limit !== 1) {
    throw providerError(
      'validation',
      'Connected Notion Project content reads require one exact record type, id, expected title, and limit.'
    );
  }
  const definition = recordMapping(
    mapping,
    recordTypes[0],
    capability,
    settings,
    mappings
  );
  if (definition.content?.portable !== 'body'
    || definition.content.provider !== 'page-content'
    || definition.content.providerType !== 'markdown') {
    throw providerError(
      'validation',
      'Connected Notion Project content reads require one exact mapped markdown page-content route.'
    );
  }
  const titleFields = definition.fields.filter((field) => field.providerType === 'title');
  if (titleFields.length !== 1) {
    throw providerError(
      'validation',
      'Connected Notion Project content reads require one exact mapped title field.'
    );
  }
  return {
    definition,
    expectedTitle: content.expectedTitle,
    requestedId: input.ids[0],
    titleField: titleFields[0]
  };
}

const OPAQUE_PROVIDER_PERSON_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HYPHENATED_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const COMPACT_UUID = /^[0-9A-Fa-f]{32}$/;
const UUID_URN_PREFIX = /^urn:uuid:/i;
const USER_RESERVED_PREFIX = /^user:/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function exactProviderPersonId(value, label) {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw providerError(
      'validation',
      label + ' must be one opaque non-empty provider person identity.'
    );
  }
  if (HYPHENATED_UUID.test(value)) {
    const canonical = value.toLowerCase();
    if (canonical !== NIL_UUID && value === canonical) return value;
    throw providerError(
      'validation',
      label + ' must be one opaque non-empty provider person identity.'
    );
  }
  if (COMPACT_UUID.test(value)
    || UUID_URN_PREFIX.test(value)
    || USER_RESERVED_PREFIX.test(value)) {
    throw providerError(
      'validation',
      label + ' must be one opaque non-empty provider person identity.'
    );
  }
  if (OPAQUE_PROVIDER_PERSON_ID.test(value)) return value;
  throw providerError(
    'validation',
    label + ' must be one opaque non-empty provider person identity.'
  );
}

function exactProviderPersonIds(value, label) {
  if (!Array.isArray(value)) {
    throw providerError('validation', label + ' must be an array of provider person identities.');
  }
  const identities = value.map((item, index) => {
    return exactProviderPersonId(item, label + '[' + index + ']');
  });
  if (new Set(identities).size !== identities.length) {
    throw providerError('validation', label + ' contains duplicate provider person identities.');
  }
  return identities.sort(compareCodepoint);
}

function canonicalDecodedProviderPersonId(value, label) {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw providerError(
      'validation',
      label + ' must be one opaque provider person identity or exact user:// UUID identity.'
    );
  }
  if (HYPHENATED_UUID.test(value)) {
    const canonical = value.toLowerCase();
    if (canonical !== NIL_UUID) return canonical;
    throw providerError(
      'validation',
      label + ' must be one opaque provider person identity or exact user:// UUID identity.'
    );
  }
  if (COMPACT_UUID.test(value) || UUID_URN_PREFIX.test(value)) {
    throw providerError(
      'validation',
      label + ' must be one opaque provider person identity or exact user:// UUID identity.'
    );
  }
  const prefix = 'user://';
  if (value.startsWith(prefix)) {
    const identity = value.slice(prefix.length);
    if (HYPHENATED_UUID.test(identity)) {
      const canonical = identity.toLowerCase();
      if (canonical !== NIL_UUID) return canonical;
    }
  }
  if (USER_RESERVED_PREFIX.test(value)) {
    throw providerError(
      'validation',
      label + ' must be one opaque provider person identity or exact user:// UUID identity.'
    );
  }
  if (OPAQUE_PROVIDER_PERSON_ID.test(value)) return value;
  throw providerError(
    'validation',
    label + ' must be one opaque provider person identity or exact user:// UUID identity.'
  );
}

function canonicalDecodedProviderPersonIds(value, label) {
  if (!Array.isArray(value)) {
    throw providerError('validation', label + ' must be an array of provider person identities.');
  }
  const identities = value.map((item, index) => {
    return canonicalDecodedProviderPersonId(item, label + '[' + index + ']');
  });
  if (new Set(identities).size !== identities.length) {
    throw providerError(
      'validation',
      label + ' contains duplicate canonical provider person identities.'
    );
  }
  return identities.sort(compareCodepoint);
}

function canonicalRelationIdentity(value, label) {
  const pageId = exactNotionPageId(value);
  if (!pageId) {
    throw providerError(
      'validation',
      label + ' must be an exact Notion page URL or UUID identity.'
    );
  }
  return 'https://www.notion.so/' + pageId.replaceAll('-', '').toLowerCase();
}

function canonicalRelationIdentities(value, label) {
  if (!Array.isArray(value)) {
    throw providerError('validation', label + ' must be an array of Notion page identities.');
  }
  const identities = value.map((item, index) => {
    return canonicalRelationIdentity(item, label + '[' + index + ']');
  }).sort(compareCodepoint);
  if (new Set(identities).size !== identities.length) {
    throw providerError(
      'validation',
      label + ' contains duplicate aliases for one Notion page identity.'
    );
  }
  return identities;
}

function normalizedMappedIdentityValue(field, value) {
  if (value === null) return null;
  const label = 'Notion mapped field ' + field.portable;
  if (field.providerType === 'relation') {
    return field.decode === 'json'
      ? canonicalRelationIdentities(value, label)
      : canonicalRelationIdentity(value, label);
  }
  if (field.providerType === 'person') {
    return field.decode === 'json'
      ? exactProviderPersonIds(value, label)
      : exactProviderPersonId(value, label);
  }
  return value;
}

function normalizedDecodedMappedIdentityValue(field, value) {
  if (value === null || field.providerType !== 'person') {
    return normalizedMappedIdentityValue(field, value);
  }
  const label = 'Notion mapped field ' + field.portable;
  return field.decode === 'json'
    ? canonicalDecodedProviderPersonIds(value, label)
    : canonicalDecodedProviderPersonId(value, label);
}

function normalizedPortableWriteFields(definition, values) {
  const fields = new Map(definition.fields.map((field) => [field.portable, field]));
  return Object.fromEntries(Object.entries(values).map(([portable, value]) => {
    const field = fields.get(portable);
    if (!field) {
      throw providerError(
        'validation',
        'Notion normalized write output contains unmapped field '
          + definition.id + '.' + portable + '.'
      );
    }
    const normalized = normalizedMappedIdentityValue(field, value);
    return [portable, Array.isArray(normalized) ? [...normalized] : normalized];
  }));
}

function encodedProperty(field, value) {
  if (value === null) return null;
  const normalized = normalizedMappedIdentityValue(field, value);
  if (field.decode === 'json') {
    if (!Array.isArray(normalized)
      || normalized.some((item) => typeof item !== 'string')) {
      throw providerError(
        'validation',
        'Notion mapped field ' + field.portable + ' requires an array of strings.'
      );
    }
    if (field.providerType === 'relation' || field.providerType === 'person') {
      return [...normalized];
    }
    return JSON.stringify(normalized);
  }
  if (field.providerType === 'checkbox') return normalized ? '__YES__' : '__NO__';
  if (!['string', 'number', 'boolean'].includes(typeof normalized)) {
    throw providerError(
      'validation',
      'Notion mapped field ' + field.portable + ' requires a scalar value.'
    );
  }
  return normalized;
}

function providerReadColumn(field) {
  return field.providerType === 'date'
    ? 'date:' + field.provider + ':start'
    : field.provider;
}

function mappedProperties({
  mapping,
  definition,
  values,
  label,
  writeOperation,
  optionMappings
}) {
  const fields = new Map(definition.fields.map((field) => [field.portable, field]));
  const properties = {};
  for (const [portable, value] of Object.entries(values)) {
    const field = fields.get(portable);
    if (!field) {
      throw providerError(
        'validation',
        label + ' contains unmapped field ' + definition.id + '.' + portable + '.'
      );
    }
    if (field.writeOperations && !field.writeOperations.includes(writeOperation)) {
      throw providerError(
        'validation',
        label + ' cannot use field outside its declared write scope: '
          + definition.id + '.' + portable + '.'
      );
    }
    if (field.providerType === 'date') {
      if (value !== null && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
        throw providerError(
          'validation',
          'Notion mapped field ' + field.portable + ' requires a YYYY-MM-DD calendar date.'
        );
      }
      properties['date:' + field.provider + ':start'] = value;
      if (value !== null) properties['date:' + field.provider + ':is_datetime'] = 0;
      continue;
    }
    properties[field.provider] = encodedProperty(
      field,
      mappedChoiceValue(
        optionMappings,
        mapping,
        definition,
        field,
        value,
        'provider'
      )
    );
  }
  return properties;
}

function targetForRecord(settings, definition) {
  const target = requiredString(
    notionSettings(settings)[definition.target],
    'Notion target ' + definition.target
  );
  if (!/^collection:\/\/[a-f0-9-]{32,36}$/.test(target)) {
    throw providerError('validation', 'Notion target ' + definition.target + ' is not a collection URI.');
  }
  return target;
}

const NOTION_BARE_PAGE_ID =
  /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const NOTION_PAGE_PATH_ID =
  /(?:^|-)([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const APP_NOTION_PAGE_URL =
  /^https:\/\/app\.notion\.com\/(?:p\/)?([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\?[^#]*)?$/i;

function parsedUrl(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function exactNotionPageId(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value) return null;
  if (NOTION_BARE_PAGE_ID.test(value)) return value;
  const exactAppMatch = APP_NOTION_PAGE_URL.exec(value);
  if (exactAppMatch) return exactAppMatch[1];
  const parsed = parsedUrl(value);
  if (parsed === null) return null;
  const notionHost = parsed.hostname === 'notion.so'
    || parsed.hostname === 'www.notion.so'
    || parsed.hostname === 'app.notion.com'
    || /^[a-z0-9-]+\.notion\.site$/i.test(parsed.hostname);
  if (parsed.protocol !== 'https:'
    || !notionHost
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.hash) {
    return null;
  }
  if (parsed.hostname === 'app.notion.com') {
    return null;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const match = segments.at(-1)?.match(NOTION_PAGE_PATH_ID);
  return match ? match[1] : null;
}

function notionPageId(value) {
  const id = requiredString(value, 'Notion record id');
  const pageId = exactNotionPageId(id);
  if (!pageId) {
    throw providerError('validation', 'Notion page operations require a page URL or UUID record id.');
  }
  return pageId;
}

function normalizedNotionPageId(value) {
  return notionPageId(value).replaceAll('-', '').toLowerCase();
}

function canonicalNotionPageUri(value) {
  return 'https://www.notion.so/' + normalizedNotionPageId(value);
}

function normalizedDataSourceId(value, label) {
  const id = requiredString(value, label);
  if (!NOTION_BARE_PAGE_ID.test(id) || id.trim() !== id) {
    throw providerError('validation', label + ' must be one exact Notion data-source identity.');
  }
  return id.replaceAll('-', '').toLowerCase();
}

function assertQueryDataSourceBinding({
  payload,
  responseProfile,
  settings,
  definition
}) {
  if (!Object.hasOwn(payload, 'data_source_ids')) {
    if (responseProfile === CLAUDE_RESPONSE_PROFILE) {
      throw providerError(
        'validation',
        'The direct Claude query omitted its exact data-source identity.'
      );
    }
    return;
  }
  if (!Array.isArray(payload.data_source_ids) || payload.data_source_ids.length !== 1) {
    throw providerError(
      'validation',
      'The Notion query must identify exactly one selected data source.'
    );
  }
  const observed = normalizedDataSourceId(
    payload.data_source_ids[0],
    'Notion observed data source'
  );
  const expected = normalizedDataSourceId(
    targetForRecord(settings, definition).slice('collection://'.length),
    'Notion configured data source'
  );
  if (observed !== expected) {
    throw providerError(
      'conflict',
      'The Notion query result came from outside the exact configured data source.'
    );
  }
}

function optionalNormalizedNotionPageId(value) {
  const pageId = exactNotionPageId(value);
  return pageId ? pageId.replaceAll('-', '').toLowerCase() : null;
}

function exactObservedPageIdentity(value, label) {
  const page = requiredObject(value, label);
  const identities = ['url', 'id', 'page_id', 'pageId']
    .filter((key) => Object.hasOwn(page, key))
    .map((key) => requiredString(page[key], label + ' ' + key));
  if (identities.length === 0) {
    throw providerError('validation', label + ' omitted its provider page identity.');
  }
  const normalized = identities.map((identity) => normalizedNotionPageId(identity));
  if (new Set(normalized).size !== 1) {
    throw providerError('conflict', label + ' returned conflicting provider page identities.');
  }
  return {
    value: 'https://www.notion.so/' + normalized[0],
    normalized: normalized[0]
  };
}

function exactCreatedPage(payload) {
  const response = requiredObject(payload, 'Notion create response');
  if (!Array.isArray(response.pages) || response.pages.length !== 1) {
    throw providerError(
      'validation',
      'Notion create must return exactly one created page.'
    );
  }
  return exactObservedPageIdentity(response.pages[0], 'Notion created page');
}

function normalizedNotionInlineTitle(value) {
  if (typeof value !== 'string') return null;
  let normalized = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const escaped = value[index + 1];
    if (character === '\\' && ['\\', '[', ']'].includes(escaped)) {
      normalized += escaped;
      index += 1;
      continue;
    }
    normalized += character;
  }
  return normalized;
}

function exactPageProperties(propertiesText) {
  if (propertiesText.length > 100000) {
    throw providerError(
      'validation',
      'Notion document properties exceed the bounded page-property limit.'
    );
  }
  const properties = requiredObject(
    parseJsonText(propertiesText, 'Notion document properties'),
    'Notion document properties'
  );
  if (Object.keys(properties).length > 500) {
    throw providerError(
      'validation',
      'Notion document properties exceed the bounded property-count limit.'
    );
  }
  return properties;
}

function exactPagePropertyTitle(properties, expectedTitle) {
  if (Object.hasOwn(properties, 'title')) {
    if (normalizedNotionInlineTitle(properties.title) !== expectedTitle) {
      throw providerError(
        'conflict',
        'Notion document title property does not match the exact requested definition.'
      );
    }
    return expectedTitle;
  }
  const databaseTitleCandidates = Object.values(properties).filter((value) => {
    return normalizedNotionInlineTitle(value) === expectedTitle;
  });
  if (databaseTitleCandidates.length !== 1) {
    throw providerError(
      'conflict',
      'Notion database document properties do not identify one exact requested title.'
    );
  }
  return expectedTitle;
}

function exactNotionPagePreambleUrl(preambleUrl, payloadUrl) {
  let preambleIdentity;
  let payloadIdentity;
  try {
    preambleIdentity = exactNotionPageId(preambleUrl);
    payloadIdentity = exactNotionPageId(payloadUrl);
  } catch {
    return false;
  }
  if (!preambleIdentity || !payloadIdentity || preambleIdentity !== payloadIdentity) return false;
  if (preambleUrl === payloadUrl) return true;

  const parsedPreambleUrl = parsedUrl(preambleUrl);
  const parsedPayloadUrl = parsedUrl(payloadUrl);
  return Boolean(
    parsedPreambleUrl
    && parsedPayloadUrl
    && !parsedPreambleUrl.search
    && parsedPayloadUrl.search
    && !parsedPreambleUrl.hash
    && !parsedPayloadUrl.hash
    && parsedPreambleUrl.origin === parsedPayloadUrl.origin
    && parsedPreambleUrl.pathname === parsedPayloadUrl.pathname
  );
}

function exactNotionPagePreamble(preamble, payloadUrl) {
  if (!preamble) return;
  if (preamble.length > 10000 || /[<>]/u.test(preamble)) {
    throw providerError(
      'validation',
      'Notion document content does not match the observed bounded page envelope.'
    );
  }
  const match = /^Here is the result of "view" for the Page with URL (\S+) as of (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):$/u
    .exec(preamble);
  const observedAt = match?.[2];
  const observedTime = Date.parse(observedAt || '');
  if (!match
    || !exactNotionPagePreambleUrl(match[1], payloadUrl)
    || !Number.isFinite(observedTime)
    || new Date(observedTime).toISOString() !== observedAt) {
    throw providerError(
      'validation',
      'Notion document content does not match the exact observed page preamble.'
    );
  }
}

function notionPageEnvelopeIdentity(pageOpen) {
  if (typeof pageOpen !== 'string'
    || pageOpen.length > 4096
    || !pageOpen.startsWith('<page ')
    || !pageOpen.endsWith('>')) {
    throw providerError(
      'validation',
      'Notion document page envelope must contain one exact page identity and optional bounded icon and color.'
    );
  }
  const source = pageOpen.slice('<page '.length, -1);
  const attributes = [];
  let cursor = 0;
  while (cursor < source.length) {
    const match = /^([a-z][a-z0-9-]*)="([^"]*)"/u.exec(source.slice(cursor));
    if (!match) {
      throw providerError(
        'validation',
        'Notion document page envelope must contain one exact page identity and optional bounded icon and color.'
      );
    }
    attributes.push({ name: match[1], value: match[2] });
    cursor += match[0].length;
    if (cursor === source.length) break;
    if (source[cursor] !== ' ' || source[cursor + 1] === ' ') {
      throw providerError(
        'validation',
        'Notion document page envelope must contain one exact page identity and optional bounded icon and color.'
      );
    }
    cursor += 1;
  }
  const names = attributes.map((attribute) => attribute.name);
  const identities = attributes.filter((attribute) => {
    return attribute.name === 'url' || attribute.name === 'id';
  });
  const icons = attributes.filter((attribute) => attribute.name === 'icon');
  const colors = attributes.filter((attribute) => attribute.name === 'color');
  const icon = icons[0]?.value;
  const color = colors[0]?.value;
  if (attributes.length < 1
    || attributes.length > 3
    || new Set(names).size !== names.length
    || identities.length !== 1
    || icons.length > 1
    || colors.length > 1
    || attributes.some((attribute) => {
      return !['url', 'id', 'icon', 'color'].includes(attribute.name);
    })
    || (color !== undefined && !NOTION_MARKDOWN_COLORS.has(color))
    || (icon !== undefined
      && (icon.length < 1
        || icon.length > 64
        || icon.trim() !== icon
        || /[\p{Cc}<>&]/u.test(icon)
        || /\b(?:secret_[A-Za-z0-9]{24,}|ntn_[A-Za-z0-9]{24,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{24,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/u.test(icon)))) {
    throw providerError(
      'validation',
      'Notion document page envelope must contain one exact page identity and optional bounded icon and color.'
    );
  }
  return normalizedNotionPageId(identities[0].value);
}

function exactNotionPageEnvelopeIdentity(pageOpen, expectedIdentity) {
  const observedIdentity = notionPageEnvelopeIdentity(pageOpen);
  if (observedIdentity !== expectedIdentity) {
    throw providerError(
      'conflict',
      'Notion document page envelope identifies a different page.'
    );
  }
}

function boundedNotionPageEnvelope(envelope, pageStart) {
  let cursor = pageStart;
  let depth = 0;
  let outerOpenEnd = -1;
  while (cursor < envelope.length) {
    const nextOpen = envelope.indexOf('<page', cursor);
    const nextClose = envelope.indexOf('</page', cursor);
    let tagStart;
    let kind;
    if (nextOpen < 0 && nextClose < 0) break;
    if (nextClose >= 0 && (nextOpen < 0 || nextClose < nextOpen)) {
      tagStart = nextClose;
      kind = 'close';
    } else {
      tagStart = nextOpen;
      kind = 'open';
    }
    if (kind === 'open') {
      if (!envelope.startsWith('<page ', tagStart)) {
        throw providerError(
          'validation',
          'Notion document content does not match the observed bounded page envelope.'
        );
      }
      const tagEnd = envelope.indexOf('>', tagStart);
      if (tagEnd < 0) {
        throw providerError(
          'validation',
          'Notion document content does not match the observed bounded page envelope.'
        );
      }
      notionPageEnvelopeIdentity(envelope.slice(tagStart, tagEnd + 1));
      depth += 1;
      if (depth === 1) {
        if (tagStart !== pageStart) {
          throw providerError(
            'validation',
            'Notion document content does not match the observed bounded page envelope.'
          );
        }
        outerOpenEnd = tagEnd;
      }
      cursor = tagEnd + 1;
      continue;
    }
    if (!envelope.startsWith('</page>', tagStart) || depth < 1) {
      throw providerError(
        'validation',
        'Notion document content does not match the observed bounded page envelope.'
      );
    }
    depth -= 1;
    const tagEnd = tagStart + '</page>'.length;
    if (depth === 0) {
      if (tagEnd !== envelope.length) {
        throw providerError(
          'validation',
          'Notion document content does not match the observed bounded page envelope.'
        );
      }
      return {
        outerOpenEnd,
        outerCloseStart: tagStart
      };
    }
    cursor = tagEnd;
  }
  throw providerError(
    'validation',
    'Notion document content does not match the observed bounded page envelope.'
  );
}

function normalizedPageContent(payload, input) {
  if (payload?.metadata?.type !== 'page') {
    throw providerError('validation', 'Notion document fetch did not return page metadata.');
  }
  requiredString(payload.title, 'Notion document display title');
  const expectedTitle = requiredString(input.expectedTitle, 'Notion expected document title');
  const payloadUrl = requiredString(payload.url, 'Notion document URL');
  const observed = exactObservedPageIdentity(payload, 'Notion fetched document');
  const providerUri = observed.value;
  if (observed.normalized !== normalizedNotionPageId(input.uri)) {
    throw providerError(
      'conflict',
      'Notion document identity does not match the exact requested definition.'
    );
  }
  const envelope = requiredString(payload.text, 'Notion document content').trim();
  const pageStart = envelope.indexOf('<page ');
  const preamble = pageStart >= 0 ? envelope.slice(0, pageStart).trim() : '';
  if (pageStart < 0) {
    throw providerError(
      'validation',
      'Notion document content does not match the observed bounded page envelope.'
    );
  }
  const pageEnvelope = boundedNotionPageEnvelope(envelope, pageStart);
  const pageOpenEnd = pageEnvelope.outerOpenEnd;
  const pageEnd = pageEnvelope.outerCloseStart;
  const propertiesStart = envelope.indexOf('<properties>', pageOpenEnd + 1);
  const propertiesEnd = envelope.indexOf('</properties>', pageOpenEnd + 1);
  const ancestryMetadata = propertiesStart > pageOpenEnd
    ? envelope.slice(pageOpenEnd + 1, propertiesStart)
    : '';
  if (propertiesStart <= pageOpenEnd
    || propertiesEnd < propertiesStart
    || propertiesEnd + '</properties>'.length > pageEnd
    || ancestryMetadata.length > 10000
    || ancestryMetadata.includes('<page')
    || ancestryMetadata.includes('</page')) {
    throw providerError(
      'validation',
      'Notion document content does not match the observed bounded page envelope.'
    );
  }
  exactNotionPagePreamble(preamble, payloadUrl);
  exactNotionPageEnvelopeIdentity(
    envelope.slice(pageStart, pageOpenEnd + 1),
    observed.normalized
  );
  const propertiesText = envelope.slice(
    propertiesStart + '<properties>'.length,
    propertiesEnd
  ).trim();
  const properties = exactPageProperties(propertiesText);
  const title = exactPagePropertyTitle(properties, expectedTitle);
  const body = envelope.slice(propertiesEnd + '</properties>'.length, pageEnd).trim();
  if (!body || body.length > 250000) {
    throw providerError('validation', 'Notion document body is empty or outside the bounded content limit.');
  }
  return { title, providerUri, body, properties };
}

function documentUpdates(input) {
  requiredString(input.expectedTitle, 'Notion expected document title');
  if (!/^sha256:[a-f0-9]{64}$/.test(input.expectedBodyFingerprint || '')
    || !Array.isArray(input.updates)
    || input.updates.length < 1
    || input.updates.length > 20
    || new Set(input.updates.map((update) => update.id)).size !== input.updates.length
    || new Set(input.updates.map((update) => update.oldText)).size !== input.updates.length) {
    throw providerError('validation', 'Notion document updates require one exact reviewed body and unique replacements.');
  }
  return input.updates.map((update) => {
    if (!update || typeof update !== 'object' || Array.isArray(update)
      || typeof update.oldText !== 'string' || !update.oldText
      || typeof update.newText !== 'string' || !update.newText
      || update.oldText === update.newText
      || update.replaceAllMatches !== false) {
      throw providerError('validation', 'Notion document updates require one exact changing replacement.');
    }
    return {
      old_str: update.oldText,
      new_str: update.newText,
      replace_all_matches: false
    };
  });
}

function exactRecordReadIdentityScope(ids) {
  if (!ids) return null;
  const normalized = ids.map(optionalNormalizedNotionPageId);
  if (normalized.some((identity) => identity === null)) {
    throw providerError(
      'validation',
      'Connected Notion exact record reads require exact Notion page URL or UUID identities.'
    );
  }
  if (new Set(normalized).size !== normalized.length) {
    throw providerError(
      'validation',
      'Notion exact record reads contain duplicate normalized requested identities.'
    );
  }
  return {
    providerIdentityMode: true,
    comparisons: normalized,
    originals: ids,
    canonicalIds: normalized.map((identity) => 'https://www.notion.so/' + identity)
  };
}

function selectForType({
  mapping,
  definition,
  target,
  input,
  identityScope,
  params,
  optionMappings
}) {
  const fieldSql = definition.fields.flatMap((field) => {
    return [sqlString(field.portable), sqlIdentifier(providerReadColumn(field))];
  }).join(', ');
  const clauses = [];
  if (identityScope) {
    const identityExpression = identityScope.providerIdentityMode
      ? "lower(substr(replace(url, '-', ''), -32))"
      : 'url';
    clauses.push(
      identityExpression + ' IN ('
        + identityScope.comparisons.map(() => '?').join(', ') + ')'
    );
    params.push(...identityScope.comparisons);
  }
  for (const [portable, value] of Object.entries(input.filters || {})) {
    const fields = definition.fields.filter((field) => field.portable === portable);
    if (fields.length !== 1) {
      throw providerError(
        'validation',
        'Notion mapping does not expose filter field ' + portable + ' for ' + definition.id + '.'
      );
    }
    const normalized = normalizedMappedIdentityValue(fields[0], value);
    clauses.push(sqlIdentifier(providerReadColumn(fields[0])) + ' = ?');
    params.push(String(mappedChoiceValue(
      optionMappings,
      mapping,
      definition,
      fields[0],
      normalized,
      'provider'
    )));
  }
  if (input.filtersAny) {
    const alternatives = input.filtersAny.map((candidate) => {
      const parts = [];
      for (const [portable, value] of Object.entries(candidate)) {
        const fields = definition.fields.filter((field) => field.portable === portable);
        if (fields.length !== 1) {
          throw providerError(
            'validation',
            'Notion mapping does not expose alternative filter field ' + portable
              + ' for ' + definition.id + '.'
          );
        }
        const normalized = normalizedMappedIdentityValue(fields[0], value);
        parts.push(sqlIdentifier(providerReadColumn(fields[0])) + ' = ?');
        params.push(String(mappedChoiceValue(
          optionMappings,
          mapping,
          definition,
          fields[0],
          normalized,
          'provider'
        )));
      }
      return '(' + parts.join(' AND ') + ')';
    });
    clauses.push('(' + alternatives.join(' OR ') + ')');
  }
  return 'SELECT '
    + sqlString(definition.id) + ' AS "__soterType", '
    + 'url AS "__soterId", '
    + 'json_object(' + fieldSql + ') AS "__soterFields" '
    + 'FROM ' + sqlIdentifier(target)
    + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '');
}

export function prepareMcp({ capability, input, settings, mappings }) {
  if (capability === 'workspace.identity.read') {
    if (input?.identity !== 'current-user') {
      throw providerError(
        'validation',
        'Notion workspace identity reads support only the authenticated current user.'
      );
    }
    return {
      tool: 'fetch',
      arguments: { id: 'self' }
    };
  }
  if (capability === 'documents.content.read') {
    requiredString(input.expectedTitle, 'Notion expected document title');
    return {
      tool: 'fetch',
      arguments: { id: normalizedNotionPageId(input.uri) }
    };
  }
  if (capability === 'documents.content.update') {
    return {
      tool: 'update_page',
      arguments: {
        page_id: notionPageId(input.uri),
        command: 'update_content',
        content_updates: documentUpdates(input)
      }
    };
  }
  const descriptor = parseRecordCapability(capability);
  if (!descriptor) {
    throw providerError('validation', 'Notion MCP adapter does not implement ' + capability + '.');
  }
  const mapping = mappingDocument(mappings, capability);
  const optionMappings = configuredOptionMappings(settings, mappings);
  if (descriptor.operation === 'schema-read') {
    const definition = recordMapping(mapping, input.recordType, capability, settings, mappings);
    return {
      tool: 'fetch',
      arguments: { id: targetForRecord(settings, definition) }
    };
  }
  if (descriptor.operation === 'create') {
    const definition = recordMapping(mapping, input.recordType, capability, settings, mappings);
    const properties = mappedProperties({
      mapping,
      definition,
      values: input.fields,
      label: 'Notion create',
      writeOperation: 'create',
      optionMappings
    });
    if (!definition.fields.some((field) => {
      return field.providerType === 'title' && Object.hasOwn(input.fields, field.portable);
    })) {
      throw providerError('validation', 'Notion create requires the mapped title field.');
    }
    const page = { properties };
    if (input.body !== undefined && input.body !== null) {
      if (definition.content?.portable !== 'body'
        || definition.content.provider !== 'page-content'
        || definition.content.providerType !== 'markdown'
        || typeof input.body !== 'string') {
        throw providerError(
          'validation',
          'Notion page content requires the exact mapped markdown page-content route.'
        );
      }
      page.content = input.body;
    }
    return {
      tool: 'create_pages',
      arguments: {
        parent: { data_source_id: targetForRecord(settings, definition).slice('collection://'.length) },
        pages: [page]
      }
    };
  }
  if (descriptor.operation === 'update') {
    exactRecordUpdatePatch(input);
    const definition = recordMapping(mapping, input.recordType, capability, settings, mappings);
    return {
      tool: 'update_page',
      arguments: {
        page_id: notionPageId(input.id),
        command: 'update_properties',
        properties: mappedProperties({
          mapping,
          definition,
          values: input.patch,
          label: 'Notion update',
          writeOperation: 'update',
          optionMappings
        })
      }
    };
  }
  if (descriptor.operation !== 'read') {
    throw providerError('validation', 'Notion MCP adapter does not implement ' + capability + '.');
  }
  const recordTypes = requestedRecordTypes(input);
  if (input.ids && (!Array.isArray(input.ids)
    || input.ids.length < 1
    || input.ids.length > 100
    || input.ids.some((id) => typeof id !== 'string' || !id.trim()))) {
    throw providerError('validation', 'Notion record ids must contain 1 through 100 non-empty strings.');
  }
  if (input.filters && input.filtersAny) {
    throw providerError('validation', 'Notion record reads cannot combine exact and alternative filters.');
  }
  if (input.filtersAny && (!Array.isArray(input.filtersAny)
    || input.filtersAny.length < 1
    || input.filtersAny.length > 12
    || input.filtersAny.some((candidate) => {
      return !candidate || typeof candidate !== 'object' || Array.isArray(candidate)
        || Object.keys(candidate).length < 1;
    }))) {
    throw providerError('validation', 'Notion alternative record filters must contain 1 through 12 non-empty objects.');
  }
  requiredObject(input.filters || {}, 'Notion record filters');
  const identityScope = exactRecordReadIdentityScope(input.ids);
  const contentRead = exactProjectContentRead(
    capability,
    input,
    mapping,
    settings,
    mappings
  );
  if (contentRead) {
    for (const [field, value] of Object.entries(input.filters || {})) {
      normalizedRequestedFilterValue(
        mapping,
        capability,
        contentRead.definition.id,
        field,
        value,
        settings,
        mappings
      );
    }
    for (const candidate of input.filtersAny || []) {
      for (const [field, value] of Object.entries(candidate)) {
        normalizedRequestedFilterValue(
          mapping,
          capability,
          contentRead.definition.id,
          field,
          value,
          settings,
          mappings
        );
      }
    }
    return {
      tool: 'fetch',
      arguments: { id: identityScope.comparisons[0] }
    };
  }
  const targets = notionSettings(settings);
  const params = [];
  const targetUris = [];
  const selects = recordTypes.map((type) => {
    const definition = recordMapping(mapping, type, capability, settings, mappings);
    const target = requiredString(targets[definition.target], 'Notion target ' + definition.target);
    if (!/^collection:\/\/[a-f0-9-]{32,36}$/.test(target)) {
      throw providerError('validation', 'Notion target ' + definition.target + ' is not a collection URI.');
    }
    targetUris.push(target);
    return selectForType({
      mapping,
      definition,
      target,
      input,
      identityScope,
      params,
      optionMappings
    });
  });
  const data = {
    mode: 'sql',
    data_source_urls: [...new Set(targetUris)],
    query: selects.join(' UNION ALL ') + ' LIMIT ' + requestLimit(input)
  };
  if (params.length) data.params = params;
  return { tool: 'query_data_sources', arguments: { data } };
}

function decodedFields(mapping, row, capability, optionMappings, settings, mappings) {
  const definition = recordMapping(
    mapping,
    row.__soterType,
    capability,
    settings,
    mappings
  );
  const raw = requiredObject(
    parseJsonText(row.__soterFields, 'Notion normalized field envelope'),
    'Notion normalized field envelope'
  );
  const fields = {};
  for (const field of definition.fields) {
    const value = Object.hasOwn(raw, field.portable) ? raw[field.portable] : null;
    const decoded = field.decode === 'json' && value !== null
      ? parseJsonText(value, 'Notion field ' + field.portable)
      : value;
    const normalized = normalizedDecodedMappedIdentityValue(field, decoded);
    fields[field.portable] = mappedChoiceValue(
      optionMappings,
      mapping,
      definition,
      field,
      normalized,
      'portable'
    );
  }
  return fields;
}

function decodedPageFieldValue(field, properties) {
  if (!Object.hasOwn(properties, field.provider)) {
    throw providerError(
      'validation',
      'Notion fetched Project content omitted mapped property ' + field.portable + '.'
    );
  }
  let value = properties[field.provider];
  if (field.decode === 'json' && typeof value === 'string') {
    value = parseJsonText(value, 'Notion fetched Project field ' + field.portable);
  }
  if (field.providerType === 'title') {
    value = normalizedNotionInlineTitle(value);
  }
  if (value === null) return null;
  if (field.decode === 'json') {
    if (!Array.isArray(value)
      || value.length > 100
      || value.some((item) => typeof item !== 'string')) {
      throw providerError(
        'validation',
        'Notion fetched Project field ' + field.portable
          + ' does not match its exact mapped array shape.'
      );
    }
    return value;
  }
  if (field.providerType === 'checkbox') {
    if (typeof value !== 'boolean') {
      throw providerError(
        'validation',
        'Notion fetched Project field ' + field.portable
          + ' does not match its exact mapped boolean shape.'
      );
    }
    return value;
  }
  if (typeof value !== 'string'
    || (field.providerType === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
    throw providerError(
      'validation',
      'Notion fetched Project field ' + field.portable
        + ' does not match its exact mapped scalar shape.'
    );
  }
  return value;
}

function decodedPageFields({
  mapping,
  definition,
  properties,
  expectedTitle,
  optionMappings
}) {
  const fields = {};
  for (const field of definition.fields) {
    const decoded = decodedPageFieldValue(field, properties);
    const normalized = normalizedDecodedMappedIdentityValue(field, decoded);
    fields[field.portable] = mappedChoiceValue(
      optionMappings,
      mapping,
      definition,
      field,
      normalized,
      'portable'
    );
  }
  const titleFields = definition.fields.filter((field) => field.providerType === 'title');
  if (titleFields.length !== 1
    || fields[titleFields[0].portable] !== expectedTitle) {
    throw providerError(
      'conflict',
      'Notion fetched Project title does not match the exact requested title.'
    );
  }
  return fields;
}

function normalizedRequestedFilterValue(
  mapping,
  capability,
  recordType,
  portable,
  value,
  settings,
  mappings
) {
  const definition = recordMapping(
    mapping,
    recordType,
    capability,
    settings,
    mappings
  );
  const fields = definition.fields.filter((field) => field.portable === portable);
  if (fields.length !== 1) {
    throw providerError(
      'validation',
      'Notion mapping does not expose filter field ' + portable + ' for ' + definition.id + '.'
    );
  }
  return normalizedMappedIdentityValue(fields[0], value);
}

function assertRequestedRecords(records, input, mapping, capability, settings, mappings) {
  const requestedTypes = new Set(requestedRecordTypes(input));
  let exactRecords = records;
  if (input.ids) {
    const identityScope = exactRecordReadIdentityScope(input.ids);
    const requestedIds = new Map(identityScope.comparisons.map((comparison, index) => {
      return [comparison, {
        id: identityScope.canonicalIds[index],
        requestedIdFingerprint: fingerprintJson(identityScope.originals[index])
      }];
    }));
    const observedIds = new Set();
    exactRecords = records.map((record) => {
      const comparison = optionalNormalizedNotionPageId(record.id);
      if (!comparison || observedIds.has(comparison) || !requestedIds.has(comparison)) {
        throw providerError(
          'validation',
          'Notion returned duplicate records or a substituted exact requested identity.'
        );
      }
      observedIds.add(comparison);
      const requested = requestedIds.get(comparison);
      return {
        ...record,
        id: requested.id,
        identityBinding: {
          state: 'exact-request',
          requestedIdFingerprint: requested.requestedIdFingerprint
        }
      };
    });
  } else {
    exactRecords = records.map((record) => {
      const normalized = optionalNormalizedNotionPageId(record.id);
      if (normalized === null) {
        throw providerError(
          'validation',
          'Connected Notion returned a record without an exact Notion page identity.'
        );
      }
      return {
        ...record,
        id: 'https://www.notion.so/' + normalized,
        identityBinding: {
          state: 'observed',
          requestedIdFingerprint: null
        }
      };
    });
  }
  const ids = exactRecords.map((record) => record.id);
  if (records.length > requestLimit(input)
    || new Set(ids).size !== ids.length
    || exactRecords.some((record) => !requestedTypes.has(record.type))) {
    throw providerError(
      'validation',
      'Notion returned duplicate records or records outside the exact requested type, id, or limit.'
    );
  }
  for (const record of exactRecords) {
    for (const [field, value] of Object.entries(input.filters || {})) {
      const normalized = normalizedRequestedFilterValue(
        mapping,
        capability,
        record.type,
        field,
        value,
        settings,
        mappings
      );
      if (fingerprintJson(record.fields[field]) !== fingerprintJson(normalized)) {
        throw providerError(
          'validation',
          'Notion returned a record that does not match requested filter ' + field + '.'
        );
      }
    }
    if (input.filtersAny && !input.filtersAny.some((candidate) => {
      return Object.entries(candidate).every(([field, value]) => {
        const normalized = normalizedRequestedFilterValue(
          mapping,
          capability,
          record.type,
          field,
          value,
          settings,
          mappings
        );
        return fingerprintJson(record.fields[field]) === fingerprintJson(normalized);
      });
    })) {
      throw providerError(
        'validation',
        'Notion returned a record outside every requested alternative filter.'
      );
    }
  }
  return exactRecords;
}

function schemaOptionDocuments(property, providerType) {
  if (providerType === 'status' && property?.groups
    && typeof property.groups === 'object' && !Array.isArray(property.groups)) {
    return Object.values(property.groups).flatMap((group) => {
      return Array.isArray(group) ? group : [];
    });
  }
  if (Array.isArray(property?.options)) return property.options;
  return property?.[providerType]?.options;
}

function schemaOptions(property, field, mapping, definition, optionMappings) {
  if (!CHOICE_PROVIDER_TYPES.has(field.providerType)) return null;
  const options = schemaOptionDocuments(property, field.providerType);
  if (!Array.isArray(options) || options.length < 1) {
    throw providerError(
      'validation',
      'Notion choice property ' + property?.name + ' did not expose a current option set.'
    );
  }
  const providerNames = options
    .map((option) => exactOptionName(option?.name, 'Provider Notion schema option'))
    .sort(compareCodepoint);
  if (new Set(providerNames).size !== providerNames.length) {
    throw providerError('validation', 'Notion choice property contains duplicate option names.');
  }
  const scope = exactOptionMapping(optionMappings, mapping, definition, field);
  const configuredProviders = [...scope.providerToPortable.keys()].sort(compareCodepoint);
  if (fingerprintJson(configuredProviders) !== fingerprintJson(providerNames)) {
    throw providerError(
      'conflict',
      'Private Notion option mapping does not cover the exact current provider choice set.'
    );
  }
  return providerNames.map((name) => {
    return mappedOptionValue(
      optionMappings,
      mapping,
      definition,
      field,
      name,
      'portable'
    );
  }).sort(compareCodepoint);
}

function normalizedRecordSchema(
  mapping,
  definition,
  providerSchema,
  optionMappings
) {
  const fields = definition.fields.map((field) => {
    const property = requiredObject(
      providerSchema[field.provider],
      'Notion mapped property ' + field.provider
    );
    if (property.name !== field.provider || property.type !== field.providerType) {
      throw providerError(
        'validation',
        'Notion mapped property ' + field.provider + ' expected type '
          + field.providerType + ' but observed ' + String(property.type) + '.'
      );
    }
    const writable = definition.capabilities.some((capability) => {
      const operation = parseRecordCapability(capability)?.operation;
      return ['create', 'update'].includes(operation)
        && (!field.writeOperations || field.writeOperations.includes(operation));
    });
    return {
      id: field.portable,
      writable,
      options: schemaOptions(
        property,
        field,
        mapping,
        definition,
        optionMappings
      )
    };
  }).sort((left, right) => compareCodepoint(left.id, right.id));
  const unsigned = { recordType: definition.id, fields };
  return { ...unsigned, fingerprint: fingerprintJson(unsigned) };
}

export function completeMcp({
  capability,
  authority,
  input,
  responseProfile,
  response,
  at,
  mappings,
  settings
}) {
  const payload = requiredObject(
    nativePayload(response, responseProfile, directPayloadKind(capability, input)),
    'Notion query result'
  );
  if (capability === 'workspace.identity.read') {
    if (input?.identity !== 'current-user'
      || payload?.metadata?.type !== 'self'
      || !nonEmptyString(payload?.self?.user?.id)) {
      throw providerError(
        'validation',
        'Notion fetch(self) did not return the exact authenticated current-user identity.'
      );
    }
    const providerPersonId = canonicalDecodedProviderPersonId(
      payload.self.user.id,
      'Notion authenticated current-user identity'
    );
    const identity = {
      kind: 'current-user',
      providerPersonId,
      fingerprint: fingerprintJson({
        kind: 'current-user',
        providerPersonId
      })
    };
    return {
      identity,
      provenance: {
        provider: 'notion-mcp',
        authority,
        sourceKind: 'connected',
        sourceReferenceFingerprint: fingerprintJson({
          kind: identity.kind,
          providerPersonId: identity.providerPersonId
        })
      },
      observedAt: at
    };
  }
  if (capability === 'documents.content.read') {
    const normalized = normalizedPageContent(payload, input);
    return {
      document: {
        uri: input.uri,
        title: normalized.title,
        format: 'markdown',
        body: normalized.body,
        bodyFingerprint: fingerprintJson(normalized.body)
      },
      provenance: {
        provider: 'notion-mcp',
        authority,
        providerUri: normalized.providerUri
      },
      observedAt: at
    };
  }
  if (capability === 'documents.content.update') {
    const updated = exactObservedPageIdentity(payload, 'Notion updated document');
    if (updated.normalized !== normalizedNotionPageId(input.uri)) {
      throw providerError('conflict', 'Notion updated a document outside the exact requested identity.');
    }
    return {
      document: { uri: input.uri, title: input.expectedTitle },
      accepted: true,
      changeFingerprint: fingerprintJson(input),
      provenance: {
        provider: 'notion-mcp',
        authority,
        providerUri: updated.value
      },
      observedAt: at
    };
  }
  const descriptor = parseRecordCapability(capability);
  if (!descriptor) {
    throw providerError('validation', 'Notion MCP adapter does not implement ' + capability + '.');
  }
  const mapping = mappingDocument(mappings, capability);
  const optionMappings = configuredOptionMappings(settings, mappings);
  if (descriptor.operation === 'schema-read') {
    const definition = recordMapping(mapping, input.recordType, capability, settings, mappings);
    const schema = normalizedRecordSchema(
      mapping,
      definition,
      dataSourceState(payload, targetForRecord(settings, definition)),
      optionMappings
    );
    return {
      schema,
      provenance: {
        provider: 'notion-mcp',
        authority,
        mapping: mapping.id,
        mappingVersion: mapping.version,
        sourceKind: 'connected',
        sourceReferenceFingerprint: fingerprintJson({
          mapping: mapping.id,
          mappingVersion: mapping.version,
          recordType: schema.recordType,
          schemaFingerprint: schema.fingerprint,
          fieldBindingFingerprint: effectiveFieldBindingFingerprint(mapping, definition)
        })
      },
      observedAt: at
    };
  }
  if (descriptor.operation === 'create') {
    const definition = recordMapping(mapping, input.recordType, capability, settings, mappings);
    const created = exactCreatedPage(payload);
    return {
      record: {
        type: input.recordType,
        id: created.value,
        fields: normalizedPortableWriteFields(definition, input.fields),
        ...(input.body !== undefined ? { body: input.body } : {})
      },
      created: true,
      provenance: {
        provider: 'notion-mcp',
        authority,
        mapping: mapping.id,
        mappingVersion: mapping.version
      },
      observedAt: at
    };
  }
  if (descriptor.operation === 'update') {
    const changedFields = exactRecordUpdatePatch(input);
    const definition = recordMapping(mapping, input.recordType, capability, settings, mappings);
    const updated = exactObservedPageIdentity(payload, 'Notion updated page');
    if (updated.normalized !== normalizedNotionPageId(input.id)) {
      throw providerError(
        'conflict',
        'Notion updated a record outside the exact requested identity.'
      );
    }
    return {
      record: {
        type: input.recordType,
        id: canonicalNotionPageUri(input.id),
        fields: normalizedPortableWriteFields(definition, input.patch)
      },
      changedFields,
      provenance: {
        provider: 'notion-mcp',
        authority,
        mapping: mapping.id,
        mappingVersion: mapping.version
      },
      observedAt: at
    };
  }
  if (descriptor.operation !== 'read') {
    throw providerError('validation', 'Notion MCP adapter does not implement ' + capability + '.');
  }
  const contentRead = exactProjectContentRead(
    capability,
    input,
    mapping,
    settings,
    mappings
  );
  if (contentRead) {
    const normalized = normalizedPageContent(payload, {
      uri: contentRead.requestedId,
      expectedTitle: contentRead.expectedTitle
    });
    const fields = decodedPageFields({
      mapping,
      definition: contentRead.definition,
      properties: normalized.properties,
      expectedTitle: contentRead.expectedTitle,
      optionMappings
    });
    const [record] = assertRequestedRecords(
      [{
        type: contentRead.definition.id,
        id: normalized.providerUri,
        fields,
        body: normalized.body
      }],
      input,
      mapping,
      capability,
      settings,
      mappings
    );
    return {
      records: [{
        ...record,
        version: fingerprintJson({
          type: record.type,
          id: record.id,
          fields: record.fields,
          body: record.body
        })
      }],
      provenance: {
        provider: 'notion-mcp',
        authority,
        mapping: mapping.id,
        mappingVersion: mapping.version,
        sourceKind: 'connected',
        sourceReferenceFingerprint: fingerprintJson({
          capability,
          input,
          mapping: mapping.id,
          mappingVersion: mapping.version,
          fieldBindingFingerprint: effectiveFieldBindingFingerprint(
            mapping,
            contentRead.definition
          )
        })
      },
      observedAt: at
    };
  }
  const readDefinition = recordMapping(
    mapping,
    requestedRecordTypes(input)[0],
    capability,
    settings,
    mappings
  );
  assertQueryDataSourceBinding({
    payload,
    responseProfile,
    settings,
    definition: readDefinition
  });
  if (!Array.isArray(payload.results) || typeof payload.has_more !== 'boolean') {
    throw providerError('validation', 'Notion query result must contain results and has_more.');
  }
  if (payload.has_more) {
    throw providerError(
      'validation',
      'Notion query pagination is incomplete; Core must resume a bounded continuation before using these records.'
    );
  }
  const observedRecords = payload.results.map((row, index) => {
    requiredObject(row, 'Notion result row ' + index);
    const type = requiredString(row.__soterType, 'Notion result type');
    const id = requiredString(row.__soterId, 'Notion result id');
    const fields = decodedFields(
      mapping,
      row,
      capability,
      optionMappings,
      settings,
      mappings
    );
    return { type, id, fields };
  });
  const records = assertRequestedRecords(
    observedRecords,
    input,
    mapping,
    capability,
    settings,
    mappings
  ).map((record) => ({
    ...record,
    version: fingerprintJson({
      type: record.type,
      id: record.id,
      fields: record.fields
    })
  }));
  return {
    records,
    provenance: {
      provider: 'notion-mcp',
      authority,
      mapping: mapping.id,
      mappingVersion: mapping.version,
      sourceKind: 'connected',
      sourceReferenceFingerprint: fingerprintJson({
        capability,
        input,
        mapping: mapping.id,
        mappingVersion: mapping.version,
        fieldBindingFingerprint: effectiveFieldBindingFingerprint(mapping, readDefinition)
      })
    },
    observedAt: at
  };
}

function typedMappings(mappings, planCapabilities) {
  const selected = (mappings || []).flatMap((mapping) => {
    if (mapping?.$contract !== 'soter://contracts/provider-mapping/v1'
      || mapping.recordTypes?.some((record) => {
        return record.fields.some((field) => typeof field.providerType !== 'string');
      })) return [];
    const readCapabilities = mapping.capabilities.filter((capability) => {
      return parseRecordCapability(capability)?.operation === 'read'
        && planCapabilities.includes(capability);
    });
    return readCapabilities.map((readCapability) => ({ mapping, readCapability }));
  }).sort((left, right) => compareCodepoint(left.mapping.id, right.mapping.id));
  if (!selected.length) {
    throw providerError(
      'validation',
      'Notion schema probes require at least one current typed record mapping in plan scope.'
    );
  }
  if (new Set(selected.map((item) => item.mapping.id)).size !== selected.length) {
    throw providerError(
      'validation',
      'Each Notion mapping may expose only one record-read capability in one probe plan.'
    );
  }
  return selected;
}

function broadRecordProbeSelections(selectedMappings, targets) {
  return selectedMappings.flatMap(({ mapping, readCapability }) => {
    return mapping.recordTypes.flatMap((record) => {
      if (!record.capabilities.includes(readCapability)
        || !Object.hasOwn(targets, record.target)) return [];
      return [{ mapping, readCapability, record }];
    });
  });
}

function exactRecordProbeSelections({
  mappings,
  selectedMappings,
  planCapabilities,
  targets,
  operatorRecordRequirements
}) {
  if (operatorRecordRequirements === undefined
    || (Array.isArray(operatorRecordRequirements)
      && operatorRecordRequirements.length === 0)) {
    return broadRecordProbeSelections(selectedMappings, targets);
  }
  if (!Array.isArray(operatorRecordRequirements)
    || operatorRecordRequirements.some((requirement) => {
      return !requirement || typeof requirement !== 'object' || Array.isArray(requirement)
        || typeof requirement.capability !== 'string'
        || !Array.isArray(requirement.recordTypes)
        || requirement.recordTypes.length < 1
        || requirement.recordTypes.some((recordType) => typeof recordType !== 'string');
    })) {
    throw providerError(
      'validation',
      'Notion operator record requirements must be a non-empty closed capability and record-type set.'
    );
  }
  const selections = new Map();
  for (const requirement of operatorRecordRequirements) {
    if (!planCapabilities.includes(requirement.capability)) {
      throw providerError(
        'validation',
        'Notion operator record requirement is outside the exact provider capability scope: '
          + requirement.capability + '.'
      );
    }
    for (const recordType of requirement.recordTypes) {
      const matches = (mappings || []).flatMap((mapping) => {
        if (mapping?.$contract !== 'soter://contracts/provider-mapping/v1'
          || !mapping.capabilities?.includes(requirement.capability)) return [];
        return mapping.recordTypes.flatMap((record) => {
          return record.id === recordType
            && record.capabilities.includes(requirement.capability)
            ? [{ mapping, record }]
            : [];
        });
      });
      if (matches.length !== 1) {
        throw providerError(
          'validation',
          'Notion operator record requirement must resolve one exact mapping: '
            + requirement.capability + '/' + recordType + '; found ' + matches.length + '.'
        );
      }
      const [{ mapping, record }] = matches;
      const readable = selectedMappings.filter((selected) => {
        return selected.mapping.id === mapping.id
          && record.capabilities.includes(selected.readCapability);
      });
      if (readable.length !== 1) {
        throw providerError(
          'validation',
          'Notion operator record requirement has no unique read-only probe route: '
            + requirement.capability + '/' + recordType + '.'
        );
      }
      if (!Object.hasOwn(targets, record.target)) {
        throw providerError(
          'validation',
          'Notion operator record requirement has no configured target: '
            + requirement.capability + '/' + recordType + '.'
        );
      }
      const selection = {
        mapping,
        readCapability: readable[0].readCapability,
        record
      };
      const key = mapping.id + '|' + record.id;
      const prior = selections.get(key);
      if (prior && prior.readCapability !== selection.readCapability) {
        throw providerError(
          'validation',
          'Notion operator record requirement resolved ambiguous read-only probe routes: '
            + requirement.capability + '/' + recordType + '.'
        );
      }
      selections.set(key, selection);
    }
  }
  return [...selections.values()].sort((left, right) => {
    const mappingOrder = compareCodepoint(left.mapping.id, right.mapping.id);
    return mappingOrder || compareCodepoint(left.record.id, right.record.id);
  });
}

function sortedFieldSignature(fields) {
  return fields.map((field) => ({
    provider: field.provider,
    providerType: field.providerType
  })).sort((left, right) => compareCodepoint(left.provider, right.provider));
}

function effectiveFieldBindingFingerprint(mapping, definition) {
  return fingerprintJson({
    mapping: mapping.id,
    mappingVersion: mapping.version,
    recordType: definition.id,
    fields: definition.fields.map((field) => ({
      portable: field.portable,
      provider: field.provider,
      providerType: field.providerType,
      decode: field.decode,
      writeOperations: field.writeOperations || null
    }))
  });
}

function dataSourceState(payload, targetUri) {
  if (payload?.metadata?.type !== 'data_source' || typeof payload.text !== 'string') {
    throw providerError('validation', 'Notion fetch target did not return data-source metadata.');
  }
  const source = payload.text.match(/<data-source\s+url="([^"]+)">/);
  const state = payload.text.match(/<data-source-state>\s*([\s\S]*?)\s*<\/data-source-state>/);
  const sourceUri = source?.[1]?.replace(/^\{\{/, '').replace(/\}\}$/, '');
  if (sourceUri !== targetUri || !state?.[1]) {
    throw providerError(
      'validation',
      'Notion fetch target did not identify the exact configured data source.'
    );
  }
  const parsed = requiredObject(
    parseJsonText(state[1], 'Notion data-source state'),
    'Notion data-source state'
  );
  return requiredObject(parsed.schema, 'Notion data-source schema');
}

function schemaObservation(step, responseProfile, response, settings, mappings) {
  const providerSchema = dataSourceState(
    requiredObject(
      nativePayload(response, responseProfile, 'data-source'),
      'Notion data-source result'
    ),
    step.scope.targetUri
  );
  const expected = step.scope.expectedFields;
  const matchingMappings = (mappings || []).filter((mapping) => {
    return mapping?.id === step.scope.mappingId
      && mapping.version === step.scope.mappingVersion;
  });
  if (matchingMappings.length !== 1) {
    throw providerError(
      'validation',
      'Notion schema probe did not resolve one exact current provider mapping.'
    );
  }
  const mapping = matchingMappings[0];
  const definitions = mapping.recordTypes.filter((record) => {
    return record.id === step.scope.recordType
      && record.capabilities.includes(step.scope.capability);
  });
  if (definitions.length !== 1) {
    throw providerError(
      'validation',
      'Notion schema probe did not resolve one exact current record definition.'
    );
  }
  const definition = recordMapping(
    mapping,
    step.scope.recordType,
    step.scope.capability,
    settings,
    mappings
  );
  if (step.scope.fieldBindingFingerprint
    !== effectiveFieldBindingFingerprint(mapping, definition)) {
    throw providerError(
      'conflict',
      'Notion schema probe field bindings no longer match the exact prepared scope.'
    );
  }
  if (fingerprintJson(expected) !== fingerprintJson(definition.fields.map((field) => ({
    portable: field.portable,
    provider: field.provider,
    providerType: field.providerType,
    decode: field.decode
  })))) {
    throw providerError(
      'validation',
      'Notion schema probe step does not match the current exact record definition.'
    );
  }
  const normalized = normalizedRecordSchema(
    mapping,
    definition,
    providerSchema,
    configuredOptionMappings(settings, mappings)
  );
  const expectedSignature = sortedFieldSignature(expected);
  return {
    schemaCompatible: true,
    mappedFieldCount: normalized.fields.length,
    choiceFieldCount: normalized.fields.filter((field) => {
      return Array.isArray(field.options);
    }).length,
    expectedFingerprint: fingerprintJson(expectedSignature),
    observedFingerprint: normalized.fingerprint
  };
}

export function prepareProbePlanMcp({
  plan,
  sources = [],
  settings,
  mappings,
  operatorRecordRequirements
}) {
  const selectedMappings = typedMappings(mappings, plan.capabilities);
  const targets = notionSettings(settings);
  const recordSelections = exactRecordProbeSelections({
    mappings,
    selectedMappings,
    planCapabilities: plan.capabilities,
    targets,
    operatorRecordRequirements
  });
  const steps = [
    {
      id: 'step.identity',
      kind: 'identity',
      subject: 'provider.identity',
      scope: {
        expectation: {
          metadataType: 'self',
          workspaceIdType: 'string',
          userIdType: 'string'
        }
      },
      tool: 'fetch',
      arguments: { id: 'self' }
    }
  ];
  for (const selection of recordSelections) {
    const { mapping, readCapability, record } = selection;
    const definition = recordMapping(
      mapping,
      record.id,
      readCapability,
      settings,
      mappings
    );
    const mappingStepId = mapping.id.slice('mapping.'.length);
    const recordSubject = parseRecordCapability(readCapability).subject;
    const targetUri = requiredString(
      targets[record.target],
      'Notion target ' + record.target
    );
    if (!/^collection:\/\/[a-f0-9-]{32,36}$/.test(targetUri)) {
      throw providerError('validation', 'Notion target ' + record.target + ' is not a collection URI.');
    }
    const expectedFields = definition.fields.map((field) => ({
      portable: field.portable,
      provider: field.provider,
      providerType: field.providerType,
      decode: field.decode
    }));
    steps.push({
      id: 'step.mapping.' + mappingStepId + '.record.' + record.id + '.schema',
      kind: 'schema',
      subject: recordSubject + '.' + record.id,
      scope: {
        targetKey: record.target,
        targetUri,
        recordType: record.id,
        capability: readCapability,
        mappingId: mapping.id,
        mappingVersion: mapping.version,
        fieldBindingFingerprint: effectiveFieldBindingFingerprint(mapping, definition),
        expectedFields
      },
      tool: 'fetch',
      arguments: { id: targetUri }
    });
    const input = { recordTypes: [record.id], filters: {}, limit: 1 };
    const request = prepareMcp({
      capability: readCapability,
      input,
      settings,
      mappings
    });
    steps.push({
      id: 'step.mapping.' + mappingStepId + '.record.' + record.id + '.read',
      kind: 'read',
      subject: recordSubject + '.' + record.id,
      scope: {
        targetKey: record.target,
        targetUri,
        recordType: record.id,
        capability: readCapability,
        mappingId: mapping.id,
        mappingVersion: mapping.version,
        input,
        expectation: {
          resultEnvelope: 'bounded-normalized-records',
          maximumRows: 1
        }
      },
      tool: request.tool,
      arguments: request.arguments
    });
  }
  const documentSources = sources.filter((source) => {
    return source.capability === 'documents.content.read';
  }).sort((left, right) => compareCodepoint(left.id, right.id));
  for (const source of documentSources) {
    if (!plan.authorities.includes(source.authority)
      || source.inputFingerprint !== fingerprintJson(source.input)
      || !source.id.startsWith('source.')) {
      throw providerError(
        'validation',
        'Notion document probe source is outside the exact locked capability and authority scope.'
      );
    }
    const request = prepareMcp({
      capability: 'documents.content.read',
      input: source.input,
      settings,
      mappings
    });
    steps.push({
      id: 'step.source.' + source.id.slice('source.'.length) + '.document',
      kind: 'document',
      subject: source.id,
      scope: {
        sourceId: source.id,
        authority: source.authority,
        capability: source.capability,
        input: source.input,
        inputFingerprint: source.inputFingerprint,
        expectation: {
          identityMatched: true,
          format: 'markdown',
          bodyPresent: true,
          maximumBodyCharacters: 250000
        }
      },
      tool: request.tool,
      arguments: request.arguments
    });
  }
  if (documentSources.length && !plan.capabilities.includes('documents.content.read')) {
    throw providerError('validation', 'Notion document probe sources are outside capability scope.');
  }
  return { steps };
}

export function completeProbePlanStepMcp({
  step,
  responseProfile,
  response,
  plan,
  settings,
  mappings,
  at
}) {
  if (step.kind === 'identity') {
    const payload = requiredObject(
      nativePayload(response, responseProfile, 'self'),
      'Notion identity result'
    );
    if (payload?.metadata?.type !== 'self'
      || !nonEmptyString(payload?.self?.workspace?.id)
      || !nonEmptyString(payload?.self?.user?.id)) {
      throw providerError(
        'authentication',
        'Notion fetch(self) did not return an authenticated workspace and user identity.'
      );
    }
    const providerPersonId = canonicalDecodedProviderPersonId(
      payload.self.user.id,
      'Notion authenticated probe user identity'
    );
    return {
      identityAuthenticated: true,
      expectedFingerprint: fingerprintJson(step.scope.expectation),
      observedFingerprint: fingerprintJson({
        metadataType: payload.metadata.type,
        workspaceIdType: typeof payload.self.workspace.id,
        userIdType: typeof providerPersonId
      })
    };
  }
  if (step.kind === 'schema') {
    return schemaObservation(step, responseProfile, response, settings, mappings);
  }
  if (step.kind === 'read') {
    const normalized = completeMcp({
      capability: step.scope.capability,
      authority: plan.authorities[0],
      input: step.scope.input,
      responseProfile,
      response,
      at,
      mappings,
      settings
    });
    return {
      queryAccepted: true,
      normalized: true,
      rowCount: normalized.records.length,
      rowObserved: normalized.records.length > 0,
      expectedFingerprint: fingerprintJson(step.scope.expectation),
      observedFingerprint: fingerprintJson({
        resultEnvelope: 'bounded-normalized-records',
        rowCount: normalized.records.length,
        rowObserved: normalized.records.length > 0
      })
    };
  }
  if (step.kind === 'document') {
    const normalized = completeMcp({
      capability: 'documents.content.read',
      authority: step.scope.authority,
      input: step.scope.input,
      responseProfile,
      response,
      at,
      mappings,
      settings
    });
    const observation = {
      identityMatched: normalized.document.uri === step.scope.input.uri
        && normalized.document.title === step.scope.input.expectedTitle,
      format: normalized.document.format,
      bodyPresent: Boolean(normalized.document.body),
      maximumBodyCharacters: 250000
    };
    if (!observation.identityMatched
      || observation.format !== 'markdown'
      || !observation.bodyPresent
      || normalized.document.body.length > observation.maximumBodyCharacters) {
      throw providerError('validation', 'Notion document probe did not satisfy its minimized contract.');
    }
    return {
      documentReadable: true,
      identityMatched: true,
      bodyPresent: true,
      expectedFingerprint: fingerprintJson(step.scope.expectation),
      observedFingerprint: fingerprintJson(observation)
    };
  }
  throw providerError('validation', 'Unsupported Notion provider probe step kind.');
}

function selectedMappingsCapability(steps, capability) {
  return steps.some((step) => {
    return step.kind === 'read' && step.scope.capability === capability;
  });
}

export function finalizeProbePlanMcp({ plan, steps, results }) {
  const byStep = new Map(results.map((item) => [item.stepId, item]));
  const checks = steps.map((step) => {
    const observed = byStep.get(step.id);
    if (!observed?.result || typeof observed.resultFingerprint !== 'string') {
      throw providerError('validation', 'Notion provider probe is missing a minimized step result.');
    }
    return {
      id: 'check.' + step.id.slice('step.'.length),
      stepId: step.id,
      kind: step.kind,
      subject: step.subject,
      scopeFingerprint: step.scopeFingerprint,
      state: 'passed',
      method: step.kind === 'read' || step.kind === 'document' ? 'read-only' : 'metadata',
      expectedFingerprint: observed.result.expectedFingerprint,
      observedFingerprint: observed.result.observedFingerprint,
      details: step.kind === 'identity'
        ? 'The host-authenticated Notion identity response matched the minimized identity contract.'
        : step.kind === 'schema'
          ? 'The exact configured target exposed every mapped property with its declared provider type.'
          : step.kind === 'read'
            ? 'The exact configured target accepted its bounded mapped query and returned a normalizable result envelope.'
            : 'The exact configured document source matched its identity and returned bounded normalizable content; the body was discarded.'
    };
  });
  const documentChecks = steps.filter((step) => step.kind === 'document').length;
  return {
    credentials: plan.credentialRefs.map((secretRefId) => ({
      secretRefId,
      state: 'passed',
      details: 'The host-authenticated Notion identity endpoint returned a workspace and user.'
    })),
    reachability: {
      state: 'passed',
      details: 'The host reached every explicit identity, target-schema, bounded target-read, and configured document-source probe step.'
    },
    authorities: plan.authorities.map((id) => ({
      id,
      state: 'passed',
      details: 'Every exact configured record target required by this locked authority scope was schema-compatible and readable.'
    })),
    capabilities: plan.capabilities.map((id) => ({
      id,
      state: (selectedMappingsCapability(steps, id)
        || (id === 'documents.content.read' && documentChecks > 0)) ? 'passed' : 'unknown',
      method: (selectedMappingsCapability(steps, id)
        || (id === 'documents.content.read' && documentChecks > 0)) ? 'read-only' : 'metadata',
      details: selectedMappingsCapability(steps, id)
        ? 'Every configured mapped target accepted a one-row bounded query whose result envelope normalized successfully.'
        : id === 'documents.content.read' && documentChecks > 0
          ? 'Every configured probe-read document source matched its exact identity and returned bounded normalizable content without retaining its body.'
          : 'Read and schema compatibility do not establish write permission, provider write response conformance, verification, or compensation.'
    })),
    checks,
    limitations: [
      'This exact-lock probe establishes configured target access, mapped schema compatibility, bounded record-read normalization, and exact configured document-read normalization only; it does not establish policy interpretation, write behavior, or end-to-end automation health.',
      'A target that returns zero rows proves query and empty-envelope compatibility but does not exercise non-null value decoding for that target.',
      'Raw provider responses, policy bodies, row values, target identifiers, workspace identity values, and user identity values are excluded from the persisted observations.'
    ]
  };
}
