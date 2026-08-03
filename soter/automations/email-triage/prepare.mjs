import path from 'node:path';

import { invokeCapability } from '../../core/capabilities.mjs';
import { fingerprintJson, readJson } from '../../core/lib/canonical-json.mjs';
import { fingerprintLock } from '../../core/resolve.mjs';
import { prepareRunEnvelope } from '../../core/run.mjs';
import { reduceMailThreads } from '../../contexts/email/reduction.mjs';

const AUTOMATION_ID = 'automation.email-triage';
const COLLECTION_CONTRACT = 'soter://contracts/prepared-work-review-collection/v1';
const DERIVED_REVIEW_CONTRACT = 'soter://contracts/automation-derived-review/v1';
const RAW_BODY_MARKER = /RAW_[A-Z0-9_]*BODY_SENTINEL|HOSTILE_RAW_BODY_SENTINEL/;

const SUMMARY_TEXT = {
  REPORT_4242_REVIEW: 'A compliance-sensitive report requires human review and a response.',
  SUSPECTED_INJECTION_VISIBLE: 'The message contains a suspected instruction-injection attempt and remains visible for human review.',
  INVOICE_77_HUMAN_REVIEW: 'Invoice 77 requires human verification; no payment or approval action is proposed.',
  NORTHBEAM_REPLY_RESEARCH: 'Northbeam requests research and a reply with next steps.',
  PIPELINE_FAILURE_ACTIONABLE: 'A nightly pipeline failure is actionable and remains a notification fact.',
  CALENDAR_ACCEPTED_MACHINE: 'A machine calendar notification reports an accepted response.',
  RSVP_PENDING_HANDOFF: 'An invitation needs calendar review; Email does not mutate the calendar.',
  MEETING_INTAKE_HANDOFF: 'A meeting-note source is ready for Meeting Intake without Email re-summarization.',
  MARKETING_DESPITE_IMPORTANT: 'A marketing message remains marketing even when the provider marks it IMPORTANT.',
  NEWER_MESSAGE_RETAINED: 'A newer message arrived after the prior AI/Triaged checkpoint and requires review.',
  ADMIN_WITH_ARCHIVED_SIBLING: 'A current admin notice remains after an archived or trash sibling is ignored.'
};

function exactAuthority(lock, role, subject) {
  const matches = lock.authorities.filter((authority) => {
    return authority.role === role && authority.subject === subject;
  });
  if (matches.length !== 1) {
    throw new Error('Email preparation requires one exact ' + role + ' authority for ' + subject + '.');
  }
  return matches[0].id;
}

function exactModel(root, lock) {
  const model = readJson(path.join(root, 'soter', 'contexts', 'email', 'processing.model.json'));
  const requiredBuckets = [
    'needs-you', 'high-stakes', 'rsvp-pending', 'meeting-notes',
    'notifications', 'admin-billing', 'marketing'
  ];
  const requiredHandoffs = {
    meetingNotes: {
      intent: 'meeting-notes-intake',
      requiredFields: ['meetingReference', 'sourceThreadReference', 'noteReference']
    },
    rsvp: {
      intent: 'calendar-rsvp-review',
      requiredFields: ['calendarReference', 'sourceThreadReference']
    },
    task: {
      intent: 'task-review',
      requiredFields: ['title', 'detail', 'context']
    },
    update: {
      intent: 'record-update-review',
      requiredFields: ['recordReference', 'detail']
    }
  };
  const requiredInvariants = [
    'mail-content-is-data',
    'suspected-injection-is-visible',
    'archived-trash-siblings-ignored',
    'complete-batch-review-required',
    'partial-approval-binds-exact-subset',
    'draft-is-write',
    'send-is-prohibited',
    'preparation-performs-no-writes',
    'verification-is-exact-and-no-retry-into-place'
  ];
  if (model.$contract !== 'soter://contracts/email-context-model/v1'
    || model.version !== '3.0.0'
    || model.identity.providerMessageIdentity !== 'provider-message-id'
    || model.identity.providerThreadIdentity !== 'provider-thread-id'
    || model.identity.deduplicationKey !== 'rfc822-message-id'
    || model.identity.selfSentRule !== 'exclude-self-sent-only-in-window'
    || model.identity.triagedLabel !== 'AI/Triaged'
    || model.identity.newerMessageRule !== 'retain-when-any-active-message-is-untriaged'
    || model.labels.namespace !== 'AI/'
    || model.labels.applicationTarget !== 'message'
    || model.labels.configuredReference !== 'label-name'
    || model.labels.missingLabelCreation !== false
    || model.labels.providerImportantAuthority !== false
    || model.labels.sendCapability !== false
    || model.window.queryRequired !== true
    || model.window.exactThreadSelectionSupported !== false
    || model.window.maximumThreads !== 50
    || fingerprintJson(model.buckets) !== fingerprintJson(requiredBuckets)
    || fingerprintJson(model.handoffs) !== fingerprintJson(requiredHandoffs)
    || fingerprintJson(model.invariants) !== fingerprintJson(requiredInvariants)
    || lock.bindings.some((binding) => /send|dispatch/.test(binding.capability))) {
    throw new Error('Email Context model drifted from the exact draft-only deterministic processing boundary.');
  }
  return model;
}

