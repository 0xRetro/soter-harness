import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWorkspace } from '../../core/inspection.mjs';
import { createFixtureRuntimeState, invokeCapability } from '../../core/capabilities.mjs';
import {
  fingerprintJson,
  fingerprintPath,
  readJson,
  repoRelativePath,
  resolveRepoPath,
  writeJson
} from '../../core/lib/canonical-json.mjs';
import {
  privateConfigurationStatePath,
  writePrivateConfigurationState
} from '../../core/private-configurations.mjs';
import {
  inspectPreparedAutomationWork,
  prepareAutomationRun
} from '../../core/prepared-work.mjs';
import { fingerprintLock, resolveConfiguration } from '../../core/resolve.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';
import {
  runStatePath,
  writeActiveConfigurationLockState
} from '../../core/runtime-state.mjs';
import { completeDurableOperationPlanExecution } from '../../core/service.mjs';
import {
  completeDurableConnectedTransactionExecution,
  failDurableHostExecution,
  prepareDurableConnectedTransactionExecution,
  prepareDurableConnectedTransactionReconciliation
} from '../../core/service.mjs';
import {
  beginProposalConnectedApprovalRequest,
  confirmProposalConnectedApprovalRequest
} from '../../core/operator-authority.mjs';
import { inspectConnectedApprovalReviewMaterial } from '../../core/connected-approval-review.mjs';
import { inspectConnectedOperatorActivity } from '../../core/operator-inspection.mjs';
import {
  assertProposalConnectedBatch,
  createProposalConnectedBatch
} from '../../core/proposal-connected-batches.mjs';
import {
  assertVerifiedConnectedWriteIsNotPaginated,
  completeVerifiedConnectedTransactionCall,
  prepareVerifiedConnectedTransactionReconciliation
} from '../../core/verified-connected-transaction-runtime.mjs';
import {
  finalizeEmailTriageConnectedAcquisition,
  prepareEmailTriageConnectedAcquisition
} from './context.mjs';
import {
  commitEmailTriageDecision,
  inspectEmailTriageDecisionContext
} from './decision.mjs';
import {
  commitEmailTriageProposal,
  inspectEmailTriageProposalDecision,
  inspectEmailTriageProposalMaterial
} from './proposal.mjs';
import {
  completeMcp,
  completeProbePlanStepMcp,
  finalizeProbePlanMcp,
  prepareProbePlanMcp
} from '../../integrations/gmail/mcp.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AT = '2026-07-16T20:00:00.000Z';

