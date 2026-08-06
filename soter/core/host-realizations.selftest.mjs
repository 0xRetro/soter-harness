import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertHostRealizationInspection,
  beginHostRealizationRequest,
  confirmHostRealizationRequest,
  executeHostRealization,
  inspectManagedHostProjectionOwnership,
  inspectHostRealization,
  prepareHostRealization,
  prepareHostRealizationExecution,
  recoverHostRealization
} from './host-realizations.mjs';
import { renderHostProjectionCandidates } from './host-projections.mjs';
import { fingerprintLock, resolveConfiguration } from './resolve.mjs';
import {
  privateConfigurationStatePath,
  writePrivateConfigurationState
} from './private-configurations.mjs';
import {
  activeConfigurationLockStatePath,
  hostManagedManifestStatePath,
  hostRealizationCheckpointStatePath,
  hostRealizationConfirmationStatePath,
  hostRealizationConsumptionStatePath,
  hostRealizationPlanStatePath,
  hostRealizationRequestStatePath,
  readHostManagedManifestState,
  writeActiveConfigurationLockState,
  writeHostManagedManifestState
} from './runtime-state.mjs';
import { fingerprintJson, readJson, sha256 } from './lib/canonical-json.mjs';
import { validateJsonSchema } from '../kernel/verify.mjs';

const CREATED = '2026-07-16T12:00:00.000Z';
const CONFIRMED = '2026-07-16T12:05:00.000Z';
const STARTED = '2026-07-16T12:06:00.000Z';
const EXECUTED = '2026-07-16T12:07:00.000Z';
const VALID_UNTIL = '2026-07-16T13:00:00.000Z';

function copyRuntime(sourceRoot, label) {
  const root = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    'soter-host-realization-' + label + '-'
  ));
  fs.cpSync(path.join(sourceRoot, 'soter'), path.join(root, 'soter'), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(root, 'package.json'));
  fs.copyFileSync(path.join(sourceRoot, 'package-lock.json'), path.join(root, 'package-lock.json'));
  return root;
}

function activate(root, configurationName) {
  const configPath = 'soter/configurations/' + configurationName + '.config.json';
  writePrivateConfigurationState(root, configurationName, readJson(path.join(root, configPath)));
  const lock = resolveConfiguration({
    root,
    configPath: privateConfigurationStatePath(root, configurationName)
  });
  writeActiveConfigurationLockState(root, configurationName, lock);
  return lock;
}

function authorizePlan(root, label, plan, times = {}) {
  const createdAt = times.createdAt || CREATED;
  const confirmedAt = times.confirmedAt || CONFIRMED;
  const startedAt = times.startedAt || STARTED;
  const request = beginHostRealizationRequest({
    root,
    planId: plan.id,
    id: 'host-realization-request.' + label,
    reason: 'Confirm the exact contained host projection plan.',
    createdAt,
    expiresAt: times.requestExpiresAt || '2026-07-16T12:30:00.000Z'
  }).request;
  const confirmation = confirmHostRealizationRequest({
    root,
    requestId: request.id,
    id: 'host-realization-confirmation.' + label,
    actor: { type: 'local-operator', id: 'operator.selftest' },
    reason: 'Confirm the exact contained host projection scope.',
    confirmedAt
  }).confirmation;
  const execution = prepareHostRealizationExecution({
    root,
    confirmationId: confirmation.id,
    checkpointId: 'checkpoint.host-realization.' + label,
    at: startedAt
  });
  return { plan, request, confirmation, execution };
}

function authority(root, label, configurationName = 'meeting-intake', times = {}) {
  const plan = prepareHostRealization({
    root,
    configurationName,
    id: 'host-realization-plan.' + label,
    createdAt: times.createdAt || CREATED,
    validUntil: times.validUntil || VALID_UNTIL
  }).plan;
  return authorizePlan(root, label, plan, times);
}

function assertMode(file, expected) {
  if (process.platform === 'win32') return;
  assert.equal((fs.statSync(file).mode & 0o777).toString(8).padStart(4, '0'), expected);
}

function resealManifest(manifest) {
  manifest.manifestFingerprint = null;
  const unsigned = { ...manifest };
  delete unsigned.manifestFingerprint;
  manifest.manifestFingerprint = fingerprintJson(unsigned);
  return manifest;
}

function resealPlan(plan) {
  plan.scopeFingerprint = fingerprintJson(plan.operations.map((operation) => ({
    id: operation.id,
    sequence: operation.sequence,
    action: operation.action,
    path: operation.path,
    role: operation.role,
    mode: operation.after.mode,
    beforeFingerprint: operation.before.fingerprint,
    afterFingerprint: operation.after.fingerprint
  })));
  plan.planFingerprint = null;
  const unsigned = { ...plan };
  delete unsigned.planFingerprint;
  plan.planFingerprint = fingerprintJson(unsigned);
  return plan;
}

function resealInspection(inspection) {
  inspection.inspectionFingerprint = null;
  const unsigned = { ...inspection };
  delete unsigned.inspectionFingerprint;
  inspection.inspectionFingerprint = fingerprintJson(unsigned);
  return inspection;
}

function resealRecord(value, property) {
  value[property] = null;
  const unsigned = { ...value };
  delete unsigned[property];
  value[property] = fingerprintJson(unsigned);
  return value;
}