function exactDerivedReviewDefinition(root) {
  const definition = readJson(path.join(
    root,
    'soter',
    'automations',
    'email-triage',
    'derived-review.json'
  ));
  if (definition.$contract !== DERIVED_REVIEW_CONTRACT
    || definition.automation !== AUTOMATION_ID
    || definition.kind !== 'email-triage-derived-review') {
    throw new Error('Email derived review definition drifted from its Automation-owned contract.');
  }
  return definition;
}

function exactSettings(lock) {
  const settings = lock.settings?.['integration.gmail'];
  const labelValues = settings?.labels ? Object.values(settings.labels) : [];
  if (!settings
    || !Array.isArray(settings.selfAddresses)
    || !settings.selfAddresses.length
    || new Set(settings.selfAddresses.map((address) => address.toLowerCase())).size
      !== settings.selfAddresses.length
    || labelValues.length !== 9
    || labelValues.some((label) => typeof label !== 'string' || !label.startsWith('AI/'))
    || settings.labels.triaged !== 'AI/Triaged') {
    throw new Error('Email preparation requires exact self identities and a complete AI-only label mapping.');
  }
  return settings;
}

function classify(candidate) {
  const signals = candidate.message.signals;
  if (signals.suspectedInjection) {
    return { group: 'high-stakes', attention: 'operator', reasonCode: 'SUSPECTED_PROMPT_INJECTION', labelKey: 'needsReview' };
  }
  if (signals.meetingNotes) {
    return { group: 'meeting-notes', attention: 'operator', reasonCode: 'MEETING_INTAKE_HANDOFF', labelKey: 'meetingNotes', handoff: 'meeting-handoff' };
  }
  if (signals.calendarResponse === 'invitation') {
    return { group: 'rsvp-pending', attention: 'operator', reasonCode: 'RSVP_PENDING', labelKey: 'rsvpPending', handoff: 'calendar-handoff' };
  }
  if (signals.marketing) {
    return { group: 'marketing', attention: 'no-one', reasonCode: 'MARKETING_CLASSIFIED', labelKey: 'marketing' };
  }
  if (signals.machineNotification || signals.calendarResponse === 'accepted') {
    return { group: 'notifications', attention: signals.actionableFailure ? 'operator' : 'no-one', reasonCode: signals.actionableFailure ? 'ACTIONABLE_NOTIFICATION_FAILURE' : 'MACHINE_NOTIFICATION', labelKey: 'notifications' };
  }
  if (signals.money || signals.legalOrCompliance) {
    return { group: 'high-stakes', attention: 'operator', reasonCode: signals.money ? 'MONEY_HUMAN_REVIEW_REQUIRED' : 'HIGH_STAKES_HUMAN_REVIEW_REQUIRED', labelKey: 'highStakes' };
  }
  if (signals.replyRequested) {
    return { group: 'needs-you', attention: 'operator', reasonCode: 'REPLY_OR_RESEARCH_REQUIRED', labelKey: 'needsYou' };
  }
  if (signals.adminBilling) {
    return { group: 'admin-billing', attention: 'operator', reasonCode: 'ADMIN_BILLING_REVIEW', labelKey: 'adminBilling' };
  }
  return { group: 'notifications', attention: 'unknown', reasonCode: 'UNCLASSIFIED_NOTIFICATION', labelKey: 'notifications' };
}

