import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

const RESPONSE_PROFILE = 'gmail.codex.connector.v1';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function providerError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw providerError('validation', label + ' must be a non-empty string.');
  }
  return value;
}

function exactStrings(value, label, maximum) {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > maximum
    || value.some((item) => typeof item !== 'string' || !item.trim())
    || new Set(value).size !== value.length) {
    throw providerError('validation', label + ' must contain unique non-empty strings.');
  }
  return [...value];
}

function exactObject(value, label, { required = [], allowed = required } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw providerError('validation', label + ' must be one structured object.');
  }
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !allowed.includes(key))) {
    throw providerError('validation', label + ' does not match the exact declared response profile.');
  }
  return value;
}

function nativePayload(response, responseProfile, label) {
  if (responseProfile !== RESPONSE_PROFILE) {
    throw providerError('validation', 'Gmail response profile is not declared by this adapter.');
  }
  exactObject(response, label + ' envelope', {
    required: ['structuredContent'],
    allowed: ['structuredContent', 'content', 'isError', '_meta']
  });
  if (Object.hasOwn(response, 'isError') && typeof response.isError !== 'boolean') {
    throw providerError('validation', label + ' envelope returned a non-boolean isError state.');
  }
  if (Object.hasOwn(response, 'content') && !Array.isArray(response.content)) {
    throw providerError('validation', label + ' envelope content must be an array when present.');
  }
  if (Object.hasOwn(response, '_meta')
    && (!response._meta || typeof response._meta !== 'object' || Array.isArray(response._meta))) {
    throw providerError('validation', label + ' envelope _meta must be an object when present.');
  }
  if (response?.isError === true) {
    throw providerError('unknown', label + ' returned an error result.');
  }
  const structured = exactObject(
    response.structuredContent,
    label + ' direct structured result',
    { allowed: Object.keys(response.structuredContent ?? {}) }
  );
  if (Object.hasOwn(structured, 'result')) {
    throw providerError(
      'validation',
      label + ' returned an unsupported legacy or mixed result wrapper.'
    );
  }
  return structured;
}

function provenance(authority, source) {
  return {
    provider: 'gmail-mcp',
    authority,
    sourceKind: 'connected',
    sourceReferenceFingerprint: fingerprintJson(source)
  };
}

function messageRecords(payload) {
  const parsed = exactObject(payload, 'Gmail batch read result', { required: ['messages'] });
  if (!Array.isArray(parsed.messages)) {
    throw providerError('validation', 'Gmail batch read messages must be an array.');
  }
  return parsed.messages;
}

function searchResult(payload, maximumMessages) {
  const parsed = exactObject(payload, 'Gmail message search result', {
    required: ['message_ids', 'next_page_token']
  });
  if (!Array.isArray(parsed.message_ids)) {
    throw providerError(
      'validation',
      'Gmail message search message_ids must be an array.'
    );
  }
  const ids = parsed.message_ids.map((record) => {
    return requiredString(record, 'Gmail search message identity');
  });
  if (new Set(ids).size !== ids.length) {
    throw providerError('conflict', 'Gmail message search returned a duplicate message identity.');
  }
  const nextPageToken = parsed.next_page_token;
  if (nextPageToken !== null
    && (typeof nextPageToken !== 'string' || !nextPageToken.trim())) {
    throw providerError('validation', 'Gmail message search returned an invalid page token state.');
  }
  return { ids, complete: nextPageToken === null };
}

function threadRecords(payload) {
  const parsed = exactObject(payload, 'Gmail thread read result', { required: ['threads'] });
  if (!Array.isArray(parsed.threads)) {
    throw providerError('validation', 'Gmail thread read threads must be an array.');
  }
  return parsed.threads;
}

function exactOptionalStrings(value, label, maximum) {
  if (!Array.isArray(value)
    || value.length > maximum
    || value.some((item) => typeof item !== 'string' || !item.trim())
    || new Set(value).size !== value.length) {
    throw providerError('validation', label + ' must contain unique non-empty strings.');
  }
  return [...value];
}

