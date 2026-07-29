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

function recordId(recordType, deduplicationKey) {
  const suffix = crypto.createHash('sha256').update(deduplicationKey).digest('hex').slice(0, 12);
  return recordType + '.' + suffix;
}

function projectedRecord(record, requestedIds) {
  return {
    type: record.type,
    id: record.id,
    version: record.version,
    fields: structuredClone(record.fields),
    ...(Object.hasOwn(record, 'body') ? { body: structuredClone(record.body) } : {}),
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
    const requestedTypes = new Set(recordTypes);
    const requestedIds = input.ids ? new Set(input.ids) : null;
    const filters = Object.entries(input.filters || {});
    const filtersAny = (input.filtersAny || []).map((candidate) => Object.entries(candidate));
    const records = fixture.data.records.filter((record) => {
      return requestedTypes.has(record.type)
        && (!requestedIds || requestedIds.has(record.id))
        && filters.every(([field, value]) => record.fields?.[field] === value)
        && (!filtersAny.length || filtersAny.some((candidate) => {
          return candidate.every(([field, value]) => record.fields?.[field] === value);
        }));
    }).slice(0, input.limit || 100)
      .map((record) => projectedRecord(record, requestedIds));
    return {
      records,
      provenance: provenance(authority, fixture, capability, mapping),
      observedAt: at || fixture.observedAt
    };
  }
  if (descriptor.operation === 'create') {
    const definition = recordMapping(mapping, input.recordType, capability);
    assertMappedWriteFields(definition, input.fields, 'create');
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
    const record = {
      type: input.recordType,
      id: recordId(input.recordType, input.deduplicationKey),
      version: '1',
      deduplicationKey: input.deduplicationKey,
      fields: { ...input.fields },
      ...(input.body !== undefined ? { body: input.body } : {})
    };
    fixture.data.records.push(record);
    return {
      record,
      created: true,
      provenance: provenance(authority, fixture, capability, mapping),
      observedAt: at || fixture.observedAt
    };
  }
  if (descriptor.operation === 'update') {
    const definition = recordMapping(mapping, input.recordType, capability);
    assertMappedWriteFields(definition, input.patch, 'update');
    const record = fixture.data.records.find((item) => {
      return item.type === input.recordType && item.id === input.id;
    });
    if (!record) throw providerError('not-found', 'Record fixture not found: ' + input.id + '.');
    if (record.version !== input.expectedVersion) {
      throw providerError('conflict', 'Expected version ' + input.expectedVersion + ' but found ' + record.version + '.');
    }
    const changedFields = Object.keys(input.patch).sort();
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
