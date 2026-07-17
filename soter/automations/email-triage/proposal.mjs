import path from 'node:path';

import { validateJsonSchema } from '../../kernel/verify.mjs';
import {
  automationProposalFingerprint,
  automationProposalMaterialFingerprint,
  commitDurableAutomationProposal,
  getExactDurableAutomationProposal,
  loadAutomationProposalDeclaration
} from '../../core/automation-proposals.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import {
  assertAutomationReviewProjection,
  derivedReviewContentFingerprint
} from '../../core/review-projections.mjs';
import {
  hasAutomationProposalState,
  readAutomationProposalState
} from '../../core/runtime-state.mjs';
import { assertEmailTriageDecision, loadEmailTriageDecision } from './decision.mjs';

const AUTOMATION_ID = 'automation.email-triage';
const PROPOSAL_TYPE = 'email-triage.review-proposal';
const REVIEW_KIND = 'email-triage-review';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const ZERO_FINGERPRINT = 'sha256:' + '0'.repeat(64);
const MACHINE_GROUPS = new Set(['notifications', 'admin-billing', 'marketing']);
const LIMITATIONS = [
  'This private review proposal creates no approval, confirmation, continuation, provider call, write, dispatch, proof, maturity, or migration authority.',
  'Email approval remains unavailable until a separate selected-activity private exact-batch review contract binds complete human-readable values to one exact batch and approval request.',
  'Contained and connected acquisition evidence does not establish live label or draft write behavior; exact later verification must re-read labels and list drafts without retrying ambiguity into place.'
];

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validate(root, value, schemaPath, label) {
  const failures = validateJsonSchema(value, readJson(path.join(root, schemaPath)));
  if (failures.length) {
    throw new Error(
      label + ' does not satisfy its contract: '
        + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
}

function rowFingerprint(row) {
  const unsigned = structuredClone(row);
  delete unsigned.fingerprint;
  delete unsigned.privateDetailFingerprint;
  for (const action of unsigned.actions) delete action.changeFingerprint;
  return fingerprintJson(unsigned);
}

function collectionFingerprint(collection) {
  const unsigned = structuredClone(collection);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function field(id, label, type, reviewValue) {
  return { id, label, type, reviewValue, fingerprint: fingerprintJson(reviewValue) };
}

function item(id, kind, sources, fields) {
  const result = { id, kind, sources, fields, fingerprint: ZERO_FINGERPRINT };
  const unsigned = structuredClone(result);
  delete unsigned.fingerprint;
  result.fingerprint = fingerprintJson(unsigned);
  return result;
}

function sourceFor(collectionId, row) {
  return { collectionId, rowId: row.id, rowFingerprint: row.fingerprint };
}

function labelKey(group) {
  return {
    'needs-you': 'needsYou',
    'high-stakes': 'highStakes',
    'rsvp-pending': 'rsvpPending',
    'meeting-notes': 'meetingNotes',
    notifications: 'notifications',
    'admin-billing': 'adminBilling',
    marketing: 'marketing'
  }[group];
}

function reasonCode(group) {
  return {
    'needs-you': 'EMAIL_NEEDS_YOU',
    'high-stakes': 'EMAIL_HIGH_STAKES',
    'rsvp-pending': 'EMAIL_RSVP_PENDING',
    'meeting-notes': 'EMAIL_MEETING_NOTES_HANDOFF',
    notifications: 'EMAIL_NOTIFICATION',
    'admin-billing': 'EMAIL_ADMIN_BILLING',
    marketing: 'EMAIL_MARKETING'
  }[group];
}

function exactSettings(lock) {
  const settings = lock.settings?.['integration.gmail'];
  const required = [
    'needsYou', 'highStakes', 'rsvpPending', 'meetingNotes',
    'notifications', 'adminBilling', 'marketing', 'needsReview', 'triaged'
  ];
  if (!settings?.labels
    || required.some((key) => typeof settings.labels[key] !== 'string')
    || required.some((key) => !settings.labels[key].startsWith('AI/'))
    || settings.labels.triaged !== 'AI/Triaged') {
    throw new Error('Email proposal requires the exact configured AI label namespace.');
  }
  return settings;
}

function exactSources(snapshot, decision) {
  const entry = snapshot.entries.find((item) => {
    return item.id === decision.payload.window.threadsEntryId
      && item.capability === 'mail.threads.read';
  });
  const threads = entry?.value?.threads;
  if (!Array.isArray(threads)) {
    throw new Error('Email proposal requires the exact private thread Context entry.');
  }
  const threadMap = new Map(threads.map((thread) => [thread.id, thread]));
  return new Map(decision.payload.candidates.map((candidate) => {
    const thread = threadMap.get(candidate.threadId);
    if (!thread || fingerprintJson(thread) !== candidate.threadFingerprint) {
      throw new Error('Email proposal candidate thread binding is stale.');
    }
    const messageMap = new Map(thread.messages.map((message) => [message.id, message]));
    const active = candidate.activeMessageIds.map((id, index) => {
      const message = messageMap.get(id);
      if (!message || fingerprintJson(message) !== candidate.activeMessageFingerprints[index]) {
        throw new Error('Email proposal candidate message binding is stale.');
      }
      return message;
    });
    const newest = messageMap.get(candidate.newestMessageId);
    if (!newest || fingerprintJson(newest) !== candidate.newestMessageFingerprint) {
      throw new Error('Email proposal newest-message binding is stale.');
    }
    return [candidate.id, { candidate, thread, active, newest }];
  }));
}

function exactInputs(decision, input, inputSchemaPath) {
  const failures = validateJsonSchema(input, readJson(inputSchemaPath));
  if (failures.length) {
    throw new Error(
      'Email private proposal input does not satisfy its contract: '
        + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
  const ids = input.candidates.map((candidate) => candidate.candidateId);
  const expected = decision.payload.candidates.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length
    || fingerprintJson([...ids].sort()) !== fingerprintJson([...expected].sort())) {
    throw new Error('Email proposal input must cover every and only ready decision candidate.');
  }
  const result = new Map(input.candidates.map((candidate) => [candidate.candidateId, candidate]));
  for (const decisionCandidate of decision.payload.candidates) {
    const candidate = result.get(decisionCandidate.id);
    const requiresDraft = decisionCandidate.replyDisposition === 'draft-review';
    const requiresTask = decisionCandidate.handoffIntent === 'task-review';
    const requiresUpdate = decisionCandidate.handoffIntent === 'record-update-review';
    if (requiresDraft !== (typeof candidate.draftBody === 'string')
      || requiresTask !== (candidate.taskHandoff !== null)
      || requiresUpdate !== (candidate.updateHandoff !== null)) {
      throw new Error(
        'Email proposal private values do not match the exact decision reply and handoff dispositions.'
      );
    }
    if (decisionCandidate.suspectedInjection
      && (candidate.draftBody !== null
        || candidate.taskHandoff !== null
        || candidate.updateHandoff !== null)) {
      throw new Error('Suspected Email instruction injection cannot produce a draft or handoff value.');
    }
  }
  return result;
}

function groupedSources(decision, sources) {
  const groups = [];
  const machine = new Map();
  for (const candidate of decision.payload.candidates) {
    const source = sources.get(candidate.id);
    if (MACHINE_GROUPS.has(candidate.group)) {
      let group = machine.get(candidate.group);
      if (!group) {
        group = [];
        machine.set(candidate.group, group);
        groups.push(group);
      }
      group.push(source);
    } else {
      groups.push([source]);
    }
  }
  return groups;
}

function flagsFor(sources) {
  const flags = [];
  if (sources.some(({ candidate }) => candidate.suspectedInjection)) {
    flags.push('SUSPECTED_INSTRUCTION_INJECTION');
  }
  if (sources.some(({ candidate }) => candidate.providerImportantObserved)) {
    flags.push('PROVIDER_IMPORTANT_IGNORED');
  }
  if (sources.some(({ candidate }) => candidate.archivedSiblingIgnored)) {
    flags.push('ARCHIVED_TRASH_SIBLING_IGNORED');
  }
  return flags;
}

function buildReview({ decision, sources, inputs, settings, derivedReviewDefinition }) {
  const rows = [];
  const privateItems = [];
  const proposedChanges = [];
  const groups = groupedSources(decision, sources);
  for (let index = 0; index < groups.length; index += 1) {
    const members = groups[index];
    const sequence = index + 1;
    const suffix = String(sequence).padStart(3, '0');
    const first = members[0].candidate;
    const actions = [];
    for (const member of members) {
      const candidate = member.candidate;
      const actionBase = 'action.email.' + candidate.id.slice('candidate.email.'.length);
      if (candidate.suspectedInjection) {
        actions.push({
          id: actionBase + '.held',
          kind: 'none',
          capability: null,
          effect: null,
          state: 'held',
          reasonCode: 'SUSPECTED_INJECTION_REQUIRES_HUMAN_REVIEW'
        });
      } else {
        actions.push({
          id: actionBase + '.label',
          kind: 'label',
          capability: 'mail.labels.apply',
          effect: 'write',
          state: 'proposed',
          reasonCode: 'AI_NAMESPACE_LABEL_PROPOSED',
          changeFingerprint: null
        });
      }
      if (candidate.replyDisposition === 'draft-review') {
        actions.push({
          id: actionBase + '.draft',
          kind: 'draft',
          capability: 'mail.drafts.create',
          effect: 'write',
          state: 'proposed',
          reasonCode: 'REPLY_DRAFT_PROPOSED',
          changeFingerprint: null
        });
      }
      const handoff = {
        'task-review': ['task-handoff', 'TASK_REVIEW_HANDOFF'],
        'record-update-review': ['update-handoff', 'RECORD_UPDATE_REVIEW_HANDOFF'],
        'meeting-notes-intake': ['meeting-handoff', 'MEETING_INTAKE_HANDOFF'],
        'calendar-rsvp-review': ['calendar-handoff', 'CALENDAR_REVIEW_HANDOFF']
      }[candidate.handoffIntent];
      if (handoff) {
        actions.push({
          id: actionBase + '.' + handoff[0],
          kind: candidate.handoffIntent,
          capability: null,
          effect: null,
          state: 'handoff',
          reasonCode: handoff[1]
        });
      }
    }
    const row = {
      id: 'row.email.' + suffix,
      sequence,
      representedCount: members.length,
      subject: {
        kind: members.length > 1 ? 'mail-bucket' : 'mail-thread',
        fingerprint: fingerprintJson(members.map(({ candidate }) => candidate.candidateFingerprint))
      },
      group: first.group,
      attention: members.some(({ candidate }) => candidate.attention === 'operator')
        ? 'operator'
        : 'no-one',
      disposition: MACHINE_GROUPS.has(first.group)
        ? 'collapsed'
        : ['meeting-notes', 'rsvp-pending'].includes(first.group) ? 'handoff' : 'itemized',
      reasonCode: members.length > 1
        ? 'MACHINE_MAIL_BUCKET_COLLAPSED'
        : reasonCode(first.group),
      flags: flagsFor(members),
      actions,
      privateDetailFingerprint: null,
      fingerprint: ZERO_FINGERPRINT
    };
    row.fingerprint = rowFingerprint(row);
    const source = sourceFor('collection.email.window', row);
    const allMessages = members.flatMap((member) => member.active);
    const detail = item(
      'review-item.email.' + suffix + '.detail',
      'thread-detail',
      [source],
      [
        field(
          'sender',
          'Sender',
          'text',
          members.length > 1 ? 'Multiple machine senders' : members[0].newest.from
        ),
        field(
          'participants',
          'Participants',
          'string-list',
          [...new Set(allMessages.flatMap((message) => [message.from, ...message.to]))].sort()
        ),
        field(
          'subject',
          'Subject',
          'text',
          members.length > 1 ? 'Collapsed machine mail' : members[0].newest.subject
        ),
        field(
          'summary',
          'Summary',
          'text',
          members.map(({ candidate }) => candidate.summary).join('\n')
        ),
        field(
          'reason',
          'Review reason',
          'text',
          members.map(({ candidate }) => candidate.reason).join('\n')
        ),
        field('waitingOn', 'Waiting on', 'text', row.attention)
      ]
    );
    row.privateDetailFingerprint = detail.fingerprint;
    privateItems.push(detail);

    for (const member of members) {
      const candidate = member.candidate;
      const input = inputs.get(candidate.id);
      const actionBase = 'action.email.' + candidate.id.slice('candidate.email.'.length);
      const candidateSource = sourceFor('collection.email.window', row);
      const labelAction = actions.find((action) => action.id === actionBase + '.label');
      if (labelAction) {
        const label = item(
          'review-item.email.' + candidate.id.slice('candidate.email.'.length) + '.label',
          'label',
          [candidateSource],
          [
            field('messageIds', 'Exact message IDs', 'string-list', candidate.activeMessageIds),
            field('labelName', 'Exact label name', 'text', settings.labels[labelKey(candidate.group)])
          ]
        );
        privateItems.push(label);
        const change = {
          id: labelAction.id,
          recordId: labelAction.id,
          effect: labelAction.capability,
          beforeFingerprint: null,
          afterFingerprint: label.fingerprint
        };
        labelAction.changeFingerprint = fingerprintJson(change);
        proposedChanges.push(change);
      }
      const draftAction = actions.find((action) => action.id === actionBase + '.draft');
      if (draftAction) {
        const draft = item(
          'review-item.email.' + candidate.id.slice('candidate.email.'.length) + '.draft',
          'draft',
          [candidateSource],
          [
            field('replyMessageId', 'Exact reply message ID', 'text', candidate.newestMessageId),
            field('recipients', 'Recipients', 'string-list', [member.newest.from]),
            field('subject', 'Draft subject', 'text', 'Re: ' + member.newest.subject),
            field('body', 'Complete draft body', 'text', input.draftBody)
          ]
        );
        privateItems.push(draft);
        const change = {
          id: draftAction.id,
          recordId: draftAction.id,
          effect: draftAction.capability,
          beforeFingerprint: null,
          afterFingerprint: draft.fingerprint
        };
        draftAction.changeFingerprint = fingerprintJson(change);
        proposedChanges.push(change);
      }
      if (candidate.handoffIntent === 'task-review') {
        privateItems.push(item(
          'review-item.email.' + candidate.id.slice('candidate.email.'.length) + '.task-handoff',
          'task-handoff',
          [candidateSource],
          [
            field('title', 'Task title', 'text', input.taskHandoff.title),
            field('detail', 'Task detail', 'text', input.taskHandoff.detail),
            field('context', 'Task context', 'text', input.taskHandoff.context)
          ]
        ));
      }
      if (candidate.handoffIntent === 'record-update-review') {
        privateItems.push(item(
          'review-item.email.' + candidate.id.slice('candidate.email.'.length) + '.update-handoff',
          'update-handoff',
          [candidateSource],
          [
            field('recordReference', 'Record reference', 'text', input.updateHandoff.recordReference),
            field('detail', 'Update detail', 'text', input.updateHandoff.detail)
          ]
        ));
      }
      if (candidate.handoffIntent === 'meeting-notes-intake') {
        privateItems.push(item(
          'review-item.email.' + candidate.id.slice('candidate.email.'.length) + '.meeting-handoff',
          'meeting-handoff',
          [candidateSource],
          [
            field('meetingReference', 'Meeting reference', 'text', fingerprintJson(member.newest.rfc822MessageId)),
            field('sourceThreadReference', 'Source thread', 'text', candidate.threadId),
            field('noteReference', 'Note source', 'text', candidate.newestMessageId)
          ]
        ));
      }
      if (candidate.handoffIntent === 'calendar-rsvp-review') {
        privateItems.push(item(
          'review-item.email.' + candidate.id.slice('candidate.email.'.length) + '.calendar-handoff',
          'calendar-handoff',
          [candidateSource],
          [
            field('calendarReference', 'Calendar reference', 'text', fingerprintJson(member.newest.rfc822MessageId)),
            field('sourceThreadReference', 'Source thread', 'text', candidate.threadId)
          ]
        ));
      }
    }
    rows.push(row);
  }

  const window = decision.payload.window;
  const windowCollection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: 'collection.email.window',
    kind: 'email-triage-window',
    labelKey: 'email-triage-window',
    coverage: {
      complete: true,
      observedCount: window.observedThreadCount,
      includedCount: window.includedCount,
      excludedCount: window.excludedCount,
      exclusions: structuredClone(window.exclusions)
    },
    rows,
    fingerprint: ZERO_FINGERPRINT
  };
  windowCollection.fingerprint = collectionFingerprint(windowCollection);

  const digestRow = {
    id: 'row.email.digest',
    sequence: 1,
    representedCount: 1,
    subject: {
      kind: 'email-digest',
      fingerprint: fingerprintJson(rows.map((row) => row.fingerprint))
    },
    group: 'digest',
    attention: 'operator',
    disposition: 'itemized',
    reasonCode: 'DIGEST_READY_FOR_PRIVATE_REVIEW',
    flags: ['EMAIL_SEND_PROHIBITED', 'SELECTED_ACTIVITY_APPROVAL_REVIEW_UNAVAILABLE'],
    actions: [
      {
        id: 'action.email.digest.held',
        kind: 'none',
        capability: null,
        effect: null,
        state: 'held',
        reasonCode: 'DIGEST_WRITE_DESTINATION_UNAVAILABLE'
      },
      {
        id: 'action.email.send.prohibited',
        kind: 'none',
        capability: null,
        effect: 'dispatch',
        state: 'prohibited',
        reasonCode: 'EMAIL_SEND_PROHIBITED'
      }
    ],
    privateDetailFingerprint: null,
    fingerprint: ZERO_FINGERPRINT
  };
  digestRow.fingerprint = rowFingerprint(digestRow);
  const digestSources = [
    sourceFor('collection.email.outputs', digestRow),
    ...rows.map((row) => sourceFor('collection.email.window', row))
  ];
  const digest = item(
    'review-item.email.digest',
    'digest',
    digestSources,
    [field('body', 'Complete digest body', 'text', inputs.digestBody)]
  );
  digestRow.privateDetailFingerprint = digest.fingerprint;
  privateItems.push(digest);
  const outputCollection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: 'collection.email.outputs',
    kind: 'email-triage-outputs',
    labelKey: 'email-triage-outputs',
    coverage: {
      complete: true,
      observedCount: 1,
      includedCount: 1,
      excludedCount: 0,
      exclusions: []
    },
    rows: [digestRow],
    fingerprint: ZERO_FINGERPRINT
  };
  outputCollection.fingerprint = collectionFingerprint(outputCollection);

  const derivedReview = { kind: derivedReviewDefinition.kind, items: privateItems };
  const contentFingerprint = derivedReviewContentFingerprint(derivedReview);
  const review = {
    $contract: 'soter://contracts/automation-review/v1',
    contractVersion: '1.0.0',
    kind: REVIEW_KIND,
    fingerprint: ZERO_FINGERPRINT,
    facts: [
      { id: 'query-fingerprint', label: 'Mailbox query fingerprint', value: window.queryFingerprint, state: 'supported', basisIds: ['automation-decision'] },
      { id: 'raw-thread-count', label: 'Observed mailbox threads', value: window.observedThreadCount, state: 'supported', basisIds: ['automation-decision'] },
      { id: 'included-item-count', label: 'Included reduced items', value: window.includedCount, state: 'supported', basisIds: ['automation-decision'] },
      { id: 'review-row-count', label: 'Review rows', value: rows.length, state: 'supported', basisIds: ['automation-proposal'] },
      { id: 'provider-important-authority', label: 'Provider IMPORTANT classification authority', value: false, state: 'supported', basisIds: ['email-policy'] },
      { id: 'send-capability-declared', label: 'Mail send capability declared', value: false, state: 'supported', basisIds: ['email-policy'] }
    ],
    contradictions: [
      { id: 'suspected-injection-cannot-authorize-actions', claim: 'Suspected mail-content instructions remain visible and produce no proposed external action.', state: 'observed', basisIds: ['automation-decision'] },
      { id: 'provider-important-is-not-classification', claim: 'Provider IMPORTANT does not determine Email classification.', state: 'observed', basisIds: ['email-policy'] }
    ],
    collections: [windowCollection, outputCollection],
    privateReview: {
      state: 'available',
      kind: derivedReview.kind,
      contractId: derivedReviewDefinition.$contract,
      contractFingerprint: fingerprintJson(derivedReviewDefinition),
      contentFingerprint
    },
    proposedChanges
  };
  const unsigned = structuredClone(review);
  delete unsigned.fingerprint;
  review.fingerprint = fingerprintJson(unsigned);
  return { review, derivedReview };
}

export function createEmailTriageProposal({
  root,
  lock,
  snapshot,
  decision,
  id,
  createdAt,
  producer,
  input
}) {
  const resolvedRoot = path.resolve(root);
  assertEmailTriageDecision({ root: resolvedRoot, lock, snapshot, decision });
  if (decision.state !== 'ready') {
    throw new Error('Email proposal requires one exact ready grounded decision.');
  }
  const declaration = loadAutomationProposalDeclaration(resolvedRoot, lock, AUTOMATION_ID);
  if (declaration.declaration.export !== 'createEmailTriageProposal') {
    const error = new Error(
      'Email proposal manifest does not select the exact pack-owned builder export.'
    );
    error.code = 'AUTOMATION_PROPOSAL_ADAPTER_INVALID';
    throw error;
  }
  const settings = exactSettings(lock);
  const sources = exactSources(snapshot, decision);
  const inputs = exactInputs(decision, input, declaration.inputSchemaPath);
  inputs.digestBody = input.digestBody;
  const { review, derivedReview } = buildReview({
    decision,
    sources,
    inputs,
    settings,
    derivedReviewDefinition: declaration.derivedReviewDefinition
  });
  const proposal = {
    $contract: 'soter://contracts/automation-proposal/v1',
    contractVersion: '1.0.0',
    id,
    automation: structuredClone(decision.automation),
    runId: decision.runId,
    createdAt: new Date(createdAt).toISOString(),
    configurationLockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint,
    decision: {
      id: decision.id,
      fingerprint: decision.decisionFingerprint,
      decisionType: decision.decisionType,
      contextSnapshotId: decision.context.snapshotId,
      contextSnapshotFingerprint: decision.context.snapshotFingerprint
    },
    producer: structuredClone(producer),
    state: 'ready-for-review',
    proposalType: PROPOSAL_TYPE,
    review,
    limitations: structuredClone(LIMITATIONS),
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_PROPOSAL_REVIEW_ONLY',
      permittedNextAction: 'inspect-private-proposal-material'
    },
    privacy: {
      scope: 'private-sanitized-proposal',
      rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false,
      privateValuesIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsWritten: false,
      externalWritesPerformed: false
    },
    proposalFingerprint: ZERO_FINGERPRINT
  };
  proposal.proposalFingerprint = automationProposalFingerprint(proposal);
  const material = {
    $contract: 'soter://contracts/automation-proposal-material/v1',
    contractVersion: '1.0.0',
    createdAt: proposal.createdAt,
    proposal: { id: proposal.id, fingerprint: proposal.proposalFingerprint },
    decision: { id: decision.id, fingerprint: decision.decisionFingerprint },
    automation: structuredClone(proposal.automation),
    configuration: {
      name: lock.configuration.name,
      lockFingerprint: proposal.configurationLockFingerprint,
      graphFingerprint: proposal.graphFingerprint
    },
    reviewContractId: declaration.derivedReviewDefinition.$contract,
    reviewContractFingerprint: fingerprintJson(declaration.derivedReviewDefinition),
    applicability: 'current',
    kind: derivedReview.kind,
    contentFingerprint: derivedReviewContentFingerprint(derivedReview),
    items: structuredClone(derivedReview.items),
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_PROPOSAL_MATERIAL_REVIEW_ONLY'
    },
    privacy: {
      scope: 'private-local-automation-proposal',
      projection: 'selected-proposal-only',
      rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false,
      workspaceInspectionIncluded: false,
      evidenceIncluded: false,
      canonicalArtifactsIncluded: false
    },
    fingerprint: ZERO_FINGERPRINT
  };
  material.fingerprint = automationProposalMaterialFingerprint(material);

  validate(resolvedRoot, review, 'soter/contracts/automation-review.schema.json', 'Email proposal review');
  validate(resolvedRoot, proposal, 'soter/contracts/automation-proposal.schema.json', 'Automation proposal');
  validate(resolvedRoot, proposal, declaration.declaration.schema, 'Email proposal');
  validate(
    resolvedRoot,
    material,
    'soter/contracts/automation-proposal-material.schema.json',
    'Automation proposal material'
  );
  assertAutomationReviewProjection({
    preview: review,
    derivedReview,
    automationPack: declaration.manifest,
    lock,
    derivedReviewDefinition: declaration.derivedReviewDefinition,
    invalid: (message) => codedError('AUTOMATION_PROPOSAL_BINDING_INVALID', message),
    materialInvalid: (code, message) => codedError(
      'AUTOMATION_PROPOSAL_MATERIAL_' + code,
      message
    )
  });
  return { proposal, material };
}

