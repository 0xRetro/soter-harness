#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  fingerprintJson,
  fingerprintPath,
  readJson,
  resolveRepoPath
} from '../lib/canonical-json.mjs';
import {
  normalizeProjectionPath,
  renderHostProjectionCandidates
} from '../host-projections.mjs';
import { materializeContainedPrivateConfiguration } from '../contained-private-configurations.mjs';
import { inspectWorkspace } from '../inspection.mjs';
import {
  privateConfigurationStatePath,
  writePrivateConfigurationState
} from '../private-configurations.mjs';
import { resolveConfiguration } from '../resolve.mjs';
import { prepareRunEnvelope } from '../run.mjs';
import {
  failDurableHostExecution,
  prepareDurableCapabilityExecution,
  prepareDurableOperationPlanExecution
} from '../service.mjs';
import {
  activeConfigurationLockStatePath,
  runStatePath,
  writeActiveConfigurationLockState,
  writeRunState
} from '../runtime-state.mjs';

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let lockPath;
let runPath;
let taskPolicyId;
const fixtureTime = '2026-07-15T12:00:00.000Z';
const PRIVATE_TASK_STATUS_OPTION = 'PRIVATE_PROVIDER_TASK_STATUS_MCP_SENTINEL';
const PRIVATE_TASK_CONTEXT_OPTION = 'PRIVATE_PROVIDER_TASK_CONTEXT_MCP_SENTINEL';
const PRIVATE_PROJECT_TYPE_OPTION = 'PRIVATE_PROVIDER_PROJECT_TYPE_MCP_SENTINEL';
const PRIVATE_PROJECT_STATUS_OPTION = 'PRIVATE_PROVIDER_PROJECT_STATUS_MCP_SENTINEL';

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function optionMapping(mapping, recordType, field, portable, provider) {
  return {
    mapping,
    recordType,
    field,
    mode: 'exact-bijection',
    entries: [{ portable, provider }]
  };
}

function taskNotionOptionMappings() {
  return [
    optionMapping(
      'mapping.integration.notion.tasks-records',
      'task',
      'status',
      'To Do',
      PRIVATE_TASK_STATUS_OPTION
    ),
    optionMapping(
      'mapping.integration.notion.tasks-records',
      'task',
      'context',
      'Project',
      PRIVATE_TASK_CONTEXT_OPTION
    ),
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'projectType',
      'Internal Project',
      PRIVATE_PROJECT_TYPE_OPTION
    ),
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'status',
      'Active',
      PRIVATE_PROJECT_STATUS_OPTION
    )
  ];
}

function meetingNotionOptionMappings() {
  return [
    optionMapping(
      'mapping.integration.notion.crm-records',
      'organization',
      'organizationType',
      'Client',
      'Client'
    ),
    optionMapping(
      'mapping.integration.notion.crm-records',
      'organization',
      'tags',
      'Important',
      'Important'
    ),
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'projectType',
      'Client Project',
      'Client Project'
    ),
    optionMapping(
      'mapping.integration.notion.projects-records',
      'project',
      'status',
      'Active',
      'Active'
    ),
    optionMapping(
      'mapping.integration.notion.tasks-records',
      'task',
      'status',
      'Open',
      'Open'
    ),
    optionMapping(
      'mapping.integration.notion.tasks-records',
      'task',
      'context',
      'Bound from the selected project only.',
      'Bound from the selected project only.'
    ),
    optionMapping(
      'mapping.integration.notion.meetings-records',
      'meeting',
      'meetingType',
      'Project Sync',
      'Project Sync'
    ),
    optionMapping(
      'mapping.integration.notion.meetings-records',
      'meeting-summary',
      'documentType',
      'Meeting Summary',
      'Meeting Summary'
    )
  ];
}

function privateStateTreeFingerprint(root) {
  const entries = [];
  const visit = (current, relativePath) => {
    const stat = fs.lstatSync(current);
    const common = {
      path: relativePath || '.',
      mode: stat.mode & 0o7777,
      nlink: stat.nlink
    };
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      entries.push({ ...common, type: 'directory' });
      for (const entry of fs.readdirSync(current).sort(compareText)) {
        visit(
          path.join(current, entry),
          relativePath ? relativePath + '/' + entry : entry
        );
      }
      return;
    }
    if (stat.isFile() && !stat.isSymbolicLink()) {
      entries.push({
        ...common,
        type: 'file',
        contentFingerprint: fingerprintPath(current)
      });
      return;
    }
    throw new Error(
      'Private MCP selftest state contains an unsupported filesystem entry: '
        + (relativePath || '.')
    );
  };
  visit(root, '');
  return fingerprintJson({ entries });
}

function projectionRows(outputs) {
  return outputs.map((output) => ({
    id: output.id,
    path: output.path,
    role: output.role,
    mode: output.mode,
    templatePath: output.templatePath,
    templateFingerprint: output.templateFingerprint,
    contentFingerprint: output.contentFingerprint,
    fingerprint: output.fingerprint
  }));
}

function safeProjectionTarget(root, relativePath) {
  const normalized = normalizeProjectionPath(relativePath);
  if (normalized !== relativePath) {
    throw new Error('MCP fixture host projection path is not canonical: ' + relativePath);
  }
  const target = resolveRepoPath(root, normalized);
  let parent = path.dirname(target);
  const ancestors = [];
  while (parent !== root) {
    ancestors.push(parent);
    const next = path.dirname(parent);
    if (next === parent) {
      throw new Error('MCP fixture host projection path escapes its contained root.');
    }
    parent = next;
  }
  for (const ancestor of ancestors) {
    if (!fs.existsSync(ancestor)) continue;
    const stat = fs.lstatSync(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('MCP fixture host projection parent is unsafe.');
    }
  }
  if (fs.existsSync(target)) {
    throw new Error('MCP fixture host projection refuses to adopt an existing output.');
  }
  return { relativePath: normalized, target };
}

function ensureProjectionParents(root, target) {
  const relative = path.relative(root, path.dirname(target));
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o755 });
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('MCP fixture host projection parent became unsafe.');
    }
    if (process.platform !== 'win32') fs.chmodSync(cursor, 0o755);
  }
}

function writeExactProjectionOutput(root, candidate) {
  if (candidate.output.mode !== '0644') {
    throw new Error('MCP fixture host projection output has an unsupported mode.');
  }
  ensureProjectionParents(root, candidate.target);
  const descriptor = fs.openSync(candidate.target, 'wx', 0o644);
  try {
    fs.writeFileSync(descriptor, candidate.output.content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (process.platform !== 'win32') fs.chmodSync(candidate.target, 0o644);
  const stat = fs.lstatSync(candidate.target);
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o644)
    || fingerprintPath(candidate.target) !== candidate.output.contentFingerprint) {
    throw new Error('MCP fixture host projection output failed exact verification.');
  }
}

function materializeExactHostProjections(root) {
  const candidates = [];
  for (const host of ['codex', 'claude']) {
    const lock = resolveConfiguration({
      root,
      configPath: 'soter/configurations/meeting-intake.config.json',
      host
    });
    const adapter = readJson(resolveRepoPath(root, 'soter/hosts/' + host + '/adapter.json'));
    const rendered = renderHostProjectionCandidates({
      root,
      adapter,
      configurationId: lock.configuration.name,
      packIds: lock.packs.map((pack) => pack.id),
      capabilityIds: lock.capabilities.map((capability) => capability.id),
      effectPolicies: lock.effectPolicies,
      currentLock: lock
    });
    if (adapter.host !== host
      || adapter.id !== lock.host.adapter
      || adapter.version !== lock.host.version
      || rendered.definition.id !== lock.host.projectionDefinition.id
      || rendered.definition.version !== lock.host.projectionDefinition.version
      || rendered.definition.fingerprint !== lock.host.projectionDefinition.fingerprint
      || rendered.generator.id !== lock.host.projectionGenerator.id
      || rendered.generator.version !== lock.host.projectionGenerator.version
      || fingerprintJson(projectionRows(rendered.outputs))
        !== fingerprintJson(lock.projections)) {
      throw new Error('MCP fixture host projection does not match its exact resolved lock.');
    }
    for (const output of rendered.outputs) {
      candidates.push({
        host,
        output,
        ...safeProjectionTarget(root, output.path)
      });
    }
  }
  candidates.sort((left, right) => compareText(left.relativePath, right.relativePath));
  for (let index = 0; index < candidates.length; index += 1) {
    const current = candidates[index].relativePath;
    const prior = candidates[index - 1]?.relativePath || null;
    if (prior && (current === prior
      || current.startsWith(prior + '/')
      || prior.startsWith(current + '/'))) {
      throw new Error('MCP fixture host projections collide across hosts.');
    }
  }
  for (const candidate of candidates) writeExactProjectionOutput(root, candidate);
  if (fs.existsSync(path.join(root, '.soter'))) {
    throw new Error('MCP fixture projection materialization created runtime authority state.');
  }
}

