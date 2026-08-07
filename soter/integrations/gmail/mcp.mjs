import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

const RESPONSE_PROFILE = 'gmail.codex.connector.v1';
const THREAD_READ_MAXIMUM_PAGES = 101;
const MAXIMUM_RAW_MIME_BYTES = 20_000_000;
const MAXIMUM_RAW_MIME_BASE64URL_CHARACTERS = Math.ceil(MAXIMUM_RAW_MIME_BYTES * 4 / 3) + 2;
const MAXIMUM_RFC822_HEADER_BYTES = 262_144;
const MAXIMUM_PROVIDER_ID_CHARACTERS = 500;
const MAXIMUM_ADDRESS_CHARACTERS = 1000;
const MAXIMUM_ADDRESSES = 500;
const MAXIMUM_LABEL_CHARACTERS = 500;
const MAXIMUM_LABELS = 100;
const MAXIMUM_SUBJECT_CHARACTERS = 10_000;
const MAXIMUM_BODY_CHARACTERS = 1_000_000;
const MAXIMUM_THREAD_COUNT = 100;
const MAXIMUM_MESSAGES_PER_THREAD = 500;
const MAXIMUM_REQUESTED_MESSAGES = 100;

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

function boundedRequiredString(value, label, maximumCharacters) {
  const result = requiredString(value, label);
  if (result.length > maximumCharacters) {
    throw providerError('validation', label + ' exceeds its exact character bound.');
  }
  return result;
}