export function inspectEmailTriageProposalDecision({
  root,
  lockPath,
  decisionId,
  expectedHost
}) {
  const exact = loadEmailTriageDecision({ root, lockPath, decisionId, expectedHost });
  if (exact.decision.state !== 'ready') {
    throw new Error('Email proposal inspection requires a ready grounded decision.');
  }
  return {
    decision: exact.decision,
    inputTemplate: {
      candidates: exact.decision.payload.candidates.map((candidate) => ({
        candidateId: candidate.id,
        draftBody: null,
        taskHandoff: null,
        updateHandoff: null
      })),
      digestBody: null
    },
    authority: {
      state: 'none',
      reasonCode: 'AUTOMATION_PROPOSAL_INPUT_REQUIRED'
    }
  };
}

export function commitEmailTriageProposal({
  root,
  lockPath,
  decisionId,
  id,
  input,
  producer,
  at,
  expectedHost
}) {
  const resolvedRoot = path.resolve(root);
  const exact = loadEmailTriageDecision({
    root: resolvedRoot,
    lockPath,
    decisionId,
    expectedHost
  });
  const existing = hasAutomationProposalState(resolvedRoot, id)
    ? readAutomationProposalState(resolvedRoot, id).proposal
    : null;
  const { proposal, material } = createEmailTriageProposal({
    root: resolvedRoot,
    lock: exact.lock,
    snapshot: exact.snapshot,
    decision: exact.decision,
    id,
    createdAt: existing?.createdAt || at || new Date().toISOString(),
    producer,
    input
  });
  return commitDurableAutomationProposal({
    root: resolvedRoot,
    lockPath,
    decisionId,
    proposal,
    material,
    expectedHost
  });
}