function notionMappingStep(mapping, recordType, kind) {
  return 'step.mapping.integration.notion.' + mapping + '-records.record.'
    + recordType + '.' + kind;
}

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
    const optionMappings = meetingNotionOptionMappings();
    const schema = Object.fromEntries(source.scope.expectedFields.map((field) => {
      const property = { name: field.provider, type: field.providerType };
      if (['status', 'select', 'multi_select'].includes(field.providerType)) {
        const declaration = optionMappings.find((item) => {
          return item.mapping === source.scope.mappingId
            && item.recordType === source.scope.recordType
            && item.field === field.portable;
        });
        if (!declaration) {
          throw new Error(
            'MCP selftest has no private option mapping for '
              + source.scope.recordType + '.' + field.portable + '.'
          );
        }
        property.options = declaration.entries.map((entry) => ({
          name: entry.provider
        }));
      }
      return [field.provider, property];
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
            projectUris: JSON.stringify(fields.projectUris),
            sourceMeetingUris: JSON.stringify(fields.sourceMeetingUris || []),
            sourceQuotes: JSON.stringify(fields.sourceQuotes || []),
            sourceSummaryFingerprints: JSON.stringify(fields.sourceSummaryFingerprints || [])
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
          + '</page>',
        ...(marker ? { privateMarker: marker } : {})
      })
    }],
    isError: false
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
      authority: source.authority,
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
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(codeRoot, file), path.join(root, file));
  }
  materializeExactHostProjections(root);
  const meeting = materializeContainedPrivateConfiguration({
    root,
    configurationName: 'meeting-intake',
    host: 'codex',
    notionOptionMappings: meetingNotionOptionMappings()
  });
  const task = materializeContainedPrivateConfiguration({
    root,
    configurationName: 'task-capture',
    host: 'codex',
    notionOptionMappings: taskNotionOptionMappings()
  });
  taskPolicyId = task.notion.recordUris['policy.tasks'];
  if (!/^https:\/\/www\.notion\.so\/[a-f0-9]{32}$/.test(taskPolicyId || '')) {
    throw new Error('Contained Task configuration did not materialize its exact private policy identity.');
  }
  const emailConfiguration = readJson(path.join(
    root,
    'soter/configurations/email-triage.config.json'
  ));
  writePrivateConfigurationState(root, emailConfiguration.name, emailConfiguration);
  const emailLock = resolveConfiguration({
    root,
    configPath: privateConfigurationStatePath(root, emailConfiguration.name),
    host: 'codex'
  });
  writeActiveConfigurationLockState(root, emailConfiguration.name, emailLock);
  lockPath = path.relative(
    root,
    activeConfigurationLockStatePath(root, meeting.configuration.name)
  ).split(path.sep).join('/');
  const run = prepareRunEnvelope({
    root,
    lock: meeting.lock,
    lockPath,
    automationId: 'automation.meeting-intake',
    runId: 'run.meeting-intake.mcp-selftest',
    createdAt: fixtureTime,
    requestedOutcome: 'Exercise exact private-active MCP host-call authority without provider effects.'
  });
  const storedRun = writeRunState(root, run);
  runPath = storedRun.path;
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