function recipientList(record) {
  return exactOptionalStrings(record.to, 'Gmail message recipients', 500);
}

function normalizedSentAt(record) {
  const value = record.sent_at;
  if (typeof value !== 'string' || !value.trim()) {
    throw providerError('validation', 'Gmail message timestamp is unavailable.');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw providerError('validation', 'Gmail message timestamp is invalid.');
  }
  return date.toISOString();
}

function normalizedThreadMessage(record) {
  exactObject(record, 'Gmail thread message', {
    required: [
      'id', 'rfc822_message_id', 'from', 'to', 'sent_at', 'labels', 'subject', 'body'
    ]
  });
  const body = record.body;
  if (typeof body !== 'string') {
    throw providerError('validation', 'Gmail message body normalization is unavailable.');
  }
  if (typeof record.subject !== 'string') {
    throw providerError('validation', 'Gmail message subject must be a string.');
  }
  return {
    id: messageId(record),
    rfc822MessageId: requiredString(record.rfc822_message_id, 'Gmail RFC822 Message-ID'),
    from: requiredString(record.from, 'Gmail sender'),
    to: recipientList(record),
    sentAt: normalizedSentAt(record),
    labels: messageLabels(record),
    subject: record.subject,
    body
  };
}

function normalizedThreads(payload, input) {
  const requested = new Set(input.messageIds);
  const seenRequested = new Set();
  const seenMessages = new Set();
  const seenThreads = new Set();
  const records = threadRecords(payload);
  if (records.length < 1 || records.length > input.maximumThreads) {
    throw providerError('validation', 'Gmail thread read returned an invalid thread count.');
  }
  const threads = records.map((record) => {
    exactObject(record, 'Gmail thread', { required: ['id', 'messages'] });
    const id = requiredString(record.id, 'Gmail thread identity');
    if (seenThreads.has(id)) {
      throw providerError('conflict', 'Gmail thread read returned a duplicate thread identity.');
    }
    seenThreads.add(id);
    const rawMessages = record.messages;
    if (!Array.isArray(rawMessages)
      || rawMessages.length < 1
      || rawMessages.length > input.maximumMessagesPerThread) {
      throw providerError('validation', 'Gmail thread read returned an invalid message count.');
    }
    const messages = rawMessages.map(normalizedThreadMessage);
    if (!messages.some((message) => requested.has(message.id))) {
      throw providerError(
        'conflict',
        'Gmail thread read returned a thread unrelated to the exact requested messages.'
      );
    }
    for (const message of messages) {
      if (seenMessages.has(message.id)) {
        throw providerError('conflict', 'Gmail thread read returned a duplicate message identity.');
      }
      seenMessages.add(message.id);
      if (requested.has(message.id)) seenRequested.add(message.id);
    }
    return { id, messages };
  });
  if (seenRequested.size !== requested.size) {
    throw providerError('not-found', 'Gmail thread read omitted one or more requested messages.');
  }
  return threads;
}

function messageId(record) {
  return requiredString(record.id, 'Gmail batch read message identity');
}

function messageLabels(record) {
  const labels = record.labels;
  if (!Array.isArray(labels)
    || labels.some((label) => typeof label !== 'string' || !label.trim())
    || new Set(labels).size !== labels.length) {
    throw providerError('validation', 'Gmail batch read labels must be unique strings.');
  }
  return labels;
}

