import assert from 'node:assert/strict';
import {
  completeMcp,
  completeMcpPage,
  completeProbePlanStepMcp,
  finalizeMcpPages,
  prepareMcp
} from './mcp.mjs';
import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

const RESPONSE_PROFILE = 'gmail.codex.connector.v1';
const AT = '2026-08-06T00:00:00.000Z';
const THREAD_INPUT = {
  messageIds: ['message.2', 'message.1'],
  maximumThreads: 2,
  maximumMessagesPerThread: 25,
  maximumTotalMessages: 25
};

function response(structuredContent, extra = {}) {
  return {
    structuredContent,
    content: [{ type: 'text', text: 'This model-visible text is never parsed.' }],
    ...extra
  };
}

function completeSearch(value) {
  return completeMcp({
    capability: 'mail.messages.search',
    input: { query: 'in:inbox newer_than:1d', maximumMessages: 2 },
    authority: 'mailbox.test',
    responseProfile: RESPONSE_PROFILE,
    response: value,
    at: AT
  });
}

function assertProviderError(run, kind, pattern) {
  assert.throws(run, (error) => {
    assert.equal(error.kind, kind);
    assert.match(error.message, pattern);
    return true;
  });
}

function assertValidation(run, pattern) {
  assertProviderError(run, 'validation', pattern);
}

function batchMessage({ id, threadId = 'thread.1', numericTimestamp = false } = {}) {
  return {
    id,
    thread_id: threadId,
    email_ts: numericTimestamp ? 1785974400 : '2026-08-06T00:00:00.000Z',
    from_: 'sender@example.test',
    to: numericTimestamp ? 'operator@example.test' : ['operator@example.test'],
    cc: [],
    bcc: [],
    labels: ['INBOX'],
    subject: 'PRIVATE_SUBJECT_' + id,
    body: 'PRIVATE_BODY_' + id,
    snippet: 'withheld after normalization',
    display_title: null,
    display_url: null,
    has_attachment: false,
    attachments: [],
    inline_images: [],
    raw_mime: null,
    raw_mime_base64url: null
  };
}

function batchResponse(messages = [
  batchMessage({ id: 'message.2' }),
  batchMessage({ id: 'message.1', numericTimestamp: true })
], overrides = {}) {
  return response({
    responses: [{
      thread_id: 'thread.1',
      total_messages: messages.length,
      truncated: false,
      messages,
      ...overrides
    }]
  });
}

function rawMime(messageId, { duplicate = false, malformed = false } = {}) {
  const value = malformed ? 'not-a-message-id' : '<rfc822.' + messageId + '@example.test>';
  return [
    'From: sender@example.test',
    'mEsSaGe-Id:',
    ' ' + value,
    ...(duplicate ? ['Message-ID: <duplicate@example.test>'] : []),
    'Subject: private',
    '',
    'PRIVATE_RAW_MIME_BODY_' + messageId
  ].join('\r\n');
}

function identityResponse(messageId, options = {}) {
  const source = options.raw ?? rawMime(messageId, options);
  return response({
    id: options.returnedId ?? messageId,
    thread_id: options.threadId ?? 'thread.1',
    raw_mime: options.omitRaw ? null : source,
    raw_mime_base64url: options.includeBase64
      ? Buffer.from(source, 'utf8').toString('base64url')
      : null
  });
}

function receipt(sequence, page) {
  return { sequence, page, pageFingerprint: fingerprintJson(page) };
}

const direct = completeSearch(response({
  message_ids: ['message.2', 'message.1'],
  next_page_token: null
}));
assert.deepEqual(direct.messageIds, ['message.1', 'message.2']);
assert.equal(direct.returnedMessageCount, 2);
assert.equal(direct.complete, true);

const codepointOrdered = completeSearch(response({
  message_ids: ['message.a', 'message.A'],
  next_page_token: null
}));
assert.deepEqual(codepointOrdered.messageIds, ['message.A', 'message.a']);

