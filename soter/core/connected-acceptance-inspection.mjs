import path from 'node:path';

import { validateJsonSchema } from '../kernel/verify.mjs';
import { fingerprintJson, readJson } from './lib/canonical-json.mjs';
import { inspectWorkspace } from './inspection.mjs';
import { inspectConnectedOperatorActivity } from './operator-inspection.mjs';

const CONTRACT = 'soter://contracts/connected-acceptance-inspection/v1';
const SCHEMA_PATH = 'soter/contracts/connected-acceptance-inspection.schema.json';
const CLAIM_BOUNDARY = 'This projection composes existing sanitized observations only; it does not run connected acceptance, grant authority, or establish readiness, verification, or health.';

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactInstant(value) {
  const parsed = Date.parse(value);
  return typeof value === 'string'
    && Number.isFinite(parsed)
    && new Date(parsed).toISOString() === value;
}

function inspectionFingerprint(inspection) {
  const unsigned = structuredClone(inspection);
  delete unsigned.inspectionFingerprint;
  return fingerprintJson(unsigned);
}

function assertInspection(root, inspection) {
  const schema = readJson(path.join(root, SCHEMA_PATH));
  const failures = validateJsonSchema(inspection, schema);
  if (failures.length) {
    throw new Error(
      'Connected acceptance inspection does not satisfy its contract: '
        + failures.slice(0, 8).map((item) => item.path + ' ' + item.message).join('; ')
    );
  }
  if (inspection.inspectionFingerprint !== inspectionFingerprint(inspection)) {
    throw new Error('Connected acceptance inspection fingerprint is stale.');
  }
  return inspection;
}

function projectSlackAvailability(workspace) {
  const workflows = workspace.workflows.filter((item) => {
    return item.id === 'automation.slack-conversation-review';
  });
  if (workflows.length !== 1) {
    throw new Error('Connected acceptance inspection requires one Slack Conversation Review workflow.');
  }
  const modes = workflows[0].operator?.preparation?.modes?.filter((item) => {
    return item.id === 'connected-acquisition';
  }) || [];
  if (modes.length !== 1) {
    throw new Error('Connected acceptance inspection requires one Slack connected-acquisition mode.');
  }
  if (modes[0].availability.state === 'unavailable') {
    return {
      state: 'unavailable',
      reasonCode: modes[0].availability.reasonCode,
      reason: modes[0].availability.reason
    };
  }
  return {
    state: 'not-evaluated',
    reasonCode: 'SLACK_CONNECTED_ACCEPTANCE_NOT_EVALUATED',
    reason: 'Slack connected acquisition is declared available, but this inspection received no exact sanitized acceptance observation.'
  };
}

function projectTransaction(inspection) {
  if (!inspection.checkpoint) {
    throw new Error('Connected acceptance inspection requires an exact transaction checkpoint.');
  }
  return {
    host: inspection.configuration.host,
    checkpoint: structuredClone(inspection.checkpoint),
    automationId: inspection.activity.automationId,
    workId: inspection.activity.workId,
    workState: inspection.activity.workState,
    phase: inspection.activity.phase,
    configuration: {
      name: inspection.configuration.name,
      lockFingerprint: inspection.configuration.lockFingerprint,
      graphFingerprint: inspection.configuration.graphFingerprint,
      applicability: inspection.configuration.applicability.state,
      reasonCode: inspection.configuration.applicability.reasonCode
    },
    approval: {
      state: inspection.approval.state,
      reasonCode: inspection.approval.reasonCode
    },
    verification: {
      state: inspection.verification.state,
      observedFingerprint: inspection.verification.observedFingerprint
    },
    resume: {
      classification: inspection.resume.classification,
      reasonCode: inspection.resume.reasonCode,
      permittedNextAction: inspection.resume.permittedNextAction
    },
    blockerReasonCodes: [...new Set(
      inspection.blockers.map((blocker) => blocker.reasonCode)
    )].sort(compareText)
  };
}

export function composeConnectedAcceptanceInspection({
  root,
  generatedAt,
  slackConversationReview,
  operatorInspections = []
}) {
  const resolvedRoot = path.resolve(root);
  if (!exactInstant(generatedAt)
    || !slackConversationReview
    || typeof slackConversationReview !== 'object'
    || !Array.isArray(operatorInspections)) {
    throw new TypeError('Connected acceptance inspection requires an exact time and sanitized observations.');
  }
  const observations = operatorInspections.map(projectTransaction).sort((left, right) => {
    return compareText(left.host, right.host)
      || compareText(left.checkpoint.id, right.checkpoint.id);
  });
  if (new Set(observations.map((item) => item.checkpoint.id)).size !== observations.length) {
    throw new Error('Connected acceptance inspection received a duplicate checkpoint identity.');
  }
  const inspection = {
    $contract: CONTRACT,
    contractVersion: '1.0.0',
    generatedAt,
    slackConversationReview: structuredClone(slackConversationReview),
    transactions: observations.length
      ? {
          state: 'observed',
          reasonCode: 'CONNECTED_TRANSACTION_CHECKPOINTS_INSPECTED',
          observations
        }
      : {
          state: 'not-evaluated',
          reasonCode: 'CONNECTED_TRANSACTION_CHECKPOINT_NOT_SUPPLIED',
          observations: []
        },
    authority: {
      grants: 'none',
      providerCallsPermitted: false,
      writesPermitted: false,
      approvalAuthorityIncluded: false,
      continuationAuthorityIncluded: false
    },
    privacy: {
      rawProviderResponseIncluded: false,
      messageContentIncluded: false,
      credentialValuesIncluded: false,
      privateInputsIncluded: false,
      privateStateIncluded: false,
      localPathsIncluded: false
    },
    claims: {
      acceptance: 'not-evaluated',
      ready: 'unknown',
      verified: 'unknown',
      healthy: 'unknown'
    },
    claimBoundary: CLAIM_BOUNDARY,
    inspectionFingerprint: fingerprintJson(null)
  };
  inspection.inspectionFingerprint = inspectionFingerprint(inspection);
  return assertInspection(resolvedRoot, inspection);
}

export function inspectConnectedAcceptance({
  root,
  checkpointIds = [],
  generatedAt = new Date().toISOString(),
  ...unknown
} = {}) {
  if (Object.keys(unknown).length
    || !Array.isArray(checkpointIds)
    || checkpointIds.some((id) => typeof id !== 'string' || !id.trim())
    || new Set(checkpointIds).size !== checkpointIds.length) {
    throw new TypeError('Connected acceptance inspection requires unique exact checkpoint IDs.');
  }
  const resolvedRoot = path.resolve(root);
  const workspace = inspectWorkspace({ root: resolvedRoot });
  const operatorInspections = checkpointIds.map((checkpointId) => {
    return inspectConnectedOperatorActivity({
      root: resolvedRoot,
      checkpointId,
      observedAt: generatedAt
    });
  });
  return composeConnectedAcceptanceInspection({
    root: resolvedRoot,
    generatedAt,
    slackConversationReview: projectSlackAvailability(workspace),
    operatorInspections
  });
}