function boundedText(value, label, maximumCharacters) {
  if (typeof value !== 'string' || value.length > maximumCharacters) {
    throw providerError('validation', label + ' exceeds its exact character bound.');
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

function exactOptionalStrings(value, label, maximum) {
  if (!Array.isArray(value)
    || value.length > maximum
    || value.some((item) => typeof item !== 'string' || !item.trim())
    || new Set(value).size !== value.length) {
    throw providerError('validation', label + ' must contain unique non-empty strings.');
  }
  return [...value];
}

function exactBoundedStrings(value, label, maximumItems, maximumCharacters, { required = false } = {}) {
  const result = required
    ? exactStrings(value, label, maximumItems)
    : exactOptionalStrings(value, label, maximumItems);
  for (const item of result) {
    boundedRequiredString(item, label + ' item', maximumCharacters);
  }
  return result;
}

function assertThreadReadInput(input) {
  exactObject(input, 'Mail thread read input', {
    required: [
      'messageIds', 'maximumThreads', 'maximumMessagesPerThread', 'maximumTotalMessages'
    ]
  });
  const messageIds = exactBoundedStrings(
    input.messageIds,
    'Mail thread message IDs',
    MAXIMUM_REQUESTED_MESSAGES,
    MAXIMUM_PROVIDER_ID_CHARACTERS,
    { required: true }
  );
  if (!Number.isInteger(input.maximumThreads)
    || input.maximumThreads < 1
    || input.maximumThreads > MAXIMUM_THREAD_COUNT
    || !Number.isInteger(input.maximumMessagesPerThread)
    || input.maximumMessagesPerThread < 1
    || input.maximumMessagesPerThread > MAXIMUM_MESSAGES_PER_THREAD
    || !Number.isInteger(input.maximumTotalMessages)
    || input.maximumTotalMessages < 1
    || input.maximumTotalMessages > MAXIMUM_MESSAGES_PER_THREAD
    || input.maximumMessagesPerThread > input.maximumTotalMessages
    || messageIds.length > input.maximumTotalMessages) {
    throw providerError('validation', 'Mail thread read bounds are invalid.');
  }
  return input;
}

function normalizedAddresses(value, label) {
  if (typeof value === 'string') {
    return [boundedRequiredString(value, label, MAXIMUM_ADDRESS_CHARACTERS)];
  }
  return exactBoundedStrings(
    value,
    label,
    MAXIMUM_ADDRESSES,
    MAXIMUM_ADDRESS_CHARACTERS
  );
}

function normalizedSentAtValue(value) {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    value = Number(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw providerError('validation', 'Gmail message timestamp is invalid.');
    }
    value *= Math.abs(value) < 100_000_000_000 ? 1000 : 1;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw providerError('validation', 'Gmail message timestamp is unavailable.');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw providerError('validation', 'Gmail message timestamp is invalid.');
  }
  return date.toISOString();
}

function assertNullableRawMime(record, label) {
  for (const key of ['raw_mime', 'raw_mime_base64url']) {
    if (Object.hasOwn(record, key) && record[key] !== null) {
      throw providerError('validation', label + ' exposed raw MIME outside identity enrichment.');
    }
  }
}

const LIVE_MESSAGE_KEYS = [
  'id', 'thread_id', 'email_ts', 'from_', 'to', 'cc', 'bcc', 'labels', 'subject',
  'body', 'snippet', 'display_title', 'display_url', 'has_attachment', 'attachments',
  'inline_images', 'raw_mime', 'raw_mime_base64url'
];

function normalizedBatchMessage(record, threadId, requested) {
  exactObject(record, 'Gmail thread message', {
    required: ['id', 'thread_id', 'email_ts', 'from_', 'to', 'labels', 'subject', 'body'],
    allowed: LIVE_MESSAGE_KEYS
  });
  if (boundedRequiredString(
    record.thread_id,
    'Gmail message thread identity',
    MAXIMUM_PROVIDER_ID_CHARACTERS
  ) !== threadId) {
    throw providerError('conflict', 'Gmail thread message does not match its exact parent thread.');
  }
  assertNullableRawMime(record, 'Gmail thread message');
  for (const key of ['attachments', 'inline_images']) {
    if (Object.hasOwn(record, key)
      && (!Array.isArray(record[key]) || record[key].length > MAXIMUM_MESSAGES_PER_THREAD)) {
      throw providerError('validation', 'Gmail message ' + key + ' must be an array when present.');
    }
  }
  for (const key of ['snippet', 'display_title', 'display_url']) {
    if (Object.hasOwn(record, key)
      && record[key] !== null
      && (typeof record[key] !== 'string'
        || record[key].length > MAXIMUM_SUBJECT_CHARACTERS)) {
      throw providerError('validation', 'Gmail message ' + key + ' must be text when present.');
    }
  }
  if (Object.hasOwn(record, 'has_attachment') && typeof record.has_attachment !== 'boolean') {
    throw providerError('validation', 'Gmail message attachment state must be boolean.');
  }
  for (const key of ['cc', 'bcc']) {
    if (Object.hasOwn(record, key)) normalizedAddresses(record[key], 'Gmail message ' + key);
  }
  const id = messageId(record);
  const body = boundedText(record.body, 'Gmail message body', MAXIMUM_BODY_CHARACTERS);
  const subject = boundedText(
    record.subject,
    'Gmail message subject',
    MAXIMUM_SUBJECT_CHARACTERS
  );
  return {
    id,
    membership: requested.has(id) ? 'exact-request' : 'thread-context',
    rfc822MessageId: null,
    from: boundedRequiredString(record.from_, 'Gmail sender', MAXIMUM_ADDRESS_CHARACTERS),
    to: normalizedAddresses(record.to, 'Gmail message recipients'),
    sentAt: normalizedSentAtValue(record.email_ts),
    labels: messageLabels(record),
    subject,
    body
  };
}

function normalizedThreadBatch(payload, input) {
  const requested = new Set(input.messageIds);
  const seenRequested = new Set();
  const seenMessages = new Set();
  const seenThreads = new Set();
  const parsed = exactObject(payload, 'Gmail thread read result', { required: ['responses'] });
  if (!Array.isArray(parsed.responses)) {
    throw providerError('validation', 'Gmail thread read responses must be an array.');
  }
  const records = parsed.responses;
  if (records.length < 1 || records.length > input.maximumThreads) {
    throw providerError('validation', 'Gmail thread read returned an invalid thread count.');
  }
  const threads = records.map((record) => {
    exactObject(record, 'Gmail thread', {
      required: ['thread_id', 'total_messages', 'truncated', 'messages']
    });
    const id = boundedRequiredString(
      record.thread_id,
      'Gmail thread identity',
      MAXIMUM_PROVIDER_ID_CHARACTERS
    );
    if (seenThreads.has(id)) {
      throw providerError('conflict', 'Gmail thread read returned a duplicate thread identity.');
    }
    seenThreads.add(id);
    if (!Number.isInteger(record.total_messages) || record.total_messages < 1
      || typeof record.truncated !== 'boolean') {
      throw providerError('validation', 'Gmail thread read returned invalid coverage metadata.');
    }
    if (record.truncated) {
      throw providerError('validation', 'Gmail thread read returned a truncated thread.');
    }
    const rawMessages = record.messages;
    if (!Array.isArray(rawMessages)
      || rawMessages.length < 1
      || rawMessages.length > input.maximumMessagesPerThread
      || rawMessages.length !== record.total_messages) {
      throw providerError('validation', 'Gmail thread read returned an invalid message count.');
    }
    const messages = rawMessages.map((message) => normalizedBatchMessage(message, id, requested));
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
  if (seenMessages.size > input.maximumTotalMessages) {
    throw providerError('validation', 'Gmail thread read exceeded the exact aggregate message bound.');
  }
  return threads;
}

function threadMessageQueue(threads) {
  return threads.flatMap((thread) => thread.messages.filter((message) => {
    return message.membership === 'exact-request';
  }).map((message) => ({
    messageId: message.id,
    threadId: thread.id
  }))).sort((left, right) => {
    return compareCodepoint(left.messageId, right.messageId)
      || compareCodepoint(left.threadId, right.threadId);
  });
}

function priorPageReceipts(priorPages, sequence) {
  if (!Array.isArray(priorPages) || priorPages.length !== sequence - 1) {
    throw providerError('conflict', 'Gmail thread enrichment prior pages are incomplete.');
  }
  for (let index = 0; index < priorPages.length; index += 1) {
    const receipt = exactObject(priorPages[index], 'Gmail prior page receipt', {
      required: ['sequence', 'page', 'pageFingerprint']
    });
    if (receipt.sequence !== index + 1
      || receipt.pageFingerprint !== fingerprintJson(receipt.page)) {
      throw providerError('conflict', 'Gmail prior page receipt fingerprint is invalid.');
    }
  }
  return priorPages;
}

function exactNormalizedPage(receipt, label) {
  const page = exactObject(receipt.page, label, {
    required: [
      'observedCount',
      'includedCount',
      'excludedCount',
      'observedIdentityFingerprints',
      'data'
    ]
  });
  if (!Number.isInteger(page.observedCount) || page.observedCount < 0
    || !Number.isInteger(page.includedCount) || page.includedCount < 0
    || !Number.isInteger(page.excludedCount) || page.excludedCount < 0
    || page.observedCount !== page.includedCount + page.excludedCount
    || !Array.isArray(page.observedIdentityFingerprints)
    || page.observedIdentityFingerprints.length !== page.observedCount
    || new Set(page.observedIdentityFingerprints).size
      !== page.observedIdentityFingerprints.length
    || page.observedIdentityFingerprints.some((item) => {
      return typeof item !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item);
    })) {
    throw providerError('conflict', label + ' coverage is invalid.');
  }
  return page;
}

function exactStoredBatchThreads(data, input) {
  const stored = exactObject(data, 'Gmail stored thread batch', {
    required: ['kind', 'threads']
  });
  if (stored.kind !== 'gmail-thread-batch'
    || !input || typeof input !== 'object' || Array.isArray(input)
    || !Array.isArray(stored.threads)
    || stored.threads.length < 1
    || stored.threads.length > input.maximumThreads) {
    throw providerError('conflict', 'Gmail stored thread batch is invalid or unbounded.');
  }
  const requested = new Set(exactBoundedStrings(
    input.messageIds,
    'Mail thread message IDs',
    MAXIMUM_REQUESTED_MESSAGES,
    MAXIMUM_PROVIDER_ID_CHARACTERS,
    { required: true }
  ));
  const seenThreads = new Set();
  const seenMessages = new Set();
  const seenRequested = new Set();
  for (const thread of stored.threads) {
    const normalizedThread = exactObject(thread, 'Gmail stored thread', {
      required: ['id', 'messages']
    });
    const threadId = boundedRequiredString(
      normalizedThread.id,
      'Gmail stored thread identity',
      MAXIMUM_PROVIDER_ID_CHARACTERS
    );
    if (seenThreads.has(threadId)
      || !Array.isArray(normalizedThread.messages)
      || normalizedThread.messages.length < 1
      || normalizedThread.messages.length > input.maximumMessagesPerThread) {
      throw providerError('conflict', 'Gmail stored thread identities or bounds are invalid.');
    }
    seenThreads.add(threadId);
    let related = false;
    for (const message of normalizedThread.messages) {
      const normalizedMessage = exactObject(message, 'Gmail stored thread message', {
        required: [
          'id', 'membership', 'rfc822MessageId', 'from', 'to', 'sentAt', 'labels',
          'subject', 'body'
        ]
      });
      const id = boundedRequiredString(
        normalizedMessage.id,
        'Gmail stored message identity',
        MAXIMUM_PROVIDER_ID_CHARACTERS
      );
      if (seenMessages.has(id)) {
        throw providerError('conflict', 'Gmail stored thread batch repeats a message identity.');
      }
      seenMessages.add(id);
      const isRequested = requested.has(id);
      if (normalizedMessage.membership !== (isRequested ? 'exact-request' : 'thread-context')
        || normalizedMessage.rfc822MessageId !== null) {
        throw providerError(
          'conflict',
          'Gmail stored message membership does not match the exact request.'
        );
      }
      boundedRequiredString(
        normalizedMessage.from,
        'Gmail stored message sender',
        MAXIMUM_ADDRESS_CHARACTERS
      );
      exactBoundedStrings(
        normalizedMessage.to,
        'Gmail stored message recipients',
        MAXIMUM_ADDRESSES,
        MAXIMUM_ADDRESS_CHARACTERS
      );
      if (typeof normalizedMessage.sentAt !== 'string'
        || normalizedSentAtValue(normalizedMessage.sentAt) !== normalizedMessage.sentAt) {
        throw providerError('conflict', 'Gmail stored message timestamp is not normalized.');
      }
      messageLabels(normalizedMessage);
      boundedText(
        normalizedMessage.subject,
        'Gmail stored message subject',
        MAXIMUM_SUBJECT_CHARACTERS
      );
      boundedText(
        normalizedMessage.body,
        'Gmail stored message body',
        MAXIMUM_BODY_CHARACTERS
      );
      if (isRequested) {
        related = true;
        seenRequested.add(id);
      }
    }
    if (!related) {
      throw providerError(
        'conflict',
        'Gmail stored thread batch contains a thread unrelated to the exact request.'
      );
    }
  }
  if (seenRequested.size !== requested.size) {
    throw providerError('conflict', 'Gmail stored thread batch omits an exact requested message.');
  }
  if (seenMessages.size > input.maximumTotalMessages) {
    throw providerError('conflict', 'Gmail stored thread batch exceeds its aggregate message bound.');
  }
  return stored.threads;
}

function assertRfc822MessageId(value) {
  const match = typeof value === 'string'
    ? /^<([^<>@\s]+)@([^<>@\s]+)>$/.exec(value)
    : null;
  const atom = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+$/;
  const isDotAtom = (part) => part.split('.').every((component) => atom.test(component));
  if (typeof value !== 'string'
    || value.length > 1000
    || !/^[\x20-\x7e]+$/.test(value)
    || !match
    || !isDotAtom(match[1])
    || !isDotAtom(match[2])) {
    throw providerError('validation', 'Gmail raw MIME must contain exactly one valid RFC822 Message-ID.');
  }
  return value;
}

function exactBatchReceipt(receipt, input) {
  const page = exactNormalizedPage(receipt, 'Gmail stored thread batch page');
  const threads = exactStoredBatchThreads(page.data, input);
  const expectedIdentities = threads.map((thread) => fingerprintJson({
    phase: 'thread-batch',
    providerThreadId: thread.id
  }));
  if (page.observedCount !== threads.length
    || page.includedCount !== threads.length
    || page.excludedCount !== 0
    || fingerprintJson(page.observedIdentityFingerprints)
      !== fingerprintJson(expectedIdentities)) {
    throw providerError('conflict', 'Gmail stored thread batch page coverage is invalid.');
  }
  return threads;
}

function exactIdentityReceipt(receipt, expected) {
  const page = exactNormalizedPage(receipt, 'Gmail stored RFC822 identity page');
  const data = exactObject(page.data, 'Gmail stored RFC822 identity', {
    required: ['kind', 'messageId', 'threadId', 'rfc822MessageId']
  });
  if (data.kind !== 'gmail-rfc822-identity'
    || boundedRequiredString(
      data.messageId,
      'Gmail stored identity message ID',
      MAXIMUM_PROVIDER_ID_CHARACTERS
    ) !== expected.messageId
    || boundedRequiredString(
      data.threadId,
      'Gmail stored identity thread ID',
      MAXIMUM_PROVIDER_ID_CHARACTERS
    ) !== expected.threadId) {
    throw providerError(
      'conflict',
      'Gmail stored RFC822 identity does not match the deterministic batch queue.'
    );
  }
  assertRfc822MessageId(data.rfc822MessageId);
  const expectedIdentity = fingerprintJson({
    phase: 'rfc822-identity',
    providerThreadId: expected.threadId,
    providerMessageId: expected.messageId
  });
  if (page.observedCount !== 1
    || page.includedCount !== 1
    || page.excludedCount !== 0
    || fingerprintJson(page.observedIdentityFingerprints)
      !== fingerprintJson([expectedIdentity])) {
    throw providerError('conflict', 'Gmail stored RFC822 identity page coverage is invalid.');
  }
  return data;
}

function exactThreadPageState(page, priorPages, input) {
  assertThreadReadInput(input);
  const sequence = page?.sequence ?? 1;
  const maximumPages = page?.maximumPages ?? THREAD_READ_MAXIMUM_PAGES;
  if (!Number.isInteger(sequence) || sequence < 1
    || !Number.isInteger(maximumPages) || maximumPages !== THREAD_READ_MAXIMUM_PAGES) {
    throw providerError('validation', 'Gmail thread enrichment page state is invalid.');
  }
  const receipts = priorPageReceipts(priorPages ?? [], sequence);
  if (sequence === 1) return { sequence, maximumPages, receipts, queue: [] };
  const threads = exactBatchReceipt(receipts[0], input);
  const queue = threadMessageQueue(threads);
  if (queue.length + 1 > maximumPages) {
    throw providerError('validation', 'Gmail thread enrichment exceeds its exact maximum page bound.');
  }
  for (let index = 1; index < receipts.length; index += 1) {
    const expected = queue[index - 1];
    if (!expected) {
      throw providerError('conflict', 'Gmail thread enrichment prior identity pages do not match the batch queue.');
    }
    exactIdentityReceipt(receipts[index], expected);
  }
  return { sequence, maximumPages, receipts, queue };
}

function decodeRawMime(value) {
  if (typeof value !== 'string' || !value
    || value.length > MAXIMUM_RAW_MIME_BASE64URL_CHARACTERS
    || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw providerError('validation', 'Gmail raw MIME base64url payload is invalid.');
  }
  const unpadded = value.replace(/=+$/, '');
  const bytes = Buffer.from(unpadded, 'base64url');
  if (bytes.length > MAXIMUM_RAW_MIME_BYTES
    || bytes.toString('base64url') !== unpadded) {
    throw providerError('validation', 'Gmail raw MIME base64url payload is invalid.');
  }
  return bytes;
}

function rfc822MessageId(rawMime) {
  if (!Buffer.isBuffer(rawMime) && typeof rawMime !== 'string') {
    throw providerError('validation', 'Gmail raw MIME source is unavailable.');
  }
  const bytes = Buffer.isBuffer(rawMime) ? rawMime : Buffer.from(rawMime, 'utf8');
  if (bytes.length < 1 || bytes.length > MAXIMUM_RAW_MIME_BYTES) {
    throw providerError('validation', 'Gmail raw MIME source is unavailable.');
  }
  const headerWindow = bytes.subarray(0, MAXIMUM_RFC822_HEADER_BYTES + 4);
  const separator = [
    Buffer.from('\r\n\r\n', 'ascii'),
    Buffer.from('\n\n', 'ascii'),
    Buffer.from('\r\r', 'ascii')
  ].map((value) => headerWindow.indexOf(value))
    .filter((value) => value >= 0)
    .sort((left, right) => left - right)[0] ?? -1;
  if (separator < 0 || separator > MAXIMUM_RFC822_HEADER_BYTES) {
    throw providerError('validation', 'Gmail raw MIME headers are malformed or unbounded.');
  }
  const unfolded = headerWindow.subarray(0, separator).toString('latin1')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]+/g, ' ');
  const values = unfolded.split('\n').flatMap((line) => {
    const match = /^message-id\s*:(.*)$/i.exec(line);
    return match ? [match[1].trim()] : [];
  });
  if (values.length !== 1) {
    throw providerError('validation', 'Gmail raw MIME must contain exactly one valid RFC822 Message-ID.');
  }
  return assertRfc822MessageId(values[0]);
}

