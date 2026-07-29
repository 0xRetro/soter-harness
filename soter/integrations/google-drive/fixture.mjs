import crypto from 'node:crypto';
import fs from 'node:fs';

import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

function providerError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function provenance(authority, fixture, subject) {
  return {
    provider: 'google-drive-fixture',
    authority,
    sourceKind: 'fixture',
    sourceReferenceFingerprint: fingerprintJson({ fixtureId: fixture.id, subject })
  };
}

function exactOne(values, label) {
  if (values.length !== 1) throw providerError('not-found', label + ' did not resolve exactly once.');
  return values[0];
}

function withFingerprint(value) {
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  return { ...unsigned, fingerprint: fingerprintJson(unsigned) };
}

function createdUri(kind, key) {
  const suffix = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return 'soter-fixture://storage/' + kind + '/' + suffix;
}

function exactWriteInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.sourceUri !== 'string' || !input.sourceUri
    || typeof input.destinationUri !== 'string' || !input.destinationUri
    || typeof input.name !== 'string' || !input.name
    || typeof input.deduplicationKey !== 'string' || input.deduplicationKey.length < 12) {
    throw providerError('validation', 'Storage write requires exact source, destination, name, and deduplication key.');
  }
}

export async function invoke({ capability, input, authority, fixtures, state, at }) {
  const fixture = state || JSON.parse(fs.readFileSync(fixtures[0], 'utf8'));
  const observedAt = at || fixture.observedAt;
  if (capability === 'storage.registry.read') {
    const source = exactOne(
      fixture.data.registries.filter((item) => item.id === input.registryId),
      'Storage registry ' + input.registryId
    );
    const registry = withFingerprint(source);
    return {
      registry,
      provenance: provenance(authority, fixture, { registryId: input.registryId }),
      observedAt
    };
  }
  if (capability === 'storage.artifacts.read') {
    const source = exactOne(
      fixture.data.artifacts.filter((item) => item.uri === input.uri),
      'Storage artifact ' + input.uri
    );
    const artifact = withFingerprint(source);
    return {
      artifact,
      provenance: provenance(authority, fixture, { uri: input.uri }),
      observedAt
    };
  }
  if (capability === 'storage.shortcuts.create') {
    exactWriteInput(input);
    const existing = fixture.data.artifacts.find((item) => {
      return item.deduplicationKey === input.deduplicationKey;
    });
    if (existing) {
      return {
        artifact: {
          uri: existing.uri,
          name: existing.name,
          kind: 'shortcut',
          parentUris: existing.parentUris,
          targetUri: existing.targetUri
        },
        created: false,
        provenance: provenance(authority, fixture, { deduplicationKey: input.deduplicationKey }),
        observedAt
      };
    }
    const artifact = {
      name: input.name,
      uri: createdUri('shortcut', input.deduplicationKey),
      kind: 'shortcut',
      ownership: 'organization',
      link: createdUri('link', input.deduplicationKey),
      parentUris: [input.destinationUri],
      targetUri: input.sourceUri,
      deduplicationKey: input.deduplicationKey
    };
    fixture.data.artifacts.push(artifact);
    return {
      artifact: {
        uri: artifact.uri,
        name: artifact.name,
        kind: artifact.kind,
        parentUris: artifact.parentUris,
        targetUri: artifact.targetUri
      },
      created: true,
      provenance: provenance(authority, fixture, { deduplicationKey: input.deduplicationKey }),
      observedAt
    };
  }
  if (capability === 'storage.files.copy') {
    exactWriteInput(input);
    const existing = fixture.data.artifacts.find((item) => {
      return item.deduplicationKey === input.deduplicationKey;
    });
    if (existing) {
      return {
        artifact: {
          uri: existing.uri,
          name: existing.name,
          kind: 'file',
          parentUris: existing.parentUris,
          sourceUri: existing.sourceUri
        },
        created: false,
        provenance: provenance(authority, fixture, { deduplicationKey: input.deduplicationKey }),
        observedAt
      };
    }
    const artifact = {
      name: input.name,
      uri: createdUri('copy', input.deduplicationKey),
      kind: 'file',
      ownership: 'organization',
      link: createdUri('link', input.deduplicationKey),
      parentUris: [input.destinationUri],
      targetUri: null,
      sourceUri: input.sourceUri,
      deduplicationKey: input.deduplicationKey
    };
    fixture.data.artifacts.push(artifact);
    return {
      artifact: {
        uri: artifact.uri,
        name: artifact.name,
        kind: artifact.kind,
        parentUris: artifact.parentUris,
        sourceUri: artifact.sourceUri
      },
      created: true,
      provenance: provenance(authority, fixture, { deduplicationKey: input.deduplicationKey }),
      observedAt
    };
  }
  throw providerError('validation', 'Google Drive fixture does not implement ' + capability + '.');
}
