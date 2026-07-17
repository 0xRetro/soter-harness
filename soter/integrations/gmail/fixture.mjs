import crypto from 'node:crypto';
import fs from 'node:fs';

import { fingerprintJson } from '../../core/lib/canonical-json.mjs';

function providerError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function provenance(authority) {
  return {
    provider: 'gmail-fixture',
    authority,
    sourceKind: 'fixture',
    sourceReferenceFingerprint: fingerprintJson({
      provider: 'gmail-fixture',
      fixture: 'soter/fixtures/providers/gmail/inbox-window.json'
    })
  };
}

function fixtureState(fixtures, state) {
  return state || JSON.parse(fs.readFileSync(fixtures[0], 'utf8'));
}

function transportMessage(message) {
  return {
    id: message.id,
    rfc822MessageId: message.rfc822MessageId,
    from: message.from,
    to: structuredClone(message.to),
    sentAt: message.sentAt,
    labels: structuredClone(message.labels),
    subject: message.subject,
    body: message.body
  };
}

export async function invoke({ capability, input, authority, fixtures, state, at }) {
  const fixture = fixtureState(fixtures, state);
  const observedAt = at || fixture.observedAt;
  if (capability === 'mail.messages.search') {
    if (input.query !== fixture.data.query) {
      throw providerError('not-found', 'Contained mailbox fixture does not match the exact bounded query.');
    }
    const matched = fixture.data.threads.flatMap((thread) => thread.messages).filter((message) => {
      return message.labels.includes('INBOX');
    }).map((message) => message.id).sort((left, right) => left.localeCompare(right, 'en'));
    const messageIds = matched.slice(0, input.maximumMessages);
    return {
      queryFingerprint: fingerprintJson(input.query),
      messageIds,
      returnedMessageCount: messageIds.length,
      complete: matched.length <= input.maximumMessages,
      provenance: provenance(authority),
      observedAt
    };
  }
  if (capability === 'mail.threads.read') {
    const requested = new Set(input.messageIds);
    const allMessages = fixture.data.threads.flatMap((thread) => thread.messages);
    if (input.messageIds.some((id) => !allMessages.some((message) => message.id === id))) {
      throw providerError('not-found', 'One or more contained mail messages do not exist.');
    }
    const threads = fixture.data.threads.filter((thread) => {
      return thread.messages.some((message) => requested.has(message.id));
    });
    if (threads.length > input.maximumThreads
      || threads.some((thread) => thread.messages.length > input.maximumMessagesPerThread)) {
      throw providerError('validation', 'Contained mail thread expansion exceeds an exact bound.');
    }
    return {
      requestedMessageIds: [...input.messageIds].sort((left, right) => left.localeCompare(right, 'en')),
      returnedThreadCount: threads.length,
      threads: threads.map((thread) => ({
        id: thread.id,
        messages: thread.messages.map(transportMessage)
      })),
      provenance: provenance(authority),
      observedAt
    };
  }
  if (capability === 'mail.window.read') {
    if (input.query !== fixture.data.query) {
      throw providerError('not-found', 'Contained mailbox fixture does not match the exact bounded query.');
    }
    if (fixture.data.threads.length > input.maximumThreads) {
      throw providerError('validation', 'Contained mailbox window exceeds the exact maximum thread bound.');
    }
    return {
      queryFingerprint: fingerprintJson(input.query),
      returnedThreadCount: fixture.data.threads.length,
      threads: structuredClone(fixture.data.threads),
      provenance: provenance(authority),
      observedAt
    };
  }
  if (capability === 'mail.labels.read') {
    if (input.maximumMessages < input.messageIds.length) {
      throw providerError('validation', 'Contained label read exceeds the exact message bound.');
    }
    const requested = new Set(input.messageIds);
    const messages = fixture.data.threads.flatMap((thread) => thread.messages).filter((message) => {
      return requested.has(message.id);
    }).map((message) => ({
      messageId: message.id,
      labelNames: message.labels.filter((label) => input.labelNames.includes(label)).sort()
    })).sort((left, right) => left.messageId.localeCompare(right.messageId, 'en'));
    return { messages, provenance: provenance(authority), observedAt };
  }
  if (capability === 'mail.labels.apply') {
    if (input.createMissingLabels !== false
      || !input.addLabelNames.every((label) => label.startsWith('AI/'))
      || !input.removeLabelNames.every((label) => label.startsWith('AI/'))) {
      throw providerError('authorization', 'Contained mail labels must remain inside the AI/ namespace.');
    }
    const requested = new Set(input.messageIds);
    const messages = fixture.data.threads.flatMap((thread) => thread.messages).filter((message) => {
      return requested.has(message.id);
    });
    if (messages.length !== requested.size) {
      throw providerError('not-found', 'One or more contained mail messages do not exist.');
    }
    for (const message of messages) {
      message.labels = [...new Set([
        ...message.labels.filter((label) => !input.removeLabelNames.includes(label)),
        ...input.addLabelNames
      ])].sort();
    }
    return {
      messageIds: [...input.messageIds].sort(),
      addedLabelNames: [...input.addLabelNames].sort(),
      removedLabelNames: [...input.removeLabelNames].sort(),
      provenance: provenance(authority),
      observedAt
    };
  }
  if (capability === 'mail.drafts.list') {
    if (input.maximumDrafts < input.idempotencyKeys.length) {
      throw providerError('validation', 'Contained draft list exceeds the exact draft bound.');
    }
    const replies = new Set(input.replyMessageIds);
    const keys = new Set(input.idempotencyKeys);
    const drafts = fixture.data.drafts.filter((draft) => {
      return replies.has(draft.replyMessageId) && keys.has(draft.idempotencyKey);
    }).map((draft) => ({
      draftId: draft.id,
      replyMessageId: draft.replyMessageId,
      idempotencyKey: draft.idempotencyKey,
      contentFingerprint: draft.contentFingerprint
    })).sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey, 'en'));
    return { drafts, provenance: provenance(authority), observedAt };
  }
  if (capability === 'mail.drafts.create') {
    const replyMessage = fixture.data.threads.flatMap((thread) => thread.messages).find((message) => {
      return message.id === input.replyMessageId;
    });
    if (!replyMessage) throw providerError('not-found', 'Contained draft reply message does not exist.');
    const existing = fixture.data.drafts.find((draft) => {
      return draft.idempotencyKey === input.idempotencyKey;
    });
    const contentFingerprint = fingerprintJson({
      recipients: input.recipients,
      subject: input.subject,
      body: input.body
    });
    if (existing && existing.contentFingerprint !== contentFingerprint) {
      throw providerError('conflict', 'Contained draft idempotency key already binds different content.');
    }
    const draft = existing || {
      id: 'draft.' + crypto.createHash('sha256')
        .update(input.idempotencyKey)
        .digest('hex')
        .slice(0, 16),
      replyMessageId: input.replyMessageId,
      recipients: [...input.recipients],
      subject: input.subject,
      body: input.body,
      contentFingerprint,
      idempotencyKey: input.idempotencyKey
    };
    if (!existing) fixture.data.drafts.push(draft);
    return {
      draftId: draft.id,
      replyMessageId: draft.replyMessageId,
      contentFingerprint: draft.contentFingerprint,
      provenance: provenance(authority),
      observedAt
    };
  }
  throw providerError('validation', 'Gmail fixture does not implement ' + capability + '.');
}
