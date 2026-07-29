import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  finalizeMeetingIntakeConnectedContext,
  prepareMeetingIntakeConnectedContext
} from '../../automations/meeting-intake/context.mjs';
import {
  finalizeEmailTriageConnectedAcquisition,
  prepareEmailTriageConnectedAcquisition
} from '../../automations/email-triage/context.mjs';
import {
  finalizeTaskCaptureConnectedAcquisition,
  prepareTaskCaptureConnectedAcquisition
} from '../../automations/task-capture/context.mjs';
import {
  finalizeOrganizationCaptureConnectedAcquisition,
  prepareOrganizationCaptureConnectedAcquisition
} from '../../automations/organization-capture/context.mjs';
import {
  finalizeProjectCaptureConnectedAcquisition,
  prepareProjectCaptureConnectedAcquisition
} from '../../automations/project-capture/context.mjs';
import {
  finalizeContactCaptureConnectedAcquisition,
  prepareContactCaptureConnectedAcquisition
} from '../../automations/contact-capture/context.mjs';
import {
  finalizeSlackConversationReviewConnectedAcquisition,
  inspectSlackConversationReviewConnected,
  inspectSlackConversationReviewConnectedPrivateReview,
  prepareSlackConversationReviewConnectedAcquisition
} from '../../automations/slack-conversation-review/context.mjs';
import {
  commitMeetingIntakeDecision,
  inspectMeetingIntakeDecisionContext
} from '../../automations/meeting-intake/decision.mjs';
import {
  commitEmailTriageDecision,
  inspectEmailTriageDecisionContext
} from '../../automations/email-triage/decision.mjs';
import {
  commitTaskCaptureDecision,
  inspectTaskCaptureDecisionContext
} from '../../automations/task-capture/decision.mjs';
import {
  commitOrganizationCaptureDecision,
  inspectOrganizationCaptureDecisionContext
} from '../../automations/organization-capture/decision.mjs';
import {
  commitProjectCaptureDecision,
  inspectProjectCaptureDecisionContext
} from '../../automations/project-capture/decision.mjs';
import {
  commitContactCaptureDecision,
  inspectContactCaptureDecisionContext
} from '../../automations/contact-capture/decision.mjs';
import {
  commitEmailTriageProposal,
  inspectEmailTriageProposalDecision,
  inspectEmailTriageProposalMaterial
} from '../../automations/email-triage/proposal.mjs';
import {
  commitTaskCaptureProposal,
  inspectTaskCaptureProposalDecision,
  inspectTaskCaptureProposalMaterial
} from '../../automations/task-capture/proposal.mjs';
import {
  commitOrganizationCaptureProposal,
  inspectOrganizationCaptureProposalDecision,
  inspectOrganizationCaptureProposalMaterial
} from '../../automations/organization-capture/proposal.mjs';
import {
  commitProjectCaptureProposal,
  inspectProjectCaptureProposalDecision,
  inspectProjectCaptureProposalMaterial
} from '../../automations/project-capture/proposal.mjs';
import {
  commitContactCaptureProposal,
  inspectContactCaptureProposalDecision,
  inspectContactCaptureProposalMaterial
} from '../../automations/contact-capture/proposal.mjs';
import {
  commitMeetingIntakeProposal,
  inspectMeetingIntakeProposalDecision,
  inspectMeetingIntakeProposalMaterial
} from '../../automations/meeting-intake/proposal.mjs';
import {
  completeDurableCapabilityExecution,
  completeDurableConnectedTransactionExecution,
  completeDurableOperationPlanExecution,
  completeDurableProviderProbeExecution,
  failDurableHostExecution,
  getDurableHostExecution,
  listDurableHostExecutions,
  prepareDurableConnectedTransactionReconciliation,
  prepareDurableProviderProbeExecution
} from '../service.mjs';
import {
  createHostRuntimeBasis,
  inspectHostRuntime
} from '../host-runtime-inspection.mjs';
import { prepareAutomationRun } from '../prepared-work.mjs';

const jsonObject = z.record(z.string(), z.unknown());
const resultSchema = { result: jsonObject };
const statefulAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};
const completionAnnotations = {
  ...statefulAnnotations,
  idempotentHint: true
};
const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

function result(value, summary) {
  const structuredContent = { result: value };
  return {
    content: [{ type: 'text', text: summary + '\n' + JSON.stringify(value, null, 2) }],
    structuredContent
  };
}

function staleRuntimeResult(inspection) {
  const message = 'The loaded Soter host runtime no longer matches the current governed behavior. Restart the host runtime before using operational tools.';
  const value = {
    code: inspection.runtime.reasonCode,
    message,
    inspection
  };
  return {
    isError: true,
    content: [{
      type: 'text',
      text: inspection.runtime.reasonCode + ': ' + message
    }],
    structuredContent: { result: value }
  };
}