function field(id, label, type, reviewValue) {
  return { id, label, type, fingerprint: fingerprintJson(reviewValue), reviewValue };
}

function item(id, kind, sources, fields) {
  const value = { id, kind, sources, fields, fingerprint: 'sha256:' + '0'.repeat(64) };
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  value.fingerprint = fingerprintJson(unsigned);
  return value;
}

function rowFingerprint(row) {
  const unsigned = structuredClone(row);
  delete unsigned.fingerprint;
  delete unsigned.privateDetailFingerprint;
  for (const action of unsigned.actions) delete action.changeFingerprint;
  return fingerprintJson(unsigned);
}

function handoffDefinition(model, key, expectedIntent) {
  const definition = model.handoffs[key];
  if (!definition || definition.intent !== expectedIntent) {
    throw new Error('Email handoff intent does not match the portable Context declaration.');
  }
  return definition;
}

function handoffFields(definition, values) {
  const fields = definition.requiredFields.map((id) => {
    const value = values[id];
    if (!value) throw new Error('Email handoff is missing required field ' + id + '.');
    const label = {
      meetingReference: 'Meeting reference',
      sourceThreadReference: 'Source thread',
      noteReference: 'Note source',
      calendarReference: 'Calendar reference',
      title: 'Task title',
      detail: 'Task detail',
      context: 'Task context',
      recordReference: 'Record reference'
    }[id];
    return field(id, label, 'text', value);
  });
  return fields;
}

function collectionFingerprint(collection) {
  const unsigned = structuredClone(collection);
  delete unsigned.fingerprint;
  return fingerprintJson(unsigned);
}

function sourceFor(collectionId, row) {
  return { collectionId, rowId: row.id, rowFingerprint: row.fingerprint };
}

function safeSummary(candidate) {
  const summary = SUMMARY_TEXT[candidate.message.signals.summaryCode];
  if (!summary || RAW_BODY_MARKER.test(summary)) {
    throw new Error('Email fixture did not supply one exact safe summary code.');
  }
  return summary;
}

function flagsFor(candidates, classifications) {
  const flags = [];
  if (candidates.some((candidate) => candidate.message.signals.suspectedInjection)) {
    flags.push('SUSPECTED_PROMPT_INJECTION');
  }
  if (candidates.some((candidate) => candidate.message.signals.actionableFailure)) {
    flags.push('ACTIONABLE_FAILURE');
  }
  if (candidates.some((candidate) => candidate.message.signals.calendarResponse === 'accepted')) {
    flags.push('CALENDAR_RESPONSE_ACCEPTED');
  }
  if (candidates.some((candidate) => candidate.archivedSiblingIgnored)) {
    flags.push('ARCHIVED_OR_TRASH_SIBLING_IGNORED');
  }
  if (candidates.some((candidate) => {
    return candidate.thread.labels.includes('IMPORTANT')
      || candidate.message.labels.includes('IMPORTANT');
  })) {
    flags.push('PROVIDER_IMPORTANT_IGNORED');
  }
  if (classifications.some((classification) => classification.group === 'needs-you')) flags.push('NEEDS_YOU');
  if (classifications.some((classification) => classification.group === 'high-stakes')) flags.push('HIGH_STAKES');
  return [...new Set(flags)].sort();
}