export function prepareMcp({ capability, input }) {
  if (capability === 'mail.messages.search') {
    return {
      tool: 'search_email_ids',
      arguments: {
        query: requiredString(input.query, 'Mail search query'),
        max_results: input.maximumMessages
      }
    };
  }
  if (capability === 'mail.threads.read') {
    return {
      tool: 'batch_read_email_threads',
      arguments: {
        ids: exactStrings(input.messageIds, 'Mail thread message IDs', 100),
        id_type: 'message',
        max_messages: input.maximumMessagesPerThread
      }
    };
  }
  if (capability === 'mail.labels.apply') {
    const messageIds = exactStrings(input.messageIds, 'Mail label message IDs', 100);
    const addLabelNames = exactStrings(input.addLabelNames, 'Mail label names to add', 10);
    if (!Array.isArray(input.removeLabelNames)
      || input.removeLabelNames.length > 10
      || input.removeLabelNames.some((label) => typeof label !== 'string' || !label.trim())
      || new Set(input.removeLabelNames).size !== input.removeLabelNames.length
      || input.createMissingLabels !== false
      || [...addLabelNames, ...input.removeLabelNames].some((label) => !label.startsWith('AI/'))) {
      throw providerError(
        'authorization',
        'Connected Gmail labels require exact AI/ names and prohibit implicit label creation.'
      );
    }
    return {
      tool: 'apply_labels_to_emails',
      arguments: {
        message_ids: messageIds,
        add_label_names: addLabelNames,
        remove_label_names: [...input.removeLabelNames],
        create_missing_labels: false
      }
    };
  }
  if (capability === 'mail.labels.read') {
    const messageIds = exactStrings(input.messageIds, 'Mail label-read message IDs', 100);
    exactStrings(input.labelNames, 'Mail label names to verify', 10);
    if (input.maximumMessages !== messageIds.length) {
      throw providerError(
        'validation',
        'Connected Gmail label verification requires an exact message bound.'
      );
    }
    return {
      tool: 'batch_read_email',
      arguments: { message_ids: messageIds }
    };
  }
  throw providerError('validation', 'Gmail MCP adapter does not implement ' + capability + '.');
}

export function completeMcp({ capability, input, authority, responseProfile, response, at }) {
  if (capability === 'mail.messages.search') {
    const result = searchResult(
      nativePayload(response, responseProfile, 'Gmail message search'),
      input.maximumMessages
    );
    if (result.ids.length > input.maximumMessages) {
      throw providerError('validation', 'Gmail message search exceeded the exact result bound.');
    }
    return {
      queryFingerprint: fingerprintJson(input.query),
      messageIds: [...result.ids].sort(compareCodepoint),
      returnedMessageCount: result.ids.length,
      complete: result.complete,
      provenance: provenance(authority, {
        capability,
        queryFingerprint: fingerprintJson(input.query),
        maximumMessages: input.maximumMessages
      }),
      observedAt: at
    };
  }
  if (capability === 'mail.threads.read') {
    const threads = normalizedThreads(
      nativePayload(response, responseProfile, 'Gmail thread read'),
      input
    );
    return {
      requestedMessageIds: [...input.messageIds].sort(compareCodepoint),
      returnedThreadCount: threads.length,
      threads,
      provenance: provenance(authority, {
        capability,
        messageIds: [...input.messageIds].sort(compareCodepoint),
        maximumThreads: input.maximumThreads,
        maximumMessagesPerThread: input.maximumMessagesPerThread
      }),
      observedAt: at
    };
  }
  if (capability === 'mail.labels.apply') {
    const acknowledged = exactObject(
      nativePayload(response, responseProfile, 'Gmail label write'),
      'Gmail label write result',
      { required: ['state'] }
    );
    if (acknowledged.state !== 'acknowledged') {
      throw providerError('validation', 'Gmail label write did not return the exact acknowledged state.');
    }
    return {
      messageIds: [...input.messageIds].sort(compareCodepoint),
      addedLabelNames: [...input.addLabelNames].sort(compareCodepoint),
      removedLabelNames: [...input.removeLabelNames].sort(compareCodepoint),
      provenance: provenance(authority, {
        capability,
        messageIds: [...input.messageIds].sort(compareCodepoint),
        addedLabelNames: [...input.addLabelNames].sort(compareCodepoint),
        removedLabelNames: [...input.removeLabelNames].sort(compareCodepoint)
      }),
      observedAt: at
    };
  }
  if (capability === 'mail.labels.read') {
    const requested = new Set(input.messageIds);
    const records = messageRecords(nativePayload(response, responseProfile, 'Gmail batch read'));
    const seen = new Set();
    const messages = records.map((record) => {
      exactObject(record, 'Gmail batch read message', {
        required: ['id', 'labels'],
        allowed: ['id', 'labels', 'body']
      });
      if (Object.hasOwn(record, 'body') && typeof record.body !== 'string') {
        throw providerError(
          'validation',
          'Gmail batch read message body must be text when the declared profile returns it.'
        );
      }
      const id = messageId(record);
      if (!requested.has(id) || seen.has(id)) {
        throw providerError(
          'conflict',
          'Gmail batch read returned an unexpected or duplicate message identity.'
        );
      }
      seen.add(id);
      return {
        messageId: id,
        labelNames: messageLabels(record).filter((label) => {
          return input.labelNames.includes(label);
        }).sort(compareCodepoint)
      };
    }).sort((left, right) => compareCodepoint(left.messageId, right.messageId));
    if (seen.size !== requested.size) {
      throw providerError('not-found', 'Gmail batch read omitted one or more exact messages.');
    }
    return {
      messages,
      provenance: provenance(authority, {
        capability,
        messageIds: [...input.messageIds].sort(compareCodepoint),
        labelNames: [...input.labelNames].sort(compareCodepoint)
      }),
      observedAt: at
    };
  }
  throw providerError('validation', 'Gmail MCP adapter does not implement ' + capability + '.');
}