export function createSoterMcpServer({ root, host }) {
  if (!host) throw new Error('Soter MCP server requires an active host identity.');
  const server = new McpServer(
    { name: 'soter-core', version: '0.1.0' },
    {
      instructions: [
        'Before operational work, use soter_inspect_host_runtime; if it reports SOTER_HOST_RUNTIME_STALE, restart the host runtime instead of retrying another Soter tool.',
        'Soter Core validates exact locks and runs for the active ' + host + ' host projection, then saves a private durable checkpoint before emitting a provider-neutral operation resolved to an exact native host tool.',
        'After compaction or restart, use soter_list_host_calls and soter_get_host_call to recover pending work.',
        'Use soter_stage_automation_acquisition to validate one exact private operator input and create the zero-effect prepared-work/run boundary before invoking an Automation-specific connected acquisition tool.',
        'Invoke exactly currentCall.transport.tool when currentCall is present; otherwise invoke checkpoint.call.transport.tool only for a checkpoint that still uses the v1 single-call contract.',
        'Return both checkpoint.id and currentCall.id for sequential plans and connected transactions because a successful completion may emit the next exact call.',
        'A needs-attention connected transaction may use soter_reconcile_connected_transaction to emit one exact read-only observation; reconciliation never retries a write and remains paused for missing or divergent state.',
        'Completed Meeting Intake, Email, Task Capture, Project Capture, Organization Capture, Contact Capture, and Slack conversation-review acquisition plans must be finalized through their exact finalizer before their private snapshots are used.',
        'Email acquisition records transport facts only and pauses before triage judgment, drafts, approval, or writes.',
        'Task Capture acquisition, Project Capture acquisition, Organization Capture acquisition, Contact Capture acquisition, and Meeting Intake acquisition each bind one current prepared-work item to exact connected context, then pause before decision, proposal, approval, or writes.',
        'Slack conversation-review acquisition reads complete exact selected message windows and only exact explicitly supplied thread references; its finalizer and ordinary inspection expose counts and fingerprints only.',
        'Use soter_inspect_slack_conversation_review_private only for an explicit selected-work private read; it exposes normalized private bodies but never provider envelopes, cursors, approval, continuation, retry, or write authority.',
        'Inspect or recover exact private decision workspaces with the matching decision inspection tool, then commit only the exact grounded decision; use needs-input rather than guessing whenever the domain adapter reports unresolved issues.',
        'Use soter_inspect_task_capture_decision and soter_commit_task_capture_decision for the Task Capture decision, then soter_inspect_task_capture_proposal, soter_commit_task_capture_proposal, and soter_inspect_task_capture_proposal_material for its review-only proposal.',
        'Use soter_inspect_organization_capture_decision and soter_commit_organization_capture_decision for the Organization Capture decision, then soter_inspect_organization_capture_proposal, soter_commit_organization_capture_proposal, and soter_inspect_organization_capture_proposal_material for its review-only proposal.',
        'Use soter_inspect_project_capture_decision and soter_commit_project_capture_decision for the Project Capture decision, then soter_inspect_project_capture_proposal, soter_commit_project_capture_proposal, and soter_inspect_project_capture_proposal_material for its review-only proposal.',
        'Use soter_inspect_contact_capture_decision and soter_commit_contact_capture_decision for the Contact Capture decision, then soter_inspect_contact_capture_proposal, soter_commit_contact_capture_proposal, and soter_inspect_contact_capture_proposal_material for its review-only proposal.',
        'Use soter_inspect_email_triage_decision and soter_commit_email_triage_decision for Email judgment, then soter_inspect_email_triage_proposal, soter_commit_email_triage_proposal, and soter_inspect_email_triage_proposal_material for its review-only proposal.',
        'Use soter_inspect_meeting_intake_decision and soter_commit_meeting_intake_decision for Meeting Intake judgment, then soter_inspect_meeting_intake_proposal, soter_commit_meeting_intake_proposal, and soter_inspect_meeting_intake_proposal_material for its review-only proposal.',
        'Those proposals create no approval, continuation, provider call, write, or send authority.',
        'Always pass requested provider arguments through the separately configured provider MCP route and return the native result unchanged. Never fabricate a provider response.',
        'Soter does not invoke providers or persist raw responses. MCP cannot originate or alter connected-write approval; it may only resume a transaction already authorized and checkpointed by the trusted CLI.'
      ].join(' ')
    }
  );
  const runtimeBasis = createHostRuntimeBasis({ root, host });
  const currentRuntimeInspection = () => inspectHostRuntime({ root, basis: runtimeBasis });
  const guard = (handler) => async (...args) => {
    const inspection = currentRuntimeInspection();
    if (inspection.runtime.state !== 'current') return staleRuntimeResult(inspection);
    return handler(...args);
  };
  const registerGuardedTool = (name, specification, handler) => {
    return server.registerTool(name, specification, guard(handler));
  };

  server.registerTool('soter_inspect_host_runtime', {
    title: 'Inspect Soter host runtime',
    description: 'Compare the loaded Soter MCP runtime with the current governed behavior inventory. This read-only inspection exposes no private state, grants no authority, and performs no provider call.',
    inputSchema: {},
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async () => {
    return result(
      currentRuntimeInspection(),
      'Inspected whether the loaded Soter host runtime matches the current governed behavior.'
    );
  });

  registerGuardedTool('soter_stage_automation_acquisition', {
    title: 'Stage Soter connected acquisition',
    description: 'Validate exact private operator input against one current private-active Automation lock and stage a zero-effect connected-acquisition run. This tool performs no provider call, creates no context snapshot or evidence, and grants no approval, continuation, readiness, or execution authority.',
    inputSchema: {
      automation_id: z.string().min(1),
      configuration_name: z.string().min(1),
      configuration_basis: z.literal('private-active'),
      input: jsonObject,
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const work = await prepareAutomationRun({
      root,
      automationId: input.automation_id,
      configurationName: input.configuration_name,
      configurationBasis: input.configuration_basis,
      preparationMode: 'connected-acquisition',
      expectedHost: host,
      input: input.input,
      createdAt: input.at
    });
    return result(
      work,
      'Staged exact private connected-acquisition input; no provider call or execution authority was created.'
    );
  });

  registerGuardedTool('soter_prepare_provider_probe', {
    title: 'Prepare Soter provider probe',
    description: 'Validate an exact configuration lock, durably checkpoint an explicit provider readiness plan, and emit at most its first minimized native host request. This tool does not call the provider.',
    inputSchema: {
      configuration_basis: z.literal('private-active'),
      lock_path: z.string().min(1),
      provider_implementation: z.string().min(1),
      probe_id: z.string().min(1).optional(),
      at: z.string().min(20).optional(),
      valid_for_seconds: z.number().int().min(60).max(900).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareDurableProviderProbeExecution({
      root,
      configurationBasis: input.configuration_basis,
      lockPath: input.lock_path,
      providerImplementation: input.provider_implementation,
      probeId: input.probe_id,
      at: input.at,
      validForSeconds: input.valid_for_seconds,
      expectedHost: host
    });
    return result(prepared, 'Durably checkpointed a Soter provider probe request; no provider call was executed.');
  });

  registerGuardedTool('soter_complete_provider_probe', {
    title: 'Complete Soter provider probe',
    description: 'Resume the exact provider probe call, validate and minimize the native result, and atomically emit the next explicit call or close the checkpoint without persisting the raw response.',
    inputSchema: {
      checkpoint_id: z.string().min(1),
      call_id: z.string().min(1),
      response: jsonObject,
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: completionAnnotations
  }, async (input) => {
    const completed = await completeDurableProviderProbeExecution({
      root,
      checkpointId: input.checkpoint_id,
      callId: input.call_id,
      response: input.response,
      at: input.at,
      expectedHost: host
    });
    return result(completed, 'Advanced the exact provider probe without persisting the native response.');
  });

  registerGuardedTool('soter_complete_capability_call', {
    title: 'Complete Soter capability call',
    description: 'Resume the exact current call of a durable capability checkpoint, validate one native result, and either emit the next checkpoint-bound page call or finalize normalized portable output without persisting the raw response or continuation cursor.',
    inputSchema: {
      checkpoint_id: z.string().min(1),
      call_id: z.string().min(1).optional(),
      response: jsonObject,
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: completionAnnotations
  }, async (input) => {
    const completed = await completeDurableCapabilityExecution({
      root,
      checkpointId: input.checkpoint_id,
      callId: input.call_id,
      response: input.response,
      at: input.at,
      expectedHost: host
    });
    return result(completed, 'Advanced the exact provider capability call without persisting the native response or exposing its continuation cursor.');
  });

  registerGuardedTool('soter_complete_operation_plan', {
    title: 'Advance Soter operation plan',
    description: 'Complete the exact current plan call, persist only normalized output, and atomically emit the next policy-bound call or close the plan.',
    inputSchema: {
      checkpoint_id: z.string().min(1),
      call_id: z.string().min(1),
      response: jsonObject,
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: completionAnnotations
  }, async (input) => {
    const completed = await completeDurableOperationPlanExecution({
      root,
      checkpointId: input.checkpoint_id,
      callId: input.call_id,
      response: input.response,
      at: input.at,
      expectedHost: host
    });
    return result(completed, 'Advanced the exact operation plan without persisting the native provider response.');
  });

  registerGuardedTool('soter_advance_connected_transaction', {
    title: 'Advance Soter connected transaction',
    description: 'Resume the exact current call of an already authorized private connected-transaction checkpoint, persist only normalized output, and emit the next precondition, write, verification, or read-only reconciliation call. This interface cannot accept, create, or modify approval.',
    inputSchema: {
      checkpoint_id: z.string().min(1),
      call_id: z.string().min(1),
      response: jsonObject,
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: completionAnnotations
  }, async (input) => {
    const completed = await completeDurableConnectedTransactionExecution({
      root,
      checkpointId: input.checkpoint_id,
      callId: input.call_id,
      response: input.response,
      at: input.at,
      expectedHost: host
    });
    return result(
      completed,
      'Advanced the exact approval-bound connected transaction without persisting the native provider response.'
    );
  });

  registerGuardedTool('soter_reconcile_connected_transaction', {
    title: 'Reconcile Soter connected transaction',
    description: 'For an exact needs-attention transaction, checkpoint one read-only record observation that can prove approved state, prior state, missing state, or divergence. This tool never accepts approval and never retries a write.',
    inputSchema: {
      checkpoint_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareDurableConnectedTransactionReconciliation({
      root,
      checkpointId: input.checkpoint_id,
      at: input.at,
      expectedHost: host
    });
    return result(
      prepared,
      'Prepared one exact read-only reconciliation call; no provider call or write was executed.'
    );
  });

  registerGuardedTool('soter_prepare_meeting_intake_context', {
    title: 'Prepare connected meeting-intake context',
    description: 'Build, preflight, and durably start the bounded connected source plan from one exact current Meeting Intake prepared-work record. The plan loads the policy index, exact transcript, matching CRM meeting, and only its referenced organization-to-project-to-task chain without writes.',
    inputSchema: {
      work_id: z.string().regex(/^work\.meeting-intake\.[a-f0-9]{24}$/),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareMeetingIntakeConnectedContext({
      root,
      workId: input.work_id,
      at: input.at,
      expectedHost: host
    });
    return result(
      prepared,
      'Durably started the bounded connected meeting-intake context plan and emitted at most one native host call.'
    );
  });

  registerGuardedTool('soter_finalize_meeting_intake_context', {
    title: 'Finalize connected meeting-intake context',
    description: 'Validate a completed exact context plan, require non-empty identity-matched fixed sources plus every requested related record, persist one private context snapshot, update its durable run, and pause before writes.',
    inputSchema: {
      checkpoint_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: completionAnnotations
  }, async (input) => {
    const finalized = finalizeMeetingIntakeConnectedContext({
      root,
      checkpointId: input.checkpoint_id,
      expectedHost: host
    });
    return result(
      finalized,
      'Finalized the bounded connected context snapshot and paused its durable run before writes.'
    );
  });

  registerGuardedTool('soter_prepare_slack_conversation_review_context', {
    title: 'Prepare connected Slack conversation review',
    description: 'Revalidate one exact current Slack conversation-review prepared-work item, checkpoint a fixed read-only plan, and emit at most its first private native host call. The plan reads every selected bounded message window and only exact explicitly supplied thread references. This tool performs no provider call and creates no persistence proposal, approval, continuation, retry, or write authority.',
    inputSchema: {
      work_id: z.string().regex(/^work\.slack-conversation-review\.[a-f0-9]{24}$/),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareSlackConversationReviewConnectedAcquisition({
      root,
      workId: input.work_id,
      at: input.at,
      expectedHost: host
    });
    return result(
      prepared,
      'SLACK_CONNECTED_PLAN_PREPARED: checkpointed one exact private read-only plan and emitted at most one native host call; no provider call or authority was created.'
    );
  });

  registerGuardedTool('soter_finalize_slack_conversation_review_context', {
    title: 'Finalize connected Slack conversation review',
    description: 'Revalidate complete exact conversation, message-window, and explicitly selected-thread coverage, commit one private normalized Context snapshot, and return only the closed sanitized inspection of counts, fingerprints, injection suspicion, and no-authority state. No body, reference, provider envelope, or cursor is returned.',
    inputSchema: {
      checkpoint_id: z.string().regex(
        /^checkpoint\.plan\.slack-conversation-review\.connected-acquisition\.[a-f0-9]{24}$/
      )
    },
    outputSchema: resultSchema,
    annotations: completionAnnotations
  }, async (input) => {
    const inspection = finalizeSlackConversationReviewConnectedAcquisition({
      root,
      checkpointId: input.checkpoint_id,
      expectedHost: host
    });
    return result(
      inspection,
      'SLACK_CONNECTED_INSPECTION_READY: finalized private normalized Context and returned its sanitized inspection without provider data or authority.'
    );
  });

  registerGuardedTool('soter_inspect_slack_conversation_review', {
    title: 'Inspect sanitized connected Slack conversation review',
    description: 'Revalidate one exact completed selected-work snapshot and return its closed sanitized counts, fingerprints, injection suspicion, and no-authority state. This read returns no private value, conversation or thread reference, message body, participant value, provider envelope, or cursor.',
    inputSchema: {
      work_id: z.string().regex(/^work\.slack-conversation-review\.[a-f0-9]{24}$/)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const inspection = inspectSlackConversationReviewConnected({
      root,
      workId: input.work_id,
      expectedHost: host
    });
    return result(
      inspection,
      'SLACK_CONNECTED_INSPECTION_READY: returned one exact sanitized selected-work inspection without private values or authority.'
    );
  });

  registerGuardedTool('soter_inspect_slack_conversation_review_private', {
    title: 'Inspect private selected Slack conversation review',
    description: 'Explicit private selected-work read. Revalidate one exact completed selected-work snapshot and return normalized conversation references, message bodies, and only exact explicitly selected thread bodies. This read never returns raw provider envelopes or pagination cursors and creates no persistence proposal, approval, continuation, retry, provider call, or write authority.',
    inputSchema: {
      work_id: z.string().regex(/^work\.slack-conversation-review\.[a-f0-9]{24}$/)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const review = inspectSlackConversationReviewConnectedPrivateReview({
      root,
      workId: input.work_id,
      expectedHost: host
    });
    return result(
      review,
      'SLACK_CONNECTED_PRIVATE_SELECTED_WORK: returned exact normalized private selected-work material without provider envelopes, cursors, or authority.'
    );
  });

  registerGuardedTool('soter_prepare_email_triage_context', {
    title: 'Prepare connected Email acquisition',
    description: 'Build, preflight, and durably start the exact bounded private mailbox search sealed by one current Email prepared-work record, followed by thread expansion. This transport-only acquisition performs no triage judgment, draft generation, approval, or provider write.',
    inputSchema: {
      work_id: z.string().regex(/^work\.email-triage\.[a-f0-9]{24}$/),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareEmailTriageConnectedAcquisition({
      root,
      workId: input.work_id,
      at: input.at,
      expectedHost: host
    });
    return result(
      prepared,
      'Durably started one bounded private Email acquisition plan and emitted at most one native host call.'
    );
  });

  registerGuardedTool('soter_finalize_email_triage_context', {
    title: 'Finalize connected Email acquisition',
    description: 'Validate complete pagination and exact searched-message coverage, persist one private normalized Context snapshot, and pause before any triage judgment, draft, approval, or write.',
    inputSchema: {
      checkpoint_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: completionAnnotations
  }, async (input) => {
    const finalized = finalizeEmailTriageConnectedAcquisition({
      root,
      checkpointId: input.checkpoint_id,
      expectedHost: host
    });
    return result(
      finalized,
      'Finalized the bounded private Email acquisition snapshot and paused before judgment or writes.'
    );
  });

  registerGuardedTool('soter_inspect_email_triage_decision', {
    title: 'Inspect Email triage decision context',
    description: 'Recover the exact private normalized Email snapshot and deterministic reduction template covering every bounded candidate. This read-only tool interprets no mail and performs no provider call.',
    inputSchema: {
      lock_path: z.string().min(1),
      snapshot_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const inspected = inspectEmailTriageDecisionContext({
      root,
      lockPath: input.lock_path,
      snapshotId: input.snapshot_id,
      expectedHost: host
    });
    return result(
      inspected,
      'Recovered exact private Email candidates and an explicit needs-input template without provider calls.'
    );
  });

  registerGuardedTool('soter_commit_email_triage_decision', {
    title: 'Commit grounded Email triage decision',
    description: 'Bind one exact classification and bounded subject/body evidence to every reduced private Email candidate. Use needs-input to abstain. This tool creates no draft, proposed change, approval, continuation, or provider call.',
    inputSchema: {
      lock_path: z.string().min(1),
      snapshot_id: z.string().min(1),
      decision_id: z.string().min(1),
      decision: jsonObject,
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const committed = commitEmailTriageDecision({
      root,
      lockPath: input.lock_path,
      snapshotId: input.snapshot_id,
      id: input.decision_id,
      input: input.decision,
      producer: { kind: 'host', id: 'host.' + host, host },
      at: input.at,
      expectedHost: host
    });
    return result(
      committed,
      'Committed the exact grounded private Email decision without drafts, proposed changes, approval, continuation, or provider calls.'
    );
  });

  registerGuardedTool('soter_inspect_email_triage_proposal', {
    title: 'Inspect Email triage proposal basis',
    description: 'Recover one exact ready private Email decision and a candidate-complete private proposal input template. This selected-decision read performs no provider call and grants no authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      decision_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const inspected = inspectEmailTriageProposalDecision({
      root,
      lockPath: input.lock_path,
      decisionId: input.decision_id,
      expectedHost: host
    });
    return result(
      inspected,
      'Recovered the exact private Email proposal basis without proposal state, approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_commit_email_triage_proposal', {
    title: 'Commit Email triage review proposal',
    description: 'Validate complete private draft, digest, and handoff values against one exact ready Email decision, then create a sanitized proposal plus selected-private companion. This tool creates no approval, continuation, provider call, write, or send authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      decision_id: z.string().min(1),
      proposal_id: z.string().min(1),
      proposal: jsonObject,
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const committed = commitEmailTriageProposal({
      root,
      lockPath: input.lock_path,
      decisionId: input.decision_id,
      id: input.proposal_id,
      input: input.proposal,
      producer: { kind: 'host', id: 'host.' + host, host },
      at: input.at,
      expectedHost: host
    });
    return result(
      committed,
      'Committed one exact private Email review proposal without approval, continuation, provider calls, writes, or sending.'
    );
  });

  registerGuardedTool('soter_inspect_email_triage_proposal_material', {
    title: 'Inspect selected Email proposal material',
    description: 'Return complete private review values for one exact selected Email proposal after revalidating its decision, lock, row, action, and content bindings. This read grants no authority and performs no provider call.',
    inputSchema: {
      lock_path: z.string().min(1),
      proposal_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const material = inspectEmailTriageProposalMaterial({
      root,
      lockPath: input.lock_path,
      proposalId: input.proposal_id,
      expectedHost: host
    });
    return result(
      material,
      'Returned exact selected-private Email proposal material without approval, continuation, provider calls, writes, or sending.'
    );
  });

  registerGuardedTool('soter_prepare_task_capture_context', {
    title: 'Prepare connected Task Capture acquisition',
    description: 'Bind one current Task prepared-work item to a durable connected plan for exact policy selection, project resolution, optional authenticated current-user identity, and bounded duplicate reads. This tool performs no provider call and creates no proposal, approval, continuation, or write authority.',
    inputSchema: {
      work_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareTaskCaptureConnectedAcquisition({
      root,
      workId: input.work_id,
      at: input.at,
      expectedHost: host
    });
    return result(
      prepared,
      'Durably started one exact connected Task acquisition and emitted at most one native host call.'
    );
  });

  registerGuardedTool('soter_finalize_task_capture_context', {
    title: 'Finalize connected Task Capture acquisition',
    description: 'Validate the completed exact Task acquisition, persist one private normalized Context snapshot, and pause before decision, proposal, approval, continuation, or write authority.',
    inputSchema: {
      checkpoint_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: completionAnnotations
  }, async (input) => {
    const finalized = finalizeTaskCaptureConnectedAcquisition({
      root,
      checkpointId: input.checkpoint_id,
      expectedHost: host
    });
    return result(
      finalized,
      'Finalized the exact private Task acquisition snapshot and paused before decisions or writes.'
    );
  });

  registerGuardedTool('soter_inspect_task_capture_decision', {
    title: 'Inspect Task Capture decision basis',
    description: 'Revalidate one exact private connected Task snapshot at the current inspection time and derive ready or needs-input from Context freshness, project context, and bounded duplicates. This read exposes fingerprints and issue codes only, performs no provider call, and grants no authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      snapshot_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const inspected = inspectTaskCaptureDecisionContext({
      root,
      lockPath: input.lock_path,
      snapshotId: input.snapshot_id,
      expectedHost: host,
      at: input.at
    });
    return result(
      inspected,
      'Inspected the deterministic Task decision basis without creating decision state or authority.'
    );
  });

  registerGuardedTool('soter_commit_task_capture_decision', {
    title: 'Commit grounded Task Capture decision',
    description: 'Deterministically bind current prepared input, exact connected policy selection, project, current-user identity, and duplicate observations into one private Task decision. This tool creates no proposal, approval, continuation, provider call, or write authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      snapshot_id: z.string().min(1),
      decision_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const committed = commitTaskCaptureDecision({
      root,
      lockPath: input.lock_path,
      snapshotId: input.snapshot_id,
      id: input.decision_id,
      producer: { kind: 'host', id: 'host.' + host, host },
      at: input.at,
      expectedHost: host
    });
    return result(
      committed,
      'Committed one exact private Task decision without proposal, approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_inspect_task_capture_proposal', {
    title: 'Inspect Task Capture proposal basis',
    description: 'Recover one exact ready private Task decision and its deterministic proposal fingerprint basis. This selected-decision read performs no provider call and grants no authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      decision_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const inspected = inspectTaskCaptureProposalDecision({
      root,
      lockPath: input.lock_path,
      decisionId: input.decision_id,
      expectedHost: host
    });
    return result(
      inspected,
      'Recovered the exact Task proposal basis without proposal state, approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_commit_task_capture_proposal', {
    title: 'Commit Task Capture review proposal',
    description: 'Deterministically create one sanitized Task review proposal plus selected-private companion from an exact ready decision. This tool creates no approval, continuation, provider call, or write authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      decision_id: z.string().min(1),
      proposal_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const committed = commitTaskCaptureProposal({
      root,
      lockPath: input.lock_path,
      decisionId: input.decision_id,
      id: input.proposal_id,
      input: {},
      producer: { kind: 'host', id: 'host.' + host, host },
      at: input.at,
      expectedHost: host
    });
    return result(
      committed,
      'Committed one exact private Task review proposal without approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_inspect_task_capture_proposal_material', {
    title: 'Inspect selected Task Capture proposal material',
    description: 'Return complete private Task values for one exact selected proposal after revalidating its decision, prepared work, lock, row, action, and content bindings. This read grants no authority and performs no provider call.',
    inputSchema: {
      lock_path: z.string().min(1),
      proposal_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const material = inspectTaskCaptureProposalMaterial({
      root,
      lockPath: input.lock_path,
      proposalId: input.proposal_id,
      expectedHost: host
    });
    return result(
      material,
      'Returned exact selected-private Task proposal material without approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_prepare_organization_capture_context', {
    title: 'Prepare connected Organization Capture acquisition',
    description: 'Bind one current Organization prepared-work item to a durable connected plan for exact policy selection, current schema observation, and bounded alias-aware duplicate reads. This tool performs no provider call and creates no proposal, approval, continuation, or write authority.',
    inputSchema: {
      work_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareOrganizationCaptureConnectedAcquisition({
      root,
      workId: input.work_id,
      at: input.at,
      expectedHost: host
    });
    return result(
      prepared,
      'Durably started one exact connected Organization acquisition and emitted at most one native host call.'
    );
  });

  registerGuardedTool('soter_finalize_organization_capture_context', {
    title: 'Finalize connected Organization Capture acquisition',
    description: 'Validate the completed exact Organization acquisition, persist one private normalized Context snapshot, and pause before decision, proposal, approval, continuation, or write authority.',
    inputSchema: {
      checkpoint_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: completionAnnotations
  }, async (input) => {
    const finalized = finalizeOrganizationCaptureConnectedAcquisition({
      root,
      checkpointId: input.checkpoint_id,
      expectedHost: host
    });
    return result(
      finalized,
      'Finalized the exact private Organization acquisition snapshot and paused before decisions or writes.'
    );
  });

  registerGuardedTool('soter_inspect_organization_capture_decision', {
    title: 'Inspect Organization Capture decision basis',
    description: 'Revalidate one exact private connected Organization snapshot and derive ready or needs-input from current schema, deterministic classification, and bounded duplicate candidates. This read exposes fingerprints and issue codes only, performs no provider call, and grants no authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      snapshot_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const inspected = inspectOrganizationCaptureDecisionContext({
      root,
      lockPath: input.lock_path,
      snapshotId: input.snapshot_id,
      expectedHost: host
    });
    return result(
      inspected,
      'Inspected the deterministic Organization decision basis without creating decision state or authority.'
    );
  });

  registerGuardedTool('soter_commit_organization_capture_decision', {
    title: 'Commit grounded Organization Capture decision',
    description: 'Deterministically bind current prepared input, exact policy selection, current schema, and alias-aware duplicate observations into one private Organization decision. This tool creates no proposal, approval, continuation, provider call, or write authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      snapshot_id: z.string().min(1),
      decision_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const committed = commitOrganizationCaptureDecision({
      root,
      lockPath: input.lock_path,
      snapshotId: input.snapshot_id,
      id: input.decision_id,
      producer: { kind: 'host', id: 'host.' + host, host },
      at: input.at,
      expectedHost: host
    });
    return result(
      committed,
      'Committed one exact private Organization decision without proposal, approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_inspect_organization_capture_proposal', {
    title: 'Inspect Organization Capture proposal basis',
    description: 'Recover one exact ready private Organization decision and its deterministic proposal fingerprint basis. This selected-decision read performs no provider call and grants no authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      decision_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const inspected = inspectOrganizationCaptureProposalDecision({
      root,
      lockPath: input.lock_path,
      decisionId: input.decision_id,
      expectedHost: host
    });
    return result(
      inspected,
      'Recovered the exact Organization proposal basis without proposal state, approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_commit_organization_capture_proposal', {
    title: 'Commit Organization Capture review proposal',
    description: 'Deterministically create one sanitized Organization review proposal plus selected-private companion from an exact ready decision. This tool creates no approval, continuation, provider call, or write authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      decision_id: z.string().min(1),
      proposal_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const committed = commitOrganizationCaptureProposal({
      root,
      lockPath: input.lock_path,
      decisionId: input.decision_id,
      id: input.proposal_id,
      input: {},
      producer: { kind: 'host', id: 'host.' + host, host },
      at: input.at,
      expectedHost: host
    });
    return result(
      committed,
      'Committed one exact private Organization review proposal without approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_inspect_organization_capture_proposal_material', {
    title: 'Inspect selected Organization Capture proposal material',
    description: 'Return complete private Organization values for one exact selected proposal after revalidating its decision, prepared work, schema, lock, row, action, and content bindings. This read grants no authority and performs no provider call.',
    inputSchema: {
      lock_path: z.string().min(1),
      proposal_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const material = inspectOrganizationCaptureProposalMaterial({
      root,
      lockPath: input.lock_path,
      proposalId: input.proposal_id,
      expectedHost: host
    });
    return result(
      material,
      'Returned exact selected-private Organization proposal material without approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_prepare_project_capture_context', {
    title: 'Prepare connected Project Capture acquisition',
    description: 'Bind one current Project prepared-work item to a durable connected plan for exact policy, current schema, organization, optional current-user manager, and bounded duplicate reads. This tool performs no provider call and creates no proposal, approval, continuation, or write authority.',
    inputSchema: {
      work_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareProjectCaptureConnectedAcquisition({
      root,
      workId: input.work_id,
      at: input.at,
      expectedHost: host
    });
    return result(
      prepared,
      'Durably started one exact connected Project Capture acquisition and emitted at most one native host call.'
    );
  });

  registerGuardedTool('soter_finalize_project_capture_context', {
    title: 'Finalize connected Project Capture acquisition',
    description: 'Validate the completed exact Project acquisition, persist one private normalized Context snapshot, and pause before decision, proposal, approval, continuation, or write authority.',
    inputSchema: {
      checkpoint_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: completionAnnotations
  }, async (input) => {
    const finalized = finalizeProjectCaptureConnectedAcquisition({
      root,
      checkpointId: input.checkpoint_id,
      expectedHost: host
    });
    return result(
      finalized,
      'Finalized the exact private Project acquisition snapshot and paused before decisions or writes.'
    );
  });

  registerGuardedTool('soter_inspect_project_capture_decision', {
    title: 'Inspect Project Capture decision basis',
    description: 'Revalidate one exact private connected Project snapshot and derive ready or needs-input from current schema, naming, dates, organization, manager, and duplicate candidates. This read exposes fingerprints and issue codes only, performs no provider call, and grants no authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      snapshot_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const inspected = inspectProjectCaptureDecisionContext({
      root,
      lockPath: input.lock_path,
      snapshotId: input.snapshot_id,
      expectedHost: host
    });
    return result(
      inspected,
      'Inspected the deterministic Project Capture decision basis without creating decision state or authority.'
    );
  });

  registerGuardedTool('soter_commit_project_capture_decision', {
    title: 'Commit grounded Project Capture decision',
    description: 'Deterministically bind current private input, exact policy and schema, organization, optional current-user manager, body and milestones, and duplicate observations into one private Project decision. This tool creates no proposal, approval, continuation, provider call, or write authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      snapshot_id: z.string().min(1),
      decision_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const committed = commitProjectCaptureDecision({
      root,
      lockPath: input.lock_path,
      snapshotId: input.snapshot_id,
      id: input.decision_id,
      producer: { kind: 'host', id: 'host.' + host, host },
      at: input.at,
      expectedHost: host
    });
    return result(
      committed,
      'Committed one exact private Project Capture decision without proposal, approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_inspect_project_capture_proposal', {
    title: 'Inspect Project Capture proposal basis',
    description: 'Recover one exact ready private Project Capture decision and its deterministic proposal fingerprint basis. This selected-decision read performs no provider call and grants no authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      decision_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const inspected = inspectProjectCaptureProposalDecision({
      root,
      lockPath: input.lock_path,
      decisionId: input.decision_id,
      expectedHost: host
    });
    return result(
      inspected,
      'Recovered the exact Project Capture proposal basis without proposal state, approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_commit_project_capture_proposal', {
    title: 'Commit Project Capture review proposal',
    description: 'Deterministically create one sanitized Project review proposal plus selected-private companion from an exact ready decision. This tool creates no approval, continuation, provider call, or write authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      decision_id: z.string().min(1),
      proposal_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const committed = commitProjectCaptureProposal({
      root,
      lockPath: input.lock_path,
      decisionId: input.decision_id,
      id: input.proposal_id,
      input: {},
      producer: { kind: 'host', id: 'host.' + host, host },
      at: input.at,
      expectedHost: host
    });
    return result(
      committed,
      'Committed one exact private Project Capture review proposal without approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_inspect_project_capture_proposal_material', {
    title: 'Inspect selected Project Capture proposal material',
    description: 'Return complete private Project fields, body, and milestones for one exact selected proposal after revalidating its decision, prepared work, schema, lock, row, action, and content bindings. This read grants no authority and performs no provider call.',
    inputSchema: {
      lock_path: z.string().min(1),
      proposal_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const material = inspectProjectCaptureProposalMaterial({
      root,
      lockPath: input.lock_path,
      proposalId: input.proposal_id,
      expectedHost: host
    });
    return result(
      material,
      'Returned exact selected-private Project Capture proposal material without approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_prepare_contact_capture_context', {
    title: 'Prepare connected Contact Capture acquisition',
    description: 'Bind one current Contact prepared-work item to a durable connected plan for exact policy selection, current person schema observation, bounded email-or-name duplicate reads, and optional organization resolution. This tool performs no provider call and creates no proposal, approval, continuation, or write authority.',
    inputSchema: {
      work_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareContactCaptureConnectedAcquisition({
      root,
      workId: input.work_id,
      at: input.at,
      expectedHost: host
    });
    return result(
      prepared,
      'Durably started one exact connected Contact acquisition and emitted at most one native host call.'
    );
  });

  registerGuardedTool('soter_finalize_contact_capture_context', {
    title: 'Finalize connected Contact Capture acquisition',
    description: 'Validate the completed exact Contact acquisition, persist one private normalized Context snapshot, and pause before decision, proposal, approval, continuation, or write authority.',
    inputSchema: {
      checkpoint_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: completionAnnotations
  }, async (input) => {
    const finalized = finalizeContactCaptureConnectedAcquisition({
      root,
      checkpointId: input.checkpoint_id,
      expectedHost: host
    });
    return result(
      finalized,
      'Finalized the exact private Contact acquisition snapshot and paused before decisions or writes.'
    );
  });

  registerGuardedTool('soter_inspect_contact_capture_decision', {
    title: 'Inspect Contact Capture decision basis',
    description: 'Revalidate one exact private connected Contact snapshot and derive ready or needs-input from current option sets, exact organization resolution, and bounded duplicate candidates. This read exposes fingerprints and issue codes only, performs no provider call, and grants no authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      snapshot_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const inspected = inspectContactCaptureDecisionContext({
      root,
      lockPath: input.lock_path,
      snapshotId: input.snapshot_id,
      expectedHost: host
    });
    return result(
      inspected,
      'Inspected the deterministic Contact decision basis without creating decision state or authority.'
    );
  });

  registerGuardedTool('soter_commit_contact_capture_decision', {
    title: 'Commit grounded Contact Capture decision',
    description: 'Deterministically bind current prepared input, exact policy selection, current schema, organization resolution, and email-or-name duplicate observations into one private Contact decision. This tool creates no proposal, approval, continuation, provider call, or write authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      snapshot_id: z.string().min(1),
      decision_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const committed = commitContactCaptureDecision({
      root,
      lockPath: input.lock_path,
      snapshotId: input.snapshot_id,
      id: input.decision_id,
      producer: { kind: 'host', id: 'host.' + host, host },
      at: input.at,
      expectedHost: host
    });
    return result(
      committed,
      'Committed one exact private Contact decision without proposal, approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_inspect_contact_capture_proposal', {
    title: 'Inspect Contact Capture proposal basis',
    description: 'Recover one exact ready private Contact decision and its deterministic proposal fingerprint basis. This selected-decision read performs no provider call and grants no authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      decision_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const inspected = inspectContactCaptureProposalDecision({
      root,
      lockPath: input.lock_path,
      decisionId: input.decision_id,
      expectedHost: host
    });
    return result(
      inspected,
      'Recovered the exact Contact proposal basis without proposal state, approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_commit_contact_capture_proposal', {
    title: 'Commit Contact Capture review proposal',
    description: 'Deterministically create one sanitized Contact review proposal plus selected-private companion from an exact ready decision. This tool creates no approval, continuation, provider call, or write authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      decision_id: z.string().min(1),
      proposal_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const committed = commitContactCaptureProposal({
      root,
      lockPath: input.lock_path,
      decisionId: input.decision_id,
      id: input.proposal_id,
      input: {},
      producer: { kind: 'host', id: 'host.' + host, host },
      at: input.at,
      expectedHost: host
    });
    return result(
      committed,
      'Committed one exact private Contact review proposal without approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_inspect_contact_capture_proposal_material', {
    title: 'Inspect selected Contact Capture proposal material',
    description: 'Return complete private Contact values for one exact selected proposal after revalidating its decision, prepared work, schema, lock, row, action, and content bindings. This read grants no authority and performs no provider call.',
    inputSchema: {
      lock_path: z.string().min(1),
      proposal_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const material = inspectContactCaptureProposalMaterial({
      root,
      lockPath: input.lock_path,
      proposalId: input.proposal_id,
      expectedHost: host
    });
    return result(
      material,
      'Returned exact selected-private Contact proposal material without approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_inspect_meeting_intake_decision', {
    title: 'Inspect meeting-intake decision context',
    description: 'Recover the exact private normalized context snapshot and a safe needs-input template enumerating every bounded task and applicable policy. This read-only tool performs no provider call.',
    inputSchema: {
      lock_path: z.string().min(1),
      snapshot_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const inspected = inspectMeetingIntakeDecisionContext({
      root,
      lockPath: input.lock_path,
      snapshotId: input.snapshot_id,
      expectedHost: host
    });
    return result(
      inspected,
      'Recovered the exact private decision context and an explicit needs-input template without provider calls.'
    );
  });

  registerGuardedTool('soter_commit_meeting_intake_decision', {
    title: 'Commit grounded meeting-intake decision',
    description: 'Resolve exact bounded meeting, transcript segments, task candidates, and applicable policy excerpts into a private durable Automation decision. Use needs-input to abstain. This tool performs no provider call and creates no write approval.',
    inputSchema: {
      lock_path: z.string().min(1),
      snapshot_id: z.string().min(1),
      decision_id: z.string().min(1),
      decision: jsonObject,
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const committed = commitMeetingIntakeDecision({
      root,
      lockPath: input.lock_path,
      snapshotId: input.snapshot_id,
      id: input.decision_id,
      input: input.decision,
      producer: { kind: 'host', id: 'host.' + host, host },
      at: input.at,
      expectedHost: host
    });
    return result(
      committed,
      'Committed the exact grounded Automation decision without provider calls or write approval.'
    );
  });

  registerGuardedTool('soter_inspect_meeting_intake_proposal', {
    title: 'Inspect Meeting Intake proposal basis',
    description: 'Recover one exact ready private Meeting Intake decision and its deterministic proposal basis. This selected-decision read performs no provider call and grants no authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      decision_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const inspected = inspectMeetingIntakeProposalDecision({
      root,
      lockPath: input.lock_path,
      decisionId: input.decision_id,
      expectedHost: host
    });
    return result(
      inspected,
      'Recovered the exact Meeting Intake proposal basis without proposal state, approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_commit_meeting_intake_proposal', {
    title: 'Commit Meeting Intake review proposal',
    description: 'Deterministically create one sanitized Meeting Intake review proposal plus selected-private companion from an exact ready decision. This tool creates no approval, continuation, provider call, or write authority.',
    inputSchema: {
      lock_path: z.string().min(1),
      decision_id: z.string().min(1),
      proposal_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const committed = commitMeetingIntakeProposal({
      root,
      lockPath: input.lock_path,
      decisionId: input.decision_id,
      id: input.proposal_id,
      input: {},
      producer: { kind: 'host', id: 'host.' + host, host },
      at: input.at,
      expectedHost: host
    });
    return result(
      committed,
      'Committed one exact private Meeting Intake review proposal without approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_inspect_meeting_intake_proposal_material', {
    title: 'Inspect selected Meeting Intake proposal material',
    description: 'Return complete private summary, task-fold, and held-boundary values for one exact selected Meeting Intake proposal after revalidating its decision, lock, row, action, and content bindings. This read grants no authority and performs no provider call.',
    inputSchema: {
      lock_path: z.string().min(1),
      proposal_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const material = inspectMeetingIntakeProposalMaterial({
      root,
      lockPath: input.lock_path,
      proposalId: input.proposal_id,
      expectedHost: host
    });
    return result(
      material,
      'Returned exact selected-private Meeting Intake proposal material without approval, continuation, provider calls, or writes.'
    );
  });

  registerGuardedTool('soter_fail_host_call', {
    title: 'Record Soter host call failure',
    description: 'Close an exact durable probe or capability checkpoint as failed when the host could not obtain a native provider result.',
    inputSchema: {
      checkpoint_id: z.string().min(1),
      error_kind: z.enum([
        'authentication',
        'authorization',
        'validation',
        'conflict',
        'rate-limit',
        'unavailable',
        'retryable',
        'not-found',
        'unknown'
      ]),
      call_id: z.string().min(1).optional(),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: completionAnnotations
  }, async (input) => {
    const failed = await failDurableHostExecution({
      root,
      checkpointId: input.checkpoint_id,
      errorKind: input.error_kind,
      callId: input.call_id,
      at: input.at,
      expectedHost: host
    });
    return result(failed, 'Recorded the exact host request as failed; no provider call was executed.');
  });

  registerGuardedTool('soter_get_host_call', {
    title: 'Get Soter host call checkpoint',
    description: 'Rehydrate one private durable host call checkpoint by ID without contacting a provider.',
    inputSchema: {
      checkpoint_id: z.string().min(1)
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const checkpoint = getDurableHostExecution({
      root,
      checkpointId: input.checkpoint_id,
      expectedHost: host
    });
    return result(checkpoint, 'Loaded the durable Soter host call checkpoint.');
  });

  registerGuardedTool('soter_list_host_calls', {
    title: 'List Soter host call checkpoints',
    description: 'List private durable host call checkpoint summaries for recovery; normalized results are omitted from the list view.',
    inputSchema: {
      state: z.enum([
        'requested', 'completed', 'failed', 'needs-attention', 'blocked'
      ]).optional()
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const checkpoints = listDurableHostExecutions({
      root,
      state: input.state,
      expectedHost: host
    });
    return result(checkpoints, 'Listed durable Soter host call checkpoints.');
  });

  return server;
}
