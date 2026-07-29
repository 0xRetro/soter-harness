import fs from 'node:fs';

import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { collaborationConversationIdentityFingerprint } from '../../contexts/communications/collaboration/identity.mjs';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function providerError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function exactInstant(value, label) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw providerError('validation', label + ' must be a valid instant.');
  }
  return new Date(value).toISOString();
}

function provenance(authority, fixture, capability, input, outputBasis) {
  return {
    provider: 'slack-fixture',
    authority,
    sourceKind: 'fixture',
    sourceReferenceFingerprint: fingerprintJson({
      fixtureId: fixture.id,
      capability,
      input,
      outputBasis
    })
  };
}

function exactFixture(fixtures, state) {
  const fixture = state || JSON.parse(fs.readFileSync(fixtures[0], 'utf8'));
  if (fixture?.data?.workspace?.id === undefined || !Array.isArray(fixture.data.channels)) {
    throw providerError('validation', 'Slack fixture is malformed.');
  }
  return fixture;
}

function exactWorkspace(fixture, workspaceId) {
  if (workspaceId !== fixture.data.workspace.id) {
    throw providerError('not-found', 'Slack workspace fixture did not resolve exactly once.');
  }
}

function assertConfiguredWorkspace(settings, input) {
  const configured = settings?.['integration.slack'];
  if (!configured
    || Object.keys(configured).length !== 1
    || typeof configured.workspaceId !== 'string'
    || !configured.workspaceId) {
    throw providerError(
      'validation',
      'Slack fixture requires one exact integration.slack workspace setting.'
    );
  }
  if (input?.workspaceId !== configured.workspaceId) {
    throw providerError(
      'authorization',
      'Slack fixture input does not match the exact configured workspace.'
    );
  }
}

function identityFingerprint(workspaceId, conversationId) {
  return collaborationConversationIdentityFingerprint({
    platform: 'slack',
    providerWorkspaceId: workspaceId,
    providerConversationId: conversationId
  });
}

function fixtureConversationKind(channel) {
  const derived = channel.visibility === 'public' ? 'public-channel' : 'private-channel';
  const kind = channel.kind ?? derived;
  if (!['public-channel', 'private-channel', 'direct-message', 'group-direct-message'].includes(kind)) {
    throw providerError('validation', 'Slack fixture conversation kind is unsupported.');
  }
  const expectedVisibility = kind === 'public-channel' ? 'public' : 'private';
  if (channel.visibility !== expectedVisibility) {
    throw providerError('validation', 'Slack fixture conversation kind conflicts with visibility.');
  }
  if ((kind === 'public-channel' || kind === 'private-channel')
    && (typeof channel.name !== 'string' || !channel.name.trim())) {
    throw providerError('validation', 'Slack fixture channels require a non-empty name.');
  }
  return kind;
}

