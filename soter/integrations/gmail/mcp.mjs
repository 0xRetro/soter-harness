import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

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

function nativePayload(response, label) {
  if (response?.isError === true) {
    throw providerError('unknown', label + ' returned an error result.');
  }
  const direct = response?.structuredContent?.result ?? response?.result;
  if (direct !== undefined && direct !== null) return direct;
  const text = response?.content?.find((item) => item?.type === 'text')?.text;
  if (typeof text === 'string' && text.trim()) return text;
  throw providerError('validation', label + ' did not return an acknowledged result.');
}

function parsedPayload(payload, label) {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    throw providerError('validation', label + ' text result was not JSON.');
  }
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
  const parsed = parsedPayload(payload, 'Gmail batch read');
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.messages)) return parsed.messages;
  if (Array.isArray(parsed?.emails)) return parsed.emails;
  if (Array.isArray(parsed?.results)) return parsed.results;
  throw providerError(
    'validation',
    'Gmail batch read response normalization is unverified for this response shape.'
  );
}

function searchResult(payload, maximumMessages) {
  const parsed = parsedPayload(payload, 'Gmail message search');
  const records = Array.isArray(parsed)
    ? parsed
    : parsed?.message_ids ?? parsed?.messageIds ?? parsed?.ids
      ?? parsed?.messages ?? parsed?.results;
  if (!Array.isArray(records)) {
    throw providerError(
      'validation',
      'Gmail message search response normalization is unverified for this response shape.'
    );
  }
  const ids = records.map((record) => {
    return typeof record === 'string' ? requiredString(record, 'Gmail search message identity')
      : messageId(record);
  });
  if (new Set(ids).size !== ids.length) {
    throw providerError('conflict', 'Gmail message search returned a duplicate message identity.');
  }
  const nextPageToken = parsed?.next_page_token ?? parsed?.nextPageToken ?? null;
  if (nextPageToken !== null && nextPageToken !== undefined
    && (typeof nextPageToken !== 'string' || !nextPageToken.trim())) {
    throw providerError('validation', 'Gmail message search returned an invalid page token state.');
  }
  const explicitComplete = parsed?.complete;
  const explicitHasMore = parsed?.has_more ?? parsed?.hasMore;
  if (explicitComplete !== undefined && typeof explicitComplete !== 'boolean') {
    throw providerError('validation', 'Gmail message search returned an invalid completeness state.');
  }
  if (explicitHasMore !== undefined && typeof explicitHasMore !== 'boolean') {
    throw providerError('validation', 'Gmail message search returned an invalid has-more state.');
  }
  const complete = nextPageToken
    ? false
    : (explicitComplete !== undefined
      ? explicitComplete
      : (explicitHasMore !== undefined ? !explicitHasMore : ids.length < maximumMessages));
  return { ids, complete };
}

function threadRecords(payload) {
  const parsed = parsedPayload(payload, 'Gmail thread read');
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.threads)) return parsed.threads;
  if (Array.isArray(parsed?.results)) return parsed.results;
  throw providerError(
    'validation',
    'Gmail thread read response normalization is unverified for this response shape.'
  );
}