async function expectError(action, message) {
  let observed;
  try {
    await action();
  } catch (error) {
    observed = error;
  }
  if (!observed || !String(observed.message || observed).includes(message)) {
    throw new Error(
      'Expected failure containing ' + message + '; observed: '
        + String(observed?.stack || observed || 'no failure')
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

function assertPrivateCliExportsRejected(root) {
  const cases = [
    {
      args: ['probe-prepare', '--output', 'probe.json'],
      label: 'provider probe preparation'
    },
    {
      args: ['probe-complete', '--probe-output', 'probe.json'],
      label: 'provider probe completion'
    },
    {
      args: ['capability-complete', '--output', 'capability.json'],
      label: 'capability completion'
    },
    {
      args: ['host-fail', '--checkpoint', 'checkpoint.private-export-test', '--output', 'host.json'],
      label: 'host-call failure'
    }
  ];
  for (const item of cases) {
    const invoked = invokeCli(root, item.args);
    if (invoked.status === 0 || !invoked.stderr.includes('cannot be exported')) {
      throw new Error(
        'CLI ' + item.label + ' did not reject a private runtime-state export.'
      );
    }
  }
}

async function assertWrongHostRejected(root) {
  const client = await connectClient(root, 'claude');
  try {
    const claudeProjection = path.join(root, 'CLAUDE.md');
    const claudeProjectionSource = fs.readFileSync(claudeProjection, 'utf8');
    fs.writeFileSync(
      claudeProjection,
      claudeProjectionSource + '\n<!-- MCP Claude projection drift selftest. -->\n'
    );
    try {
      const staleRuntime = await call(client, 'soter_inspect_host_runtime', {});
      if (staleRuntime.runtime.state !== 'stale'
        || staleRuntime.runtime.reasonCode !== 'SOTER_HOST_RUNTIME_STALE') {
        throw new Error('Claude did not detect drift in its exact realized host projection.');
      }
    } finally {
      fs.writeFileSync(claudeProjection, claudeProjectionSource);
      if (process.platform !== 'win32') fs.chmodSync(claudeProjection, 0o644);
    }
    const restoredRuntime = await call(client, 'soter_inspect_host_runtime', {});
    if (restoredRuntime.runtime.state !== 'current') {
      throw new Error('Claude did not recover after exact host projection restoration.');
    }
    await expectToolError(client, 'soter_prepare_provider_probe', {
      configuration_basis: 'private-active',
      lock_path: lockPath,
      provider_implementation: 'provider.integration.otter.mcp',
      at: fixtureTime
    }, 'selected configuration lock does not match the active host');
  } finally {
    await client.close().catch(() => {});
  }
}

async function assertClaudeHostProjection(root) {
  const configurationName = 'meeting-intake';
  const originalLock = readJson(activeConfigurationLockStatePath(root, configurationName));
  const claudeLock = resolveConfiguration({
    root,
    configPath: privateConfigurationStatePath(root, configurationName),
    host: 'claude'
  });
  const storedLock = writeActiveConfigurationLockState(root, configurationName, claudeLock);
  const claudeLockPath = storedLock.path;
  const claudeRun = prepareRunEnvelope({
    root,
    lock: claudeLock,
    lockPath: claudeLockPath,
    automationId: 'automation.meeting-intake',
    runId: 'run.meeting-intake.mcp-claude-host',
    createdAt: fixtureTime,
    requestedOutcome: 'Exercise the exact Claude private-active host projection.'
  });
  const storedRun = writeRunState(root, claudeRun);
  const client = await connectClient(root, 'claude');
  try {
    const prepared = await prepareDurableCapabilityExecution({
      root,
      configurationBasis: 'private-active',
      lockPath: claudeLockPath,
      runPath: storedRun.path,
      capability: 'meetings.records.read',
      authority: 'authority.meetings.instance',
      providerImplementation: 'provider.integration.notion.mcp',
      input: {
        recordTypes: ['meeting'],
        ids: ['https://www.notion.so/ffffffffffffffffffffffffffffffff'],
        limit: 1
      },
      callId: 'toolcall.mcp-selftest.claude-notion-read',
      at: fixtureTime,
      expectedHost: 'claude'
    });
    if (claudeLock.configuration.hostSelection?.source !== 'override'
      || claudeLock.host.id !== 'claude'
      || claudeRun.host?.id !== 'claude'
      || prepared.checkpoint?.host?.id !== 'claude'
      || prepared.checkpoint?.call?.transport?.tool !== 'Notion:notion-query-data-sources') {
      throw new Error('Claude did not realize the same configuration through its exact native tool mapping.');
    }
    await call(client, 'soter_fail_host_call', {
      checkpoint_id: prepared.checkpoint.id,
      error_kind: 'unavailable',
      at: fixtureTime
    });
  } finally {
    await client.close().catch(() => {});
    writeActiveConfigurationLockState(root, configurationName, originalLock);
  }
}

async function selftest(root) {
  assertPrivateCliExportsRejected(root);
  let client = await connectClient(root);
  let preparedCapability;
  let pendingNotionProbe;
  let expectedNotionProbeSteps = 0;
  let failedProbe;
  let rateLimitedNotionProbe;
  let rateLimitSentinels;
  let requestedRunContents;
  const privateInputRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'soter-mcp-response-'))
  );
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    const expectedNames = [
      'soter_advance_connected_transaction',
      'soter_commit_contact_capture_decision',
      'soter_commit_contact_capture_proposal',
      'soter_commit_email_triage_decision',
      'soter_commit_email_triage_proposal',
      'soter_commit_meeting_intake_decision',
      'soter_commit_meeting_intake_proposal',
      'soter_commit_organization_capture_decision',
      'soter_commit_organization_capture_proposal',
      'soter_commit_project_capture_decision',
      'soter_commit_project_capture_proposal',
      'soter_commit_task_capture_decision',
      'soter_commit_task_capture_proposal',
      'soter_complete_capability_call',
      'soter_complete_operation_plan',
      'soter_complete_provider_probe',
      'soter_fail_host_call',
      'soter_finalize_contact_capture_context',
      'soter_finalize_email_triage_context',
      'soter_finalize_meeting_intake_context',
      'soter_finalize_organization_capture_context',
      'soter_finalize_project_capture_context',
      'soter_finalize_slack_conversation_review_context',
      'soter_finalize_task_capture_context',
      'soter_get_host_call',
      'soter_inspect_contact_capture_decision',
      'soter_inspect_contact_capture_proposal',
      'soter_inspect_contact_capture_proposal_material',
      'soter_inspect_email_triage_decision',
      'soter_inspect_email_triage_proposal',
      'soter_inspect_email_triage_proposal_material',
      'soter_inspect_host_runtime',
      'soter_inspect_meeting_intake_decision',
      'soter_inspect_meeting_intake_proposal',
      'soter_inspect_meeting_intake_proposal_material',
      'soter_inspect_organization_capture_decision',
      'soter_inspect_organization_capture_proposal',
      'soter_inspect_organization_capture_proposal_material',
      'soter_inspect_project_capture_decision',
      'soter_inspect_project_capture_proposal',
      'soter_inspect_project_capture_proposal_material',
      'soter_inspect_slack_conversation_review',
      'soter_inspect_slack_conversation_review_private',
      'soter_inspect_task_capture_decision',
      'soter_inspect_task_capture_proposal',
      'soter_inspect_task_capture_proposal_material',
      'soter_list_host_calls',
      'soter_prepare_contact_capture_context',
      'soter_prepare_email_triage_context',
      'soter_prepare_meeting_intake_context',
      'soter_prepare_organization_capture_context',
      'soter_prepare_project_capture_context',
      'soter_prepare_provider_probe',
      'soter_prepare_slack_conversation_review_context',
      'soter_prepare_task_capture_context',
      'soter_reconcile_connected_transaction',
      'soter_stage_automation_acquisition'
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
    const workOwnedAcquisitionTools = new Set([
      'soter_prepare_contact_capture_context',
      'soter_prepare_email_triage_context',
      'soter_prepare_meeting_intake_context',
      'soter_prepare_organization_capture_context',
      'soter_prepare_project_capture_context',
      'soter_prepare_slack_conversation_review_context',
      'soter_prepare_task_capture_context'
    ]);
    for (const tool of listed.tools.filter((item) => workOwnedAcquisitionTools.has(item.name))) {
      const input = JSON.stringify(tool.inputSchema);
      if (!input.includes('work_id')
        || input.includes('lock_path')
        || input.includes('run_path')
        || input.includes('"query"')
        || input.includes('snapshot_id')) {
        throw new Error(
          'Connected acquisition MCP input is not derived exclusively from exact prepared work: '
            + tool.name
        );
      }
    }
    const hostFailureTool = listed.tools.find((item) => item.name === 'soter_fail_host_call');
    if (!hostFailureTool
      || JSON.stringify(hostFailureTool.inputSchema).includes('"message"')) {
      throw new Error('The MCP host-failure boundary exposed caller-supplied failure prose.');
    }
    const projectedInstructions = client.getInstructions() || '';
    const requiredInstructionFacts = [
      'soter_list_host_calls',
      'soter_commit_contact_capture_decision',
      'soter_commit_contact_capture_proposal',
      'soter_commit_email_triage_decision',
      'soter_commit_email_triage_proposal',
      'soter_inspect_slack_conversation_review_private',
      'soter_stage_automation_acquisition',
      'soter_commit_meeting_intake_decision',
      'soter_commit_meeting_intake_proposal',
      'soter_commit_organization_capture_decision',
      'soter_commit_organization_capture_proposal',
      'soter_commit_project_capture_decision',
      'soter_commit_project_capture_proposal',
      'soter_commit_task_capture_decision',
      'soter_commit_task_capture_proposal',
      'Contact Capture acquisition',
      'Organization Capture acquisition',
      'Project Capture acquisition',
      'Task Capture acquisition'
    ];
    const missingInstructionFacts = requiredInstructionFacts.filter((fact) => {
      return !projectedInstructions.includes(fact);
    });
    if (missingInstructionFacts.length) {
      throw new Error(
        'The MCP server did not project durable recovery instructions: '
          + missingInstructionFacts.join(', ')
      );
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

    const runtimeArtifact = path.join(root, 'AGENTS.md');
    const runtimeArtifactSource = fs.readFileSync(runtimeArtifact, 'utf8');
    fs.writeFileSync(
      runtimeArtifact,
      runtimeArtifactSource + '\n<!-- MCP Codex projection drift selftest. -->\n'
    );
    try {
      const privateStatePath = path.join(root, '.soter');
      const privateStateFingerprintBeforeStaleCall
        = privateStateTreeFingerprint(privateStatePath);
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
          configuration_basis: 'private-active',
          lock_path: lockPath,
          provider_implementation: 'provider.integration.notion.mcp',
          probe_id: 'probe.mcp-stale-runtime',
          at: fixtureTime
        }
      });
      if (!staleOperation.isError
        || staleOperation.structuredContent?.result?.code !== 'SOTER_HOST_RUNTIME_STALE'
        || staleOperation.structuredContent?.result?.inspection?.runtime?.state !== 'stale'
        || privateStateTreeFingerprint(privateStatePath)
          !== privateStateFingerprintBeforeStaleCall) {
        throw new Error('A stale MCP runtime did not block state creation before provider dispatch.');
      }
    } finally {
      fs.writeFileSync(runtimeArtifact, runtimeArtifactSource);
      if (process.platform !== 'win32') fs.chmodSync(runtimeArtifact, 0o644);
    }
    const restoredRuntime = await call(client, 'soter_inspect_host_runtime', {});
    if (restoredRuntime.runtime.state !== 'current'
      || restoredRuntime.runtime.currentFingerprint !== currentRuntime.runtime.startupFingerprint) {
      throw new Error('MCP host runtime inspection did not recover after exact behavior restoration.');
    }

    const completedRun = JSON.parse(fs.readFileSync(path.join(root, runPath), 'utf8'));
    completedRun.id = 'run.meeting-intake.mcp-closed-run';
    completedRun.lifecycleState = 'completed';
    const arbitraryCompletedRunPath = 'soter/fixtures/meeting-intake/mcp-closed-run.run.json';
    fs.writeFileSync(
      path.join(root, arbitraryCompletedRunPath),
      JSON.stringify(completedRun, null, 2) + '\n'
    );
    await expectError(() => prepareDurableCapabilityExecution({
      root,
      configurationBasis: 'private-active',
      lockPath,
      runPath: arbitraryCompletedRunPath,
      capability: 'meeting.transcript.read',
      authority: 'authority.otter.provider',
      providerImplementation: 'provider.integration.otter.mcp',
      input: {
        meetingId: 'meeting.arbitrary-run',
        recordingUri: 'https://otter.ai/u/conversation_arbitrary_run'
      },
      at: fixtureTime,
      expectedHost: 'codex'
    }), 'existing exact Core-owned private state file');
    const completedRunState = writeRunState(root, completedRun);
    await expectError(() => prepareDurableCapabilityExecution({
      root,
      configurationBasis: 'private-active',
      lockPath,
      runPath: completedRunState.path,
      capability: 'meeting.transcript.read',
      authority: 'authority.otter.provider',
      providerImplementation: 'provider.integration.otter.mcp',
      input: {
        meetingId: 'meeting.closed-run',
        recordingUri: 'https://otter.ai/u/conversation_closed_run'
      },
      at: fixtureTime,
      expectedHost: 'codex'
    }), 'cannot continue this host request');

    const preparedProbe = await call(client, 'soter_prepare_provider_probe', {
      configuration_basis: 'private-active',
      lock_path: lockPath,
      provider_implementation: 'provider.integration.otter.mcp',
      probe_id: 'probe.mcp-selftest.otter',
      at: fixtureTime,
      valid_for_seconds: 300
    });
    if (preparedProbe.checkpoint?.state !== 'requested'
      || preparedProbe.checkpoint?.$contract
        !== 'soter://contracts/provider-probe-plan-checkpoint/v1'
      || preparedProbe.currentCall?.transport?.server !== 'otter'
      || preparedProbe.currentCall?.transport?.operation !== 'get_user_info'
      || preparedProbe.currentCall?.transport?.tool !== 'mcp__otter__get_user_info'
      || JSON.stringify(preparedProbe.currentCall?.arguments) !== '{}') {
      throw new Error('Provider probe preparation did not persist the exact Otter request.');
    }
    assertPrivateFile(checkpointFile(root, preparedProbe));

    const privateIdentity = 'private-identity-mcp-selftest-marker';
    await expectToolError(client, 'soter_complete_provider_probe', {
      checkpoint_id: preparedProbe.checkpoint.id,
      call_id: 'probecall.wrong.identity',
      response: { structuredContent: { result: privateIdentity } },
      at: fixtureTime
    }, 'exact current call');
    const completedProbe = await call(client, 'soter_complete_provider_probe', {
      checkpoint_id: preparedProbe.checkpoint.id,
      call_id: preparedProbe.currentCall.id,
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
      call_id: preparedProbe.currentCall.id,
      response: { structuredContent: { result: privateIdentity } },
      at: fixtureTime
    });
    if (repeatedProbe.checkpoint.checkpointFingerprint
      !== completedProbe.checkpoint.checkpointFingerprint) {
      throw new Error('Repeating an identical provider result was not idempotent.');
    }

    const notionMarker = 'private-notion-probe-mcp-selftest-marker';
    const preparedNotionProbe = await call(client, 'soter_prepare_provider_probe', {
      configuration_basis: 'private-active',
      lock_path: lockPath,
      provider_implementation: 'provider.integration.notion.mcp',
      probe_id: 'probe.mcp-selftest.notion-plan',
      at: fixtureTime,
      valid_for_seconds: 300
    });
    expectedNotionProbeSteps = preparedNotionProbe.checkpoint?.plan?.steps?.length || 0;
    if (preparedNotionProbe.checkpoint?.state !== 'requested'
      || expectedNotionProbeSteps < 1
      || preparedNotionProbe.checkpoint?.steps?.length !== expectedNotionProbeSteps
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
      || pendingNotionProbe.checkpoint.currentStepId
        !== notionMappingStep('crm', 'organization', 'schema')
      || pendingNotionProbe.checkpoint.plan.steps.some((step) => {
        return step.scope?.recordType === 'organization-capture-policy';
      })) {
      throw new Error('MCP provider probe plan did not minimize identity and emit its next exact call.');
    }
    assertPrivateFile(checkpointFile(root, pendingNotionProbe));
    if (fs.readFileSync(checkpointFile(root, pendingNotionProbe), 'utf8').includes(notionMarker)) {
      throw new Error('Notion identity content reached durable provider probe plan state.');
    }

    const rateLimitedNotionProbeRequest = await call(client, 'soter_prepare_provider_probe', {
      configuration_basis: 'private-active',
      lock_path: lockPath,
      provider_implementation: 'provider.integration.notion.mcp',
      probe_id: 'probe.mcp-selftest.notion-rate-limit',
      at: fixtureTime,
      valid_for_seconds: 300
    });
    rateLimitSentinels = [
      'sk-' + 'r'.repeat(32),
      '/private/user/notion-rate-limit.json',
      'RAW_NOTION_RATE_LIMIT_BODY_SENTINEL'
    ];
    const rateLimitResponse = {
      isError: true,
      structuredContent: {
        error_code: 'RATE_LIMITED',
        error_message: rateLimitSentinels.join(' ')
      },
      content: [{
        type: 'text',
        text: rateLimitSentinels.join(' ')
      }]
    };
    rateLimitedNotionProbe = await call(client, 'soter_complete_provider_probe', {
      checkpoint_id: rateLimitedNotionProbeRequest.checkpoint.id,
      call_id: rateLimitedNotionProbeRequest.currentCall.id,
      response: rateLimitResponse,
      at: fixtureTime
    });
    const rateLimitedStep = rateLimitedNotionProbe.checkpoint?.steps?.find((step) => {
      return step.state === 'failed';
    });
    const recoveredRateLimitedProbe = await call(client, 'soter_get_host_call', {
      checkpoint_id: rateLimitedNotionProbeRequest.checkpoint.id
    });
    const listedRateLimitedProbes = await call(client, 'soter_list_host_calls', {
      state: 'failed'
    });
    const rateLimitedCheckpointContents = fs.readFileSync(
      checkpointFile(root, rateLimitedNotionProbe),
      'utf8'
    );
    const rateLimitedProjections = [
      JSON.stringify(rateLimitedNotionProbe),
      JSON.stringify(recoveredRateLimitedProbe),
      JSON.stringify(listedRateLimitedProbes),
      rateLimitedCheckpointContents
    ];
    if (rateLimitedNotionProbe.checkpoint?.state !== 'failed'
      || rateLimitedNotionProbe.currentCall !== null
      || rateLimitedStep?.error?.kind !== 'rate-limit'
      || rateLimitedStep.error.code !== 'HOST_CALL_RATE_LIMITED'
      || rateLimitedStep.error.message !== 'The exact host operation was rate limited.'
      || !rateLimitedStep.call?.responseFingerprint
      || rateLimitedNotionProbe.checkpoint.privacy?.rawProviderResponsePersisted !== false
      || rateLimitedProjections.some((projection) => {
        return rateLimitSentinels.some((sentinel) => projection.includes(sentinel));
      })) {
      throw new Error(
        'Notion connector rate-limit completion was not durably classified and minimized.'
      );
    }
    const replayedRateLimitedProbe = await call(client, 'soter_complete_provider_probe', {
      checkpoint_id: rateLimitedNotionProbeRequest.checkpoint.id,
      call_id: rateLimitedNotionProbeRequest.currentCall.id,
      response: rateLimitResponse,
      at: fixtureTime
    });
    if (replayedRateLimitedProbe.checkpoint.checkpointFingerprint
      !== rateLimitedNotionProbe.checkpoint.checkpointFingerprint) {
      throw new Error('Repeating the exact Notion rate-limit envelope was not idempotent.');
    }
    await expectToolError(client, 'soter_complete_provider_probe', {
      checkpoint_id: rateLimitedNotionProbeRequest.checkpoint.id,
      call_id: rateLimitedNotionProbeRequest.currentCall.id,
      response: {
        ...rateLimitResponse,
        structuredContent: {
          ...rateLimitResponse.structuredContent,
          error_message: 'A changed provider response cannot reopen a failed checkpoint.'
        }
      },
      at: fixtureTime
    }, 'does not match the exact completed step call');

    const failedProbeRequest = await call(client, 'soter_prepare_provider_probe', {
      configuration_basis: 'private-active',
      lock_path: lockPath,
      provider_implementation: 'provider.integration.otter.mcp',
      probe_id: 'probe.mcp-selftest.failure',
      at: fixtureTime
    });
    const credentialSentinel = 'sk-' + 'a'.repeat(32);
    const hostileFailureProse = [
      credentialSentinel,
      '/private/user/secrets.json',
      'RAW_PROVIDER_FAILURE_BODY_SENTINEL'
    ].join(' ');
    await expectError(() => failDurableHostExecution({
      root,
      checkpointId: failedProbeRequest.checkpoint.id,
      callId: failedProbeRequest.currentCall.id,
      errorKind: 'provider-said-maybe',
      at: fixtureTime,
      expectedHost: 'codex'
    }), 'explicit closed error kind');
    await expectError(() => failDurableHostExecution({
      root,
      checkpointId: failedProbeRequest.checkpoint.id,
      callId: failedProbeRequest.currentCall.id,
      errorKind: 'authentication',
      message: hostileFailureProse,
      at: fixtureTime,
      expectedHost: 'codex'
    }), 'exact declared arguments');
    failedProbe = await failDurableHostExecution({
      root,
      checkpointId: failedProbeRequest.checkpoint.id,
      callId: failedProbeRequest.currentCall.id,
      errorKind: 'authentication',
      at: fixtureTime,
      expectedHost: 'codex'
    });
    const failedProbeStep = failedProbe.checkpoint?.steps?.find((step) => {
      return step.state === 'failed';
    });
    const failedProbeContents = fs.readFileSync(checkpointFile(root, failedProbe), 'utf8');
    const recoveredFailedProbe = await call(client, 'soter_get_host_call', {
      checkpoint_id: failedProbeRequest.checkpoint.id
    });
    const listedFailedProbes = await call(client, 'soter_list_host_calls', {
      state: 'failed'
    });
    const failureProjections = [
      JSON.stringify(failedProbe),
      JSON.stringify(recoveredFailedProbe),
      JSON.stringify(listedFailedProbes),
      failedProbeContents
    ];
    if (failedProbe.checkpoint?.state !== 'failed'
      || failedProbeStep?.error?.kind !== 'authentication'
      || failedProbeStep.error.code !== 'HOST_CALL_AUTHENTICATION_FAILED'
      || failedProbeStep.error.message !== 'The exact host operation could not authenticate.'
      || failureProjections.some((projection) => [
        credentialSentinel,
        '/private/user/secrets.json',
        'RAW_PROVIDER_FAILURE_BODY_SENTINEL'
      ].some((sentinel) => projection.includes(sentinel)))) {
      throw new Error('Host failure recording did not close the durable provider request.');
    }
    const repeatedFailedProbe = await call(client, 'soter_fail_host_call', {
      checkpoint_id: failedProbeRequest.checkpoint.id,
      call_id: failedProbeRequest.currentCall.id,
      error_kind: 'authentication',
      at: fixtureTime
    });
    if (repeatedFailedProbe.checkpoint.checkpointFingerprint
      !== failedProbe.checkpoint.checkpointFingerprint) {
      throw new Error('Repeating an exact provider probe failure was not idempotent.');
    }

    const staleProbe = await call(client, 'soter_prepare_provider_probe', {
      configuration_basis: 'private-active',
      lock_path: lockPath,
      provider_implementation: 'provider.integration.otter.mcp',
      probe_id: 'probe.mcp-selftest.stale',
      at: fixtureTime
    });
    const providerModule = path.join(root, 'soter/integrations/otter/mcp.mjs');
    const providerSource = fs.readFileSync(providerModule, 'utf8');
    try {
      fs.writeFileSync(providerModule, providerSource + '\n// planted stale-state change\n');
      await expectToolError(client, 'soter_complete_provider_probe', {
        checkpoint_id: staleProbe.checkpoint.id,
        call_id: staleProbe.currentCall.id,
        response: { structuredContent: { result: 'private-stale-identity' } },
        at: fixtureTime
      }, 'SOTER_HOST_RUNTIME_STALE');
      await client.close();
      client = await connectClient(root);
      await expectToolError(client, 'soter_complete_provider_probe', {
        checkpoint_id: staleProbe.checkpoint.id,
        call_id: staleProbe.currentCall.id,
        response: { structuredContent: { result: 'private-stale-identity' } },
        at: fixtureTime
      }, 'Private-active configuration lock is stale');
      await client.close();
    } finally {
      fs.writeFileSync(providerModule, providerSource);
      client = await connectClient(root);
    }
    await call(client, 'soter_fail_host_call', {
      checkpoint_id: staleProbe.checkpoint.id,
      call_id: staleProbe.currentCall.id,
      error_kind: 'unavailable',
      at: fixtureTime
    });

    const capabilityInput = {
      meetingId: 'meeting.mcp-selftest',
      recordingUri: 'https://otter.ai/u/conversation_mcp_selftest'
    };
    preparedCapability = await prepareDurableCapabilityExecution({
      root,
      configurationBasis: 'private-active',
      lockPath,
      runPath,
      capability: 'meeting.transcript.read',
      authority: 'authority.otter.provider',
      providerImplementation: 'provider.integration.otter.mcp',
      input: capabilityInput,
      callId: 'toolcall.mcp-selftest.otter-read',
      at: fixtureTime,
      expectedHost: 'codex'
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
    await expectError(() => prepareDurableCapabilityExecution({
      root,
      configurationBasis: 'private-active',
      lockPath,
      runPath,
      capability: 'meeting.transcript.read',
      authority: 'authority.otter.provider',
      providerImplementation: 'provider.integration.otter.mcp',
      input: capabilityInput,
      callId: 'toolcall.mcp-selftest.parallel-read',
      at: fixtureTime,
      expectedHost: 'codex'
    }), 'already has pending host call checkpoint');

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
      || recoveredNotionProbe.checkpoint.result?.checks?.length
        !== expectedNotionProbeSteps
      || recoveredNotionProbe.checkpoint.result?.checks?.filter((check) => {
        return check.kind === 'document' && check.method === 'read-only';
      }).length !== 3
      || recoveredNotionProbe.checkpoint.result?.capabilities?.find((item) => {
        return item.id === 'crm.records.read';
      })?.state !== 'passed'
      || recoveredNotionProbe.checkpoint.result?.capabilities?.find((item) => {
        return item.id === 'documents.content.read';
      })?.state !== 'passed'
      || ['projects.records.read', 'tasks.records.read', 'meetings.records.read'].some((id) => {
        return recoveredNotionProbe.checkpoint.result?.capabilities?.find((item) => {
          return item.id === id;
        })?.state !== 'passed';
      })
      || recoveredNotionProbe.checkpoint.result?.capabilities?.filter((item) => {
        return item.id === 'meetings.records.create' || item.id === 'tasks.records.update';
      }).some((item) => item.state !== 'unknown')
      || JSON.stringify(recoveredNotionProbe).includes(notionMarker)
      || fs.readFileSync(checkpointFile(root, recoveredNotionProbe), 'utf8')
        .includes(notionMarker)
      || fs.readFileSync(checkpointFile(root, recoveredNotionProbe), 'utf8')
        .includes('automation.meeting-intake')) {
      throw new Error('Recovered Notion probe plan did not close with minimized exact checks.');
    }

    let driftedNotionProbe = await call(client, 'soter_prepare_provider_probe', {
      configuration_basis: 'private-active',
      lock_path: lockPath,
      provider_implementation: 'provider.integration.notion.mcp',
      probe_id: 'probe.mcp-selftest.notion-drift',
      at: fixtureTime
    });
    const driftStepId = notionMappingStep('crm', 'organization', 'schema');
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

    const preparedPlan = await prepareDurableOperationPlanExecution({
      root,
      configurationBasis: 'private-active',
      lockPath,
      runPath,
      plan: {
        $contract: 'soter://contracts/operation-plan/v2',
        contractVersion: '2.0.0',
        id: 'plan.mcp-selftest.multi-target-read',
        runId: completed.run.id,
        createdAt: '2026-07-15T12:00:04.000Z',
        mode: 'sequential',
        failurePolicy: 'stop',
        reason: 'Prove sequential multi-target reads through the shared MCP projection and durable Core service.',
        steps: [
          {
            id: 'step.read-meeting',
            capability: 'meetings.records.read',
            authority: 'authority.meetings.instance',
            providerImplementation: 'provider.integration.notion.mcp',
            input: { recordTypes: ['meeting'], limit: 1 },
            inputBindings: [],
            reason: 'Read one mapped meeting target through the Notion provider.'
          },
          {
            id: 'step.read-task',
            capability: 'tasks.records.read',
            authority: 'authority.tasks.instance',
            providerImplementation: 'provider.integration.notion.mcp',
            input: { recordTypes: ['task'], limit: 1 },
            inputBindings: [],
            reason: 'Read one mapped task target after the first call completes.'
          }
        ]
      },
      at: '2026-07-15T12:00:04.000Z',
      expectedHost: 'codex'
    });
    const firstPlanCall = preparedPlan.currentCall;
    if (preparedPlan.checkpoint?.state !== 'requested'
      || preparedPlan.checkpoint?.currentStepId !== 'step.read-meeting'
      || firstPlanCall?.transport?.operation !== 'query_data_sources'
      || firstPlanCall?.transport?.tool
        !== 'mcp__codex_apps__notion_query_data_sources') {
      throw new Error('MCP operation plan did not emit the exact first native host call.');
    }
    const firstPlanMarker = 'private-first-plan-response-marker';
    const firstPlanResponse = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: [{
            __soterType: 'meeting',
            __soterId: 'https://app.notion.com/p/33333333333333333333333333333333',
            __soterFields: JSON.stringify({
              title: 'MCP plan meeting',
              meetingType: 'Project Sync',
              recordingUri: 'https://otter.ai/u/mcp-plan-meeting',
              organizationUris: '[]'
            })
          }],
          has_more: false,
          privateMarker: firstPlanMarker
        })
      }],
      isError: false
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
              __soterId: 'https://app.notion.com/p/44444444444444444444444444444444',
              __soterFields: JSON.stringify({
                title: 'MCP plan task',
                status: 'Open',
                context: null,
                projectUris: '[]'
              })
            }],
            has_more: false,
            privateMarker: secondPlanMarker
          }
        }
      },
      at: '2026-07-15T12:00:06.000Z'
    });
    const completedPlanContents = fs.readFileSync(checkpointFile(root, completedPlan), 'utf8');
    if (completedPlan.checkpoint?.state !== 'completed'
      || completedPlan.currentCall !== null
      || completedPlan.checkpoint?.steps?.some((step) => step.state !== 'completed')
      || completedPlan.checkpoint?.result?.stepResults?.length !== 2
      || [firstPlanMarker, secondPlanMarker].some((marker) => {
        return JSON.stringify(completedPlan).includes(marker)
          || completedPlanContents.includes(marker);
      })) {
      throw new Error('Recovered MCP operation plan did not complete with minimized durable state.');
    }
    const completedPlanFile = checkpointFile(root, completedPlan);
    const tamperedPlan = JSON.parse(completedPlanContents);
    tamperedPlan.steps[0].output.records[0].fields.title = 'Tampered plan output';
    fs.writeFileSync(completedPlanFile, JSON.stringify(tamperedPlan, null, 2) + '\n');
    await expectToolError(client, 'soter_get_host_call', {
      checkpoint_id: completedPlan.checkpoint.id
    }, 'fingerprint does not match');
    fs.writeFileSync(completedPlanFile, completedPlanContents, { mode: 0o600 });

    const cliPlan = await prepareDurableOperationPlanExecution({
      root,
      configurationBasis: 'private-active',
      lockPath,
      runPath,
      plan: {
        $contract: 'soter://contracts/operation-plan/v2',
        contractVersion: '2.0.0',
        id: 'plan.cli-selftest.single-target-read',
        runId: completed.run.id,
        createdAt: '2026-07-15T12:00:07.000Z',
        mode: 'sequential',
        failurePolicy: 'stop',
        reason: 'Prove the CLI advances an internally prepared durable operation plan.',
        steps: [{
          id: 'step.read-meeting',
          capability: 'meetings.records.read',
          authority: 'authority.meetings.instance',
          providerImplementation: 'provider.integration.notion.mcp',
          input: { recordTypes: ['meeting'], limit: 1 },
          inputBindings: [],
          reason: 'Read one mapped meeting target through the CLI completion projection.'
        }]
      },
      at: '2026-07-15T12:00:07.000Z',
      expectedHost: 'codex'
    });
    const cliPlanMarker = 'private-cli-plan-response-marker';
    const cliPlanResponsePath = path.join(privateInputRoot, 'cli-operation-plan-response.json');
    fs.writeFileSync(cliPlanResponsePath, JSON.stringify({
      structuredContent: {
        result: {
          results: [{
            __soterType: 'meeting',
            __soterId: 'https://app.notion.com/p/55555555555555555555555555555555',
            __soterFields: JSON.stringify({
              title: 'CLI plan meeting',
              meetingType: 'Project Sync',
              recordingUri: 'https://otter.ai/u/cli-plan-meeting',
              organizationUris: '[]'
            })
          }],
          has_more: false,
          privateMarker: cliPlanMarker
        }
      }
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

    const connectedRecording = 'https://otter.ai/u/meeting_fixture_001';
    const meetingInputPath = path.join(privateInputRoot, 'mcp-meeting-intake.input.json');
    fs.writeFileSync(meetingInputPath, JSON.stringify({
      meeting: 'meeting.fixture-001',
      recordingUri: connectedRecording,
      operatorGoal: 'MCP_PRIVATE_MEETING_GOAL_SENTINEL'
    }, null, 2) + '\n', { mode: 0o600 });
    const meetingPreparedWork = await call(client, 'soter_stage_automation_acquisition', {
      automation_id: 'automation.meeting-intake',
      configuration_name: 'meeting-intake',
      configuration_basis: 'private-active',
      input: {
        meeting: 'meeting.fixture-001',
        recordingUri: connectedRecording,
        operatorGoal: 'MCP_PRIVATE_MEETING_GOAL_SENTINEL'
      },
      at: '2026-07-15T12:00:08.500Z'
    });
    if (meetingPreparedWork.state !== 'ready-for-acquisition'
      || meetingPreparedWork.preparationMode !== 'connected-acquisition'
      || meetingPreparedWork.checkpoint.contextSnapshotId !== null
      || meetingPreparedWork.evidence.length !== 0
      || meetingPreparedWork.preview.facts.length !== 0
      || meetingPreparedWork.preview.collections.length !== 0
      || meetingPreparedWork.preview.proposedChanges.length !== 0
      || JSON.stringify(meetingPreparedWork).includes('MCP_PRIVATE_MEETING_GOAL_SENTINEL')) {
      throw new Error('MCP connected-acquisition stage exceeded its sanitized zero-effect boundary.');
    }
    const connectedContextLock = JSON.parse(fs.readFileSync(path.join(root, lockPath), 'utf8'));
    const contextPolicyBindings = applicablePolicySources(connectedContextLock);
    const preparedContext = await call(client, 'soter_prepare_meeting_intake_context', {
      work_id: meetingPreparedWork.id,
      at: '2026-07-15T12:00:09.000Z'
    });
    if (preparedContext.checkpoint?.$contract
        !== 'soter://contracts/operation-plan-checkpoint/v2'
      || preparedContext.checkpoint?.currentStepId
        !== 'step.context-policy.' + contextPolicyBindings[0].id.slice('policy.'.length)
      || preparedContext.currentCall?.transport?.tool
        !== 'mcp__codex_apps__notion_fetch') {
      throw new Error('MCP connected context did not emit its exact first source call.');
    }
    await expectToolError(client, 'soter_finalize_meeting_intake_context', {
      checkpoint_id: preparedContext.checkpoint.id
    }, 'completed operation plan');
    const contextMarkers = [
      ...contextPolicyBindings.map((_, index) => 'private-mcp-context-policy-body-' + index),
      'private-mcp-context-transcript-marker',
      'private-mcp-context-meeting-marker',
      'private-mcp-context-organization-marker',
      'private-mcp-context-project-marker',
      'private-mcp-context-task-marker'
    ];
    const mcpOrganizationId = '66666666666666666666666666666666';
    const mcpProjectId = '77777777777777777777777777777777';
    const mcpTaskId = '88888888888888888888888888888888';
    const mcpOrganizationUri = 'https://www.notion.so/' + mcpOrganizationId;
    const mcpProjectUri = 'https://www.notion.so/' + mcpProjectId;
    const mcpTaskUri = 'https://www.notion.so/' + mcpTaskId;
    await client.close();
    client = await connectClient(root);
    let contextExecution = await call(client, 'soter_get_host_call', {
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
          marker: contextMarkers[index]
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
        privateMarker: contextMarkers[contextPolicyBindings.length]
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
              __soterId: 'https://app.notion.com/p/99999999999999999999999999999999',
              __soterFields: JSON.stringify({
                title: 'MCP connected context',
                meetingType: 'Project Sync',
                occurredOn: '2026-07-15',
                recordingUri: connectedRecording,
                organizationUris: JSON.stringify([mcpOrganizationUri])
              })
            }],
            has_more: false,
            privateMarker: contextMarkers[contextPolicyBindings.length + 1]
          }
        }
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
        !== mcpOrganizationId
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
            has_more: false,
            privateMarker: contextMarkers[contextPolicyBindings.length + 2]
          }
        }
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
            has_more: false,
            privateMarker: contextMarkers[contextPolicyBindings.length + 3]
          }
        }
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
            has_more: false,
            privateMarker: contextMarkers[contextPolicyBindings.length + 4]
          }
        }
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
      || contextCompleted.checkpoint?.result?.stepResults?.length !== 8
      || contextProject.checkpoint?.currentStepId !== 'step.context-projects'
      || contextProject.currentCall?.arguments?.data?.params?.[0] !== mcpProjectId
      || contextTask.checkpoint?.currentStepId !== 'step.context-tasks'
      || contextTask.currentCall?.arguments?.data?.params?.[0] !== mcpTaskId
      || finalizedContext.snapshot?.containment !== 'connected'
      || finalizedContext.snapshot?.entries?.length !== 8
      || finalizedContext.snapshot?.entries?.filter((entry) => {
        return entry.applicability?.state === 'applicable';
      }).length !== contextPolicyBindings.length
      || finalizedContext.snapshot?.entries?.filter((entry) => {
        return entry.applicability?.state === 'applicable';
      }).some((entry) => !contextPolicyBindings.some((binding) => {
        return binding.sourceId === entry.applicability.sourceId;
      }))
      || finalizedContext.run?.context
        ?.find((entry) => entry.authority === 'authority.meetings.definition')?.status !== 'loaded'
      || finalizedContext.run?.context
        ?.find((entry) => entry.authority === 'authority.tasks.definition')?.status !== 'loaded'
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
            definitionAuthorities: finalizedContext.run?.context?.filter((entry) => {
              return entry.authority === 'authority.meetings.definition'
                || entry.authority === 'authority.tasks.definition';
            }),
            lifecycleState: finalizedContext.run?.lifecycleState,
            cliSnapshotPath: cliFinalizedContext.snapshotPath,
            mcpSnapshotPath: finalizedContext.snapshotPath,
            persistedMarkers: contextMarkers.filter((marker) => contextDurableContents.includes(marker))
          })
      );
    }
    const emailQuery = 'in:inbox newer_than:1d';
    const emailInputPath = path.join(privateInputRoot, 'mcp-email-triage.input.json');
    fs.writeFileSync(emailInputPath, JSON.stringify({
      query: emailQuery,
      scope: 'triage-drafts-handoffs-digest',
      focus: 'MCP_PRIVATE_EMAIL_HOSTILE_FOCUS_SENTINEL'
    }, null, 2) + '\n', { mode: 0o600 });
    const hostileEmailPreparedWork = runCli(root, [
      'operator-prepare',
      '--configuration', 'email-triage',
      '--configuration-basis', 'private-active',
      '--preparation-mode', 'connected-acquisition',
      '--automation', 'automation.email-triage',
      '--input', emailInputPath,
      '--at', '2026-07-15T12:00:16.000Z'
    ]);
    const emailLockPath = hostileEmailPreparedWork.configuration.lockPath;
    const hostileEmailContext = await call(client, 'soter_prepare_email_triage_context', {
      work_id: hostileEmailPreparedWork.id,
      at: '2026-07-15T12:00:17.000Z'
    });
    if (hostileEmailContext.checkpoint?.$contract
        !== 'soter://contracts/operation-plan-checkpoint/v2'
      || hostileEmailContext.checkpoint?.currentStepId !== 'step.mail-message-search'
      || hostileEmailContext.currentCall?.transport?.tool
        !== 'mcp__codex_apps__gmail_search_email_ids'
      || hostileEmailContext.currentCall?.arguments?.query !== emailQuery) {
      throw new Error('MCP Email acquisition did not emit its exact private search call.');
    }
    const emailSearchMarker = 'MCP_RAW_EMAIL_SEARCH_RESPONSE_SENTINEL';
    const rejectedEmailSearch = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: hostileEmailContext.checkpoint.id,
      call_id: hostileEmailContext.currentCall.id,
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
    if (rejectedEmailSearch.checkpoint?.state !== 'failed'
      || rejectedEmailSearch.currentCall !== null
      || JSON.stringify(rejectedEmailSearch).includes(emailSearchMarker)
      || fs.readFileSync(checkpointFile(root, rejectedEmailSearch), 'utf8')
        .includes(emailSearchMarker)) {
      throw new Error('MCP Email acquisition did not reject and minimize an open raw response.');
    }

    fs.writeFileSync(emailInputPath, JSON.stringify({
      query: emailQuery,
      scope: 'triage-drafts-handoffs-digest',
      focus: 'MCP_PRIVATE_EMAIL_SUCCESS_FOCUS_SENTINEL'
    }, null, 2) + '\n', { mode: 0o600 });
    const emailPreparedWork = runCli(root, [
      'operator-prepare',
      '--configuration', 'email-triage',
      '--configuration-basis', 'private-active',
      '--preparation-mode', 'connected-acquisition',
      '--automation', 'automation.email-triage',
      '--input', emailInputPath,
      '--at', '2026-07-15T12:00:18.100Z'
    ]);
    if (emailPreparedWork.configuration.lockPath !== emailLockPath) {
      throw new Error('MCP Email preparation changed its exact private-active lock.');
    }
    const preparedEmailContext = await call(client, 'soter_prepare_email_triage_context', {
      work_id: emailPreparedWork.id,
      at: '2026-07-15T12:00:18.200Z'
    });
    await expectToolError(client, 'soter_finalize_email_triage_context', {
      checkpoint_id: preparedEmailContext.checkpoint.id
    }, 'completed operation plan');
    const emailThreadExecution = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: preparedEmailContext.checkpoint.id,
      call_id: preparedEmailContext.currentCall.id,
      response: {
        structuredContent: {
          result: {
            message_ids: ['gmail-mcp-message-001'],
            next_page_token: null
          }
        }
      },
      at: '2026-07-15T12:00:18.300Z'
    });
    if (emailThreadExecution.checkpoint?.currentStepId !== 'step.mail-thread-expansion'
      || emailThreadExecution.currentCall?.transport?.tool
        !== 'mcp__codex_apps__gmail_batch_read_email_threads') {
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
                body: 'MCP private Email body; data only.'
              }]
            }]
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
      || emailDurableContents.includes('"rawProviderResponse"')
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
    const taskInputPath = path.join(privateInputRoot, 'mcp-task-capture.input.json');
    const taskTitle = 'MCP_PRIVATE_TASK_TITLE_SENTINEL';
    const taskDate = '2026-07-24';
    const taskProjectId = 'https://www.notion.so/22222222222222222222222222222222';
    fs.writeFileSync(taskInputPath, JSON.stringify({
      title: taskTitle,
      project: taskProjectId,
      assignee: 'self',
      nextActionOn: taskDate,
      context: 'Project'
    }, null, 2) + '\n', { mode: 0o600 });
    const taskPreparedWork = runCli(root, [
      'operator-prepare',
      '--configuration', 'task-capture',
      '--configuration-basis', 'private-active',
      '--preparation-mode', 'connected-acquisition',
      '--automation', 'automation.task-capture',
      '--input', taskInputPath,
      '--at', '2026-07-15T12:00:24.000Z'
    ]);
    const taskLockPath = taskPreparedWork.configuration.lockPath;
    let taskContext = await call(client, 'soter_prepare_task_capture_context', {
      work_id: taskPreparedWork.id,
      at: '2026-07-15T12:00:26.000Z'
    });
    if (taskContext.checkpoint?.currentStepId !== 'step.task-policy-selection'
      || taskContext.currentCall?.capability?.id !== 'tasks.records.read') {
      throw new Error('MCP Task acquisition did not start with its exact policy selection.');
    }
    const taskRawMarkers = [
      'MCP_RAW_TASK_POLICY_SENTINEL',
      'MCP_RAW_TASK_SCHEMA_SENTINEL',
      'MCP_RAW_TASK_PROJECT_SENTINEL',
      'MCP_RAW_TASK_IDENTITY_SENTINEL',
      'MCP_RAW_TASK_DUPLICATES_SENTINEL'
    ];
    taskContext = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: taskContext.checkpoint.id,
      call_id: taskContext.currentCall.id,
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'task-work-policy',
              __soterId: taskPolicyId,
              __soterFields: JSON.stringify({ name: 'Tasks' })
            }],
            has_more: false,
            rawProviderResponse: taskRawMarkers[0]
          }
        }
      },
      at: '2026-07-15T12:00:27.000Z'
    });
    if (taskContext.checkpoint?.currentStepId !== 'step.task-schema'
      || taskContext.currentCall?.capability?.id !== 'tasks.schema.read') {
      throw new Error('MCP Task acquisition did not advance to exact Task schema preflight.');
    }
    const taskSchemaTarget = taskContext.currentCall.arguments.id;
    const taskProviderSchema = {
      Name: { name: 'Name', type: 'title' },
      Status: {
        name: 'Status',
        type: 'status',
        options: [{ name: PRIVATE_TASK_STATUS_OPTION }]
      },
      Context: {
        name: 'Context',
        type: 'select',
        options: [{ name: PRIVATE_TASK_CONTEXT_OPTION }]
      },
      Project: { name: 'Project', type: 'relation' },
      'Assigned To': { name: 'Assigned To', type: 'person' },
      'Next Action': { name: 'Next Action', type: 'date' },
      'Source Meetings': { name: 'Source Meetings', type: 'relation' },
      Grounding: { name: 'Grounding', type: 'text' },
      'Summary Fingerprints': { name: 'Summary Fingerprints', type: 'text' }
    };
    taskContext = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: taskContext.checkpoint.id,
      call_id: taskContext.currentCall.id,
      response: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            metadata: { type: 'data_source' },
            title: 'Private Task target',
            url: 'https://notion.invalid/private-task-target',
            text: '<data-source url="{{' + taskSchemaTarget + '}}">\n'
              + '<data-source-state>\n'
              + JSON.stringify({ schema: taskProviderSchema })
              + '\n</data-source-state>\n</data-source>',
            rawProviderResponse: taskRawMarkers[1]
          })
        }],
        isError: false
      },
      at: '2026-07-15T12:00:28.000Z'
    });
    taskContext = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: taskContext.checkpoint.id,
      call_id: taskContext.currentCall.id,
      response: {
        structuredContent: {
          result: {
            results: [{
              __soterType: 'project',
              __soterId: taskProjectId,
              __soterFields: JSON.stringify({
                name: 'Launch',
                projectType: PRIVATE_PROJECT_TYPE_OPTION,
                status: PRIVATE_PROJECT_STATUS_OPTION,
                organizationUris: '[]',
                taskUris: '[]'
              })
            }],
            has_more: false,
            rawProviderResponse: taskRawMarkers[2]
          }
        }
      },
      at: '2026-07-15T12:00:29.000Z'
    });
    taskContext = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: taskContext.checkpoint.id,
      call_id: taskContext.currentCall.id,
      response: {
        structuredContent: {
          result: {
            metadata: { type: 'self' },
            self: { user: { id: 'provider-person.mcp-selftest' } },
            rawProviderResponse: taskRawMarkers[3]
          }
        }
      },
      at: '2026-07-15T12:00:30.000Z'
    });
    taskContext = await call(client, 'soter_complete_operation_plan', {
      checkpoint_id: taskContext.checkpoint.id,
      call_id: taskContext.currentCall.id,
      response: {
        structuredContent: {
          result: {
            results: [],
            has_more: false,
            rawProviderResponse: taskRawMarkers[4]
          }
        }
      },
      at: '2026-07-15T12:00:31.000Z'
    });
    const finalizedTaskContext = await call(client, 'soter_finalize_task_capture_context', {
      checkpoint_id: taskContext.checkpoint.id
    });
    const cliFinalizedTaskContext = runCli(root, [
      'task-context-connected-finalize',
      '--checkpoint', taskContext.checkpoint.id
    ]);
    const taskDurableContents = [
      finalizedTaskContext.snapshotPath,
      finalizedTaskContext.checkpointPath,
      finalizedTaskContext.runPath
    ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    if (taskContext.checkpoint?.state !== 'completed'
      || finalizedTaskContext.snapshot?.entries?.length !== 5
      || finalizedTaskContext.run?.lifecycleState !== 'paused'
      || finalizedTaskContext.run?.approvals?.length !== 0
      || cliFinalizedTaskContext.snapshotPath !== finalizedTaskContext.snapshotPath
      || taskRawMarkers.some((marker) => taskDurableContents.includes(marker))) {
      throw new Error('MCP Task acquisition drifted, leaked raw responses, or granted authority.');
    }
    const inspectedTaskDecision = await call(client, 'soter_inspect_task_capture_decision', {
      lock_path: taskLockPath,
      snapshot_id: finalizedTaskContext.snapshot.id,
      at: '2026-07-15T12:00:32.000Z'
    });
    const cliInspectedTaskDecision = runCli(root, [
      'task-capture-decision-inspect',
      '--lock', taskLockPath,
      '--snapshot', finalizedTaskContext.snapshot.id,
      '--at', '2026-07-15T12:00:32.000Z'
    ]);
    const staleInspectedTaskDecision = await call(
      client,
      'soter_inspect_task_capture_decision',
      {
        lock_path: taskLockPath,
        snapshot_id: finalizedTaskContext.snapshot.id,
        at: '2026-07-15T12:06:00.000Z'
      }
    );
    const staleCliInspectedTaskDecision = runCli(root, [
      'task-capture-decision-inspect',
      '--lock', taskLockPath,
      '--snapshot', finalizedTaskContext.snapshot.id,
      '--at', '2026-07-15T12:06:00.000Z'
    ]);
    const committedTaskDecision = await call(client, 'soter_commit_task_capture_decision', {
      lock_path: taskLockPath,
      snapshot_id: finalizedTaskContext.snapshot.id,
      decision_id: 'decision.task-capture.mcp-selftest',
      at: '2026-07-15T12:00:32.000Z'
    });
    const replayedTaskDecision = await call(client, 'soter_commit_task_capture_decision', {
      lock_path: taskLockPath,
      snapshot_id: finalizedTaskContext.snapshot.id,
      decision_id: 'decision.task-capture.mcp-selftest',
      at: '2026-07-15T12:00:33.000Z'
    });
    if (inspectedTaskDecision.outcome?.state !== 'ready'
      || inspectedTaskDecision.outcome?.duplicateCandidateCount !== 0
      || cliInspectedTaskDecision.outcome?.state !== 'ready'
      || staleInspectedTaskDecision.outcome?.state !== 'needs-input'
      || !staleInspectedTaskDecision.outcome?.issueCodes?.includes('TASK_CONTEXT_STALE')
      || staleInspectedTaskDecision.authority?.state !== 'none'
      || staleCliInspectedTaskDecision.outcome?.state !== 'needs-input'
      || !staleCliInspectedTaskDecision.outcome?.issueCodes?.includes('TASK_CONTEXT_STALE')
      || staleCliInspectedTaskDecision.authority?.state !== 'none'
      || staleInspectedTaskDecision.outcome?.taskAfterFingerprint
        !== inspectedTaskDecision.outcome?.taskAfterFingerprint
      || committedTaskDecision.decision?.state !== 'ready'
      || committedTaskDecision.run?.approvals?.length !== 0
      || replayedTaskDecision.decision?.decisionFingerprint
        !== committedTaskDecision.decision?.decisionFingerprint
      || JSON.stringify(inspectedTaskDecision).includes(taskTitle)
      || JSON.stringify(inspectedTaskDecision).includes(taskDate)
      || JSON.stringify(inspectedTaskDecision).includes(PRIVATE_TASK_STATUS_OPTION)
      || JSON.stringify(inspectedTaskDecision).includes(PRIVATE_TASK_CONTEXT_OPTION)
      || JSON.stringify(inspectedTaskDecision).includes(PRIVATE_PROJECT_TYPE_OPTION)
      || JSON.stringify(inspectedTaskDecision).includes(PRIVATE_PROJECT_STATUS_OPTION)
      || JSON.stringify(committedTaskDecision).includes('continuationRequest')) {
      throw new Error('MCP Task decision drifted, leaked sanitized values, or granted authority.');
    }
    const inspectedTaskProposal = await call(client, 'soter_inspect_task_capture_proposal', {
      lock_path: taskLockPath,
      decision_id: committedTaskDecision.decision.id
    });
    const cliInspectedTaskProposal = runCli(root, [
      'task-capture-proposal-inspect',
      '--lock', taskLockPath,
      '--decision', committedTaskDecision.decision.id
    ]);
    const committedTaskProposal = await call(client, 'soter_commit_task_capture_proposal', {
      lock_path: taskLockPath,
      decision_id: committedTaskDecision.decision.id,
      proposal_id: 'proposal.task-capture.mcp-selftest',
      at: '2026-07-15T12:00:34.000Z'
    });
    const replayedTaskProposal = await call(client, 'soter_commit_task_capture_proposal', {
      lock_path: taskLockPath,
      decision_id: committedTaskDecision.decision.id,
      proposal_id: 'proposal.task-capture.mcp-selftest',
      at: '2026-07-15T12:00:35.000Z'
    });
    const inspectedTaskMaterial = await call(
      client,
      'soter_inspect_task_capture_proposal_material',
      { lock_path: taskLockPath, proposal_id: committedTaskProposal.proposal.id }
    );
    const cliInspectedTaskMaterial = runCli(root, [
      'task-capture-proposal-material',
      '--lock', taskLockPath,
      '--proposal', committedTaskProposal.proposal.id
    ]);
    if (inspectedTaskProposal.authority?.state !== 'none'
      || cliInspectedTaskProposal.authority?.state !== 'none'
      || committedTaskProposal.proposal?.state !== 'ready-for-review'
      || committedTaskProposal.proposal?.authority?.state !== 'none'
      || committedTaskProposal.run?.approvals?.length !== 0
      || replayedTaskProposal.proposal?.proposalFingerprint
        !== committedTaskProposal.proposal?.proposalFingerprint
      || JSON.stringify(committedTaskProposal).includes(taskTitle)
      || JSON.stringify(committedTaskProposal).includes(taskDate)
      || JSON.stringify(committedTaskProposal).includes(PRIVATE_TASK_STATUS_OPTION)
      || JSON.stringify(committedTaskProposal).includes(PRIVATE_TASK_CONTEXT_OPTION)
      || !JSON.stringify(inspectedTaskMaterial).includes(taskTitle)
      || !JSON.stringify(inspectedTaskMaterial).includes(taskDate)
      || cliInspectedTaskMaterial.fingerprint !== inspectedTaskMaterial.fingerprint
      || JSON.stringify(committedTaskProposal).includes('continuationRequest')) {
      throw new Error('MCP Task proposal drifted, leaked private values, or granted authority.');
    }
    const taskProposalActionIds = committedTaskProposal.proposal.review.collections
      .flatMap((collection) => collection.rows)
      .flatMap((row) => row.actions)
      .filter((action) => action.state === 'proposed')
      .map((action) => action.id);
    const taskCompiledBatch = runCli(root, [
      'proposal-connected-batch-preview',
      '--lock', taskLockPath,
      '--proposal', committedTaskProposal.proposal.id,
      ...taskProposalActionIds.flatMap((actionId) => ['--action-id', actionId]),
      '--change-set-id', 'changeset.task-capture.mcp-restart-selftest',
      '--batch-id', 'batch.task-capture.mcp-restart-selftest',
      '--host', 'codex',
      '--at', '2026-07-15T12:00:35.000Z'
    ]);
    const taskBatchPath = path.join(privateInputRoot, 'mcp-task-connected-batch.json');
    const taskChangeSetPath = path.join(privateInputRoot, 'mcp-task-change-set.json');
    fs.writeFileSync(taskBatchPath, JSON.stringify(taskCompiledBatch.batch, null, 2) + '\n', {
      mode: 0o600
    });
    fs.writeFileSync(taskChangeSetPath, JSON.stringify(taskCompiledBatch.changeSet, null, 2) + '\n', {
      mode: 0o600
    });
    runCli(root, [
      'connected-approval-request',
      '--configuration-basis', 'private-active',
      '--lock', taskLockPath,
      '--run', committedTaskProposal.runPath,
      '--batch', taskBatchPath,
      '--change-set', taskChangeSetPath,
      '--request-id', 'approval-request.task-capture.mcp-restart-selftest',
      '--reason', 'Review the exact connected Task create scope before the restart recovery test.',
      '--expires-at', '2026-07-15T12:10:35.000Z',
      '--at', '2026-07-15T12:00:35.000Z'
    ]);
    runCli(root, [
      'connected-approval-confirm',
      '--request-id', 'approval-request.task-capture.mcp-restart-selftest',
      '--approval-id', 'approval.task-capture.mcp-restart-selftest',
      '--actor', 'operator.mcp-selftest',
      '--reason', 'Confirm only the exact reviewed Task create and duplicate precondition.',
      '--at', '2026-07-15T12:00:36.000Z'
    ]);
    const startedTaskTransaction = runCli(root, [
      'connected-transaction-prepare',
      '--approval-id', 'approval.task-capture.mcp-restart-selftest',
      '--at', '2026-07-15T12:00:37.000Z'
    ]);
    await client.close();
    client = await connectClient(root);
    const recoveredTaskTransaction = await call(client, 'soter_get_host_call', {
      checkpoint_id: startedTaskTransaction.checkpoint.id
    });
    const listedTaskTransactions = await call(client, 'soter_list_host_calls', {
      state: 'requested'
    });
    const listedTaskTransaction = listedTaskTransactions.checkpoints.find((item) => {
      return item.id === startedTaskTransaction.checkpoint.id;
    });
    if (recoveredTaskTransaction.checkpoint?.$contract
        !== 'soter://contracts/connected-transaction-checkpoint/v2'
      || recoveredTaskTransaction.currentCall?.id !== startedTaskTransaction.currentCall.id
      || recoveredTaskTransaction.currentCall?.capability?.id !== 'tasks.records.read'
      || listedTaskTransaction?.callId !== startedTaskTransaction.currentCall.id
      || listedTaskTransaction?.currentStage !== 'precondition'
      || listedTaskTransaction?.batchId !== taskCompiledBatch.batch.id) {
      throw new Error(
        'Restarted MCP server did not rehydrate and list the exact v2 connected current call.'
      );
    }
    const advancedTaskTransaction = await call(
      client,
      'soter_advance_connected_transaction',
      {
        checkpoint_id: startedTaskTransaction.checkpoint.id,
        call_id: recoveredTaskTransaction.currentCall.id,
        response: {
          structuredContent: {
            result: { results: [], has_more: false }
          }
        },
        at: '2026-07-15T12:00:38.000Z'
      }
    );
    const taskWriteProperties
      = advancedTaskTransaction.currentCall?.arguments?.pages?.[0]?.properties;
    const portableTaskOperation = advancedTaskTransaction.checkpoint?.batch?.operations
      ?.find((operation) => operation.capability === 'tasks.records.create');
    const taskWorkspaceInspection = inspectWorkspace(root);
    if (advancedTaskTransaction.currentCall?.capability?.id !== 'tasks.records.create'
      || taskWriteProperties?.Status !== PRIVATE_TASK_STATUS_OPTION
      || taskWriteProperties?.Context !== PRIVATE_TASK_CONTEXT_OPTION
      || portableTaskOperation?.input?.fields?.status !== 'To Do'
      || portableTaskOperation?.input?.fields?.context !== 'Project'
      || JSON.stringify(taskCompiledBatch).includes(PRIVATE_TASK_STATUS_OPTION)
      || JSON.stringify(taskCompiledBatch).includes(PRIVATE_TASK_CONTEXT_OPTION)
      || JSON.stringify(taskWorkspaceInspection).includes(PRIVATE_TASK_STATUS_OPTION)
      || JSON.stringify(taskWorkspaceInspection).includes(PRIVATE_TASK_CONTEXT_OPTION)) {
      throw new Error(
        'Connected Task start did not translate portable choices only at the exact private host-call boundary.'
      );
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
    connectedDecisionInput.projectRecordId = mcpProjectUri;
    connectedDecisionInput.ourSpeakerIds = ['speaker.retro'];
    connectedDecisionInput.summarySegmentIndexes = [0];
    connectedDecisionInput.tasks[0] = {
      recordId: mcpTaskUri,
      disposition: 'fold',
      reason: 'The cited transcript segment grounds the exact bounded MCP task candidate.',
      segmentIndexes: [0]
    };
    connectedDecisionInput.policies = contextPolicyBindings.map((binding, index) => ({
      contextEntryId: finalizedContext.snapshot.entries.find((entry) => {
        return entry.applicability?.sourceId === binding.sourceId;
      })?.id,
      outcome: 'allow',
      reason: 'The exact cited synthetic policy excerpt permits this contained selftest proposal.',
      citations: ['Synthetic applicable MCP policy body ' + index + '.']
    }));
    connectedDecisionInput.issues = [];
    connectedDecisionInput.limitations = [
      'This synthetic host decision proves contract binding only and does not establish live provider judgment quality.'
    ];
    const invalidConnectedDecision = structuredClone(connectedDecisionInput);
    invalidConnectedDecision.tasks[0].recordId
      = 'https://app.notion.com/p/00000000000000000000000000000000';
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
    const inspectedMeetingProposal = await call(client, 'soter_inspect_meeting_intake_proposal', {
      lock_path: lockPath,
      decision_id: committedDecision.decision.id
    });
    const committedMeetingProposal = await call(client, 'soter_commit_meeting_intake_proposal', {
      lock_path: lockPath,
      decision_id: committedDecision.decision.id,
      proposal_id: 'proposal.meeting-intake.mcp-decision-selftest',
      at: '2026-07-15T12:00:17.000Z'
    });
    const inspectedMeetingProposalMaterial = await call(
      client,
      'soter_inspect_meeting_intake_proposal_material',
      {
        lock_path: lockPath,
        proposal_id: committedMeetingProposal.proposal.id
      }
    );
    const meetingProposalActions = committedMeetingProposal.proposal.review.collections
      .flatMap((collection) => collection.rows)
      .flatMap((row) => row.actions);
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
      || inspectedMeetingProposal.decision?.id !== committedDecision.decision.id
      || inspectedMeetingProposal.decision?.fingerprint
        !== committedDecision.decision.decisionFingerprint
      || committedMeetingProposal.proposal?.authority?.state !== 'none'
      || committedMeetingProposal.run?.lifecycleState !== 'paused'
      || meetingProposalActions.length !== 3
      || meetingProposalActions.some((action) => {
        return action.state !== 'held'
          || action.capability !== null
          || action.effect !== null
          || Object.hasOwn(action, 'changeFingerprint');
      })
      || meetingProposalActions.filter((action) => {
        return ['action.meeting-intake.summary-create', 'action.meeting-intake.task-fold']
          .includes(action.id)
          && action.reasonCode === 'COMPLETE_MEETING_READBACK_UNAVAILABLE';
      }).length !== 2
      || !meetingProposalActions.some((action) => {
        return action.id === 'action.meeting-intake.unsupported-effects'
          && action.reasonCode === 'MEETING_LEGACY_EFFECTS_UNAVAILABLE';
      })
      || committedMeetingProposal.proposal.review.proposedChanges.length !== 0
      || inspectedMeetingProposalMaterial.authority?.state !== 'none'
      || !JSON.stringify(inspectedMeetingProposalMaterial).includes(
        'Ground this connected context before any write.'
      )
      || JSON.stringify(committedMeetingProposal).includes(
        'Ground this connected context before any write.'
      )) {
      throw new Error('MCP grounded Meeting decision or private proposal projection drifted.');
    }
    const cliMeetingInputPath = path.join(privateInputRoot, 'cli-meeting-intake.input.json');
    fs.writeFileSync(cliMeetingInputPath, JSON.stringify({
      meeting: 'meeting.fixture-001',
      recordingUri: 'https://otter.ai/u/meeting_fixture_001',
      operatorGoal: 'CLI_PRIVATE_MEETING_GOAL_SENTINEL'
    }, null, 2) + '\n', { mode: 0o600 });
    const cliMeetingPreparedWork = runCli(root, [
      'operator-prepare',
      '--configuration', 'meeting-intake',
      '--configuration-basis', 'private-active',
      '--preparation-mode', 'connected-acquisition',
      '--automation', 'automation.meeting-intake',
      '--input', cliMeetingInputPath,
      '--at', '2026-07-15T12:00:12.500Z'
    ]);
    const cliPreparedContext = runCli(root, [
      'context-connected-prepare',
      '--work', cliMeetingPreparedWork.id,
      '--at', '2026-07-15T12:00:13.000Z'
    ]);
    const cliClosedContext = runCli(root, [
      'host-fail',
      '--checkpoint', cliPreparedContext.checkpoint.id,
      '--call', cliPreparedContext.currentCall.id,
      '--kind', 'unavailable',
      '--at', '2026-07-15T12:00:14.000Z'
    ]);
    if (cliPreparedContext.checkpoint.currentStepId
        !== 'step.context-policy.' + contextPolicyBindings[0].id.slice('policy.'.length)
      || cliPreparedContext.currentCall.transport.tool
        !== 'mcp__codex_apps__notion_fetch'
      || cliClosedContext.checkpoint.state !== 'failed') {
      throw new Error('CLI connected-context preparation drifted from the shared Core service.');
    }

    await assertWrongHostRejected(root);
    await assertClaudeHostProjection(root);

    const cliProbe = runCli(root, [
      'probe-prepare',
      '--configuration-basis', 'private-active',
      '--lock', lockPath,
      '--provider', 'provider.integration.otter.mcp',
      '--probe-id', 'probe.cli-selftest.otter',
      '--at', fixtureTime
    ]);
    const cliIdentity = 'private-cli-identity-marker';
    const rejectedRepoResponse = invokeCli(root, [
      'probe-complete',
      '--checkpoint', cliProbe.checkpoint.id,
      '--call', cliProbe.currentCall.id,
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
      '--call', cliProbe.currentCall.id,
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

    const rateLimitedDoctorInvocation = invokeCli(root, [
      'doctor',
      '--lock', lockPath,
      '--level', 'connected',
      '--probe-checkpoint', cliCompleted.checkpoint.id,
      '--probe-checkpoint', rateLimitedNotionProbe.checkpoint.id,
      '--at', fixtureTime
    ]);
    if (!rateLimitedDoctorInvocation.stdout.trim()) {
      throw new Error(
        'Connected rate-limit doctor did not return JSON: '
        + (rateLimitedDoctorInvocation.stderr || 'no diagnostic')
      );
    }
    const rateLimitedDoctor = JSON.parse(rateLimitedDoctorInvocation.stdout);
    const rateLimitDiagnostic = rateLimitedDoctor.diagnostics.find((item) => {
      return item.code === 'SOTER_PROVIDER_PROBE_RATE_LIMIT'
        && item.subject === 'provider.integration.notion.mcp';
    });
    const rateLimitReachability = rateLimitedDoctor.checks.find((item) => {
      return item.id === 'integrations.reachable';
    });
    const rateLimitCapability = rateLimitedDoctor.checks.find((item) => {
      return item.id === 'integrations.capability-compatible';
    });
    if (rateLimitedDoctorInvocation.status !== 1
      || rateLimitedDoctor.states.valid !== 'passed'
      || rateLimitedDoctor.states.ready !== 'failed'
      || rateLimitReachability?.state !== 'failed'
      || rateLimitCapability?.state !== 'unknown'
      || !rateLimitDiagnostic
      || !rateLimitDiagnostic.remediation.includes('Wait for the provider limit window')
      || rateLimitedDoctor.diagnostics.some((item) => {
        return item.code === 'SOTER_PROVIDER_PROBE_MISSING'
          && item.subject === 'provider.integration.notion.mcp';
      })
      || rateLimitSentinels.some((sentinel) => {
        return JSON.stringify(rateLimitedDoctor).includes(sentinel);
      })) {
      throw new Error(
        'Connected doctor did not preserve the secret-safe Notion rate-limit classification.'
      );
    }

    const failedDoctorInvocation = invokeCli(root, [
      'doctor',
      '--lock', lockPath,
      '--level', 'connected',
      '--probe-checkpoint', failedProbe.checkpoint.id,
      '--probe-checkpoint', recoveredNotionProbe.checkpoint.id,
      '--at', fixtureTime
    ]);
    if (!failedDoctorInvocation.stdout.trim()) {
      throw new Error(
        'Connected failed-attempt doctor did not return JSON: '
        + (failedDoctorInvocation.stderr || 'no diagnostic')
      );
    }
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
    process.stderr.write('Soter MCP selftest: ' + (error.stack || error.message) + '\n');
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
