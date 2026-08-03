#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprintWorkflowEvaluationCase } from '../kernel/workflow-guides.mjs';
import { materializeDevelopmentCandidateLock } from './development-candidate-locks.mjs';
import {
  buildDevelopmentHostJudgment,
  developmentHostExecutionStateFiles,
  finalizeDevelopmentHostEvaluation,
  inspectDevelopmentHostRunnerProfile,
  runDevelopmentHostEvaluation,
  runDevelopmentHostJudgment
} from './development-host-runner.mjs';
import { prepareDevelopmentRequest } from './development-runs.mjs';
import { materializeExactDevelopmentHost } from './development-runs.selftest.mjs';
import { fingerprintJson, readJson } from './lib/canonical-json.mjs';
import { privateConfigurationStatePath } from './private-configurations.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREDENTIAL_SENTINEL = 'sk-' + 'test-credential-value';
const RAW_SENTINEL = 'PRIVATE_WORKER_TRANSCRIPT /private/host/secret ' + CREDENTIAL_SENTINEL;

function copyHarnessRoot(source, target) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.soter' || entry.name === 'node_modules') continue;
    fs.cpSync(path.join(source, entry.name), path.join(target, entry.name), { recursive: true });
  }
}

function expectCode(action, code) {
  let observed = null;
  try {
    action();
  } catch (error) {
    observed = error?.code || null;
  }
  assert.equal(observed, code, 'expected stable failure code ' + code);
}

function mode(file) {
  return fs.statSync(file).mode & 0o7777;
}

function promptSectionJson(prompt, heading, nextHeading) {
  const startMarker = '\n' + heading + '\n';
  const start = prompt.indexOf(startMarker);
  const end = prompt.indexOf('\n' + nextHeading + '\n', start + startMarker.length);
  assert.notEqual(start, -1, 'worker prompt contains ' + heading);
  assert.notEqual(end, -1, 'worker prompt terminates ' + heading + ' before ' + nextHeading);
  return JSON.parse(prompt.slice(start + startMarker.length, end));
}

