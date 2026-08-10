import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import { collaborationConversationIdentityFingerprint } from '../../contexts/communications/collaboration/identity.mjs';

function compareCodepoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function providerError(kind, message, code = null) {
  const error = new Error(message);
  error.kind = kind;
  if (code) error.code = code;
  return error;
}

function configuredSlackSettings(settings) {
  const configured = settings?.['integration.slack'];
  if (!configured
    || typeof configured !== 'object'
    || Array.isArray(configured)
    || Object.keys(configured).some((key) => {
      return !['workspaceId', 'readinessProbe'].includes(key);
    })
    || typeof configured.workspaceId !== 'string'
    || !configured.workspaceId) {
    throw providerError(
      'validation',
      'Slack MCP requires one exact integration.slack workspace setting.'
    );
  }
  if (!Object.hasOwn(configured, 'readinessProbe')) {
    return { workspaceId: configured.workspaceId, readinessProbe: null };
  }
  const probe = configured.readinessProbe;
  const keys = [
    'conversationId',
    'threadRootMessageId',
    'oldestInclusive',
    'latestExclusive'
  ];
  if (!probe
    || typeof probe !== 'object'
    || Array.isArray(probe)
    || Object.keys(probe).length !== keys.length
    || keys.some((key) => !Object.hasOwn(probe, key))
    || !/^[CDG][A-Z0-9]{8,63}$/.test(probe.conversationId || '')
    || !/^[0-9]{1,16}[.][0-9]{6}$/.test(probe.threadRootMessageId || '')) {
    throw providerError(
      'validation',
      'Slack MCP readiness probe settings are malformed.'
    );
  }
  const oldestInclusive = exactInstant(
    probe.oldestInclusive,
    'Slack readiness oldestInclusive'
  );
  const latestExclusive = exactInstant(
    probe.latestExclusive,
    'Slack readiness latestExclusive'
  );
  const oldestMillis = Date.parse(oldestInclusive);
  const latestMillis = Date.parse(latestExclusive);
  if (probe.oldestInclusive !== oldestInclusive
    || probe.latestExclusive !== latestExclusive
    || oldestMillis >= latestMillis
    || latestMillis - oldestMillis > 24 * 60 * 60 * 1000) {
    throw providerError(
      'validation',
      'Slack MCP readiness probe requires one canonical positive window of at most 24 hours.'
    );
  }
  return {
    workspaceId: configured.workspaceId,
    readinessProbe: {
      conversationId: probe.conversationId,
      threadRootMessageId: probe.threadRootMessageId,
      oldestInclusive,
      latestExclusive
    }
  };
}

function configuredWorkspaceId(settings) {
  return configuredSlackSettings(settings).workspaceId;
}

function assertConfiguredWorkspace(settings, input) {
  const workspaceId = configuredWorkspaceId(settings);
  if (input?.workspaceId !== workspaceId) {
    throw providerError(
      'authorization',
      'Slack MCP input does not match the exact configured workspace.'
    );
  }
  return workspaceId;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw providerError('validation', label + ' must be a non-empty string.');
  }
  return value.trim();
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return requiredString(value, label);
}

function exactInstant(value, label) {
  const text = requiredString(value, label);
  const millis = Date.parse(text);
  if (Number.isNaN(millis)) {
    throw providerError('validation', label + ' must be a valid instant.');
  }
  return new Date(millis).toISOString();
}

function slackTimestamp(value, label) {
  const instant = exactInstant(value, label);
  const milliseconds = Date.parse(instant);
  const seconds = BigInt(Math.floor(milliseconds / 1000));
  const micros = String((milliseconds % 1000) * 1000).padStart(6, '0');
  return String(seconds) + '.' + micros;
}

function instantFromSlackTimestamp(value, label) {
  const text = requiredString(value, label);
  const match = /^([0-9]+)\.([0-9]{1,6})$/.exec(text);
  if (!match) {
    const parsed = Date.parse(text);
    if (Number.isNaN(parsed)) throw providerError('validation', label + ' is invalid.');
    return new Date(parsed).toISOString();
  }
  const seconds = BigInt(match[1]);
  const millis = Number(seconds * 1000n + BigInt(match[2].padEnd(6, '0').slice(0, 3)));
  if (!Number.isSafeInteger(millis)) {
    throw providerError('validation', label + ' is outside the supported instant range.');
  }
  return new Date(millis).toISOString();
}

const CODEX_RESPONSE_PROFILE = 'slack.codex.connector.v1';
const RESPONSE_PROFILES = new Set([CODEX_RESPONSE_PROFILE]);

function exactResponseProfile(value) {
  const profile = value ?? CODEX_RESPONSE_PROFILE;
  if (!RESPONSE_PROFILES.has(profile)) {
    throw providerError(
      'validation',
      'Slack returned an undeclared structured response profile.',
      'STRUCTURED_RESPONSE_PROFILE_UNAVAILABLE'
    );
  }
  return profile;
}

function nativePayload(response, label) {
  if (response?.isError === true || response?.is_error === true) {
    throw providerError('unknown', label + ' returned an error result.');
  }
  const structuredContent = response?.structuredContent;
  if (!structuredContent || typeof structuredContent !== 'object' || Array.isArray(structuredContent)) {
    throw providerError(
      'validation',
      label + ' did not return the declared structured MCP response.',
      'STRUCTURED_RESPONSE_PROFILE_UNAVAILABLE'
    );
  }
  const value = Object.hasOwn(structuredContent, 'result')
    ? structuredContent.result
    : structuredContent;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw providerError(
      'validation',
      label + ' did not return one structured object.',
      'STRUCTURED_RESPONSE_PROFILE_UNAVAILABLE'
    );
  }
  return value;
}

