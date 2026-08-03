import crypto from 'node:crypto';
import fs from 'node:fs';

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

function provenance(authority, fixture, capability, mapping = null) {
  return {
    provider: 'notion-fixture',
    authority,
    ...(mapping ? { mapping: mapping.id, mappingVersion: mapping.version } : {}),
    sourceKind: 'fixture',
    sourceReferenceFingerprint: fingerprintJson({
      fixtureId: fixture.id,
      capability,
      mappingFingerprint: mapping ? fingerprintJson(mapping) : null
    })
  };
}

function mappingDocument(mappings, capability) {
  const matches = (mappings || []).filter((mapping) => {
    return mapping?.$contract === 'soter://contracts/provider-mapping/v1'
      && mapping.capabilities?.includes(capability);
  });
  if (matches.length !== 1) {
    throw providerError(
      'validation',
      'Expected one fixture provider mapping for ' + capability + '; found ' + matches.length + '.'
    );
  }
  return matches[0];
}

function recordMapping(mapping, recordType, capability) {
  const matches = mapping.recordTypes.filter((record) => {
    return record.id === recordType && record.capabilities.includes(capability);
  });
  if (matches.length !== 1) {
    throw providerError(
      'validation',
      'Notion fixture mapping does not declare record type ' + recordType + ' for ' + capability + '.'
    );
  }
  return matches[0];
}

function assertMappedWriteFields(definition, values, operation) {
  const fields = new Map(definition.fields.map((field) => [field.portable, field]));
  for (const portable of Object.keys(values)) {
    const field = fields.get(portable);
    if (!field || (field.writeOperations && !field.writeOperations.includes(operation))) {
      throw providerError(
        'validation',
        'Notion fixture ' + operation + ' cannot use unmapped or write-scoped field '
          + definition.id + '.' + portable + '.'
      );
    }
  }
}

function exactRecordUpdatePatch(input) {
  if (!input
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.keys(input).some((key) => {
      return !['recordType', 'id', 'expectedVersion', 'patch'].includes(key);
    })
    || !['recordType', 'id', 'expectedVersion', 'patch'].every((key) => {
      return Object.hasOwn(input, key);
    })
    || typeof input.recordType !== 'string'
    || !input.recordType.trim()
    || input.recordType.trim() !== input.recordType
    || typeof input.id !== 'string'
    || !input.id.trim()
    || input.id.trim() !== input.id
    || typeof input.expectedVersion !== 'string'
    || !input.expectedVersion.trim()
    || input.expectedVersion.trim() !== input.expectedVersion
    || !input.patch
    || typeof input.patch !== 'object'
    || Array.isArray(input.patch)
    || Object.keys(input.patch).length < 1) {
    throw providerError(
      'validation',
      'Notion fixture updates require one closed exact record identity, expected version, and non-empty patch.'
    );
  }
  return Object.keys(input.patch).sort(compareCodepoint);
}

function assertMappedBodyContent(definition, body) {
  if (body === undefined || body === null) return false;
  if (definition.content?.portable !== 'body'
    || definition.content.provider !== 'page-content'
    || definition.content.providerType !== 'markdown'
    || typeof body !== 'string') {
    throw providerError(
      'validation',
      'Notion fixture page content requires the exact mapped markdown page-content route.'
    );
  }
  return true;
}

function requestedRecordTypes(input) {
  const plural = Array.isArray(input?.recordTypes) ? input.recordTypes : null;
  const singular = typeof input?.recordType === 'string' ? [input.recordType] : null;
  if ((plural && singular) || (!plural && !singular)) {
    throw providerError(
      'validation',
      'Notion fixture record reads require exactly one recordType or recordTypes shape.'
    );
  }
  const recordTypes = plural || singular;
  if (recordTypes.length < 1
    || recordTypes.length > 10
    || new Set(recordTypes).size !== recordTypes.length
    || recordTypes.some((recordType) => typeof recordType !== 'string' || !recordType.trim())) {
    throw providerError(
      'validation',
      'Notion fixture record reads require 1 through 10 unique non-empty record types.'
    );
  }
  return recordTypes;
}

