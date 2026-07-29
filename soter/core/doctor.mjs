import path from 'node:path';

import { validateJsonSchema, verifySoter } from '../kernel/verify.mjs';
import { listProviderDeclarations } from './capabilities.mjs';
import { createResolutionEvidence } from './evidence.mjs';
import { evaluateConfigurationMaturity, loadMaturityEvidence } from './maturity.mjs';
import {
  fingerprintJson,
  readJson,
  resolveRepoPath
} from './lib/canonical-json.mjs';
import { fingerprintLock, lockMatchesResolution } from './resolve.mjs';

function diagnostic({
  code,
  severity,
  claim,
  subject,
  path: diagnosticPath = [],
  expected,
  observed,
  evidenceIds = [],
  remediation
}) {
  return {
    code,
    severity,
    claim,
    subject,
    path: diagnosticPath,
    expected,
    observed,
    evidenceIds,
    remediation
  };
}

export function runOfflineDoctor({
  root,
  configPath,
  lock,
  doctorId,
  evidenceId,
  createdAt
}) {
  const resolvedRoot = path.resolve(root);
  const verification = verifySoter(resolvedRoot, { includeRuntimeArtifacts: false });
  const diagnostics = verification.violations.map((violation) => diagnostic({
    code: violation.code,
    severity: violation.level === 'warn' ? 'warning' : 'error',
    claim: violation.what,
    subject: violation.file,
    expected: violation.why,
    observed: violation.what,
    remediation: violation.fix
  }));

  let lockState = 'unknown';
  let lockComparison = null;
  if (verification.health.valid === 'passed') {
    try {
      lockComparison = lockMatchesResolution({
        lock,
        root: resolvedRoot,
        configPath: configPath || lock.configuration.path
      });
      lockState = lockComparison.matches ? 'passed' : 'stale';
      if (!lockComparison.matches) {
        diagnostics.push(diagnostic({
          code: 'SOTER_LOCK_STALE',
          severity: 'error',
          claim: 'The supplied configuration lock matches the current resolved graph.',
          subject: lock.configuration.name,
          path: ['configurationLock'],
          expected: lockComparison.expectedFingerprint,
          observed: lockComparison.observedFingerprint,
          remediation: 'Resolve the configuration again and review the changed graph before running it.'
        }));
      }
    } catch (error) {
      lockState = 'failed';
      diagnostics.push(diagnostic({
        code: 'SOTER_LOCK_INVALID',
        severity: 'error',
        claim: 'The supplied configuration lock can be compared with the desired configuration.',
        subject: lock?.configuration?.name || 'unknown configuration',
        path: ['configurationLock'],
        expected: 'A complete lock produced by core.resolver.',
        observed: error.message,
        remediation: 'Resolve the configuration again before preparing or executing a run.'
      }));
    }
  }

  const graphState = verification.health.valid;
  const valid = graphState === 'failed'
    ? 'failed'
    : lockState === 'stale' ? 'stale' : lockState === 'failed' ? 'failed' : 'passed';
  const ready = valid === 'failed' ? 'failed' : valid === 'stale' ? 'stale' : 'unknown';
  const loadedMaturityEvidence = loadMaturityEvidence(resolvedRoot);
  for (const item of loadedMaturityEvidence.diagnostics) {
    diagnostics.push(diagnostic({
      code: item.code,
      severity: 'warning',
      claim: 'Only unique contract-valid evidence/v2 records can support maturity.',
      subject: item.subject,
      expected: 'One exact schema-valid evidence/v2 record.',
      observed: item.message,
      remediation: item.remediation
    }));
  }
  const resolvedConfiguration = verification.resolvedConfigurations.find((item) => {
    return item.name === lock.configuration.name;
  });
  const maturity = resolvedConfiguration
    ? evaluateConfigurationMaturity({
      lock,
      resolvedConfiguration,
      evidenceRecords: loadedMaturityEvidence.records,
      lockState: lockState === 'passed' ? 'current' : lockState,
      at: createdAt
    })
    : null;
  const verified = valid === 'failed'
    ? 'failed'
    : valid === 'stale'
      ? 'stale'
      : maturity?.verified || 'unknown';
  const healthy = 'unknown';

  const evidence = [];
  if (graphState === 'passed' && lockState === 'passed') {
    evidence.push(createResolutionEvidence({ lock, id: evidenceId, createdAt }));
  }
  const evidenceIds = evidence.map((item) => item.id);

  const checks = [
    {
      id: 'kernel.graph-valid',
      claim: 'Machine contracts and the selected dependency graph are internally valid.',
      state: graphState,
      evidenceIds: [],
      details: graphState === 'passed'
        ? 'The dependency-free Kernel verifier reported no graph errors.'
        : 'Kernel diagnostics identify contract or graph failures.'
    },
    {
      id: 'core.lock-current',
      claim: 'The supplied lock exactly matches a fresh deterministic resolution.',
      state: lockState,
      evidenceIds,
      details: lockState === 'passed'
        ? 'The observed and freshly resolved lock fingerprints match.'
        : lockState === 'stale'
          ? 'A locked input changed; the configuration must be resolved and reviewed again.'
          : 'A current lock could not be established.'
    },
    {
      id: 'host.credentials-ready',
      claim: 'Required host credential references resolve with sufficient permissions.',
      state: 'skipped',
      evidenceIds: [],
      details: 'Offline doctor does not inspect credential values or provider permissions.'
    },
    {
      id: 'integrations.reachable',
      claim: 'Selected integrations are authenticated, reachable, and capability-compatible.',
      state: 'skipped',
      evidenceIds: [],
      details: 'Offline doctor performs no network or provider calls.'
    },
    {
      id: 'behavior.evidence-current',
      claim: 'Applicable fixture or stronger behavior evidence is current for every selected component.',
      state: verified,
      evidenceIds: maturity?.evidenceIds || [],
      details: verified === 'passed'
        ? 'Every selected pack and host has active subject-scoped behavior evidence for this exact lock.'
        : verified === 'failed'
          ? 'Applicable behavior evidence failed for at least one selected component.'
          : verified === 'stale'
            ? 'The lock or applicable behavior evidence is stale.'
            : 'Static declarations, test capacity, and run-scoped evidence do not establish complete behavior verification.'
    },
    {
      id: 'runtime.health-current',
      claim: 'Connected dependencies are currently healthy for this configuration.',
      state: 'skipped',
      evidenceIds: [],
      details: 'Current dependency health requires a connected or canary doctor level.'
    }
  ];

  diagnostics.push(diagnostic({
    code: 'SOTER_OFFLINE_SCOPE',
    severity: 'info',
    claim: 'Offline doctor reports only claims it can establish without provider access.',
    subject: lock.configuration.name,
    expected: 'Readiness and live health remain unknown until connected checks run.',
    observed: 'Credential, reachability, capability, and current-health checks were skipped.',
    evidenceIds,
    remediation: 'Run a future connected doctor before executing provider capabilities.'
  }));

  return {
    report: {
      $contract: 'soter://contracts/doctor-result/v1',
      contractVersion: '1.0.0',
      id: doctorId,
      createdAt,
      level: 'offline',
      configuration: {
        name: lock.configuration.name,
        lockFingerprint: fingerprintLock(lock)
      },
      states: { valid, ready, verified, healthy },
      checks,
      diagnostics,
      providerProbeIds: [],
      evidenceIds: [...new Set([...evidenceIds, ...(maturity?.evidenceIds || [])])]
    },
    evidence,
    maturity,
    lockComparison
  };
}