function headerValue(record, name) {
  const headers = record?.headers ?? record?.payload?.headers;
  if (Array.isArray(headers)) {
    const match = headers.find((header) => {
      return typeof header?.name === 'string'
        && header.name.toLowerCase() === name.toLowerCase();
    });
    return match?.value;
  }
  if (headers && typeof headers === 'object') {
    const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : undefined;
  }
  return undefined;
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
  const value = record?.to ?? record?.recipients ?? headerValue(record, 'To');
  if (Array.isArray(value)) return exactOptionalStrings(value, 'Gmail message recipients', 500);
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

function normalizedSentAt(record) {
  const value = record?.sentAt ?? record?.sent_at ?? record?.date ?? headerValue(record, 'Date');
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
  const rfc822MessageId = record?.rfc822MessageId
    ?? record?.rfc822_message_id
    ?? record?.internetMessageId
    ?? headerValue(record, 'Message-ID');
  const subject = record?.subject ?? headerValue(record, 'Subject') ?? '';
  const body = record?.body ?? record?.text ?? record?.body_text;
  if (typeof body !== 'string') {
    throw providerError('validation', 'Gmail message body normalization is unavailable.');
  }
  return {
    id: messageId(record),
    rfc822MessageId: requiredString(rfc822MessageId, 'Gmail RFC822 Message-ID'),
    from: requiredString(record?.from ?? record?.sender ?? headerValue(record, 'From'), 'Gmail sender'),
    to: recipientList(record),
    sentAt: normalizedSentAt(record),
    labels: messageLabels(record),
    subject: typeof subject === 'string' ? subject : String(subject),
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
    const id = requiredString(record?.id ?? record?.thread_id ?? record?.threadId, 'Gmail thread identity');
    if (seenThreads.has(id)) {
      throw providerError('conflict', 'Gmail thread read returned a duplicate thread identity.');
    }
    seenThreads.add(id);
    const rawMessages = record?.messages ?? record?.emails;
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
  return requiredString(
    record?.id ?? record?.message_id ?? record?.messageId,
    'Gmail batch read message identity'
  );
}

function messageLabels(record) {
  const labels = record?.labels ?? record?.label_names ?? record?.labelNames;
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

export function completeMcp({ capability, input, authority, response, at }) {
  if (capability === 'mail.messages.search') {
    const result = searchResult(
      nativePayload(response, 'Gmail message search'),
      input.maximumMessages
    );
    if (result.ids.length > input.maximumMessages) {
      throw providerError('validation', 'Gmail message search exceeded the exact result bound.');
    }
    return {
      queryFingerprint: fingerprintJson(input.query),
      messageIds: [...result.ids].sort((left, right) => left.localeCompare(right, 'en')),
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
    const threads = normalizedThreads(nativePayload(response, 'Gmail thread read'), input);
    return {
      requestedMessageIds: [...input.messageIds].sort((left, right) => left.localeCompare(right, 'en')),
      returnedThreadCount: threads.length,
      threads,
      provenance: provenance(authority, {
        capability,
        messageIds: [...input.messageIds].sort((left, right) => left.localeCompare(right, 'en')),
        maximumThreads: input.maximumThreads,
        maximumMessagesPerThread: input.maximumMessagesPerThread
      }),
      observedAt: at
    };
  }
  if (capability === 'mail.labels.apply') {
    nativePayload(response, 'Gmail label write');
    return {
      messageIds: [...input.messageIds].sort(),
      addedLabelNames: [...input.addLabelNames].sort(),
      removedLabelNames: [...input.removeLabelNames].sort(),
      provenance: provenance(authority, {
        capability,
        messageIds: [...input.messageIds].sort(),
        addedLabelNames: [...input.addLabelNames].sort(),
        removedLabelNames: [...input.removeLabelNames].sort()
      }),
      observedAt: at
    };
  }
  if (capability === 'mail.labels.read') {
    const requested = new Set(input.messageIds);
    const records = messageRecords(nativePayload(response, 'Gmail batch read'));
    const seen = new Set();
    const messages = records.map((record) => {
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
        }).sort()
      };
    }).sort((left, right) => left.messageId.localeCompare(right.messageId, 'en'));
    if (seen.size !== requested.size) {
      throw providerError('not-found', 'Gmail batch read omitted one or more exact messages.');
    }
    return {
      messages,
      provenance: provenance(authority, {
        capability,
        messageIds: [...input.messageIds].sort(),
        labelNames: [...input.labelNames].sort()
      }),
      observedAt: at
    };
  }
  throw providerError('validation', 'Gmail MCP adapter does not implement ' + capability + '.');
}

export function prepareProbeMcp() {
  return { tool: 'get_profile', arguments: {} };
}

export function completeProbeMcp({ response, plan }) {
  nativePayload(response, 'Gmail profile');
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
    limitations: [
      'This profile-only probe establishes authentication and endpoint reachability, not label capability readiness, verification, or health.',
      'The provider response and account identity value are excluded; only typed observations and fingerprints may persist.'
    ]
  };
}