assert.deepEqual(prepareMcp({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  page: { sequence: 1, maximumPages: 101 },
  priorPages: []
}), {
  tool: 'batch_read_email_threads',
  arguments: { message_ids: ['message.2', 'message.1'], max_messages: 25 }
});

const batch = completeMcpPage({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  responseProfile: RESPONSE_PROFILE,
  response: batchResponse(),
  page: { sequence: 1, maximumPages: 101 },
  priorPages: []
});
assert.equal(batch.continuation.cursor, 'message.1');
assert.equal(batch.page.data.kind, 'gmail-thread-batch');
assert.equal(batch.page.data.threads[0].messages[1].sentAt, '2026-08-06T00:00:00.000Z');
assert.deepEqual(
  batch.page.data.threads[0].messages.map((item) => item.membership),
  ['exact-request', 'exact-request']
);
assert.equal(JSON.stringify(batch).includes('raw_mime'), false);

const pages = [receipt(1, batch.page)];
assert.deepEqual(prepareMcp({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  continuation: { cursor: 'message.1' },
  page: { sequence: 2, maximumPages: 101 },
  priorPages: pages
}), {
  tool: 'read_email',
  arguments: { message_id: 'message.1', include_raw_mime: true }
});

const identityOne = completeMcpPage({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  responseProfile: RESPONSE_PROFILE,
  response: identityResponse('message.1', { includeBase64: true }),
  page: { sequence: 2, maximumPages: 101 },
  priorPages: pages
});
assert.equal(identityOne.page.data.rfc822MessageId, '<rfc822.message.1@example.test>');
assert.equal(identityOne.continuation.cursor, 'message.2');
assert.equal(JSON.stringify(identityOne).includes('PRIVATE_RAW_MIME_BODY'), false);
pages.push(receipt(2, identityOne.page));

assert.deepEqual(prepareMcp({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  continuation: { cursor: 'message.2' },
  page: { sequence: 3, maximumPages: 101 },
  priorPages: pages
}), {
  tool: 'read_email',
  arguments: { message_id: 'message.2', include_raw_mime: true }
});

const identityTwo = completeMcpPage({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  responseProfile: RESPONSE_PROFILE,
  response: identityResponse('message.2'),
  page: { sequence: 3, maximumPages: 101 },
  priorPages: pages
});
assert.deepEqual(identityTwo.continuation, { state: 'exhausted' });
pages.push(receipt(3, identityTwo.page));

const finalized = finalizeMcpPages({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  authority: 'mailbox.test',
  pages,
  coverage: {
    complete: true,
    cursorExhausted: true,
    pagesRead: 3,
    observedCount: 3,
    includedCount: 3,
    excludedCount: 0
  },
  at: AT
});
assert.equal(finalized.returnedThreadCount, 1);
assert.equal(finalized.returnedMessageCount, 2);
assert.deepEqual(finalized.threads[0].messages.map((item) => item.rfc822MessageId), [
  '<rfc822.message.2@example.test>',
  '<rfc822.message.1@example.test>'
]);
assert.equal(JSON.stringify(finalized).includes('PRIVATE_RAW_MIME_BODY'), false);
assert.equal(JSON.stringify(finalized).includes('raw_mime'), false);

