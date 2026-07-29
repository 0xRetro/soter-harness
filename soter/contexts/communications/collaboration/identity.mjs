import { fingerprintJson } from '../../../core/lib/canonical-json.mjs';

function requireIdentityPart(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(name + ' must be a non-empty string');
  }
  return value.trim();
}

export function normalizeCollaborationPlatform(platform) {
  const normalized = requireIdentityPart(platform, 'platform').toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error('platform must be a portable lowercase identifier');
  }
  return normalized;
}

export function collaborationConversationIdentityBasis({
  platform,
  providerWorkspaceId,
  providerConversationId
}) {
  return {
    platform: normalizeCollaborationPlatform(platform),
    providerWorkspaceId: requireIdentityPart(providerWorkspaceId, 'providerWorkspaceId'),
    providerConversationId: requireIdentityPart(providerConversationId, 'providerConversationId')
  };
}

export function collaborationConversationIdentityFingerprint(identity) {
  return fingerprintJson(collaborationConversationIdentityBasis(identity));
}