function responsePayload({ response, label, responseProfile, capability }) {
  exactResponseProfile(responseProfile);
  let payload = nativePayload(response, label);
  for (const key of ['workspaces', 'teams', 'conversations', 'channels', 'members', 'messages']) {
    if (typeof payload[key] === 'string') {
      throw providerError(
        'validation',
        'Slack Codex connector returned prose where its structured response profile was required.'
      );
    }
  }
  if (typeof payload.pagination_info === 'string') {
    throw providerError(
      'validation',
      'Slack Codex connector returned prose pagination outside its structured response profile.'
    );
  }
  const containers = PAGINATION_CONTAINER_KEYS.flatMap((key) => {
    const value = payload[key];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? [{ key, value }]
      : [];
  });
  const hasExplicitState = [payload, ...containers.map((item) => item.value)].some((source) => {
    return Object.hasOwn(source, 'has_more') || Object.hasOwn(source, 'hasMore');
  });
  if (!hasExplicitState && containers.length) {
    const cursorValues = containers.flatMap(({ value }) => {
      return ['next_cursor', 'nextCursor']
        .filter((key) => Object.hasOwn(value, key))
        .map((key) => value[key]);
    });
    if (cursorValues.length
      && cursorValues.every((cursor) => typeof cursor === 'string')
      && new Set(cursorValues).size === 1) {
      const selected = containers.find(({ value }) => {
        return Object.hasOwn(value, 'next_cursor') || Object.hasOwn(value, 'nextCursor');
      });
      payload = {
        ...payload,
        [selected.key]: {
          ...selected.value,
          has_more: Boolean(cursorValues[0].trim())
        }
      };
    }
  }
  return payload;
}

function oneRecordArray(payload, keys, label, { allowEmpty = true } = {}) {
  const matches = keys.filter((key) => Array.isArray(payload[key]));
  if (matches.length !== 1) {
    throw providerError('validation', label + ' response must contain exactly one recognized record array.');
  }
  const records = payload[matches[0]];
  if (!allowEmpty && records.length === 0) {
    throw providerError('not-found', label + ' response contained no records.');
  }
  if (records.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw providerError('validation', label + ' response records must be objects.');
  }
  return records;
}

const PAGINATION_CONTAINER_KEYS = [
  'pagination_info',
  'paginationInfo',
  'response_metadata',
  'responseMetadata',
  'pagination'
];

function paginationContainers(payload, label) {
  return PAGINATION_CONTAINER_KEYS.flatMap((key) => {
    if (!Object.hasOwn(payload, key)) return [];
    const value = payload[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw providerError('validation', label + ' returned malformed pagination metadata.');
    }
    return [value];
  });
}

function explicitPaginationValues(payload, containers, keys) {
  const values = [];
  for (const source of [payload, ...containers]) {
    for (const key of keys) {
      if (Object.hasOwn(source, key)) values.push(source[key]);
    }
  }
  return values;
}

function paginationContinuation(payload, label) {
  const containers = paginationContainers(payload, label);
  const hasMoreValues = explicitPaginationValues(payload, containers, ['has_more', 'hasMore']);
  if (hasMoreValues.length === 0) {
    throw providerError(
      'validation',
      label + ' omitted its explicit exhausted-or-more pagination state.'
    );
  }
  if (hasMoreValues.some((value) => typeof value !== 'boolean')) {
    throw providerError('validation', label + ' returned a non-boolean has-more state.');
  }
  if (new Set(hasMoreValues).size > 1) {
    throw providerError('conflict', label + ' returned conflicting has-more states.');
  }
  const cursorValues = explicitPaginationValues(payload, containers, ['next_cursor', 'nextCursor']);
  if (cursorValues.length === 0) {
    throw providerError('validation', label + ' omitted explicit continuation cursor metadata.');
  }
  if (cursorValues.some((value) => typeof value !== 'string')) {
    throw providerError('validation', label + ' returned a non-string continuation cursor.');
  }
  const uniqueCursors = [...new Set(cursorValues)];
  if (uniqueCursors.length > 1) {
    throw providerError('conflict', label + ' returned conflicting continuation cursors.');
  }
  const hasMore = hasMoreValues[0];
  const cursor = uniqueCursors[0];
  if (hasMore && !cursor.trim()) {
    throw providerError('conflict', label + ' reported more pages without a continuation cursor.');
  }
  if (!hasMore && cursor) {
    throw providerError('conflict', label + ' returned a cursor after declaring pagination exhausted.');
  }
  return hasMore ? { state: 'more', cursor } : { state: 'exhausted' };
}

function exactScopeValue(values, expected, label) {
  const present = values.filter((value) => value !== undefined && value !== null && value !== '');
  if (present.some((value) => typeof value !== 'string' || !value.trim())) {
    throw providerError('validation', label + ' scope identity is invalid.');
  }
  const unique = [...new Set(present.map((value) => value.trim()))];
  if (unique.length === 0) return;
  if (unique.length > 1 || unique[0] !== expected) {
    throw providerError('conflict', label + ' did not match the exact requested scope identity.');
  }
}

function assertResponseScope(payload, input, label, { conversation = false } = {}) {
  exactScopeValue([
    payload.team_id,
    payload.teamId,
    payload.workspace_id,
    payload.workspaceId,
    typeof payload.team === 'string' ? payload.team : undefined,
    typeof payload.workspace === 'string' ? payload.workspace : undefined,
    payload.team?.id,
    payload.team?.team_id,
    payload.workspace?.id,
    payload.workspace?.team_id
  ], input.workspaceId, label + ' workspace');
  if (conversation) {
    exactScopeValue([
      payload.channel_id,
      payload.channelId,
      payload.conversation_id,
      payload.conversationId,
      typeof payload.channel === 'string' ? payload.channel : undefined,
      typeof payload.conversation === 'string' ? payload.conversation : undefined,
      payload.channel?.id,
      payload.channel?.channel_id,
      payload.conversation?.id,
      payload.conversation?.conversation_id
    ], input.conversationId, label + ' conversation');
  }
}

function observedBefore(page) {
  if (page === undefined || page === null) return 0;
  for (const key of ['observedCountBefore', 'includedCountBefore', 'excludedCountBefore']) {
    if (!Number.isInteger(page[key]) || page[key] < 0) {
      throw providerError('validation', 'Slack pagination omitted exact prior-page coverage.');
    }
  }
  if (page.observedCountBefore !== page.includedCountBefore + page.excludedCountBefore) {
    throw providerError('conflict', 'Slack pagination prior-page coverage is inconsistent.');
  }
  return page.observedCountBefore;
}

function exactNativeLimit(capability, input, page) {
  const declaration = capability === 'communications.conversations.list'
    ? {
        maximum: input.mode === 'exact'
          ? input.maximumObservedConversations
          : input.maximumConversations,
        native: 100
      }
    : capability === 'communications.participants.read'
      ? { maximum: input.maximumParticipants, native: 30 }
      : capability === 'communications.messages.read' || capability === 'communications.thread.read'
        ? { maximum: input.maximumMessages, native: 100 }
        : null;
  if (!declaration || !Number.isInteger(declaration.maximum) || declaration.maximum < 1) {
    throw providerError('validation', 'Slack capability omitted its exact caller result bound.');
  }
  const remaining = declaration.maximum - observedBefore(page);
  if (remaining < 1) {
    throw providerError(
      'conflict',
      'Slack pagination cannot read beyond the exact caller observation allowance.'
    );
  }
  return Math.min(declaration.native, remaining);
}