const contextualInput = {
  messageIds: ['message.1'],
  maximumThreads: 1,
  maximumMessagesPerThread: 3,
  maximumTotalMessages: 3
};
const contextualBatch = completeMcpPage({
  capability: 'mail.threads.read',
  input: contextualInput,
  responseProfile: RESPONSE_PROFILE,
  response: batchResponse([
    batchMessage({ id: 'message.1' }),
    batchMessage({ id: 'message.context' })
  ]),
  page: { sequence: 1, maximumPages: 101 },
  priorPages: []
});
assert.equal(contextualBatch.continuation.cursor, 'message.1');
assert.deepEqual(
  contextualBatch.page.data.threads[0].messages.map((item) => item.membership),
  ['exact-request', 'thread-context']
);
const contextualPages = [receipt(1, contextualBatch.page)];
const contextualIdentity = completeMcpPage({
  capability: 'mail.threads.read',
  input: contextualInput,
  responseProfile: RESPONSE_PROFILE,
  response: identityResponse('message.1'),
  page: { sequence: 2, maximumPages: 101 },
  priorPages: contextualPages
});
assert.deepEqual(contextualIdentity.continuation, { state: 'exhausted' });
contextualPages.push(receipt(2, contextualIdentity.page));
const contextualFinalized = finalizeMcpPages({
  capability: 'mail.threads.read',
  input: contextualInput,
  authority: 'mailbox.test',
  pages: contextualPages,
  coverage: {
    complete: true,
    cursorExhausted: true,
    pagesRead: 2,
    observedCount: 2,
    includedCount: 2,
    excludedCount: 0
  },
  at: AT
});
assert.deepEqual(contextualFinalized.threads[0].messages.map((item) => ({
  membership: item.membership,
  rfc822MessageId: item.rfc822MessageId
})), [
  { membership: 'exact-request', rfc822MessageId: '<rfc822.message.1@example.test>' },
  { membership: 'thread-context', rfc822MessageId: null }
]);

const hundredMessageIds = Array.from({ length: 100 }, (_, index) => {
  return 'message.bound.' + String(index + 1).padStart(3, '0');
});
const hundredInput = {
  messageIds: [...hundredMessageIds].reverse(),
  maximumThreads: 1,
  maximumMessagesPerThread: 100,
  maximumTotalMessages: 100
};
const hundredBatch = completeMcpPage({
  capability: 'mail.threads.read',
  input: hundredInput,
  responseProfile: RESPONSE_PROFILE,
  response: batchResponse(hundredMessageIds.map((id) => batchMessage({ id }))),
  page: { sequence: 1, maximumPages: 101 },
  priorPages: []
});
const hundredPages = [receipt(1, hundredBatch.page)];
let hundredCurrent = hundredBatch;
for (let index = 0; index < hundredMessageIds.length; index += 1) {
  const messageId = hundredMessageIds[index];
  assert.equal(hundredCurrent.continuation.cursor, messageId);
  hundredCurrent = completeMcpPage({
    capability: 'mail.threads.read',
    input: hundredInput,
    responseProfile: RESPONSE_PROFILE,
    response: identityResponse(messageId),
    page: { sequence: index + 2, maximumPages: 101 },
    priorPages: hundredPages
  });
  hundredPages.push(receipt(index + 2, hundredCurrent.page));
}
assert.deepEqual(hundredCurrent.continuation, { state: 'exhausted' });
assert.equal(hundredPages.length, 101);
const hundredFinalized = finalizeMcpPages({
  capability: 'mail.threads.read',
  input: hundredInput,
  authority: 'mailbox.test',
  pages: hundredPages,
  coverage: {
    complete: true,
    cursorExhausted: true,
    pagesRead: 101,
    observedCount: 101,
    includedCount: 101,
    excludedCount: 0
  },
  at: AT
});
assert.equal(hundredFinalized.returnedMessageCount, 100);
assert.equal(
  hundredFinalized.threads[0].messages.every((message) => {
    return message.membership === 'exact-request'
      && typeof message.rfc822MessageId === 'string';
  }),
  true
);
assertProviderError(() => prepareMcp({
  capability: 'mail.threads.read',
  input: hundredInput,
  continuation: { cursor: 'message.impossible' },
  page: { sequence: 102, maximumPages: 101 },
  priorPages: hundredPages
}), 'conflict', /deterministic queue/);

const resealedBatchPages = structuredClone(pages);
resealedBatchPages[0].page.data.threads[0].messages[0].raw_mime =
  'HOSTILE_RESEALED_RAW_MIME_SENTINEL';
resealedBatchPages[0].pageFingerprint = fingerprintJson(resealedBatchPages[0].page);
assertValidation(() => prepareMcp({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  continuation: { cursor: 'message.1' },
  page: { sequence: 2, maximumPages: 101 },
  priorPages: [resealedBatchPages[0]]
}), /does not match the exact declared response profile/);