function normalizedRfc822Identity(payload, expected) {
  const record = exactObject(payload, 'Gmail single-message identity result', {
    required: ['id', 'thread_id'],
    allowed: LIVE_MESSAGE_KEYS
  });
  if (boundedRequiredString(
    record.id,
    'Gmail identity message ID',
    MAXIMUM_PROVIDER_ID_CHARACTERS
  ) !== expected.messageId
    || boundedRequiredString(
      record.thread_id,
      'Gmail identity thread ID',
      MAXIMUM_PROVIDER_ID_CHARACTERS
    ) !== expected.threadId) {
    throw providerError('conflict', 'Gmail RFC822 identity result does not match the exact queued message.');
  }
  const sources = [];
  if (Object.hasOwn(record, 'raw_mime') && record.raw_mime !== null) {
    sources.push(record.raw_mime);
  }
  if (Object.hasOwn(record, 'raw_mime_base64url') && record.raw_mime_base64url !== null) {
    sources.push(decodeRawMime(record.raw_mime_base64url));
  }
  if (!sources.length) {
    throw providerError('validation', 'Gmail RFC822 identity result omitted raw MIME.');
  }
  const identities = sources.map(rfc822MessageId);
  if (new Set(identities).size !== 1) {
    throw providerError('conflict', 'Gmail raw MIME representations disagree on RFC822 Message-ID.');
  }
  return {
    messageId: expected.messageId,
    threadId: expected.threadId,
    rfc822MessageId: identities[0]
  };
}