function exactProjectContentRead(capability, input, mapping, recordTypes) {
  if (!Object.hasOwn(input || {}, 'content')) return null;
  const content = input.content;
  if (capability !== 'projects.records.read'
    || !content
    || typeof content !== 'object'
    || Array.isArray(content)
    || Object.keys(content).length !== 1
    || typeof content.expectedTitle !== 'string'
    || !content.expectedTitle
    || content.expectedTitle.trim() !== content.expectedTitle
    || content.expectedTitle.length > 200
    || recordTypes.length !== 1
    || !Array.isArray(input.ids)
    || input.ids.length !== 1
    || input.limit !== 1) {
    throw providerError(
      'validation',
      'Notion Project content reads require one exact record type, id, expected title, and limit.'
    );
  }
  const definition = recordMapping(mapping, recordTypes[0], capability);
  if (definition.content?.portable !== 'body'
    || definition.content.provider !== 'page-content'
    || definition.content.providerType !== 'markdown') {
    throw providerError(
      'validation',
      'Notion Project content reads require one exact mapped markdown page-content route.'
    );
  }
  const titleFields = definition.fields.filter((field) => field.providerType === 'title');
  if (titleFields.length !== 1) {
    throw providerError(
      'validation',
      'Notion Project content reads require one exact mapped title field.'
    );
  }
  return {
    expectedTitle: content.expectedTitle,
    titleField: titleFields[0]
  };
}

function recordId(recordType, deduplicationKey) {
  const suffix = crypto.createHash('sha256').update(deduplicationKey).digest('hex').slice(0, 12);
  return recordType + '.' + suffix;
}

function projectedRecord(record, requestedIds, body = undefined) {
  const projectedBody = body === undefined && Object.hasOwn(record, 'body')
    ? structuredClone(record.body)
    : body;
  return {
    type: record.type,
    id: record.id,
    version: body === undefined
      ? record.version
      : fingerprintJson({
        type: record.type,
        id: record.id,
        fields: record.fields,
        body
      }),
    fields: structuredClone(record.fields),
    ...(projectedBody === undefined ? {} : { body: projectedBody }),
    identityBinding: requestedIds
      ? {
        state: 'exact-request',
        requestedIdFingerprint: fingerprintJson(record.id)
      }
      : {
        state: 'observed',
        requestedIdFingerprint: null
      }
  };
}

function exactDocumentUpdates(source, input) {
  if (source.title !== input.expectedTitle
    || fingerprintJson(source.body) !== input.expectedBodyFingerprint) {
    throw providerError(
      'conflict',
      'Document fixture title or body fingerprint no longer matches the reviewed value.'
    );
  }
  if (!Array.isArray(input.updates)
    || new Set(input.updates.map((update) => update.id)).size !== input.updates.length
    || new Set(input.updates.map((update) => update.oldText)).size !== input.updates.length) {
    throw providerError('validation', 'Document updates require unique identifiers and match text.');
  }
  let body = source.body;
  for (const update of input.updates) {
    if (update.replaceAllMatches !== false || update.oldText === update.newText) {
      throw providerError('validation', 'Document updates require one exact changing replacement.');
    }
    const first = body.indexOf(update.oldText);
    const second = first < 0 ? -1 : body.indexOf(update.oldText, first + update.oldText.length);
    if (first < 0 || second >= 0) {
      throw providerError(
        'conflict',
        'Document update ' + update.id + ' did not match exactly one current text region.'
      );
    }
    body = body.slice(0, first) + update.newText + body.slice(first + update.oldText.length);
  }
  if (!body.trim() || body.length > 250000) {
    throw providerError('validation', 'Updated document body is empty or outside the bounded content limit.');
  }
  return body;
}

