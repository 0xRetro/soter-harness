import crypto from 'node:crypto';

export const PRIVATE_CONTAINED_BASIS_VERSION = '1.1.0';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function fingerprintJson(value) {
  return 'sha256:' + crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function valueShape(value) {
  if (Array.isArray(value)) return value.map(valueShape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, valueShape(value[key])])
    );
  }
  if (value === null) return 'null';
  return typeof value;
}

function packSelection(pack) {
  return {
    id: pack.id,
    version: pack.version,
    layer: pack.layer,
    releaseStage: pack.releaseStage,
    evidenceMaturity: pack.evidenceMaturity,
    source: pack.source,
    reason: pack.reason,
    manifestFingerprint: pack.manifestFingerprint,
    artifacts: pack.artifacts.map((artifact) => ({
      path: artifact.path,
      role: artifact.role
    }))
  };
}

function sourceSemantics(source) {
  const { input, inputFingerprint, ...semantic } = source;
  return {
    ...semantic,
    inputShape: valueShape(input)
  };
}

function authoritySemantics(authority) {
  const { uri, declarationFingerprint, ...semantic } = authority;
  return semantic;
}

function settingsSemantics(settings) {
  const portable = structuredClone(settings);
  const notion = portable?.['integration.notion'];
  if (notion && typeof notion === 'object' && !Array.isArray(notion)) {
    delete notion.optionMappings;
  }
  return valueShape(portable);
}

/**
 * Produce the complete safe projection whose equality is required between a
 * portable tracked lock and one contained private realization. Provider target
 * values, source values, private paths, and private fingerprints are excluded.
 */
export function privateContainedLockProjection(lock) {
  return {
    resolver: lock.resolver,
    host: lock.host,
    packs: lock.packs.map(packSelection),
    dependencies: lock.dependencies,
    capabilities: lock.capabilities,
    bindings: lock.bindings,
    sources: lock.sources.map(sourceSemantics),
    authorities: lock.authorities.map(authoritySemantics),
    effectPolicies: lock.effectPolicies,
    settingsShape: settingsSemantics(lock.settings),
    projections: lock.projections
  };
}

export function fingerprintPrivateContainedLockProjection(lock) {
  return fingerprintJson(privateContainedLockProjection(lock));
}

export function fingerprintPrivateContainedBasis(basis) {
  const unsigned = structuredClone(basis);
  delete unsigned.basisFingerprint;
  return fingerprintJson(unsigned);
}