export function prepareProbePlanMcp() {
  return {
    steps: [{
      id: 'step.identity',
      kind: 'identity',
      subject: 'provider.identity',
      scope: {
        expectation: {
          acknowledgedProfile: true
        }
      },
      tool: 'get_profile',
      arguments: {}
    }]
  };
}

export function completeProbePlanStepMcp({ step, responseProfile, response }) {
  if (step?.id !== 'step.identity' || step.kind !== 'identity') {
    throw providerError('validation', 'Gmail provider probe received an unsupported step.');
  }
  nativePayload(response, responseProfile, 'Gmail profile');
  return {
    profileAcknowledged: true,
    expectedFingerprint: fingerprintJson(step.scope.expectation),
    observedFingerprint: fingerprintJson({ acknowledgedProfile: true })
  };
}

export function finalizeProbePlanMcp({ plan, steps, results }) {
  const step = steps?.[0];
  const observed = results?.[0];
  if (steps?.length !== 1
    || results?.length !== 1
    || step?.id !== 'step.identity'
    || observed?.stepId !== step.id
    || !observed.result?.profileAcknowledged
    || observed.result.expectedFingerprint !== fingerprintJson(step.scope.expectation)
    || typeof observed.result.observedFingerprint !== 'string') {
    throw providerError('validation', 'Gmail provider probe is missing its exact minimized identity result.');
  }
  return {
    credentials: plan.credentialRefs.map((secretRefId) => ({
      secretRefId,
      state: 'passed',
      details: 'The host-authenticated Gmail profile endpoint returned an acknowledged result.'
    })),
    reachability: {
      state: 'passed',
      details: 'The host reached the Gmail profile endpoint and received an acknowledged result.'
    },
    authorities: plan.authorities.map((id) => ({
      id,
      state: 'passed',
      details: 'The configured Gmail account profile was visible without reading mail content.'
    })),
    capabilities: plan.capabilities.map((id) => ({
      id,
      state: 'unknown',
      method: 'metadata',
      details: 'Profile metadata does not establish exact message access, label permission, response normalization, or write behavior.'
    })),
    checks: [{
      id: 'check.identity',
      stepId: step.id,
      kind: step.kind,
      subject: step.subject,
      scopeFingerprint: step.scopeFingerprint,
      state: 'passed',
      method: 'metadata',
      expectedFingerprint: observed.result.expectedFingerprint,
      observedFingerprint: observed.result.observedFingerprint,
      details: 'The host-authenticated Gmail profile response matched the minimized identity contract.'
    }],
    limitations: [
      'This profile-only probe establishes authentication and endpoint reachability, not label capability readiness, verification, or health.',
      'The provider response and account identity value are excluded; only typed observations and fingerprints may persist.'
    ]
  };
}