function buildReview({ reduced, settings, model, derivedReviewDefinition }) {
  const classified = reduced.included.map((candidate) => ({ candidate, classification: classify(candidate) }));
  const groups = [];
  let notifications = null;
  for (const entry of classified) {
    if (entry.classification.group === 'notifications') {
      if (!notifications) {
        notifications = { entries: [], index: groups.length };
        groups.push(notifications);
      }
      notifications.entries.push(entry);
    } else {
      groups.push({ entries: [entry] });
    }
  }
  const rows = [];
  const privateItems = [];
  const proposedChanges = [];
  for (let index = 0; index < groups.length; index += 1) {
    const entries = groups[index].entries;
    const candidates = entries.map((entry) => entry.candidate);
    const classifications = entries.map((entry) => entry.classification);
    const classification = classifications[0];
    const sequence = index + 1;
    const rowId = 'row.email.' + String(sequence).padStart(3, '0');
    const actionBase = 'action.email.' + String(sequence).padStart(3, '0');
    const suspectedInjection = candidates.some((candidate) => {
      return candidate.message.signals.suspectedInjection;
    });
    const actions = suspectedInjection ? [{
      id: actionBase + '.held',
      kind: 'none',
      capability: null,
      effect: null,
      state: 'held',
      reasonCode: 'SUSPECTED_INJECTION_REQUIRES_HUMAN_REVIEW'
    }] : [{
      id: actionBase + '.label',
      kind: 'label',
      capability: 'mail.labels.apply',
      effect: 'write',
      state: 'proposed',
      reasonCode: 'AI_NAMESPACE_LABEL_PROPOSED',
      changeFingerprint: null
    }];
    if (candidates.length === 1 && candidates[0].message.signals.summaryCode === 'NORTHBEAM_REPLY_RESEARCH') {
      const taskHandoff = handoffDefinition(model, 'task', 'task-review');
      actions.push({
        id: actionBase + '.draft', kind: 'draft', capability: 'mail.drafts.create',
        effect: 'write', state: 'proposed', reasonCode: 'REPLY_DRAFT_PROPOSED',
        changeFingerprint: null
      });
      actions.push({
        id: actionBase + '.task-handoff', kind: taskHandoff.intent, capability: null,
        effect: null, state: 'handoff', reasonCode: 'RESEARCH_TASK_HANDOFF'
      });
    }
    if (classification.handoff) {
      const declaredHandoff = classification.handoff === 'meeting-handoff'
        ? handoffDefinition(model, 'meetingNotes', 'meeting-notes-intake')
        : handoffDefinition(model, 'rsvp', 'calendar-rsvp-review');
      actions.push({
        id: actionBase + '.' + classification.handoff,
        kind: declaredHandoff.intent,
        capability: null,
        effect: null,
        state: 'handoff',
        reasonCode: classification.handoff === 'meeting-handoff'
          ? 'MEETING_INTAKE_HANDOFF'
          : 'CALENDAR_REVIEW_HANDOFF'
      });
    }
    const row = {
      id: rowId,
      sequence,
      representedCount: candidates.length,
      subject: {
        kind: candidates.length > 1 ? 'mail-bucket' : 'mail-thread',
        fingerprint: fingerprintJson(candidates.map((candidate) => candidate.message.rfc822MessageId).sort())
      },
      group: classification.group,
      attention: classifications.some((entry) => entry.attention === 'operator')
        ? 'operator'
        : classification.attention,
      disposition: candidates.length > 1 || ['notifications', 'marketing', 'admin-billing'].includes(classification.group)
        ? 'collapsed'
        : classification.handoff ? 'handoff' : 'itemized',
      reasonCode: candidates.length > 1 ? 'MACHINE_NOTIFICATIONS_COLLAPSED' : classification.reasonCode,
      flags: flagsFor(candidates, classifications),
      actions,
      privateDetailFingerprint: null,
      fingerprint: 'sha256:' + '0'.repeat(64)
    };
    row.fingerprint = rowFingerprint(row);
    const source = sourceFor('collection.email.window', row);
    const detail = item(
      'review-item.email.' + String(sequence).padStart(3, '0') + '.detail',
      'thread-detail',
      [source],
      [
        field('sender', 'Sender', 'text', candidates.length > 1
          ? 'Multiple machine senders'
          : candidates[0].message.from),
        field('participants', 'Participants', 'string-list', [...new Set(candidates.flatMap((candidate) => {
          return candidate.message.to;
        }))].sort()),
        field('subject', 'Subject', 'text', candidates.length > 1
          ? 'Machine notifications'
          : candidates[0].message.subject),
        field('summary', 'Summary', 'text', candidates.map(safeSummary).join(' ')),
        field('reason', 'Review reason', 'text', row.reasonCode),
        field('waitingOn', 'Waiting on', 'text', row.attention)
      ]
    );
    row.privateDetailFingerprint = detail.fingerprint;
    privateItems.push(detail);
    const labelAction = actions.find((action) => action.kind === 'label');
    if (labelAction) {
      const label = item(
        'review-item.email.' + String(sequence).padStart(3, '0') + '.label',
        'label',
        [source],
        [
          field('messageIds', 'Exact message IDs', 'string-list', [...new Set(candidates.flatMap((candidate) => {
            return candidate.active.map((message) => message.id);
          }))].sort()),
          field(
            'labelName',
            'Exact label name',
            'text',
            settings.labels[classification.labelKey]
          )
        ]
      );
      privateItems.push(label);
      const labelChange = {
        id: labelAction.id,
        recordId: labelAction.id,
        effect: labelAction.capability,
        beforeFingerprint: null,
        afterFingerprint: label.fingerprint
      };
      labelAction.changeFingerprint = fingerprintJson(labelChange);
      proposedChanges.push(labelChange);
    }
    if (actions.some((action) => action.kind === 'draft')) {
      const candidate = candidates[0];
      const draft = item(
        'review-item.email.' + String(sequence).padStart(3, '0') + '.draft',
        'draft',
        [source],
        [
          field('replyMessageId', 'Exact reply message ID', 'text', candidate.message.id),
          field('recipients', 'Recipients', 'string-list', [candidate.message.from]),
          field('subject', 'Draft subject', 'text', 'Re: ' + candidate.message.subject),
          field('body', 'Complete draft body', 'text', 'Thanks for the note. I will research the open question and follow up with grounded next steps. No external action has been taken.')
        ]
      );
      privateItems.push(draft);
      const draftAction = actions.find((action) => action.kind === 'draft');
      const draftChange = {
        id: draftAction.id,
        recordId: draftAction.id,
        effect: draftAction.capability,
        beforeFingerprint: null,
        afterFingerprint: draft.fingerprint
      };
      draftAction.changeFingerprint = fingerprintJson(draftChange);
      proposedChanges.push(draftChange);
      const taskHandoff = handoffDefinition(model, 'task', 'task-review');
      privateItems.push(item(
        'review-item.email.' + String(sequence).padStart(3, '0') + '.task-handoff',
        'task-handoff',
        [source],
        handoffFields(taskHandoff, {
          title: 'Research Northbeam open question',
          detail: 'Ground the requested research before the proposed reply is reviewed.',
          context: 'Client'
        })
      ));
    }
    if (classification.handoff === 'meeting-handoff') {
      const meetingHandoff = handoffDefinition(model, 'meetingNotes', 'meeting-notes-intake');
      privateItems.push(item(
        'review-item.email.' + String(sequence).padStart(3, '0') + '.meeting-handoff',
        'meeting-handoff',
        [source],
        handoffFields(meetingHandoff, {
          meetingReference: fingerprintJson(candidates[0].message.rfc822MessageId),
          sourceThreadReference: candidates[0].thread.id,
          noteReference: candidates[0].message.id
        })
      ));
    }
    if (classification.handoff === 'calendar-handoff') {
      const calendarHandoff = handoffDefinition(model, 'rsvp', 'calendar-rsvp-review');
      privateItems.push(item(
        'review-item.email.' + String(sequence).padStart(3, '0') + '.calendar-handoff',
        'calendar-handoff',
        [source],
        handoffFields(calendarHandoff, {
          calendarReference: fingerprintJson(candidates[0].message.rfc822MessageId),
          sourceThreadReference: candidates[0].thread.id
        })
      ));
    }
    rows.push(row);
  }

  const exclusions = reduced.exclusions;
  const excludedCount = exclusions.reduce((total, exclusion) => total + exclusion.count, 0);
  const windowCollection = {
    $contract: COLLECTION_CONTRACT,
    contractVersion: '1.0.0',
    id: 'collection.email.window',
    kind: 'email-triage-window',
    labelKey: 'email-triage-window',
    coverage: {
      complete: true,
      observedCount: reduced.observedCount,
      includedCount: reduced.included.length,
      excludedCount,
      exclusions
    },
    rows,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  windowCollection.fingerprint = collectionFingerprint(windowCollection);

  const digestRow = {
    id: 'row.email.digest',
    sequence: 1,
    representedCount: 1,
    subject: { kind: 'email-digest', fingerprint: fingerprintJson(rows.map((row) => row.fingerprint)) },
    group: 'digest',
    attention: 'operator',
    disposition: 'itemized',
    reasonCode: 'DIGEST_READY_FOR_PRIVATE_REVIEW',
    flags: ['DIGEST_DESTINATION_UNAVAILABLE', 'EMAIL_SEND_PROHIBITED'],
    actions: [
      { id: 'action.email.digest.held', kind: 'none', capability: null, effect: null, state: 'held', reasonCode: 'DIGEST_DESTINATION_UNAVAILABLE' },
      { id: 'action.email.send.prohibited', kind: 'none', capability: null, effect: 'dispatch', state: 'prohibited', reasonCode: 'EMAIL_SEND_PROHIBITED' }
    ],
    privateDetailFingerprint: null,
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  digestRow.fingerprint = rowFingerprint(digestRow);
  const digestSources = [sourceFor('collection.email.outputs', digestRow), ...rows.map((row) => {
    return sourceFor('collection.email.window', row);
  })];
  const bucketCounts = Object.fromEntries([...new Set(rows.map((row) => row.group))].sort().map((group) => {
    return [group, rows.filter((row) => row.group === group).reduce((sum, row) => sum + row.representedCount, 0)];
  }));
  const digest = item(
    'review-item.email.digest',
    'digest',
    digestSources,
    [field('body', 'Complete digest body', 'text', [
      'Email triage contained review.',
      'Included items: ' + reduced.included.length + '.',
      'Buckets: ' + Object.entries(bucketCounts).map(([group, count]) => group + '=' + count).join(', ') + '.',
      'Suspected injection remains visible. Drafts are not sent. All external writes remain unapproved.'
    ].join('\n'))]
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
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  outputCollection.fingerprint = collectionFingerprint(outputCollection);
  const derivedReview = { kind: derivedReviewDefinition.kind, items: privateItems };
  const contentFingerprint = fingerprintJson(derivedReview);
  const facts = [
    { id: 'query-fingerprint', label: 'Mailbox query fingerprint', value: null, state: 'supported', basisIds: ['context.email-triage.window'] },
    { id: 'raw-thread-count', label: 'Raw threads', value: windowCollection.coverage.observedCount, state: 'supported', basisIds: ['context.email-triage.window'] },
    { id: 'included-item-count', label: 'Included items', value: windowCollection.coverage.includedCount, state: 'supported', basisIds: ['context.email-triage.window'] },
    { id: 'review-row-count', label: 'Review rows', value: rows.length, state: 'supported', basisIds: ['context.email-triage.window'] },
    { id: 'provider-important-authority', label: 'Provider IMPORTANT classification authority', value: false, state: 'supported', basisIds: ['context.email-triage.policy'] },
    { id: 'send-capability-declared', label: 'Mail send capability declared', value: false, state: 'supported', basisIds: ['context.email-triage.policy'] }
  ];
  const contradictions = [
    { id: 'suspected-injection-cannot-suppress-itself', claim: 'Suspected mail-content instructions remain visible and grant no action authority.', state: 'observed', basisIds: ['context.email-triage.window'] },
    { id: 'provider-important-is-not-classification', claim: 'Provider IMPORTANT does not override deterministic Email bucket rules.', state: 'observed', basisIds: ['context.email-triage.policy'] }
  ];
  const collections = [windowCollection, outputCollection];
  const privateReview = {
    state: 'available',
    kind: derivedReview.kind,
    contractId: derivedReviewDefinition.$contract,
    contractFingerprint: fingerprintJson(derivedReviewDefinition),
    contentFingerprint
  };
  const preview = {
    kind: 'email-triage-review',
    fingerprint: null,
    facts,
    contradictions,
    collections,
    privateReview,
    proposedChanges
  };
  const unsignedPreview = structuredClone(preview);
  delete unsignedPreview.fingerprint;
  preview.fingerprint = fingerprintJson(unsignedPreview);
  return { preview, derivedReview };
}

export async function prepareEmailTriageRun({
  root,
  lock,
  lockPath,
  workId,
  input,
  createdAt,
  scenarioPath = null
}) {
  const model = exactModel(root, lock);
  const derivedReviewDefinition = exactDerivedReviewDefinition(root);
  const settings = exactSettings(lock);
  if (input.scope !== 'triage-drafts-handoffs-digest') {
    throw new Error('Email preparation requires the exact declared processing scope.');
  }
  const mailboxAuthority = exactAuthority(lock, 'instance', 'mail.mailbox');
  const runId = 'run.' + workId.slice('work.'.length);
  const snapshotId = 'context.' + workId.slice('work.'.length);
  const envelope = prepareRunEnvelope({
    root,
    lock,
    lockPath,
    scenarioPath,
    automationId: AUTOMATION_ID,
    runId,
    createdAt,
    requestedOutcome: 'Prepare one bounded Email triage, private drafts, handoffs, and digest; stop before approval, writes, or sending.',
    evidenceIds: []
  });
  const read = await invokeCapability({
    root,
    lock,
    capability: 'mail.window.read',
    authority: mailboxAuthority,
    containment: 'fixture',
    input: { query: input.query, maximumThreads: model.window.maximumThreads },
    effectId: 'effect.email-triage.preparation.window.fixture',
    at: createdAt
  });
  if (read.invocation.state !== 'passed'
    || read.output.queryFingerprint !== fingerprintJson(input.query)
    || read.output.returnedThreadCount !== read.output.threads.length
    || read.output.threads.length > model.window.maximumThreads) {
    throw new Error('Email preparation could not prove one exact bounded mailbox read.');
  }
  const reduced = {
    ...reduceMailThreads({
      threads: read.output.threads,
      selfAddresses: settings.selfAddresses,
      triagedLabel: settings.labels.triaged
    }),
    observedCount: read.output.returnedThreadCount
  };
  const { preview, derivedReview } = buildReview({
    reduced,
    settings,
    model,
    derivedReviewDefinition
  });
  const windowCollection = preview.collections.find((collection) => {
    return collection.id === 'collection.email.window';
  });
  if (windowCollection.coverage.observedCount !== read.output.returnedThreadCount
    || windowCollection.coverage.observedCount
      !== windowCollection.coverage.includedCount + windowCollection.coverage.excludedCount
    || windowCollection.coverage.observedCount !== 15
    || windowCollection.coverage.includedCount !== 11
    || windowCollection.rows.length !== 10
    || windowCollection.coverage.excludedCount !== 4) {
    throw new Error('Email contained oracle did not reproduce the exact bounded reduction counts.');
  }
  const sanitizedWindow = {
    queryFingerprint: read.output.queryFingerprint,
    providerOutputFingerprint: read.invocation.outputFingerprint,
    modelFingerprint: fingerprintJson(model),
    rawThreadCount: windowCollection.coverage.observedCount,
    includedItemCount: windowCollection.coverage.includedCount,
    excludedItemCount: windowCollection.coverage.excludedCount,
    reviewRowCount: windowCollection.rows.length,
    collectionFingerprint: windowCollection.fingerprint
  };
  preview.facts.find((fact) => fact.id === 'query-fingerprint').value = sanitizedWindow.queryFingerprint;
  const unsignedPreview = structuredClone(preview);
  delete unsignedPreview.fingerprint;
  preview.fingerprint = fingerprintJson(unsignedPreview);
  const entry = {
    id: 'context.email-triage.window',
    subject: 'mail.mailbox.window',
    authority: mailboxAuthority,
    role: 'instance',
    capability: read.invocation.capability,
    providerPack: read.invocation.providerPack,
    providerImplementation: read.invocation.providerImplementation,
    providerVersion: read.invocation.providerVersion,
    observedAt: read.output.observedAt,
    freshness: 'passed',
    provenance: read.output.provenance,
    valueFingerprint: fingerprintJson(sanitizedWindow),
    value: sanitizedWindow
  };
  const snapshot = {
    $contract: 'soter://contracts/context-snapshot/v1',
    contractVersion: '1.0.0',
    id: snapshotId,
    runId,
    createdAt,
    configurationLockFingerprint: fingerprintLock(lock),
    graphFingerprint: lock.graphFingerprint,
    containment: 'fixture',
    entries: [entry],
    effectIds: [read.invocation.id],
    privacy: {
      scope: 'private',
      redactions: [
        'Raw query, sender, recipient, subject, body, thread, message, draft, and handoff values are excluded; only exact fingerprints and counts remain.'
      ]
    }
  };
  envelope.context = envelope.context.map((context) => {
    if (context.authority !== mailboxAuthority) return context;
    return { ...context, status: 'loaded', provenance: 'fixture:' + entry.valueFingerprint, freshness: 'passed' };
  });
  envelope.lifecycleState = 'paused';
  envelope.checkpoints = [
    { id: 'effects-established', state: 'passed', details: 'Read and disclosure policies were evaluated before the exact bounded fixture call.' },
    { id: 'mail-window-reduced', state: 'passed', details: 'Deterministic identity, sibling, triage-freshness, injection, bucket, and coverage rules were applied.' },
    { id: 'write-and-dispatch-boundary-held', state: 'passed', details: 'No label, draft, CRM, digest, calendar, send, approval, continuation, or provider write was executed.' }
  ];
  envelope.outputs = [{ id: snapshot.id, type: 'context-snapshot', fingerprint: fingerprintJson(snapshot) }];
  envelope.effects = [read.invocation];
  return {
    envelope,
    snapshot,
    contextPlan: [{
      id: 'preparation.context.1',
      sequence: 1,
      label: 'Read and reduce exact bounded mailbox window',
      capability: 'mail.window.read',
      authority: mailboxAuthority,
      containment: 'fixture',
      state: 'completed',
      inputFingerprint: read.invocation.inputFingerprint,
      outputFingerprint: entry.valueFingerprint,
      limitation: 'This synthetic fixture read does not establish connected identity, reachability, permission, classification quality, or write behavior.'
    }],
    outcomes: [
      { id: 'email-window-covered', label: 'Exact mailbox window coverage prepared', state: 'supported', basis: ['context.email-triage.window'], limitation: 'Coverage applies only to the exact contained query and synthetic fixture.' },
      { id: 'email-review-private', label: 'Private thread, draft, handoff, and digest review prepared', state: 'supported', basis: ['context.email-triage.window'], limitation: 'Private review material grants no approval, continuation, execution, write, send, proof, or maturity authority.' },
      { id: 'email-approval-not-requested', label: 'Email approval has not been requested', state: 'blocked', basis: ['context.email-triage.window'], limitation: 'Preparation creates no approval. A committed grounded decision, private proposal, exact review-only candidate selection, compiled review-only candidate preview, private selected-activity review, and separate exact request and confirmation are required.' }
    ],
    preview,
    derivedReview
  };
}