function aggregateStates(states, empty = 'unknown') {
  if (!states.length) return empty;
  if (states.includes('failed')) return 'failed';
  if (states.includes('stale')) return 'stale';
  if (states.some((state) => state === 'unknown' || state === 'skipped')) return 'unknown';
  if (states.every((state) => state === 'not-applicable')) return 'not-applicable';
  return 'passed';
}

function probeFreshness(probe, at) {
  const probedAt = Date.parse(probe.probedAt);
  const validUntil = Date.parse(probe.validUntil);
  const observedAt = Date.parse(at);
  if (!Number.isFinite(probedAt)
    || !Number.isFinite(validUntil)
    || !Number.isFinite(observedAt)
    || validUntil < probedAt
    || probedAt > observedAt) {
    return 'failed';
  }
  return observedAt > validUntil ? 'stale' : 'passed';
}

function probeAttemptFreshness(attempt, at) {
  const attemptedAt = Date.parse(attempt.attemptedAt);
  const failedAt = Date.parse(attempt.failedAt);
  const validUntil = Date.parse(attempt.validUntil);
  const observedAt = Date.parse(at);
  if (!Number.isFinite(attemptedAt)
    || !Number.isFinite(failedAt)
    || !Number.isFinite(validUntil)
    || !Number.isFinite(observedAt)
    || failedAt < attemptedAt
    || validUntil < failedAt
    || failedAt > observedAt) {
    return 'failed';
  }
  return observedAt > validUntil ? 'stale' : 'passed';
}