const crossedMembershipPages = structuredClone(contextualPages);
crossedMembershipPages[0].page.data.threads[0].messages[1].membership = 'exact-request';
crossedMembershipPages[0].pageFingerprint = fingerprintJson(crossedMembershipPages[0].page);
assertProviderError(() => prepareMcp({
  capability: 'mail.threads.read',
  input: contextualInput,
  continuation: { cursor: 'message.1' },
  page: { sequence: 2, maximumPages: 101 },
  priorPages: [crossedMembershipPages[0]]
}), 'conflict', /membership does not match/);

const exposedSiblingIdentityPages = structuredClone(contextualPages);
exposedSiblingIdentityPages[0].page.data.threads[0].messages[1].rfc822MessageId =
  '<context-should-be-null@example.test>';
exposedSiblingIdentityPages[0].pageFingerprint = fingerprintJson(
  exposedSiblingIdentityPages[0].page
);
assertProviderError(() => prepareMcp({
  capability: 'mail.threads.read',
  input: contextualInput,
  continuation: { cursor: 'message.1' },
  page: { sequence: 2, maximumPages: 101 },
  priorPages: [exposedSiblingIdentityPages[0]]
}), 'conflict', /membership does not match/);

const resealedIdentityPages = structuredClone(pages);
resealedIdentityPages[1].page.data.rfc822MessageId = 'not-a-message-id';
resealedIdentityPages[1].pageFingerprint = fingerprintJson(resealedIdentityPages[1].page);
assertValidation(() => prepareMcp({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  continuation: { cursor: 'message.2' },
  page: { sequence: 3, maximumPages: 101 },
  priorPages: resealedIdentityPages.slice(0, 2)
}), /exactly one valid RFC822 Message-ID/);
assertValidation(() => finalizeMcpPages({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  authority: 'mailbox.test',
  pages: resealedIdentityPages,
  coverage: {
    complete: true,
    cursorExhausted: true,
    pagesRead: 3,
    observedCount: 3,
    includedCount: 3,
    excludedCount: 0
  },
  at: AT
}), /exactly one valid RFC822 Message-ID/);

assertProviderError(() => prepareMcp({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  continuation: { cursor: 'message.wrong' },
  page: { sequence: 2, maximumPages: 101 },
  priorPages: [pages[0]]
}), 'conflict', /deterministic queue/);

assertValidation(() => completeMcpPage({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  responseProfile: RESPONSE_PROFILE,
  response: batchResponse(undefined, { truncated: true }),
  page: { sequence: 1, maximumPages: 101 },
  priorPages: []
}), /truncated thread/);

assertValidation(() => completeMcpPage({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  responseProfile: RESPONSE_PROFILE,
  response: batchResponse(undefined, { total_messages: 9 }),
  page: { sequence: 1, maximumPages: 101 },
  priorPages: []
}), /invalid message count/);

function assertFirstPageMessageRejected(mutate, pattern = /exact character bound/) {
  const message = batchMessage({ id: 'message.1' });
  mutate(message);
  assertValidation(() => completeMcpPage({
    capability: 'mail.threads.read',
    input: { ...THREAD_INPUT, messageIds: ['message.1'] },
    responseProfile: RESPONSE_PROFILE,
    response: batchResponse([message]),
    page: { sequence: 1, maximumPages: 101 },
    priorPages: []
  }), pattern);
}

assertValidation(() => prepareMcp({
  capability: 'mail.threads.read',
  input: { ...THREAD_INPUT, messageIds: ['m'.repeat(501)] },
  page: { sequence: 1, maximumPages: 101 },
  priorPages: []
}), /exact character bound/);

