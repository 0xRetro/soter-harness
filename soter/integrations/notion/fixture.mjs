import crypto from 'node:crypto';
import fs from 'node:fs';

import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

function providerError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function provenance(authority) {
  return {
    provider: 'notion-fixture',
    authority,
    fixture: 'soter/fixtures/providers/notion/crm-records.json'
  };
}

function recordId(recordType, deduplicationKey) {
  const suffix = crypto.createHash('sha256').update(deduplicationKey).digest('hex').slice(0, 12);
  return recordType + '.' + suffix;
}

export async function invoke({ capability, input, authority, fixtures, state, at }) {
  const fixture = state || JSON.parse(fs.readFileSync(fixtures[0], 'utf8'));
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
      provenance: provenance(authority),
      observedAt: at || fixture.observedAt
    };
  }
  if (capability === 'crm.records.read') {
    const requestedTypes = new Set(input.recordTypes);
    const requestedIds = input.ids ? new Set(input.ids) : null;
    const filters = Object.entries(input.filters || {});
    const records = fixture.data.records.filter((record) => {
      return requestedTypes.has(record.type)
        && (!requestedIds || requestedIds.has(record.id))
        && filters.every(([field, value]) => record.fields?.[field] === value);
    }).slice(0, input.limit || 100);
    return { records, provenance: provenance(authority), observedAt: at || fixture.observedAt };
  }
  if (capability === 'crm.records.create') {
    const existing = fixture.data.records.find((record) => {
      return record.type === input.recordType && record.deduplicationKey === input.deduplicationKey;
    });
    if (existing) {
      return {
        record: existing,
        created: false,
        provenance: provenance(authority),
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
      provenance: provenance(authority),
      observedAt: at || fixture.observedAt
    };
  }
  if (capability === 'crm.records.update') {
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
      provenance: provenance(authority),
      observedAt: at || fixture.observedAt
    };
  }
  throw providerError('validation', 'Notion fixture does not implement ' + capability + '.');
}