function assertCursorExhausted(payload, label) {
  if (paginationContinuation(payload, label).state !== 'exhausted') {
    throw providerError(
      'validation',
      label + ' pagination is incomplete; partial provider windows cannot be normalized.'
    );
  }
}

function provenance(authority, capability, input, outputBasis) {
  return {
    provider: 'slack-mcp',
    authority,
    sourceKind: 'connected',
    sourceReferenceFingerprint: fingerprintJson({ capability, input, outputBasis })
  };
}

function conversationKind(record) {
  const declared = record.kind ?? record.type ?? record.conversation_type ?? record.conversationType;
  const map = new Map([
    ['public_channel', 'public-channel'],
    ['public-channel', 'public-channel'],
    ['channel', 'public-channel'],
    ['private_channel', 'private-channel'],
    ['private-channel', 'private-channel'],
    ['group', 'private-channel'],
    ['im', 'direct-message'],
    ['direct-message', 'direct-message'],
    ['mpim', 'group-direct-message'],
    ['group-direct-message', 'group-direct-message']
  ]);
  if (typeof declared === 'string' && map.has(declared)) return map.get(declared);
  if (record.is_im === true || record.isIm === true) return 'direct-message';
  if (record.is_mpim === true || record.isMpim === true) return 'group-direct-message';
  if (record.is_private === true || record.isPrivate === true) return 'private-channel';
  if (record.is_private === false || record.isPrivate === false) return 'public-channel';
  throw providerError('validation', 'Slack conversation kind is unavailable.');
}

