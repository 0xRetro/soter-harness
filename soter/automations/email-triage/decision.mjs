import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import {
  commitDurableAutomationDecision,
  getExactDurableAutomationDecision,
  getExactDurableContextSnapshot
} from '../../core/service.mjs';
import { fingerprintJson, readJson, resolveRepoPath } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  hasAutomationDecisionState,
  readAutomationDecisionState,
  readContextSnapshotState
} from '../../core/runtime-state.mjs';
import { reduceMailThreads } from '../../contexts/email/reduction.mjs';

const AUTOMATION_ID = 'automation.email-triage';
const DECISION_TYPE = 'email-triage.grounded-classification';

function validate(root, value, schemaPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw new Error(
      label + ' does not satisfy its contract: '
        + failures.slice(0, 5).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

function decisionFingerprint(decision) {
  const value = structuredClone(decision);
  delete value.decisionFingerprint;
  return fingerprintJson(value);
}

function selectedAutomation(lock) {
  const matches = lock.packs.filter((pack) => {
    return pack.id === AUTOMATION_ID && pack.layer === 'automation';
  });
  if (matches.length !== 1) {
    throw new Error('Email decision requires one selected ' + AUTOMATION_ID + ' pack.');
  }
  return matches[0];
}

function exactSettings(lock) {
  const settings = lock.settings?.['integration.gmail'];
  if (!settings
    || !Array.isArray(settings.selfAddresses)
    || settings.selfAddresses.length < 1
    || settings.labels?.triaged !== 'AI/Triaged') {
    throw new Error('Email decision requires exact self identities and the configured triage label.');
  }
  return settings;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(label + ' must be an array.');
  return value;
}

function requireText(value, label, minimum = 1) {
  if (typeof value !== 'string' || value.trim().length < minimum) {
    throw new Error(label + ' must contain at least ' + minimum + ' characters.');
  }
  return value.trim();
}

function exactEntry(snapshot, capability, required) {
  const entries = snapshot.entries.filter((entry) => entry.capability === capability);
  if (entries.length !== (required ? 1 : 0)) {
    throw new Error(
      'Email decision requires ' + (required ? 'exactly one' : 'no') + ' ' + capability
        + ' Context entry; found ' + entries.length + '.'
    );
  }
  return entries[0] || null;
}

function sameJson(left, right) {
  return fingerprintJson(left) === fingerprintJson(right);
}

function exactWindow(snapshot, lock) {
  const search = exactEntry(snapshot, 'mail.messages.search', true);
  const searchOutput = search.value;
  if (searchOutput.complete !== true
    || !Array.isArray(searchOutput.messageIds)
    || searchOutput.returnedMessageCount !== searchOutput.messageIds.length
    || new Set(searchOutput.messageIds).size !== searchOutput.messageIds.length) {
    throw new Error('Email decision requires one complete exact searched-message set.');
  }
  const threads = exactEntry(
    snapshot,
    'mail.threads.read',
    searchOutput.messageIds.length > 0
  );
  const threadValues = threads?.value?.threads || [];
  if (threads && (!sameJson(
    threads.value.requestedMessageIds,
    [...searchOutput.messageIds].sort((left, right) => left.localeCompare(right, 'en'))
  )
    || threads.value.returnedThreadCount !== threadValues.length)) {
    throw new Error('Email decision thread Context does not match the exact searched-message set.');
  }
  const settings = exactSettings(lock);
  const reduced = reduceMailThreads({
    threads: threadValues,
    selfAddresses: settings.selfAddresses,
    triagedLabel: settings.labels.triaged
  });
  const excludedCount = reduced.exclusions.reduce((total, item) => total + item.count, 0);
  if (threadValues.length !== reduced.included.length + excludedCount) {
    throw new Error('Email decision reduction does not cover every observed thread exactly once.');
  }
  return { search, threads, reduced, settings };
}

function candidateSource(candidate) {
  const activeMessageIds = candidate.active.map((message) => message.id);
  const activeMessageFingerprints = candidate.active.map(fingerprintJson);
  const threadFingerprint = fingerprintJson(candidate.thread);
  const newestMessageFingerprint = fingerprintJson(candidate.message);
  const source = {
    threadId: candidate.thread.id,
    threadFingerprint,
    activeMessageIds,
    activeMessageFingerprints,
    newestMessageId: candidate.message.id,
    newestMessageFingerprint,
    providerImportantObserved: candidate.active.some((message) => {
      return message.labels.includes('IMPORTANT');
    }),
    archivedSiblingIgnored: candidate.archivedSiblingIgnored
  };
  const candidateFingerprint = fingerprintJson(source);
  return {
    id: 'candidate.email.' + candidateFingerprint.slice('sha256:'.length, 'sha256:'.length + 24),
    candidateFingerprint,
    ...source,
    messages: candidate.active
  };
}

function candidateSources(window) {
  const sources = window.reduced.included.map(candidateSource);
  if (new Set(sources.map((item) => item.id)).size !== sources.length
    || new Set(sources.map((item) => item.candidateFingerprint)).size !== sources.length) {
    throw new Error('Email decision candidates do not have unique exact source identities.');
  }
  return sources;
}

function candidateInputMap(input) {
  const candidates = requireArray(input, 'Email candidate decisions');
  const ids = candidates.map((candidate) => candidate?.candidateId);
  if (ids.some((id) => typeof id !== 'string' || !id)
    || new Set(ids).size !== ids.length) {
    throw new Error('Email candidate decisions must identify each candidate exactly once.');
  }
  return new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
}

function groundedEvidence(source, input, label) {
  const messages = new Map(source.messages.map((message) => [message.id, message]));
  const seen = new Set();
  return requireArray(input, label).map((item, index) => {
    const message = messages.get(item?.messageId);
    if (!message) {
      throw new Error(label + ' item ' + index + ' references an unbounded active message.');
    }
    if (!['subject', 'body'].includes(item.field)) {
      throw new Error(label + ' item ' + index + ' has an unsupported evidence field.');
    }
    const quote = requireText(item.quote, label + ' quote ' + index, 3);
    if (typeof message[item.field] !== 'string' || !message[item.field].includes(quote)) {
      throw new Error(label + ' quote ' + index + ' is not an exact substring of bounded mail data.');
    }
    const key = message.id + '\0' + item.field + '\0' + quote;
    if (seen.has(key)) throw new Error(label + ' contains duplicate evidence.');
    seen.add(key);
    return {
      messageId: message.id,
      messageFingerprint: fingerprintJson(message),
      field: item.field,
      quote,
      quoteFingerprint: fingerprintJson(quote)
    };
  });
}

function validateReadyCandidate(candidate) {
  if (candidate.group === 'unresolved'
    || candidate.suspectedInjection === null
    || candidate.providerImportantIgnored !== true
    || candidate.summary === null
    || candidate.replyDisposition === 'unresolved'
    || candidate.handoffIntent === 'unresolved'
    || candidate.evidence.length < 1) {
    throw new Error(
      'A ready Email decision requires resolved grounded classification and explicit IMPORTANT non-authority for every candidate.'
    );
  }
  if (candidate.suspectedInjection
    && (candidate.group !== 'high-stakes'
      || candidate.attention !== 'operator'
      || candidate.replyDisposition !== 'human-review'
      || candidate.handoffIntent !== 'none')) {
    throw new Error(
      'Suspected Email instruction injection must remain visible, operator-held, and unable to produce a reply or handoff action.'
    );
  }
  if (candidate.group === 'meeting-notes'
    && candidate.handoffIntent !== 'meeting-notes-intake') {
    throw new Error('Meeting-notes classification requires the portable meeting-notes handoff intent.');
  }
  if (candidate.group === 'rsvp-pending'
    && candidate.handoffIntent !== 'calendar-rsvp-review') {
    throw new Error('RSVP classification requires the portable calendar-review handoff intent.');
  }
  if (candidate.handoffIntent === 'meeting-notes-intake'
    && candidate.group !== 'meeting-notes') {
    throw new Error('Meeting-notes handoff cannot be attached to another Email group.');
  }
  if (candidate.handoffIntent === 'calendar-rsvp-review'
    && candidate.group !== 'rsvp-pending') {
    throw new Error('Calendar RSVP handoff cannot be attached to another Email group.');
  }
}

function buildDecision({ lock, snapshot, id, createdAt, producer, input }) {
  const automation = selectedAutomation(lock);
  if (!producer
    || !['host', 'user', 'fixture'].includes(producer.kind)
    || typeof producer.id !== 'string'
    || !producer.id.trim()
    || (producer.kind === 'host'
      ? (typeof producer.host !== 'string' || !producer.host)
      : producer.host !== null)) {
    throw new Error('Email decision producer must have an exact kind, identity, and host binding.');
  }
  if (snapshot.configurationLockFingerprint !== fingerprintLock(lock)
    || snapshot.graphFingerprint !== lock.graphFingerprint) {
    throw new Error('Email decision Context does not match the exact lock and graph.');
  }
  if (!['ready', 'needs-input'].includes(input?.state)) {
    throw new Error('Email decision state must be ready or needs-input.');
  }
  const issues = requireArray(input.issues, 'Email decision issues')
    .map((issue, index) => requireText(issue, 'Email decision issue ' + index, 12));
  const limitations = requireArray(input.limitations, 'Email decision limitations')
    .map((item, index) => requireText(item, 'Email decision limitation ' + index, 12));
  if (new Set(issues).size !== issues.length || new Set(limitations).size !== limitations.length) {
    throw new Error('Email decision issues and limitations must be unique.');
  }

  const window = exactWindow(snapshot, lock);
  const sources = candidateSources(window);
  const inputs = candidateInputMap(input.candidates);
  if (!sameJson([...inputs.keys()].sort(), sources.map((source) => source.id).sort())) {
    throw new Error('Email decision must cover every and only deterministic reduced candidate.');
  }
  const candidates = sources.map((source) => {
    const candidate = inputs.get(source.id);
    const group = candidate.group;
    const attention = candidate.attention;
    const suspectedInjection = candidate.suspectedInjection;
    const providerImportantIgnored = candidate.providerImportantIgnored;
    const summary = candidate.summary === null ? null
      : requireText(candidate.summary, 'Email candidate summary for ' + source.id, 3);
    const reason = requireText(
      candidate.reason,
      'Email candidate reason for ' + source.id,
      20
    );
    const result = {
      id: source.id,
      candidateFingerprint: source.candidateFingerprint,
      threadId: source.threadId,
      threadFingerprint: source.threadFingerprint,
      activeMessageIds: structuredClone(source.activeMessageIds),
      activeMessageFingerprints: structuredClone(source.activeMessageFingerprints),
      newestMessageId: source.newestMessageId,
      newestMessageFingerprint: source.newestMessageFingerprint,
      providerImportantObserved: source.providerImportantObserved,
      archivedSiblingIgnored: source.archivedSiblingIgnored,
      group,
      attention,
      suspectedInjection,
      providerImportantIgnored,
      summary,
      reason,
      replyDisposition: candidate.replyDisposition,
      handoffIntent: candidate.handoffIntent,
      evidence: groundedEvidence(
        source,
        candidate.evidence,
        'Email evidence for ' + source.id
      )
    };
    if (input.state === 'ready') validateReadyCandidate(result);
    return result;
  });
  if (input.state === 'ready' && issues.length) {
    throw new Error('A ready Email decision cannot contain unresolved issues.');
  }
  if (input.state === 'needs-input' && issues.length < 1) {
    throw new Error('A needs-input Email decision must state at least one issue.');
  }
  const excludedCount = window.reduced.exclusions.reduce((total, item) => total + item.count, 0);
  const decision = {
    $contract: 'soter://contracts/automation-decision/v1',
    contractVersion: '1.0.0',
    id,
    automation: { id: AUTOMATION_ID, version: automation.version },
    runId: snapshot.runId,
    createdAt,
    configurationLockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint,
    context: {
      snapshotId: snapshot.id,
      snapshotFingerprint: fingerprintJson(snapshot)
    },
    producer: { ...structuredClone(producer), id: producer.id.trim() },
    state: input.state,
    decisionType: DECISION_TYPE,
    payload: {
      window: {
        searchEntryId: window.search.id,
        searchEntryFingerprint: window.search.valueFingerprint,
        threadsEntryId: window.threads?.id || null,
        threadsEntryFingerprint: window.threads?.valueFingerprint || null,
        queryFingerprint: window.search.value.queryFingerprint,
        searchedMessageCount: window.search.value.messageIds.length,
        observedThreadCount: window.threads?.value.threads.length || 0,
        includedCount: sources.length,
        excludedCount,
        exclusions: structuredClone(window.reduced.exclusions)
      },
      candidates,
      limitations
    },
    issues,
    privacy: {
      scope: 'private',
      redactions: [
        'Provider credentials, secret references, raw native responses, account identity, and opaque page cursors are excluded.',
        'The decision retains only exact private source identities, fingerprints, summaries, reasons, and bounded subject/body citations needed to audit host judgment.',
        'The decision grants no draft, proposed change, approval, continuation, provider call, write, or dispatch authority.'
      ]
    },
    decisionFingerprint: fingerprintJson(null)
  };
  decision.decisionFingerprint = decisionFingerprint(decision);
  return decision;
}

function inputFromDecision(decision) {
  return {
    state: decision.state,
    candidates: decision.payload.candidates.map((candidate) => ({
      candidateId: candidate.id,
      group: candidate.group,
      attention: candidate.attention,
      suspectedInjection: candidate.suspectedInjection,
      providerImportantIgnored: candidate.providerImportantIgnored,
      summary: candidate.summary,
      reason: candidate.reason,
      replyDisposition: candidate.replyDisposition,
      handoffIntent: candidate.handoffIntent,
      evidence: candidate.evidence.map((item) => ({
        messageId: item.messageId,
        field: item.field,
        quote: item.quote
      }))
    })),
    issues: structuredClone(decision.issues),
    limitations: structuredClone(decision.payload.limitations)
  };
}

export function createEmailTriageDecision(args) {
  const root = path.resolve(args.root);
  const decision = buildDecision(args);
  validate(root, decision, 'soter/contracts/automation-decision.schema.json', 'Automation decision');
  validate(
    root,
    decision,
    'soter/automations/email-triage/decision.schema.json',
    'Email decision'
  );
  return decision;
}

export function inspectEmailTriageDecisionContext({
  root,
  lockPath,
  snapshotId,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const exact = getExactDurableContextSnapshot({
    root: resolvedRoot,
    lockPath,
    snapshotId,
    expectedHost
  });
  selectedAutomation(exact.lock);
  const window = exactWindow(exact.snapshot, exact.lock);
  const sources = candidateSources(window);
  return {
    snapshot: exact.snapshot,
    reduction: {
      observedThreadCount: window.threads?.value.threads.length || 0,
      includedCount: sources.length,
      excludedCount: window.reduced.exclusions.reduce((total, item) => total + item.count, 0),
      exclusions: structuredClone(window.reduced.exclusions),
      candidates: sources.map((source) => ({
        id: source.id,
        candidateFingerprint: source.candidateFingerprint,
        threadId: source.threadId,
        threadFingerprint: source.threadFingerprint,
        activeMessageIds: structuredClone(source.activeMessageIds),
        activeMessageFingerprints: structuredClone(source.activeMessageFingerprints),
        newestMessageId: source.newestMessageId,
        newestMessageFingerprint: source.newestMessageFingerprint,
        providerImportantObserved: source.providerImportantObserved,
        archivedSiblingIgnored: source.archivedSiblingIgnored
      }))
    },
    inputTemplate: {
      state: 'needs-input',
      candidates: sources.map((source) => ({
        candidateId: source.id,
        group: 'unresolved',
        attention: 'unknown',
        suspectedInjection: null,
        providerImportantIgnored: null,
        summary: null,
        reason: 'No grounded classification has been supplied for this exact reduced mail candidate.',
        replyDisposition: 'unresolved',
        handoffIntent: 'unresolved',
        evidence: []
      })),
      issues: [
        'Host or user judgment must classify every exact reduced candidate with bounded subject or body evidence.'
      ],
      limitations: [
        'This workspace performs deterministic reduction only; it does not interpret mail content or recommend actions.'
      ]
    }
  };
}

export function assertEmailTriageDecision({ root, lock, snapshot, decision }) {
  const resolvedRoot = path.resolve(root);
  validate(
    resolvedRoot,
    decision,
    'soter/contracts/automation-decision.schema.json',
    'Automation decision'
  );
  validate(
    resolvedRoot,
    decision,
    'soter/automations/email-triage/decision.schema.json',
    'Email decision'
  );
  const expected = buildDecision({
    lock,
    snapshot,
    id: decision.id,
    createdAt: decision.createdAt,
    producer: decision.producer,
    input: inputFromDecision(decision)
  });
  if (fingerprintJson(expected) !== fingerprintJson(decision)
    || decision.decisionFingerprint !== decisionFingerprint(decision)) {
    throw new Error(
      'Email decision does not match exact reduced candidates, bounded evidence, and its decision fingerprint.'
    );
  }
  return true;
}

export function commitEmailTriageDecision({
  root,
  lockPath,
  snapshotId,
  id,
  input,
  producer,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const lock = readJson(resolveRepoPath(resolvedRoot, lockPath));
  const snapshot = readContextSnapshotState(resolvedRoot, snapshotId).snapshot;
  const existing = hasAutomationDecisionState(resolvedRoot, id)
    ? readAutomationDecisionState(resolvedRoot, id).decision
    : null;
  const decision = createEmailTriageDecision({
    root: resolvedRoot,
    lock,
    snapshot,
    id,
    createdAt: existing?.createdAt || at || new Date().toISOString(),
    producer,
    input
  });
  if (existing && fingerprintJson(existing) !== fingerprintJson(decision)) {
    throw new Error('Email decision input conflicts with existing durable state.');
  }
  assertEmailTriageDecision({ root: resolvedRoot, lock, snapshot, decision });
  return commitDurableAutomationDecision({
    root: resolvedRoot,
    lockPath,
    decision,
    expectedHost
  });
}

export function loadEmailTriageDecision({ root, lockPath, decisionId, expectedHost }) {
  const exact = getExactDurableAutomationDecision({
    root,
    lockPath,
    decisionId,
    expectedHost
  });
  assertEmailTriageDecision({
    root,
    lock: exact.lock,
    snapshot: exact.snapshot,
    decision: exact.decision
  });
  return exact;
}