const overlongThreadId = 't'.repeat(501);
assertValidation(() => completeMcpPage({
  capability: 'mail.threads.read',
  input: { ...THREAD_INPUT, messageIds: ['message.1'] },
  responseProfile: RESPONSE_PROFILE,
  response: batchResponse(
    [batchMessage({ id: 'message.1', threadId: overlongThreadId })],
    { thread_id: overlongThreadId }
  ),
  page: { sequence: 1, maximumPages: 101 },
  priorPages: []
}), /exact character bound/);

const overlongSiblingId = 'm'.repeat(501);
assertValidation(() => completeMcpPage({
  capability: 'mail.threads.read',
  input: { ...THREAD_INPUT, messageIds: ['message.1'] },
  responseProfile: RESPONSE_PROFILE,
  response: batchResponse([
    batchMessage({ id: 'message.1' }),
    batchMessage({ id: overlongSiblingId })
  ]),
  page: { sequence: 1, maximumPages: 101 },
  priorPages: []
}), /exact character bound/);

for (const mutate of [
  (message) => { message.from_ = 'a'.repeat(1001); },
  (message) => { message.to = ['a'.repeat(1001)]; },
  (message) => {
    message.to = Array.from({ length: 501 }, (_, index) => 'person.' + index + '@example.test');
  },
  (message) => { message.cc = ['a'.repeat(1001)]; },
  (message) => { message.labels = ['L'.repeat(501)]; },
  (message) => {
    message.labels = Array.from({ length: 101 }, (_, index) => 'LABEL_' + index);
  },
  (message) => { message.subject = 's'.repeat(10_001); },
  (message) => { message.body = 'b'.repeat(1_000_001); }
]) {
  assertFirstPageMessageRejected(mutate, /exact character bound|unique.*strings/);
}

assertFirstPageMessageRejected((message) => {
  message.attachments = Array.from({ length: 501 }, () => ({}));
}, /must be an array when present/);

assertFirstPageMessageRejected((message) => {
  message.display_url = 'u'.repeat(10_001);
}, /must be text when present/);

const twentyFiveMessages = (threadId, prefix) => Array.from({ length: 25 }, (_, index) => {
  return batchMessage({
    id: prefix + String(index + 1).padStart(2, '0'),
    threadId
  });
});
const aggregateOverflow = [
  twentyFiveMessages('thread.1', 'message.a'),
  twentyFiveMessages('thread.2', 'message.b')
];
assertValidation(() => completeMcpPage({
  capability: 'mail.threads.read',
  input: {
    messageIds: ['message.a01', 'message.b01'],
    maximumThreads: 2,
    maximumMessagesPerThread: 25,
    maximumTotalMessages: 49
  },
  responseProfile: RESPONSE_PROFILE,
  response: response({
    responses: aggregateOverflow.map((messages, index) => ({
      thread_id: 'thread.' + (index + 1),
      total_messages: messages.length,
      truncated: false,
      messages
    }))
  }),
  page: { sequence: 1, maximumPages: 101 },
  priorPages: []
}), /aggregate message bound/);

assertValidation(() => prepareMcp({
  capability: 'mail.threads.read',
  input: {
    messageIds: ['message.1', 'message.2'],
    maximumThreads: 1,
    maximumMessagesPerThread: 2,
    maximumTotalMessages: 1
  },
  page: { sequence: 1, maximumPages: 101 },
  priorPages: []
}), /bounds are invalid/);

for (const [value, pattern, kind = 'validation'] of [
  [identityResponse('message.1', { omitRaw: true }), /omitted raw MIME/],
  [identityResponse('message.1', { duplicate: true }), /exactly one valid RFC822/],
  [identityResponse('message.1', { malformed: true }), /exactly one valid RFC822/],
  [identityResponse('message.1', { returnedId: 'message.wrong' }), /does not match/, 'conflict'],
  [identityResponse('message.1', { threadId: 'thread.wrong' }), /does not match/, 'conflict']
]) {
  assertProviderError(() => completeMcpPage({
    capability: 'mail.threads.read',
    input: THREAD_INPUT,
    responseProfile: RESPONSE_PROFILE,
    response: value,
    page: { sequence: 2, maximumPages: 101 },
    priorPages: [pages[0]]
  }), kind, pattern);
}

