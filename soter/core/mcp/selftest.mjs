#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { fingerprintJson } from '../lib/canonical-json.mjs';
import { changeSetScopeFingerprint } from '../transaction.mjs';

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const lockPath = 'soter/fixtures/meeting-intake/meeting-intake.lock.json';
const runPath = 'soter/fixtures/meeting-intake/preflight.run.json';
const completedRunPath = 'soter/fixtures/meeting-intake/transaction.run.json';
const fixtureTime = '2026-07-15T12:00:00.000Z';

function notionProbeResponse(checkpoint, marker, driftStepId = null) {
  const source = checkpoint.plan.steps.find((step) => step.id === checkpoint.currentStepId);
  if (source.kind === 'identity') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          metadata: { type: 'self' },
          self: {
            workspace: { id: 'workspace.mcp-selftest', name: marker },
            user: { id: 'user.mcp-selftest', name: marker }
          }
        })
      }],
      isError: false
    };
  }
  if (source.kind === 'schema') {
    const schema = Object.fromEntries(source.scope.expectedFields.map((field) => {
      return [field.provider, { name: field.provider, type: field.providerType }];
    }));
    if (source.id === driftStepId) {
      const first = source.scope.expectedFields[0];
      schema[first.provider].type = 'unexpected-mcp-selftest-type';
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          metadata: { type: 'data_source' },
          title: 'Private target ' + marker,
          url: 'https://notion.invalid/private-target',
          text: '<data-source url="{{' + source.scope.targetUri + '}}">\n'
            + '<data-source-state>\n' + JSON.stringify({ schema })
            + '\n</data-source-state>\n</data-source>'
        })
      }],
      isError: false
    };
  }
  if (source.kind === 'document') {
    return notionPageResponse({
      uri: source.scope.input.uri,
      title: source.id === driftStepId
        ? 'Drifted policy title'
        : source.scope.input.expectedTitle,
      body: '# Synthetic policy\n\nPrivate probe body ' + marker + '.',
      marker
    });
  }
  return {
    structuredContent: { result: { results: [], has_more: false } }
  };
}

function notionTaskResponse(id, fields, marker = null) {
  return {
    structuredContent: {
      result: {
        results: [{
          __soterType: 'task',
          __soterId: id,
          __soterFields: JSON.stringify({
            ...fields,
            projectUris: JSON.stringify(fields.projectUris)
          })
        }],
        has_more: false
      }
    },
    ...(marker ? { privateMarker: marker } : {})
  };
}

function notionSummaryResponse(id, fields, marker = null) {
  return {
    structuredContent: {
      result: {
        results: [{
          __soterType: 'meeting-summary',
          __soterId: id,
          __soterFields: JSON.stringify(fields)
        }],
        has_more: false
      }
    },
    ...(marker ? { privateMarker: marker } : {})
  };
}

function notionPageResponse({ uri, title, body, marker = null }) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        metadata: { type: 'page' },
        title,
        url: uri,
        text: 'Here is the result of "view" for the requested page.\n'
          + '<page url="' + uri + '">\n'
          + '<ancestor-path></ancestor-path>\n'
          + '<properties>{"title":' + JSON.stringify(title) + '}</properties>\n'
          + body + '\n'
          + '</page>'
      })
    }],
    isError: false,
    ...(marker ? { privateMarker: marker } : {})
  };
}

function applicablePolicySources(lock) {
  return lock.sources.flatMap((source) => {
    const consumer = source.consumers.find((item) => {
      return item.pack === 'automation.meeting-intake'
        && item.purpose === 'applicable-policy';
    });
    if (!consumer) return [];
    return [{
      id: source.id.slice('source.'.length),
      sourceId: source.id,
      subjects: consumer.subjects,
      title: source.input.expectedTitle,
      documentUri: source.input.uri,
      reason: consumer.reason
    }];
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

function createFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-mcp-'));
  fs.cpSync(path.join(codeRoot, 'soter'), path.join(root, 'soter'), { recursive: true });
  fs.cpSync(path.join(codeRoot, '.codex'), path.join(root, '.codex'), { recursive: true });
  fs.cpSync(path.join(codeRoot, '.claude'), path.join(root, '.claude'), { recursive: true });
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(codeRoot, file), path.join(root, file));
  }
  return root;
}

async function connectClient(root, host = 'codex') {
  const client = new Client({ name: 'soter-core-selftest', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(codeRoot, 'soter/core/mcp/server.mjs'),
      '--root',
      root,
      '--host',
      host
    ],
    cwd: root,
    stderr: 'pipe'
  });
  await client.connect(transport);
  return client;
}

function toolResult(response) {
  if (response.isError) {
    throw new Error('MCP tool returned an error: ' + JSON.stringify(response.content));
  }
  return response.structuredContent?.result;
}

async function call(client, name, args) {
  return toolResult(await client.callTool({ name, arguments: args }));
}

async function expectToolError(client, name, args, message) {
  const response = await client.callTool({ name, arguments: args });
  if (!response.isError || !JSON.stringify(response.content).includes(message)) {
    throw new Error(
      name + ' did not fail with expected diagnostic: ' + message
        + '; observed: ' + JSON.stringify(response.content)
    );
  }
}

function checkpointFile(root, prepared) {
  return path.join(root, prepared.checkpointPath);
}

function assertPrivateFile(file) {
  if (!fs.existsSync(file)) throw new Error('Durable private state file is missing: ' + file);
  if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o777) !== 0o600) {
    throw new Error('Durable private state file does not use mode 0600: ' + file);
  }
}

function invokeCli(root, args) {
  return spawnSync(
    process.execPath,
    [path.join(codeRoot, 'soter/core/cli.mjs'), ...args, '--root', root, '--json'],
    { cwd: root, encoding: 'utf8' }
  );
}

function runCli(root, args) {
  const invoked = invokeCli(root, args);
  if (invoked.status !== 0) {
    throw new Error('CLI projection failed: ' + (invoked.stderr || invoked.stdout));
  }
  return JSON.parse(invoked.stdout);
}

function prepareCliConnectedTransactionFixture({ root, privateInputRoot, suffix, recordId, priorFields }) {
  const sourceRun = JSON.parse(fs.readFileSync(path.join(root, runPath), 'utf8'));
  sourceRun.id = 'run.meeting-intake.' + suffix;
  const sourceRunPath = 'soter/fixtures/meeting-intake/' + suffix + '.run.json';
  fs.writeFileSync(path.join(root, sourceRunPath), JSON.stringify(sourceRun, null, 2) + '\n');
  const input = {
    recordType: 'task',
    id: recordId,
    expectedVersion: fingerprintJson({ type: 'task', id: recordId, fields: priorFields }),
    patch: { status: 'Open' }
  };
  const changeSet = {
    $contract: 'soter://contracts/change-set/v1',
    contractVersion: '1.0.0',
    id: 'changeset.meeting-intake.' + suffix,
    runId: sourceRun.id,
    createdAt: fixtureTime,
    configurationLockFingerprint: sourceRun.configurationLock.fingerprint,
    state: 'proposed',
    scopeFingerprint: 'sha256:' + '0'.repeat(64),
    operations: [{
      id: 'operation.task.' + suffix + '-status-update',
      capability: 'crm.records.update',
      authority: 'authority.crm.instance',
      reason: 'Prove exact connected transaction behavior through CLI and MCP projections.',
      input,
      inputFingerprint: fingerprintJson(input),
      state: 'pending',
      effectId: null,
      outputFingerprint: null,
      error: null
    }],
    approvalId: null,
    transaction: {
      checkpointFingerprint: 'sha256:' + '0'.repeat(64),
      state: 'not-started',
      rollbackState: 'not-required',
      restoredFingerprint: null
    },
    verification: {
      state: 'unknown',
      effectId: null,
      criteria: ['Compare, update, verify, and reconcile through exact durable calls.'],
      observedFingerprint: null
    }
  };
  changeSet.scopeFingerprint = changeSetScopeFingerprint(changeSet);
  const changeSetPath = 'soter/fixtures/meeting-intake/' + suffix + '.changeset.json';
  fs.writeFileSync(path.join(root, changeSetPath), JSON.stringify(changeSet, null, 2) + '\n');
  const batch = runCli(root, [
    'connected-batch-preview',
    '--lock', lockPath,
    '--change-set', changeSetPath,
    '--batch-id', 'batch.meeting-intake.' + suffix,
    '--at', fixtureTime
  ]);
  const batchPath = path.join(privateInputRoot, suffix + '.batch.json');
  fs.writeFileSync(batchPath, JSON.stringify(batch, null, 2) + '\n', { mode: 0o600 });
  const request = runCli(root, [
    'connected-approval-request',
    '--lock', lockPath,
    '--run', sourceRunPath,
    '--batch', batchPath,
    '--change-set', changeSetPath,
    '--request-id', 'approval-request.meeting-intake.' + suffix,
    '--reason', 'Request confirmation for this exact mapped update projection.',
    '--expires-at', '2026-07-15T12:05:00.000Z',
    '--at', fixtureTime
  ]);
  const approval = runCli(root, [
    'connected-approval-confirm',
    '--request-id', request.request.id,
    '--approval-id', 'approval.meeting-intake.' + suffix,
    '--actor', 'mcp-selftest-user',
    '--reason', 'Authorize only this exact mapped update for projection verification.',
    '--at', fixtureTime
  ]).approval;
  const transaction = runCli(root, [
    'connected-transaction-prepare',
    '--approval-id', approval.id,
    '--at', fixtureTime
  ]);
  return { transaction, approval };
}

async function assertWrongHostRejected(root) {
  const client = await connectClient(root, 'claude');
  try {
    await expectToolError(client, 'soter_prepare_provider_probe', {
      lock_path: lockPath,
      provider_implementation: 'provider.integration.otter.mcp',
      at: fixtureTime
    }, 'does not match the active host projection claude');
  } finally {
    await client.close().catch(() => {});
  }
}

async function assertClaudeHostProjection(root) {
  const claudeLockPath = 'soter/fixtures/meeting-intake/mcp-claude.lock.json';
  const claudeRunPath = 'soter/fixtures/meeting-intake/mcp-claude.run.json';
  const claudeLock = runCli(root, [
    'resolve',
    '--config', 'soter/configurations/meeting-intake.config.json',
    '--host', 'claude',
    '--output', claudeLockPath
  ]);
  const preparedRun = runCli(root, [
    'prepare',
    '--lock', claudeLockPath,
    '--run-id', 'run.meeting-intake.mcp-claude-host',
    '--output', claudeRunPath,
    '--at', fixtureTime
  ]);
  const client = await connectClient(root, 'claude');
  try {
    const prepared = await call(client, 'soter_prepare_capability_call', {
      lock_path: claudeLockPath,
      run_path: claudeRunPath,
      capability: 'crm.records.read',
      authority: 'authority.crm.instance',
      provider_implementation: 'provider.integration.notion.mcp',
      input: {
        recordTypes: ['meeting'],
        ids: ['https://www.notion.so/ffffffffffffffffffffffffffffffff'],
        limit: 1
      },
      call_id: 'toolcall.mcp-selftest.claude-notion-read',
      at: fixtureTime
    });
    if (claudeLock.configuration.hostSelection?.source !== 'override'
      || claudeLock.host.id !== 'claude'
      || preparedRun.envelope?.host?.id !== 'claude'
      || prepared.checkpoint?.host?.id !== 'claude'
      || prepared.checkpoint?.call?.transport?.tool !== 'Notion:notion-query-data-sources') {
      throw new Error('Claude did not realize the same configuration through its exact native tool mapping.');
    }
    await call(client, 'soter_fail_host_call', {
      checkpoint_id: prepared.checkpoint.id,
      error_kind: 'unavailable',
      message: 'Synthetic Claude host projection call was intentionally not dispatched.',
      at: fixtureTime
    });
  } finally {
    await client.close().catch(() => {});
  }
}

