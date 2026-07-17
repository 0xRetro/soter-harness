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
  commitMeetingIntakeDecision,
  inspectMeetingIntakeDecisionContext
} from '../../automations/meeting-intake/decision.mjs';
import {
  commitEmailTriageDecision,
  inspectEmailTriageDecisionContext
} from '../../automations/email-triage/decision.mjs';
import {
  commitEmailTriageProposal,
  inspectEmailTriageProposalDecision,
  inspectEmailTriageProposalMaterial
} from '../../automations/email-triage/proposal.mjs';
import { proposeDurableMeetingIntakeChangeSet } from '../../automations/meeting-intake/transaction.mjs';
import {
  completeDurableCapabilityExecution,
  completeDurableConnectedTransactionExecution,
  completeDurableOperationPlanExecution,
  completeDurableProviderProbeExecution,
  failDurableHostExecution,
  getDurableHostExecution,
  listDurableHostExecutions,
  prepareDurableCapabilityExecution,
  prepareDurableConnectedTransactionReconciliation,
  prepareDurableOperationPlanExecution,
  prepareDurableProviderProbeExecution
} from '../service.mjs';
import {
  createHostRuntimeBasis,
  inspectHostRuntime
} from '../host-runtime-inspection.mjs';

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
      instructions: 'Before operational work, use soter_inspect_host_runtime; if it reports SOTER_HOST_RUNTIME_STALE, restart the host runtime instead of retrying another Soter tool. Soter Core validates exact locks and runs for the active ' + host + ' host projection, then saves a private durable checkpoint before emitting a provider-neutral operation resolved to an exact native host tool. After compaction or restart, use soter_list_host_calls and soter_get_host_call to recover pending work. Invoke exactly currentCall.transport.tool when currentCall is present; otherwise invoke the legacy checkpoint.call.transport.tool. Return both checkpoint.id and currentCall.id for sequential plans and connected transactions because a successful completion may emit the next exact call. A needs-attention connected transaction may use soter_reconcile_connected_transaction to emit one exact read-only observation; reconciliation never retries a write and remains paused for missing or divergent state. Completed meeting-intake and Email acquisition plans must be finalized through their exact finalizer before their private snapshots are used. Email acquisition records transport facts only and pauses before triage judgment, drafts, approval, or writes. Inspect or recover exact private decision workspaces with soter_inspect_meeting_intake_decision or soter_inspect_email_triage_decision, then record exact bounded host judgment with soter_commit_meeting_intake_decision or soter_commit_email_triage_decision; use state needs-input rather than guessing when candidates or policies remain unresolved. A ready Email decision may be inspected and committed as one exact private review-only proposal with soter_inspect_email_triage_proposal and soter_commit_email_triage_proposal; complete draft, digest, and handoff values remain available only through soter_inspect_email_triage_proposal_material. That proposal creates no approval, continuation, provider call, write, or send authority. A ready meeting-intake decision can be projected into a reviewable change set with soter_propose_meeting_intake_change_set. Always pass requested provider arguments through the separately configured provider MCP route and return the native result unchanged. Never fabricate a provider response. Soter does not invoke providers or persist raw responses. MCP cannot originate or alter connected-write approval; it may only resume a transaction already authorized and checkpointed by the trusted CLI.'
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

  registerGuardedTool('soter_prepare_provider_probe', {
    title: 'Prepare Soter provider probe',
    description: 'Validate an exact configuration lock, durably checkpoint an explicit provider readiness plan, and emit at most its first minimized native host request. This tool does not call the provider.',
    inputSchema: {
      lock_path: z.string().min(1),
      provider_implementation: z.string().min(1),
      call_id: z.string().min(1).optional(),
      probe_id: z.string().min(1).optional(),
      at: z.string().min(20).optional(),
      valid_for_seconds: z.number().int().min(60).max(900).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareDurableProviderProbeExecution({
      root,
      lockPath: input.lock_path,
      providerImplementation: input.provider_implementation,
      callId: input.call_id,
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
      call_id: z.string().min(1).optional(),
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

  registerGuardedTool('soter_prepare_capability_call', {
    title: 'Prepare Soter capability call',
    description: 'Validate and durably checkpoint an exact run before emitting one policy-bound provider operation resolved to an exact native host tool. This interface supplies no connected-write approval.',
    inputSchema: {
      lock_path: z.string().min(1),
      run_path: z.string().min(1),
      capability: z.string().min(1),
      authority: z.string().min(1),
      provider_implementation: z.string().min(1),
      input: jsonObject,
      call_id: z.string().min(1).optional(),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareDurableCapabilityExecution({
      root,
      lockPath: input.lock_path,
      runPath: input.run_path,
      capability: input.capability,
      authority: input.authority,
      providerImplementation: input.provider_implementation,
      input: input.input,
      callId: input.call_id,
      at: input.at,
      expectedHost: host
    });
    return result(prepared, 'Durably checkpointed a policy-bound Soter capability request; no provider call was executed.');
  });

  registerGuardedTool('soter_complete_capability_call', {
    title: 'Complete Soter capability call',
    description: 'Resume a durable capability checkpoint, validate the native result against its exact run and request, then checkpoint normalized portable output without the raw response.',
    inputSchema: {
      checkpoint_id: z.string().min(1),
      response: jsonObject,
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: completionAnnotations
  }, async (input) => {
    const completed = await completeDurableCapabilityExecution({
      root,
      checkpointId: input.checkpoint_id,
      response: input.response,
      at: input.at,
      expectedHost: host
    });
    return result(completed, 'Validated and normalized the provider capability result.');
  });

  registerGuardedTool('soter_prepare_operation_plan', {
    title: 'Prepare Soter operation plan',
    description: 'Validate and durably checkpoint an exact sequential capability plan with fixed inputs or typed earlier-output bindings, then emit at most its first policy-bound native host call. Empty skip bindings emit no provider call. This interface supplies no connected-write approval.',
    inputSchema: {
      lock_path: z.string().min(1),
      run_path: z.string().min(1),
      plan: jsonObject,
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareDurableOperationPlanExecution({
      root,
      lockPath: input.lock_path,
      runPath: input.run_path,
      plan: input.plan,
      at: input.at,
      expectedHost: host
    });
    return result(prepared, 'Durably checkpointed an exact sequential operation plan and emitted at most one native host call.');
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
    description: 'Resume the exact current call of an already authorized private connected-transaction checkpoint, persist only normalized output, and emit the next compare, write, verify, or compensation call. This interface cannot accept, create, or modify approval.',
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
    description: 'Build, preflight, and durably start the bounded connected source plan for one meeting-intake run. The plan loads the policy index, exact transcript, matching CRM meeting, and only its referenced organization-to-project-to-task chain without writes.',
    inputSchema: {
      lock_path: z.string().min(1),
      run_path: z.string().min(1),
      snapshot_id: z.string().min(1),
      meeting_id: z.string().min(1),
      recording_uri: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareMeetingIntakeConnectedContext({
      root,
      lockPath: input.lock_path,
      runPath: input.run_path,
      snapshotId: input.snapshot_id,
      meetingId: input.meeting_id,
      recordingUri: input.recording_uri,
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

  registerGuardedTool('soter_prepare_email_triage_context', {
    title: 'Prepare connected Email acquisition',
    description: 'Build, preflight, and durably start one exact bounded private mailbox search followed by thread expansion. This transport-only acquisition performs no triage judgment, draft generation, approval, or provider write.',
    inputSchema: {
      lock_path: z.string().min(1),
      run_path: z.string().min(1),
      snapshot_id: z.string().min(1),
      query: z.string().min(1).max(1000),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: statefulAnnotations
  }, async (input) => {
    const prepared = await prepareEmailTriageConnectedAcquisition({
      root,
      lockPath: input.lock_path,
      runPath: input.run_path,
      snapshotId: input.snapshot_id,
      query: input.query,
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

  registerGuardedTool('soter_propose_meeting_intake_change_set', {
    title: 'Propose meeting-intake change set',
    description: 'Project one exact ready durable meeting-intake decision into a reviewable provider-neutral change set. This read-only projection creates no approval and performs no provider call.',
    inputSchema: {
      lock_path: z.string().min(1),
      decision_id: z.string().min(1),
      change_set_id: z.string().min(1),
      at: z.string().min(20).optional()
    },
    outputSchema: resultSchema,
    annotations: readAnnotations
  }, async (input) => {
    const proposal = proposeDurableMeetingIntakeChangeSet({
      root,
      lockPath: input.lock_path,
      decisionId: input.decision_id,
      id: input.change_set_id,
      createdAt: input.at || new Date().toISOString(),
      expectedHost: host
    });
    return result(
      proposal,
      'Projected the exact durable Automation decision into a reviewable change set; no approval or provider call was created.'
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
      message: z.string().min(1),
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
      message: input.message,
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
        'requested', 'completed', 'rolled-back', 'failed', 'needs-attention', 'blocked'
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