function messageId(record) {
  return boundedRequiredString(
    record.id,
    'Gmail batch read message identity',
    MAXIMUM_PROVIDER_ID_CHARACTERS
  );
}

function messageLabels(record) {
  const labels = record.labels;
  if (!Array.isArray(labels)
    || labels.length > MAXIMUM_LABELS
    || labels.some((label) => {
      return typeof label !== 'string'
        || !label.trim()
        || label.length > MAXIMUM_LABEL_CHARACTERS;
    })
    || new Set(labels).size !== labels.length) {
    throw providerError('validation', 'Gmail batch read labels must be unique strings.');
  }
  return labels;
}

export function prepareMcp({
  capability,
  input,
  continuation = null,
  page = null,
  priorPages = []
}) {
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
    const state = exactThreadPageState(page, priorPages, input);
    if (state.sequence === 1) {
      if (continuation !== null && continuation !== undefined) {
        throw providerError('conflict', 'Gmail initial thread batch cannot accept continuation state.');
      }
      return {
        tool: 'batch_read_email_threads',
        arguments: {
          message_ids: exactStrings(input.messageIds, 'Mail thread message IDs', 100),
          max_messages: input.maximumMessagesPerThread
        }
      };
    }
    const expected = state.queue[state.sequence - 2];
    if (!expected || continuation?.cursor !== expected.messageId) {
      throw providerError('conflict', 'Gmail thread enrichment cursor does not match the deterministic queue.');
    }
    return {
      tool: 'read_email',
      arguments: {
        message_id: expected.messageId,
        include_raw_mime: true
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
    throw providerError('validation', 'Gmail thread reads require bounded RFC822 enrichment pages.');
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

export function completeMcpPage({
  capability,
  input,
  responseProfile,
  response,
  page = null,
  priorPages = []
}) {
  if (capability !== 'mail.threads.read') {
    throw providerError('validation', 'Gmail MCP pagination does not implement ' + capability + '.');
  }
  const state = exactThreadPageState(page, priorPages, input);
  if (state.sequence === 1) {
    const threads = normalizedThreadBatch(
      nativePayload(response, responseProfile, 'Gmail thread read'),
      input
    );
    const queue = threadMessageQueue(threads);
    if (queue.length + 1 > state.maximumPages) {
      throw providerError('validation', 'Gmail thread enrichment exceeds its exact maximum page bound.');
    }
    return {
      page: {
        observedCount: threads.length,
        includedCount: threads.length,
        excludedCount: 0,
        observedIdentityFingerprints: threads.map((thread) => fingerprintJson({
          phase: 'thread-batch',
          providerThreadId: thread.id
        })),
        data: { kind: 'gmail-thread-batch', threads }
      },
      continuation: { state: 'more', cursor: queue[0].messageId }
    };
  }
  const expected = state.queue[state.sequence - 2];
  if (!expected) {
    throw providerError('conflict', 'Gmail thread enrichment page exceeds its deterministic queue.');
  }
  const identity = normalizedRfc822Identity(
    nativePayload(response, responseProfile, 'Gmail single-message identity'),
    expected
  );
  const next = state.queue[state.sequence - 1] ?? null;
  return {
    page: {
      observedCount: 1,
      includedCount: 1,
      excludedCount: 0,
      observedIdentityFingerprints: [fingerprintJson({
        phase: 'rfc822-identity',
        providerThreadId: identity.threadId,
        providerMessageId: identity.messageId
      })],
      data: { kind: 'gmail-rfc822-identity', ...identity }
    },
    continuation: next
      ? { state: 'more', cursor: next.messageId }
      : { state: 'exhausted' }
  };
}

export function finalizeMcpPages({
  capability,
  input,
  authority,
  pages,
  coverage,
  at
}) {
  if (capability !== 'mail.threads.read') {
    throw providerError('validation', 'Gmail MCP pagination does not implement ' + capability + '.');
  }
  const exactCoverage = exactObject(coverage, 'Gmail thread enrichment coverage', {
    required: [
      'complete',
      'cursorExhausted',
      'pagesRead',
      'observedCount',
      'includedCount',
      'excludedCount'
    ]
  });
  if (exactCoverage.complete !== true || exactCoverage.cursorExhausted !== true
    || exactCoverage.pagesRead !== pages?.length || !Array.isArray(pages) || pages.length < 2) {
    throw providerError('validation', 'Gmail thread enrichment requires exact exhausted coverage.');
  }
  const state = exactThreadPageState(
    { sequence: pages.length + 1, maximumPages: THREAD_READ_MAXIMUM_PAGES },
    pages,
    input
  );
  if (pages.length !== state.queue.length + 1) {
    throw providerError('conflict', 'Gmail thread enrichment omitted one or more identity pages.');
  }
  const totals = pages.reduce((value, receipt) => ({
    observedCount: value.observedCount + receipt.page.observedCount,
    includedCount: value.includedCount + receipt.page.includedCount,
    excludedCount: value.excludedCount + receipt.page.excludedCount
  }), { observedCount: 0, includedCount: 0, excludedCount: 0 });
  if (exactCoverage.observedCount !== totals.observedCount
    || exactCoverage.includedCount !== totals.includedCount
    || exactCoverage.excludedCount !== totals.excludedCount) {
    throw providerError('conflict', 'Gmail thread enrichment coverage totals are invalid.');
  }
  const identities = new Map(pages.slice(1).map((receipt) => {
    const data = receipt.page.data;
    return [data.messageId, data];
  }));
  if (identities.size !== state.queue.length) {
    throw providerError('conflict', 'Gmail thread enrichment contains duplicate message identities.');
  }
  const threads = pages[0].page.data.threads.map((thread) => ({
    id: thread.id,
    messages: thread.messages.map((message) => {
      if (message.membership === 'thread-context') {
        if (identities.has(message.id)) {
          throw providerError('conflict', 'Gmail thread context received an undeclared RFC822 identity.');
        }
        return { ...message, rfc822MessageId: null };
      }
      const identity = identities.get(message.id);
      if (!identity || identity.threadId !== thread.id) {
        throw providerError('conflict', 'Gmail thread enrichment identity join is incomplete.');
      }
      return { ...message, rfc822MessageId: identity.rfc822MessageId };
    })
  }));
  return {
    requestedMessageIds: [...input.messageIds].sort(compareCodepoint),
    returnedThreadCount: threads.length,
    returnedMessageCount: threads.reduce((total, thread) => total + thread.messages.length, 0),
    threads,
    provenance: provenance(authority, {
      capability,
      messageIds: [...input.messageIds].sort(compareCodepoint),
      maximumThreads: input.maximumThreads,
      maximumMessagesPerThread: input.maximumMessagesPerThread,
      maximumTotalMessages: input.maximumTotalMessages,
      pageFingerprints: pages.map((receipt) => receipt.pageFingerprint)
    }),
    observedAt: at
  };
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