function conversationProjection(workspaceId, record) {
  const providerConversationId = requiredString(
    record.id ?? record.channel_id ?? record.channelId,
    'Slack conversation identity'
  );
  const kind = conversationKind(record);
  const value = {
    providerConversationId,
    kind,
    name: optionalString(record.name ?? record.display_name ?? record.displayName, 'Slack conversation name'),
    visibility: kind === 'public-channel' ? 'public' : 'private',
    shared: record.is_shared === true || record.isShared === true
      || record.is_ext_shared === true || record.isExtShared === true,
    permalink: optionalString(record.permalink ?? record.url, 'Slack conversation permalink'),
    identityFingerprint: collaborationConversationIdentityFingerprint({
      platform: 'slack',
      providerWorkspaceId: workspaceId,
      providerConversationId
    }),
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  value.fingerprint = fingerprintJson(unsigned);
  return value;
}

function participantProjection(workspaceId, record) {
  const profile = record.profile && typeof record.profile === 'object' && !Array.isArray(record.profile)
    ? record.profile
    : {};
  const providerParticipantId = requiredString(
    record.id ?? record.user_id ?? record.userId,
    'Slack participant identity'
  );
  const value = {
    providerParticipantId,
    displayName: optionalString(
      record.display_name ?? record.displayName ?? profile.display_name ?? profile.displayName
        ?? record.real_name ?? record.realName ?? profile.real_name ?? profile.realName ?? record.name,
      'Slack participant display name'
    ),
    email: optionalString(record.email ?? profile.email, 'Slack participant email'),
    identityFingerprint: fingerprintJson({
      platform: 'slack',
      providerWorkspaceId: workspaceId,
      providerParticipantId
    }),
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  value.fingerprint = fingerprintJson(unsigned);
  return value;
}

function messageText(record) {
  const value = record.text ?? record.content ?? record.message;
  if (typeof value !== 'string') {
    throw providerError('validation', 'Slack message content normalization is unavailable.');
  }
  return value;
}

function observedReplyCount(record, { required = false } = {}) {
  const values = ['reply_count', 'replyCount']
    .filter((key) => Object.hasOwn(record, key))
    .map((key) => record[key]);
  if (values.length === 0) {
    if (required) {
      throw providerError('validation', 'Slack message omitted its exact observed reply count.');
    }
    return null;
  }
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw providerError('validation', 'Slack message reply count must be a non-negative integer.');
  }
  if (new Set(values).size > 1) {
    throw providerError('conflict', 'Slack message returned conflicting reply counts.');
  }
  return values[0];
}

function messageProjection(record, { requireReplyCount = false } = {}) {
  const providerMessageId = requiredString(
    record.ts ?? record.id ?? record.message_ts ?? record.messageTs,
    'Slack message identity'
  );
  const content = messageText(record);
  const threadTs = optionalString(record.thread_ts ?? record.threadTs, 'Slack thread root identity');
  const value = {
    providerMessageId,
    authorParticipantId: optionalString(
      record.user ?? record.user_id ?? record.userId ?? record.bot_id ?? record.botId,
      'Slack message author identity'
    ),
    sentAt: instantFromSlackTimestamp(record.ts ?? record.sent_at ?? record.sentAt, 'Slack message timestamp'),
    threadRootMessageId: threadTs && threadTs !== providerMessageId ? threadTs : null,
    replyCount: observedReplyCount(record, { required: requireReplyCount }),
    content,
    contentFingerprint: fingerprintJson(content),
    fingerprint: 'sha256:' + '0'.repeat(64)
  };
  const unsigned = structuredClone(value);
  delete unsigned.fingerprint;
  value.fingerprint = fingerprintJson(unsigned);
  return value;
}

function conversationTypes(kinds) {
  const map = {
    'public-channel': 'public_channel',
    'private-channel': 'private_channel',
    'direct-message': 'im',
    'group-direct-message': 'mpim'
  };
  return kinds.map((kind) => map[kind]);
}

function pageCursor(continuation, page) {
  const sequence = page?.sequence ?? 1;
  if (sequence === 1) {
    if (continuation !== undefined && continuation !== null) {
      throw providerError('conflict', 'Slack first page cannot accept a continuation cursor.');
    }
    return null;
  }
  if (!continuation || typeof continuation.cursor !== 'string' || !continuation.cursor) {
    throw providerError('validation', 'Slack continued page requires the exact private cursor.');
  }
  return continuation.cursor;
}

function withCursor(argumentsValue, cursor) {
  return cursor ? { ...argumentsValue, cursor } : argumentsValue;
}

export function prepareMcp({
  capability,
  input,
  settings,
  continuation = null,
  page = null
}) {
  assertConfiguredWorkspace(settings, input);
  const cursor = pageCursor(continuation, page);
  const limit = exactNativeLimit(capability, input, page);
  if (capability === 'communications.conversations.list') {
    const kinds = input.mode === 'visible'
      ? input.kinds
      : ['public-channel', 'private-channel', 'direct-message', 'group-direct-message'];
    return {
      tool: 'list_user_conversations',
      arguments: withCursor({
        team_id: requiredString(input.workspaceId, 'Slack workspace identity'),
        types: conversationTypes(kinds),
        exclude_archived: true,
        query: input.mode === 'visible' ? (input.nameContains ?? null) : null,
        limit
      }, cursor)
    };
  }
  if (capability === 'communications.participants.read') {
    if (input.excludeBots !== true) {
      throw providerError('authorization', 'Slack participant reads must exclude bots.');
    }
    return {
      tool: 'list_channel_members',
      arguments: withCursor({
        channel_id: requiredString(input.conversationId, 'Slack conversation identity'),
        include_bots: false,
        include_deleted: false,
        limit,
        response_format: 'detailed'
      }, cursor)
    };
  }
  if (capability === 'communications.messages.read') {
    if (input.includeThreadReplies !== false) {
      throw providerError('authorization', 'Slack conversation-window reads must exclude thread replies.');
    }
    return {
      tool: 'read_channel',
      arguments: withCursor({
        channel_id: requiredString(input.conversationId, 'Slack conversation identity'),
        oldest: slackTimestamp(input.oldestInclusive, 'Slack message oldestInclusive'),
        latest: slackTimestamp(input.latestExclusive, 'Slack message latestExclusive'),
        limit,
        response_format: 'detailed'
      }, cursor)
    };
  }
  if (capability === 'communications.thread.read') {
    if (input.selectionMode !== 'explicit-root') {
      throw providerError('authorization', 'Slack thread reads require one explicit root selection.');
    }
    return {
      tool: 'read_thread',
      arguments: withCursor({
        channel_id: requiredString(input.conversationId, 'Slack conversation identity'),
        message_ts: requiredString(input.rootMessageId, 'Slack thread root identity'),
        limit,
        response_format: 'detailed'
      }, cursor)
    };
  }
  throw providerError('validation', 'Slack MCP adapter does not implement ' + capability + '.');
}

export function completeMcp({
  capability,
  input,
  authority,
  settings,
  responseProfile,
  response,
  at
}) {
  assertConfiguredWorkspace(settings, input);
  const payload = responsePayload({
    response,
    label: 'Slack ' + capability,
    responseProfile,
    capability
  });
  assertCursorExhausted(payload, 'Slack ' + capability);

  if (capability === 'communications.conversations.list') {
    assertResponseScope(payload, input, 'Slack conversation list');
    const records = oneRecordArray(payload, ['conversations', 'channels', 'results'], 'Slack conversation list');
    const observationMaximum = input.mode === 'exact'
      ? input.maximumObservedConversations
      : input.maximumConversations;
    if (records.length > observationMaximum) {
      throw providerError('validation', 'Slack conversation list exceeded the exact observation bound.');
    }
    const all = records.map((record) => conversationProjection(input.workspaceId, record));
    if (new Set(all.map((record) => record.providerConversationId)).size !== all.length) {
      throw providerError('conflict', 'Slack conversation list returned a duplicate identity.');
    }
    let conversations;
    if (input.mode === 'exact') {
      const requested = new Set(input.conversationIds);
      conversations = all.filter((record) => requested.has(record.providerConversationId));
      if (conversations.length !== requested.size
        || conversations.length > input.maximumConversations) {
        throw providerError('not-found', 'Slack conversation list omitted one or more exact requested identities.');
      }
    } else {
      const kinds = new Set(input.kinds);
      const needle = input.nameContains?.toLowerCase() || null;
      conversations = all.filter((record) => {
        return kinds.has(record.kind)
          && (!needle || (record.name ?? '').toLowerCase().includes(needle));
      });
    }
    conversations.sort((left, right) => compareCodepoint(left.providerConversationId, right.providerConversationId));
    const workspaceName = optionalString(
      payload.workspace?.name ?? payload.team?.name ?? payload.workspace_name ?? payload.workspaceName,
      'Slack workspace display name'
    );
    return {
      workspace: {
        providerWorkspaceId: input.workspaceId,
        displayName: workspaceName,
        identityFingerprint: fingerprintJson({ platform: 'slack', providerWorkspaceId: input.workspaceId })
      },
      conversations,
      coverage: {
        complete: true,
        cursorExhausted: true,
        pagesRead: 1,
        observedCount: all.length,
        includedCount: conversations.length,
        excludedCount: all.length - conversations.length
      },
      provenance: provenance(authority, capability, input, conversations.map((record) => record.fingerprint)),
      observedAt: at
    };
  }

  if (capability === 'communications.participants.read') {
    assertResponseScope(payload, input, 'Slack participant read', { conversation: true });
    const records = oneRecordArray(payload, ['participants', 'members', 'users', 'results'], 'Slack participant read');
    const humans = records.filter((record) => {
      return record.is_bot !== true && record.isBot !== true && record.bot !== true
        && record.deleted !== true && record.is_deleted !== true && record.isDeleted !== true;
    });
    const excludedBotCount = records.length - humans.length;
    if (humans.length > input.maximumParticipants) {
      throw providerError('validation', 'Slack participant read exceeded the exact bound.');
    }
    const participants = humans
      .map((record) => participantProjection(input.workspaceId, record))
      .sort((left, right) => compareCodepoint(left.providerParticipantId, right.providerParticipantId));
    if (new Set(participants.map((record) => record.providerParticipantId)).size !== participants.length) {
      throw providerError('conflict', 'Slack participant read returned a duplicate identity.');
    }
    return {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      participants,
      coverage: {
        complete: true,
        cursorExhausted: true,
        pagesRead: 1,
        observedCount: records.length,
        includedHumanCount: participants.length,
        excludedBotCount
      },
      provenance: provenance(authority, capability, input, participants.map((record) => record.fingerprint)),
      observedAt: at
    };
  }

  if (capability === 'communications.messages.read') {
    assertResponseScope(payload, input, 'Slack message read', { conversation: true });
    const records = oneRecordArray(payload, ['messages', 'results'], 'Slack message read');
    if (records.length > input.maximumMessages) {
      throw providerError('validation', 'Slack message read exceeded the exact bound.');
    }
    const oldest = Date.parse(exactInstant(input.oldestInclusive, 'Slack message oldestInclusive'));
    const latest = Date.parse(exactInstant(input.latestExclusive, 'Slack message latestExclusive'));
    const messages = records.map((record) => {
      return messageProjection(record, { requireReplyCount: true });
    }).filter((message) => {
      const sentAt = Date.parse(message.sentAt);
      return sentAt >= oldest && sentAt < latest && message.threadRootMessageId === null;
    }).sort((left, right) => compareCodepoint(left.providerMessageId, right.providerMessageId));
    if (new Set(messages.map((message) => message.providerMessageId)).size !== messages.length) {
      throw providerError('conflict', 'Slack message read returned a duplicate message identity.');
    }
    if (messages.length !== records.length) {
      throw providerError('conflict', 'Slack message read returned an out-of-window or thread-reply record.');
    }
    return {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      window: {
        oldestInclusive: exactInstant(input.oldestInclusive, 'Slack message oldestInclusive'),
        latestExclusive: exactInstant(input.latestExclusive, 'Slack message latestExclusive')
      },
      messages,
      coverage: {
        complete: true,
        cursorExhausted: true,
        pagesRead: 1,
        observedCount: records.length,
        includedCount: messages.length
      },
      provenance: provenance(authority, capability, input, messages.map((message) => message.fingerprint)),
      observedAt: at
    };
  }

  if (capability === 'communications.thread.read') {
    if (input.selectionMode !== 'explicit-root') {
      throw providerError('authorization', 'Slack thread reads require one explicit root selection.');
    }
    assertResponseScope(payload, input, 'Slack thread read', { conversation: true });
    const records = oneRecordArray(payload, ['messages', 'replies', 'results'], 'Slack thread read', { allowEmpty: false });
    if (records.length > input.maximumMessages) {
      throw providerError('validation', 'Slack thread read exceeded the exact bound.');
    }
    const projected = records.map((record) => messageProjection(record));
    if (new Set(projected.map((message) => message.providerMessageId)).size !== projected.length) {
      throw providerError('conflict', 'Slack thread read returned a duplicate message identity.');
    }
    const roots = projected.filter((message) => message.providerMessageId === input.rootMessageId);
    if (roots.length !== 1) {
      throw providerError('not-found', 'Slack thread read did not return the exact root once.');
    }
    if (projected.some((message) => {
      return message.providerMessageId !== input.rootMessageId
        && message.threadRootMessageId !== input.rootMessageId;
    })) {
      throw providerError('conflict', 'Slack thread read returned a message outside the exact root.');
    }
    const messages = projected.map((message) => {
      const value = {
        providerMessageId: message.providerMessageId,
        authorParticipantId: message.authorParticipantId,
        sentAt: message.sentAt,
        isRoot: message.providerMessageId === input.rootMessageId,
        content: message.content,
        contentFingerprint: message.contentFingerprint,
        fingerprint: 'sha256:' + '0'.repeat(64)
      };
      const unsigned = structuredClone(value);
      delete unsigned.fingerprint;
      value.fingerprint = fingerprintJson(unsigned);
      return value;
    }).sort((left, right) => compareCodepoint(left.providerMessageId, right.providerMessageId));
    return {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      rootMessageId: input.rootMessageId,
      messages,
      coverage: {
        complete: true,
        cursorExhausted: true,
        pagesRead: 1,
        observedCount: records.length,
        includedCount: messages.length
      },
      provenance: provenance(authority, capability, input, messages.map((message) => message.fingerprint)),
      observedAt: at
    };
  }

  throw providerError('validation', 'Slack MCP adapter does not implement ' + capability + '.');
}

export function completeMcpPage({
  capability,
  input,
  settings,
  responseProfile,
  response,
  page = null
}) {
  assertConfiguredWorkspace(settings, input);
  const payload = responsePayload({
    response,
    label: 'Slack ' + capability,
    responseProfile,
    capability
  });
  const continuation = paginationContinuation(payload, 'Slack ' + capability);
  const limit = exactNativeLimit(capability, input, page);

  if (capability === 'communications.conversations.list') {
    assertResponseScope(payload, input, 'Slack conversation list');
    const records = oneRecordArray(payload, ['conversations', 'channels', 'results'], 'Slack conversation list');
    if (records.length > limit) {
      throw providerError('validation', 'Slack conversation page exceeded its exact remaining bound.');
    }
    const all = records.map((record) => conversationProjection(input.workspaceId, record));
    if (new Set(all.map((record) => record.providerConversationId)).size !== all.length) {
      throw providerError('conflict', 'Slack conversation page returned a duplicate identity.');
    }
    let conversations;
    if (input.mode === 'exact') {
      const requested = new Set(input.conversationIds);
      conversations = all.filter((record) => requested.has(record.providerConversationId));
    } else {
      const kinds = new Set(input.kinds);
      const needle = input.nameContains?.toLowerCase() || null;
      conversations = all.filter((record) => {
        return kinds.has(record.kind)
          && (!needle || (record.name ?? '').toLowerCase().includes(needle));
      });
    }
    return {
      page: {
        observedCount: all.length,
        includedCount: conversations.length,
        excludedCount: all.length - conversations.length,
        observedIdentityFingerprints: all.map((record) => record.identityFingerprint),
        data: {
          workspaceName: optionalString(
            payload.workspace?.name ?? payload.team?.name
              ?? payload.workspace_name ?? payload.workspaceName,
            'Slack workspace display name'
          ),
          conversations
        }
      },
      continuation
    };
  }

  if (capability === 'communications.participants.read') {
    assertResponseScope(payload, input, 'Slack participant read', { conversation: true });
    const records = oneRecordArray(payload, ['participants', 'members', 'users', 'results'], 'Slack participant read');
    if (records.length > limit) {
      throw providerError('validation', 'Slack participant page exceeded its exact remaining bound.');
    }
    const identities = records.map((record) => requiredString(
      record.id ?? record.user_id ?? record.userId,
      'Slack participant identity'
    ));
    if (new Set(identities).size !== identities.length) {
      throw providerError('conflict', 'Slack participant page returned a duplicate identity.');
    }
    const humans = records.filter((record) => {
      return record.is_bot !== true && record.isBot !== true && record.bot !== true
        && record.deleted !== true && record.is_deleted !== true && record.isDeleted !== true;
    });
    const participants = humans.map((record) => participantProjection(input.workspaceId, record));
    return {
      page: {
        observedCount: records.length,
        includedCount: participants.length,
        excludedCount: records.length - participants.length,
        observedIdentityFingerprints: identities.map((providerParticipantId) => fingerprintJson({
          platform: 'slack',
          providerWorkspaceId: input.workspaceId,
          providerParticipantId
        })),
        data: { participants }
      },
      continuation
    };
  }

  if (capability === 'communications.messages.read') {
    assertResponseScope(payload, input, 'Slack message read', { conversation: true });
    const records = oneRecordArray(payload, ['messages', 'results'], 'Slack message read');
    if (records.length > limit) {
      throw providerError('validation', 'Slack message page exceeded its exact remaining bound.');
    }
    const oldest = Date.parse(exactInstant(input.oldestInclusive, 'Slack message oldestInclusive'));
    const latest = Date.parse(exactInstant(input.latestExclusive, 'Slack message latestExclusive'));
    const messages = records.map((record) => {
      return messageProjection(record, { requireReplyCount: true });
    });
    if (new Set(messages.map((message) => message.providerMessageId)).size !== messages.length) {
      throw providerError('conflict', 'Slack message page returned a duplicate message identity.');
    }
    if (messages.some((message) => {
      const sentAt = Date.parse(message.sentAt);
      return sentAt < oldest || sentAt >= latest || message.threadRootMessageId !== null;
    })) {
      throw providerError('conflict', 'Slack message page returned an out-of-window or thread-reply record.');
    }
    return {
      page: {
        observedCount: messages.length,
        includedCount: messages.length,
        excludedCount: 0,
        observedIdentityFingerprints: messages.map((message) => fingerprintJson({
          platform: 'slack',
          providerWorkspaceId: input.workspaceId,
          providerConversationId: input.conversationId,
          providerMessageId: message.providerMessageId
        })),
        data: { messages }
      },
      continuation
    };
  }

  if (capability === 'communications.thread.read') {
    if (input.selectionMode !== 'explicit-root') {
      throw providerError('authorization', 'Slack thread reads require one explicit root selection.');
    }
    assertResponseScope(payload, input, 'Slack thread read', { conversation: true });
    const records = oneRecordArray(payload, ['messages', 'replies', 'results'], 'Slack thread read', { allowEmpty: false });
    if (records.length > limit) {
      throw providerError('validation', 'Slack thread page exceeded its exact remaining bound.');
    }
    const projected = records.map((record) => messageProjection(record));
    if (new Set(projected.map((message) => message.providerMessageId)).size !== projected.length) {
      throw providerError('conflict', 'Slack thread page returned a duplicate message identity.');
    }
    if (projected.some((message) => {
      return message.providerMessageId !== input.rootMessageId
        && message.threadRootMessageId !== input.rootMessageId;
    })) {
      throw providerError('conflict', 'Slack thread page returned a message outside the exact root.');
    }
    const messages = projected.map((message) => {
      const value = {
        providerMessageId: message.providerMessageId,
        authorParticipantId: message.authorParticipantId,
        sentAt: message.sentAt,
        isRoot: message.providerMessageId === input.rootMessageId,
        content: message.content,
        contentFingerprint: message.contentFingerprint,
        fingerprint: 'sha256:' + '0'.repeat(64)
      };
      const unsigned = structuredClone(value);
      delete unsigned.fingerprint;
      value.fingerprint = fingerprintJson(unsigned);
      return value;
    });
    return {
      page: {
        observedCount: messages.length,
        includedCount: messages.length,
        excludedCount: 0,
        observedIdentityFingerprints: messages.map((message) => fingerprintJson({
          platform: 'slack',
          providerWorkspaceId: input.workspaceId,
          providerConversationId: input.conversationId,
          providerMessageId: message.providerMessageId
        })),
        data: { messages }
      },
      continuation
    };
  }

  throw providerError('validation', 'Slack MCP adapter does not implement ' + capability + '.');
}

function exactCoverage(pages, coverage) {
  if (!Array.isArray(pages) || pages.length < 1
    || !coverage || coverage.complete !== true || coverage.cursorExhausted !== true
    || coverage.pagesRead !== pages.length) {
    throw providerError('validation', 'Slack pagination finalizer requires exact exhausted coverage.');
  }
  return coverage;
}

function uniqueBy(items, key, label) {
  if (new Set(items.map((item) => item[key])).size !== items.length) {
    throw providerError('conflict', label + ' contains a duplicate identity across pages.');
  }
  return items;
}

export function finalizeMcpPages({
  capability,
  input,
  authority,
  settings,
  pages,
  coverage,
  at
}) {
  assertConfiguredWorkspace(settings, input);
  exactCoverage(pages, coverage);
  const pageFingerprints = pages.map((item) => item.pageFingerprint);

  if (capability === 'communications.conversations.list') {
    const conversations = uniqueBy(
      pages.flatMap((item) => item.page.data.conversations),
      'providerConversationId',
      'Slack conversation aggregate'
    ).sort((left, right) => compareCodepoint(left.providerConversationId, right.providerConversationId));
    if (conversations.length > input.maximumConversations) {
      throw providerError('validation', 'Slack conversation aggregate exceeded the exact result bound.');
    }
    if (input.mode === 'exact') {
      const requested = new Set(input.conversationIds);
      if (conversations.length !== requested.size
        || conversations.some((conversation) => !requested.has(conversation.providerConversationId))) {
        throw providerError('not-found', 'Slack conversation aggregate omitted one or more exact requested identities.');
      }
    }
    const workspaceNames = [...new Set(
      pages.map((item) => item.page.data.workspaceName).filter(Boolean)
    )];
    if (workspaceNames.length > 1) {
      throw providerError('conflict', 'Slack pagination changed workspace display identity between pages.');
    }
    return {
      workspace: {
        providerWorkspaceId: input.workspaceId,
        displayName: workspaceNames[0] ?? null,
        identityFingerprint: fingerprintJson({ platform: 'slack', providerWorkspaceId: input.workspaceId })
      },
      conversations,
      coverage: structuredClone(coverage),
      provenance: provenance(authority, capability, input, { pageFingerprints, coverage }),
      observedAt: at
    };
  }

  if (capability === 'communications.participants.read') {
    const participants = uniqueBy(
      pages.flatMap((item) => item.page.data.participants),
      'providerParticipantId',
      'Slack participant aggregate'
    ).sort((left, right) => compareCodepoint(left.providerParticipantId, right.providerParticipantId));
    if (participants.length > input.maximumParticipants) {
      throw providerError('validation', 'Slack participant aggregate exceeded the exact result bound.');
    }
    return {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      participants,
      coverage: {
        complete: true,
        cursorExhausted: true,
        pagesRead: coverage.pagesRead,
        observedCount: coverage.observedCount,
        includedHumanCount: coverage.includedCount,
        excludedBotCount: coverage.excludedCount
      },
      provenance: provenance(authority, capability, input, { pageFingerprints, coverage }),
      observedAt: at
    };
  }

  if (capability === 'communications.messages.read') {
    const messages = uniqueBy(
      pages.flatMap((item) => item.page.data.messages),
      'providerMessageId',
      'Slack message aggregate'
    ).sort((left, right) => compareCodepoint(left.providerMessageId, right.providerMessageId));
    if (messages.length > input.maximumMessages) {
      throw providerError('validation', 'Slack message aggregate exceeded the exact result bound.');
    }
    return {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      window: {
        oldestInclusive: exactInstant(input.oldestInclusive, 'Slack message oldestInclusive'),
        latestExclusive: exactInstant(input.latestExclusive, 'Slack message latestExclusive')
      },
      messages,
      coverage: {
        complete: true,
        cursorExhausted: true,
        pagesRead: coverage.pagesRead,
        observedCount: coverage.observedCount,
        includedCount: coverage.includedCount
      },
      provenance: provenance(authority, capability, input, { pageFingerprints, coverage }),
      observedAt: at
    };
  }

  if (capability === 'communications.thread.read') {
    const messages = uniqueBy(
      pages.flatMap((item) => item.page.data.messages),
      'providerMessageId',
      'Slack thread aggregate'
    ).sort((left, right) => compareCodepoint(left.providerMessageId, right.providerMessageId));
    if (messages.length > input.maximumMessages) {
      throw providerError('validation', 'Slack thread aggregate exceeded the exact result bound.');
    }
    if (messages.filter((message) => message.isRoot).length !== 1) {
      throw providerError('not-found', 'Slack thread aggregate did not return the exact root once.');
    }
    return {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      rootMessageId: input.rootMessageId,
      messages,
      coverage: {
        complete: true,
        cursorExhausted: true,
        pagesRead: coverage.pagesRead,
        observedCount: coverage.observedCount,
        includedCount: coverage.includedCount
      },
      provenance: provenance(authority, capability, input, { pageFingerprints, coverage }),
      observedAt: at
    };
  }

  throw providerError('validation', 'Slack MCP adapter does not implement ' + capability + '.');
}

export function prepareProbePlanMcp({ settings }) {
  const configured = configuredSlackSettings(settings);
  const workspaceId = configured.workspaceId;
  const steps = [{
    id: 'step.identity',
    kind: 'identity',
    subject: 'provider.identity',
    scope: {
      expectation: {
        cursorExhausted: true,
        minimumWorkspaceCount: 1,
        uniqueWorkspaceIdentities: true,
        configuredWorkspaceObserved: true,
        configuredWorkspaceFingerprint: fingerprintJson(workspaceId)
      }
    },
    tool: 'list_workspaces',
    arguments: {
      include_icon: false,
      limit: 50
    }
  }];
  if (!configured.readinessProbe) return { steps };

  const readiness = configured.readinessProbe;
  const definitions = [
    {
      id: 'step.messages-profile',
      capability: 'communications.messages.read',
      subject: 'communications.messages.read',
      input: {
        workspaceId,
        conversationId: readiness.conversationId,
        oldestInclusive: readiness.oldestInclusive,
        latestExclusive: readiness.latestExclusive,
        maximumMessages: 1,
        includeThreadReplies: false
      }
    },
    {
      id: 'step.thread-profile',
      capability: 'communications.thread.read',
      subject: 'communications.thread.read',
      input: {
        selectionMode: 'explicit-root',
        workspaceId,
        conversationId: readiness.conversationId,
        rootMessageId: readiness.threadRootMessageId,
        maximumMessages: 1
      }
    }
  ];
  for (const definition of definitions) {
    const prepared = prepareMcp({
      capability: definition.capability,
      input: definition.input,
      settings
    });
    steps.push({
      id: definition.id,
      kind: 'schema',
      subject: definition.subject,
      scope: {
        expectation: {
          cursorExhausted: true,
          usableRecordCount: 1,
          subjectFingerprint: fingerprintJson({
            capability: definition.capability,
            input: definition.input
          })
        }
      },
      tool: prepared.tool,
      arguments: prepared.arguments
    });
  }
  return {
    steps
  };
}

function readinessStepDefinition(stepId, settings) {
  const configured = configuredSlackSettings(settings);
  const readiness = configured.readinessProbe;
  if (!readiness) return null;
  if (stepId === 'step.messages-profile') {
    return {
      capability: 'communications.messages.read',
      input: {
        workspaceId: configured.workspaceId,
        conversationId: readiness.conversationId,
        oldestInclusive: readiness.oldestInclusive,
        latestExclusive: readiness.latestExclusive,
        maximumMessages: 1,
        includeThreadReplies: false
      },
      records(page) {
        const records = page.page.data.messages;
        if (records.length !== 1) {
          throw providerError(
            'not-found',
            'Slack readiness message profile did not return one usable record.'
          );
        }
        return [{
          authorPresent: records[0].authorParticipantId !== null,
          replyCountPresent: records[0].replyCount !== null,
          threadRootPresent: records[0].threadRootMessageId !== null,
          contentPresent: typeof records[0].content === 'string'
        }];
      }
    };
  }
  if (stepId === 'step.thread-profile') {
    return {
      capability: 'communications.thread.read',
      input: {
        selectionMode: 'explicit-root',
        workspaceId: configured.workspaceId,
        conversationId: readiness.conversationId,
        rootMessageId: readiness.threadRootMessageId,
        maximumMessages: 1
      },
      records(page) {
        const records = page.page.data.messages;
        if (records.length !== 1 || records[0].isRoot !== true) {
          throw providerError(
            'not-found',
            'Slack readiness thread profile did not return its exact root subject.'
          );
        }
        return [{
          isRoot: true,
          authorPresent: records[0].authorParticipantId !== null,
          contentPresent: typeof records[0].content === 'string'
        }];
      }
    };
  }
  return null;
}

export function completeProbePlanStepMcp({
  step,
  settings,
  responseProfile,
  response
}) {
  if (step?.id !== 'step.identity') {
    const definition = readinessStepDefinition(step?.id, settings);
    if (!definition
      || step.kind !== 'schema'
      || step.subject !== definition.capability
      || step.scope?.expectation?.subjectFingerprint !== fingerprintJson({
        capability: definition.capability,
        input: definition.input
      })) {
      throw providerError('validation', 'Slack provider probe received an unsupported step.');
    }
    const page = completeMcpPage({
      capability: definition.capability,
      input: definition.input,
      settings,
      responseProfile,
      response
    });
    if (page.continuation.state !== 'exhausted') {
      throw providerError(
        'validation',
        'Slack readiness response profile pagination is incomplete.'
      );
    }
    const records = definition.records(page);
    if (page.page.observedCount !== 1
      || page.page.includedCount !== 1
      || page.page.excludedCount !== 0
      || records.length !== 1) {
      throw providerError(
        'validation',
        'Slack readiness response profile requires one exact usable record.'
      );
    }
    const shapeFingerprint = fingerprintJson({
      capability: definition.capability,
      records
    });
    const expectedFingerprint = fingerprintJson(step.scope.expectation);
    return {
      cursorExhausted: true,
      recordCount: 1,
      usableRecordCount: 1,
      shapeFingerprint,
      expectedFingerprint,
      observedFingerprint: fingerprintJson({
        cursorExhausted: true,
        recordCount: 1,
        usableRecordCount: 1,
        shapeFingerprint,
        subjectFingerprint: step.scope.expectation.subjectFingerprint
      })
    };
  }
  if (step.kind !== 'identity' || step.subject !== 'provider.identity') {
    throw providerError('validation', 'Slack provider probe received an unsupported step.');
  }
  const payload = responsePayload({
    response,
    label: 'Slack workspace list',
    responseProfile,
    capability: 'list_workspaces'
  });
  assertCursorExhausted(payload, 'Slack workspace list');
  const records = oneRecordArray(payload, ['workspaces', 'teams', 'results'], 'Slack workspace list', { allowEmpty: false });
  const identities = records.map((record) => requiredString(
    record.id ?? record.team_id ?? record.teamId,
    'Slack workspace identity'
  ));
  if (new Set(identities).size !== identities.length) {
    throw providerError('conflict', 'Slack workspace list returned duplicate identities.');
  }
  const workspaceId = configuredWorkspaceId(settings);
  if (step.scope.expectation?.configuredWorkspaceFingerprint !== fingerprintJson(workspaceId)
    || !identities.includes(workspaceId)) {
    throw providerError(
      'not-found',
      'Slack workspace list did not contain the exact configured workspace.'
    );
  }
  return {
    cursorExhausted: true,
    workspaceCount: identities.length,
    uniqueWorkspaceIdentities: true,
    configuredWorkspaceObserved: true,
    configuredWorkspaceFingerprint: fingerprintJson(workspaceId),
    expectedFingerprint: fingerprintJson(step.scope.expectation),
    observedFingerprint: fingerprintJson({
      cursorExhausted: true,
      minimumWorkspaceCountSatisfied: identities.length >= 1,
      uniqueWorkspaceIdentities: true,
      configuredWorkspaceObserved: true,
      configuredWorkspaceFingerprint: fingerprintJson(workspaceId)
    })
  };
}

export function finalizeProbePlanMcp({ plan, steps, results, settings }) {
  const workspaceId = configuredWorkspaceId(settings);
  const expectedSteps = prepareProbePlanMcp({ settings }).steps;
  if (!Array.isArray(steps)
    || !Array.isArray(results)
    || steps.length !== expectedSteps.length
    || results.length !== expectedSteps.length
    || steps.some((step, index) => {
      const expected = expectedSteps[index];
      return step.id !== expected.id
        || step.kind !== expected.kind
        || step.subject !== expected.subject
        || fingerprintJson(step.scope?.expectation)
          !== fingerprintJson(expected.scope.expectation)
        || results[index]?.stepId !== step.id;
    })) {
    throw providerError('validation', 'Slack provider probe is missing its exact minimized identity result.');
  }
  const step = steps[0];
  const observed = results[0];
  if (!observed.result?.cursorExhausted
    || !observed.result?.uniqueWorkspaceIdentities
    || observed.result?.configuredWorkspaceObserved !== true
    || observed.result?.configuredWorkspaceFingerprint !== fingerprintJson(workspaceId)
    || !Number.isInteger(observed.result.workspaceCount)
    || observed.result.workspaceCount < 1
    || observed.result.expectedFingerprint !== fingerprintJson(step.scope.expectation)
    || typeof observed.result.observedFingerprint !== 'string') {
    throw providerError('validation', 'Slack provider probe is missing its exact minimized identity result.');
  }
  for (let index = 1; index < steps.length; index += 1) {
    const item = results[index].result;
    if (item?.cursorExhausted !== true
      || item.recordCount !== 1
      || item.usableRecordCount !== 1
      || typeof item.shapeFingerprint !== 'string'
      || item.expectedFingerprint !== fingerprintJson(steps[index].scope.expectation)
      || typeof item.observedFingerprint !== 'string') {
      throw providerError(
        'validation',
        'Slack provider probe is missing one exact minimized response-shape result.'
      );
    }
  }
  return {
    credentials: plan.credentialRefs.map((secretRefId) => ({
      secretRefId,
      state: 'passed',
      details: 'The host-authenticated Slack workspace-list endpoint returned a cursor-exhausted structured result.'
    })),
    reachability: {
      state: 'passed',
      details: 'The host reached Slack workspace listing and received a structured result.'
    },
    authorities: plan.authorities.map((id) => ({
      id,
      state: 'passed',
      details: 'The exact configured Slack workspace identity was observed in the cursor-exhausted private workspace-list result.'
    })),
    capabilities: plan.capabilities.map((id) => ({
      id,
      state: 'unknown',
      method: 'metadata',
      details: 'Private bounded response-shape observations do not establish portable capability compatibility.'
    })),
    checks: steps.map((item, index) => ({
      id: index === 0 ? 'check.identity' : 'check.' + item.id.slice('step.'.length),
      stepId: item.id,
      kind: item.kind,
      subject: item.subject,
      scopeFingerprint: item.scopeFingerprint,
      state: 'passed',
      method: 'metadata',
      expectedFingerprint: results[index].result.expectedFingerprint,
      observedFingerprint: results[index].result.observedFingerprint,
      details: index === 0
        ? 'The host-authenticated Slack workspace-list response matched the minimized cursor-exhausted identity contract.'
        : 'One exact bounded Slack response matched its minimized cursor-exhausted shape contract.'
    })),
    limitations: [
      'This probe establishes authentication, endpoint reachability, and optional bounded response shapes only; every portable capability remains unknown.',
      'Slack Conversation Review remains unavailable with CLOSED_MESSAGE_THREAD_RESPONSE_UNAVAILABLE.',
      'Workspace, conversation, message, thread, content, cursor, native argument, and raw response values are excluded from the finalized probe.'
    ]
  };
}