export async function invoke({ capability, input, authority, fixtures, mappings, state, at }) {
  const fixture = state || JSON.parse(fs.readFileSync(fixtures[0], 'utf8'));
  if (capability === 'workspace.identity.read') {
    if (input?.identity !== 'current-user'
      || fixture.data?.identity?.kind !== 'current-user'
      || typeof fixture.data.identity.providerPersonId !== 'string'
      || !fixture.data.identity.providerPersonId) {
      throw providerError(
        'validation',
        'Notion identity fixture requires one exact authenticated current-user identity.'
      );
    }
    const identity = {
      kind: 'current-user',
      providerPersonId: fixture.data.identity.providerPersonId,
      fingerprint: fingerprintJson({
        kind: 'current-user',
        providerPersonId: fixture.data.identity.providerPersonId
      })
    };
    return {
      identity,
      provenance: {
        provider: 'notion-fixture',
        authority,
        sourceKind: 'fixture',
        sourceReferenceFingerprint: fingerprintJson({
          fixtureId: fixture.id,
          identity: 'current-user'
        })
      },
      observedAt: at || fixture.observedAt
    };
  }
  if (capability === 'documents.content.read') {
    const matches = (fixture.data.documents || []).filter((document) => {
      return document.uri === input.uri;
    });
    if (matches.length !== 1) {
      throw providerError('not-found', 'Document fixture did not resolve exactly once: ' + input.uri + '.');
    }
    const source = matches[0];
    if (source.title !== input.expectedTitle) {
      throw providerError(
        'conflict',
        'Document fixture title does not match the expected definition identity.'
      );
    }
    if (typeof source.body !== 'string' || !source.body.trim() || source.body.length > 250000) {
      throw providerError('validation', 'Document fixture body is empty or outside the bounded content limit.');
    }
    return {
      document: {
        uri: source.uri,
        title: source.title,
        format: 'markdown',
        body: source.body,
        bodyFingerprint: fingerprintJson(source.body)
      },
      provenance: provenance(authority, fixture, capability),
      observedAt: at || fixture.observedAt
    };
  }
  if (capability === 'documents.content.update') {
    const matches = (fixture.data.documents || []).filter((document) => {
      return document.uri === input.uri;
    });
    if (matches.length !== 1) {
      throw providerError('not-found', 'Document fixture did not resolve exactly once: ' + input.uri + '.');
    }
    const source = matches[0];
    source.body = exactDocumentUpdates(source, input);
    return {
      document: { uri: source.uri, title: source.title },
      accepted: true,
      changeFingerprint: fingerprintJson(input),
      provenance: provenance(authority, fixture, capability),
      observedAt: at || fixture.observedAt
    };
  }
  const descriptor = parseRecordCapability(capability);
  if (!descriptor) {
    throw providerError('validation', 'Notion fixture does not implement ' + capability + '.');
  }
  const mapping = mappingDocument(mappings, capability);
  if (descriptor.operation === 'schema-read') {
    recordMapping(mapping, input.recordType, capability);
    const matches = (fixture.data.schemas || []).filter((schema) => {
      return schema.recordType === input.recordType;
    });
    if (matches.length !== 1) {
      throw providerError(
        'not-found',
        'Notion schema fixture did not resolve exactly once: ' + input.recordType + '.'
      );
    }
    const unsigned = structuredClone(matches[0]);
    if (!Array.isArray(unsigned.fields)
      || unsigned.fields.length < 1
      || new Set(unsigned.fields.map((field) => field.id)).size !== unsigned.fields.length
      || unsigned.fields.some((field) => {
        return typeof field.id !== 'string'
          || typeof field.writable !== 'boolean'
          || (field.options !== null
            && (!Array.isArray(field.options)
              || field.options.length < 1
              || new Set(field.options).size !== field.options.length
              || field.options.some((option) => typeof option !== 'string' || !option)));
      })) {
      throw providerError('validation', 'Notion schema fixture is malformed or ambiguous.');
    }
    unsigned.fields = unsigned.fields.map((field) => ({
      ...field,
      options: field.options === null ? null : [...field.options].sort(compareCodepoint)
    })).sort((left, right) => compareCodepoint(left.id, right.id));
    const schema = { ...unsigned, fingerprint: fingerprintJson(unsigned) };
    return {
      schema,
      provenance: provenance(authority, fixture, capability, mapping),
      observedAt: at || fixture.observedAt
    };
  }
  if (descriptor.operation === 'read') {
    if (input.filters && input.filtersAny) {
      throw providerError('validation', 'Record reads cannot combine exact and alternative filters.');
    }
    const recordTypes = requestedRecordTypes(input);
    for (const recordType of recordTypes) recordMapping(mapping, recordType, capability);
    const contentRead = exactProjectContentRead(capability, input, mapping, recordTypes);
    const requestedTypes = new Set(recordTypes);
    const requestedIds = input.ids ? new Set(input.ids) : null;
    const filters = Object.entries(input.filters || {});
    const filtersAny = (input.filtersAny || []).map((candidate) => Object.entries(candidate));
    const selected = fixture.data.records.filter((record) => {
      return requestedTypes.has(record.type)
        && (!requestedIds || requestedIds.has(record.id))
        && filters.every(([field, value]) => record.fields?.[field] === value)
        && (!filtersAny.length || filtersAny.some((candidate) => {
          return candidate.every(([field, value]) => record.fields?.[field] === value);
        }));
    }).slice(0, input.limit || 100);
    let contentBody;
    if (contentRead) {
      if (selected.length !== 1) {
        throw providerError(
          'not-found',
          'Notion Project content fixture did not resolve one exact requested record.'
        );
      }
      const [record] = selected;
      if (record.fields?.[contentRead.titleField.portable] !== contentRead.expectedTitle) {
        throw providerError(
          'conflict',
          'Notion Project content fixture record title does not match the exact requested title.'
        );
      }
      const documents = (fixture.data.documents || []).filter((document) => {
        return document.uri === record.id;
      });
      if (documents.length !== 1) {
        throw providerError(
          'not-found',
          'Notion Project content fixture did not resolve one exact mapped document body.'
        );
      }
      const [document] = documents;
      if (document.title !== contentRead.expectedTitle) {
        throw providerError(
          'conflict',
          'Notion Project content fixture document title does not match the exact requested title.'
        );
      }
      if (typeof document.body !== 'string'
        || !document.body.trim()
        || document.body.length > 250000) {
        throw providerError(
          'validation',
          'Notion Project content fixture body is empty or outside the bounded content limit.'
        );
      }
      contentBody = document.body;
    }
    const records = selected.map((record) => {
      return projectedRecord(record, requestedIds, contentBody);
    });
    return {
      records,
      provenance: provenance(authority, fixture, capability, mapping),
      observedAt: at || fixture.observedAt
    };
  }
  if (descriptor.operation === 'create') {
    const definition = recordMapping(mapping, input.recordType, capability);
    assertMappedWriteFields(definition, input.fields, 'create');
    const bodyPresent = assertMappedBodyContent(definition, input.body);
    const existing = fixture.data.records.find((record) => {
      return record.type === input.recordType && record.deduplicationKey === input.deduplicationKey;
    });
    if (existing) {
      return {
        record: existing,
        created: false,
        provenance: provenance(authority, fixture, capability, mapping),
        observedAt: at || fixture.observedAt
      };
    }
    const storedFields = input.recordType === 'project'
      ? Object.fromEntries(definition.fields.map((field) => {
          if (Object.hasOwn(input.fields, field.portable)) {
            return [field.portable, structuredClone(input.fields[field.portable])];
          }
          return [field.portable, field.decode === 'json' ? [] : null];
        }))
      : { ...input.fields };
    const record = {
      type: input.recordType,
      id: recordId(input.recordType, input.deduplicationKey),
      version: '1',
      deduplicationKey: input.deduplicationKey,
      fields: storedFields,
      ...(bodyPresent && input.recordType !== 'project' ? { body: input.body } : {})
    };
    fixture.data.records.push(record);
    if (bodyPresent) {
      const titleField = definition.fields.find((field) => field.providerType === 'title');
      const title = titleField ? storedFields[titleField.portable] : null;
      if (typeof title !== 'string' || !title
        || (fixture.data.documents || []).some((document) => document.uri === record.id)) {
        throw providerError(
          'validation',
          'Notion fixture create could not bind one exact new mapped document body.'
        );
      }
      fixture.data.documents ||= [];
      fixture.data.documents.push({ uri: record.id, title, body: input.body });
    }
    return {
      record,
      created: true,
      provenance: provenance(authority, fixture, capability, mapping),
      observedAt: at || fixture.observedAt
    };
  }
  if (descriptor.operation === 'update') {
    const changedFields = exactRecordUpdatePatch(input);
    const definition = recordMapping(mapping, input.recordType, capability);
    assertMappedWriteFields(definition, input.patch, 'update');
    const record = fixture.data.records.find((item) => {
      return item.type === input.recordType && item.id === input.id;
    });
    if (!record) throw providerError('not-found', 'Record fixture not found: ' + input.id + '.');
    if (record.version !== input.expectedVersion) {
      throw providerError('conflict', 'Expected version ' + input.expectedVersion + ' but found ' + record.version + '.');
    }
    record.fields = { ...record.fields, ...input.patch };
    record.version = String(Number(record.version) + 1);
    return {
      record,
      changedFields,
      provenance: provenance(authority, fixture, capability, mapping),
      observedAt: at || fixture.observedAt
    };
  }
  throw providerError('validation', 'Notion fixture does not implement ' + capability + '.');
}