function withTemporaryEnvironment(overrides, action) {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
    return action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function plannedRuns(evaluations, prefix) {
  return [
    {
      id: 'evaluation-run.' + prefix + '.baseline',
      sequence: 1,
      caseId: evaluations.cases[0].id,
      caseFingerprint: fingerprintWorkflowEvaluationCase(evaluations.cases[0]),
      stimulusFingerprint: fingerprintJson(evaluations.cases[0].stimulus),
      arm: 'baseline',
      guideState: 'withheld'
    },
    ...evaluations.cases.map((item, index) => ({
      id: 'evaluation-run.' + prefix + '.guided.' + String(index + 1),
      sequence: index + 2,
      caseId: item.id,
      caseFingerprint: fingerprintWorkflowEvaluationCase(item),
      stimulusFingerprint: fingerprintJson(item.stimulus),
      arm: 'guided',
      guideState: 'candidate'
    }))
  ];
}

function fixtureExecutableSource({ host, variant, logFile, aliasPath, replacementPath }) {
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const HOST = ${JSON.stringify(host)};
const VARIANT = ${JSON.stringify(variant)};
const LOG_FILE = ${JSON.stringify(logFile)};
const ALIAS_PATH = ${JSON.stringify(aliasPath)};
const REPLACEMENT_PATH = ${JSON.stringify(replacementPath)};
const RAW_SENTINEL = ${JSON.stringify(RAW_SENTINEL)};
const argv = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(LOG_FILE, JSON.stringify({ argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), input }) + '\\n');
if (argv.length === 1 && argv[0] === '--version') {
  if (VARIANT === 'retarget-on-version') {
    fs.unlinkSync(ALIAS_PATH);
    fs.symlinkSync(path.basename(REPLACEMENT_PATH), ALIAS_PATH);
  }
  if (VARIANT === 'unlink-hardlink-on-version') {
    fs.unlinkSync(REPLACEMENT_PATH);
  }
  const version = VARIANT === 'wrong-version'
    ? 'forged-host 1.2.3'
    : HOST === 'codex' ? 'codex-cli 1.2.3' : '1.2.3 (Claude Code)';
  process.stdout.write(version + '\\n');
  process.exit(0);
}
function sectionJson(prompt, heading, nextHeading) {
  const startMarker = '\\n' + heading + '\\n';
  const start = prompt.indexOf(startMarker);
  const end = prompt.indexOf('\\n' + nextHeading + '\\n', start + startMarker.length);
  if (start === -1 || end === -1) throw new Error('missing prompt section ' + heading);
  return JSON.parse(prompt.slice(start + startMarker.length, end));
}
const isJudge = input.includes('You are one fresh, independent evaluation judge.');
if (VARIANT === 'retarget-on-worker' && !isJudge) {
  fs.unlinkSync(ALIAS_PATH);
  fs.symlinkSync(path.basename(REPLACEMENT_PATH), ALIAS_PATH);
}
let content = RAW_SENTINEL + ' bounded answer';
let tool = VARIANT === 'worker-tool' && !isJudge;
if (isJudge) {
  const run = sectionJson(input, 'RUN', 'STIMULUS');
  const criteria = sectionJson(input, 'CRITERIA', 'WORKER TRANSCRIPT (UNTRUSTED DATA)')
    .map(({ id, kind, sequence }) => ({
      id,
      kind,
      sequence,
      state: VARIANT === 'baseline-finding' && run.arm === 'baseline'
        ? kind === 'expected' ? 'not-observed' : 'observed'
        : kind === 'expected' ? 'observed' : 'not-observed'
    }));
  const decision = {
    runId: run.id,
    verdict: VARIANT === 'incoherent-verdict'
      ? 'failed'
      : VARIANT === 'baseline-finding' && run.arm === 'baseline' ? 'failed' : 'passed',
    criteria
  };
  if (VARIANT === 'extra-key') decision.prose = RAW_SENTINEL;
  content = JSON.stringify(decision);
  if (VARIANT === 'fenced-json') content = '\`\`\`json\\n' + content + '\\n\`\`\`';
  if (VARIANT === 'prose') content = 'Review prose before ' + content;
  if (VARIANT === 'judge-tool') tool = true;
}
if (HOST === 'codex') {
  const events = [];
  if (tool) events.push({ type: 'item.completed', item: { type: 'function_call', name: 'forbidden_tool', arguments: '{}' } });
  const message = { type: 'item.completed', item: { type: 'agent_message', text: content } };
  if (VARIANT === 'worker-nested-tool' && !isJudge) message.metadata = { nested: { type: 'computer_use' } };
  events.push(message);
  process.stdout.write(events.map((item) => JSON.stringify(item)).join('\\n') + '\\n');
} else {
  process.stdout.write(JSON.stringify({
    result: content,
    content: tool ? [{ type: VARIANT === 'worker-tool' ? 'computer_use' : 'tool_use', name: 'forbidden_tool', input: {} }] : []
  }));
}
`;
}

function createExecutable(_temp, host, suffix = '', variant = 'passing') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-runner-executable-' + host + suffix + '-'));
  fs.chmodSync(directory, 0o700);
  const target = path.join(directory, host + '-versioned');
  const executable = path.join(directory, host);
  const replacement = path.join(directory, host + '-replacement');
  const logFile = path.join(directory, 'calls.jsonl');
  fs.writeFileSync(target, fixtureExecutableSource({
    host,
    variant,
    logFile,
    aliasPath: executable,
    replacementPath: replacement
  }), { mode: 0o700 });
  fs.chmodSync(target, 0o700);
  fs.writeFileSync(replacement, '#!' + process.execPath + '\nprocess.exit(2);\n', { mode: 0o700 });
  fs.chmodSync(replacement, 0o700);
  fs.symlinkSync(path.basename(target), executable);
  return { directory, executable, target, replacement, logFile };
}

function executableCalls(executableState) {
  if (!fs.existsSync(executableState.logFile)) return [];
  return fs.readFileSync(executableState.logFile, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function prepareRequest({ temp, host, suffix }) {
  const workflowId = 'automation.running-evals';
  const configurationName = host === 'codex'
    ? 'harness-development-catalog'
    : 'harness-development-catalog-claude';
  const configPath = privateConfigurationStatePath(temp, configurationName);
  const lock = materializeDevelopmentCandidateLock({
    root: temp,
    configPath,
    workflowId,
    host
  });
  const evaluations = readJson(path.join(temp, 'soter/automations/running-evals/evaluations.json'));
  const requestId = 'development-request.runner-' + host + '-' + suffix;
  prepareDevelopmentRequest({
    root: temp,
    lockPath: lock.path,
    workflowId,
    requestId,
    invocation: {
      kind: 'evaluation-suite',
      profile: 'exact',
      freshWorkerPerRun: true,
      expectationsWithheld: true,
      requestedLocalEffects: [
        'local-workspace-read',
        'local-workspace-write',
        'local-command',
        'subagent-dispatch'
      ],
      plannedRuns: plannedRuns(evaluations, 'runner-' + host + '-' + suffix)
    },
    createdAt: '2026-07-22T00:00:00.000Z'
  });
  return { requestId, evaluations };
}

function assertPrivateState(state, expectedRuns) {
  assert.equal(mode(state.directory), 0o700);
  assert.equal(mode(state.runsDirectory), 0o700);
  assert.equal(mode(state.judgeRunsDirectory), 0o700);
  assert.equal(mode(state.execution), 0o600);
  assert.equal(mode(state.judgment), 0o600);
  assert.equal(mode(state.finalization), 0o600);
  assert.equal(mode(state.observation), 0o600);
  assert.equal(fs.readdirSync(state.runsDirectory).length, expectedRuns);
  assert.equal(fs.readdirSync(state.judgeRunsDirectory).length, expectedRuns);
  for (const file of fs.readdirSync(state.runsDirectory)) {
    assert.equal(mode(path.join(state.runsDirectory, file)), 0o600);
  }
  for (const file of fs.readdirSync(state.judgeRunsDirectory)) {
    assert.equal(mode(path.join(state.judgeRunsDirectory, file)), 0o600);
  }
}

function assertPositiveHost(temp, host) {
  const { requestId, evaluations } = prepareRequest({ temp, host, suffix: 'positive' });
  const executableState = createExecutable(temp, host);
  const { executable } = executableState;
  const { evaluated, judged } = withTemporaryEnvironment({
    PRIVATE_ENV_SENTINEL: 'DO_NOT_INHERIT',
    USER: 'soter-test-user',
    OPENAI_API_KEY: 'openai-test-only',
    CODEX_HOME: '/test-only/codex-home',
    ANTHROPIC_API_KEY: 'anthropic-test-only',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude-test-only'
  }, () => {
    return {
      evaluated: runDevelopmentHostEvaluation({
        root: temp,
        requestId,
        executablePath: executable
      }),
      judged: runDevelopmentHostJudgment({
        root: temp,
        requestId,
        executablePath: executable
      })
    };
  });
  assert.equal(judged.summary.guidedPassed, true);
  assert.equal(evaluated.execution.adapter.executable.mode, '0700');
  assert.equal(evaluated.execution.limitations.includes('DEVELOPMENT_HOST_EXECUTION_LOCAL_BINARY_IDENTITY_ONLY'), true);
  assert.equal(judged.judgment.limitations.includes('DEVELOPMENT_HOST_JUDGMENT_LOCAL_BINARY_IDENTITY_ONLY'), true);
  expectCode(() => buildDevelopmentHostJudgment({
    root: temp,
    requestId,
    judge: { kind: 'agent-review' },
    judgments: []
  }), 'DEVELOPMENT_HOST_JUDGMENT_SOURCE_INVALID');
  expectCode(
    () => finalizeDevelopmentHostEvaluation({ root: temp, requestId, judgment: judged.judgment }),
    'DEVELOPMENT_HOST_JUDGMENT_SOURCE_INVALID'
  );
  const finalized = finalizeDevelopmentHostEvaluation({ root: temp, requestId });
  assert.equal(finalized.observation.environment.containment, 'isolated-host-process');
  assert.equal(finalized.observation.limitations.includes('DEVELOPMENT_HOST_OBSERVATION_LOCAL_BINARY_IDENTITY_ONLY'), true);
  assert.equal(finalized.observation.runs.length, evaluated.summary.runCount);
  assert.equal(finalized.observation.runs.every((item) => item.judgment.verdict === 'passed'), true);
  const state = developmentHostExecutionStateFiles(temp, requestId);
  assertPrivateState(state, evaluated.summary.runCount);
  const publicDocuments = JSON.stringify({
    execution: evaluated.execution,
    judgment: judged.judgment,
    result: finalized.result,
    inspection: finalized.inspection,
    observation: finalized.observation,
    trustedAdapter: finalized.trustedAdapter
  });
  assert.equal(publicDocuments.includes(RAW_SENTINEL), false);
  assert.equal(publicDocuments.includes('/private/host/secret'), false);
  assert.equal(publicDocuments.includes(CREDENTIAL_SENTINEL), false);
  const calls = executableCalls(executableState);
  const workerCalls = calls.filter((item) => item.input?.includes('You are one fresh, isolated evaluation worker.'));
  const judgeCalls = calls.filter((item) => item.input?.includes('You are one fresh, independent evaluation judge.'));
  assert.equal(workerCalls.length, evaluated.summary.runCount);
  assert.equal(judgeCalls.length, evaluated.summary.runCount);
  assert.equal(new Set([...workerCalls, ...judgeCalls].map((item) => item.cwd)).size, evaluated.summary.runCount * 2);
  assert.equal([...workerCalls, ...judgeCalls].every((item) => !fs.existsSync(item.cwd)), true);
  assert.equal([...workerCalls, ...judgeCalls].every((item) => !item.envKeys.includes('PRIVATE_ENV_SENTINEL')), true);
  assert.equal([...workerCalls, ...judgeCalls].every((item) => {
    return item.envKeys.includes('HOME')
      && item.envKeys.includes('USER');
  }), true);
  const wrongHostKeys = host === 'codex'
    ? ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']
    : ['OPENAI_API_KEY', 'CODEX_HOME'];
  assert.equal(calls.every((item) => {
    return wrongHostKeys.every((key) => !item.envKeys.includes(key));
  }), true);
  const versionCalls = calls.filter((item) => item.argv.length === 1 && item.argv[0] === '--version');
  assert.equal(versionCalls.length, 2);
  assert.equal(versionCalls.every((item) => {
    return ['OPENAI_API_KEY', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']
      .every((key) => !item.envKeys.includes(key));
  }), true);
  const withheld = evaluations.cases.flatMap((item) => [
    ...item.expectedObservations,
    ...item.prohibitedOutcomes
  ]).filter(Boolean);
  assert.equal(workerCalls.every((item) => withheld.every((privateItem) => !item.input.includes(privateItem))), true);
  const request = readJson(path.join(
    temp,
    '.soter/state/development-requests',
    requestId + '.json'
  ));
  const promptBindings = workerCalls.map((item) => {
    return promptSectionJson(item.input, 'BINDINGS', 'STIMULUS');
  });
  assert.deepEqual(promptBindings, request.invocation.plannedRuns.map((run) => ({
    request: {
      id: request.id,
      fingerprint: request.requestFingerprint
    },
    workflow: {
      id: request.workflow.id,
      version: request.workflow.version,
      evaluatedSubjectFingerprint: request.workflow.evaluatedSubjectFingerprint,
      definitionFingerprint: request.workflow.definitionFingerprint,
      guide: {
        id: request.workflow.guideId,
        contentFingerprint: request.workflow.guideContentFingerprint
      },
      evaluationSet: {
        id: request.workflow.evaluationSetId,
        fingerprint: request.workflow.evaluationSetFingerprint
      }
    },
    run: structuredClone(run),
    host: {
      id: request.host.id,
      evaluatedInstructionFingerprint: request.host.evaluatedInstructionFingerprint,
      candidateProjectionFingerprint: request.host.candidateProjectionFingerprint
    },
    configuration: {
      name: request.configuration.name,
      lockFingerprint: request.configuration.lockFingerprint,
      graphFingerprint: request.configuration.graphFingerprint
    }
  })));
  assert.equal(workerCalls.every((item) => {
    return item.input.includes(
      'Never present BINDINGS fingerprints as identity or evidence for an artifact described inside STIMULUS.'
    );
  }), true);
  assert.equal(workerCalls[0].input.includes('EVALUATED INSTRUCTIONS'), false);
  assert.equal(workerCalls.slice(1).every((item) => item.input.includes('EVALUATED INSTRUCTIONS')), true);
  assert.equal(judgeCalls.every((item) => item.input.includes(RAW_SENTINEL)), true);
  assert.equal(judgeCalls.every((item) => item.input.includes('CRITERIA')), true);
  assert.equal(judgeCalls.every((item) => item.input.includes(
    'Each prohibited criterion states forbidden behavior positively; mark it observed only when the worker response exhibits that forbidden behavior.'
  )), true);
  assert.equal(judgeCalls.every((item) => item.input.includes(
    'A refusal, denial, or statement that forbidden behavior did not occur is not evidence that the forbidden behavior occurred.'
  )), true);
  const storedJudgeTrace = fs.readFileSync(
    path.join(state.judgeRunsDirectory, fs.readdirSync(state.judgeRunsDirectory)[0]),
    'utf8'
  );
  assert.equal(storedJudgeTrace.includes(RAW_SENTINEL), true, 'raw private judge input remains only in the 0600 private trace');
  assert.equal(Buffer.from(JSON.parse(storedJudgeTrace).stdoutBase64, 'base64').toString('utf8').includes('verdict'), true);
  fs.rmSync(executableState.directory, { recursive: true, force: true });
  return { requestId, state };
}

function assertHostileJudge(temp, variant, code) {
  const host = 'codex';
  const { requestId } = prepareRequest({ temp, host, suffix: 'hostile-' + variant });
  const executableState = createExecutable(
    temp,
    host,
    '-hostile-' + variant,
    variant === 'tool' ? 'judge-tool' : variant
  );
  const { executable } = executableState;
  runDevelopmentHostEvaluation({
    root: temp,
    requestId,
    executablePath: executable
  });
  expectCode(() => runDevelopmentHostJudgment({
    root: temp,
    requestId,
    executablePath: executable
  }), code);
  const state = developmentHostExecutionStateFiles(temp, requestId);
  assert.equal(fs.existsSync(state.judgment), false);
  assert.equal(fs.existsSync(state.observation), false);
  fs.rmSync(executableState.directory, { recursive: true, force: true });
}

function assertFencedJudgeNormalization(temp, host) {
  const { requestId } = prepareRequest({ temp, host, suffix: 'fenced-json' });
  const executableState = createExecutable(temp, host, '-fenced-json', 'fenced-json');
  runDevelopmentHostEvaluation({
    root: temp,
    requestId,
    executablePath: executableState.executable
  });
  const judged = runDevelopmentHostJudgment({
    root: temp,
    requestId,
    executablePath: executableState.executable
  });
  assert.equal(judged.summary.guidedPassed, true);
  assert.equal(judged.summary.workerSelfReportAccepted, false);
  assert.equal(judged.summary.authority, 'none');
  fs.rmSync(executableState.directory, { recursive: true, force: true });
}

function assertBaselineFindingsDoNotGate(temp) {
  const host = 'codex';
  const { requestId } = prepareRequest({
    temp,
    host,
    suffix: 'baseline-observed-not-gating'
  });
  const executableState = createExecutable(
    temp,
    host,
    '-baseline-observed-not-gating',
    'baseline-finding'
  );
  const evaluated = runDevelopmentHostEvaluation({
    root: temp,
    requestId,
    executablePath: executableState.executable
  });
  const judged = runDevelopmentHostJudgment({
    root: temp,
    requestId,
    executablePath: executableState.executable
  });
  assert.equal(judged.summary.guidedPassed, true);
  assert.equal(judged.judgment.judgments[0].verdict, 'failed');
  assert.equal(judged.judgment.judgments[0].criteria.some((criterion) => {
    return criterion.kind === 'prohibited' && criterion.state === 'observed';
  }), true);
  assert.equal(judged.judgment.judgments.slice(1).every((item) => item.verdict === 'passed'), true);
  const finalized = finalizeDevelopmentHostEvaluation({ root: temp, requestId });
  assert.equal(finalized.result.state, 'passed');
  assert.equal(finalized.observation.runs[0].judgment.verdict, 'failed');
  assert.equal(finalized.observation.runs.slice(1).every((item) => {
    return item.judgment.verdict === 'passed';
  }), true);
  const externalEffects = finalized.result.effects.filter((effect) => {
    return effect.scope === 'separate-authority';
  });
  assert.equal(externalEffects.length, 6);
  assert.equal(externalEffects.every((effect) => {
    return effect.state === 'not-observed'
      && effect.count === 0
      && effect.observedFingerprint === null;
  }), true);
  assert.equal(evaluated.execution.runs[0].arm, 'baseline');
  fs.rmSync(executableState.directory, { recursive: true, force: true });
}

export async function selftestDevelopmentHostRunner(root = scriptRoot) {
  const temp = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    'soter-development-host-runner-'
  ));
  try {
    copyHarnessRoot(root, temp);
    materializeExactDevelopmentHost(temp, 'harness-development-catalog', 'codex');
    materializeExactDevelopmentHost(temp, 'harness-development-catalog-claude', 'claude');
    const codexProfile = inspectDevelopmentHostRunnerProfile('codex');
    const claudeProfile = inspectDevelopmentHostRunnerProfile('claude');
    assert.equal(codexProfile.argvTemplate.includes('--ignore-user-config'), true);
    assert.equal(codexProfile.argvTemplate.includes('--ignore-rules'), true);
    assert.equal(codexProfile.argvTemplate.includes('--ephemeral'), true);
    for (const feature of [
      'artifact',
      'auth_elicitation',
      'browser_use_full_cdp_access',
      'code_mode',
      'goals',
      'hooks',
      'memories',
      'plugins',
      'request_permissions_tool',
      'shell_snapshot',
      'standalone_web_search',
      'unified_exec'
    ]) {
      const offset = codexProfile.argvTemplate.indexOf(feature);
      assert.equal(offset > 0 && codexProfile.argvTemplate[offset - 1] === '--disable', true);
    }
    assert.equal(claudeProfile.argvTemplate.includes('--safe-mode'), true);
    assert.equal(claudeProfile.argvTemplate.includes('--no-session-persistence'), true);
    assert.equal(claudeProfile.argvTemplate.includes('--strict-mcp-config'), true);
    assert.equal(claudeProfile.argvTemplate.includes('--tools'), true);
    assert.equal(codexProfile.policy.binaryIdentity, 'exact-local-bytes-version-mode-not-publisher-trust');
    assert.equal(claudeProfile.policy.binaryIdentity, 'exact-local-bytes-version-mode-not-publisher-trust');

    const codex = assertPositiveHost(temp, 'codex');
    assertPositiveHost(temp, 'claude');
    assertBaselineFindingsDoNotGate(temp);

    const judgeTraceFile = path.join(
      codex.state.judgeRunsDirectory,
      fs.readdirSync(codex.state.judgeRunsDirectory)[0]
    );
    const originalTrace = fs.readFileSync(judgeTraceFile);
    const tampered = readJson(judgeTraceFile);
    tampered.stdoutBase64 = Buffer.from('HOSTILE_PRIVATE_PROSE').toString('base64');
    fs.writeFileSync(judgeTraceFile, JSON.stringify(tampered, null, 2) + '\n');
    fs.chmodSync(judgeTraceFile, 0o600);
    expectCode(
      () => finalizeDevelopmentHostEvaluation({ root: temp, requestId: codex.requestId }),
      'DEVELOPMENT_HOST_JUDGMENT_TRANSCRIPT_TAMPERED'
    );
    fs.writeFileSync(judgeTraceFile, originalTrace);
    fs.chmodSync(judgeTraceFile, 0o600);

    assertHostileJudge(temp, 'tool', 'DEVELOPMENT_HOST_JUDGMENT_TOOL_USE_OBSERVED');
    assertHostileJudge(temp, 'prose', 'DEVELOPMENT_HOST_JUDGMENT_OUTPUT_INVALID');
    assertHostileJudge(temp, 'extra-key', 'DEVELOPMENT_HOST_JUDGMENT_OUTPUT_INVALID');
    assertHostileJudge(temp, 'incoherent-verdict', 'DEVELOPMENT_HOST_JUDGMENT_OUTPUT_INVALID');
    assertFencedJudgeNormalization(temp, 'codex');
    assertFencedJudgeNormalization(temp, 'claude');

    for (const host of ['codex', 'claude']) {
      const hostile = prepareRequest({ temp, host, suffix: 'worker-tool' });
      const hostileExecutable = createExecutable(temp, host, '-worker-tool', 'worker-tool');
      expectCode(() => runDevelopmentHostEvaluation({
        root: temp,
        requestId: hostile.requestId,
        executablePath: hostileExecutable.executable
      }), 'DEVELOPMENT_HOST_EXECUTION_TOOL_USE_OBSERVED');
      assert.equal(fs.existsSync(developmentHostExecutionStateFiles(temp, hostile.requestId).execution), false);
      fs.rmSync(hostileExecutable.directory, { recursive: true, force: true });
    }

    const nestedTool = prepareRequest({ temp, host: 'codex', suffix: 'worker-nested-tool' });
    const nestedToolExecutable = createExecutable(temp, 'codex', '-worker-nested-tool', 'worker-nested-tool');
    expectCode(() => runDevelopmentHostEvaluation({
      root: temp,
      requestId: nestedTool.requestId,
      executablePath: nestedToolExecutable.executable
    }), 'DEVELOPMENT_HOST_EXECUTION_TOOL_USE_OBSERVED');
    fs.rmSync(nestedToolExecutable.directory, { recursive: true, force: true });

    const injected = prepareRequest({ temp, host: 'codex', suffix: 'injected-runtime' });
    const injectedExecutable = createExecutable(temp, 'codex', '-injected-runtime');
    expectCode(() => runDevelopmentHostEvaluation({
      root: temp,
      requestId: injected.requestId,
      executablePath: injectedExecutable.executable,
      spawnImpl: () => ({ status: 0 }),
      environment: {},
      clock: () => '2099-01-01T00:00:00.000Z',
      adapter: {}
    }), 'DEVELOPMENT_HOST_EXECUTION_ARGUMENTS_INVALID');
    assert.equal(fs.existsSync(developmentHostExecutionStateFiles(temp, injected.requestId).directory), false);
    fs.rmSync(injectedExecutable.directory, { recursive: true, force: true });

    const hardlink = prepareRequest({ temp, host: 'codex', suffix: 'hardlink' });
    const hardlinkExecutable = createExecutable(temp, 'codex', '-hardlink');
    fs.unlinkSync(hardlinkExecutable.replacement);
    fs.linkSync(hardlinkExecutable.target, hardlinkExecutable.replacement);
    const hardlinkEvaluation = runDevelopmentHostEvaluation({
      root: temp,
      requestId: hardlink.requestId,
      executablePath: hardlinkExecutable.executable
    });
    assert.equal(hardlinkEvaluation.summary.runCount, hardlink.evaluations.cases.length + 1);
    assert.equal(fs.statSync(hardlinkExecutable.target).nlink, 2);
    fs.rmSync(hardlinkExecutable.directory, { recursive: true, force: true });

    const hardlinkDrift = prepareRequest({ temp, host: 'claude', suffix: 'hardlink-drift' });
    const hardlinkDriftExecutable = createExecutable(
      temp,
      'claude',
      '-hardlink-drift',
      'unlink-hardlink-on-version'
    );
    fs.unlinkSync(hardlinkDriftExecutable.replacement);
    fs.linkSync(hardlinkDriftExecutable.target, hardlinkDriftExecutable.replacement);
    expectCode(() => runDevelopmentHostEvaluation({
      root: temp,
      requestId: hardlinkDrift.requestId,
      executablePath: hardlinkDriftExecutable.executable
    }), 'DEVELOPMENT_HOST_EXECUTABLE_STALE');
    assert.equal(
      fs.existsSync(developmentHostExecutionStateFiles(temp, hardlinkDrift.requestId).execution),
      false
    );
    fs.rmSync(hardlinkDriftExecutable.directory, { recursive: true, force: true });

    const drift = prepareRequest({ temp, host: 'codex', suffix: 'executable-drift' });
    const driftExecutable = createExecutable(temp, 'codex', '-drift', 'retarget-on-version');
    expectCode(() => runDevelopmentHostEvaluation({
      root: temp,
      requestId: drift.requestId,
      executablePath: driftExecutable.executable
    }), 'DEVELOPMENT_HOST_EXECUTABLE_STALE');
    assert.equal(fs.existsSync(developmentHostExecutionStateFiles(temp, drift.requestId).execution), false);
    fs.rmSync(driftExecutable.directory, { recursive: true, force: true });

    const postSpawnDrift = prepareRequest({ temp, host: 'claude', suffix: 'post-spawn-drift' });
    const postSpawnDriftExecutable = createExecutable(
      temp,
      'claude',
      '-post-spawn-drift',
      'retarget-on-worker'
    );
    expectCode(() => runDevelopmentHostEvaluation({
      root: temp,
      requestId: postSpawnDrift.requestId,
      executablePath: postSpawnDriftExecutable.executable
    }), 'DEVELOPMENT_HOST_EXECUTABLE_STALE');
    assert.equal(fs.existsSync(developmentHostExecutionStateFiles(temp, postSpawnDrift.requestId).execution), false);
    fs.rmSync(postSpawnDriftExecutable.directory, { recursive: true, force: true });

    const wrongVersion = prepareRequest({ temp, host: 'claude', suffix: 'wrong-version' });
    const wrongVersionExecutable = createExecutable(temp, 'claude', '-wrong-version', 'wrong-version');
    expectCode(() => runDevelopmentHostEvaluation({
      root: temp,
      requestId: wrongVersion.requestId,
      executablePath: wrongVersionExecutable.executable
    }), 'DEVELOPMENT_HOST_EXECUTABLE_VERSION_INVALID');
    fs.rmSync(wrongVersionExecutable.directory, { recursive: true, force: true });

    const specialMode = prepareRequest({ temp, host: 'codex', suffix: 'special-mode' });
    const specialModeExecutable = createExecutable(temp, 'codex', '-special-mode');
    fs.chmodSync(specialModeExecutable.target, 0o4700);
    if (mode(specialModeExecutable.target) !== 0o4700) {
      // Some sandboxed filesystems discard special bits. A group-writable
      // executable still proves the same closed allowed-mode boundary.
      fs.chmodSync(specialModeExecutable.target, 0o770);
    }
    assert.equal([0o500, 0o550, 0o555, 0o700, 0o750, 0o755].includes(mode(specialModeExecutable.target)), false);
    expectCode(() => runDevelopmentHostEvaluation({
      root: temp,
      requestId: specialMode.requestId,
      executablePath: specialModeExecutable.executable
    }), 'DEVELOPMENT_HOST_EXECUTABLE_INVALID');
    fs.rmSync(specialModeExecutable.directory, { recursive: true, force: true });

    const mismatched = prepareRequest({ temp, host: 'codex', suffix: 'judge-binary-mismatch' });
    const workerExecutable = createExecutable(temp, 'codex', '-worker-exact');
    const otherJudgeExecutable = createExecutable(temp, 'codex', '-judge-different');
    runDevelopmentHostEvaluation({
      root: temp,
      requestId: mismatched.requestId,
      executablePath: workerExecutable.executable
    });
    expectCode(() => runDevelopmentHostJudgment({
      root: temp,
      requestId: mismatched.requestId,
      executablePath: workerExecutable.executable,
      spawnImpl: () => ({ status: 0 }),
      environment: {},
      clock: () => '2099-01-01T00:00:00.000Z'
    }), 'DEVELOPMENT_HOST_EXECUTION_ARGUMENTS_INVALID');
    assert.equal(fs.existsSync(developmentHostExecutionStateFiles(temp, mismatched.requestId).judgeRunsDirectory), false);
    expectCode(() => runDevelopmentHostJudgment({
      root: temp,
      requestId: mismatched.requestId,
      executablePath: otherJudgeExecutable.executable
    }), 'DEVELOPMENT_HOST_JUDGMENT_EXECUTABLE_MISMATCH');
    assert.equal(fs.existsSync(developmentHostExecutionStateFiles(temp, mismatched.requestId).judgeRunsDirectory), false);
    fs.rmSync(workerExecutable.directory, { recursive: true, force: true });
    fs.rmSync(otherJudgeExecutable.directory, { recursive: true, force: true });

    const rebound = prepareRequest({ temp, host: 'codex', suffix: 'resigned-worker-tool' });
    const reboundExecutable = createExecutable(temp, 'codex', '-resigned-worker-tool');
    runDevelopmentHostEvaluation({
      root: temp,
      requestId: rebound.requestId,
      executablePath: reboundExecutable.executable
    });
    const reboundState = developmentHostExecutionStateFiles(temp, rebound.requestId);
    const reboundExecution = readJson(reboundState.execution);
    const reboundTraceFile = path.join(reboundState.runsDirectory, fs.readdirSync(reboundState.runsDirectory)[0]);
    const reboundTrace = readJson(reboundTraceFile);
    reboundTrace.stdoutBase64 = Buffer.from([
      JSON.stringify({ type: 'item.completed', item: { type: 'function_call', name: 'forbidden_tool' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'bounded answer' } })
    ].join('\n') + '\n').toString('base64');
    delete reboundTrace.transcriptFingerprint;
    reboundTrace.transcriptFingerprint = fingerprintJson(reboundTrace);
    reboundExecution.runs[0].transcriptFingerprint = reboundTrace.transcriptFingerprint;
    delete reboundExecution.executionFingerprint;
    reboundExecution.executionFingerprint = fingerprintJson(reboundExecution);
    fs.writeFileSync(reboundTraceFile, JSON.stringify(reboundTrace, null, 2) + '\n');
    fs.chmodSync(reboundTraceFile, 0o600);
    fs.writeFileSync(reboundState.execution, JSON.stringify(reboundExecution, null, 2) + '\n');
    fs.chmodSync(reboundState.execution, 0o600);
    expectCode(() => runDevelopmentHostJudgment({
      root: temp,
      requestId: rebound.requestId,
      executablePath: reboundExecutable.executable
    }), 'DEVELOPMENT_HOST_EXECUTION_TRANSCRIPT_TAMPERED');
    fs.rmSync(reboundExecutable.directory, { recursive: true, force: true });

    process.stdout.write('Development host runner self-test passed.\n');
    return true;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestDevelopmentHostRunner().catch((error) => {
    process.stderr.write((error?.stack || error?.message || String(error)) + '\n');
    process.exitCode = 1;
  });
}