function conversationProjection(workspaceId, channel) {
  const kind = fixtureConversationKind(channel);
  const value = {
    providerConversationId: channel.id,
    kind,
    name: channel.name ?? null,
    visibility: channel.visibility,
    shared: channel.shared === true,
    permalink: channel.permalink ?? null,
    identityFingerprint: identityFingerprint(workspaceId, channel.id),
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  value.fingerprint = fingerprintJson(unsigned);
  return value;
}

function participantProjection(workspaceId, member) {
  const value = {
    providerParticipantId: member.providerPersonId,
    displayName: member.displayName ?? null,
    email: member.email ?? null,
    identityFingerprint: fingerprintJson({
      platform: 'slack',
      providerWorkspaceId: workspaceId,
      providerParticipantId: member.providerPersonId
    }),
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  value.fingerprint = fingerprintJson(unsigned);
  return value;
}

function messageProjection(message, rootMessageId = null, { requireReplyCount = false } = {}) {
  if (requireReplyCount
    && (!Number.isInteger(message.replyCount) || message.replyCount < 0)) {
    throw providerError(
      'validation',
      'Slack fixture message requires an exact non-negative integer replyCount.'
    );
  }
  if (Object.hasOwn(message, 'replyCount')
    && (!Number.isInteger(message.replyCount) || message.replyCount < 0)) {
    throw providerError('validation', 'Slack fixture message replyCount is invalid.');
  }
  const content = String(message.text ?? '');
  const value = {
    providerMessageId: message.id,
    authorParticipantId: message.authorParticipantId ?? null,
    sentAt: exactInstant(message.sentAt, 'Slack fixture message sentAt'),
    threadRootMessageId: rootMessageId ?? message.threadRootMessageId ?? null,
    replyCount: Object.hasOwn(message, 'replyCount') ? message.replyCount : null,
    content,
    contentFingerprint: fingerprintJson(content),
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  value.fingerprint = fingerprintJson(unsigned);
  return value;
}

function exactChannel(fixture, conversationId) {
  const matches = fixture.data.channels.filter((channel) => channel.id === conversationId);
  if (matches.length !== 1) {
    throw providerError('not-found', 'Slack conversation fixture did not resolve exactly once.');
  }
  return matches[0];
}

function channelMessages(channel) {
  if (!Array.isArray(channel.messages)) return [];
  const ids = channel.messages.map((message) => message.id);
  if (ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    throw providerError('validation', 'Slack fixture message identities must be unique non-empty strings.');
  }
  return [...channel.messages].sort((left, right) => compareCodepoint(left.id, right.id));
}

function boundedMessages(channel, input) {
  const oldest = Date.parse(exactInstant(input.oldestInclusive, 'Slack message window oldestInclusive'));
  const latest = Date.parse(exactInstant(input.latestExclusive, 'Slack message window latestExclusive'));
  if (oldest >= latest) {
    throw providerError('validation', 'Slack message window must have a positive duration.');
  }
  const selected = channelMessages(channel).filter((message) => {
    const sentAt = Date.parse(exactInstant(message.sentAt, 'Slack fixture message sentAt'));
    return sentAt >= oldest && sentAt < latest && !message.threadRootMessageId;
  });
  if (selected.length > input.maximumMessages) {
    throw providerError('validation', 'Slack message window exceeds the exact bounded maximum.');
  }
  return selected;
}

export async function invoke({
  capability,
  input,
  authority,
  settings,
  fixtures,
  state,
  at
}) {
  assertConfiguredWorkspace(settings, input);
  const fixture = exactFixture(fixtures, state);
  exactWorkspace(fixture, input.workspaceId);
  const all = [...fixture.data.channels].sort((left, right) => compareCodepoint(left.id, right.id));

  if (capability === 'communications.conversations.list') {
    let selected;
    if (input.mode === 'visible') {
      const allowedKinds = new Set(input.kinds);
      const needle = input.nameContains?.toLowerCase() || null;
      selected = all.filter((channel) => {
        const kind = fixtureConversationKind(channel);
        return allowedKinds.has(kind)
          && (!needle || (channel.name ?? '').toLowerCase().includes(needle));
      });
    } else if (input.mode === 'exact') {
      if (!Number.isInteger(input.maximumObservedConversations)
        || input.maximumObservedConversations < 1
        || all.length > input.maximumObservedConversations) {
        throw providerError(
          'validation',
          'Slack exact conversation observation exceeds its policy-bound maximum.'
        );
      }
      const requested = new Set(input.conversationIds);
      selected = all.filter((channel) => requested.has(channel.id));
      if (selected.length !== requested.size) {
        throw providerError('not-found', 'At least one exact selected Slack conversation is unavailable.');
      }
    } else {
      throw providerError('validation', 'Slack conversation list mode is unsupported.');
    }
    if (selected.length > input.maximumConversations) {
      throw providerError('validation', 'Slack conversation result exceeds the exact bounded maximum.');
    }
    const conversations = selected.map((channel) => conversationProjection(input.workspaceId, channel));
    return {
      workspace: {
        providerWorkspaceId: fixture.data.workspace.id,
        displayName: fixture.data.workspace.name ?? null,
        identityFingerprint: fingerprintJson({
          platform: 'slack',
          providerWorkspaceId: fixture.data.workspace.id
        })
      },
      conversations,
      coverage: {
        complete: true,
        cursorExhausted: true,
        pagesRead: new Set(all.map((channel) => channel.page)).size || 1,
        observedCount: all.length,
        includedCount: conversations.length,
        excludedCount: all.length - conversations.length
      },
      provenance: provenance(authority, fixture, capability, input, conversations.map((item) => item.fingerprint)),
      observedAt: at || fixture.observedAt
    };
  }

  if (capability === 'communications.participants.read') {
    if (input.excludeBots !== true) {
      throw providerError('validation', 'Slack participant reads must exclude bots.');
    }
    const channel = exactChannel(fixture, input.conversationId);
    const members = Array.isArray(channel.members) ? channel.members : [];
    const humans = members.filter((member) => member.bot !== true);
    const bots = members.filter((member) => member.bot === true);
    if (humans.length > input.maximumParticipants) {
      throw providerError('validation', 'Slack participant roster exceeds the exact bounded maximum.');
    }
    const participants = humans
      .map((member) => participantProjection(input.workspaceId, member))
      .sort((left, right) => compareCodepoint(left.providerParticipantId, right.providerParticipantId));
    return {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      participants,
      coverage: {
        complete: true,
        cursorExhausted: true,
        pagesRead: 1,
        observedCount: members.length,
        includedHumanCount: humans.length,
        excludedBotCount: bots.length
      },
      provenance: provenance(authority, fixture, capability, input, participants.map((item) => item.fingerprint)),
      observedAt: at || fixture.observedAt
    };
  }

  if (capability === 'communications.messages.read') {
    if (input.includeThreadReplies !== false) {
      throw providerError('validation', 'Conversation-window reads must exclude thread replies.');
    }
    const channel = exactChannel(fixture, input.conversationId);
    const selected = boundedMessages(channel, input);
    const messages = selected.map((message) => {
      return messageProjection(message, null, { requireReplyCount: true });
    });
    return {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      window: {
        oldestInclusive: exactInstant(input.oldestInclusive, 'Slack message window oldestInclusive'),
        latestExclusive: exactInstant(input.latestExclusive, 'Slack message window latestExclusive')
      },
      messages,
      coverage: {
        complete: true,
        cursorExhausted: true,
        pagesRead: new Set(selected.map((message) => message.page ?? 1)).size || 1,
        observedCount: selected.length,
        includedCount: messages.length
      },
      provenance: provenance(authority, fixture, capability, input, messages.map((item) => item.fingerprint)),
      observedAt: at || fixture.observedAt
    };
  }

  if (capability === 'communications.thread.read') {
    if (input.selectionMode !== 'explicit-root') {
      throw providerError('authorization', 'Slack thread reads require one explicit root selection.');
    }
    const channel = exactChannel(fixture, input.conversationId);
    const allMessages = channelMessages(channel);
    const root = allMessages.find((message) => message.id === input.rootMessageId);
    if (!root || root.threadRootMessageId) {
      throw providerError('not-found', 'Slack thread root fixture did not resolve exactly once.');
    }
    const records = [root, ...allMessages.filter((message) => {
      return message.threadRootMessageId === root.id;
    })];
    if (records.length > input.maximumMessages) {
      throw providerError('validation', 'Slack thread exceeds the exact bounded maximum.');
    }
    const messages = records.map((message) => {
      const projected = messageProjection(message, message.id === root.id ? null : root.id);
      return {
        providerMessageId: projected.providerMessageId,
        authorParticipantId: projected.authorParticipantId,
        sentAt: projected.sentAt,
        isRoot: message.id === root.id,
        content: projected.content,
        contentFingerprint: projected.contentFingerprint,
        fingerprint: fingerprintJson({
          providerMessageId: projected.providerMessageId,
          authorParticipantId: projected.authorParticipantId,
          sentAt: projected.sentAt,
          isRoot: message.id === root.id,
          content: projected.content,
          contentFingerprint: projected.contentFingerprint
        })
      };
    });
    return {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      rootMessageId: input.rootMessageId,
      messages,
      coverage: {
        complete: true,
        cursorExhausted: true,
        pagesRead: new Set(records.map((message) => message.threadPage ?? 1)).size || 1,
        observedCount: records.length,
        includedCount: messages.length
      },
      provenance: provenance(authority, fixture, capability, input, messages.map((item) => item.fingerprint)),
      observedAt: at || fixture.observedAt
    };
  }

  throw providerError('validation', 'Slack fixture does not implement ' + capability + '.');
}