export async function selftestHostRealizations(sourceRoot) {
  const roots = [];
  try {
    const independence = copyRuntime(sourceRoot, 'candidate-independence');
    roots.push(independence);
    const firstLock = resolveConfiguration({
      root: independence,
      configPath: 'soter/configurations/meeting-intake.config.json'
    });
    fs.writeFileSync(path.join(independence, 'AGENTS.md'), 'HOSTILE_DEVELOPMENT_GUIDANCE\n');
    fs.mkdirSync(path.join(independence, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(independence, '.codex/config.toml'), 'HOSTILE_DEVELOPMENT_CONFIG\n');
    const secondLock = resolveConfiguration({
      root: independence,
      configPath: 'soter/configurations/meeting-intake.config.json'
    });
    assert.equal(
      fingerprintLock(secondLock),
      fingerprintLock(firstLock),
      'Resolved host candidates depended on current developer projection bytes.'
    );
    activate(independence, 'meeting-intake');
    assert.throws(
      () => prepareHostRealization({
        root: independence,
        configurationName: 'meeting-intake',
        id: 'host-realization-plan.collision',
        createdAt: CREATED,
        validUntil: VALID_UNTIL
      }),
      (error) => error.code === 'HOST_REALIZATION_UNMANAGED_COLLISION'
    );

    const codexNotionTool = copyRuntime(sourceRoot, 'codex-notion-tool');
    roots.push(codexNotionTool);
    const codexAdapterFile = path.join(
      codexNotionTool,
      'soter/hosts/codex/adapter.json'
    );
    const codexProjectionFile = path.join(
      codexNotionTool,
      'soter/hosts/codex/projection.json'
    );
    const originalCodexAdapter = fs.readFileSync(codexAdapterFile, 'utf8');
    const originalCodexProjection = fs.readFileSync(codexProjectionFile, 'utf8');
    const currentCodexAdapter = JSON.parse(originalCodexAdapter);
    const codexQueryMapping = currentCodexAdapter.mcpServers
      .find((server) => server.id === 'notion')
      ?.toolMappings.find((mapping) => mapping.logical === 'query_data_sources');
    assert.equal(currentCodexAdapter.version, '0.3.1');
    assert.equal(
      codexQueryMapping?.native,
      'mcp__codex_apps__notion_query_data_sources',
      'Current Codex adapter did not select the corrected native Notion query tool.'
    );
    const codexLock = activate(codexNotionTool, 'harness-development-catalog');
    assert.equal(codexLock.host.version, '0.3.1');
    const codexUnselectedRendered = renderHostProjectionCandidates({
      root: codexNotionTool,
      adapter: currentCodexAdapter,
      configurationId: codexLock.configuration.name,
      packIds: codexLock.packs.map((pack) => pack.id),
      capabilityIds: codexLock.capabilities.map((capability) => capability.id),
      effectPolicies: codexLock.effectPolicies
    });
    const codexUnselectedTools = codexUnselectedRendered.outputs.find((output) => {
      return output.id === 'output.codex.tools';
    });
    assert.equal(codexUnselectedTools.content, [
      '[mcp_servers.soter]',
      'command = "node"',
      'args = ["soter/core/mcp/server.mjs", "--host", "codex"]',
      ''
    ].join('\n'), 'An unselected provider changed the byte-exact base Codex MCP projection.');
    assert(!codexUnselectedTools.content.includes('mcp_servers.otter')
      && !codexUnselectedTools.content.includes('mcp.otter.ai')
      && !codexUnselectedTools.content.includes('auth = "oauth"'),
    'An unselected Otter provider leaked into the Codex MCP projection.');
    const expectCodexDriftToInvalidateActiveLock = () => {
      const drifted = resolveConfiguration({
        root: codexNotionTool,
        configPath: 'soter/configurations/harness-development-catalog.config.json'
      });
      assert.notEqual(
        fingerprintLock(drifted),
        fingerprintLock(codexLock),
        'Host adapter or projection drift did not invalidate the exact active lock.'
      );
    };
    const codexMetadataDrift = JSON.parse(originalCodexAdapter);
    codexMetadataDrift.limitations.push('Hostile unrelated Codex adapter drift.');
    fs.writeFileSync(
      codexAdapterFile,
      JSON.stringify(codexMetadataDrift, null, 2) + '\n'
    );
    expectCodexDriftToInvalidateActiveLock();
    fs.writeFileSync(codexAdapterFile, originalCodexAdapter);
    const codexMappingDrift = JSON.parse(originalCodexAdapter);
    codexMappingDrift.mcpServers.find((server) => server.id === 'notion')
      .toolMappings.find((mapping) => mapping.logical === 'fetch').native
        = 'mcp__codex_apps__notion_hostile_fetch';
    fs.writeFileSync(
      codexAdapterFile,
      JSON.stringify(codexMappingDrift, null, 2) + '\n'
    );
    expectCodexDriftToInvalidateActiveLock();
    fs.writeFileSync(codexAdapterFile, originalCodexAdapter);
    const codexOldQueryMapping = JSON.parse(originalCodexAdapter);
    codexOldQueryMapping.mcpServers.find((server) => server.id === 'notion')
      .toolMappings.find((mapping) => mapping.logical === 'query_data_sources').native
        = 'mcp__codex_apps__notion_notion_query_data_sources';
    fs.writeFileSync(
      codexAdapterFile,
      JSON.stringify(codexOldQueryMapping, null, 2) + '\n'
    );
    expectCodexDriftToInvalidateActiveLock();
    fs.writeFileSync(codexAdapterFile, originalCodexAdapter);
    const codexProjectionDrift = JSON.parse(originalCodexProjection);
    codexProjectionDrift.limitations.push('Hostile unrelated Codex projection drift.');
    fs.writeFileSync(
      codexProjectionFile,
      JSON.stringify(codexProjectionDrift, null, 2) + '\n'
    );
    expectCodexDriftToInvalidateActiveLock();
    fs.writeFileSync(codexProjectionFile, originalCodexProjection);

    const claudeRootMcp = copyRuntime(sourceRoot, 'claude-root-mcp');
    roots.push(claudeRootMcp);
    const claudeLock = activate(claudeRootMcp, 'harness-development-catalog-claude');
    assert(claudeLock.projections.some((projection) => {
      return projection.id === 'output.claude.tools' && projection.path === '.mcp.json';
    }), 'Current Claude lock did not select the corrected root MCP path.');
    const claudeAdapterFile = path.join(
      claudeRootMcp,
      'soter/hosts/claude/adapter.json'
    );
    const claudeProjectionFile = path.join(
      claudeRootMcp,
      'soter/hosts/claude/projection.json'
    );
    const originalClaudeAdapter = fs.readFileSync(claudeAdapterFile, 'utf8');
    const originalClaudeProjection = fs.readFileSync(claudeProjectionFile, 'utf8');
    const expectClaudeDriftToInvalidateActiveLock = () => {
      const drifted = resolveConfiguration({
        root: claudeRootMcp,
        configPath: 'soter/configurations/harness-development-catalog-claude.config.json'
      });
      assert.notEqual(
        fingerprintLock(drifted),
        fingerprintLock(claudeLock),
        'Host adapter or projection drift did not invalidate the exact active lock.'
      );
    };
    const metadataDrift = JSON.parse(originalClaudeAdapter);
    metadataDrift.limitations.push('Hostile unrelated adapter drift.');
    fs.writeFileSync(claudeAdapterFile, JSON.stringify(metadataDrift, null, 2) + '\n');
    expectClaudeDriftToInvalidateActiveLock();
    fs.writeFileSync(claudeAdapterFile, originalClaudeAdapter);
    const toolDrift = JSON.parse(originalClaudeAdapter);
    toolDrift.mcpServers.find((server) => server.id === 'notion')
      .toolMappings.find((mapping) => mapping.logical === 'fetch').native
        = 'Notion:hostile-unreviewed-fetch';
    fs.writeFileSync(claudeAdapterFile, JSON.stringify(toolDrift, null, 2) + '\n');
    expectClaudeDriftToInvalidateActiveLock();
    fs.writeFileSync(claudeAdapterFile, originalClaudeAdapter);
    const projectionDrift = JSON.parse(originalClaudeProjection);
    projectionDrift.limitations.push('Hostile unrelated projection drift.');
    fs.writeFileSync(
      claudeProjectionFile,
      JSON.stringify(projectionDrift, null, 2) + '\n'
    );
    expectClaudeDriftToInvalidateActiveLock();
    fs.writeFileSync(claudeProjectionFile, originalClaudeProjection);
    const claudeAuthority = authority(
      claudeRootMcp,
      'claude-root-mcp',
      'harness-development-catalog-claude'
    );
    assert.equal(executeHostRealization({
      root: claudeRootMcp,
      checkpointId: claudeAuthority.execution.checkpoint.id,
      at: EXECUTED
    }).state, 'completed');
    assert(fs.existsSync(path.join(claudeRootMcp, 'CLAUDE.md')));
    assert(fs.existsSync(path.join(claudeRootMcp, '.mcp.json')));
    assert(!fs.existsSync(path.join(claudeRootMcp, '.claude/.mcp.json')),
      'Current Claude realization reproduced the retired nested MCP path.');
    const realizedClaudeSkill = path.join(
      claudeRootMcp,
      '.claude/skills/running-evals/SKILL.md'
    );
    assert(fs.existsSync(realizedClaudeSkill),
      'Current Claude realization omitted an active governed workflow skill.');
    const realizedClaudeSkillContent = fs.readFileSync(realizedClaudeSkill, 'utf8');
    assert(!realizedClaudeSkillContent.includes('disable-model-invocation:'),
      'Active Claude workflow skill remained unavailable to the governed host agent.');
    assert(realizedClaudeSkillContent.includes('soter_create_development_request')
      && realizedClaudeSkillContent.includes('soter_read_development_target')
      && realizedClaudeSkillContent.includes('soter_record_development_result')
      && realizedClaudeSkillContent.includes('grants no provider'),
    'Active Claude workflow skill omitted its exact request, result, or no-authority boundary.');
    assertMode(path.join(claudeRootMcp, '.mcp.json'), '0644');
    assert.equal(inspectManagedHostProjectionOwnership({
      root: claudeRootMcp,
      host: 'claude'
    }).state, 'realized');
    const unmanagedClaudeSkill = path.join(
      claudeRootMcp,
      '.claude/skills/unmanaged-neighbor/SKILL.md'
    );
    fs.mkdirSync(path.dirname(unmanagedClaudeSkill), { recursive: true });
    fs.writeFileSync(unmanagedClaudeSkill, 'Unmanaged neighboring skill.\n', { mode: 0o644 });
    assert.throws(
      () => inspectManagedHostProjectionOwnership({ root: claudeRootMcp, host: 'claude' }),
      (error) => error.code === 'HOST_REALIZATION_MANAGED_DRIFT'
    );
    fs.rmSync(path.dirname(unmanagedClaudeSkill), { recursive: true, force: true });
    assert.equal(inspectManagedHostProjectionOwnership({
      root: claudeRootMcp,
      host: 'claude'
    }).state, 'realized');

    const exactClaudeManifest = structuredClone(
      readHostManagedManifestState(claudeRootMcp, 'claude').manifest
    );
    const inventedClaudeSkill = path.join(
      claudeRootMcp,
      '.claude/skills/invented-review/SKILL.md'
    );
    const inventedClaudeContent = 'Invented self-sealed Claude skill.\n';
    fs.mkdirSync(path.dirname(inventedClaudeSkill), { recursive: true });
    fs.writeFileSync(inventedClaudeSkill, inventedClaudeContent, { mode: 0o644 });
    const forgedClaudeManifest = structuredClone(exactClaudeManifest);
    const runningEvalsOutput = forgedClaudeManifest.outputs.find((output) => {
      return output.path === '.claude/skills/running-evals/SKILL.md';
    });
    const inventedContentFingerprint = sha256(Buffer.from(inventedClaudeContent, 'utf8'));
    forgedClaudeManifest.outputs.push({
      ...runningEvalsOutput,
      id: 'output.claude.workflow-guide.invented-review.skill',
      path: '.claude/skills/invented-review/SKILL.md',
      contentFingerprint: inventedContentFingerprint,
      fingerprint: fingerprintJson({
        contentFingerprint: inventedContentFingerprint,
        mode: '0644'
      })
    });
    forgedClaudeManifest.outputs.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    writeHostManagedManifestState(claudeRootMcp, resealManifest(forgedClaudeManifest));
    assert.throws(
      () => inspectManagedHostProjectionOwnership({ root: claudeRootMcp, host: 'claude' }),
      (error) => error.code === 'HOST_REALIZATION_CANDIDATE_DRIFT'
    );
    writeHostManagedManifestState(claudeRootMcp, exactClaudeManifest);
    fs.rmSync(path.dirname(inventedClaudeSkill), { recursive: true, force: true });
    assert.equal(inspectManagedHostProjectionOwnership({
      root: claudeRootMcp,
      host: 'claude'
    }).state, 'realized');

    const credentialTemplate = copyRuntime(sourceRoot, 'credential-template');
    roots.push(credentialTemplate);
    fs.appendFileSync(
      path.join(credentialTemplate, 'soter/hosts/codex/templates/AGENTS.md.tmpl'),
      'sk-' + 'HOSTILECREDENTIALMATERIAL1234567890\n'
    );
    assert.throws(
      () => resolveConfiguration({
        root: credentialTemplate,
        configPath: 'soter/configurations/meeting-intake.config.json'
      }),
      (error) => error.code === 'HOST_PROJECTION_CREDENTIAL_REJECTED'
    );

    for (const [label, protectedPath] of [
      ['protected-git', '.git/config'],
      ['protected-private-state', '.soter/state/private.json']
    ]) {
      const protectedRoot = copyRuntime(sourceRoot, label);
      roots.push(protectedRoot);
      const projectionPath = path.join(protectedRoot, 'soter/hosts/codex/projection.json');
      const projection = readJson(projectionPath);
      projection.outputs[0].path = protectedPath;
      fs.writeFileSync(projectionPath, JSON.stringify(projection, null, 2) + '\n');
      assert.throws(
        () => activate(protectedRoot, 'meeting-intake'),
        /SOTER_HOST_PROJECTION_DEFINITION/,
        `Governed graph accepted host output in protected namespace ${protectedPath}.`
      );
    }

    const protectedPlanRoot = copyRuntime(sourceRoot, 'protected-private-plan');
    roots.push(protectedPlanRoot);
    activate(protectedPlanRoot, 'meeting-intake');
    const protectedPlan = prepareHostRealization({
      root: protectedPlanRoot,
      configurationName: 'meeting-intake',
      id: 'host-realization-plan.protected-private-plan',
      createdAt: CREATED,
      validUntil: VALID_UNTIL
    }).plan;
    const priorPath = protectedPlan.operations[0].path;
    protectedPlan.operations[0].path = '.soter/state/private.json';
    protectedPlan.candidateManifest.outputs.find((output) => output.path === priorPath).path
      = '.soter/state/private.json';
    fs.writeFileSync(
      hostRealizationPlanStatePath(protectedPlanRoot, protectedPlan.id),
      JSON.stringify(resealPlan(protectedPlan), null, 2) + '\n',
      { mode: 0o600 }
    );
    assert.throws(
      () => beginHostRealizationRequest({
        root: protectedPlanRoot,
        planId: protectedPlan.id,
        id: 'host-realization-request.protected-private-plan',
        reason: 'Reject a re-signed plan targeting private runtime authority state.',
        createdAt: CREATED,
        expiresAt: '2026-07-16T12:30:00.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_PATH_INVALID',
      'Host realization accepted a re-signed output targeting private runtime authority state.'
    );

    const redirected = copyRuntime(sourceRoot, 'redirected-plan');
    roots.push(redirected);
    activate(redirected, 'meeting-intake');
    const redirectedPlan = prepareHostRealization({
      root: redirected,
      configurationName: 'meeting-intake',
      id: 'host-realization-plan.redirected',
      createdAt: CREATED,
      validUntil: VALID_UNTIL
    }).plan;
    redirectedPlan.operations[0].path = 'HOSTILE-redirected-output';
    fs.writeFileSync(
      hostRealizationPlanStatePath(redirected, redirectedPlan.id),
      JSON.stringify(resealPlan(redirectedPlan), null, 2) + '\n',
      { mode: 0o600 }
    );
    assert.throws(
      () => beginHostRealizationRequest({
        root: redirected,
        planId: redirectedPlan.id,
        id: 'host-realization-request.redirected',
        reason: 'Reject the re-signed operation that no longer matches exact ownership.',
        createdAt: CREATED,
        expiresAt: '2026-07-16T12:30:00.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_PLAN_TAMPERED'
    );

    const checkpointCollision = copyRuntime(sourceRoot, 'checkpoint-collision');
    roots.push(checkpointCollision);
    activate(checkpointCollision, 'meeting-intake');
    const collisionPlan = prepareHostRealization({
      root: checkpointCollision,
      configurationName: 'meeting-intake',
      id: 'host-realization-plan.checkpoint-collision',
      createdAt: CREATED,
      validUntil: VALID_UNTIL
    }).plan;
    const collisionRequest = beginHostRealizationRequest({
      root: checkpointCollision,
      planId: collisionPlan.id,
      id: 'host-realization-request.checkpoint-collision',
      reason: 'Prepare an exact request for checkpoint collision pressure.',
      createdAt: '2026-07-16T12:01:00.000Z',
      expiresAt: '2026-07-16T12:30:00.000Z'
    }).request;
    const collisionConfirmation = confirmHostRealizationRequest({
      root: checkpointCollision,
      requestId: collisionRequest.id,
      id: 'host-realization-confirmation.checkpoint-collision',
      actor: { type: 'local-operator', id: 'operator.selftest' },
      reason: 'Confirm the exact collision-pressure request.',
      confirmedAt: '2026-07-16T12:02:00.000Z'
    }).confirmation;
    const collisionCheckpointId = 'checkpoint.host-realization.checkpoint-collision';
    const collisionCheckpointPath = hostRealizationCheckpointStatePath(
      checkpointCollision,
      collisionCheckpointId
    );
    fs.mkdirSync(path.dirname(collisionCheckpointPath), { recursive: true, mode: 0o700 });
    const collisionCheckpointBytes = '{"occupied":true}\n';
    fs.writeFileSync(collisionCheckpointPath, collisionCheckpointBytes, { mode: 0o600 });
    assert.throws(
      () => prepareHostRealizationExecution({
        root: checkpointCollision,
        confirmationId: collisionConfirmation.id,
        checkpointId: collisionCheckpointId,
        at: '2026-07-16T12:03:00.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_CHECKPOINT_BINDING_INVALID'
    );
    assert(!fs.existsSync(hostRealizationConsumptionStatePath(
      checkpointCollision,
      'host-realization-consumption.checkpoint-collision'
    )), 'Checkpoint collision reserved fresh one-time start authority.');
    assert.equal(fs.readFileSync(collisionCheckpointPath, 'utf8'), collisionCheckpointBytes,
      'Checkpoint collision mutated the occupied checkpoint.');
    assert(!fs.existsSync(path.join(checkpointCollision, 'AGENTS.md')),
      'Checkpoint collision applied a managed host output.');
    assert(!fs.existsSync(hostManagedManifestStatePath(checkpointCollision, 'codex')),
      'Checkpoint collision created a managed host manifest.');

    const causal = copyRuntime(sourceRoot, 'causal-order');
    roots.push(causal);
    activate(causal, 'meeting-intake');
    const causalPlan = prepareHostRealization({
      root: causal,
      configurationName: 'meeting-intake',
      id: 'host-realization-plan.causal-order',
      createdAt: CREATED,
      validUntil: VALID_UNTIL
    }).plan;
    const earlyRequestId = 'host-realization-request.causal-order-early';
    assert.throws(
      () => beginHostRealizationRequest({
        root: causal,
        planId: causalPlan.id,
        id: earlyRequestId,
        reason: 'Reject a request created before its exact plan.',
        createdAt: '2026-07-16T11:59:00.000Z',
        expiresAt: '2026-07-16T12:30:00.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_REQUEST_WINDOW_INVALID'
    );
    assert(!fs.existsSync(hostRealizationRequestStatePath(causal, earlyRequestId)),
      'A request created before its exact plan reached durable state.');

    const causalRequest = beginHostRealizationRequest({
      root: causal,
      planId: causalPlan.id,
      id: 'host-realization-request.causal-order',
      reason: 'Create a request inside its exact plan window.',
      createdAt: '2026-07-16T12:01:00.000Z',
      expiresAt: '2026-07-16T12:30:00.000Z'
    }).request;
    const causalRequestPath = hostRealizationRequestStatePath(causal, causalRequest.id);
    const crossedRequestRecord = structuredClone(causalRequest);
    crossedRequestRecord.createdAt = '2026-07-16T11:59:00.000Z';
    resealRecord(crossedRequestRecord, 'requestFingerprint');
    fs.writeFileSync(causalRequestPath, JSON.stringify(crossedRequestRecord, null, 2) + '\n');
    assert.throws(
      () => confirmHostRealizationRequest({
        root: causal,
        requestId: causalRequest.id,
        id: 'host-realization-confirmation.causal-order-tampered-request',
        actor: { type: 'local-operator', id: 'operator.selftest' },
        reason: 'Reject a re-signed request outside its exact plan window.',
        confirmedAt: '2026-07-16T12:02:00.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_REQUEST_BINDING_INVALID'
    );
    fs.writeFileSync(causalRequestPath, JSON.stringify(causalRequest, null, 2) + '\n');

    const earlyConfirmationId = 'host-realization-confirmation.causal-order-early';
    assert.throws(
      () => confirmHostRealizationRequest({
        root: causal,
        requestId: causalRequest.id,
        id: earlyConfirmationId,
        actor: { type: 'local-operator', id: 'operator.selftest' },
        reason: 'Reject confirmation before the exact request.',
        confirmedAt: '2026-07-16T12:00:30.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_TIME_INVALID'
    );
    assert(!fs.existsSync(hostRealizationConfirmationStatePath(causal, earlyConfirmationId)),
      'A confirmation preceding its exact request reached durable state.');

    const causalConfirmation = confirmHostRealizationRequest({
      root: causal,
      requestId: causalRequest.id,
      id: 'host-realization-confirmation.causal-order',
      actor: { type: 'local-operator', id: 'operator.selftest' },
      reason: 'Confirm inside the exact request window.',
      confirmedAt: '2026-07-16T12:02:00.000Z'
    }).confirmation;
    const causalConfirmationPath = hostRealizationConfirmationStatePath(causal, causalConfirmation.id);
    const crossedConfirmationRecord = structuredClone(causalConfirmation);
    crossedConfirmationRecord.confirmedAt = '2026-07-16T12:00:30.000Z';
    resealRecord(crossedConfirmationRecord, 'confirmationFingerprint');
    fs.writeFileSync(causalConfirmationPath, JSON.stringify(crossedConfirmationRecord, null, 2) + '\n');
    assert.throws(
      () => prepareHostRealizationExecution({
        root: causal,
        confirmationId: causalConfirmation.id,
        checkpointId: 'checkpoint.host-realization.causal-order-tampered-confirmation',
        at: '2026-07-16T12:03:00.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_CONFIRMATION_BINDING_INVALID'
    );
    fs.writeFileSync(causalConfirmationPath, JSON.stringify(causalConfirmation, null, 2) + '\n');

    const earlyCheckpointId = 'checkpoint.host-realization.causal-order-early';
    assert.throws(
      () => prepareHostRealizationExecution({
        root: causal,
        confirmationId: causalConfirmation.id,
        checkpointId: earlyCheckpointId,
        at: '2026-07-16T12:01:30.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_TIME_INVALID'
    );
    assert(!fs.existsSync(hostRealizationConsumptionStatePath(
      causal,
      'host-realization-consumption.causal-order'
    )), 'Execution before confirmation created a durable consumption.');
    assert(!fs.existsSync(hostRealizationCheckpointStatePath(causal, earlyCheckpointId)),
      'Execution before confirmation created a durable checkpoint.');

    const causalExecution = prepareHostRealizationExecution({
      root: causal,
      confirmationId: causalConfirmation.id,
      checkpointId: 'checkpoint.host-realization.causal-order',
      at: '2026-07-16T12:03:00.000Z'
    });
    const causalConsumptionPath = hostRealizationConsumptionStatePath(
      causal,
      causalExecution.consumption.id
    );
    const causalCheckpointPath = hostRealizationCheckpointStatePath(
      causal,
      causalExecution.checkpoint.id
    );
    const reservedConsumption = structuredClone(causalExecution.consumption);
    reservedConsumption.state = 'reserved';
    reservedConsumption.updatedAt = reservedConsumption.createdAt;
    reservedConsumption.checkpointFingerprint = null;
    resealRecord(reservedConsumption, 'consumptionFingerprint');
    fs.writeFileSync(causalConsumptionPath, JSON.stringify(reservedConsumption, null, 2) + '\n');
    const reservedConsumptionBytes = fs.readFileSync(causalConsumptionPath, 'utf8');
    fs.unlinkSync(causalCheckpointPath);
    assert.throws(
      () => prepareHostRealizationExecution({
        root: causal,
        confirmationId: causalConfirmation.id,
        checkpointId: causalExecution.checkpoint.id,
        at: '2026-07-16T12:02:30.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_TIME_INVALID'
    );
    assert(!fs.existsSync(causalCheckpointPath),
      'A backdated reserved-consumption retry left an orphan checkpoint.');
    assert.equal(fs.readFileSync(causalConsumptionPath, 'utf8'), reservedConsumptionBytes,
      'A backdated reserved-consumption retry mutated its reservation.');
    const earlyReservedCheckpoint = structuredClone(causalExecution.checkpoint);
    earlyReservedCheckpoint.createdAt = '2026-07-16T12:02:30.000Z';
    earlyReservedCheckpoint.updatedAt = '2026-07-16T12:02:30.000Z';
    resealRecord(earlyReservedCheckpoint, 'checkpointFingerprint');
    fs.writeFileSync(
      causalCheckpointPath,
      JSON.stringify(earlyReservedCheckpoint, null, 2) + '\n'
    );
    assert.throws(
      () => prepareHostRealizationExecution({
        root: causal,
        confirmationId: causalConfirmation.id,
        checkpointId: causalExecution.checkpoint.id,
        at: '2026-07-16T12:04:00.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_CHECKPOINT_BINDING_INVALID'
    );
    assert.equal(fs.readFileSync(causalConsumptionPath, 'utf8'), reservedConsumptionBytes,
      'A checkpoint preceding its reservation consumed one-time start authority.');
    fs.unlinkSync(causalCheckpointPath);

    fs.writeFileSync(
      causalConsumptionPath,
      JSON.stringify(causalExecution.consumption, null, 2) + '\n'
    );
    fs.writeFileSync(
      causalCheckpointPath,
      JSON.stringify(causalExecution.checkpoint, null, 2) + '\n'
    );

    const causalCheckpointBytes = fs.readFileSync(causalCheckpointPath, 'utf8');
    assert.throws(
      () => executeHostRealization({
        root: causal,
        checkpointId: causalExecution.checkpoint.id,
        at: '2026-07-16T12:02:30.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_TIME_INVALID'
    );
    assert.equal(fs.readFileSync(causalCheckpointPath, 'utf8'), causalCheckpointBytes,
      'A backdated execution mutated its durable checkpoint.');
    assert(!fs.existsSync(path.join(causal, 'AGENTS.md')),
      'A backdated execution applied a managed host output.');
    assert.throws(
      () => executeHostRealization({
        root: causal,
        checkpointId: causalExecution.checkpoint.id,
        at: 'not-a-valid-date-value'
      }),
      (error) => error.code === 'HOST_REALIZATION_TIME_INVALID'
    );
    assert.equal(fs.readFileSync(causalCheckpointPath, 'utf8'), causalCheckpointBytes,
      'A malformed execution time mutated its durable checkpoint.');

    const crossedCheckpointRecord = structuredClone(causalExecution.checkpoint);
    crossedCheckpointRecord.updatedAt = '2026-07-16T12:02:30.000Z';
    resealRecord(crossedCheckpointRecord, 'checkpointFingerprint');
    fs.writeFileSync(causalCheckpointPath, JSON.stringify(crossedCheckpointRecord, null, 2) + '\n');
    assert.throws(
      () => executeHostRealization({
        root: causal,
        checkpointId: causalExecution.checkpoint.id,
        at: '2026-07-16T12:04:00.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_CHECKPOINT_BINDING_INVALID'
    );
    fs.writeFileSync(causalCheckpointPath, causalCheckpointBytes);

    const completedBeforeCheckpoint = structuredClone(causalExecution.consumption);
    completedBeforeCheckpoint.createdAt = '2026-07-16T12:02:30.000Z';
    completedBeforeCheckpoint.updatedAt = '2026-07-16T12:02:45.000Z';
    resealRecord(completedBeforeCheckpoint, 'consumptionFingerprint');
    const completedBeforeCheckpointBytes = JSON.stringify(completedBeforeCheckpoint, null, 2) + '\n';
    fs.writeFileSync(causalConsumptionPath, completedBeforeCheckpointBytes);
    assert.throws(
      () => executeHostRealization({
        root: causal,
        checkpointId: causalExecution.checkpoint.id,
        at: '2026-07-16T12:04:00.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_CHECKPOINT_BINDING_INVALID'
    );
    assert.equal(fs.readFileSync(causalConsumptionPath, 'utf8'), completedBeforeCheckpointBytes,
      'A consumption completed before checkpoint creation was mutated during rejection.');
    assert.equal(fs.readFileSync(causalCheckpointPath, 'utf8'), causalCheckpointBytes,
      'A checkpoint created after completed consumption was mutated during rejection.');
    assert(!fs.existsSync(path.join(causal, 'AGENTS.md')),
      'A crossed consumption/checkpoint lifecycle applied a managed host output.');
    fs.writeFileSync(
      causalConsumptionPath,
      JSON.stringify(causalExecution.consumption, null, 2) + '\n'
    );

    const crossedConsumptionRecord = structuredClone(causalExecution.consumption);
    crossedConsumptionRecord.createdAt = '2026-07-16T12:01:30.000Z';
    crossedConsumptionRecord.updatedAt = '2026-07-16T12:01:30.000Z';
    resealRecord(crossedConsumptionRecord, 'consumptionFingerprint');
    fs.writeFileSync(causalConsumptionPath, JSON.stringify(crossedConsumptionRecord, null, 2) + '\n');
    assert.throws(
      () => prepareHostRealizationExecution({
        root: causal,
        confirmationId: causalConfirmation.id,
        checkpointId: causalExecution.checkpoint.id,
        at: '2026-07-16T12:03:00.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_CONSUMPTION_BINDING_INVALID'
    );

    const happy = copyRuntime(sourceRoot, 'happy');
    roots.push(happy);
    const lock = activate(happy, 'meeting-intake');
    const exact = authority(happy, 'happy');
    for (const file of [
      hostRealizationPlanStatePath(happy, exact.plan.id),
      hostRealizationRequestStatePath(happy, exact.request.id),
      hostRealizationConfirmationStatePath(happy, exact.confirmation.id),
      hostRealizationConsumptionStatePath(happy, exact.execution.consumption.id),
      hostRealizationCheckpointStatePath(happy, exact.execution.checkpoint.id)
    ]) {
      assertMode(file, '0600');
      assertMode(path.dirname(file), '0700');
    }
    const inspection = inspectHostRealization({
      root: happy,
      planId: exact.plan.id,
      requestId: exact.request.id,
      confirmationId: exact.confirmation.id,
      consumptionId: exact.execution.consumption.id,
      checkpointId: exact.execution.checkpoint.id,
      at: STARTED
    });
    assert.equal(inspection.resume.permittedNextAction, 'execute-checkpoint');
    assert.equal(inspection.request.createdAt, CREATED);
    assert.equal(inspection.request.expiresAt, '2026-07-16T12:30:00.000Z');
    assert.equal(inspection.confirmation.confirmedAt, CONFIRMED);
    assert.equal(inspection.confirmation.actor, 'operator.selftest');
    assert.equal(inspection.consumption.createdAt, STARTED);
    assert.equal(inspection.consumption.updatedAt, STARTED);
    assert(!JSON.stringify(inspection).includes(happy)
      && !JSON.stringify(inspection).includes('Soter host projection'),
    'Sanitized host inspection exposed the private target path or candidate bytes.');
    const hostileInspection = structuredClone(inspection);
    hostileInspection.target.path = '/private/HOSTILE_TARGET_SENTINEL';
    hostileInspection.scope.outputs[0].content = 'HOSTILE_RAW_OUTPUT_SENTINEL';
    hostileInspection.scope.outputs[0].before = 'HOSTILE_RAW_BEFORE_SENTINEL';
    const inspectionSchema = readJson(path.join(
      happy,
      'soter/contracts/host-realization-inspection.schema.json'
    ));
    assert.equal(validateJsonSchema(inspection, inspectionSchema).length, 0,
      'Honest host inspection failed its sanitized schema.');
    assert.deepEqual(inspection.authority, {
      kind: 'inspection-only',
      grantsExecution: false,
      grantsApproval: false,
      grantsHostRealization: false,
      grantsProviderRead: false,
      grantsProviderWrite: false
    });
    assert.deepEqual(inspection.privacy, {
      consumerRootIncluded: false,
      absolutePathsIncluded: false,
      managedRelativePathsIncluded: true,
      confirmationActorIdIncluded: true,
      templateBytesIncluded: false,
      priorBytesIncluded: false,
      candidateBytesIncluded: false,
      rawManagedManifestIncluded: false,
      privateConfigurationValuesIncluded: false,
      privateStateIncluded: false,
      credentialValuesIncluded: false,
      rawProviderResponsesIncluded: false
    });
    assert(validateJsonSchema(hostileInspection, inspectionSchema).length >= 3,
      'Sanitized host inspection accepted private target or raw output escape fields.');
    for (const hostilePath of [
      '/Users/retro/private/AGENTS.md',
      '../escape',
      'nested/../../escape',
      '.',
      '..',
      'foo/./bar',
      '.git/config',
      '.GIT/config',
      '.soter/state/private.json',
      '.SOTER/STATE/private.json',
      'C:\\Users\\retro\\private\\AGENTS.md'
    ]) {
      const hostilePathInspection = structuredClone(inspection);
      hostilePathInspection.scope.outputs[0].path = hostilePath;
      assert(validateJsonSchema(hostilePathInspection, inspectionSchema).length > 0,
        `Sanitized host inspection accepted non-relative output path ${hostilePath}.`);
    }
    for (const invalidMode of ['0600', '0755', null]) {
      const invalidModeInspection = structuredClone(inspection);
      invalidModeInspection.scope.outputs[0].mode = invalidMode;
      assert(validateJsonSchema(invalidModeInspection, inspectionSchema).length > 0,
        `Sanitized host inspection accepted invalid create/replace mode ${invalidMode}.`);
    }
    const crossedRemoveMode = structuredClone(inspection);
    crossedRemoveMode.scope.outputs[0].action = 'remove';
    assert(validateJsonSchema(crossedRemoveMode, inspectionSchema).length > 0,
      'Sanitized host inspection accepted remove action with candidate mode and fingerprint.');
    const missingAuthority = structuredClone(inspection);
    delete missingAuthority.authority;
    assert(validateJsonSchema(missingAuthority, inspectionSchema).length > 0,
      'Sanitized host inspection accepted a missing no-authority boundary.');
    const contradictoryAuthority = structuredClone(inspection);
    contradictoryAuthority.authority.grantsExecution = true;
    assert(validateJsonSchema(contradictoryAuthority, inspectionSchema).length > 0,
      'Sanitized host inspection accepted execution authority.');
    const missingPrivacy = structuredClone(inspection);
    delete missingPrivacy.privacy;
    assert(validateJsonSchema(missingPrivacy, inspectionSchema).length > 0,
      'Sanitized host inspection accepted a missing privacy boundary.');
    const contradictoryPrivacy = structuredClone(inspection);
    contradictoryPrivacy.privacy.absolutePathsIncluded = true;
    assert(validateJsonSchema(contradictoryPrivacy, inspectionSchema).length > 0,
      'Sanitized host inspection accepted absolute paths in its privacy boundary.');
    const missingActorPrivacy = structuredClone(inspection);
    delete missingActorPrivacy.privacy.confirmationActorIdIncluded;
    assert(validateJsonSchema(missingActorPrivacy, inspectionSchema).length > 0,
      'Sanitized host inspection omitted its confirmation actor disclosure fact.');
    const contradictoryActorPrivacy = structuredClone(inspection);
    contradictoryActorPrivacy.privacy.confirmationActorIdIncluded = false;
    assert(validateJsonSchema(contradictoryActorPrivacy, inspectionSchema).length > 0,
      'Sanitized host inspection denied its represented confirmation actor identifier.');
    const malformedInstant = structuredClone(inspection);
    malformedInstant.confirmation.confirmedAt = '2026-07-16 12:05:00Z';
    resealInspection(malformedInstant);
    assert(validateJsonSchema(malformedInstant, inspectionSchema).length > 0,
      'Sanitized host inspection accepted a non-canonical lifecycle instant.');
    for (const [label, mutate] of [
      ['plan window', (candidate) => {
        candidate.plan.validUntil = candidate.plan.createdAt;
      }],
      ['request before plan', (candidate) => {
        candidate.request.createdAt = '2026-07-16T11:59:00.000Z';
      }],
      ['request expiry after plan', (candidate) => {
        candidate.plan.validUntil = '2026-07-16T12:20:00.000Z';
      }],
      ['request window', (candidate) => {
        candidate.request.createdAt = '2026-07-16T12:31:00.000Z';
      }],
      ['confirmation before request', (candidate) => {
        candidate.confirmation.confirmedAt = '2026-07-16T11:59:00.000Z';
      }],
      ['confirmation after expiry', (candidate) => {
        candidate.confirmation.confirmedAt = '2026-07-16T12:31:00.000Z';
      }],
      ['consumption before confirmation', (candidate) => {
        candidate.consumption.createdAt = '2026-07-16T12:04:00.000Z';
        candidate.consumption.updatedAt = '2026-07-16T12:04:00.000Z';
      }],
      ['consumption update before creation', (candidate) => {
        candidate.consumption.updatedAt = '2026-07-16T12:05:30.000Z';
      }],
      ['consumption update after request expiry', (candidate) => {
        candidate.consumption.updatedAt = '2026-07-16T12:31:00.000Z';
      }]
    ]) {
      const crossedTime = structuredClone(inspection);
      mutate(crossedTime);
      resealInspection(crossedTime);
      assert.throws(
        () => assertHostRealizationInspection(happy, crossedTime),
        (error) => error.code === 'HOST_REALIZATION_INSPECTION_BINDING_INVALID',
        `Sanitized host inspection accepted crossed ${label} chronology.`
      );
    }
    const absoluteIdentifier = structuredClone(inspection);
    absoluteIdentifier.host.adapter = '/tmp';
    resealInspection(absoluteIdentifier);
    assert(validateJsonSchema(absoluteIdentifier, inspectionSchema).length > 0,
      'Sanitized host inspection represented an absolute path as an identifier.');
    const credentialActor = structuredClone(inspection);
    credentialActor.confirmation.actor = 'sk-' + 'a'.repeat(24);
    resealInspection(credentialActor);
    assert.equal(validateJsonSchema(credentialActor, inspectionSchema).length, 0,
      'Credential-actor pressure fixture did not preserve the closed inspection shape.');
    assert.throws(
      () => assertHostRealizationInspection(happy, credentialActor),
      (error) => error.code === 'HOST_REALIZATION_INSPECTION_PRIVACY_INVALID',
      'Sanitized host inspection accepted credential material in an actor identifier.'
    );
    const hydratedInspection = inspectHostRealization({
      root: happy,
      planId: exact.plan.id,
      checkpointId: exact.execution.checkpoint.id,
      at: STARTED
    });
    assert.equal(hydratedInspection.request.id, exact.request.id);
    assert.equal(hydratedInspection.confirmation.id, exact.confirmation.id);
    assert.equal(hydratedInspection.consumption.id, exact.execution.consumption.id);
    assert.equal(validateJsonSchema(hydratedInspection, inspectionSchema).length, 0,
      'Checkpoint inspection did not hydrate one exact authority chain.');
    assert.deepEqual(inspection.request.plan, {
      id: exact.plan.id,
      fingerprint: exact.plan.planFingerprint
    });
    assert.equal(inspection.request.scopeFingerprint, inspection.scope.fingerprint);
    assert.deepEqual(inspection.confirmation.request, {
      id: exact.request.id,
      fingerprint: exact.request.requestFingerprint
    });
    assert.deepEqual(inspection.consumption.confirmation, {
      id: exact.confirmation.id,
      fingerprint: exact.confirmation.confirmationFingerprint
    });
    assert.equal(inspection.consumption.checkpointId, inspection.checkpoint.id);
    assert.equal(
      inspection.consumption.checkpointFingerprint,
      inspection.checkpoint.authorityFingerprint
    );

    const crossedRequest = beginHostRealizationRequest({
      root: happy,
      planId: exact.plan.id,
      id: 'host-realization-request.crossed',
      reason: 'Create a second same-plan request for inspection binding pressure.',
      createdAt: CREATED,
      expiresAt: '2026-07-16T12:30:00.000Z'
    }).request;
    const crossedConfirmation = confirmHostRealizationRequest({
      root: happy,
      requestId: crossedRequest.id,
      id: 'host-realization-confirmation.crossed',
      actor: { type: 'local-operator', id: 'operator.selftest' },
      reason: 'Create a second same-plan confirmation for inspection binding pressure.',
      confirmedAt: CONFIRMED
    }).confirmation;
    assert.throws(
      () => inspectHostRealization({
        root: happy,
        planId: exact.plan.id,
        requestId: crossedRequest.id,
        confirmationId: crossedConfirmation.id,
        consumptionId: exact.execution.consumption.id,
        checkpointId: exact.execution.checkpoint.id,
        at: STARTED
      }),
      (error) => error.code === 'HOST_REALIZATION_INSPECTION_BINDING_INVALID'
    );
    const crossedRequestInspection = inspectHostRealization({
      root: happy,
      planId: exact.plan.id,
      requestId: crossedRequest.id,
      confirmationId: crossedConfirmation.id,
      at: STARTED
    });
    const recomputedCrossedRequest = structuredClone(inspection);
    recomputedCrossedRequest.request = crossedRequestInspection.request;
    resealInspection(recomputedCrossedRequest);
    assert.equal(validateJsonSchema(recomputedCrossedRequest, inspectionSchema).length, 0,
      'Crossed request pressure fixture did not preserve the closed inspection shape.');
    assert.throws(
      () => assertHostRealizationInspection(happy, recomputedCrossedRequest),
      (error) => error.code === 'HOST_REALIZATION_INSPECTION_BINDING_INVALID',
      'Recomputed inspection fingerprint disguised a request from another authority chain.'
    );

    const crossedRoot = copyRuntime(sourceRoot, 'inspection-crossed-authority');
    roots.push(crossedRoot);
    activate(crossedRoot, 'project-pulse');
    const crossedAuthority = authority(crossedRoot, 'inspection-crossed-authority', 'project-pulse');
    const crossedAuthorityInspection = inspectHostRealization({
      root: crossedRoot,
      planId: crossedAuthority.plan.id,
      checkpointId: crossedAuthority.execution.checkpoint.id,
      at: STARTED
    });
    const recomputedCrossedAuthority = structuredClone(inspection);
    recomputedCrossedAuthority.request = crossedAuthorityInspection.request;
    recomputedCrossedAuthority.confirmation = crossedAuthorityInspection.confirmation;
    recomputedCrossedAuthority.consumption = crossedAuthorityInspection.consumption;
    recomputedCrossedAuthority.checkpoint = crossedAuthorityInspection.checkpoint;
    recomputedCrossedAuthority.resume = crossedAuthorityInspection.resume;
    resealInspection(recomputedCrossedAuthority);
    assert.equal(validateJsonSchema(recomputedCrossedAuthority, inspectionSchema).length, 0,
      'Crossed authority pressure fixture did not preserve the closed inspection shape.');
    assert.throws(
      () => assertHostRealizationInspection(happy, recomputedCrossedAuthority),
      (error) => error.code === 'HOST_REALIZATION_INSPECTION_BINDING_INVALID',
      'Recomputed inspection fingerprint disguised an unrelated authority tuple.'
    );

    const recomputedOutputMismatch = structuredClone(inspection);
    recomputedOutputMismatch.checkpoint.outputs.pop();
    resealInspection(recomputedOutputMismatch);
    assert.equal(validateJsonSchema(recomputedOutputMismatch, inspectionSchema).length, 0,
      'Output parity pressure fixture did not preserve the closed inspection shape.');
    assert.throws(
      () => assertHostRealizationInspection(happy, recomputedOutputMismatch),
      (error) => error.code === 'HOST_REALIZATION_INSPECTION_BINDING_INVALID',
      'Recomputed inspection fingerprint disguised incomplete checkpoint output coverage.'
    );
    const recomputedScopeMutation = structuredClone(inspection);
    recomputedScopeMutation.scope.outputs[0].role = 'configuration';
    resealInspection(recomputedScopeMutation);
    assert.equal(validateJsonSchema(recomputedScopeMutation, inspectionSchema).length, 0,
      'Scope-mutation pressure fixture did not preserve the closed inspection shape.');
    assert.throws(
      () => assertHostRealizationInspection(happy, recomputedScopeMutation),
      (error) => error.code === 'HOST_REALIZATION_INSPECTION_BINDING_INVALID',
      'Recomputed inspection fingerprint disguised a changed exact scope row.'
    );
    const expiredConfirmationInspection = inspectHostRealization({
      root: happy,
      planId: exact.plan.id,
      requestId: exact.request.id,
      confirmationId: exact.confirmation.id,
      at: '2026-07-16T12:31:00.000Z'
    });
    assert.equal(expiredConfirmationInspection.resume.reasonCode, 'HOST_REALIZATION_CONFIRMATION_EXPIRED');
    assert.equal(expiredConfirmationInspection.resume.permittedNextAction, 'request-confirmation');

    const orphanConsumption = structuredClone(inspection);
    orphanConsumption.request = null;
    orphanConsumption.confirmation = null;
    orphanConsumption.checkpoint = null;
    orphanConsumption.resume = {
      classification: 'safe',
      reasonCode: 'HOST_REALIZATION_PLAN_CURRENT',
      reason: 'The exact private plan is current and may request confirmation.',
      permittedNextAction: 'request-confirmation'
    };
    assert(validateJsonSchema(orphanConsumption, inspectionSchema).length > 0,
      'Host inspection accepted started consumption without its authority ancestry or checkpoint.');

    const falsePlanOnlyStart = inspectHostRealization({
      root: happy,
      planId: exact.plan.id,
      at: STARTED
    });
    assert.equal(validateJsonSchema(falsePlanOnlyStart, inspectionSchema).length, 0,
      'Honest plan-only host inspection failed its lifecycle contract.');
    falsePlanOnlyStart.resume = {
      classification: 'safe',
      reasonCode: 'HOST_REALIZATION_CHECKPOINT_READY',
      reason: 'The one-time start is bound to an exact prepared checkpoint.',
      permittedNextAction: 'execute-checkpoint'
    };
    assert(validateJsonSchema(falsePlanOnlyStart, inspectionSchema).length > 0,
      'Plan-only host inspection accepted checkpoint execution guidance.');

    const orphanCompleted = structuredClone(inspection);
    orphanCompleted.request = null;
    orphanCompleted.confirmation = null;
    orphanCompleted.consumption = null;
    orphanCompleted.plan.applicability = 'applied';
    orphanCompleted.checkpoint.state = 'completed';
    orphanCompleted.checkpoint.phase = 'terminal';
    orphanCompleted.checkpoint.currentOutputId = null;
    orphanCompleted.checkpoint.outputs.forEach((output) => { output.state = 'verified'; });
    orphanCompleted.checkpoint.failure = null;
    orphanCompleted.resume = {
      classification: 'unavailable',
      reasonCode: 'HOST_REALIZATION_COMPLETED',
      reason: 'The exact deterministic local projection is complete.',
      permittedNextAction: 'none'
    };
    orphanCompleted.claims.localProjection = 'passed';
    assert(validateJsonSchema(orphanCompleted, inspectionSchema).length > 0,
      'Host inspection accepted a completed checkpoint without its authority ancestry.');

    const unsafeAttention = structuredClone(inspection);
    unsafeAttention.request.state = 'expired';
    unsafeAttention.checkpoint.state = 'needs-attention';
    unsafeAttention.checkpoint.phase = 'terminal';
    unsafeAttention.checkpoint.failure = {
      reasonCode: 'HOST_REALIZATION_RECOVERY_FAILED',
      summary: 'Host realization recovery could not establish one exact checkpoint state.'
    };
    unsafeAttention.resume = {
      classification: 'safe',
      reasonCode: 'HOST_REALIZATION_CHECKPOINT_READY',
      reason: 'The one-time start is bound to an exact prepared checkpoint.',
      permittedNextAction: 'execute-checkpoint'
    };
    assert(validateJsonSchema(unsafeAttention, inspectionSchema).length > 0,
      'Host inspection accepted safe execution guidance for a needs-attention checkpoint.');

    const honestAttention = structuredClone(unsafeAttention);
    honestAttention.resume = {
      classification: 'requires-review',
      reasonCode: 'HOST_REALIZATION_NEEDS_ATTENTION',
      reason: 'Checkpoint state requires exact local inspection before any further action.',
      permittedNextAction: 'inspect-checkpoint'
    };
    assert.equal(validateJsonSchema(honestAttention, inspectionSchema).length, 0,
      'Honest needs-attention host inspection failed its closed resume contract.');
    for (const hostileSummary of [
      'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwxyz0123456789',
      'Read /Users/retro/private/secrets.json before recovery.',
      'rawProviderResponse: HOSTILE_RAW_PROVIDER_SENTINEL'
    ]) {
      const hostileFailure = structuredClone(honestAttention);
      hostileFailure.checkpoint.failure.summary = hostileSummary;
      assert(validateJsonSchema(hostileFailure, inspectionSchema).length > 0,
        `Sanitized host inspection accepted hostile failure summary ${hostileSummary}.`);
    }
    for (const misleadingReasonCode of [
      'HOST_REALIZATION_OUTPUT_DRIFT',
      'HOST_REALIZATION_COMPLETED',
      'HOST_REALIZATION_ROLLED_BACK',
      'HOST_REALIZATION_FAKE_REASON'
    ]) {
      const misleadingAttention = structuredClone(honestAttention);
      misleadingAttention.resume.reasonCode = misleadingReasonCode;
      assert(validateJsonSchema(misleadingAttention, inspectionSchema).length > 0,
        `Needs-attention host inspection accepted contradictory resume code ${misleadingReasonCode}.`);
    }

    const crossedPrepared = structuredClone(inspection);
    crossedPrepared.checkpoint.phase = 'terminal';
    crossedPrepared.checkpoint.outputs[0].state = 'rolled-back';
    crossedPrepared.checkpoint.failure = {
      reasonCode: 'HOST_REALIZATION_EXECUTION_FAILED',
      summary: 'Host realization stopped and attempted exact rollback.'
    };
    assert(validateJsonSchema(crossedPrepared, inspectionSchema).length > 0,
      'Host inspection accepted crossed prepared checkpoint phase, output, and failure states.');
    const preparedPassedClaim = structuredClone(inspection);
    preparedPassedClaim.claims.localProjection = 'passed';
    assert(validateJsonSchema(preparedPassedClaim, inspectionSchema).length > 0,
      'Host inspection promoted local projection before exact completion.');
    const completed = executeHostRealization({
      root: happy,
      checkpointId: exact.execution.checkpoint.id,
      at: EXECUTED
    });
    assert.equal(completed.state, 'completed');
    const adapter = readJson(path.join(happy, 'soter/hosts/codex/adapter.json'));
    const rendered = renderHostProjectionCandidates({
      root: happy,
      adapter,
      configurationId: lock.configuration.name,
      packIds: lock.packs.map((pack) => pack.id),
      capabilityIds: lock.capabilities.map((capability) => capability.id),
      effectPolicies: lock.effectPolicies
    });
    const instructions = rendered.outputs.find((output) => output.role === 'instructions');
    const tools = rendered.outputs.find((output) => output.id === 'output.codex.tools');
    assert.equal(tools.content, [
      '[mcp_servers.soter]',
      'command = "node"',
      'args = ["soter/core/mcp/server.mjs", "--host", "codex"]',
      '',
      '[mcp_servers.otter]',
      'url = "https://mcp.otter.ai/mcp"',
      'auth = "oauth"',
      ''
    ].join('\n'), 'Selected Otter provider did not render one exact Codex MCP endpoint block.');
    assert.equal(tools.content.split('[mcp_servers.otter]').length - 1, 1,
      'Selected Otter provider rendered a duplicate Codex MCP endpoint block.');
    assert.notEqual(tools.contentFingerprint, codexUnselectedTools.contentFingerprint,
      'Provider selection did not change the deterministic Codex tools candidate fingerprint.');
    assert(instructions.content.includes('`integration.notion` requires `notion`')
      && instructions.content.includes('`integration.otter` requires `otter`')
      && !instructions.content.includes('`integration.slack` requires `slack`')
      && instructions.content.includes('`private-by-construction` (`kernel-static`)'),
    'Host instructions did not project the exact selected provider requirements and canonical development guards.');
    assert(!instructions.content.includes('mcp__codex_apps__')
      && instructions.content.includes('discovery and authentication must be proven separately'),
    'Host instructions leaked native tool names or promoted provider discovery/authentication.');
    const missingProviderRoute = structuredClone(adapter);
    missingProviderRoute.mcpServers = missingProviderRoute.mcpServers.filter((server) => {
      return server.id !== 'notion';
    });
    assert.throws(
      () => renderHostProjectionCandidates({
        root: happy,
        adapter: missingProviderRoute,
        configurationId: lock.configuration.name,
        packIds: lock.packs.map((pack) => pack.id),
        capabilityIds: lock.capabilities.map((capability) => capability.id),
        effectPolicies: lock.effectPolicies
      }),
      (error) => error.code === 'HOST_PROJECTION_PROVIDER_REQUIREMENT_UNAVAILABLE'
    );
    const happyProjectionFile = path.join(happy, 'soter/hosts/codex/projection.json');
    const originalHappyProjection = fs.readFileSync(happyProjectionFile, 'utf8');
    const honestHappyProjection = JSON.parse(originalHappyProjection);
    const renderHappyProjection = () => renderHostProjectionCandidates({
      root: happy,
      adapter,
      configurationId: lock.configuration.name,
      packIds: lock.packs.map((pack) => pack.id),
      capabilityIds: lock.capabilities.map((capability) => capability.id),
      effectPolicies: lock.effectPolicies
    });
    const assertEndpointMutationRejected = (mutate, expectedCode, message) => {
      const mutated = structuredClone(honestHappyProjection);
      mutate(mutated);
      fs.writeFileSync(happyProjectionFile, JSON.stringify(mutated, null, 2) + '\n');
      try {
        assert.throws(renderHappyProjection, (error) => error.code === expectedCode, message);
      } finally {
        fs.writeFileSync(happyProjectionFile, originalHappyProjection);
      }
    };
    assertEndpointMutationRejected((projection) => {
      projection.providerEndpointBlocks.push({
        ...projection.providerEndpointBlocks[0],
        id: 'provider-endpoint.codex.otter-duplicate'
      });
    }, 'HOST_PROJECTION_PROVIDER_ENDPOINT_AMBIGUOUS',
    'Duplicate provider endpoint ownership did not fail closed.');
    assertEndpointMutationRejected((projection) => {
      projection.providerEndpointBlocks[0].server = 'notion';
    }, 'HOST_PROJECTION_PROVIDER_ENDPOINT_BINDING_INVALID',
    'Provider endpoint server mismatch did not fail closed.');
    assertEndpointMutationRejected((projection) => {
      projection.providerEndpointBlocks[0].content += 'api_key = "sk-hostile-private-sentinel"\n';
    }, 'HOST_PROJECTION_CREDENTIAL_REJECTED',
    'Credential-like provider endpoint material did not fail closed.');
    assertEndpointMutationRejected((projection) => {
      projection.providerEndpointBlocks[0].content =
        projection.providerEndpointBlocks[0].content.replace('{{SERVER_ID}}', '{{UNDECLARED}}');
    }, 'HOST_PROJECTION_TEMPLATE_INVALID',
    'Unresolved provider endpoint marker did not fail closed.');
    assert.equal(
      renderHappyProjection().outputs.find((output) => output.id === 'output.codex.tools')
        .contentFingerprint,
      tools.contentFingerprint,
      'Rejected provider endpoint mutations changed the restored deterministic candidate.'
    );
    for (const output of rendered.outputs) {
      const file = path.join(happy, output.path);
      assert.equal(fs.readFileSync(file, 'utf8'), output.content);
      assertMode(file, '0644');
    }
    assertMode(path.join(happy, '.codex'), '0755');
    assertMode(activeConfigurationLockStatePath(happy, 'meeting-intake'), '0600');
    assertMode(hostManagedManifestStatePath(happy, 'codex'), '0600');
    const after = inspectHostRealization({
      root: happy,
      planId: exact.plan.id,
      requestId: exact.request.id,
      confirmationId: exact.confirmation.id,
      consumptionId: exact.execution.consumption.id,
      checkpointId: exact.execution.checkpoint.id,
      at: EXECUTED
    });
    assert.equal(after.claims.localProjection, 'passed');
    assert.equal(after.claims.hostLaunch, 'unknown');
    assert.equal(after.claims.authentication, 'unknown');
    assert.equal(after.claims.connectedBehavior, 'unknown');
    assert.throws(
      () => prepareHostRealization({
        root: happy,
        configurationName: 'meeting-intake',
        id: 'host-realization-plan.already-current',
        createdAt: CREATED,
        validUntil: VALID_UNTIL
      }),
      (error) => error.code === 'HOST_REALIZATION_ALREADY_CURRENT'
    );

    const switchedLock = activate(happy, 'project-pulse');
    const switched = authority(happy, 'switch', 'project-pulse');
    assert(switched.plan.operations.some((operation) => operation.action === 'replace'));
    const switchedCompleted = executeHostRealization({
      root: happy,
      checkpointId: switched.execution.checkpoint.id,
      at: EXECUTED
    });
    assert.equal(switchedCompleted.state, 'completed');
    const switchedManifest = readHostManagedManifestState(happy, 'codex').manifest;
    assert.equal(switchedManifest.configuration.lockFingerprint, fingerprintLock(switchedLock));

    const drift = copyRuntime(sourceRoot, 'managed-drift');
    roots.push(drift);
    activate(drift, 'meeting-intake');
    const driftInitial = authority(drift, 'managed-drift-initial');
    executeHostRealization({ root: drift, checkpointId: driftInitial.execution.checkpoint.id, at: EXECUTED });
    fs.writeFileSync(path.join(drift, 'AGENTS.md'), 'HOSTILE_LOCAL_EDIT_SENTINEL\n', { mode: 0o644 });
    assert.throws(
      () => prepareHostRealization({
        root: drift,
        configurationName: 'meeting-intake',
        id: 'host-realization-plan.managed-drift',
        createdAt: CREATED,
        validUntil: VALID_UNTIL
      }),
      (error) => error.code === 'HOST_REALIZATION_MANAGED_DRIFT'
    );

    const crash = copyRuntime(sourceRoot, 'crash');
    roots.push(crash);
    activate(crash, 'meeting-intake');
    const crashing = authority(crash, 'crash');
    assert.throws(
      () => executeHostRealization({
        root: crash,
        checkpointId: crashing.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'after-output:output.codex.tools'
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    const recovered = recoverHostRealization({
      root: crash,
      checkpointId: crashing.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    });
    assert.equal(recovered.state, 'completed');
    assert.equal(recoverHostRealization({
      root: crash,
      checkpointId: crashing.execution.checkpoint.id,
      at: '2026-07-16T12:09:00.000Z'
    }).state, 'completed');

    const stalePrepared = copyRuntime(sourceRoot, 'stale-prepared');
    roots.push(stalePrepared);
    activate(stalePrepared, 'meeting-intake');
    const stalePreparedAuthority = authority(stalePrepared, 'stale-prepared');
    const stalePreparedConfigurationPath = privateConfigurationStatePath(
      stalePrepared,
      'meeting-intake'
    );
    const stalePreparedConfiguration = readJson(stalePreparedConfigurationPath);
    stalePreparedConfiguration.packs[0].reason += ' Planted post-preview configuration drift.';
    fs.writeFileSync(
      stalePreparedConfigurationPath,
      JSON.stringify(stalePreparedConfiguration, null, 2) + '\n',
      { mode: 0o600 }
    );
    const stalePreparedInspection = inspectHostRealization({
      root: stalePrepared,
      planId: stalePreparedAuthority.plan.id,
      checkpointId: stalePreparedAuthority.execution.checkpoint.id,
      at: EXECUTED
    });
    assert.equal(stalePreparedInspection.plan.applicability, 'stale');
    assert.equal(stalePreparedInspection.checkpoint.state, 'prepared');
    assert.deepEqual(stalePreparedInspection.resume, {
      classification: 'requires-review',
      reasonCode: 'HOST_REALIZATION_CHECKPOINT_REVIEW_REQUIRED',
      reason: 'The prepared checkpoint must be inspected because its plan is no longer current.',
      permittedNextAction: 'inspect-checkpoint'
    });
    assert.equal(validateJsonSchema(stalePreparedInspection, inspectionSchema).length, 0,
      'Honest stale prepared host inspection failed its resume contract.');
    const crossedStalePrepared = structuredClone(stalePreparedInspection);
    crossedStalePrepared.resume.reason =
      'The exact checkpoint must be inspected because its plan is no longer current.';
    assert(validateJsonSchema(crossedStalePrepared, inspectionSchema).length > 0,
      'Stale prepared host inspection accepted in-progress recovery guidance.');

    const staleInProgress = copyRuntime(sourceRoot, 'stale-in-progress');
    roots.push(staleInProgress);
    activate(staleInProgress, 'meeting-intake');
    const staleInProgressAuthority = authority(staleInProgress, 'stale-in-progress');
    const staleInProgressFirstOutput = staleInProgressAuthority.plan.operations[0].id;
    assert.throws(
      () => executeHostRealization({
        root: staleInProgress,
        checkpointId: staleInProgressAuthority.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'before-output:' + staleInProgressFirstOutput
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    const stalePrivateConfigurationPath = privateConfigurationStatePath(
      staleInProgress,
      'meeting-intake'
    );
    const stalePrivateConfiguration = readJson(stalePrivateConfigurationPath);
    stalePrivateConfiguration.packs[0].reason += ' Planted post-preview configuration drift.';
    fs.writeFileSync(
      stalePrivateConfigurationPath,
      JSON.stringify(stalePrivateConfiguration, null, 2) + '\n',
      { mode: 0o600 }
    );
    const staleInProgressInspection = inspectHostRealization({
      root: staleInProgress,
      planId: staleInProgressAuthority.plan.id,
      checkpointId: staleInProgressAuthority.execution.checkpoint.id,
      at: EXECUTED
    });
    assert.equal(staleInProgressInspection.plan.applicability, 'stale');
    assert.equal(staleInProgressInspection.checkpoint.state, 'applying');
    assert.deepEqual(staleInProgressInspection.resume, {
      classification: 'requires-review',
      reasonCode: 'HOST_REALIZATION_CHECKPOINT_REVIEW_REQUIRED',
      reason: 'The exact checkpoint must be inspected because its plan is no longer current.',
      permittedNextAction: 'inspect-checkpoint'
    });
    assert.equal(validateJsonSchema(staleInProgressInspection, inspectionSchema).length, 0,
      'Honest stale in-progress host inspection failed its resume contract.');
    const crossedStaleInProgress = structuredClone(staleInProgressInspection);
    crossedStaleInProgress.resume.reason =
      'The prepared checkpoint must be inspected because its plan is no longer current.';
    assert(validateJsonSchema(crossedStaleInProgress, inspectionSchema).length > 0,
      'Stale in-progress host inspection accepted prepared-checkpoint guidance.');
    const expiredInProgressInspection = inspectHostRealization({
      root: staleInProgress,
      planId: staleInProgressAuthority.plan.id,
      checkpointId: staleInProgressAuthority.execution.checkpoint.id,
      at: '2026-07-16T13:01:00.000Z'
    });
    assert.equal(expiredInProgressInspection.plan.applicability, 'expired');
    assert.equal(expiredInProgressInspection.checkpoint.state, 'applying');
    assert.deepEqual(expiredInProgressInspection.resume, staleInProgressInspection.resume);
    assert.equal(validateJsonSchema(expiredInProgressInspection, inspectionSchema).length, 0,
      'Honest expired in-progress host inspection failed its resume contract.');

    for (const nativeCode of ['EACCES', 'EPERM', 'EROFS']) {
      const label = 'filesystem-failure-' + nativeCode.toLowerCase();
      const filesystemFailure = copyRuntime(sourceRoot, label);
      roots.push(filesystemFailure);
      activate(filesystemFailure, 'meeting-intake');
      const initialAuthority = authority(filesystemFailure, label + '-initial');
      assert.equal(executeHostRealization({
        root: filesystemFailure,
        checkpointId: initialAuthority.execution.checkpoint.id,
        at: EXECUTED
      }).state, 'completed');
      const priorManifest = structuredClone(
        readHostManagedManifestState(filesystemFailure, 'codex').manifest
      );
      const priorOutputs = priorManifest.outputs.map((output) => ({
        path: output.path,
        content: fs.readFileSync(path.join(filesystemFailure, output.path), 'utf8'),
        mode: output.mode
      }));

      activate(filesystemFailure, 'project-pulse');
      const filesystemAuthority = authority(
        filesystemFailure,
        label,
        'project-pulse'
      );
      const deniedOperation = filesystemAuthority.plan.operations.find((operation) => {
        return operation.action !== 'remove';
      });
      assert(deniedOperation, 'Permission regression requires one create or replace effect.');
      const checkpointId = filesystemAuthority.execution.checkpoint.id;
      const temporary = path.join(
        filesystemFailure,
        deniedOperation.path + '.' + checkpointId.replace(/[^a-z0-9.-]/g, '-') + '.tmp'
      );
      const originalOpenSync = fs.openSync;
      let filesystemStopped;
      try {
        fs.openSync = function guardedOpenSync(file, flags, mode) {
          if (path.resolve(file) === temporary) {
            const error = new Error('Contained filesystem permission failure.');
            error.code = nativeCode;
            throw error;
          }
          return originalOpenSync.call(fs, file, flags, mode);
        };
        filesystemStopped = executeHostRealization({
          root: filesystemFailure,
          checkpointId,
          at: EXECUTED
        });
      } finally {
        fs.openSync = originalOpenSync;
      }
      assert.equal(filesystemStopped.state, 'rolled-back');
      assert.equal(filesystemStopped.failure.reasonCode, 'HOST_REALIZATION_EFFECT_DENIED');
      const serializedFailure = JSON.stringify(filesystemStopped);
      assert(!serializedFailure.includes(nativeCode));
      assert(!serializedFailure.includes('Contained filesystem permission failure.'));
      assert(!serializedFailure.includes(filesystemFailure));
      assert.deepEqual(
        readHostManagedManifestState(filesystemFailure, 'codex').manifest,
        priorManifest,
        'Permission denial did not restore the exact prior managed manifest.'
      );
      for (const output of priorOutputs) {
        const file = path.join(filesystemFailure, output.path);
        assert.equal(fs.readFileSync(file, 'utf8'), output.content,
          'Permission denial changed prior managed output bytes.');
        assertMode(file, output.mode);
      }
      for (const operation of filesystemAuthority.plan.operations) {
        const file = path.join(filesystemFailure, operation.path);
        if (operation.before.state === 'absent') {
          assert(!fs.existsSync(file), 'Permission rollback retained a candidate-only output.');
        } else {
          assert.equal(fs.readFileSync(file, 'utf8'), operation.before.content,
            'Permission rollback did not restore exact prior operation bytes.');
          assertMode(file, operation.before.mode);
        }
        const suffix = checkpointId.replace(/[^a-z0-9.-]/g, '-');
        const rollbackSuffix = (checkpointId + '.rollback').replace(/[^a-z0-9.-]/g, '-');
        assert(!fs.existsSync(file + '.' + suffix + '.tmp'),
          'Permission denial retained an apply temporary file.');
        assert(!fs.existsSync(file + '.' + rollbackSuffix + '.tmp'),
          'Permission denial retained a rollback temporary file.');
      }
      assert.throws(
        () => prepareHostRealizationExecution({
          root: filesystemFailure,
          confirmationId: filesystemAuthority.confirmation.id,
          checkpointId: checkpointId + '.reuse',
          at: '2026-07-16T12:08:00.000Z'
        }),
        (error) => error.code === 'HOST_REALIZATION_CONFIRMATION_ALREADY_CONSUMED',
        'Permission rollback made the exact confirmation reusable.'
      );
      const rolledBackInspection = inspectHostRealization({
        root: filesystemFailure,
        planId: filesystemAuthority.plan.id,
        checkpointId,
        at: EXECUTED
      });
      assert.equal(rolledBackInspection.checkpoint.failure.reasonCode,
        'HOST_REALIZATION_EFFECT_DENIED');
      assert.equal(rolledBackInspection.resume.reasonCode, 'HOST_REALIZATION_ROLLED_BACK');
      assert.equal(rolledBackInspection.resume.permittedNextAction, 'none');
      assert.equal(validateJsonSchema(rolledBackInspection, inspectionSchema).length, 0,
        'Honest rolled-back host inspection failed its terminal lifecycle contract.');
    }

    const beforeOutputCrash = copyRuntime(sourceRoot, 'before-output-crash');
    roots.push(beforeOutputCrash);
    activate(beforeOutputCrash, 'meeting-intake');
    const beforeOutputAuthority = authority(beforeOutputCrash, 'before-output-crash');
    const firstOutputId = beforeOutputAuthority.plan.operations[0].id;
    assert.throws(
      () => executeHostRealization({
        root: beforeOutputCrash,
        checkpointId: beforeOutputAuthority.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'before-output:' + firstOutputId
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    assert.equal(recoverHostRealization({
      root: beforeOutputCrash,
      checkpointId: beforeOutputAuthority.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    }).state, 'completed');

    const beforeManifestCrash = copyRuntime(sourceRoot, 'before-manifest-crash');
    roots.push(beforeManifestCrash);
    activate(beforeManifestCrash, 'meeting-intake');
    const beforeManifestAuthority = authority(beforeManifestCrash, 'before-manifest-crash');
    assert.throws(
      () => executeHostRealization({
        root: beforeManifestCrash,
        checkpointId: beforeManifestAuthority.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'before-manifest'
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    assert.equal(recoverHostRealization({
      root: beforeManifestCrash,
      checkpointId: beforeManifestAuthority.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    }).state, 'completed');

    const directoryCrash = copyRuntime(sourceRoot, 'directory-crash');
    roots.push(directoryCrash);
    activate(directoryCrash, 'meeting-intake');
    const crashingDirectory = authority(directoryCrash, 'directory-crash');
    assert.throws(
      () => executeHostRealization({
        root: directoryCrash,
        checkpointId: crashingDirectory.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'after-directory:.codex'
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    assert.equal(recoverHostRealization({
      root: directoryCrash,
      checkpointId: crashingDirectory.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    }).state, 'completed');

    const recoveryTime = copyRuntime(sourceRoot, 'recovery-time');
    roots.push(recoveryTime);
    activate(recoveryTime, 'meeting-intake');
    const recoveryTimeAuthority = authority(recoveryTime, 'recovery-time');
    assert.throws(
      () => executeHostRealization({
        root: recoveryTime,
        checkpointId: recoveryTimeAuthority.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'after-directory:.codex'
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    const recoveryTimeCheckpointPath = hostRealizationCheckpointStatePath(
      recoveryTime,
      recoveryTimeAuthority.execution.checkpoint.id
    );
    const recoveryTimeCheckpointBytes = fs.readFileSync(recoveryTimeCheckpointPath, 'utf8');
    assert.throws(
      () => recoverHostRealization({
        root: recoveryTime,
        checkpointId: recoveryTimeAuthority.execution.checkpoint.id,
        at: '2026-07-16T12:06:30.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_TIME_INVALID'
    );
    assert.equal(fs.readFileSync(recoveryTimeCheckpointPath, 'utf8'), recoveryTimeCheckpointBytes,
      'Backdated recovery mutated its durable checkpoint.');

    const manifestCrash = copyRuntime(sourceRoot, 'manifest-crash');
    roots.push(manifestCrash);
    activate(manifestCrash, 'meeting-intake');
    const crashingManifest = authority(manifestCrash, 'manifest-crash');
    assert.throws(
      () => executeHostRealization({
        root: manifestCrash,
        checkpointId: crashingManifest.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'after-manifest'
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    assert.equal(recoverHostRealization({
      root: manifestCrash,
      checkpointId: crashingManifest.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    }).state, 'completed');

    const expired = copyRuntime(sourceRoot, 'expired');
    roots.push(expired);
    activate(expired, 'meeting-intake');
    const expiredAuthority = authority(expired, 'expired', 'meeting-intake', {
      validUntil: '2026-07-16T12:10:00.000Z',
      requestExpiresAt: '2026-07-16T12:08:00.000Z',
      confirmedAt: '2026-07-16T12:04:00.000Z',
      startedAt: '2026-07-16T12:05:00.000Z'
    });
    const expiredResult = executeHostRealization({
      root: expired,
      checkpointId: expiredAuthority.execution.checkpoint.id,
      at: '2026-07-16T12:11:00.000Z'
    });
    assert.equal(expiredResult.state, 'rolled-back');
    assert(!fs.existsSync(path.join(expired, 'AGENTS.md')));

    const attention = copyRuntime(sourceRoot, 'needs-attention');
    roots.push(attention);
    activate(attention, 'meeting-intake');
    const attentionAuthority = authority(attention, 'needs-attention');
    assert.throws(
      () => executeHostRealization({
        root: attention,
        checkpointId: attentionAuthority.execution.checkpoint.id,
        at: EXECUTED,
        faultAfter: 'after-output:output.codex.tools'
      }),
      (error) => error.code === 'HOST_REALIZATION_TEST_CRASH'
    );
    fs.writeFileSync(path.join(attention, '.codex/config.toml'), 'HOSTILE_UNKNOWN_OUTPUT_SENTINEL\n', { mode: 0o644 });
    const needsAttention = recoverHostRealization({
      root: attention,
      checkpointId: attentionAuthority.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    });
    assert.equal(needsAttention.state, 'needs-attention');
    const attentionInspection = inspectHostRealization({
      root: attention,
      planId: attentionAuthority.plan.id,
      requestId: attentionAuthority.request.id,
      confirmationId: attentionAuthority.confirmation.id,
      consumptionId: attentionAuthority.execution.consumption.id,
      checkpointId: attentionAuthority.execution.checkpoint.id,
      at: '2026-07-16T12:08:00.000Z'
    });
    assert.deepEqual(attentionInspection.resume, {
      classification: 'requires-review',
      reasonCode: 'HOST_REALIZATION_NEEDS_ATTENTION',
      reason: 'Checkpoint state requires exact local inspection before any further action.',
      permittedNextAction: 'inspect-checkpoint'
    });
    assert.equal(validateJsonSchema(attentionInspection, inspectionSchema).length, 0,
      'Honest persisted needs-attention host inspection failed its closed resume contract.');
    assert(!JSON.stringify(attentionInspection).includes('HOSTILE_UNKNOWN_OUTPUT_SENTINEL'));

    const previewDrift = copyRuntime(sourceRoot, 'preview-drift');
    roots.push(previewDrift);
    activate(previewDrift, 'meeting-intake');
    const previewAuthority = authority(previewDrift, 'preview-drift');
    fs.writeFileSync(path.join(previewDrift, 'AGENTS.md'), 'HOSTILE_POST_PREVIEW_SENTINEL\n', { mode: 0o644 });
    const previewStopped = executeHostRealization({
      root: previewDrift,
      checkpointId: previewAuthority.execution.checkpoint.id,
      at: EXECUTED
    });
    assert.equal(previewStopped.state, 'needs-attention');
    assert(!fs.existsSync(path.join(previewDrift, '.codex/config.toml')),
      'Per-effect revalidation did not stop before the first affected write.');

    const retirement = copyRuntime(sourceRoot, 'retirement');
    roots.push(retirement);
    activate(retirement, 'meeting-intake');
    const initial = authority(retirement, 'retirement-initial');
    executeHostRealization({ root: retirement, checkpointId: initial.execution.checkpoint.id, at: EXECUTED });
    const retiredPath = '.codex/retired-managed.txt';
    const retiredContent = 'retired managed output\n';
    fs.writeFileSync(path.join(retirement, retiredPath), retiredContent, { mode: 0o644 });
    const retiredContentFingerprint = sha256(Buffer.from(retiredContent, 'utf8'));
    const oldManifest = readHostManagedManifestState(retirement, 'codex').manifest;
    oldManifest.outputs.push({
      id: 'output.codex.retired',
      path: retiredPath,
      role: 'configuration',
      mode: '0644',
      contentFingerprint: retiredContentFingerprint,
      fingerprint: fingerprintJson({ contentFingerprint: retiredContentFingerprint, mode: '0644' })
    });
    oldManifest.outputs.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    writeHostManagedManifestState(retirement, resealManifest(oldManifest));
    const removalPlan = prepareHostRealization({
      root: retirement,
      configurationName: 'meeting-intake',
      id: 'host-realization-plan.retirement',
      createdAt: CREATED,
      validUntil: VALID_UNTIL
    }).plan;
    assert(removalPlan.operations.some((operation) => operation.action === 'remove'
      && operation.path === retiredPath));
    const removalAuthority = authorizePlan(retirement, 'retirement', removalPlan);
    assert.equal(executeHostRealization({
      root: retirement,
      checkpointId: removalAuthority.execution.checkpoint.id,
      at: EXECUTED
    }).state, 'completed');
    assert(!fs.existsSync(path.join(retirement, retiredPath)));

    const symlink = copyRuntime(sourceRoot, 'symlink');
    roots.push(symlink);
    activate(symlink, 'meeting-intake');
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soter-host-outside-'));
    roots.push(outside);
    fs.symlinkSync(outside, path.join(symlink, '.codex'));
    assert.throws(
      () => prepareHostRealization({
        root: symlink,
        configurationName: 'meeting-intake',
        id: 'host-realization-plan.symlink',
        createdAt: CREATED,
        validUntil: VALID_UNTIL
      }),
      (error) => error.code === 'HOST_REALIZATION_SYMLINK_REJECTED'
    );

    const originalRoot = copyRuntime(sourceRoot, 'wrong-root-source');
    const wrongRoot = copyRuntime(sourceRoot, 'wrong-root-target');
    roots.push(originalRoot, wrongRoot);
    activate(originalRoot, 'meeting-intake');
    activate(wrongRoot, 'meeting-intake');
    const originalPlan = prepareHostRealization({
      root: originalRoot,
      configurationName: 'meeting-intake',
      id: 'host-realization-plan.wrong-root',
      createdAt: CREATED,
      validUntil: VALID_UNTIL
    }).plan;
    const copiedPlanPath = hostRealizationPlanStatePath(wrongRoot, originalPlan.id);
    fs.mkdirSync(path.dirname(copiedPlanPath), { recursive: true, mode: 0o700 });
    fs.copyFileSync(hostRealizationPlanStatePath(originalRoot, originalPlan.id), copiedPlanPath);
    assert.throws(
      () => beginHostRealizationRequest({
        root: wrongRoot,
        planId: originalPlan.id,
        id: 'host-realization-request.wrong-root',
        reason: 'This request must fail because the exact target identity changed.',
        createdAt: CREATED,
        expiresAt: '2026-07-16T12:30:00.000Z'
      }),
      (error) => error.code === 'HOST_REALIZATION_TARGET_DRIFT'
    );

    const crossHost = copyRuntime(sourceRoot, 'cross-host');
    roots.push(crossHost);
    activate(crossHost, 'meeting-intake');
    const crossInitial = authority(crossHost, 'cross-host-initial');
    executeHostRealization({ root: crossHost, checkpointId: crossInitial.execution.checkpoint.id, at: EXECUTED });
    const codexManifest = readHostManagedManifestState(crossHost, 'codex').manifest;
    const claudeManifest = structuredClone(codexManifest);
    claudeManifest.id = 'host-managed-manifest.claude';
    claudeManifest.host = 'claude';
    writeHostManagedManifestState(crossHost, resealManifest(claudeManifest));
    assert.throws(
      () => prepareHostRealization({
        root: crossHost,
        configurationName: 'meeting-intake',
        id: 'host-realization-plan.cross-host',
        createdAt: CREATED,
        validUntil: VALID_UNTIL
      }),
      (error) => error.code === 'HOST_REALIZATION_CROSS_HOST_COLLISION'
    );

    const malformedManifest = copyRuntime(sourceRoot, 'malformed-manifest');
    roots.push(malformedManifest);
    activate(malformedManifest, 'meeting-intake');
    const malformedPath = hostManagedManifestStatePath(malformedManifest, 'codex');
    fs.mkdirSync(path.dirname(malformedPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(malformedPath, '{"private":"HOSTILE_RAW_MANIFEST_SENTINEL"}\n', { mode: 0o600 });
    assert.throws(
      () => prepareHostRealization({
        root: malformedManifest,
        configurationName: 'meeting-intake',
        id: 'host-realization-plan.malformed-manifest',
        createdAt: CREATED,
        validUntil: VALID_UNTIL
      }),
      (error) => error.code === 'HOST_REALIZATION_MANIFEST_MALFORMED'
        || error.code === 'HOST_REALIZATION_MANIFEST_TAMPERED'
    );

    console.log('Host realization self-test passed.');
    return true;
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const sourceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  selftestHostRealizations(sourceRoot).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
