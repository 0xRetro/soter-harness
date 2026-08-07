export function activeMailMessages(thread, exactMessageIds = null) {
  if (!thread || !Array.isArray(thread.messages)) {
    throw new Error('Email reduction requires a typed message array for every thread.');
  }
  if (exactMessageIds !== null && !(exactMessageIds instanceof Set)) {
    throw new Error('Email reduction exact window must be one message-identity set.');
  }
  return thread.messages.filter((message) => {
    return (exactMessageIds === null || exactMessageIds.has(message.id))
      && Array.isArray(message.labels)
      && message.labels.includes('INBOX')
      && !message.labels.includes('TRASH')
      && !message.labels.includes('ARCHIVED');
  }).sort((left, right) => {
    return left.sentAt.localeCompare(right.sentAt, 'en')
      || left.id.localeCompare(right.id, 'en');
  });
}

export function reduceMailThreads({
  threads,
  selfAddresses,
  triagedLabel,
  exactMessageIds = null
}) {
  if (!Array.isArray(threads)
    || !Array.isArray(selfAddresses)
    || selfAddresses.length < 1
    || typeof triagedLabel !== 'string'
    || !triagedLabel.startsWith('AI/')) {
    throw new Error('Email reduction requires bounded threads, self identities, and one AI triage label.');
  }
  const exactWindow = exactMessageIds === null
    ? null
    : new Set(exactMessageIds);
  if (exactMessageIds !== null
    && (!Array.isArray(exactMessageIds)
      || exactMessageIds.length < 1
      || exactWindow.size !== exactMessageIds.length
      || exactMessageIds.some((id) => typeof id !== 'string' || !id))) {
    throw new Error('Email reduction exact window must contain unique message identities.');
  }
  const self = new Set(selfAddresses.map((address) => address.toLowerCase()));
  const exclusions = new Map([
    ['NO_ACTIVE_INBOX_MESSAGE_REMOVED', 0],
    ['RFC822_ALIAS_DUPLICATE_REMOVED', 0],
    ['SELF_SENT_ONLY_REMOVED', 0],
    ['ALREADY_TRIAGED_NO_NEWER_REMOVED', 0]
  ]);
  const candidates = [];
  for (const thread of [...threads].sort((left, right) => {
    return left.id.localeCompare(right.id, 'en');
  })) {
    const active = activeMailMessages(thread, exactWindow);
    if (!active.length) {
      exclusions.set(
        'NO_ACTIVE_INBOX_MESSAGE_REMOVED',
        exclusions.get('NO_ACTIVE_INBOX_MESSAGE_REMOVED') + 1
      );
      continue;
    }
    if (active.every((message) => self.has(message.from.toLowerCase()))) {
      exclusions.set('SELF_SENT_ONLY_REMOVED', exclusions.get('SELF_SENT_ONLY_REMOVED') + 1);
      continue;
    }
    if (active.every((message) => message.labels.includes(triagedLabel))) {
      exclusions.set(
        'ALREADY_TRIAGED_NO_NEWER_REMOVED',
        exclusions.get('ALREADY_TRIAGED_NO_NEWER_REMOVED') + 1
      );
      continue;
    }
    candidates.push({
      thread,
      active,
      message: active.at(-1),
      archivedSiblingIgnored: thread.messages.some((message) => {
        return message.labels.includes('TRASH') || message.labels.includes('ARCHIVED');
      })
    });
  }
  const seenMessageIds = new Set();
  const included = [];
  for (const candidate of candidates) {
    if (seenMessageIds.has(candidate.message.rfc822MessageId)) {
      exclusions.set(
        'RFC822_ALIAS_DUPLICATE_REMOVED',
        exclusions.get('RFC822_ALIAS_DUPLICATE_REMOVED') + 1
      );
      continue;
    }
    seenMessageIds.add(candidate.message.rfc822MessageId);
    included.push(candidate);
  }
  return {
    included,
    exclusions: [...exclusions].map(([reasonCode, count]) => ({ reasonCode, count }))
  };
}