function failedProbeComponentStates(kind, freshness) {
  if (freshness !== 'passed') {
    return {
      credential: freshness,
      reachability: freshness,
      authority: freshness,
      capability: freshness
    };
  }
  return {
    credential: kind === 'authentication' ? 'failed' : 'unknown',
    reachability: ['unavailable', 'rate-limit', 'retryable'].includes(kind)
      ? 'failed'
      : 'unknown',
    authority: kind === 'authorization' ? 'failed' : 'unknown',
    capability: ['validation', 'conflict', 'not-found', 'unknown'].includes(kind)
      ? 'failed'
      : 'unknown'
  };
}

function failedProbeDiagnostic(attempt, freshness) {
  const location = attempt.failure.step
    ? attempt.failure.step.id + ' (' + attempt.failure.step.subject + ')'
    : attempt.failure.callId;
  const route = attempt.failure.transport.server + '/'
    + (attempt.failure.transport.operation || 'unresolved-operation') + ' -> '
    + (attempt.failure.transport.tool || 'unresolved-native-tool');
  if (freshness !== 'passed') {
    return diagnostic({
      code: freshness === 'stale'
        ? 'SOTER_PROVIDER_PROBE_ATTEMPT_STALE'
        : 'SOTER_PROVIDER_PROBE_ATTEMPT_TIME',
      severity: 'warning',
      claim: 'A failed provider probe attempt informs readiness only during its exact observation window.',
      subject: attempt.id,
      path: ['providerProbeAttempts', attempt.id, 'validUntil'],
      expected: 'A failed attempt that is chronologically valid and current at the doctor run.',
      observed: attempt.attemptedAt + ' through ' + attempt.validUntil + '.',
      remediation: 'Run a new exact-lock provider probe; do not treat an expired failure as current provider state.'
    });
  }
  const remediations = {
    authentication: 'Resolve the configured secret reference in the host, authenticate the provider route, and rerun the exact-lock probe.',
    authorization: 'Grant the minimum required provider permissions for the named authority and rerun the exact-lock probe.',
    unavailable: 'Ensure the MCP server and exact native tool are installed, exposed to this host execution, and reachable, then rerun the probe.',
    'rate-limit': 'Wait for the provider limit window or reduce probe frequency, then rerun the exact-lock probe.',
    retryable: 'Retry the exact-lock probe after the transient provider or host condition clears.',
    validation: 'Check the host mapping, provider response contract, and target schema before rerunning the exact-lock probe.',
    conflict: 'Refresh the configured provider target and mapping before rerunning the exact-lock probe.',
    'not-found': 'Correct or restore the exact configured provider target before rerunning the exact-lock probe.',
    unknown: 'Inspect the private checkpoint locally, repair the host or provider boundary, and rerun the exact-lock probe.'
  };
  return diagnostic({
    code: 'SOTER_PROVIDER_PROBE_' + attempt.failure.kind.toUpperCase().replace('-', '_'),
    severity: 'error',
    claim: 'The selected connected provider completes its exact policy-safe probe through the active host route.',
    subject: attempt.provider.implementation,
    path: ['providerProbeAttempts', attempt.id, 'failure'],
    expected: 'One completed current provider probe for the exact lock and implementation.',
    observed: 'Attempt ' + attempt.id + ' failed with ' + attempt.failure.kind
      + ' at ' + location + ' via ' + route + '.',
    remediation: remediations[attempt.failure.kind]
  });
}

function effectiveProbeState(state, freshness) {
  if (state === 'failed' || freshness === 'failed') return 'failed';
  if (freshness === 'stale') return 'stale';
  return state;
}

function checkDetails(label, state, passed, total) {
  if (!total) return label + ' are not required by this configuration.';
  if (state === 'passed') return 'All ' + total + ' required ' + label + ' checks passed.';
  return passed + ' of ' + total + ' required ' + label + ' checks passed; inspect diagnostics and probe details.';
}

