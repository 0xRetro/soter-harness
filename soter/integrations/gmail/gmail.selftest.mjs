import assert from 'node:assert/strict';
import {
  completeMcp,
  completeProbePlanStepMcp,
  prepareMcp
} from './mcp.mjs';

const RESPONSE_PROFILE = 'gmail.codex.connector.v1';
const AT = '2026-08-06T00:00:00.000Z';

function searchResponse(structuredContent, extra = {}) {
  return {
    structuredContent,
    content: [{ type: 'text', text: 'This model-visible text is never parsed.' }],
    ...extra
  };
}

function completeSearch(response) {
  return completeMcp({
    capability: 'mail.messages.search',
    input: {
      query: 'in:inbox newer_than:1d',
      maximumMessages: 2
    },
    authority: 'mailbox.test',
    responseProfile: RESPONSE_PROFILE,
    response,
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

const direct = completeSearch(searchResponse({
  message_ids: ['message.2', 'message.1'],
  next_page_token: null
}));
assert.deepEqual(direct.messageIds, ['message.1', 'message.2']);
assert.equal(direct.returnedMessageCount, 2);
assert.equal(direct.complete, true);

assert.deepEqual(prepareMcp({
  capability: 'mail.threads.read',
  input: {
    messageIds: ['message.2', 'message.1'],
    maximumThreads: 2,
    maximumMessagesPerThread: 25
  }
}), {
  tool: 'batch_read_email_threads',
  arguments: {
    message_ids: ['message.2', 'message.1'],
    max_messages: 25
  }
});

const directProbe = completeProbePlanStepMcp({
  step: {
    id: 'step.identity',
    kind: 'identity',
    scope: { expectation: { acknowledgedProfile: true } }
  },
  responseProfile: RESPONSE_PROFILE,
  response: searchResponse({ account_identity: 'withheld-by-adapter' })
});
assert.equal(directProbe.profileAcknowledged, true);

assertValidation(() => completeSearch({
  structuredContent: {
    result: {
      message_ids: ['message.1'],
      next_page_token: null
    }
  }
}), /unsupported legacy or mixed result wrapper/);

assertValidation(() => completeSearch({
  content: [{ type: 'text', text: 'message.1' }]
}), /does not match the exact declared response profile/);

assertValidation(() => completeSearch({
  structuredContent: JSON.stringify({
    message_ids: ['message.1'],
    next_page_token: null
  })
}), /direct structured result must be one structured object/);

assertValidation(() => completeSearch({
  structuredContent: {
    result: {
      message_ids: ['message.1'],
      next_page_token: null
    },
    message_ids: ['message.1'],
    next_page_token: null
  }
}), /unsupported legacy or mixed result wrapper/);

assertValidation(() => completeSearch({
  result: {
    structuredContent: {
      message_ids: ['message.1'],
      next_page_token: null
    }
  }
}), /does not match the exact declared response profile/);

assertProviderError(() => completeSearch(searchResponse({
  message_ids: ['message.1'],
  next_page_token: null
}, { isError: true })), 'unknown', /returned an error result/);

console.log('gmail adapter selftest passed');