function copyHarness(root) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soter-email-context-selftest-'));
  for (const directory of ['soter']) {
    fs.cpSync(path.join(root, directory), path.join(temporaryRoot, directory), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  return temporaryRoot;
}

function createRun(root, lock, workId) {
  const suffix = workId.slice('work.email-triage.'.length);
  const work = inspectPreparedAutomationWork({ root, workId });
  const lockPath = work.configuration.lockPath;
  const runPath = repoRelativePath(root, runStatePath(root, work.checkpoint.runId));
  const run = readJson(resolveRepoPath(root, runPath));
  assert.equal(run.id, work.checkpoint.runId);
  assert.equal(run.configurationLock.path, lockPath);
  assert.equal(run.configurationLock.fingerprint, work.configuration.lockFingerprint);
  const copiedLockPath = 'private/email-triage.' + suffix + '.copied.lock.json';
  const unrelatedRunPath = 'private/email-triage.' + suffix + '.unrelated.run.json';
  writeJson(path.join(root, copiedLockPath), lock);
  const unrelatedRun = prepareRunEnvelope({
    root,
    lock,
    lockPath: copiedLockPath,
    automationId: 'automation.email-triage',
    runId: 'run.email-triage.unrelated.' + suffix,
    createdAt: AT,
    requestedOutcome: 'Hostile unrelated matching-Automation run that must never be selected.'
  });
  writeJson(path.join(root, unrelatedRunPath), unrelatedRun);
  return { lockPath, runPath, run, copiedLockPath, unrelatedRunPath, unrelatedRun };
}

function materializeEmailPrivateConfiguration(root) {
  const configurationName = 'email-triage';
  const configuration = readJson(path.join(
    root,
    'soter/configurations/email-triage.config.json'
  ));
  writePrivateConfigurationState(root, configurationName, configuration);
  const lock = resolveConfiguration({
    root,
    configPath: privateConfigurationStatePath(root, configurationName),
    host: 'codex'
  });
  writeActiveConfigurationLockState(root, configurationName, lock);
  return { configuration, lock };
}

function installPaginatedGmailSelftestProvider(root) {
  const providerPath = path.join(
    root,
    'soter/providers/provider.integration.gmail.mcp.json'
  );
  const originalProvider = fs.readFileSync(providerPath, 'utf8');
  const wrapperPath = path.join(root, 'private/email-pagination-selftest.mjs');
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(wrapperPath, [
    "import { fingerprintJson } from '../soter/core/lib/canonical-json.mjs';",
    "import {",
    "  prepareMcp as prepareBase,",
    "  completeMcp as completeBase",
    "} from '../soter/integrations/gmail/mcp.mjs';",
    '',
    'export function prepareMcp(args) {',
    '  const request = prepareBase(args);',
    "  if (args.capability === 'mail.labels.read' && args.continuation?.cursor) {",
    '    return {',
    '      ...request,',
    '      arguments: { ...request.arguments, page_token: args.continuation.cursor }',
    '    };',
    '  }',
    '  return request;',
    '}',
    '',
    'export const completeMcp = completeBase;',
    '',
    'export function completeMcpPage({ capability, response }) {',
    "  if (capability !== 'mail.labels.read') {",
    "    throw new Error('Pagination selftest implements only mail.labels.read.');",
    '  }',
    '  const result = response?.structuredContent?.result;',
    '  if (!result || !Array.isArray(result.messages) || !result.continuation) {',
    "    throw new Error('Pagination selftest response is malformed.');",
    '  }',
    '  const messages = result.messages.map((record) => ({',
    '    id: record.id,',
    '    labels: [...record.labels]',
    '  }));',
    '  return {',
    '    page: {',
    '      observedCount: messages.length,',
    '      includedCount: messages.length,',
    '      excludedCount: 0,',
    '      observedIdentityFingerprints: messages.map((record) => {',
    '        return fingerprintJson({ messageId: record.id });',
    '      }),',
    '      data: { messages }',
    '    },',
    '    continuation: structuredClone(result.continuation)',
    '  };',
    '}',
    '',
    'export function finalizeMcpPages({',
    '  capability, input, authority, responseProfile, pages, coverage, at',
    '}) {',
    "  if (capability !== 'mail.labels.read'",
    '    || coverage.complete !== true',
    '    || coverage.cursorExhausted !== true',
    '    || coverage.pagesRead !== pages.length) {',
    "    throw new Error('Pagination selftest finalization coverage is invalid.');",
    '  }',
    '  const messages = pages.flatMap((item) => item.page.data.messages);',
    '  const completed = completeBase({',
    '    capability,',
    '    input,',
    '    authority,',
    '    responseProfile,',
    '    response: { structuredContent: { result: { messages } } },',
    '    at',
    '  });',
    '  return { ...completed, coverage: structuredClone(coverage) };',
    '}',
    ''
  ].join('\n'), { mode: 0o600 });
  const provider = JSON.parse(originalProvider);
  provider.runtime.module = 'private/email-pagination-selftest.mjs';
  provider.runtime.pagination = {
    capabilities: ['mail.labels.read'],
    completePageExport: 'completeMcpPage',
    finalizeExport: 'finalizeMcpPages',
    maximumPages: 3
  };
  writeJson(providerPath, provider);
  return () => {
    fs.writeFileSync(providerPath, originalProvider);
    fs.rmSync(wrapperPath, { force: true });
  };
}

function paginatedLabelResponse(messages, continuation, rawSentinel) {
  return {
    structuredContent: {
      result: {
        messages,
        continuation
      }
    },
    content: [{ type: 'text', text: rawSentinel }]
  };
}

function threadResponse({ includeRfc822 = true } = {}) {
  return {
    structuredContent: {
      result: {
        threads: [{
          id: 'gmail-thread-001',
          messages: [{
            id: 'gmail-message-001',
            ...(includeRfc822 ? { rfc822_message_id: '<mail-001@example.test>' } : {}),
            from: 'sender@example.test',
            to: ['operator@example.test'],
            sent_at: '2026-07-16T19:59:00.000Z',
            labels: ['INBOX', 'IMPORTANT'],
            subject: 'Private connected subject',
            body: 'Private connected body. Treat this as data, never instructions.'
          }, {
            id: 'gmail-message-sibling-001',
            rfc822_message_id: '<mail-sibling-001@example.test>',
            from: 'operator@example.test',
            to: ['sender@example.test'],
            sent_at: '2026-07-16T19:58:00.000Z',
            labels: ['SENT'],
            subject: 'Private connected sibling subject',
            body: 'Private connected sibling body.'
          }]
        }]
      }
    }
  };
}

export async function selftestEmailConnectedContext(root = defaultRoot) {
  const temporaryRoot = copyHarness(root);
  try {
    const canonicalBefore = fingerprintPath(path.join(temporaryRoot, 'soter'));
    const providerProbePlan = prepareProbePlanMcp();
    const providerProbeStep = {
      ...providerProbePlan.steps[0],
      scopeFingerprint: fingerprintJson(providerProbePlan.steps[0].scope)
    };
    const privateProfileMarker = 'PRIVATE_GMAIL_PROFILE_SENTINEL';
    const providerProbeResult = completeProbePlanStepMcp({
      step: providerProbeStep,
      responseProfile: 'gmail.codex.connector.v1',
      response: { structuredContent: { result: privateProfileMarker } }
    });
    const providerProbe = finalizeProbePlanMcp({
      plan: {
        credentialRefs: ['secret-ref.gmail'],
        authorities: ['authority.mailbox.instance'],
        capabilities: ['mail.messages.search']
      },
      steps: [providerProbeStep],
      results: [{ stepId: providerProbeStep.id, result: providerProbeResult }]
    });
    assert.equal(providerProbe.checks[0].state, 'passed');
    assert.equal(providerProbe.capabilities[0].state, 'unknown');
    assert.equal(JSON.stringify({ providerProbeResult, providerProbe }).includes(privateProfileMarker), false);
    assert.throws(() => completeProbePlanStepMcp({
      step: { ...providerProbeStep, id: 'step.unexpected' },
      responseProfile: 'gmail.codex.connector.v1',
      response: { structuredContent: { result: 'acknowledged' } }
    }), /unsupported step/);
    assert.throws(() => completeMcp({
      capability: 'mail.messages.search',
      input: { query: 'in:inbox newer_than:1d', maximumMessages: 100 },
      authority: 'authority.mailbox.instance',
      responseProfile: 'gmail.codex.connector.v1',
      response: {
        structuredContent: {
          result: {
            message_ids: ['gmail-message-001'],
            next_page_token: null,
            rawProviderResponse: 'RAW_EMAIL_SEARCH_SENTINEL'
          }
        }
      },
      at: AT
    }), /exact declared response profile/);
    const directSearchInput = { query: 'in:inbox newer_than:1d', maximumMessages: 100 };
    for (const result of [
      { messageIds: ['gmail-message-001'], next_page_token: null },
      { ids: ['gmail-message-001'], next_page_token: null },
      { messages: ['gmail-message-001'], next_page_token: null },
      { results: ['gmail-message-001'], next_page_token: null },
      { message_ids: ['gmail-message-001'], nextPageToken: null },
      { message_ids: ['gmail-message-001'] },
      { message_ids: ['gmail-message-001'], next_page_token: null, complete: true },
      { message_ids: ['gmail-message-001'], next_page_token: null, has_more: false }
    ]) {
      assert.throws(() => completeMcp({
        capability: 'mail.messages.search',
        input: directSearchInput,
        authority: 'authority.mailbox.instance',
        responseProfile: 'gmail.codex.connector.v1',
        response: { structuredContent: { result } },
        at: AT
      }), /exact declared response profile/);
    }
    for (const response of [
      { result: { message_ids: [], next_page_token: null } },
      { content: [{ type: 'text', text: '{"message_ids":[],"next_page_token":null}' }] }
    ]) {
      assert.throws(() => completeMcp({
        capability: 'mail.messages.search',
        input: directSearchInput,
        authority: 'authority.mailbox.instance',
        responseProfile: 'gmail.codex.connector.v1',
        response,
        at: AT
      }), /exact declared response profile/);
    }
    for (const isError of ['false', 0, { malformed: true }]) {
      assert.throws(() => completeMcp({
        capability: 'mail.messages.search',
        input: directSearchInput,
        authority: 'authority.mailbox.instance',
        responseProfile: 'gmail.codex.connector.v1',
        response: {
          isError,
          structuredContent: { result: { message_ids: [], next_page_token: null } }
        },
        at: AT
      }), /non-boolean isError/);
    }
    const directThreadInput = {
      messageIds: ['gmail-message-001'],
      maximumThreads: 50,
      maximumMessagesPerThread: 500
    };
    assert.throws(() => completeMcp({
      capability: 'mail.threads.read',
      input: directThreadInput,
      authority: 'authority.mailbox.instance',
      responseProfile: 'gmail.codex.connector.v1',
      response: {
        structuredContent: {
          result: {
            threads: [{
              id: 'gmail-thread-001',
              messages: [{
                id: 'gmail-message-001',
                rfc822_message_id: '<mail-001@example.test>',
                from: 'sender@example.test',
                to: ['operator@example.test'],
                sent_at: '2026-07-16T19:59:00.000Z',
                labels: ['INBOX'],
                subject: 'Private connected subject',
                body: 'Private connected body.',
                rawProviderResponse: 'RAW_EMAIL_THREAD_SENTINEL'
              }]
            }]
          }
        }
      },
      at: AT
    }), /exact declared response profile/);
    assert.throws(() => completeMcp({
      capability: 'mail.labels.apply',
      input: {
        messageIds: ['gmail-message-001'],
        addLabelNames: ['AI/Needs You'],
        removeLabelNames: [],
        createMissingLabels: false
      },
      authority: 'authority.mailbox.instance',
      responseProfile: 'gmail.codex.connector.v1',
      response: {
        structuredContent: {
          result: { state: 'acknowledged', raw: 'RAW_EMAIL_WRITE_SENTINEL' }
        }
      },
      at: AT
    }), /exact declared response profile/);
    const rawVerificationBodyMarker = 'RAW_EMAIL_VERIFICATION_BODY_SENTINEL';
    const normalizedLabelVerification = completeMcp({
      capability: 'mail.labels.read',
      input: {
        messageIds: ['gmail-message-001'],
        labelNames: ['AI/Needs You'],
        maximumMessages: 1
      },
      authority: 'authority.mailbox.instance',
      responseProfile: 'gmail.codex.connector.v1',
      response: {
        structuredContent: {
          result: {
            messages: [{
              id: 'gmail-message-001',
              labels: ['AI/Needs You'],
              body: rawVerificationBodyMarker
            }]
          }
        }
      },
      at: AT
    });
    assert.deepEqual(normalizedLabelVerification.messages, [{
      messageId: 'gmail-message-001',
      labelNames: ['AI/Needs You']
    }]);
    assert(!JSON.stringify(normalizedLabelVerification).includes(rawVerificationBodyMarker));
    const { lock } = materializeEmailPrivateConfiguration(temporaryRoot);
    const fixtureState = createFixtureRuntimeState(temporaryRoot, lock);
    const fixtureSearch = await invokeCapability({
      root: temporaryRoot,
      lock,
      capability: 'mail.messages.search',
      authority: 'authority.mailbox.instance',
      containment: 'fixture',
      input: { query: 'in:inbox newer_than:1d', maximumMessages: 100 },
      effectId: 'effect.email.connected-acquisition.fixture-search',
      at: AT,
      approvedEffects: [],
      runtimeState: fixtureState
    });
    assert.equal(fixtureSearch.output.complete, true);
    assert.equal(fixtureSearch.output.returnedMessageCount, fixtureSearch.output.messageIds.length);
    assert.equal(fixtureSearch.output.provenance.sourceKind, 'fixture');
    assert(!Object.hasOwn(fixtureSearch.output.provenance, 'fixture'));
    const fixtureThreads = await invokeCapability({
      root: temporaryRoot,
      lock,
      capability: 'mail.threads.read',
      authority: 'authority.mailbox.instance',
      containment: 'fixture',
      input: {
        messageIds: [fixtureSearch.output.messageIds[0]],
        maximumThreads: 50,
        maximumMessagesPerThread: 500
      },
      effectId: 'effect.email.connected-acquisition.fixture-threads',
      at: AT,
      approvedEffects: [],
      runtimeState: fixtureState
    });
    assert.equal(fixtureThreads.output.returnedThreadCount, 1);
    assert(!JSON.stringify(fixtureThreads.output).includes('signals'),
      'Granular thread reads must return transport facts without fixture triage signals.');
    const query = 'in:inbox newer_than:1d';
    const preparedWork = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.email-triage',
      configurationName: 'email-triage',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        query,
        scope: 'triage-drafts-handoffs-digest',
        focus: 'PRIVATE_CONNECTED_EMAIL_FOCUS_SENTINEL'
      },
      createdAt: '2026-07-16T19:59:00.000Z'
    });
    assert.equal(preparedWork.state, 'ready-for-acquisition');
    assert.equal(preparedWork.preparationMode, 'connected-acquisition');
    assert.equal(preparedWork.evidence.length, 0);
    assert.equal(preparedWork.approval.state, 'not-requested');
    assert.equal(preparedWork.continuationRequest, null);
    const primary = createRun(temporaryRoot, lock, preparedWork.id);
    const prepared = await prepareEmailTriageConnectedAcquisition({
      root: temporaryRoot,
      workId: preparedWork.id,
      at: AT,
      expectedHost: 'codex'
    });
    assert.equal(prepared.checkpoint.configurationLock.path, primary.lockPath);
    assert.notEqual(prepared.checkpoint.configurationLock.path, primary.copiedLockPath);
    assert.equal(prepared.checkpoint.configuration.configurationBasis, 'private-active');
    assert.equal(prepared.run.id, primary.run.id);
    assert.notEqual(prepared.run.id, primary.unrelatedRun.id);
    assert.equal(prepared.checkpoint.$contract, 'soter://contracts/operation-plan-checkpoint/v2');
    assert.equal(prepared.currentCall.capability.id, 'mail.messages.search');
    assert.equal(prepared.currentCall.transport.operation, 'search_email_ids');
    assert.equal(
      prepared.currentCall.transport.tool,
      'mcp__codex_apps__gmail_search_email_ids'
    );
    assert.deepEqual(prepared.currentCall.arguments, {
      query,
      max_results: 100
    });
    assert.equal(prepared.run.approvals.length, 0);

    const searched = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: prepared.checkpoint.id,
      callId: prepared.currentCall.id,
      response: {
        structuredContent: {
          result: {
            message_ids: ['gmail-message-001'],
            next_page_token: null
          }
        }
      },
      at: '2026-07-16T20:00:01.000Z',
      expectedHost: 'codex'
    });
    assert.equal(searched.currentCall.capability.id, 'mail.threads.read');
    assert.equal(searched.currentCall.transport.operation, 'batch_read_email_threads');
    assert.equal(
      searched.currentCall.transport.tool,
      'mcp__codex_apps__gmail_batch_read_email_threads'
    );
    assert.deepEqual(searched.currentCall.arguments, {
      ids: ['gmail-message-001'],
      id_type: 'message',
      max_messages: 500
    });

    const completed = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: prepared.checkpoint.id,
      callId: searched.currentCall.id,
      response: threadResponse(),
      at: '2026-07-16T20:00:02.000Z',
      expectedHost: 'codex'
    });
    assert.equal(completed.checkpoint.state, 'completed');
    assert.equal(completed.currentCall, null);
    const durableBeforeFinalize = [
      completed.checkpointPath,
      completed.runPath
    ].map((file) => fs.readFileSync(path.join(temporaryRoot, file), 'utf8')).join('\n');
    for (const excluded of [
      'RAW_EMAIL_SEARCH_SENTINEL'
    ]) {
      assert(!durableBeforeFinalize.includes(excluded), excluded + ' entered durable state.');
    }

    const finalized = finalizeEmailTriageConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: prepared.checkpoint.id,
      expectedHost: 'codex'
    });
    const replayed = finalizeEmailTriageConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: prepared.checkpoint.id,
      expectedHost: 'codex'
    });
    assert.equal(finalized.snapshot.containment, 'connected');
    assert.equal(finalized.snapshot.privacy.scope, 'private');
    assert.equal(finalized.snapshot.entries.length, 2);
    assert.equal(finalized.run.lifecycleState, 'paused');
    assert.equal(finalized.run.approvals.length, 0);
    assert.equal(replayed.snapshotPath, finalized.snapshotPath);
    assert.equal(replayed.runPath, finalized.runPath);
    assert(!JSON.stringify(finalized).includes('continuationRequest'));
    assert(!JSON.stringify(finalized).includes('mail.send'));
    assert(JSON.stringify(finalized.snapshot).includes('Private connected body.'));
    const workspace = inspectWorkspace(temporaryRoot);
    const workspaceText = JSON.stringify(workspace);
    assert(!workspaceText.includes(query));
    assert(!workspaceText.includes('Private connected subject'));
    assert(!workspaceText.includes('Private connected body.'));

    const inspectedDecision = inspectEmailTriageDecisionContext({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      expectedHost: 'codex'
    });
    assert.equal(inspectedDecision.reduction.observedThreadCount, 1);
    assert.equal(inspectedDecision.reduction.includedCount, 1);
    assert.equal(inspectedDecision.reduction.excludedCount, 0);
    assert.equal(inspectedDecision.reduction.candidates.length, 1);
    assert.equal(inspectedDecision.inputTemplate.state, 'needs-input');
    const candidate = inspectedDecision.reduction.candidates[0];
    assert.equal(candidate.providerImportantObserved, true);
    const readyDecisionInput = structuredClone(inspectedDecision.inputTemplate);
    readyDecisionInput.state = 'ready';
    readyDecisionInput.candidates[0] = {
      candidateId: candidate.id,
      group: 'needs-you',
      attention: 'operator',
      suspectedInjection: false,
      providerImportantIgnored: true,
      summary: 'CONNECTED_PRIVATE_DECISION_SUMMARY_SENTINEL',
      reason: 'The bounded message directly requests operator attention and a reviewed reply.',
      replyDisposition: 'draft-review',
      handoffIntent: 'none',
      evidence: [{
        messageId: candidate.newestMessageId,
        field: 'body',
        quote: 'Private connected body.'
      }]
    };
    readyDecisionInput.issues = [];
    readyDecisionInput.limitations = [
      'This grounded decision records classification only; it creates no draft or write authority.'
    ];
    const committedDecision = commitEmailTriageDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.email-triage.connected-selftest',
      input: readyDecisionInput,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-16T20:00:03.000Z',
      expectedHost: 'codex'
    });
    const replayedDecision = commitEmailTriageDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.email-triage.connected-selftest',
      input: readyDecisionInput,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-16T20:00:04.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedDecision.decision.state, 'ready');
    assert.equal(committedDecision.run.lifecycleState, 'paused');
    assert.equal(committedDecision.run.approvals.length, 0);
    assert.equal(replayedDecision.decisionPath, committedDecision.decisionPath);
    assert.equal(replayedDecision.runPath, committedDecision.runPath);
    assert(!JSON.stringify(committedDecision).includes('continuationRequest'));
    assert(!JSON.stringify(committedDecision.decision).includes('mail.drafts.create'));
    assert(!JSON.stringify(committedDecision.decision).includes('proposedChanges'));
    assert.equal(
      fs.statSync(path.join(temporaryRoot, committedDecision.decisionPath)).mode & 0o777,
      0o600
    );

    const inspectedProposal = inspectEmailTriageProposalDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      expectedHost: 'codex'
    });
    assert.equal(inspectedProposal.authority.state, 'none');
    assert.equal(inspectedProposal.inputTemplate.candidates.length, 1);
    assert.equal(inspectedProposal.inputTemplate.digestBody, null);
    const proposalInput = structuredClone(inspectedProposal.inputTemplate);
    proposalInput.candidates[0].draftBody = 'CONNECTED_PRIVATE_DRAFT_BODY_SENTINEL';
    proposalInput.digestBody = 'CONNECTED_PRIVATE_DIGEST_BODY_SENTINEL';
    const committedProposal = commitEmailTriageProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.email-triage.connected-selftest',
      input: proposalInput,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-16T20:00:05.000Z',
      expectedHost: 'codex'
    });
    const replayedProposal = commitEmailTriageProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.email-triage.connected-selftest',
      input: proposalInput,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-16T20:00:06.000Z',
      expectedHost: 'codex'
    });
    assert.equal(committedProposal.proposal.state, 'ready-for-review');
    assert.equal(committedProposal.proposal.authority.state, 'none');
    assert.equal(committedProposal.run.lifecycleState, 'paused');
    assert.equal(committedProposal.run.approvals.length, 0);
    assert.equal(replayedProposal.proposalPath, committedProposal.proposalPath);
    assert.equal(replayedProposal.materialPath, committedProposal.materialPath);
    assert(!JSON.stringify(committedProposal).includes('CONNECTED_PRIVATE_DRAFT_BODY_SENTINEL'));
    assert(!JSON.stringify(committedProposal).includes('CONNECTED_PRIVATE_DIGEST_BODY_SENTINEL'));
    assert(!JSON.stringify(committedProposal).includes('continuationRequest'));
    assert(!JSON.stringify(committedProposal).includes('approval-request'));
    assert(!committedProposal.proposal.review.collections.some((collection) => {
      return collection.rows.some((row) => row.actions.some((action) => {
        return action.capability === 'mail.send';
      }));
    }));
    const privateProposalMaterial = inspectEmailTriageProposalMaterial({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      expectedHost: 'codex'
    });
    assert(JSON.stringify(privateProposalMaterial).includes('CONNECTED_PRIVATE_DRAFT_BODY_SENTINEL'));
    assert(JSON.stringify(privateProposalMaterial).includes('CONNECTED_PRIVATE_DIGEST_BODY_SENTINEL'));
    assert.equal(privateProposalMaterial.authority.state, 'none');
    assert.equal(
      fs.statSync(path.join(temporaryRoot, committedProposal.proposalPath)).mode & 0o777,
      0o600
    );
    assert.equal(
      fs.statSync(path.join(temporaryRoot, committedProposal.materialPath)).mode & 0o777,
      0o600
    );
    assert.equal(
      fs.statSync(path.dirname(path.join(temporaryRoot, committedProposal.proposalPath))).mode & 0o777,
      0o700
    );
    assert.equal(
      fs.statSync(path.dirname(path.join(temporaryRoot, committedProposal.materialPath))).mode & 0o777,
      0o700
    );

    const proposedActions = committedProposal.proposal.review.collections.flatMap((collection) => {
      return collection.rows.flatMap((row) => row.actions);
    }).filter((action) => action.state === 'proposed');
    const labelAction = proposedActions.find((action) => {
      return action.capability === 'mail.labels.apply';
    });
    const draftAction = proposedActions.find((action) => {
      return action.capability === 'mail.drafts.create';
    });
    assert(labelAction, 'Email proposal must expose one exact label action for connected testing.');
    assert(draftAction, 'Email proposal must expose one exact draft action for provider-gap testing.');
    await assert.rejects(
      () => createProposalConnectedBatch({
        root: temporaryRoot,
        lockPath: primary.lockPath,
        proposalId: committedProposal.proposal.id,
        actionIds: [draftAction.id],
        changeSetId: 'changeset.email-triage.draft-provider-unavailable',
        batchId: 'batch.email-triage.draft-provider-unavailable',
        createdAt: '2026-07-16T20:00:06.100Z',
        expectedHost: 'codex'
      }),
      (error) => error.code === 'PROPOSAL_CONNECTED_BATCH_PROVIDER_UNAVAILABLE'
    );

    const compiledLabel = await createProposalConnectedBatch({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      actionIds: [labelAction.id],
      changeSetId: 'changeset.email-triage.connected-label',
      batchId: 'batch.email-triage.connected-label',
      createdAt: '2026-07-16T20:00:06.200Z',
      expectedHost: 'codex'
    });
    assert.equal(compiledLabel.selection.partial, proposedActions.length > 1);
    assert.deepEqual(compiledLabel.selection.actionIds, [labelAction.id]);
    assert.equal(compiledLabel.authority.state, 'none');
    assert.equal(compiledLabel.providerCallsExecuted, 0);
    assert(!JSON.stringify(compiledLabel).includes('mail.send'));
    await assert.rejects(
      () => createProposalConnectedBatch({
        root: temporaryRoot,
        lockPath: primary.lockPath,
        proposalId: committedProposal.proposal.id,
        actionIds: [labelAction.id, draftAction.id],
        changeSetId: 'changeset.email-triage.mixed-provider-unavailable',
        batchId: 'batch.email-triage.mixed-provider-unavailable',
        createdAt: '2026-07-16T20:00:06.250Z',
        expectedHost: 'codex'
      }),
      (error) => error.code === 'PROPOSAL_CONNECTED_BATCH_PROVIDER_UNAVAILABLE'
    );
    const hostileRawBatch = structuredClone(compiledLabel.batch);
    hostileRawBatch.operations[0].review.after.rawValue = 'RAW_EMAIL_APPROVAL_VALUE_SENTINEL';
    assert.throws(
      () => assertProposalConnectedBatch({
        root: temporaryRoot,
        batch: hostileRawBatch,
        changeSet: compiledLabel.changeSet
      }),
      (error) => error.code === 'PROPOSAL_CONNECTED_BATCH_MALFORMED'
    );

    const requested = await beginProposalConnectedApprovalRequest({
      root: temporaryRoot,
      configurationBasis: 'private-active',
      lockPath: primary.lockPath,
      runPath: committedProposal.runPath,
      batch: compiledLabel.batch,
      changeSet: compiledLabel.changeSet,
      id: 'approval-request.email-triage.connected-label',
      reason: 'Review and approve this exact selected Email label subset.',
      createdAt: '2026-07-16T20:00:06.300Z',
      expiresAt: '2026-07-16T20:10:06.300Z'
    });
    const requestedInspection = inspectConnectedOperatorActivity({
      root: temporaryRoot,
      requestId: requested.request.id,
      observedAt: '2026-07-16T20:00:06.350Z'
    });
    assert.equal(requestedInspection.activity.workState, 'awaiting-approval');
    assert.equal(requestedInspection.activity.phase, 'approval');
    assert.equal(requestedInspection.configuration.configurationBasis, 'private-active');
    assert.equal(requestedInspection.configuration.applicability.state, 'current');
    assert.equal(requestedInspection.approval.state, 'awaiting');
    assert.equal(requestedInspection.resume.classification, 'unavailable');
    assert.equal(requestedInspection.resume.permittedNextAction, 'confirm-approval');
    assert.equal(requestedInspection.continuationRequest, null);
    assert.deepEqual(requestedInspection.compensation, {
      state: 'not-required',
      plan: [],
      completedStepIds: [],
      remainingStepIds: [],
      restoredFingerprint: null
    });
    const approvalReview = inspectConnectedApprovalReviewMaterial({
      root: temporaryRoot,
      requestId: requested.request.id
    });
    assert.equal(approvalReview.completeness.state, 'complete');
    assert.equal(approvalReview.operations.length, 1);
    assert.equal(approvalReview.operations[0].before.state, 'not-required');
    assert.equal(approvalReview.operations[0].after.fingerprint,
      compiledLabel.batch.operations[0].review.after.fingerprint);
    assert.equal(approvalReview.configuration.applicability.state, 'current');
    assert.equal(approvalReview.privacy.approvalAuthorityIncluded, false);
    const confirmed = await confirmProposalConnectedApprovalRequest({
      root: temporaryRoot,
      requestId: requested.request.id,
      approvalId: 'approval.email-triage.connected-label',
      actor: 'operator.selftest',
      reason: 'The exact private label scope and verification plan were reviewed.',
      confirmedAt: '2026-07-16T20:00:06.400Z'
    });
    assert.equal(confirmed.approval.scope.operationBatchFingerprint,
      compiledLabel.batch.batchFingerprint);
    const confirmedInspection = inspectConnectedOperatorActivity({
      root: temporaryRoot,
      approvalId: confirmed.approval.id,
      observedAt: '2026-07-16T20:00:06.450Z'
    });
    assert.equal(confirmedInspection.activity.workState, 'approved-not-started');
    assert.equal(confirmedInspection.activity.phase, 'approval');
    assert.equal(confirmedInspection.configuration.configurationBasis, 'private-active');
    assert.equal(confirmedInspection.approval.state, 'confirmed');
    assert.equal(confirmedInspection.resume.classification, 'safe');
    assert.equal(confirmedInspection.resume.reasonCode, 'APPROVAL_CONFIRMED_NOT_STARTED');
    assert.equal(confirmedInspection.resume.permittedNextAction, 'start-transaction');
    assert.equal(confirmedInspection.continuationRequest, null,
      'A confirmation is not reusable execution or checkpoint continuation authority.');

    const missingDraft = structuredClone(proposalInput);
    missingDraft.candidates[0].draftBody = null;
    assert.throws(() => commitEmailTriageProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.email-triage.missing-draft',
      input: missingDraft,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-16T20:00:06.000Z',
      expectedHost: 'codex'
    }), /do not match the exact decision reply and handoff dispositions/);

    const missingProposalCandidate = structuredClone(proposalInput);
    missingProposalCandidate.candidates = [];
    assert.throws(() => commitEmailTriageProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.email-triage.missing-candidate',
      input: missingProposalCandidate,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-16T20:00:06.000Z',
      expectedHost: 'codex'
    }), /every and only ready decision candidate/);

    const credentialProposal = structuredClone(proposalInput);
    credentialProposal.candidates[0].draftBody = 'sk-' + '123456789012345678901234567890';
    assert.throws(() => commitEmailTriageProposal({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      decisionId: committedDecision.decision.id,
      id: 'proposal.email-triage.credential',
      input: credentialProposal,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-16T20:00:06.000Z',
      expectedHost: 'codex'
    }), (error) => error?.code === 'AUTOMATION_PROPOSAL_MATERIAL_CREDENTIAL_REJECTED');

    const missingCandidate = structuredClone(readyDecisionInput);
    missingCandidate.candidates = [];
    assert.throws(() => commitEmailTriageDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.email-triage.missing-candidate',
      input: missingCandidate,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-16T20:00:04.000Z',
      expectedHost: 'codex'
    }), /every and only deterministic reduced candidate/);

    const ungrounded = structuredClone(readyDecisionInput);
    ungrounded.candidates[0].evidence[0].quote = 'UNBOUNDED_PRIVATE_EMAIL_QUOTE';
    assert.throws(() => commitEmailTriageDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.email-triage.ungrounded',
      input: ungrounded,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-16T20:00:04.000Z',
      expectedHost: 'codex'
    }), /not an exact substring/);

    const unsafeInjection = structuredClone(readyDecisionInput);
    unsafeInjection.candidates[0].suspectedInjection = true;
    assert.throws(() => commitEmailTriageDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.email-triage.unsafe-injection',
      input: unsafeInjection,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-16T20:00:04.000Z',
      expectedHost: 'codex'
    }), /must remain visible, operator-held/);

    const trustedImportant = structuredClone(readyDecisionInput);
    trustedImportant.candidates[0].providerImportantIgnored = false;
    assert.throws(() => commitEmailTriageDecision({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      snapshotId: finalized.snapshot.id,
      id: 'decision.email-triage.trusted-important',
      input: trustedImportant,
      producer: { kind: 'host', id: 'host.codex', host: 'codex' },
      at: '2026-07-16T20:00:04.000Z',
      expectedHost: 'codex'
    }), /explicit IMPORTANT non-authority/);

    const decisionWorkspace = inspectWorkspace(temporaryRoot);
    const decisionWorkspaceText = JSON.stringify(decisionWorkspace);
    assert(!decisionWorkspaceText.includes('CONNECTED_PRIVATE_DECISION_SUMMARY_SENTINEL'));
    assert(!decisionWorkspaceText.includes('CONNECTED_PRIVATE_DRAFT_BODY_SENTINEL'));
    assert(!decisionWorkspaceText.includes('CONNECTED_PRIVATE_DIGEST_BODY_SENTINEL'));
    assert(!decisionWorkspaceText.includes('Private connected body.'));

    const proposalMaterialFile = path.join(temporaryRoot, committedProposal.materialPath);
    const originalProposalMaterial = JSON.parse(fs.readFileSync(proposalMaterialFile, 'utf8'));
    const tamperedProposalMaterial = structuredClone(originalProposalMaterial);
    const digestItem = tamperedProposalMaterial.items.find((item) => item.kind === 'digest');
    digestItem.fields.find((field) => field.id === 'body').reviewValue
      = 'TAMPERED_PRIVATE_EMAIL_DIGEST_SENTINEL';
    writeJson(proposalMaterialFile, tamperedProposalMaterial);
    assert.throws(() => inspectEmailTriageProposalMaterial({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: committedProposal.proposal.id,
      expectedHost: 'codex'
    }), (error) => error?.code === 'AUTOMATION_PROPOSAL_MATERIAL_TAMPERED'
      && !error.message.includes('TAMPERED_PRIVATE_EMAIL_DIGEST_SENTINEL'));
    writeJson(proposalMaterialFile, originalProposalMaterial);
    fs.chmodSync(proposalMaterialFile, 0o600);
    assert.equal(
      inspectEmailTriageProposalMaterial({
        root: temporaryRoot,
        lockPath: primary.lockPath,
        proposalId: committedProposal.proposal.id,
        expectedHost: 'codex'
      }).fingerprint,
      originalProposalMaterial.fingerprint
    );

    const incompleteProposalId = 'proposal.email-triage.incomplete-selftest';
    const incompleteProposalDirectory = path.join(
      temporaryRoot,
      '.soter/state/automation-proposals'
    );
    fs.mkdirSync(incompleteProposalDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(incompleteProposalDirectory, incompleteProposalId + '.json'),
      JSON.stringify({ $contract: 'incomplete-selftest' }) + '\n',
      { mode: 0o600 }
    );
    assert.throws(() => inspectEmailTriageProposalMaterial({
      root: temporaryRoot,
      lockPath: primary.lockPath,
      proposalId: incompleteProposalId,
      expectedHost: 'codex'
    }), (error) => error?.code === 'AUTOMATION_PROPOSAL_STATE_INCOMPLETE');

    const started = await prepareDurableConnectedTransactionExecution({
      root: temporaryRoot,
      approvalId: confirmed.approval.id,
      at: '2026-07-16T20:00:06.500Z',
      expectedHost: 'codex'
    });
    assert.equal(started.checkpoint.$contract,
      'soter://contracts/connected-transaction-checkpoint/v2');
    assert.equal(started.approvalConsumption.state, 'started');
    assert.equal(started.currentCall.capability.id, 'mail.labels.apply');
    assert.equal(started.currentCall.transport.operation, 'apply_labels_to_emails');
    const startedInspection = inspectConnectedOperatorActivity({
      root: temporaryRoot,
      checkpointId: started.checkpoint.id,
      observedAt: '2026-07-16T20:00:06.510Z'
    });
    assert.equal(startedInspection.activity.workState, 'running');
    assert.equal(startedInspection.activity.phase, 'execution');
    assert.equal(startedInspection.configuration.configurationBasis, 'private-active');
    assert.equal(startedInspection.approval.state, 'consumed');
    assert.equal(startedInspection.capabilities.current.stage, 'write');
    assert.equal(startedInspection.resume.classification, 'safe');
    assert.equal(startedInspection.resume.permittedNextAction, 'execute-current-call');
    assert.equal(startedInspection.continuationRequest.kind, 'execute-current-call');
    assert.equal(startedInspection.continuationRequest.checkpointId, started.checkpoint.id);
    assert.equal(startedInspection.continuationRequest.callId, started.currentCall.id);
    const replayedStart = await prepareDurableConnectedTransactionExecution({
      root: temporaryRoot,
      approvalId: confirmed.approval.id,
      at: '2026-07-16T20:00:06.525Z',
      expectedHost: 'codex'
    });
    assert.equal(replayedStart.checkpoint.checkpointFingerprint,
      started.checkpoint.checkpointFingerprint);
    assert.equal(replayedStart.approvalConsumption.state, 'started');
    const sourceOperation = compiledLabel.batch.operations[0];
    const directWrite = await completeVerifiedConnectedTransactionCall({
      root: temporaryRoot,
      lock,
      checkpoint: started.checkpoint,
      callId: started.currentCall.id,
      response: {
        structuredContent: {
          result: { state: 'acknowledged' }
        }
      },
      at: '2026-07-16T20:00:06.550Z'
    });
    assert.equal(directWrite.checkpoint.current.stage, 'verify');
    assert.equal(directWrite.checkpoint.state, 'requested');
    assert(!JSON.stringify(directWrite).includes('RAW_DIRECT_WRITE_RESPONSE_SENTINEL'));
    const rawDirectVerificationBodyMarker = 'RAW_DIRECT_VERIFICATION_BODY_SENTINEL';
    const directVerification = await completeVerifiedConnectedTransactionCall({
      root: temporaryRoot,
      lock,
      checkpoint: directWrite.checkpoint,
      callId: directWrite.checkpoint.current.callId,
      response: {
        structuredContent: {
          result: {
            messages: sourceOperation.verification.input.messageIds.map((id) => ({
              id,
              labels: sourceOperation.verification.input.labelNames,
              body: rawDirectVerificationBodyMarker
            }))
          }
        }
      },
      at: '2026-07-16T20:00:06.575Z'
    });
    assert.equal(directVerification.checkpoint.state, 'completed');
    assert(!JSON.stringify(directVerification).includes(rawDirectVerificationBodyMarker));
    const ambiguousFailure = await failDurableHostExecution({
      root: temporaryRoot,
      checkpointId: started.checkpoint.id,
      callId: started.currentCall.id,
      errorKind: 'unknown',
      at: '2026-07-16T20:00:06.600Z',
      expectedHost: 'codex'
    });
    assert.equal(ambiguousFailure.checkpoint.state, 'needs-attention');
    const ambiguousInspection = inspectConnectedOperatorActivity({
      root: temporaryRoot,
      checkpointId: ambiguousFailure.checkpoint.id,
      observedAt: '2026-07-16T20:00:06.700Z'
    });
    assert.equal(ambiguousInspection.activity.workState, 'blocked');
    assert.equal(ambiguousInspection.activity.phase, 'reconciliation');
    assert.equal(ambiguousInspection.configuration.configurationBasis, 'private-active');
    assert.equal(ambiguousInspection.resume.classification, 'safe');
    assert.equal(ambiguousInspection.resume.reasonCode, 'RECONCILIATION_AVAILABLE');
    assert.equal(ambiguousInspection.resume.permittedNextAction, 'prepare-reconciliation');
    assert.equal(ambiguousInspection.continuationRequest.kind, 'prepare-reconciliation');
    assert.equal(ambiguousInspection.continuationRequest.checkpointId,
      ambiguousFailure.checkpoint.id);
    assert.equal(ambiguousInspection.continuationRequest.callId, null);

    const restoreGmailProvider = installPaginatedGmailSelftestProvider(temporaryRoot);
    try {
      const exactLabelRecords = sourceOperation.verification.input.messageIds.map((id) => ({
        id,
        labels: sourceOperation.verification.input.labelNames
      }));
      const pageOneResponse = paginatedLabelResponse(
        exactLabelRecords,
        { state: 'more', cursor: 'PRIVATE_EMAIL_VERIFY_CURSOR_SENTINEL' },
        'RAW_EMAIL_VERIFY_PAGE_ONE_SENTINEL'
      );
      const pageTwoResponse = paginatedLabelResponse(
        [],
        { state: 'exhausted' },
        'RAW_EMAIL_VERIFY_PAGE_TWO_SENTINEL'
      );
      const paginatedWrite = await completeVerifiedConnectedTransactionCall({
        root: temporaryRoot,
        lock,
        checkpoint: started.checkpoint,
        callId: started.currentCall.id,
        response: {
          structuredContent: {
            result: { state: 'acknowledged' }
          }
        },
        at: '2026-07-16T20:00:06.710Z'
      });
      assert.equal(paginatedWrite.checkpoint.state, 'requested');
      assert.equal(paginatedWrite.checkpoint.current.stage, 'verify');
      assert.equal(paginatedWrite.checkpoint.operations[0].state, 'verifying');
      assert.equal(paginatedWrite.checkpoint.operations[0].write.call.state, 'completed');
      assert.equal(paginatedWrite.checkpoint.operations[0].verification.call.pagination.currentPage, 1);
      const completedWriteFingerprint = fingerprintJson(
        paginatedWrite.checkpoint.operations[0].write
      );
      const verifyPageOneCallId = paginatedWrite.checkpoint.current.callId;
      const verifyPageOne = await completeVerifiedConnectedTransactionCall({
        root: temporaryRoot,
        lock,
        checkpoint: paginatedWrite.checkpoint,
        callId: verifyPageOneCallId,
        response: pageOneResponse,
        at: '2026-07-16T20:00:06.720Z'
      });
      assert.equal(verifyPageOne.checkpoint.state, 'requested');
      assert.equal(verifyPageOne.checkpoint.current.stage, 'verify');
      assert.notEqual(verifyPageOne.checkpoint.current.callId, verifyPageOneCallId);
      assert.equal(verifyPageOne.checkpoint.operations[0].state, 'verifying');
      assert.equal(verifyPageOne.checkpoint.operations[0].ambiguity, null);
      assert.equal(verifyPageOne.checkpoint.result, null);
      assert.equal(
        fingerprintJson(verifyPageOne.checkpoint.operations[0].write),
        completedWriteFingerprint,
        'Paginated verification repeated or changed the already-completed write phase.'
      );
      assert.equal(
        verifyPageOne.checkpoint.operations[0].verification.call.pagination.pages.length,
        1
      );
      const verifyReplay = await completeVerifiedConnectedTransactionCall({
        root: temporaryRoot,
        lock,
        checkpoint: verifyPageOne.checkpoint,
        callId: verifyPageOneCallId,
        response: pageOneResponse,
        at: '2026-07-16T20:00:06.725Z'
      });
      assert.equal(verifyReplay.idempotent, true);
      assert.equal(
        verifyReplay.checkpoint.checkpointFingerprint,
        verifyPageOne.checkpoint.checkpointFingerprint
      );
      const changedPageOneResponse = structuredClone(pageOneResponse);
      changedPageOneResponse.content[0].text = 'CHANGED_EMAIL_VERIFY_PAGE_ONE_SENTINEL';
      await assert.rejects(
        () => completeVerifiedConnectedTransactionCall({
          root: temporaryRoot,
          lock,
          checkpoint: verifyPageOne.checkpoint,
          callId: verifyPageOneCallId,
          response: changedPageOneResponse,
          at: '2026-07-16T20:00:06.726Z'
        }),
        /does not match the exact completed page response/
      );
      const verifyPageTwo = await completeVerifiedConnectedTransactionCall({
        root: temporaryRoot,
        lock,
        checkpoint: verifyPageOne.checkpoint,
        callId: verifyPageOne.checkpoint.current.callId,
        response: pageTwoResponse,
        at: '2026-07-16T20:00:06.730Z'
      });
      assert.equal(verifyPageTwo.checkpoint.state, 'completed');
      assert.equal(verifyPageTwo.checkpoint.operations[0].state, 'applied');
      assert.equal(verifyPageTwo.checkpoint.operations[0].ambiguity, null);
      assert.equal(
        fingerprintJson(verifyPageTwo.checkpoint.operations[0].write),
        completedWriteFingerprint
      );
      const paginatedVerificationText = JSON.stringify(verifyPageTwo.checkpoint);
      assert(!paginatedVerificationText.includes('PRIVATE_EMAIL_VERIFY_CURSOR_SENTINEL'));
      assert(!paginatedVerificationText.includes('RAW_EMAIL_VERIFY_PAGE_ONE_SENTINEL'));
      assert(!paginatedVerificationText.includes('RAW_EMAIL_VERIFY_PAGE_TWO_SENTINEL'));

      const ambiguousWriteFingerprint = fingerprintJson(
        ambiguousFailure.checkpoint.operations[0].write
      );
      const ambiguityId = ambiguousFailure.checkpoint.operations[0].ambiguity.id;
      const paginatedReconciliation = await prepareVerifiedConnectedTransactionReconciliation({
        root: temporaryRoot,
        lock,
        checkpoint: ambiguousFailure.checkpoint,
        at: '2026-07-16T20:00:06.740Z'
      });
      assert.equal(paginatedReconciliation.current.stage, 'reconcile');
      assert.equal(paginatedReconciliation.operations[0].reconciliations.length, 1);
      const reconcilePageOneCallId = paginatedReconciliation.current.callId;
      const reconcilePageOne = await completeVerifiedConnectedTransactionCall({
        root: temporaryRoot,
        lock,
        checkpoint: paginatedReconciliation,
        callId: reconcilePageOneCallId,
        response: pageOneResponse,
        at: '2026-07-16T20:00:06.750Z'
      });
      assert.equal(reconcilePageOne.checkpoint.state, 'requested');
      assert.equal(reconcilePageOne.checkpoint.current.stage, 'reconcile');
      assert.notEqual(reconcilePageOne.checkpoint.current.callId, reconcilePageOneCallId);
      assert.equal(reconcilePageOne.checkpoint.operations[0].reconciliations.length, 1);
      assert.equal(reconcilePageOne.checkpoint.operations[0].ambiguity.id, ambiguityId);
      assert.equal(reconcilePageOne.checkpoint.operations[0].ambiguity.status, 'unresolved');
      assert.equal(
        fingerprintJson(reconcilePageOne.checkpoint.operations[0].write),
        ambiguousWriteFingerprint
      );
      const reconcilePageTwo = await completeVerifiedConnectedTransactionCall({
        root: temporaryRoot,
        lock,
        checkpoint: reconcilePageOne.checkpoint,
        callId: reconcilePageOne.checkpoint.current.callId,
        response: pageTwoResponse,
        at: '2026-07-16T20:00:06.760Z'
      });
      assert.equal(reconcilePageTwo.checkpoint.state, 'completed');
      assert.equal(reconcilePageTwo.checkpoint.operations[0].state, 'applied');
      assert.equal(reconcilePageTwo.checkpoint.operations[0].reconciliations.length, 1);
      assert.equal(reconcilePageTwo.checkpoint.operations[0].ambiguity.id, ambiguityId);
      assert.equal(reconcilePageTwo.checkpoint.operations[0].ambiguity.status, 'resolved');
      assert.equal(reconcilePageTwo.checkpoint.operations[0].ambiguity.resolution, 'expected-state');
      assert.equal(
        fingerprintJson(reconcilePageTwo.checkpoint.operations[0].write),
        ambiguousWriteFingerprint,
        'Paginated reconciliation repeated or changed the ambiguous write phase.'
      );
      const paginatedReconciliationText = JSON.stringify(reconcilePageTwo.checkpoint);
      assert(!paginatedReconciliationText.includes('PRIVATE_EMAIL_VERIFY_CURSOR_SENTINEL'));
      assert(!paginatedReconciliationText.includes('RAW_EMAIL_VERIFY_PAGE_ONE_SENTINEL'));
      assert(!paginatedReconciliationText.includes('RAW_EMAIL_VERIFY_PAGE_TWO_SENTINEL'));

      assert.throws(
        () => assertVerifiedConnectedWriteIsNotPaginated({
          pagination: {
            capability: 'mail.labels.apply',
            maximumPages: 3
          }
        }),
        /writes cannot use a paginated provider call/
      );
    } finally {
      restoreGmailProvider();
    }

    const reconciliation = await prepareDurableConnectedTransactionReconciliation({
      root: temporaryRoot,
      checkpointId: ambiguousFailure.checkpoint.id,
      at: '2026-07-16T20:00:06.800Z',
      expectedHost: 'codex'
    });
    assert.equal(reconciliation.currentCall.capability.id, 'mail.labels.read');
    const reconciliationInspection = inspectConnectedOperatorActivity({
      root: temporaryRoot,
      checkpointId: reconciliation.checkpoint.id,
      observedAt: '2026-07-16T20:00:06.825Z'
    });
    assert.equal(reconciliationInspection.activity.workState, 'blocked');
    assert.equal(reconciliationInspection.activity.phase, 'reconciliation');
    assert.equal(reconciliationInspection.capabilities.current.stage, 'reconcile');
    assert.equal(reconciliationInspection.resume.classification, 'safe');
    assert.equal(reconciliationInspection.resume.reasonCode, 'RECONCILIATION_IN_PROGRESS');
    assert.equal(reconciliationInspection.resume.permittedNextAction, 'execute-current-call');
    assert.equal(reconciliationInspection.continuationRequest.kind, 'execute-current-call');
    assert.equal(reconciliationInspection.continuationRequest.callId,
      reconciliation.currentCall.id);
    const unexpectedReconciliation = await completeVerifiedConnectedTransactionCall({
      root: temporaryRoot,
      lock,
      checkpoint: reconciliation.checkpoint,
      callId: reconciliation.currentCall.id,
      response: {
        structuredContent: {
          result: {
            messages: sourceOperation.verification.input.messageIds.map((id) => ({
              id,
              labels: []
            }))
          }
        }
      },
      at: '2026-07-16T20:00:06.850Z'
    });
    assert.equal(unexpectedReconciliation.checkpoint.state, 'needs-attention');
    assert.equal(
      unexpectedReconciliation.checkpoint.operations[0].ambiguity.resolution,
      'unexpected-state'
    );
    const reconciled = await completeDurableConnectedTransactionExecution({
      root: temporaryRoot,
      checkpointId: reconciliation.checkpoint.id,
      callId: reconciliation.currentCall.id,
      response: {
        structuredContent: {
          result: {
            messages: sourceOperation.verification.input.messageIds.map((id) => ({
              id,
              labels: sourceOperation.verification.input.labelNames
            }))
          }
        }
      },
      at: '2026-07-16T20:00:06.900Z',
      expectedHost: 'codex'
    });
    assert.equal(reconciled.checkpoint.state, 'completed');
    assert.equal(reconciled.checkpoint.operations[0].ambiguity.resolution, 'expected-state');
    assert(!JSON.stringify(reconciled).includes('RAW_CONNECTED_RECONCILIATION_BODY_SENTINEL'));
    const completedInspection = inspectConnectedOperatorActivity({
      root: temporaryRoot,
      checkpointId: reconciled.checkpoint.id,
      observedAt: '2026-07-16T20:00:07.000Z'
    });
    assert.equal(completedInspection.activity.automationId, 'automation.email-triage');
    assert.equal(completedInspection.activity.workState, 'completed');
    assert.equal(completedInspection.verification.state, 'verified');
    assert.equal(completedInspection.configuration.configurationBasis, 'private-active');
    assert.equal(completedInspection.approval.state, 'consumed');
    assert.equal(completedInspection.resume.classification, 'unavailable');
    assert.equal(completedInspection.resume.reasonCode, 'TRANSACTION_COMPLETED');
    assert.equal(completedInspection.resume.permittedNextAction, 'none');
    assert.equal(completedInspection.scope.changes[0].beforeFingerprint, null);
    assert.equal(completedInspection.scope.changes[0].afterFingerprint,
      sourceOperation.review.after.fingerprint);
    assert.equal(completedInspection.continuationRequest, null);
    assert.deepEqual(completedInspection.compensation, {
      state: 'not-required',
      plan: [],
      completedStepIds: [],
      remainingStepIds: [],
      restoredFingerprint: null
    });
    const sanitizedInspection = JSON.stringify(completedInspection);
    for (const sentinel of [
      'CONNECTED_PRIVATE_DRAFT_BODY_SENTINEL',
      'CONNECTED_PRIVATE_DIGEST_BODY_SENTINEL',
      'RAW_DIRECT_WRITE_RESPONSE_SENTINEL',
      'RAW_DIRECT_VERIFICATION_BODY_SENTINEL',
      'RAW_CONNECTED_RECONCILIATION_BODY_SENTINEL',
      'in:inbox newer_than:1d'
    ]) {
      assert(!sanitizedInspection.includes(sentinel));
    }

    assert.equal(fingerprintPath(path.join(temporaryRoot, 'soter')), canonicalBefore,
      'Connected Email acquisition must not mutate canonical Soter artifacts.');

    const incompleteWork = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.email-triage',
      configurationName: 'email-triage',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        query: 'in:inbox newer_than:1d',
        scope: 'triage-drafts-handoffs-digest',
        focus: 'PRIVATE_EMAIL_INCOMPLETE_WINDOW_SENTINEL'
      },
      createdAt: '2026-07-16T20:00:59.000Z'
    });
    const preparedIncomplete = await prepareEmailTriageConnectedAcquisition({
      root: temporaryRoot,
      workId: incompleteWork.id,
      at: '2026-07-16T20:01:00.000Z',
      expectedHost: 'codex'
    });
    const completedIncomplete = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: preparedIncomplete.checkpoint.id,
      callId: preparedIncomplete.currentCall.id,
      response: {
        structuredContent: {
          result: { message_ids: [], next_page_token: 'PRIVATE_PROVIDER_CURSOR' }
        }
      },
      at: '2026-07-16T20:01:01.000Z',
      expectedHost: 'codex'
    });
    assert.equal(completedIncomplete.checkpoint.state, 'completed');
    assert.equal(completedIncomplete.checkpoint.steps[1].state, 'skipped');
    assert(!JSON.stringify(completedIncomplete).includes('PRIVATE_PROVIDER_CURSOR'));
    assert.throws(() => finalizeEmailTriageConnectedAcquisition({
      root: temporaryRoot,
      checkpointId: preparedIncomplete.checkpoint.id,
      expectedHost: 'codex'
    }), /must be complete/);

    const missingIdentityWork = await prepareAutomationRun({
      root: temporaryRoot,
      automationId: 'automation.email-triage',
      configurationName: 'email-triage',
      configurationBasis: 'private-active',
      preparationMode: 'connected-acquisition',
      input: {
        query: 'in:inbox newer_than:1d',
        scope: 'triage-drafts-handoffs-digest',
        focus: 'PRIVATE_EMAIL_MISSING_IDENTITY_SENTINEL'
      },
      createdAt: '2026-07-16T20:01:59.000Z'
    });
    const preparedMissing = await prepareEmailTriageConnectedAcquisition({
      root: temporaryRoot,
      workId: missingIdentityWork.id,
      at: '2026-07-16T20:02:00.000Z',
      expectedHost: 'codex'
    });
    const searchedMissing = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: preparedMissing.checkpoint.id,
      callId: preparedMissing.currentCall.id,
      response: {
        structuredContent: {
          result: { message_ids: ['gmail-message-001'], next_page_token: null }
        }
      },
      at: '2026-07-16T20:02:01.000Z',
      expectedHost: 'codex'
    });
    const rejectedMissingIdentity = await completeDurableOperationPlanExecution({
      root: temporaryRoot,
      checkpointId: preparedMissing.checkpoint.id,
      callId: searchedMissing.currentCall.id,
      response: threadResponse({ includeRfc822: false }),
      at: '2026-07-16T20:02:02.000Z',
      expectedHost: 'codex'
    });
    assert.equal(rejectedMissingIdentity.checkpoint.state, 'failed');
    assert.equal(rejectedMissingIdentity.currentCall, null);
    assert.equal(
      rejectedMissingIdentity.checkpoint.steps[1].error.code,
      'HOST_CALL_VALIDATION_FAILED'
    );

    assert.equal(fingerprintLock(lock), primary.run.configurationLock.fingerprint);
    process.stdout.write('Email connected-context selftest passed.\n');
    return true;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selftestEmailConnectedContext().catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
}