async function selftest(root) {
  let client = await connectClient(root);
  let preparedCapability;
  let pendingNotionProbe;
  let failedProbe;
  let requestedRunContents;
  const privateInputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-mcp-response-'));
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    const expectedNames = [
      'soter_advance_connected_transaction',
      'soter_commit_email_triage_decision',
      'soter_commit_email_triage_proposal',
      'soter_commit_meeting_intake_decision',
      'soter_complete_capability_call',
      'soter_complete_operation_plan',
      'soter_complete_provider_probe',
      'soter_fail_host_call',
      'soter_finalize_email_triage_context',
      'soter_finalize_meeting_intake_context',
      'soter_get_host_call',
      'soter_inspect_email_triage_decision',
      'soter_inspect_email_triage_proposal',
      'soter_inspect_email_triage_proposal_material',
      'soter_inspect_host_runtime',
      'soter_inspect_meeting_intake_decision',
      'soter_list_host_calls',
      'soter_prepare_capability_call',
      'soter_prepare_email_triage_context',
      'soter_prepare_meeting_intake_context',
      'soter_prepare_operation_plan',
      'soter_prepare_provider_probe',
      'soter_propose_meeting_intake_change_set',
      'soter_reconcile_connected_transaction'
    ];
    if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
      throw new Error('Unexpected Soter MCP tools: ' + names.join(', '));
    }
    if (listed.tools.some((tool) => {
      const input = JSON.stringify(tool.inputSchema);
      return input.includes('approved_effects') || input.includes('approval');
    })) {
      throw new Error('The MCP projection exposed generic connected-write approval input.');
    }
    if (!client.getInstructions()?.includes('soter_list_host_calls')
      || !client.getInstructions()?.includes('soter_commit_email_triage_decision')
      || !client.getInstructions()?.includes('soter_commit_email_triage_proposal')
      || !client.getInstructions()?.includes('soter_commit_meeting_intake_decision')
      || !client.getInstructions()?.includes('Email acquisition')) {
      throw new Error('The MCP server did not project durable recovery instructions.');
    }

    const currentRuntime = await call(client, 'soter_inspect_host_runtime', {});
    if (currentRuntime.$contract !== 'soter://contracts/host-runtime-inspection/v1'
      || currentRuntime.host !== 'codex'
      || currentRuntime.runtime.state !== 'current'
      || currentRuntime.runtime.reasonCode !== 'SOTER_HOST_RUNTIME_CURRENT'
      || currentRuntime.runtime.restartRequired
      || currentRuntime.runtime.permittedNextAction !== 'continue'
      || currentRuntime.authority.grants !== 'none'
      || currentRuntime.authority.providerCallsPermitted
      || currentRuntime.authority.writesPermitted) {
      throw new Error('MCP host runtime inspection did not report its exact current no-authority state.');
    }

    const runtimeArtifact = path.join(root, 'soter/core/service.mjs');
    const runtimeArtifactSource = fs.readFileSync(runtimeArtifact, 'utf8');
    fs.writeFileSync(runtimeArtifact, runtimeArtifactSource + '\n// MCP runtime drift selftest.\n');
    try {
      const staleRuntime = await call(client, 'soter_inspect_host_runtime', {});
      if (staleRuntime.runtime.state !== 'stale'
        || staleRuntime.runtime.reasonCode !== 'SOTER_HOST_RUNTIME_STALE'
        || !staleRuntime.runtime.restartRequired
        || staleRuntime.runtime.permittedNextAction !== 'restart-host-runtime'
        || staleRuntime.runtime.currentFingerprint === staleRuntime.runtime.startupFingerprint) {
        throw new Error('MCP host runtime inspection did not fail closed on behavior drift.');
      }
      const staleOperation = await client.callTool({
        name: 'soter_prepare_provider_probe',
        arguments: {
          lock_path: lockPath,
          provider_implementation: 'provider.integration.notion.mcp',
          probe_id: 'probe.mcp-stale-runtime',
          at: fixtureTime
        }
      });
      if (!staleOperation.isError
        || staleOperation.structuredContent?.result?.code !== 'SOTER_HOST_RUNTIME_STALE'
        || staleOperation.structuredContent?.result?.inspection?.runtime?.state !== 'stale'
        || fs.existsSync(path.join(root, '.soter'))) {
        throw new Error('A stale MCP runtime did not block state creation before provider dispatch.');
      }
    } finally {
      fs.writeFileSync(runtimeArtifact, runtimeArtifactSource);
    }
    const restoredRuntime = await call(client, 'soter_inspect_host_runtime', {});
    if (restoredRuntime.runtime.state !== 'current'
      || restoredRuntime.runtime.currentFingerprint !== currentRuntime.runtime.startupFingerprint) {
      throw new Error('MCP host runtime inspection did not recover after exact behavior restoration.');
    }

    const connectedRunPath = 'soter/fixtures/meeting-intake/mcp-connected-transaction.run.json';
    const connectedRun = JSON.parse(fs.readFileSync(path.join(root, runPath), 'utf8'));
    connectedRun.id = 'run.meeting-intake.mcp-connected-transaction';
    fs.writeFileSync(
      path.join(root, connectedRunPath),
      JSON.stringify(connectedRun, null, 2) + '\n'
    );
    const connectedRecordId = 'https://www.notion.so/cccccccccccccccccccccccccccccccc';
    const connectedPriorFields = {
      title: 'MCP connected transaction task',
      status: 'Backlog',
      context: null,
      projectUris: [],
      assigneeIds: null,
      nextActionOn: null
    };
    const connectedInput = {
      recordType: 'task',
      id: connectedRecordId,
      expectedVersion: fingerprintJson({
        type: 'task',
        id: connectedRecordId,
        fields: connectedPriorFields
      }),
      patch: { status: 'Open' }
    };
    const connectedSummaryId = 'https://www.notion.so/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const connectedSummaryInput = {
      recordType: 'meeting-summary',
      deduplicationKey: 'https://otter.ai/u/mcp-connected-transaction',
      deduplicationFilter: {
        field: 'link',
        value: 'https://otter.ai/u/mcp-connected-transaction'
      },
      fields: {
        title: 'MCP connected transaction summary',
        documentType: 'Meeting Summary',
        description: 'Exact terminal create projection proof.',
        link: 'https://otter.ai/u/mcp-connected-transaction'
      },
      body: '# MCP connected transaction summary\n\nExact terminal create projection proof.'
    };
    const connectedChangeSet = {
      $contract: 'soter://contracts/change-set/v1',
      contractVersion: '1.0.0',
      id: 'changeset.meeting-intake.mcp-connected-transaction',
      runId: connectedRun.id,
      createdAt: fixtureTime,
      configurationLockFingerprint: connectedRun.configurationLock.fingerprint,
      state: 'proposed',
      scopeFingerprint: 'sha256:' + '0'.repeat(64),
      operations: [
        {
          id: 'operation.task.mcp-connected-status-update',
          capability: 'crm.records.update',
          authority: 'authority.crm.instance',
          reason: 'Prove the CLI authorization and MCP resume trust boundary.',
          input: connectedInput,
          inputFingerprint: fingerprintJson(connectedInput),
          state: 'pending',
          effectId: null,
          outputFingerprint: null,
          error: null
        },
        {
          id: 'operation.summary.mcp-connected-create',
          capability: 'crm.records.create',
          authority: 'authority.crm.instance',
          reason: 'Prove the terminal create and exact content verification boundary.',
          input: connectedSummaryInput,
          inputFingerprint: fingerprintJson(connectedSummaryInput),
          state: 'pending',
          effectId: null,
          outputFingerprint: null,
          error: null
        }
      ],
      approvalId: null,
      transaction: {
        checkpointFingerprint: 'sha256:' + '0'.repeat(64),
        state: 'not-started',
        rollbackState: 'not-required',
        restoredFingerprint: null
      },
      verification: {
        state: 'unknown',
        effectId: null,
        criteria: ['Compare, write, and read back the exact mapped status field.'],
        observedFingerprint: null
      }
    };
    connectedChangeSet.scopeFingerprint = changeSetScopeFingerprint(connectedChangeSet);
    const connectedChangeSetPath = 'soter/fixtures/meeting-intake/mcp-connected-transaction.changeset.json';
    fs.writeFileSync(
      path.join(root, connectedChangeSetPath),
      JSON.stringify(connectedChangeSet, null, 2) + '\n'
    );
    const connectedBatch = runCli(root, [
      'connected-batch-preview',
      '--lock', lockPath,
      '--change-set', connectedChangeSetPath,
      '--batch-id', 'batch.meeting-intake.mcp-connected-transaction',
      '--at', fixtureTime
    ]);
    const connectedBatchPath = path.join(privateInputRoot, 'mcp-connected-batch.json');
    fs.writeFileSync(connectedBatchPath, JSON.stringify(connectedBatch, null, 2) + '\n', { mode: 0o600 });
    const connectedRequest = runCli(root, [
      'connected-approval-request',
      '--lock', lockPath,
      '--run', connectedRunPath,
      '--batch', connectedBatchPath,
      '--change-set', connectedChangeSetPath,
      '--request-id', 'approval-request.meeting-intake.mcp-connected-transaction',
      '--reason', 'Request confirmation for the exact MCP connected transaction batch.',
      '--expires-at', '2026-07-15T12:05:00.000Z',
      '--at', fixtureTime
    ]);
    const connectedApproval = runCli(root, [
      'connected-approval-confirm',
      '--request-id', connectedRequest.request.id,
      '--approval-id', 'approval.meeting-intake.mcp-connected-transaction',
      '--actor', 'mcp-selftest-user',
      '--reason', 'Authorize this exact mapped update and terminal summary create for the MCP resume selftest.',
      '--at', fixtureTime
    ]).approval;
    let connectedTransaction = runCli(root, [
      'connected-transaction-prepare',
      '--approval-id', connectedApproval.id,
      '--at', fixtureTime
    ]);
    const connectedCompareMarker = 'private-mcp-connected-compare-marker';
    connectedTransaction = await call(client, 'soter_advance_connected_transaction', {
      checkpoint_id: connectedTransaction.checkpoint.id,
      call_id: connectedTransaction.currentCall.id,
      response: notionTaskResponse(
        connectedRecordId,
        connectedPriorFields,
        connectedCompareMarker
      ),
      at: '2026-07-15T12:00:01.000Z'
    });
    const connectedWriteMarker = 'private-mcp-connected-write-marker';
    connectedTransaction = await call(client, 'soter_advance_connected_transaction', {
      checkpoint_id: connectedTransaction.checkpoint.id,
      call_id: connectedTransaction.currentCall.id,
      response: {
        structuredContent: { result: { id: connectedRecordId } },
        privateMarker: connectedWriteMarker
      },
      at: '2026-07-15T12:00:02.000Z'
    });
    const connectedVerifyMarker = 'private-mcp-connected-verify-marker';
    connectedTransaction = await call(client, 'soter_advance_connected_transaction', {
      checkpoint_id: connectedTransaction.checkpoint.id,
      call_id: connectedTransaction.currentCall.id,
      response: notionTaskResponse(connectedRecordId, {
        ...connectedPriorFields,
        status: 'Open'
      }, connectedVerifyMarker),
      at: '2026-07-15T12:00:03.000Z'
    });
    const connectedCreateCompareMarker = 'private-mcp-connected-create-compare-marker';
    connectedTransaction = await call(client, 'soter_advance_connected_transaction', {
      checkpoint_id: connectedTransaction.checkpoint.id,
      call_id: connectedTransaction.currentCall.id,
      response: {
        structuredContent: { result: { results: [], has_more: false } },
        privateMarker: connectedCreateCompareMarker
      },
      at: '2026-07-15T12:00:04.000Z'
    });
    const connectedCreateWriteMarker = 'private-mcp-connected-create-write-marker';
    connectedTransaction = await call(client, 'soter_advance_connected_transaction', {
      checkpoint_id: connectedTransaction.checkpoint.id,
      call_id: connectedTransaction.currentCall.id,
      response: {
        structuredContent: { result: { url: connectedSummaryId } },
        privateMarker: connectedCreateWriteMarker
      },
      at: '2026-07-15T12:00:05.000Z'
    });
    const connectedCreateVerifyMarker = 'private-mcp-connected-create-verify-marker';
    connectedTransaction = await call(client, 'soter_advance_connected_transaction', {
      checkpoint_id: connectedTransaction.checkpoint.id,
      call_id: connectedTransaction.currentCall.id,
      response: notionSummaryResponse(
        connectedSummaryId,
        connectedSummaryInput.fields,
        connectedCreateVerifyMarker
      ),
      at: '2026-07-15T12:00:06.000Z'
    });
    const connectedContentCall = connectedTransaction.currentCall;
    const connectedCreateContentMarker = 'private-mcp-connected-create-content-marker';
    connectedTransaction = await call(client, 'soter_advance_connected_transaction', {
      checkpoint_id: connectedTransaction.checkpoint.id,
      call_id: connectedContentCall.id,
      response: notionPageResponse({
        uri: connectedSummaryId,
        title: connectedSummaryInput.fields.title,
        body: connectedSummaryInput.body,
        marker: connectedCreateContentMarker
      }),
      at: '2026-07-15T12:00:07.000Z'
    });
    const connectedDurableText = [
      connectedTransaction.checkpointPath,
      connectedTransaction.runPath
    ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    if (connectedTransaction.checkpoint.state !== 'completed'
      || connectedTransaction.run.approvals[0]?.id !== connectedApproval.id
      || connectedTransaction.run.effects.length !== 7
      || connectedTransaction.checkpoint.operations[1].createdRecordId !== connectedSummaryId
      || connectedContentCall.capability.id !== 'documents.content.read'
      || [
        connectedCompareMarker,
        connectedWriteMarker,
        connectedVerifyMarker,
        connectedCreateCompareMarker,
        connectedCreateWriteMarker,
        connectedCreateVerifyMarker,
        connectedCreateContentMarker
      ].some((marker) => {
        return JSON.stringify(connectedTransaction).includes(marker)
          || connectedDurableText.includes(marker);
      })) {
      throw new Error('CLI-authorized MCP transaction did not resume, verify, and minimize exactly.');
    }

    const reconciliationRecordId = 'https://www.notion.so/dddddddddddddddddddddddddddddddd';
    const reconciliationPriorFields = {
      title: 'MCP reconciliation task',
      status: 'Backlog',
      context: null,
      projectUris: [],
      assigneeIds: null,
      nextActionOn: null
    };
    let projectedReconciliation = prepareCliConnectedTransactionFixture({
      root,
      privateInputRoot,
      suffix: 'mcp-connected-reconciliation',
      recordId: reconciliationRecordId,
      priorFields: reconciliationPriorFields
    }).transaction;
    projectedReconciliation = await call(client, 'soter_advance_connected_transaction', {
      checkpoint_id: projectedReconciliation.checkpoint.id,
      call_id: projectedReconciliation.currentCall.id,
      response: notionTaskResponse(reconciliationRecordId, reconciliationPriorFields),
      at: '2026-07-15T12:00:01.000Z'
    });
    projectedReconciliation = await call(client, 'soter_fail_host_call', {
      checkpoint_id: projectedReconciliation.checkpoint.id,
      call_id: projectedReconciliation.currentCall.id,
      error_kind: 'unavailable',
      message: 'Injected MCP write ambiguity.',
      at: '2026-07-15T12:00:02.000Z'
    });
    projectedReconciliation = await call(client, 'soter_reconcile_connected_transaction', {
      checkpoint_id: projectedReconciliation.checkpoint.id,
      at: '2026-07-15T12:00:03.000Z'
    });
    const divergedReconciliationMarker = 'private-mcp-reconciliation-diverged-marker';
    projectedReconciliation = await call(client, 'soter_advance_connected_transaction', {
      checkpoint_id: projectedReconciliation.checkpoint.id,
      call_id: projectedReconciliation.currentCall.id,
      response: notionTaskResponse(reconciliationRecordId, {
        ...reconciliationPriorFields,
        status: 'Unexpected concurrent value'
      }, divergedReconciliationMarker),
      at: '2026-07-15T12:00:04.000Z'
    });
    projectedReconciliation = runCli(root, [
      'connected-transaction-reconcile',
      '--checkpoint', projectedReconciliation.checkpoint.id,
      '--at', '2026-07-15T12:00:05.000Z'
    ]);
    const approvedReconciliationMarker = 'private-mcp-reconciliation-approved-marker';
    projectedReconciliation = await call(client, 'soter_advance_connected_transaction', {
      checkpoint_id: projectedReconciliation.checkpoint.id,
      call_id: projectedReconciliation.currentCall.id,
      response: notionTaskResponse(reconciliationRecordId, {
        ...reconciliationPriorFields,
        status: 'Open'
      }, approvedReconciliationMarker),
      at: '2026-07-15T12:00:06.000Z'
    });
    const projectedReconciliationText = [
      projectedReconciliation.checkpointPath,
      projectedReconciliation.runPath
    ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    if (projectedReconciliation.checkpoint.state !== 'completed'
      || projectedReconciliation.checkpoint.operations[0].reconciliations.length !== 2
      || projectedReconciliation.checkpoint.operations[0].reconciliations[0].outcome
        !== 'diverged'
      || projectedReconciliation.checkpoint.operations[0].reconciliations[1].outcome
        !== 'approved-fields'
      || projectedReconciliation.run.effects.length !== 4
      || [divergedReconciliationMarker, approvedReconciliationMarker].some((marker) => {
        return JSON.stringify(projectedReconciliation).includes(marker)
          || projectedReconciliationText.includes(marker);
      })) {
      throw new Error('CLI and MCP reconciliation projections retried a write, drifted, or persisted a native response.');
    }

    await expectToolError(client, 'soter_prepare_capability_call', {
      lock_path: lockPath,
      run_path: completedRunPath,
      capability: 'meeting.transcript.read',
      authority: 'authority.otter.provider',
      provider_implementation: 'provider.integration.otter.mcp',
      input: {
        meetingId: 'meeting.closed-run',
        recordingUri: 'https://otter.ai/u/conversation_closed_run'
      },
      at: fixtureTime
    }, 'cannot continue this host request');

    const preparedProbe = await call(client, 'soter_prepare_provider_probe', {
      lock_path: lockPath,
      provider_implementation: 'provider.integration.otter.mcp',
      call_id: 'probecall.mcp-selftest.otter',
      probe_id: 'probe.mcp-selftest.otter',
      at: fixtureTime,
      valid_for_seconds: 300
    });
    if (preparedProbe.checkpoint?.state !== 'requested'
      || preparedProbe.checkpoint?.call?.transport?.server !== 'otter'
      || preparedProbe.checkpoint?.call?.transport?.operation !== 'get_user_info'
      || preparedProbe.checkpoint?.call?.transport?.tool !== 'mcp__otter__get_user_info'
      || JSON.stringify(preparedProbe.checkpoint?.call?.arguments) !== '{}') {
      throw new Error('Provider probe preparation did not persist the exact Otter request.');
    }
    assertPrivateFile(checkpointFile(root, preparedProbe));

    const privateIdentity = 'private-identity-mcp-selftest-marker';
    const completedProbe = await call(client, 'soter_complete_provider_probe', {
      checkpoint_id: preparedProbe.checkpoint.id,
      response: { structuredContent: { result: privateIdentity } },
      at: fixtureTime
    });
    if (completedProbe.checkpoint?.state !== 'completed'
      || completedProbe.checkpoint?.result?.capabilities?.[0]?.state !== 'unknown'
      || JSON.stringify(completedProbe).includes(privateIdentity)
      || fs.readFileSync(checkpointFile(root, completedProbe), 'utf8').includes(privateIdentity)) {
      throw new Error('Provider probe completion did not minimize durable identity evidence.');
    }
    const repeatedProbe = await call(client, 'soter_complete_provider_probe', {
      checkpoint_id: preparedProbe.checkpoint.id,
      response: { structuredContent: { result: privateIdentity } },
      at: fixtureTime
    });
    if (repeatedProbe.checkpoint.checkpointFingerprint
      !== completedProbe.checkpoint.checkpointFingerprint) {
      throw new Error('Repeating an identical provider result was not idempotent.');
    }

    const notionMarker = 'private-notion-probe-mcp-selftest-marker';
    const preparedNotionProbe = await call(client, 'soter_prepare_provider_probe', {
      lock_path: lockPath,
      provider_implementation: 'provider.integration.notion.mcp',
      probe_id: 'probe.mcp-selftest.notion-plan',
      at: fixtureTime,
      valid_for_seconds: 300
    });
    if (preparedNotionProbe.checkpoint?.state !== 'requested'
      || preparedNotionProbe.checkpoint?.steps?.length !== 20
      || preparedNotionProbe.currentCall?.transport?.operation !== 'fetch'
      || preparedNotionProbe.currentCall?.arguments?.id !== 'self') {
      throw new Error('MCP provider probe plan did not expose one exact first Notion call.');
    }
    pendingNotionProbe = await call(client, 'soter_complete_provider_probe', {
      checkpoint_id: preparedNotionProbe.checkpoint.id,
      call_id: preparedNotionProbe.currentCall.id,
      response: notionProbeResponse(preparedNotionProbe.checkpoint, notionMarker),
      at: fixtureTime
    });
    if (pendingNotionProbe.checkpoint?.state !== 'requested'
      || pendingNotionProbe.currentCall?.id
        === preparedNotionProbe.currentCall.id
      || pendingNotionProbe.checkpoint.currentStepId !== 'step.record.policy.schema') {
      throw new Error('MCP provider probe plan did not minimize identity and emit its next exact call.');
    }
    assertPrivateFile(checkpointFile(root, pendingNotionProbe));
    if (fs.readFileSync(checkpointFile(root, pendingNotionProbe), 'utf8').includes(notionMarker)) {
      throw new Error('Notion identity content reached durable provider probe plan state.');
    }

    const failedProbeRequest = await call(client, 'soter_prepare_provider_probe', {
      lock_path: lockPath,
      provider_implementation: 'provider.integration.otter.mcp',
      call_id: 'probecall.mcp-selftest.failure',
      probe_id: 'probe.mcp-selftest.failure',
      at: fixtureTime
    });
    failedProbe = await call(client, 'soter_fail_host_call', {
      checkpoint_id: failedProbeRequest.checkpoint.id,
      error_kind: 'authentication',
      message: 'The host could not authenticate the provider request.',
      at: fixtureTime
    });
    if (failedProbe.checkpoint?.state !== 'failed'
      || failedProbe.checkpoint?.call?.error?.kind !== 'authentication') {
      throw new Error('Host failure recording did not close the durable provider request.');
    }

    const staleProbe = await call(client, 'soter_prepare_provider_probe', {
      lock_path: lockPath,
      provider_implementation: 'provider.integration.otter.mcp',
      call_id: 'probecall.mcp-selftest.stale',
      probe_id: 'probe.mcp-selftest.stale',
      at: fixtureTime
    });
    const providerModule = path.join(root, 'soter/integrations/otter/mcp.mjs');
    const providerSource = fs.readFileSync(providerModule, 'utf8');
    try {
      fs.writeFileSync(providerModule, providerSource + '\n// planted stale-state change\n');
      await expectToolError(client, 'soter_complete_provider_probe', {
        checkpoint_id: staleProbe.checkpoint.id,
        response: { structuredContent: { result: 'private-stale-identity' } },
        at: fixtureTime
      }, 'SOTER_HOST_RUNTIME_STALE');
      await client.close();
      client = await connectClient(root);
      await expectToolError(client, 'soter_complete_provider_probe', {
        checkpoint_id: staleProbe.checkpoint.id,
        response: { structuredContent: { result: 'private-stale-identity' } },
        at: fixtureTime
      }, 'Configuration lock is stale');
      await client.close();
    } finally {
      fs.writeFileSync(providerModule, providerSource);
      client = await connectClient(root);
    }
    await call(client, 'soter_fail_host_call', {
      checkpoint_id: staleProbe.checkpoint.id,
      error_kind: 'unavailable',
      message: 'The stale-state selftest restored the exact provider implementation.',
      at: fixtureTime
    });

    const capabilityInput = {
      meetingId: 'meeting.mcp-selftest',
      recordingUri: 'https://otter.ai/u/conversation_mcp_selftest'
    };
    preparedCapability = await call(client, 'soter_prepare_capability_call', {
      lock_path: lockPath,
      run_path: runPath,
      capability: 'meeting.transcript.read',
      authority: 'authority.otter.provider',
      provider_implementation: 'provider.integration.otter.mcp',
      input: capabilityInput,
      call_id: 'toolcall.mcp-selftest.otter-read',
      at: fixtureTime
    });
    if (preparedCapability.checkpoint?.state !== 'requested'
      || preparedCapability.checkpoint?.call?.transport?.server !== 'otter'
      || preparedCapability.checkpoint?.call?.transport?.operation !== 'fetch'
      || preparedCapability.checkpoint?.call?.transport?.tool !== 'mcp__otter__fetch'
      || preparedCapability.checkpoint?.call?.arguments?.id !== 'conversation_mcp_selftest'
      || preparedCapability.run?.lifecycleState !== 'executing') {
      throw new Error('Capability preparation did not durably stage the exact Otter request.');
    }
    assertPrivateFile(checkpointFile(root, preparedCapability));
    assertPrivateFile(path.join(root, preparedCapability.runPath));
    requestedRunContents = fs.readFileSync(path.join(root, preparedCapability.runPath), 'utf8');

    const pending = await call(client, 'soter_list_host_calls', { state: 'requested' });
    if (!pending.checkpoints.some((item) => item.id === preparedCapability.checkpoint.id)) {
      throw new Error('Pending host call listing omitted the durable capability checkpoint.');
    }
    const loaded = await call(client, 'soter_get_host_call', {
      checkpoint_id: preparedCapability.checkpoint.id
    });
    if (loaded.checkpoint.checkpointFingerprint
      !== preparedCapability.checkpoint.checkpointFingerprint) {
      throw new Error('Host call rehydration changed the durable checkpoint.');
    }
    await expectToolError(client, 'soter_prepare_capability_call', {
      lock_path: lockPath,
      run_path: runPath,
      capability: 'meeting.transcript.read',
      authority: 'authority.otter.provider',
      provider_implementation: 'provider.integration.otter.mcp',
      input: capabilityInput,
      call_id: 'toolcall.mcp-selftest.parallel-read',
      at: fixtureTime
    }, 'already has pending host call checkpoint');

    fs.copyFileSync(path.join(root, runPath), path.join(root, preparedCapability.runPath));
  } finally {
    await client.close().catch(() => {});
  }

  client = await connectClient(root);
  try {
    let recoveredNotionProbe = await call(client, 'soter_get_host_call', {
      checkpoint_id: pendingNotionProbe.checkpoint.id
    });
    if (recoveredNotionProbe.checkpoint.state !== 'requested'
      || recoveredNotionProbe.currentCall?.id !== pendingNotionProbe.currentCall.id) {
      throw new Error('Restarted MCP server did not recover the exact provider probe step.');
    }
    const notionMarker = 'private-notion-probe-mcp-selftest-marker';
    while (recoveredNotionProbe.checkpoint.state === 'requested') {
      recoveredNotionProbe = await call(client, 'soter_complete_provider_probe', {
        checkpoint_id: recoveredNotionProbe.checkpoint.id,
        call_id: recoveredNotionProbe.currentCall.id,
        response: notionProbeResponse(recoveredNotionProbe.checkpoint, notionMarker),
        at: fixtureTime
      });
    }
    if (recoveredNotionProbe.checkpoint.state !== 'completed'
      || recoveredNotionProbe.checkpoint.result?.$contract
        !== 'soter://contracts/provider-probe/v2'
      || recoveredNotionProbe.checkpoint.result?.checks?.length !== 20
      || recoveredNotionProbe.checkpoint.result?.checks?.filter((check) => {
        return check.kind === 'document' && check.method === 'read-only';
      }).length !== 3
      || recoveredNotionProbe.checkpoint.result?.capabilities?.find((item) => {
        return item.id === 'crm.records.read';
      })?.state !== 'passed'
      || recoveredNotionProbe.checkpoint.result?.capabilities?.find((item) => {
        return item.id === 'documents.content.read';
      })?.state !== 'passed'
      || recoveredNotionProbe.checkpoint.result?.capabilities?.filter((item) => {
        return item.id === 'crm.records.create' || item.id === 'crm.records.update';
      }).some((item) => item.state !== 'unknown')
      || JSON.stringify(recoveredNotionProbe).includes(notionMarker)
      || fs.readFileSync(checkpointFile(root, recoveredNotionProbe), 'utf8')
        .includes(notionMarker)
      || fs.readFileSync(checkpointFile(root, recoveredNotionProbe), 'utf8')
        .includes('automation.meeting-intake')) {
      throw new Error('Recovered Notion probe plan did not close with minimized exact checks.');
    }

    let driftedNotionProbe = await call(client, 'soter_prepare_provider_probe', {
      lock_path: lockPath,
      provider_implementation: 'provider.integration.notion.mcp',
      probe_id: 'probe.mcp-selftest.notion-drift',
      at: fixtureTime
    });
    const driftStepId = 'step.record.organization.schema';
    while (driftedNotionProbe.checkpoint.state === 'requested') {
      driftedNotionProbe = await call(client, 'soter_complete_provider_probe', {
        checkpoint_id: driftedNotionProbe.checkpoint.id,
        call_id: driftedNotionProbe.currentCall.id,
        response: notionProbeResponse(
          driftedNotionProbe.checkpoint,
          notionMarker,
          driftStepId
        ),
        at: fixtureTime
      });
    }
    const driftedStep = driftedNotionProbe.checkpoint.steps.find((step) => {
      return step.id === driftStepId;
    });
    if (driftedNotionProbe.checkpoint.state !== 'failed'
      || driftedStep?.error?.kind !== 'validation'
      || driftedNotionProbe.checkpoint.result !== null) {
      throw new Error('MCP provider probe plan did not fail closed on target schema drift.');
    }

    const recovered = await call(client, 'soter_get_host_call', {
      checkpoint_id: preparedCapability.checkpoint.id
    });
    if (recovered.checkpoint.state !== 'requested') {
      throw new Error('Restarted MCP server did not recover the pending checkpoint.');
    }
    const privateTranscript = 'private-transcript-mcp-selftest-marker';
    const response = {
      structuredContent: {
        result: {
          speakers: [{ id: 'speaker.mcp', displayName: 'MCP speaker' }],
          segments: [{
            speakerId: 'speaker.mcp',
            text: 'MCP transcript segment.',
            startSeconds: 0
          }],
          ignoredPrivateField: privateTranscript
        }
      }
    };
    const completed = await call(client, 'soter_complete_capability_call', {
      checkpoint_id: preparedCapability.checkpoint.id,
      response,
      at: fixtureTime
    });
    if (completed.checkpoint?.state !== 'completed'
      || completed.checkpoint?.result?.meetingId !== 'meeting.mcp-selftest'
      || completed.run?.effects?.at(-1)?.state !== 'passed'
      || completed.run?.outputs?.at(-1)?.fingerprint
        !== completed.checkpoint.call.outputFingerprint
      || JSON.stringify(completed).includes(privateTranscript)) {
      throw new Error('Recovered capability completion did not update durable normalized state.');
    }
    const checkpointContents = fs.readFileSync(checkpointFile(root, completed), 'utf8');
    const runContents = fs.readFileSync(path.join(root, completed.runPath), 'utf8');
    if (checkpointContents.includes(privateTranscript) || runContents.includes(privateTranscript)) {
      throw new Error('Raw provider response content reached durable runtime state.');
    }
    fs.writeFileSync(path.join(root, completed.runPath), requestedRunContents, { mode: 0o600 });
    const repeated = await call(client, 'soter_complete_capability_call', {
      checkpoint_id: preparedCapability.checkpoint.id,
      response,
      at: fixtureTime
    });
    if (repeated.checkpoint.checkpointFingerprint
      !== completed.checkpoint.checkpointFingerprint
      || repeated.run?.effects?.at(-1)?.state !== 'passed') {
      throw new Error('Repeating an identical capability result was not idempotent.');
    }
    const remaining = await call(client, 'soter_list_host_calls', { state: 'requested' });
    if (remaining.checkpoints.some((item) => item.id === preparedCapability.checkpoint.id)) {
      throw new Error('Completed capability remained in the pending recovery list.');
    }

    const preparedPlan = await call(client, 'soter_prepare_operation_plan', {
      lock_path: lockPath,
      run_path: runPath,
      plan: {
        $contract: 'soter://contracts/operation-plan/v1',
        contractVersion: '1.0.0',
        id: 'plan.mcp-selftest.multi-target-read',
        runId: completed.run.id,
        createdAt: '2026-07-15T12:00:04.000Z',
        mode: 'sequential',
        failurePolicy: 'stop',
        reason: 'Prove sequential multi-target reads through the shared MCP projection and durable Core service.',
        steps: [
          {
            id: 'step.read-meeting',
            capability: 'crm.records.read',
            authority: 'authority.crm.instance',
            providerImplementation: 'provider.integration.notion.mcp',
            input: { recordTypes: ['meeting'], limit: 1 },
            reason: 'Read one mapped meeting target through the Notion provider.'
          },
          {
            id: 'step.read-task',
            capability: 'crm.records.read',
            authority: 'authority.crm.instance',
            providerImplementation: 'provider.integration.notion.mcp',
            input: { recordTypes: ['task'], limit: 1 },
            reason: 'Read one mapped task target after the first call completes.'
          }
        ]
      },
      at: '2026-07-15T12:00:04.000Z'
    });
    const firstPlanCall = preparedPlan.currentCall;
    if (preparedPlan.checkpoint?.state !== 'requested'
      || preparedPlan.checkpoint?.currentStepId !== 'step.read-meeting'
      || firstPlanCall?.transport?.operation !== 'query_data_sources'
      || firstPlanCall?.transport?.tool
        !== 'mcp__codex_apps__notion_notion_query_data_sources') {
      throw new Error('MCP operation plan did not emit the exact first native host call.');
    }
    const firstPlanMarker = 'private-first-plan-response-marker';
    const firstPlanResponse = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: [{
            __soterType: 'meeting',
            __soterId: 'https://app.notion.com/mcp-plan-meeting',
            __soterFields: JSON.stringify({
              title: 'MCP plan meeting',
              meetingType: 'Project Sync',
              recordingUri: 'https://otter.ai/u/mcp-plan-meeting',
              organizationUris: '[]',
              participantIds: '[]'
            })
          }],
          has_more: false
        })
      }],
      privateMarker: firstPlanMarker
    };
    const advancedPlan = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: preparedPlan.checkpoint.id,
      call_id: firstPlanCall.id,
      response: firstPlanResponse,
      at: '2026-07-15T12:00:05.000Z'
    });
    const secondPlanCall = advancedPlan.currentCall;
    if (advancedPlan.checkpoint?.state !== 'requested'
      || advancedPlan.checkpoint?.currentStepId !== 'step.read-task'
      || advancedPlan.checkpoint?.steps?.[0]?.state !== 'completed'
      || secondPlanCall?.id === firstPlanCall.id
      || JSON.stringify(advancedPlan).includes(firstPlanMarker)) {
      throw new Error('MCP operation plan did not atomically advance and minimize the first response.');
    }
    const replayedPlanStep = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: preparedPlan.checkpoint.id,
      call_id: firstPlanCall.id,
      response: firstPlanResponse,
      at: '2026-07-15T12:00:05.500Z'
    });
    if (replayedPlanStep.checkpoint.checkpointFingerprint
      !== advancedPlan.checkpoint.checkpointFingerprint
      || replayedPlanStep.currentCall?.id !== secondPlanCall.id) {
      throw new Error('MCP operation plan replay was not idempotent after advancing steps.');
    }
    const pendingPlan = await call(client, 'soter_list_host_calls', { state: 'requested' });
    if (!pendingPlan.checkpoints.some((item) => {
      return item.id === preparedPlan.checkpoint.id
        && item.kind === 'operation-plan'
        && item.currentStepId === 'step.read-task';
    })) {
      throw new Error('Pending host call listing omitted the active operation plan step.');
    }
    await client.close();
    client = await connectClient(root);
    const recoveredPlan = await call(client, 'soter_get_host_call', {
      checkpoint_id: preparedPlan.checkpoint.id
    });
    if (recoveredPlan.checkpoint?.state !== 'requested'
      || recoveredPlan.currentCall?.id !== secondPlanCall.id) {
      throw new Error('Restarted MCP server did not recover the exact current operation plan call.');
    }
    await expectToolError(client, 'soter_complete_operation_plan', {
      checkpoint_id: preparedPlan.checkpoint.id,
      call_id: firstPlanCall.id,
      response: { structuredContent: { result: { results: [], has_more: false } } },
      at: '2026-07-15T12:00:05.750Z'
    }, 'exact completed step call');
    const secondPlanMarker = 'private-second-plan-response-marker';
    const completedPlan = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: preparedPlan.checkpoint.id,
      call_id: secondPlanCall.id,
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'task',
              __soterId: 'https://app.notion.com/mcp-plan-task',
              __soterFields: JSON.stringify({
                title: 'MCP plan task',
                status: 'Open',
                context: null,
                projectUris: '[]'
              })
            }],
            has_more: false
          }
        },
        privateMarker: secondPlanMarker
      },
      at: '2026-07-15T12:00:06.000Z'
    });
    if (completedPlan.checkpoint?.state !== 'completed'
      || completedPlan.currentCall !== null
      || completedPlan.checkpoint?.steps?.some((step) => step.state !== 'completed')
      || completedPlan.checkpoint?.result?.outputFingerprints?.length !== 2
      || JSON.stringify(completedPlan).includes(secondPlanMarker)
      || fs.readFileSync(checkpointFile(root, completedPlan), 'utf8').includes('private-')) {
      throw new Error('Recovered MCP operation plan did not complete with minimized durable state.');
    }
    const completedPlanFile = checkpointFile(root, completedPlan);
    const completedPlanContents = fs.readFileSync(completedPlanFile, 'utf8');
    const tamperedPlan = JSON.parse(completedPlanContents);
    tamperedPlan.steps[0].output.records[0].fields.title = 'Tampered plan output';
    fs.writeFileSync(completedPlanFile, JSON.stringify(tamperedPlan, null, 2) + '\n');
    await expectToolError(client, 'soter_get_host_call', {
      checkpoint_id: completedPlan.checkpoint.id
    }, 'fingerprint does not match');
    fs.writeFileSync(completedPlanFile, completedPlanContents, { mode: 0o600 });

    const cliPlanPath = path.join(privateInputRoot, 'cli-operation-plan.json');
    fs.writeFileSync(cliPlanPath, JSON.stringify({
      $contract: 'soter://contracts/operation-plan/v1',
      contractVersion: '1.0.0',
      id: 'plan.cli-selftest.single-target-read',
      runId: completed.run.id,
      createdAt: '2026-07-15T12:00:07.000Z',
      mode: 'sequential',
      failurePolicy: 'stop',
      reason: 'Prove the CLI consumes the same durable sequential operation-plan service.',
      steps: [{
        id: 'step.read-meeting',
        capability: 'crm.records.read',
        authority: 'authority.crm.instance',
        providerImplementation: 'provider.integration.notion.mcp',
        input: { recordTypes: ['meeting'], limit: 1 },
        reason: 'Read one mapped meeting target through the CLI projection.'
      }]
    }, null, 2) + '\n', { mode: 0o600 });
    const cliPlan = runCli(root, [
      'plan-prepare',
      '--lock', lockPath,
      '--run', runPath,
      '--plan', cliPlanPath,
      '--at', '2026-07-15T12:00:07.000Z'
    ]);
    const rejectedPlanExport = invokeCli(root, [
      'plan-prepare',
      '--lock', lockPath,
      '--run', runPath,
      '--plan', cliPlanPath,
      '--output', 'soter/fixtures/meeting-intake/private-plan-checkpoint.json',
      '--at', '2026-07-15T12:00:07.000Z'
    ]);
    if (rejectedPlanExport.status === 0
      || !rejectedPlanExport.stderr.includes('private runtime state')) {
      throw new Error('CLI allowed a private operation-plan checkpoint export into the repository.');
    }
    const cliPlanMarker = 'private-cli-plan-response-marker';
    const cliPlanResponsePath = path.join(privateInputRoot, 'cli-operation-plan-response.json');
    fs.writeFileSync(cliPlanResponsePath, JSON.stringify({
      structuredContent: {
        result: {
          results: [{
            __soterType: 'meeting',
            __soterId: 'https://app.notion.com/cli-plan-meeting',
            __soterFields: JSON.stringify({
              title: 'CLI plan meeting',
              meetingType: 'Project Sync',
              recordingUri: 'https://otter.ai/u/cli-plan-meeting',
              organizationUris: '[]',
              participantIds: '[]'
            })
          }],
          has_more: false
        }
      },
      privateMarker: cliPlanMarker
    }, null, 2) + '\n', { mode: 0o600 });
    const cliCompletedPlan = runCli(root, [
      'plan-complete',
      '--checkpoint', cliPlan.checkpoint.id,
      '--call', cliPlan.currentCall.id,
      '--response', cliPlanResponsePath,
      '--at', '2026-07-15T12:00:08.000Z'
    ]);
    if (cliPlan.checkpoint.state !== 'requested'
      || cliCompletedPlan.checkpoint.state !== 'completed'
      || cliCompletedPlan.currentCall !== null
      || JSON.stringify(cliCompletedPlan).includes(cliPlanMarker)) {
      throw new Error('CLI operation-plan projection drifted from the durable Core service.');
    }

    const connectedContextRunPath = 'soter/fixtures/meeting-intake/mcp-connected-context.run.json';
    const connectedContextRun = JSON.parse(fs.readFileSync(path.join(root, runPath), 'utf8'));
    const connectedContextLock = JSON.parse(fs.readFileSync(path.join(root, lockPath), 'utf8'));
    const contextPolicyBindings = applicablePolicySources(connectedContextLock);
    connectedContextRun.id = 'run.meeting-intake.mcp-connected-context';
    fs.writeFileSync(
      path.join(root, connectedContextRunPath),
      JSON.stringify(connectedContextRun, null, 2) + '\n'
    );
    const connectedRecording = 'https://otter.ai/u/mcp-context-selftest';
    const preparedContext = await call(client, 'soter_prepare_meeting_intake_context', {
      lock_path: lockPath,
      run_path: connectedContextRunPath,
      snapshot_id: 'context.meeting-intake.connected.mcp-selftest',
      meeting_id: 'meeting.mcp-context-selftest',
      recording_uri: connectedRecording,
      at: '2026-07-15T12:00:09.000Z'
    });
    if (preparedContext.checkpoint?.$contract
        !== 'soter://contracts/operation-plan-checkpoint/v2'
      || preparedContext.checkpoint?.currentStepId !== 'step.context-definition-index'
      || preparedContext.currentCall?.transport?.tool
        !== 'mcp__codex_apps__notion_notion_query_data_sources') {
      throw new Error('MCP connected context did not emit its exact first source call.');
    }
    await expectToolError(client, 'soter_finalize_meeting_intake_context', {
      checkpoint_id: preparedContext.checkpoint.id
    }, 'completed operation plan');
    const contextMarkers = [
      'private-mcp-context-policy-index-marker',
      ...contextPolicyBindings.map((_, index) => 'private-mcp-context-policy-body-' + index),
      'private-mcp-context-transcript-marker',
      'private-mcp-context-meeting-marker',
      'private-mcp-context-organization-marker',
      'private-mcp-context-project-marker',
      'private-mcp-context-task-marker'
    ];
    const mcpOrganizationUri = 'https://app.notion.com/mcp-context-organization';
    const mcpProjectUri = 'https://app.notion.com/mcp-context-project';
    const mcpTaskUri = 'https://app.notion.com/mcp-context-task';
    let contextExecution = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: preparedContext.checkpoint.id,
      call_id: preparedContext.currentCall.id,
      response: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            results: contextPolicyBindings.map((binding) => ({
              __soterType: 'policy',
              __soterId: binding.documentUri,
              __soterFields: JSON.stringify({ name: binding.title })
            })),
            has_more: false
          })
        }],
        privateMarker: contextMarkers[0]
      },
      at: '2026-07-15T12:00:10.000Z'
    });
    await client.close();
    client = await connectClient(root);
    contextExecution = await call(client, 'soter_get_host_call', {
      checkpoint_id: preparedContext.checkpoint.id
    });
    if (contextExecution.checkpoint?.currentStepId
        !== 'step.context-policy.' + contextPolicyBindings[0].id.slice('policy.'.length)
      || contextExecution.currentCall?.capability?.id !== 'documents.content.read'
      || contextExecution.currentCall?.transport?.tool !== 'mcp__codex_apps__notion_fetch') {
      throw new Error('MCP connected context did not recover its exact first policy-body source.');
    }
    for (const [index, binding] of contextPolicyBindings.entries()) {
      if (contextExecution.checkpoint?.currentStepId
          !== 'step.context-policy.' + binding.id.slice('policy.'.length)
        || contextExecution.currentCall?.arguments?.id
          !== binding.documentUri.slice(-32).toLowerCase()) {
        throw new Error('MCP connected context policy-body call drifted for ' + binding.id + '.');
      }
      contextExecution = await call(client, 'soter_complete_operation_plan', {
        checkpoint_id: preparedContext.checkpoint.id,
        call_id: contextExecution.currentCall.id,
        response: notionPageResponse({
          uri: binding.documentUri,
          title: binding.title,
          body: '# ' + binding.title + '\n\nSynthetic applicable MCP policy body ' + index + '.',
          marker: contextMarkers[index + 1]
        }),
        at: '2026-07-15T12:00:10.' + String(index + 1).padStart(3, '0') + 'Z'
      });
    }
    if (contextExecution.checkpoint?.currentStepId !== 'step.context-transcript'
      || contextExecution.currentCall?.transport?.tool !== 'mcp__otter__fetch') {
      throw new Error('MCP connected context did not advance to its exact transcript source.');
    }
    const contextMeeting = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: preparedContext.checkpoint.id,
      call_id: contextExecution.currentCall.id,
      response: {
        structuredContent: {
          result: {
            speakers: [{ id: 'speaker.retro', displayName: 'Retro' }],
            segments: [{
              speakerId: 'speaker.retro',
              text: 'Ground this connected context before any write.',
              startSeconds: 3
            }]
          }
        },
        privateMarker: contextMarkers[contextPolicyBindings.length + 1]
      },
      at: '2026-07-15T12:00:11.000Z'
    });
    if (contextMeeting.checkpoint?.currentStepId !== 'step.context-meeting-record'
      || contextMeeting.currentCall?.arguments?.data?.params?.[0] !== connectedRecording) {
      throw new Error('MCP connected context did not bind the matching meeting filter.');
    }
    const contextOrganization = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: preparedContext.checkpoint.id,
      call_id: contextMeeting.currentCall.id,
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'meeting',
              __soterId: 'https://app.notion.com/mcp-context-meeting',
              __soterFields: JSON.stringify({
                title: 'MCP connected context',
                meetingType: 'Project Sync',
                recordingUri: connectedRecording,
                organizationUris: JSON.stringify([mcpOrganizationUri]),
                participantIds: JSON.stringify(['provider-person.retro'])
              })
            }],
            has_more: false
          }
        },
        privateMarker: contextMarkers[contextPolicyBindings.length + 2]
      },
      at: '2026-07-15T12:00:12.000Z'
    });
    await client.close();
    client = await connectClient(root);
    const recoveredOrganization = await call(client, 'soter_get_host_call', {
      checkpoint_id: preparedContext.checkpoint.id
    });
    if (recoveredOrganization.checkpoint?.currentStepId !== 'step.context-organizations'
      || recoveredOrganization.currentCall?.id !== contextOrganization.currentCall.id
      || recoveredOrganization.currentCall?.arguments?.data?.params?.[0]
        !== mcpOrganizationUri
      || recoveredOrganization.checkpoint.steps.find((step) => {
        return step.id === 'step.context-organizations';
      })?.bindingResolutions[0]?.sourceOutputFingerprint
        !== recoveredOrganization.checkpoint.steps.find((step) => {
          return step.id === 'step.context-meeting-record';
        })?.outputFingerprint) {
      throw new Error('MCP connected context did not recover its exact bound organization read.');
    }
    const contextProject = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: preparedContext.checkpoint.id,
      call_id: recoveredOrganization.currentCall.id,
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'organization',
              __soterId: mcpOrganizationUri,
              __soterFields: JSON.stringify({
                name: 'MCP bound organization',
                organizationType: 'Client',
                tags: '[]',
                projectUris: JSON.stringify([mcpProjectUri]),
                contactUris: '[]'
              })
            }],
            has_more: false
          }
        },
        privateMarker: contextMarkers[contextPolicyBindings.length + 3]
      },
      at: '2026-07-15T12:00:13.000Z'
    });
    const contextTask = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: preparedContext.checkpoint.id,
      call_id: contextProject.currentCall.id,
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'project',
              __soterId: mcpProjectUri,
              __soterFields: JSON.stringify({
                name: 'MCP bound project',
                projectType: 'Client Project',
                status: 'Active',
                organizationUris: JSON.stringify([mcpOrganizationUri]),
                taskUris: JSON.stringify([mcpTaskUri])
              })
            }],
            has_more: false
          }
        },
        privateMarker: contextMarkers[contextPolicyBindings.length + 4]
      },
      at: '2026-07-15T12:00:14.000Z'
    });
    const contextCompleted = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: preparedContext.checkpoint.id,
      call_id: contextTask.currentCall.id,
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'task',
              __soterId: mcpTaskUri,
              __soterFields: JSON.stringify({
                title: 'MCP bound task',
                status: 'Open',
                context: 'Bound from the selected project only.',
                projectUris: JSON.stringify([mcpProjectUri])
              })
            }],
            has_more: false
          }
        },
        privateMarker: contextMarkers[contextPolicyBindings.length + 5]
      },
      at: '2026-07-15T12:00:15.000Z'
    });
    const finalizedContext = await call(client, 'soter_finalize_meeting_intake_context', {
      checkpoint_id: preparedContext.checkpoint.id
    });
    const cliFinalizedContext = runCli(root, [
      'context-connected-finalize',
      '--checkpoint', preparedContext.checkpoint.id
    ]);
    assertPrivateFile(path.join(root, finalizedContext.snapshotPath));
    const contextDurableContents = [
      finalizedContext.snapshotPath,
      finalizedContext.checkpointPath,
      finalizedContext.runPath
    ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    if (contextCompleted.checkpoint?.state !== 'completed'
      || contextCompleted.checkpoint?.result?.stepResults?.length !== 9
      || contextProject.checkpoint?.currentStepId !== 'step.context-projects'
      || contextProject.currentCall?.arguments?.data?.params?.[0] !== mcpProjectUri
      || contextTask.checkpoint?.currentStepId !== 'step.context-tasks'
      || contextTask.currentCall?.arguments?.data?.params?.[0] !== mcpTaskUri
      || finalizedContext.snapshot?.containment !== 'connected'
      || finalizedContext.snapshot?.entries?.length !== 9
      || finalizedContext.snapshot?.entries?.filter((entry) => {
        return entry.applicability?.state === 'applicable';
      }).length !== contextPolicyBindings.length
      || finalizedContext.snapshot?.entries?.filter((entry) => {
        return entry.applicability?.state === 'applicable';
      }).some((entry) => !contextPolicyBindings.some((binding) => {
        return binding.sourceId === entry.applicability.sourceId;
      }))
      || finalizedContext.run?.context
        ?.find((entry) => entry.authority === 'authority.crm.definition')?.status !== 'loaded'
      || finalizedContext.run?.lifecycleState !== 'paused'
      || cliFinalizedContext.snapshotPath !== finalizedContext.snapshotPath
      || contextMarkers.some((marker) => contextDurableContents.includes(marker))) {
      throw new Error(
        'MCP and CLI connected-context projections drifted or persisted a raw response: '
          + JSON.stringify({
            checkpointState: contextCompleted.checkpoint?.state,
            stepResults: contextCompleted.checkpoint?.result?.stepResults?.length,
            projectStep: contextProject.checkpoint?.currentStepId,
            projectId: contextProject.currentCall?.arguments?.data?.params?.[0],
            taskStep: contextTask.checkpoint?.currentStepId,
            taskId: contextTask.currentCall?.arguments?.data?.params?.[0],
            containment: finalizedContext.snapshot?.containment,
            entries: finalizedContext.snapshot?.entries?.length,
            applicableEntries: finalizedContext.snapshot?.entries?.filter((entry) => {
              return entry.applicability?.state === 'applicable';
            }).length,
            definitionAuthority: finalizedContext.run?.context
              ?.find((entry) => entry.authority === 'authority.crm.definition'),
            lifecycleState: finalizedContext.run?.lifecycleState,
            cliSnapshotPath: cliFinalizedContext.snapshotPath,
            mcpSnapshotPath: finalizedContext.snapshotPath,
            persistedMarkers: contextMarkers.filter((marker) => contextDurableContents.includes(marker))
          })
      );
    }
    const emailLockPath = 'private/mcp-email-triage.lock.json';
    const emailRunPath = 'private/mcp-email-triage.run.json';
    runCli(root, [
      'resolve',
      '--config', 'soter/configurations/email-triage.config.json',
      '--host', 'codex',
      '--output', emailLockPath
    ]);
    runCli(root, [
      'prepare',
      '--lock', emailLockPath,
      '--automation', 'automation.email-triage',
      '--run-id', 'run.email-triage.mcp-connected-acquisition',
      '--outcome', 'Acquire one bounded private Email transport snapshot without judgment.',
      '--output', emailRunPath,
      '--at', '2026-07-15T12:00:16.000Z'
    ]);
    const emailQuery = 'in:inbox newer_than:1d MCP_PRIVATE_EMAIL_QUERY_SENTINEL';
    const preparedEmailContext = await call(client, 'soter_prepare_email_triage_context', {
      lock_path: emailLockPath,
      run_path: emailRunPath,
      snapshot_id: 'context.email-triage.connected-acquisition.mcp-selftest',
      query: emailQuery,
      at: '2026-07-15T12:00:17.000Z'
    });
    if (preparedEmailContext.checkpoint?.$contract
        !== 'soter://contracts/operation-plan-checkpoint/v2'
      || preparedEmailContext.checkpoint?.currentStepId !== 'step.mail-message-search'
      || preparedEmailContext.currentCall?.transport?.tool
        !== 'mcp__codex_apps__gmail_search_email_ids'
      || preparedEmailContext.currentCall?.arguments?.query !== emailQuery) {
      throw new Error('MCP Email acquisition did not emit its exact private search call.');
    }
    await expectToolError(client, 'soter_finalize_email_triage_context', {
      checkpoint_id: preparedEmailContext.checkpoint.id
    }, 'completed operation plan');
    const emailSearchMarker = 'MCP_RAW_EMAIL_SEARCH_RESPONSE_SENTINEL';
    const emailThreadMarker = 'MCP_RAW_EMAIL_THREAD_RESPONSE_SENTINEL';
    const emailThreadExecution = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: preparedEmailContext.checkpoint.id,
      call_id: preparedEmailContext.currentCall.id,
      response: {
        structuredContent: {
          result: {
            message_ids: ['gmail-mcp-message-001'],
            next_page_token: null,
            rawProviderResponse: emailSearchMarker
          }
        }
      },
      at: '2026-07-15T12:00:18.000Z'
    });
    if (emailThreadExecution.checkpoint?.currentStepId !== 'step.mail-thread-expansion'
      || emailThreadExecution.currentCall?.transport?.tool
        !== 'mcp__codex_apps__gmail_batch_read_email_threads'
      || JSON.stringify(emailThreadExecution).includes(emailSearchMarker)) {
      throw new Error('MCP Email acquisition did not bind and minimize its exact search result.');
    }
    const completedEmailContext = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: preparedEmailContext.checkpoint.id,
      call_id: emailThreadExecution.currentCall.id,
      response: {
        structuredContent: {
          result: {
            threads: [{
              id: 'gmail-mcp-thread-001',
              messages: [{
                id: 'gmail-mcp-message-001',
                rfc822_message_id: '<gmail-mcp-message-001@example.test>',
                from: 'sender@example.test',
                to: ['operator@example.test'],
                sent_at: '2026-07-15T12:00:00.000Z',
                labels: ['INBOX'],
                subject: 'MCP private Email subject',
                body: 'MCP private Email body; data only.',
                rawProviderResponse: emailThreadMarker
              }]
            }],
            rawProviderResponse: emailThreadMarker
          }
        }
      },
      at: '2026-07-15T12:00:19.000Z'
    });
    const finalizedEmailContext = await call(client, 'soter_finalize_email_triage_context', {
      checkpoint_id: preparedEmailContext.checkpoint.id
    });
    const cliFinalizedEmailContext = runCli(root, [
      'email-context-connected-finalize',
      '--checkpoint', preparedEmailContext.checkpoint.id
    ]);
    const emailDurableContents = [
      finalizedEmailContext.snapshotPath,
      finalizedEmailContext.checkpointPath,
      finalizedEmailContext.runPath
    ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    if (completedEmailContext.checkpoint?.state !== 'completed'
      || completedEmailContext.checkpoint?.result?.stepResults?.length !== 2
      || finalizedEmailContext.snapshot?.containment !== 'connected'
      || finalizedEmailContext.snapshot?.entries?.length !== 2
      || finalizedEmailContext.run?.lifecycleState !== 'paused'
      || finalizedEmailContext.run?.approvals?.length !== 0
      || cliFinalizedEmailContext.snapshotPath !== finalizedEmailContext.snapshotPath
      || emailDurableContents.includes(emailSearchMarker)
      || emailDurableContents.includes(emailThreadMarker)
      || JSON.stringify(finalizedEmailContext).includes('continuationRequest')) {
      throw new Error('MCP Email acquisition drifted, leaked raw responses, or granted authority.');
    }
    const inspectedEmailDecision = await call(client, 'soter_inspect_email_triage_decision', {
      lock_path: emailLockPath,
      snapshot_id: finalizedEmailContext.snapshot.id
    });
    const cliInspectedEmailDecision = runCli(root, [
      'email-triage-decision-inspect',
      '--lock', emailLockPath,
      '--snapshot', finalizedEmailContext.snapshot.id
    ]);
    const emailDecisionInput = structuredClone(inspectedEmailDecision.inputTemplate);
    const emailCandidate = inspectedEmailDecision.reduction.candidates[0];
    emailDecisionInput.state = 'ready';
    emailDecisionInput.candidates[0] = {
      candidateId: emailCandidate.id,
      group: 'needs-you',
      attention: 'operator',
      suspectedInjection: false,
      providerImportantIgnored: true,
      summary: 'MCP_PRIVATE_EMAIL_DECISION_SUMMARY_SENTINEL',
      reason: 'The exact bounded message requests operator attention and a separately reviewed reply.',
      replyDisposition: 'draft-review',
      handoffIntent: 'none',
      evidence: [{
        messageId: emailCandidate.newestMessageId,
        field: 'body',
        quote: 'MCP private Email body'
      }]
    };
    emailDecisionInput.issues = [];
    emailDecisionInput.limitations = [
      'This MCP selftest records private grounded classification only and grants no action authority.'
    ];
    const ungroundedEmailDecision = structuredClone(emailDecisionInput);
    ungroundedEmailDecision.candidates[0].evidence[0].quote = 'MCP_UNBOUNDED_EMAIL_QUOTE';
    await expectToolError(client, 'soter_commit_email_triage_decision', {
      lock_path: emailLockPath,
      snapshot_id: finalizedEmailContext.snapshot.id,
      decision_id: 'decision.email-triage.mcp-ungrounded',
      decision: ungroundedEmailDecision,
      at: '2026-07-15T12:00:20.000Z'
    }, 'not an exact substring');
    const committedEmailDecision = await call(client, 'soter_commit_email_triage_decision', {
      lock_path: emailLockPath,
      snapshot_id: finalizedEmailContext.snapshot.id,
      decision_id: 'decision.email-triage.mcp-selftest',
      decision: emailDecisionInput,
      at: '2026-07-15T12:00:20.000Z'
    });
    const replayedEmailDecision = await call(client, 'soter_commit_email_triage_decision', {
      lock_path: emailLockPath,
      snapshot_id: finalizedEmailContext.snapshot.id,
      decision_id: 'decision.email-triage.mcp-selftest',
      decision: emailDecisionInput,
      at: '2026-07-15T12:00:21.000Z'
    });
    assertPrivateFile(path.join(root, committedEmailDecision.decisionPath));
    if (inspectedEmailDecision.reduction?.observedThreadCount !== 1
      || inspectedEmailDecision.reduction?.includedCount !== 1
      || inspectedEmailDecision.inputTemplate?.state !== 'needs-input'
      || cliInspectedEmailDecision.reduction?.candidates?.[0]?.id !== emailCandidate.id
      || committedEmailDecision.decision?.state !== 'ready'
      || committedEmailDecision.decision?.producer?.host !== 'codex'
      || replayedEmailDecision.decision?.decisionFingerprint
        !== committedEmailDecision.decision?.decisionFingerprint
      || committedEmailDecision.run?.lifecycleState !== 'paused'
      || committedEmailDecision.run?.approvals?.length !== 0
      || JSON.stringify(committedEmailDecision.decision).includes('continuationRequest')
      || JSON.stringify(committedEmailDecision.decision).includes('proposedChanges')
      || JSON.stringify(committedEmailDecision.decision).includes('mail.drafts.create')) {
      throw new Error('MCP Email decision workspace drifted or granted action authority.');
    }
    const inspectedEmailProposal = await call(client, 'soter_inspect_email_triage_proposal', {
      lock_path: emailLockPath,
      decision_id: committedEmailDecision.decision.id
    });
    const cliInspectedEmailProposal = runCli(root, [
      'email-triage-proposal-inspect',
      '--lock', emailLockPath,
      '--decision', committedEmailDecision.decision.id
    ]);
    const emailProposalInput = structuredClone(inspectedEmailProposal.inputTemplate);
    emailProposalInput.candidates[0].draftBody = 'MCP_PRIVATE_EMAIL_DRAFT_SENTINEL';
    emailProposalInput.digestBody = 'MCP_PRIVATE_EMAIL_DIGEST_SENTINEL';
    const missingEmailDraft = structuredClone(emailProposalInput);
    missingEmailDraft.candidates[0].draftBody = null;
    await expectToolError(client, 'soter_commit_email_triage_proposal', {
      lock_path: emailLockPath,
      decision_id: committedEmailDecision.decision.id,
      proposal_id: 'proposal.email-triage.mcp-missing-draft',
      proposal: missingEmailDraft,
      at: '2026-07-15T12:00:22.000Z'
    }, 'do not match the exact decision reply and handoff dispositions');
    const committedEmailProposal = await call(client, 'soter_commit_email_triage_proposal', {
      lock_path: emailLockPath,
      decision_id: committedEmailDecision.decision.id,
      proposal_id: 'proposal.email-triage.mcp-selftest',
      proposal: emailProposalInput,
      at: '2026-07-15T12:00:22.000Z'
    });
    const replayedEmailProposal = await call(client, 'soter_commit_email_triage_proposal', {
      lock_path: emailLockPath,
      decision_id: committedEmailDecision.decision.id,
      proposal_id: 'proposal.email-triage.mcp-selftest',
      proposal: emailProposalInput,
      at: '2026-07-15T12:00:23.000Z'
    });
    const inspectedEmailProposalMaterial = await call(
      client,
      'soter_inspect_email_triage_proposal_material',
      { lock_path: emailLockPath, proposal_id: committedEmailProposal.proposal.id }
    );
    const cliInspectedEmailProposalMaterial = runCli(root, [
      'email-triage-proposal-material',
      '--lock', emailLockPath,
      '--proposal', committedEmailProposal.proposal.id
    ]);
    assertPrivateFile(path.join(root, committedEmailProposal.proposalPath));
    assertPrivateFile(path.join(root, committedEmailProposal.materialPath));
    if (inspectedEmailProposal.authority?.state !== 'none'
      || inspectedEmailProposal.inputTemplate?.candidates?.length !== 1
      || cliInspectedEmailProposal.inputTemplate?.candidates?.[0]?.candidateId
        !== emailCandidate.id
      || committedEmailProposal.proposal?.state !== 'ready-for-review'
      || committedEmailProposal.proposal?.authority?.state !== 'none'
      || committedEmailProposal.run?.lifecycleState !== 'paused'
      || committedEmailProposal.run?.approvals?.length !== 0
      || replayedEmailProposal.proposal?.proposalFingerprint
        !== committedEmailProposal.proposal?.proposalFingerprint
      || JSON.stringify(committedEmailProposal).includes('MCP_PRIVATE_EMAIL_DRAFT_SENTINEL')
      || JSON.stringify(committedEmailProposal).includes('MCP_PRIVATE_EMAIL_DIGEST_SENTINEL')
      || !JSON.stringify(inspectedEmailProposalMaterial)
        .includes('MCP_PRIVATE_EMAIL_DRAFT_SENTINEL')
      || !JSON.stringify(inspectedEmailProposalMaterial)
        .includes('MCP_PRIVATE_EMAIL_DIGEST_SENTINEL')
      || cliInspectedEmailProposalMaterial.fingerprint
        !== inspectedEmailProposalMaterial.fingerprint
      || JSON.stringify(committedEmailProposal).includes('continuationRequest')) {
      throw new Error('MCP Email review proposal drifted, leaked private values, or granted authority.');
    }
    const inspectedDecisionContext = await call(
      client,
      'soter_inspect_meeting_intake_decision',
      {
        lock_path: lockPath,
        snapshot_id: finalizedContext.snapshot.id
      }
    );
    const connectedDecisionInput = structuredClone(inspectedDecisionContext.inputTemplate);
    connectedDecisionInput.state = 'ready';
    connectedDecisionInput.summarySegmentIndexes = [0];
    connectedDecisionInput.tasks[0] = {
      recordId: mcpTaskUri,
      disposition: 'fold',
      reason: 'The cited transcript segment grounds the exact bounded MCP task candidate.',
      segmentIndexes: [0]
    };
    connectedDecisionInput.policies = contextPolicyBindings.map((binding, index) => ({
      contextEntryId: 'context.crm.' + binding.id,
      outcome: 'allow',
      reason: 'The exact cited synthetic policy excerpt permits this contained selftest proposal.',
      citations: ['Synthetic applicable MCP policy body ' + index + '.']
    }));
    connectedDecisionInput.issues = [];
    connectedDecisionInput.limitations = [
      'This synthetic host decision proves contract binding only and does not establish live provider judgment quality.'
    ];
    const invalidConnectedDecision = structuredClone(connectedDecisionInput);
    invalidConnectedDecision.tasks[0].recordId = 'https://app.notion.com/unbounded-task';
    await expectToolError(client, 'soter_commit_meeting_intake_decision', {
      lock_path: lockPath,
      snapshot_id: finalizedContext.snapshot.id,
      decision_id: 'decision.meeting-intake.mcp-invalid',
      decision: invalidConnectedDecision,
      at: '2026-07-15T12:00:16.000Z'
    }, 'every and only bounded task candidate');
    const committedDecision = await call(client, 'soter_commit_meeting_intake_decision', {
      lock_path: lockPath,
      snapshot_id: finalizedContext.snapshot.id,
      decision_id: 'decision.meeting-intake.mcp-selftest',
      decision: connectedDecisionInput,
      at: '2026-07-15T12:00:16.000Z'
    });
    const replayedDecision = await call(client, 'soter_commit_meeting_intake_decision', {
      lock_path: lockPath,
      snapshot_id: finalizedContext.snapshot.id,
      decision_id: 'decision.meeting-intake.mcp-selftest',
      decision: connectedDecisionInput,
      at: '2026-07-15T12:00:18.000Z'
    });
    const projectedChangeSet = await call(client, 'soter_propose_meeting_intake_change_set', {
      lock_path: lockPath,
      decision_id: committedDecision.decision.id,
      change_set_id: 'changeset.meeting-intake.mcp-decision-selftest',
      at: '2026-07-15T12:00:17.000Z'
    });
    assertPrivateFile(path.join(root, committedDecision.decisionPath));
    if (inspectedDecisionContext.counts.taskCandidates !== 1
      || inspectedDecisionContext.counts.applicablePolicies !== contextPolicyBindings.length
      || inspectedDecisionContext.inputTemplate.state !== 'needs-input'
      || committedDecision.decision.state !== 'ready'
      || committedDecision.decision.producer.host !== 'codex'
      || replayedDecision.decision.decisionFingerprint
        !== committedDecision.decision.decisionFingerprint
      || committedDecision.run.lifecycleState !== 'paused'
      || !committedDecision.run.outputs.some((item) => {
        return item.id === committedDecision.decision.id
          && item.fingerprint === committedDecision.decision.decisionFingerprint;
      })
      || projectedChangeSet.basis?.id !== committedDecision.decision.id
      || projectedChangeSet.basis?.fingerprint
        !== committedDecision.decision.decisionFingerprint
      || projectedChangeSet.operations?.length !== 2
      || projectedChangeSet.operations?.[0]?.input?.id !== mcpTaskUri) {
      throw new Error('MCP grounded decision or read-only change-set projection drifted.');
    }
    const cliContextRunPath = 'soter/fixtures/meeting-intake/cli-connected-context.run.json';
    const cliContextRun = JSON.parse(fs.readFileSync(path.join(root, runPath), 'utf8'));
    cliContextRun.id = 'run.meeting-intake.cli-connected-context';
    fs.writeFileSync(
      path.join(root, cliContextRunPath),
      JSON.stringify(cliContextRun, null, 2) + '\n'
    );
    const cliPreparedContext = runCli(root, [
      'context-connected-prepare',
      '--lock', lockPath,
      '--run', cliContextRunPath,
      '--snapshot-id', 'context.meeting-intake.connected.cli-selftest',
      '--meeting-id', 'meeting.cli-context-selftest',
      '--recording-uri', 'https://otter.ai/u/cli-context-selftest',
      '--at', '2026-07-15T12:00:13.000Z'
    ]);
    const cliClosedContext = runCli(root, [
      'host-fail',
      '--checkpoint', cliPreparedContext.checkpoint.id,
      '--call', cliPreparedContext.currentCall.id,
      '--kind', 'unavailable',
      '--message', 'Synthetic CLI context source was intentionally not dispatched.',
      '--at', '2026-07-15T12:00:14.000Z'
    ]);
    if (cliPreparedContext.checkpoint.currentStepId !== 'step.context-definition-index'
      || cliPreparedContext.currentCall.transport.tool
        !== 'mcp__codex_apps__notion_notion_query_data_sources'
      || cliClosedContext.checkpoint.state !== 'failed') {
      throw new Error('CLI connected-context preparation drifted from the shared Core service.');
    }

    await assertWrongHostRejected(root);
    await assertClaudeHostProjection(root);

    const cliProbe = runCli(root, [
      'probe-prepare',
      '--lock', lockPath,
      '--provider', 'provider.integration.otter.mcp',
      '--call-id', 'probecall.cli-selftest.otter',
      '--probe-id', 'probe.cli-selftest.otter',
      '--at', fixtureTime
    ]);
    const cliIdentity = 'private-cli-identity-marker';
    const rejectedRepoResponse = invokeCli(root, [
      'probe-complete',
      '--checkpoint', cliProbe.checkpoint.id,
      '--response', path.join(root, 'soter/fixtures/meeting-intake/offline.doctor.json'),
      '--at', fixtureTime
    ]);
    if (rejectedRepoResponse.status === 0
      || !rejectedRepoResponse.stderr.includes('must remain outside the repository')) {
      throw new Error('CLI accepted a native provider response path inside the repository.');
    }
    const cliResponsePath = path.join(privateInputRoot, 'cli-probe-response.json');
    fs.writeFileSync(
      cliResponsePath,
      JSON.stringify({ structuredContent: { result: cliIdentity } }, null, 2) + '\n',
      { mode: 0o600 }
    );
    const cliCompleted = runCli(root, [
      'probe-complete',
      '--checkpoint', cliProbe.checkpoint.id,
      '--response', cliResponsePath,
      '--at', fixtureTime
    ]);
    if (cliCompleted.checkpoint.state !== 'completed'
      || JSON.stringify(cliCompleted).includes(cliIdentity)) {
      throw new Error('CLI projection drifted from durable Core probe completion.');
    }
    const doctorInvocation = invokeCli(root, [
      'doctor',
      '--lock', lockPath,
      '--level', 'connected',
      '--probe-checkpoint', cliCompleted.checkpoint.id,
      '--probe-checkpoint', recoveredNotionProbe.checkpoint.id,
      '--at', fixtureTime
    ]);
    const doctor = JSON.parse(doctorInvocation.stdout);
    if (doctorInvocation.status !== 1
      || doctor.states.valid !== 'passed'
      || doctor.states.ready !== 'unknown'
      || !doctor.providerProbeIds.includes('probe.cli-selftest.otter')
      || !doctor.providerProbeIds.includes('probe.mcp-selftest.notion-plan')
      || doctor.diagnostics.some((item) => {
        return item.code === 'SOTER_PROVIDER_PROBE_MISSING'
          && (item.subject === 'provider.integration.otter.mcp'
            || item.subject === 'provider.integration.notion.mcp');
      })) {
      throw new Error('Connected doctor did not consume the durable provider probe checkpoint.');
    }

    const failedDoctorInvocation = invokeCli(root, [
      'doctor',
      '--lock', lockPath,
      '--level', 'connected',
      '--probe-checkpoint', failedProbe.checkpoint.id,
      '--probe-checkpoint', recoveredNotionProbe.checkpoint.id,
      '--at', fixtureTime
    ]);
    const failedDoctor = JSON.parse(failedDoctorInvocation.stdout);
    const failedAttemptDiagnostic = failedDoctor.diagnostics.find((item) => {
      return item.code === 'SOTER_PROVIDER_PROBE_AUTHENTICATION'
        && item.subject === 'provider.integration.otter.mcp';
    });
    if (failedDoctorInvocation.status !== 1
      || failedDoctor.states.ready !== 'failed'
      || !failedAttemptDiagnostic
      || failedDoctor.diagnostics.some((item) => {
        return item.code === 'SOTER_PROVIDER_PROBE_MISSING'
          && item.subject === 'provider.integration.otter.mcp';
      })
      || JSON.stringify(failedDoctor).includes(
        'The host could not authenticate the provider request.'
      )) {
      throw new Error(
        'Connected doctor did not distinguish a secret-safe exact failed probe attempt from a missing probe.'
      );
    }

    const corruptFile = checkpointFile(root, completed);
    const corrupt = JSON.parse(fs.readFileSync(corruptFile, 'utf8'));
    corrupt.call.arguments.id = 'tampered-provider-id';
    fs.writeFileSync(corruptFile, JSON.stringify(corrupt, null, 2) + '\n');
    await expectToolError(client, 'soter_get_host_call', {
      checkpoint_id: completed.checkpoint.id
    }, 'fingerprint does not match');
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(privateInputRoot, { recursive: true, force: true });
  }
}

const fixtureRoot = createFixtureRoot();
selftest(fixtureRoot)
  .then(() => {
    process.stdout.write('Soter MCP selftest: passed.\n');
  })
  .catch((error) => {
    process.stderr.write('Soter MCP selftest: ' + error.message + '\n');
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