function mimeWithMessageId(value, body = 'PRIVATE_BODY') {
  return [
    'From: sender@example.test',
    'Message-ID: ' + value,
    'Subject: private',
    '',
    body
  ].join('\r\n');
}

for (const value of [
  '<non-ascii@ex\u00e4mple.test>',
  '<control@exam\u0001ple.test>',
  '<first@example.test> <second@example.test>',
  '<leading-dot@.example.test>',
  '<double-dot@example..test>',
  '<missing-at.example.test>',
  '<' + 'a'.repeat(990) + '@example.test>'
]) {
  assertValidation(() => completeMcpPage({
    capability: 'mail.threads.read',
    input: THREAD_INPUT,
    responseProfile: RESPONSE_PROFILE,
    response: identityResponse('message.1', { raw: mimeWithMessageId(value) }),
    page: { sequence: 2, maximumPages: 101 },
    priorPages: [pages[0]]
  }), /exactly one valid RFC822 Message-ID/);
}

const bodyHeaderLookalike = completeMcpPage({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  responseProfile: RESPONSE_PROFILE,
  response: identityResponse('message.1', {
    raw: mimeWithMessageId(
      '<header-only@example.test>',
      'Message-ID: <body-lookalike@example.test>'
    )
  }),
  page: { sequence: 2, maximumPages: 101 },
  priorPages: [pages[0]]
});
assert.equal(bodyHeaderLookalike.page.data.rfc822MessageId, '<header-only@example.test>');

const eightBitMime = Buffer.concat([
  Buffer.from([
    'From: sender@example.test',
    'Message-ID: <binary-body@example.test>',
    'Content-Transfer-Encoding: 8bit',
    '',
    ''
  ].join('\r\n'), 'ascii'),
  Buffer.from([0xff, 0xfe, 0x00, 0x80])
]);
const eightBitIdentity = completeMcpPage({
  capability: 'mail.threads.read',
  input: THREAD_INPUT,
  responseProfile: RESPONSE_PROFILE,
  response: identityResponse('message.1', {
    raw: eightBitMime,
    omitRaw: true,
    includeBase64: true
  }),
  page: { sequence: 2, maximumPages: 101 },
  priorPages: [pages[0]]
});
assert.equal(eightBitIdentity.page.data.rfc822MessageId, '<binary-body@example.test>');
assert.equal(JSON.stringify(eightBitIdentity).includes(eightBitMime.toString('base64url')), false);

const rawBatch = batchMessage({ id: 'message.1' });
rawBatch.raw_mime = 'RAW_BATCH_MIME_SENTINEL';
assertValidation(() => completeMcpPage({
  capability: 'mail.threads.read',
  input: { ...THREAD_INPUT, messageIds: ['message.1'] },
  responseProfile: RESPONSE_PROFILE,
  response: batchResponse([rawBatch]),
  page: { sequence: 1, maximumPages: 101 },
  priorPages: []
}), /exposed raw MIME/);

const directProbe = completeProbePlanStepMcp({
  step: {
    id: 'step.identity',
    kind: 'identity',
    scope: { expectation: { acknowledgedProfile: true } }
  },
  responseProfile: RESPONSE_PROFILE,
  response: response({ account_identity: 'withheld-by-adapter' })
});
assert.equal(directProbe.profileAcknowledged, true);

assertValidation(() => completeSearch({
  structuredContent: {
    result: { message_ids: ['message.1'], next_page_token: null }
  }
}), /unsupported legacy or mixed result wrapper/);

assertValidation(() => completeSearch({
  content: [{ type: 'text', text: 'message.1' }]
}), /does not match the exact declared response profile/);

assertProviderError(() => completeSearch(response({
  message_ids: ['message.1'],
  next_page_token: null
}, { isError: true })), 'unknown', /returned an error result/);

console.log('gmail adapter selftest passed');