export function runConnectedDoctor({
  root,
  configPath,
  lock,
  doctorId,
  evidenceId,
  createdAt,
  providerProbes = [],
  providerProbeAttempts = []
}) {
  const resolvedRoot = path.resolve(root);
  const offline = runOfflineDoctor({
    root: resolvedRoot,
    configPath,
    lock,
    doctorId,
    evidenceId,
    createdAt
  });
  const diagnostics = offline.report.diagnostics
    .filter((item) => item.code !== 'SOTER_OFFLINE_SCOPE');
  const lockFingerprint = fingerprintLock(lock);
  const probeSchemas = new Map([[
    'soter://contracts/provider-probe/v2',
    readJson(path.join(resolvedRoot, 'soter/contracts/provider-probe-v2.schema.json'))
  ]]);
  const providers = listProviderDeclarations(resolvedRoot);
  const connectedProviders = providers.filter((provider) => provider.containment === 'connected');
  const validProbes = [];
  const validProbeAttempts = [];
  const probeContractStates = [];
  const seenProbeIds = new Set();
  const seenProbeAttemptIds = new Set();

  for (const probe of providerProbes) {
    const probeSchema = probeSchemas.get(probe?.$contract);
    const failures = probeSchema
      ? validateJsonSchema(probe, probeSchema)
      : [{ path: '$.$contract', message: 'is not a supported provider probe contract' }];
    if (failures.length || seenProbeIds.has(probe?.id)) {
      probeContractStates.push('failed');
      diagnostics.push(diagnostic({
        code: seenProbeIds.has(probe?.id)
          ? 'SOTER_PROVIDER_PROBE_DUPLICATE'
          : 'SOTER_PROVIDER_PROBE_SCHEMA',
        severity: 'error',
        claim: 'Every connected provider probe is uniquely identified and satisfies its runtime contract.',
        subject: probe?.id || 'unknown provider probe',
        path: ['providerProbes'],
        expected: 'A unique provider-probe/v2 document.',
        observed: seenProbeIds.has(probe?.id)
          ? 'The probe id occurs more than once.'
          : failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; '),
        remediation: 'Regenerate the probe through the selected integration adapter without including secret values.'
      }));
      continue;
    }
    seenProbeIds.add(probe.id);
    probeContractStates.push('passed');
    validProbes.push(probe);
  }

  const probeAttemptSchema = readJson(path.join(
    resolvedRoot,
    'soter/contracts/provider-probe-attempt.schema.json'
  ));
  for (const attempt of providerProbeAttempts) {
    const failures = validateJsonSchema(attempt, probeAttemptSchema);
    const duplicate = seenProbeAttemptIds.has(attempt?.id);
    if (failures.length || duplicate) {
      probeContractStates.push('failed');
      diagnostics.push(diagnostic({
        code: duplicate
          ? 'SOTER_PROVIDER_PROBE_ATTEMPT_DUPLICATE'
          : 'SOTER_PROVIDER_PROBE_ATTEMPT_SCHEMA',
        severity: 'error',
        claim: 'Every failed provider probe attempt is uniquely identified and satisfies its secret-safe runtime contract.',
        subject: attempt?.id || 'unknown provider probe attempt',
        path: ['providerProbeAttempts'],
        expected: 'A unique provider-probe-attempt/v1 document derived from a durable failed checkpoint.',
        observed: duplicate
          ? 'The attempt id occurs more than once.'
          : failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; '),
        remediation: 'Load the exact failed provider-probe checkpoint through Core instead of constructing a readiness input manually.'
      }));
      continue;
    }
    seenProbeAttemptIds.add(attempt.id);
    probeContractStates.push('passed');
    validProbeAttempts.push(attempt);
  }

  let desiredConfiguration = null;
  let configurationState = 'passed';
  try {
    desiredConfiguration = readJson(resolveRepoPath(
      resolvedRoot,
      configPath || lock.configuration.path
    ));
    if (fingerprintJson(desiredConfiguration) !== lock.configuration.fingerprint) {
      throw new Error('Desired configuration fingerprint does not match the supplied lock.');
    }
  } catch (error) {
    configurationState = 'failed';
    diagnostics.push(diagnostic({
      code: 'SOTER_CONNECTION_CONFIGURATION',
      severity: 'error',
      claim: 'Connected checks use the exact desired configuration that produced the lock.',
      subject: lock.configuration.name,
      path: ['configuration'],
      expected: lock.configuration.fingerprint,
      observed: error.message,
      remediation: 'Restore or resolve the desired configuration before checking connected readiness.'
    }));
  }

  const connectionInputStates = [...probeContractStates, configurationState];
  const implementationStates = [];
  const probeExecutionStates = [];
  const credentialStates = [];
  const reachabilityStates = [];
  const authorityStates = [];
  const capabilityStates = [];
  const credentialKeys = new Set();
  const reachabilityKeys = new Set();
  const authorityKeys = new Set();
  const recordUniqueState = (states, keys, key, state) => {
    if (!key || keys.has(key)) return;
    keys.add(key);
    states.push(state);
  };

  for (const binding of lock.bindings) {
    const desiredBinding = desiredConfiguration?.bindings.find((item) => {
      return item.capability === binding.capability && item.providerPack === binding.providerPack;
    });
    const candidates = connectedProviders.filter((provider) => {
      return provider.pack === binding.providerPack
        && provider.capabilities.some((item) => {
          return item.id === binding.capability && item.version === binding.capabilityVersion;
        });
    });
    if (candidates.length !== 1) {
      implementationStates.push('failed');
      probeExecutionStates.push('unknown');
      if (desiredBinding?.secretRef) {
        recordUniqueState(
          credentialStates,
          credentialKeys,
          binding.providerPack + '|' + desiredBinding.secretRef,
          'unknown'
        );
      }
      recordUniqueState(
        reachabilityStates,
        reachabilityKeys,
        binding.providerPack,
        'unknown'
      );
      for (const authority of binding.authorities) {
        recordUniqueState(
          authorityStates,
          authorityKeys,
          binding.providerPack + '|' + authority,
          'unknown'
        );
      }
      capabilityStates.push('unknown');
      diagnostics.push(diagnostic({
        code: candidates.length ? 'SOTER_CONNECTED_PROVIDER_AMBIGUOUS' : 'SOTER_CONNECTED_PROVIDER_MISSING',
        severity: 'error',
        claim: 'Every required capability has exactly one declared connected provider implementation.',
        subject: binding.providerPack + '/' + binding.capability,
        path: ['bindings', binding.capability],
        expected: 'One connected implementation of ' + binding.capabilityVersion + '.',
        observed: 'Found ' + candidates.length + ' connected implementations for '
          + binding.providerPack + '/' + binding.capability + '.',
        remediation: candidates.length
          ? 'Remove the ambiguous implementation or make provider selection explicit.'
          : 'Add and declare a connected provider implementation before attempting a connected run.'
      }));
      continue;
    }

    const provider = candidates[0];
    implementationStates.push('passed');
    const matches = validProbes.filter((probe) => {
      return probe.provider.implementation === provider.id;
    });
    if (matches.length !== 1) {
      if (matches.length) {
        probeExecutionStates.push('failed');
        if (desiredBinding?.secretRef) {
          recordUniqueState(
            credentialStates,
            credentialKeys,
            provider.id + '|' + desiredBinding.secretRef,
            'failed'
          );
        }
        recordUniqueState(reachabilityStates, reachabilityKeys, provider.id, 'failed');
        for (const authority of binding.authorities) {
          recordUniqueState(
            authorityStates,
            authorityKeys,
            provider.id + '|' + authority,
            'failed'
          );
        }
        capabilityStates.push('failed');
        diagnostics.push(diagnostic({
          code: 'SOTER_PROVIDER_PROBE_AMBIGUOUS',
          severity: 'error',
          claim: 'Each selected connected provider has one current probe for the supplied lock.',
          subject: provider.id,
          path: ['providerProbes', provider.id],
          expected: 'One current probe bound to ' + lockFingerprint + '.',
          observed: 'Found ' + matches.length + ' matching probes.',
          remediation: 'Pass only the one exact current provider probe intended for this readiness run.'
        }));
        continue;
      }

      const attempts = validProbeAttempts.filter((attempt) => {
        return attempt.provider.implementation === provider.id;
      });
      const exactAttempts = attempts.filter((attempt) => {
        return attempt.configuration.name === lock.configuration.name
          && attempt.configuration.lockFingerprint === lockFingerprint
          && attempt.host.id === lock.host.id
          && attempt.host.adapter === lock.host.adapter
          && attempt.host.version === lock.host.version
          && attempt.provider.pack === provider.pack
          && attempt.provider.version === provider.version
          && attempt.provider.containment === provider.containment
          && attempt.scope.capabilities.includes(binding.capability)
          && binding.authorities.every((authority) => {
            return attempt.scope.authorities.includes(authority);
          })
          && (!desiredBinding?.secretRef
            || attempt.scope.credentialRefs.includes(desiredBinding.secretRef));
      });
      if (attempts.length === 1 && exactAttempts.length === 1) {
        const attempt = exactAttempts[0];
        const freshness = probeAttemptFreshness(attempt, createdAt);
        const executionState = freshness === 'passed' ? 'failed' : freshness;
        const components = failedProbeComponentStates(attempt.failure.kind, freshness);
        probeExecutionStates.push(executionState);
        if (desiredBinding?.secretRef) {
          recordUniqueState(
            credentialStates,
            credentialKeys,
            provider.id + '|' + desiredBinding.secretRef,
            components.credential
          );
        }
        recordUniqueState(
          reachabilityStates,
          reachabilityKeys,
          provider.id,
          components.reachability
        );
        for (const authority of binding.authorities) {
          recordUniqueState(
            authorityStates,
            authorityKeys,
            provider.id + '|' + authority,
            components.authority
          );
        }
        capabilityStates.push(components.capability);
        diagnostics.push(failedProbeDiagnostic(attempt, freshness));
        continue;
      }

      const state = attempts.length ? 'failed' : 'unknown';
      probeExecutionStates.push(state);
      if (desiredBinding?.secretRef) {
        recordUniqueState(
          credentialStates,
          credentialKeys,
          provider.id + '|' + desiredBinding.secretRef,
          state
        );
      }
      recordUniqueState(reachabilityStates, reachabilityKeys, provider.id, state);
      for (const authority of binding.authorities) {
        recordUniqueState(
          authorityStates,
          authorityKeys,
          provider.id + '|' + authority,
          state
        );
      }
      capabilityStates.push(state);
      diagnostics.push(diagnostic({
        code: attempts.length
          ? (attempts.length > 1
            ? 'SOTER_PROVIDER_PROBE_ATTEMPT_AMBIGUOUS'
            : 'SOTER_PROVIDER_PROBE_ATTEMPT_LINK')
          : 'SOTER_PROVIDER_PROBE_MISSING',
        severity: attempts.length ? 'error' : 'warning',
        claim: attempts.length
          ? 'A failed provider probe attempt applies only to the exact lock, host, and provider implementation it names.'
          : 'Each selected connected provider has one current probe for the supplied lock.',
        subject: provider.id,
        path: attempts.length
          ? ['providerProbeAttempts', provider.id]
          : ['providerProbes', provider.id],
        expected: attempts.length
          ? 'One failed attempt bound to ' + lockFingerprint + ' and the active host projection.'
          : 'One current probe bound to ' + lockFingerprint + '.',
        observed: attempts.length
          ? 'Found ' + attempts.length + ' attempt(s), of which '
            + exactAttempts.length + ' match the exact readiness scope.'
          : 'Found no completed probe or failed attempt.',
        remediation: attempts.length
          ? 'Rerun one probe through the active exact lock and pass only its resulting checkpoint.'
          : 'Run the provider adapter read-only probe and pass its durable checkpoint to the connected doctor.'
      }));
      continue;
    }

    const probe = matches[0];
    let linkState = 'passed';
    if (probe.configuration.name !== lock.configuration.name
      || probe.configuration.lockFingerprint !== lockFingerprint
      || probe.provider.pack !== provider.pack
      || probe.provider.version !== provider.version
      || probe.provider.containment !== provider.containment) {
      linkState = 'failed';
      diagnostics.push(diagnostic({
        code: 'SOTER_PROVIDER_PROBE_LINK',
        severity: 'error',
        claim: 'Provider probes apply only to the exact lock and implementation they name.',
        subject: probe.id,
        path: ['providerProbes', probe.id],
        expected: lock.configuration.name + '/' + lockFingerprint + '/' + provider.id + '@' + provider.version,
        observed: probe.configuration.name + '/' + probe.configuration.lockFingerprint
          + '/' + probe.provider.implementation + '@' + probe.provider.version,
        remediation: 'Regenerate the probe after resolving the current configuration and provider implementation.'
      }));
    }
    const freshness = linkState === 'failed' ? 'failed' : probeFreshness(probe, createdAt);
    probeExecutionStates.push(freshness);
    if (freshness !== 'passed') {
      diagnostics.push(diagnostic({
        code: freshness === 'stale' ? 'SOTER_PROVIDER_PROBE_STALE' : 'SOTER_PROVIDER_PROBE_TIME',
        severity: 'error',
        claim: 'Connected readiness relies only on a current, chronologically valid provider observation.',
        subject: probe.id,
        path: ['providerProbes', probe.id, 'validUntil'],
        expected: 'A probe observed no later than the doctor run and valid at ' + createdAt + '.',
        observed: probe.probedAt + ' through ' + probe.validUntil + '.',
        remediation: 'Run the provider probe again and do not reuse expired connection state.'
      }));
    }

    if (desiredBinding?.secretRef) {
      const credential = probe.credentials.find((item) => item.secretRefId === desiredBinding.secretRef);
      recordUniqueState(
        credentialStates,
        credentialKeys,
        provider.id + '|' + desiredBinding.secretRef,
        credential ? effectiveProbeState(credential.state, freshness) : 'failed'
      );
      if (!credential) {
        diagnostics.push(diagnostic({
          code: 'SOTER_PROVIDER_CREDENTIAL_UNCHECKED',
          severity: 'error',
          claim: 'The configured secret reference was authenticated without exposing its value.',
          subject: provider.id,
          path: ['bindings', binding.capability, 'secretRef'],
          expected: desiredBinding.secretRef,
          observed: 'The probe contains no authentication result for that reference.',
          remediation: 'Resolve the configured secret reference in the host and rerun the provider probe.'
        }));
      }
    }

    recordUniqueState(
      reachabilityStates,
      reachabilityKeys,
      provider.id,
      effectiveProbeState(probe.reachability.state, freshness)
    );
    for (const authority of binding.authorities) {
      const authorityCheck = probe.authorities.find((item) => item.id === authority);
      recordUniqueState(
        authorityStates,
        authorityKeys,
        provider.id + '|' + authority,
        authorityCheck ? effectiveProbeState(authorityCheck.state, freshness) : 'failed'
      );
      if (!authorityCheck) {
        diagnostics.push(diagnostic({
          code: 'SOTER_PROVIDER_AUTHORITY_UNCHECKED',
          severity: 'error',
          claim: 'Every bound external authority is visible to the selected provider identity.',
          subject: provider.id + '/' + authority,
          path: ['bindings', binding.capability, 'authorities'],
          expected: 'A probe result for ' + authority + '.',
          observed: 'No authority check is present.',
          remediation: 'Add a read-only authority check to the provider probe implementation.'
        }));
      }
    }
    const capabilityCheck = probe.capabilities.find((item) => item.id === binding.capability);
    capabilityStates.push(capabilityCheck
      ? effectiveProbeState(capabilityCheck.state, freshness)
      : 'failed');
    if (!capabilityCheck) {
      diagnostics.push(diagnostic({
        code: 'SOTER_PROVIDER_CAPABILITY_UNCHECKED',
        severity: 'error',
        claim: 'Every bound capability has a safe connected compatibility observation.',
        subject: provider.id + '/' + binding.capability,
        path: ['bindings', binding.capability],
        expected: 'A metadata, read-only, or permission-introspection check.',
        observed: 'No capability check is present.',
        remediation: 'Implement a non-mutating compatibility probe for the capability.'
      }));
    }
  }

  const implementationState = aggregateStates(implementationStates);
  const probeExecutionState = aggregateStates(probeExecutionStates);
  const connectionInputState = aggregateStates(connectionInputStates);
  const credentialState = aggregateStates(credentialStates, 'not-applicable');
  const reachabilityState = aggregateStates(reachabilityStates);
  const authorityState = aggregateStates(authorityStates);
  const capabilityState = aggregateStates(capabilityStates);
  const readinessInputs = [
    offline.report.states.valid,
    connectionInputState,
    implementationState,
    probeExecutionState,
    reachabilityState,
    authorityState,
    capabilityState
  ];
  if (credentialState !== 'not-applicable') readinessInputs.push(credentialState);
  const ready = aggregateStates(readinessInputs);
  const checks = [
    ...offline.report.checks.filter((check) => {
      return check.id === 'kernel.graph-valid' || check.id === 'core.lock-current';
    }),
    {
      id: 'connections.runtime-state-valid',
      claim: 'Connected checks use the exact desired configuration and contract-valid provider observations.',
      state: connectionInputState,
      evidenceIds: [],
      details: connectionInputState === 'passed'
        ? 'The desired configuration matches the lock and every supplied probe or failed-attempt summary is uniquely typed.'
        : 'The desired configuration or one of the supplied provider-observation artifacts is invalid.'
    },
    {
      id: 'integrations.implementations-ready',
      claim: 'Every required capability resolves to exactly one connected provider implementation.',
      state: implementationState,
      evidenceIds: [],
      details: checkDetails(
        'connected implementation',
        implementationState,
        implementationStates.filter((state) => state === 'passed').length,
        implementationStates.length
      )
    },
    {
      id: 'integrations.probes-complete',
      claim: 'Every selected connected capability binding has current exact-lock provider-probe coverage through the active host route.',
      state: probeExecutionState,
      evidenceIds: [],
      details: checkDetails(
        'capability-binding probe execution',
        probeExecutionState,
        probeExecutionStates.filter((state) => state === 'passed').length,
        probeExecutionStates.length
      )
    },
    {
      id: 'connections.credentials-ready',
      claim: 'Configured secret references authenticate with sufficient provider permissions.',
      state: credentialState,
      evidenceIds: [],
      details: checkDetails(
        'credential',
        credentialState,
        credentialStates.filter((state) => state === 'passed').length,
        credentialStates.length
      )
    },
    {
      id: 'integrations.reachable',
      claim: 'Selected connected provider endpoints are currently reachable.',
      state: reachabilityState,
      evidenceIds: [],
      details: checkDetails(
        'reachability',
        reachabilityState,
        reachabilityStates.filter((state) => state === 'passed').length,
        reachabilityStates.length
      )
    },
    {
      id: 'authorities.current',
      claim: 'Every configured external authority is visible to its selected provider identity.',
      state: authorityState,
      evidenceIds: [],
      details: checkDetails(
        'authority',
        authorityState,
        authorityStates.filter((state) => state === 'passed').length,
        authorityStates.length
      )
    },
    {
      id: 'integrations.capability-compatible',
      claim: 'Required capabilities pass safe connected compatibility checks.',
      state: capabilityState,
      evidenceIds: [],
      details: checkDetails(
        'capability',
        capabilityState,
        capabilityStates.filter((state) => state === 'passed').length,
        capabilityStates.length
      )
    },
    ...offline.report.checks.filter((check) => check.id === 'behavior.evidence-current'),
    {
      id: 'runtime.health-current',
      claim: 'Recent real outcomes establish current end-to-end health for this configuration.',
      state: 'unknown',
      evidenceIds: [],
      details: 'Connected probes establish start readiness only; outcome health requires canary or monitored run evidence.'
    }
  ];

  diagnostics.push(diagnostic({
    code: 'SOTER_CONNECTED_SCOPE',
    severity: 'info',
    claim: 'Connected doctor derives readiness from exact, short-lived, read-only provider probes.',
    subject: lock.configuration.name,
    expected: 'No provider mutation, dispatch, destructive effect, or secret value enters the report.',
    observed: 'Connected readiness was evaluated from ' + validProbes.length
      + ' completed probe(s) and ' + validProbeAttempts.length
      + ' failed-attempt summary record(s).',
    evidenceIds: offline.report.evidenceIds,
    remediation: 'Use a separately authorized canary when write or dispatch behavior must be established.'
  }));

  return {
    report: {
      $contract: 'soter://contracts/doctor-result/v1',
      contractVersion: '1.0.0',
      id: doctorId,
      createdAt,
      level: 'connected',
      configuration: {
        name: lock.configuration.name,
        lockFingerprint
      },
      states: {
        valid: offline.report.states.valid,
        ready,
        verified: offline.report.states.verified,
        healthy: 'unknown'
      },
      checks,
      diagnostics,
      providerProbeIds: validProbes.map((probe) => probe.id).sort(),
      evidenceIds: offline.report.evidenceIds
    },
    evidence: offline.evidence,
    maturity: offline.maturity,
    lockComparison: offline.lockComparison
  };
}

export function formatDoctorReport(report) {
  const lines = [
    'Soter doctor (' + report.level + '): ' + report.configuration.name,
    '  valid=' + report.states.valid
      + ' ready=' + report.states.ready
      + ' verified=' + report.states.verified
      + ' healthy=' + report.states.healthy,
    ''
  ];
  for (const check of report.checks) {
    lines.push('  [' + check.state.toUpperCase() + '] ' + check.id + ' — ' + check.details);
  }
  if (report.diagnostics.length) {
    lines.push('', 'Diagnostics:');
    for (const item of report.diagnostics) {
      lines.push('  [' + item.severity.toUpperCase() + '] ' + item.code + ' — ' + item.observed);
      lines.push('    remediation: ' + item.remediation);
    }
  }
  return lines.join('\n');
}