export function loadEmailTriageProposal({ root, lockPath, proposalId, expectedHost }) {
  const exact = getExactDurableAutomationProposal({
    root,
    lockPath,
    proposalId,
    expectedHost
  });
  if (exact.proposal.automation.id !== AUTOMATION_ID
    || exact.proposal.proposalType !== PROPOSAL_TYPE
    || exact.proposal.review.kind !== REVIEW_KIND) {
    throw codedError(
      'AUTOMATION_PROPOSAL_BINDING_INVALID',
      'Durable proposal is not an Email triage proposal.'
    );
  }
  const items = new Map(exact.material.items.map((candidate) => [candidate.id, candidate]));
  const fieldValue = (reviewItem, fieldId) => {
    const matches = reviewItem?.fields?.filter((candidate) => candidate.id === fieldId) || [];
    if (matches.length !== 1) {
      throw codedError(
        'AUTOMATION_PROPOSAL_MATERIAL_BINDING_INVALID',
        'Email proposal material cannot reconstruct one exact pack-owned field.'
      );
    }
    return structuredClone(matches[0].reviewValue);
  };
  const input = {
    candidates: exact.decision.payload.candidates.map((candidate) => {
      const suffix = candidate.id.slice('candidate.email.'.length);
      const draft = items.get('review-item.email.' + suffix + '.draft') || null;
      const task = items.get('review-item.email.' + suffix + '.task-handoff') || null;
      const update = items.get('review-item.email.' + suffix + '.update-handoff') || null;
      return {
        candidateId: candidate.id,
        draftBody: draft ? fieldValue(draft, 'body') : null,
        taskHandoff: task ? {
          title: fieldValue(task, 'title'),
          detail: fieldValue(task, 'detail'),
          context: fieldValue(task, 'context')
        } : null,
        updateHandoff: update ? {
          recordReference: fieldValue(update, 'recordReference'),
          detail: fieldValue(update, 'detail')
        } : null
      };
    }),
    digestBody: fieldValue(items.get('review-item.email.digest'), 'body')
  };
  let expected;
  try {
    expected = createEmailTriageProposal({
      root: path.resolve(root),
      lock: exact.lock,
      snapshot: exact.snapshot,
      decision: exact.decision,
      id: exact.proposal.id,
      createdAt: exact.proposal.createdAt,
      producer: exact.proposal.producer,
      input
    });
  } catch (error) {
    if (error?.code?.startsWith('AUTOMATION_PROPOSAL_')) throw error;
    throw codedError(
      'AUTOMATION_PROPOSAL_BINDING_INVALID',
      'Durable Email proposal could not be reconstructed from its exact private bindings.'
    );
  }
  if (fingerprintJson(expected.proposal) !== fingerprintJson(exact.proposal)
    || fingerprintJson(expected.material) !== fingerprintJson(exact.material)) {
    const error = new Error(
      'Durable Email proposal does not match its deterministic pack-owned reconstruction.'
    );
    error.code = 'AUTOMATION_PROPOSAL_BINDING_INVALID';
    throw error;
  }
  return exact;
}

export function inspectEmailTriageProposalMaterial({
  root,
  lockPath,
  proposalId,
  expectedHost
}) {
  return structuredClone(loadEmailTriageProposal({
    root, lockPath, proposalId, expectedHost
  }).material);
}
