export type ProofState = 'passed' | 'failed' | 'stale' | 'unknown' | 'skipped' | 'not-applicable' | string;
export type ScenarioMigrationState = 'current' | 'mapped' | 'bridged' | 'migrated' | 'retired' | 'target-native' | 'unknown';
export type ViewName = 'operate' | 'explore' | 'config' | 'workflow' | 'runs' | 'distribution';
export type ConfigurationBasis = 'tracked-contained' | 'private-active';
export type PreparationMode = 'contained' | 'connected-acquisition';
export type ModeAvailability =
  | { state: 'available' }
  | { state: 'unavailable'; reasonCode: string; reason: string };

export type OperatorPreparationMode =
  | {
    id: 'contained';
    configurationBases: ['tracked-contained', 'private-active'];
    resultState: 'ready-for-review';
    availability: { state: 'available' };
    boundary: string;
  }
  | {
    id: 'connected-acquisition';
    configurationBases: ['private-active'];
    resultState: 'ready-for-acquisition';
    availability: ModeAvailability;
    boundary: string;
  };

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  source: string;
  subject: string;
  message: string;
  remediation: string;
}

export interface InspectionSnapshot {
  $contract: 'soter://contracts/workspace-inspection/v1';
  contractVersion: '1.0.0';
  workspace: { name: string; root: '.'; mode: 'read-only' };
  census: Record<string, number>;
  proof: {
    source: string;
    observedAt: string | null;
    states: Record<'valid' | 'ready' | 'verified' | 'healthy', ProofState>;
    checks: Array<{ id: string; claim: string; state: ProofState; details: string; evidenceIds: string[] }>;
    diagnostics: Diagnostic[];
    evidenceIds: string[];
  };
  configurations: Configuration[];
  catalog: CatalogItem[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  workflows: Workflow[];
  activity: Activity[];
  diagnostics: Diagnostic[];
}

export interface Configuration {
  name: string;
  status: string;
  lockState: string;
  configurationBasis: ConfigurationBasis;
  host: string;
  maturity: {
    verified: 'passed' | 'failed' | 'stale' | 'unknown';
    reasonCode: string;
    host: MaturityEvidence;
    selections: MaturityEvidence[];
  };
  selections: Array<{ id: string; version: string | null; layer: string | null; source: string; reason: string }>;
  bindings: Array<{ capability: string; providerPack: string; authorities: string[]; effects: string[]; reason: string }>;
  authorities: Array<{ id: string; role: string; subject: string; reason: string }>;
  effectPolicies: Array<{ effect: string; mode: string; reason: string }>;
  graphFingerprint: string | null;
  lockFingerprint: string | null;
}

export interface MaturityEvidence {
  id: string;
  claim: string | null;
  state: 'declared' | 'supported' | 'unsupported';
  result: 'passed' | 'failed' | 'stale' | 'unknown';
  reasonCode: string;
  requiredLevel: string | null;
  evidenceIds: string[];
  evidence: Array<{
    id: string;
    claimFamily: 'behavior';
    claim: string;
    result: string;
    level: string;
    createdAt: string;
    validUntil: string | null;
    limitations: string[];
  }>;
  basis: string;
  limitations: string[];
  remediation: string;
}

export interface CatalogItem {
  id: string;
  kind: string;
  group: string;
  label: string;
  summary: string;
  version: string | null;
  state: string;
  selected: boolean;
  effects: string[];
  limitations: string[];
}

export interface GraphNode {
  id: string;
  kind: string;
  group: string;
  label: string;
  summary: string;
  selected: boolean;
  state: string;
}

export interface GraphEdge {
  id: string;
  kind: string;
  source: string;
  target: string;
  label: string;
}

export interface Workflow {
  id: string;
  label: string;
  summary: string;
  version: string;
  configuration: string | null;
  configurationBasis: ConfigurationBasis | null;
  host: string | null;
  hostCompatibility: Record<string,
    | { state: 'compatible' }
    | { state: 'unavailable'; reasonCode: string; reason: string }
  >;
  effects: string[];
  requiredCapabilities: string[];
  dependencies: string[];
  bindings: string[];
  operator: null | {
    inputContract: {
      id: string;
      version: string;
      fields: OperatorInputField[];
      additionalInputs: boolean;
    };
    preparation: {
      supported: boolean;
      boundary: string;
      workStates: string[];
      modes: OperatorPreparationMode[];
    };
  };
  scenarios: Array<{
    id: string;
    status: 'declared-not-executed' | `executed-${string}`;
    intent: string;
    outcomes: string[];
    invariants: string[];
    evidence: string[];
    sourceCases: string[];
    migrationState: ScenarioMigrationState;
    execution: null | {
      source: 'fixture';
      result: string;
      observedAt: string;
      runId: string;
      evidenceIds: string[];
      capabilityOrder: { expected: string[]; observed: string[]; state: string };
      effectModes: { expected: Record<string, string>; observed: Record<string, string>; state: string };
      coverage: Record<'outcome' | 'invariant' | 'evidence', { passed: number; total: number }>;
      limitations: string[];
    };
  }>;
  migration: { id: string | null; state: string; limitations: string[] };
}

export interface TimelineItem {
  id: string;
  sequence: number;
  label: string;
  state: string;
  kind: string;
  at: string | null;
  capability: string | null;
  provider: string | null;
  authority: string | null;
  inputFingerprint: string | null;
  outputFingerprint: string | null;
  details: string;
}

export interface Activity {
  id: string;
  automationId?: string | null;
  source: 'fixture' | 'runtime';
  kind: 'run' | 'capability' | 'provider-probe' | 'operation-plan' | 'connected-transaction' | 'prepared-work';
  label: string;
  state: string;
  createdAt: string | null;
  updatedAt: string | null;
  host: string | null;
  provider: string | null;
  capability: string | null;
  configurationLockFingerprint: string | null;
  graphFingerprint: string | null;
  recoveryId: string | null;
  operatorRef?: { requestId: string; approvalId: string | null; checkpointId: string | null };
  preparedWorkRef?: { workId: string };
  timeline: TimelineItem[];
  evidence: Array<{ id: string; claim: string; result: string; level: string; createdAt: string; limitations: string[] }>;
}

export interface OperatorInputField {
  id: string;
  label: string;
  description: string;
  type: 'reference' | 'string' | 'string-list' | 'enum' | 'boolean' | 'date' | 'uri';
  required: boolean;
  exposure: 'identifier' | 'private';
  reference?: { subject: string; authorityRole: string };
  options?: string[];
  constraints?: {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minItems?: number;
    maxItems?: number;
    itemMinLength?: number;
    itemMaxLength?: number;
    itemPattern?: string;
  };
  examples?: string[] | string[][];
}

interface OperatorInputSummaryBase {
  id: string;
  state: string;
  fingerprint: string | null;
}

export type OperatorInputSummary = OperatorInputSummaryBase & (
  | { exposure: 'identifier'; value: string | boolean | null }
  | { exposure: 'private'; value?: never }
);

export interface OperatorInspection {
  $contract: 'soter://contracts/operator-inspection/v1';
  contractVersion: '1.0.0';
  generatedAt: string;
  activity: {
    id: string;
    automationId: string | null;
    workId: string;
    workState: 'awaiting-approval' | 'approval-expired' | 'approved-not-started' | 'running' | 'blocked' | 'verification-failed' | 'completed' | 'failed';
    phase: 'approval' | 'execution' | 'reconciliation' | 'verification' | 'complete';
    runId: string;
  };
  configuration: {
    name: string | null;
    path: string;
    lockPath: string;
    configurationBasis: ConfigurationBasis | null;
    lockFingerprint: string;
    graphFingerprint: string;
    host: string;
    applicability: { state: 'current' | 'stale' | 'unknown'; expectedLockFingerprint: string | null; observedLockFingerprint: string | null; reasonCode: string };
  };
  scope: {
    changeSet: { id: string; fingerprint: string };
    batch: { id: string; fingerprint: string };
    effects: string[];
    authorities: string[];
    recordIds: string[];
    changes: Array<{ id: string; recordId: string | null; effect: string; beforeFingerprint: string | null; afterFingerprint: string | null }>;
  };
  approval: {
    state: 'awaiting' | 'expired' | 'confirmed' | 'consumed';
    request: { id: string; fingerprint: string; requestedAt: string; expiresAt: string };
    confirmation: null | { id: string; fingerprint: string; confirmedAt: string; actor: string };
    consumption: null | { id: string; state: 'reserved' | 'started'; startedAt: string; checkpointId: string; checkpointFingerprint: string | null };
    reasonCode: string;
  };
  capabilities: {
    steps: Array<{ id: string; sequence: number; capability: string; authority: string; effects: string[]; state: 'pending' | 'current' | 'applied' | 'failed' | 'needs-attention' }>;
    completedPrefix: string[];
    current: null | { stepId: string; stage: 'precondition' | 'write' | 'verify' | 'reconcile'; callId: string; reconciliationId: string | null };
    pending: string[];
  };
  blockers: Array<{ reasonCode: string; summary: string; details: Array<{ key: string; value: string | number | boolean | null }>; requiredInputs: string[]; requiredPermissions: string[] }>;
  checkpoint: null | { id: string; fingerprint: string; state: 'requested' | 'completed' | 'failed' | 'needs-attention'; updatedAt: string };
  resume: {
    classification: 'safe' | 'requires-review' | 'unavailable';
    reasonCode: string;
    reason: string;
    permittedNextAction: 'confirm-approval' | 'renew-approval-request' | 'start-transaction' | 'execute-current-call' | 'prepare-reconciliation' | 'inspect-checkpoint' | 'rebuild-work' | 'none';
  };
  continuationRequest: null | { kind: 'execute-current-call' | 'prepare-reconciliation'; checkpointId: string; checkpointFingerprint: string; callId: string | null; requestFingerprint: string };
  verification: { state: 'not-started' | 'running' | 'verified' | 'failed' | 'unknown'; criteria: Array<{ id: string; state: string; reasonCode: string; observedFingerprint: string | null }>; observedFingerprint: string | null };
  compensation: {
    state: 'not-required';
    plan: Array<{ stepId: string; mode: string }>;
    completedStepIds: string[];
    remainingStepIds: string[];
    restoredFingerprint: null;
  };
  families: Record<'proof' | 'maturity' | 'migration', { state: 'not-evaluated'; reasonCode: string }>;
  privacy: { scope: 'private-derived'; rawProviderResponseIncluded: false; credentialValuesIncluded: false };
  inspectionFingerprint: string;
}

export type ConnectedApprovalBeforeReview =
  | { state: 'provided'; reasonCode: 'SOURCE_CONTEXT_BOUND'; fingerprint: string; reviewValue: Record<string, unknown> }
  | { state: 'unavailable'; reasonCode: 'SOURCE_CONTEXT_UNAVAILABLE'; fingerprint: null }
  | { state: 'not-required'; reasonCode: 'PRIOR_VALUE_NOT_REQUIRED'; fingerprint: null }
  | { state: 'absent-required'; reasonCode: 'DEDUPLICATION_ABSENCE_REQUIRED'; fingerprint: null };

export interface ConnectedApprovalReviewMaterial {
  $contract: 'soter://contracts/connected-approval-review-material/v1';
  contractVersion: '1.0.0';
  fingerprint: string;
  request: { id: string; fingerprint: string; createdAt: string; expiresAt: string; reason: string };
  configuration: {
    path: string;
    lockPath: string;
    lockFingerprint: string;
    graphFingerprint: string;
    host: string;
    applicability: {
      state: 'current' | 'stale' | 'unknown';
      expectedLockFingerprint: string | null;
      observedLockFingerprint: string | null;
      reasonCode: 'LOCK_CURRENT' | 'CHECKPOINT_STALE' | 'LOCK_APPLICABILITY_UNKNOWN';
    };
  };
  run: { id: string; fingerprint: string };
  changeSet: { id: string; documentFingerprint: string; scopeFingerprint: string };
  batch: { id: string; documentFingerprint: string; scopeFingerprint: string };
  effects: Array<'write' | 'destructive'>;
  completeness: { state: 'complete' | 'incomplete'; reasonCodes: Array<'SOURCE_CONTEXT_UNAVAILABLE'> };
  operations: Array<{
    id: string;
    sequence: number;
    capability: string;
    authority: string;
    reason: string;
    changeSetOperationFingerprint: string;
    batchOperationFingerprint: string;
    inputFingerprint: string;
    subject: { kind: 'portable-resource'; type: string; id: string | null };
    before: ConnectedApprovalBeforeReview;
    after: { state: 'provided'; fingerprint: string; reviewValue: Record<string, unknown> };
    precondition: { fingerprint: string; reviewValue: Record<string, unknown> };
    verification: { kind: string; expectedFingerprint: string; contentFingerprint: string | null };
    recovery: { mode: string; reason: string };
    operationFingerprint: string;
  }>;
  privacy: {
    scope: 'private-local-approval-review';
    authority: 'none';
    projection: 'selected-activity-only';
    providerArgumentsIncluded: false;
    rawProviderResponsesIncluded: false;
    credentialValuesIncluded: false;
    workspaceInspectionIncluded: false;
    evidenceIncluded: false;
    canonicalArtifactsIncluded: false;
    approvalAuthorityIncluded: false;
    continuationAuthorityIncluded: false;
  };
}

export type ConnectedApprovalReviewResult =
  | { ok: true; material: ConnectedApprovalReviewMaterial }
  | { ok: false; error: PreparedWorkReviewError };

export interface PreparedWork {
  $contract: 'soter://contracts/prepared-work/v1';
  contractVersion: '1.0.0';
  id: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  automation: { id: string; version: string };
  preparationMode?: 'connected-acquisition';
  state: 'draft' | 'preparing' | 'needs-input' | 'ready-for-review' | 'ready-for-acquisition';
  history: Array<{ state: 'draft' | 'preparing' | 'needs-input' | 'ready-for-review' | 'ready-for-acquisition'; at: string; reasonCode: string }>;
  configuration: {
    name: string; path: string; lockPath: string; configurationBasis: ConfigurationBasis; lockFingerprint: string;
    graphFingerprint: string; host: string; applicability: 'current' | 'stale';
  };
  inputSummary: {
    $contract: 'soter://contracts/operator-input-summary/v1';
    contractVersion: '1.0.0';
    workId: string;
    inputContractFingerprint: string;
    fields: OperatorInputSummary[];
    privacy: { privateValuesIncluded: false; identifierValuesSanitized: true };
  };
  contextPlan: PreparedContextStep[];
  outcomes: Array<{ id: string; label: string; state: 'proposed' | 'supported' | 'blocked'; basis: string[]; limitation: string }>;
  capabilities: { steps: PreparedContextStep[]; completedPrefix: string[]; current: string | null; pending: string[] };
  effects: Array<{ effect: string; mode: EffectMode; state: 'not-executed' | 'completed-contained'; reason: string }>;
  approval: { state: 'not-requested'; requiredFor: string[]; reason: string };
  readiness: {
    state: 'preparing' | 'needs-input' | 'ready-for-review' | 'ready-for-acquisition';
    blockers: Array<{ reasonCode: string; fieldId: string | null; message: string; remediation: string }>;
    limitations: string[];
  };
  preview: {
    kind: string;
    fingerprint: string | null;
    facts: Array<{ id: string; label: string; value: string | number | boolean | null; state: 'supported' | 'contradicted' | 'unavailable'; basisIds: string[] }>;
    contradictions: Array<{ id: string; claim: string; state: 'observed'; basisIds: string[] }>;
    collections: PreparedReviewCollection[];
    privateReview:
      | {
        state: 'available'; kind: string;
        contractId: 'soter://contracts/automation-derived-review/v1';
        contractFingerprint: string; contentFingerprint: string;
      }
      | {
        state: 'unavailable'; kind: null; contractId: null;
        contractFingerprint: null; contentFingerprint: null;
      };
    proposedChanges: Array<{ id: string; recordId: string; effect: string; beforeFingerprint: string | null; afterFingerprint: string | null }>;
  };
  evidence: Array<{ id: string; claim: string; result: string; level: string; createdAt: string; limitations: string[] }>;
  checkpoint: { id: string; fingerprint: string; runId: string | null; contextSnapshotId: string | null; state: string };
  resume: { classification: 'safe' | 'requires-review' | 'unavailable'; reasonCode: string; reason: string; permittedNextAction: string };
  continuationRequest: null;
  privacy: {
    scope: 'private-derived'; rawProviderResponsesIncluded: false; credentialValuesIncluded: false;
    privateInputValuesIncluded: false; canonicalArtifactsWritten: false; externalWritesPerformed: false;
  };
}

export interface PreparedWorkReviewMaterial {
  $contract: 'soter://contracts/prepared-work-review-material/v1';
  contractVersion: '1.0.0';
  fingerprint: string;
  createdAt: string;
  workId: string;
  preparedWorkFingerprint: string;
  checkpointId: string;
  checkpointFingerprint: string;
  automation: { id: string; version: string };
  configuration: { name: string; configurationBasis: ConfigurationBasis; lockFingerprint: string };
  inputContractFingerprint: string;
  applicability: 'current' | 'stale';
  fields: Array<
    | {
      id: string;
      exposure: 'identifier' | 'private';
      state: 'omitted';
      fingerprint: null;
      reviewValue?: never;
    }
    | {
      id: string;
      exposure: 'identifier' | 'private';
      state: 'provided';
      fingerprint: string;
      reviewValue: string | boolean;
    }
  >;
  privacy: {
    scope: 'private-local-review';
    authority: 'none';
    projection: 'selected-work-only';
  };
}

export interface PreparedWorkReviewError {
  code: string;
  reasonCode?: string;
  message: string;
}

export type PreparedWorkReviewResult =
  | { ok: true; material: PreparedWorkReviewMaterial }
  | { ok: false; error: PreparedWorkReviewError };

export interface PreparedReviewCollection {
  $contract: 'soter://contracts/prepared-work-review-collection/v1';
  contractVersion: '1.0.0';
  id: string;
  kind: string;
  labelKey: string;
  coverage: {
    complete: boolean;
    observedCount: number;
    includedCount: number;
    excludedCount: number;
    exclusions: Array<{ reasonCode: string; count: number }>;
  };
  rows: PreparedReviewRow[];
  fingerprint: string;
}

export interface PreparedReviewRow {
  id: string;
  sequence: number;
  representedCount: number;
  subject: { kind: string; fingerprint: string };
  group: string;
  attention: 'operator' | 'provider' | 'other-participant' | 'no-one' | 'unknown';
  disposition: 'itemized' | 'collapsed' | 'handoff';
  reasonCode: string;
  flags: string[];
  actions: PreparedReviewAction[];
  privateDetailFingerprint: string | null;
  fingerprint: string;
}

export type PreparedReviewAction =
  | {
    id: string; kind: string; capability: string; effect: 'write' | 'dispatch' | 'destructive';
    state: 'proposed'; reasonCode: string; changeFingerprint: string;
  }
  | {
    id: string; kind: string; capability: string; effect: 'write' | 'dispatch' | 'destructive';
    state: 'held' | 'prohibited'; reasonCode: string; changeFingerprint: null;
  }
  | {
    id: string; kind: string; capability: null; effect: null;
    state: 'handoff'; reasonCode: string;
  }
  | {
    id: string; kind: string; capability: null; effect: 'dispatch' | 'destructive' | null;
    state: 'held' | 'prohibited'; reasonCode: string;
  };

export type PreparedDerivedReviewField =
  | { id: string; label: string; type: 'text'; fingerprint: string; reviewValue: string }
  | { id: string; label: string; type: 'boolean'; fingerprint: string; reviewValue: boolean }
  | { id: string; label: string; type: 'string-list'; fingerprint: string; reviewValue: string[] };

export interface PreparedWorkDerivedReviewMaterial {
  $contract: 'soter://contracts/prepared-work-derived-review-material/v1';
  contractVersion: '1.0.0';
  fingerprint: string;
  contentFingerprint: string;
  createdAt: string;
  workId: string;
  preparedWorkFingerprint: string;
  checkpointId: string;
  checkpointFingerprint: string;
  automation: { id: string; version: string };
  configuration: { name: string; configurationBasis: ConfigurationBasis; lockFingerprint: string };
  inputContractFingerprint: string;
  reviewContractId: 'soter://contracts/automation-derived-review/v1';
  reviewContractFingerprint: string;
  applicability: 'current' | 'stale';
  kind: string;
  items: Array<{
    id: string;
    kind: string;
    sources: Array<{ collectionId: string; rowId: string; rowFingerprint: string }>;
    fields: PreparedDerivedReviewField[];
    fingerprint: string;
  }>;
  privacy: {
    scope: 'private-local-derived-review'; authority: 'none'; projection: 'selected-work-only';
    rawProviderResponsesIncluded: false; rawMessageBodiesIncluded: false;
    workspaceInspectionIncluded: false; evidenceIncluded: false; canonicalArtifactsIncluded: false;
  };
}

export type PreparedWorkDerivedReviewResult =
  | { ok: true; material: PreparedWorkDerivedReviewMaterial }
  | { ok: false; error: PreparedWorkReviewError };

export interface AutomationReview {
  $contract: 'soter://contracts/automation-review/v1';
  contractVersion: '1.0.0';
  kind: string;
  fingerprint: string;
  facts: Array<{
    id: string;
    label: string;
    value: string | number | boolean | null;
    state: 'supported' | 'contradicted' | 'unavailable';
    basisIds: string[];
  }>;
  contradictions: Array<{
    id: string;
    claim: string;
    state: 'observed';
    basisIds: string[];
  }>;
  collections: PreparedReviewCollection[];
  privateReview:
    | {
      state: 'available';
      kind: string;
      contractId: 'soter://contracts/automation-derived-review/v1';
      contractFingerprint: string;
      contentFingerprint: string;
    }
    | {
      state: 'unavailable';
      kind: null;
      contractId: null;
      contractFingerprint: null;
      contentFingerprint: null;
    };
  proposedChanges: Array<{
    id: string;
    recordId: string;
    effect: string;
    beforeFingerprint: string | null;
    afterFingerprint: string | null;
  }>;
}

export interface AutomationProposal {
  $contract: 'soter://contracts/automation-proposal/v1';
  contractVersion: '1.0.0';
  id: string;
  automation: { id: string; version: string };
  runId: string;
  createdAt: string;
  configurationLockFingerprint: string;
  graphFingerprint: string;
  decision: {
    id: string;
    fingerprint: string;
    decisionType: string;
    contextSnapshotId: string;
    contextSnapshotFingerprint: string;
  };
  producer: { kind: 'host' | 'user' | 'fixture'; id: string; host: string | null };
  state: 'ready-for-review';
  proposalType: string;
  review: AutomationReview;
  limitations: string[];
  authority: {
    state: 'none';
    reasonCode: 'AUTOMATION_PROPOSAL_REVIEW_ONLY';
    permittedNextAction: 'inspect-private-proposal-material';
  };
  privacy: {
    scope: 'private-sanitized-proposal';
    rawProviderResponsesIncluded: false;
    credentialValuesIncluded: false;
    privateValuesIncluded: false;
    workspaceInspectionIncluded: false;
    evidenceIncluded: false;
    canonicalArtifactsWritten: false;
    externalWritesPerformed: false;
  };
  proposalFingerprint: string;
}

export interface AutomationProposalMaterial {
  $contract: 'soter://contracts/automation-proposal-material/v1';
  contractVersion: '1.0.0';
  createdAt: string;
  proposal: { id: string; fingerprint: string };
  decision: { id: string; fingerprint: string };
  automation: { id: string; version: string };
  configuration: { name: string; lockFingerprint: string; graphFingerprint: string };
  reviewContractId: 'soter://contracts/automation-derived-review/v1';
  reviewContractFingerprint: string;
  applicability: 'current' | 'stale';
  kind: string;
  contentFingerprint: string;
  items: Array<{
    id: string;
    kind: string;
    sources: Array<{ collectionId: string; rowId: string; rowFingerprint: string }>;
    fields: PreparedDerivedReviewField[];
    fingerprint: string;
  }>;
  authority: { state: 'none'; reasonCode: 'AUTOMATION_PROPOSAL_MATERIAL_REVIEW_ONLY' };
  privacy: {
    scope: 'private-local-automation-proposal';
    projection: 'selected-proposal-only';
    rawProviderResponsesIncluded: false;
    credentialValuesIncluded: false;
    workspaceInspectionIncluded: false;
    evidenceIncluded: false;
    canonicalArtifactsIncluded: false;
  };
  fingerprint: string;
}

export interface AutomationProposalRequest {
  proposalId: string;
  configurationName: string;
  lockFingerprint: string;
}

export type AutomationProposalResult =
  | { ok: true; proposal: AutomationProposal }
  | { ok: false; error: PreparedWorkReviewError };

export type AutomationProposalMaterialResult =
  | { ok: true; material: AutomationProposalMaterial }
  | { ok: false; error: PreparedWorkReviewError };

export interface ConnectedChangeSetV2Operation {
  id: string;
  sequence: number;
  sourceActionId: string;
  capability: string;
  authority: string;
  reason: string;
  input: Record<string, unknown>;
  inputFingerprint: string;
  state: 'pending' | 'passed' | 'failed';
  effectId: string | null;
  outputFingerprint: string | null;
  error: Record<string, unknown> | null;
}

export interface ConnectedChangeSetV2 {
  $contract: 'soter://contracts/connected-change-set/v2';
  contractVersion: '2.0.0';
  id: string;
  runId: string;
  createdAt: string;
  configurationLockFingerprint: string;
  basis: {
    kind: 'automation-proposal';
    proposal: { id: string; fingerprint: string };
    decision: { id: string; fingerprint: string };
    automation: { id: string; version: string };
    actionIds: string[];
    selectionFingerprint: string;
  };
  state: 'proposed' | 'approved' | 'executing' | 'committed' | 'failed';
  scopeFingerprint: string;
  operations: ConnectedChangeSetV2Operation[];
  approvalId: string | null;
  transaction: {
    checkpointFingerprint: string;
    state: 'not-started' | 'committed' | 'failed';
    rollbackState: 'not-available';
    restoredFingerprint: null;
  };
  verification: {
    state: 'passed' | 'failed' | 'unknown';
    effectId: string | null;
    criteria: string[];
    observedFingerprint: string | null;
  };
}

export interface ConnectedOperationProviderV2 {
  pack: string;
  connectedImplementation: string;
  version: string;
}

export interface ConnectedOperationBatchV2Operation {
  id: string;
  sequence: number;
  sourceActionId: string;
  capability: string;
  authority: string;
  provider: ConnectedOperationProviderV2;
  effect: 'write';
  input: Record<string, unknown>;
  inputFingerprint: string;
  precondition:
    | { kind: 'none'; capability: null; input: null; inputFingerprint: null; expectation: null }
    | {
      kind: 'expectation'; capability: string; provider: ConnectedOperationProviderV2;
      input: Record<string, unknown>; inputFingerprint: string;
      expectation: { kind: string; expectedFingerprint: string };
    };
  verification: {
    capability: string;
    provider: ConnectedOperationProviderV2;
    input: Record<string, unknown>;
    inputFingerprint: string;
    expectation: { kind: string; expectedFingerprint: string };
  };
  review: {
    subject: { kind: 'portable-resource'; type: string; id: string | null };
    before:
      | { state: 'not-required'; reasonCode: 'PRIOR_VALUE_NOT_REQUIRED'; fingerprint: null }
      | { state: 'absent-required'; reasonCode: 'DEDUPLICATION_ABSENCE_REQUIRED'; fingerprint: null };
    after: { state: 'provided'; fingerprint: string; reviewValue: Record<string, unknown> };
    precondition: { fingerprint: string; reviewValue: Record<string, unknown> };
  };
  ambiguity: {
    retry: 'prohibited';
    reconcileWith: 'verification';
    unresolvedState: 'needs-attention';
    reasonCode: string;
  };
  recovery: { mode: 'manual-required'; reasonCode: string };
}

export interface ConnectedOperationBatchV2 {
  $contract: 'soter://contracts/connected-operation-batch/v2';
  contractVersion: '2.0.0';
  id: string;
  runId: string;
  createdAt: string;
  configurationLockFingerprint: string;
  changeSet: { id: string; scopeFingerprint: string };
  automation: { id: string; version: string };
  compiler: {
    module: string;
    moduleFingerprint: string;
    compileExport: string;
    evaluateExport: string;
  };
  profile: 'verified-write-sequence';
  state: 'proposed';
  executable: true;
  blockers: [];
  operations: ConnectedOperationBatchV2Operation[];
  batchFingerprint: string;
}

export interface ProposalConnectedBatchPreview {
  changeSet: ConnectedChangeSetV2;
  batch: ConnectedOperationBatchV2;
  selection: {
    availableActionCount: number;
    selectedActionCount: number;
    partial: boolean;
    actionIds: string[];
    fingerprint: string;
  };
  authority: {
    state: 'none';
    reasonCode: 'CONNECTED_BATCH_PREVIEW_ONLY';
    permittedNextAction: 'request-exact-approval';
  };
  providerCallsExecuted: 0;
  externalWritesPerformed: 0;
}

export interface ProposalConnectedBatchRequest extends AutomationProposalRequest {
  actionIds: string[];
}

export type ProposalConnectedBatchResult =
  | { ok: true; preview: ProposalConnectedBatchPreview }
  | { ok: false; error: PreparedWorkReviewError };

export type ProposalConnectedApprovalResult =
  | { ok: true; inspection: OperatorInspection }
  | { ok: false; error: PreparedWorkReviewError };

export type ConnectedOperatorActionResult =
  | { ok: true; inspection: OperatorInspection }
  | { ok: false; error: PreparedWorkReviewError };

export interface ConnectedTransactionCheckpointV2 {
  $contract: 'soter://contracts/connected-transaction-checkpoint/v2';
  contractVersion: '2.0.0';
  id: string;
  kind: 'connected-transaction';
  profile: 'verified-write-sequence';
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  state: 'requested' | 'completed' | 'failed' | 'needs-attention';
  configurationLock: { path: string; fingerprint: string };
  graphFingerprint: string;
  host: { id: string; adapter: string; version: string };
  run: { id: string; sourcePath: string; statePath: string; fingerprint: string };
  batch: ConnectedOperationBatchV2;
  batchFingerprint: string;
  changeSet: ConnectedChangeSetV2;
  changeSetFingerprint: string;
  approval: Record<string, unknown>;
  approvalFingerprint: string;
  operations: Array<{
    id: string;
    sequence: number;
    state: 'pending' | 'preconditioning' | 'writing' | 'verifying' | 'applied' | 'failed' | 'needs-attention' | 'reconciling';
    precondition: ConnectedTransactionPhase | null;
    write: ConnectedTransactionPhase | null;
    verification: ConnectedTransactionPhase | null;
    ambiguity: null | {
      id: string; stage: 'write' | 'verify'; callId: string | null; createdAt: string;
      error: Record<string, unknown>; status: 'unresolved' | 'resolved'; resolvedAt: string | null;
      resolution: 'expected-state' | 'unexpected-state' | null;
    };
    reconciliations: Array<{
      id: string; ambiguityId: string; createdAt: string; phase: ConnectedTransactionPhase;
      outcome: 'passed' | 'failed' | 'read-failed' | null; observedFingerprint: string | null;
    }>;
    observedFingerprint: string | null;
    error: Record<string, unknown> | null;
  }>;
  current: null | {
    operationId: string;
    stage: 'precondition' | 'write' | 'verify' | 'reconcile';
    callId: string;
    reconciliationId: string | null;
  };
  result: null | {
    state: 'completed' | 'failed' | 'needs-attention';
    appliedOperationIds: string[];
    error: Record<string, unknown> | null;
  };
  privacy: { scope: 'private'; rawProviderResponsePersisted: false; hostCredentialValuesPersisted: false };
  checkpointFingerprint: string;
}

export interface ConnectedTransactionPhase {
  call: Record<string, unknown>;
  output: Record<string, unknown> | null;
  outputFingerprint: string | null;
  error: Record<string, unknown> | null;
}

export interface PreparedReviewBatchAction {
  id: string;
  sequence: number;
  kind: string;
  reasonCode: string;
  capability: string;
  effect: 'write' | 'dispatch' | 'destructive';
  source: { collectionId: string; rowId: string; rowFingerprint: string };
  subjectFingerprint: string;
  sourceActionFingerprint: string;
  changeFingerprint: string;
  contextValueFingerprint: string | null;
  proposedValueFingerprint: string;
}

export interface PreparedReviewBatch {
  $contract: 'soter://contracts/prepared-review-batch/v1';
  contractVersion: '1.0.0';
  id: string;
  fingerprint: string;
  createdAt: string;
  work: {
    id: string; fingerprint: string; checkpointId: string; checkpointFingerprint: string;
    automationId: string; automationVersion: string;
  };
  configuration: {
    name: string; path: string; lockPath: string; configurationBasis: ConfigurationBasis; lockFingerprint: string;
    graphFingerprint: string; host: string;
  };
  preview: {
    kind: string; fingerprint: string; privateReviewKind: string;
    privateReviewContentFingerprint: string;
  };
  state: 'review-only';
  effects: Array<'write' | 'dispatch' | 'destructive'>;
  scope: { availableActionCount: number; selectedActionCount: number; partial: boolean; fingerprint: string };
  actions: PreparedReviewBatchAction[];
  blockers: Array<'CONNECTED_PLAN_NOT_COMPILED' | 'CONNECTED_VERIFICATION_NOT_PROVEN'>;
  privacy: {
    scope: 'private-local-review-batch'; authority: 'none'; projection: 'selected-batch-only';
    privateValuesIncluded: false; providerArgumentsIncluded: false; rawProviderResponsesIncluded: false;
    credentialValuesIncluded: false; workspaceInspectionIncluded: false; evidenceIncluded: false;
    canonicalArtifactsIncluded: false; approvalAuthorityIncluded: false;
    continuationAuthorityIncluded: false; executionAuthorityIncluded: false;
  };
}

export interface PreparedReviewBatchMaterial {
  $contract: 'soter://contracts/prepared-review-batch-material/v1';
  contractVersion: '1.0.0';
  fingerprint: string;
  batch: { id: string; fingerprint: string; createdAt: string; state: 'review-only' };
  work: {
    id: string; fingerprint: string; checkpointId: string;
    checkpointFingerprint: string; automationId: string;
  };
  configuration: PreparedReviewBatch['configuration'] & { applicability: 'current' | 'stale' };
  scope: PreparedReviewBatch['scope'];
  effects: PreparedReviewBatch['effects'];
  actions: Array<{
    selection: PreparedReviewBatchAction;
    context: PreparedWorkDerivedReviewMaterial['items'][number] | null;
    proposed: PreparedWorkDerivedReviewMaterial['items'][number];
  }>;
  blockers: PreparedReviewBatch['blockers'];
  privacy: {
    scope: 'private-local-review-batch-material'; authority: 'none'; projection: 'selected-batch-only';
    providerArgumentsIncluded: false; rawProviderResponsesIncluded: false; credentialValuesIncluded: false;
    workspaceInspectionIncluded: false; evidenceIncluded: false; canonicalArtifactsIncluded: false;
    approvalAuthorityIncluded: false; continuationAuthorityIncluded: false; executionAuthorityIncluded: false;
  };
}

export type PreparedReviewBatchCreateResult =
  | { ok: true; batch: PreparedReviewBatch }
  | { ok: false; error: PreparedWorkReviewError };

export type PreparedReviewBatchMaterialResult =
  | { ok: true; material: PreparedReviewBatchMaterial }
  | { ok: false; error: PreparedWorkReviewError };

export interface PreparedConnectedPlanProvider {
  pack: string;
  connectedImplementation: string | null;
  version?: string | null;
}

export interface PreparedConnectedPlanOperation {
  id: string;
  sequence: number;
  sourceActionId: string;
  capability: string;
  authority: string;
  provider: PreparedConnectedPlanProvider;
  effect: 'write' | 'dispatch' | 'destructive';
  input: Record<string, unknown>;
  inputFingerprint: string;
  precondition?:
    | { kind: 'none'; capability: null; input: null; inputFingerprint: null; expectation: null }
    | {
      kind: 'expectation'; capability: string; provider: PreparedConnectedPlanProvider;
      input: Record<string, unknown>; inputFingerprint: string;
      expectation: { kind: string; expectedFingerprint: string };
    };
  verification: {
    capability: string;
    provider: PreparedConnectedPlanProvider;
    input: Record<string, unknown>;
    inputFingerprint: string;
    expectation: { kind: string; expectedFingerprint: string };
  };
  review?: {
    subject: { kind: 'portable-resource'; type: string; id: string | null };
    before:
      | { state: 'not-required'; reasonCode: 'PRIOR_VALUE_NOT_REQUIRED'; fingerprint: null }
      | { state: 'absent-required'; reasonCode: 'DEDUPLICATION_ABSENCE_REQUIRED'; fingerprint: null };
    after: { state: 'provided'; fingerprint: string; reviewValue: Record<string, unknown> };
    precondition: { fingerprint: string; reviewValue: Record<string, unknown> };
  };
  ambiguity: {
    retry: 'prohibited';
    reconcileWith: 'verification';
    unresolvedState: 'needs-attention';
    reasonCode: string;
  };
  recovery: { mode: 'manual-required'; reasonCode: string };
}

export interface PreparedConnectedPlan {
  $contract: 'soter://contracts/prepared-connected-plan/v1';
  contractVersion: '1.0.0';
  id: string;
  fingerprint: string;
  createdAt: string;
  source: {
    batchId: string; batchFingerprint: string; workId: string; workFingerprint: string;
    checkpointId: string; checkpointFingerprint: string;
    automationId: string; automationVersion: string;
  };
  configuration: PreparedReviewBatch['configuration'] & { applicability: 'current' | 'stale' };
  compiler: {
    module: string; moduleFingerprint: string; compileExport: string; evaluateExport: string;
  };
  state: 'blocked-review-only';
  executable: false;
  effects: Array<'write' | 'dispatch' | 'destructive'>;
  operations: PreparedConnectedPlanOperation[];
  blockers: Array<
    | 'CONNECTED_PROVIDER_NOT_DECLARED'
    | 'CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED'
    | 'CONNECTED_VERIFICATION_NOT_PROVEN'
    | 'SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE'
  >;
  privacy: {
    scope: 'private-local-prepared-connected-plan'; authority: 'none'; projection: 'selected-plan-only';
    privateValuesIncluded: true; providerArgumentsIncluded: true; rawProviderResponsesIncluded: false;
    credentialValuesIncluded: false; workspaceInspectionIncluded: false; evidenceIncluded: false;
    canonicalArtifactsIncluded: false; approvalAuthorityIncluded: false;
    continuationAuthorityIncluded: false; executionAuthorityIncluded: false; retryAuthorityIncluded: false;
  };
}

export type PreparedConnectedPlanResult =
  | { ok: true; plan: PreparedConnectedPlan }
  | { ok: false; error: PreparedWorkReviewError };

export interface PreparedContextStep {
  id: string; sequence: number; label: string; capability: string; authority: string;
  containment: 'fixture'; state: 'pending' | 'completed' | 'blocked';
  inputFingerprint: string | null; outputFingerprint: string | null; limitation: string;
}

export type EffectMode = 'allow' | 'confirm' | 'prohibit';

export interface ConfigurationPreviewRequest {
  name: string;
  configurationBasis: ConfigurationBasis;
  draft?: {
    hostAdapter?: string;
    effectPolicies?: Partial<Record<'read' | 'disclosure' | 'write' | 'dispatch' | 'destructive', EffectMode>>;
    addPacks?: string[];
  };
}

export interface ConfigurationPreview {
  $contract: 'soter://contracts/configuration-preview/v1';
  contractVersion: '1.0.0';
  configuration: {
    name: string;
    sourcePath: string;
    configurationBasis: ConfigurationBasis;
    host: string;
    lockFingerprint: string;
    graphFingerprint: string;
  };
  draft: {
    valid: boolean;
    changed: boolean;
    host: string;
    addedPacks: string[];
    lockFingerprint: string | null;
    graphFingerprint: string | null;
  };
  changes: Array<{
    category: 'host' | 'effect-policy' | 'pack';
    subject: string;
    state: 'unchanged' | 'changed';
    before: string;
    after: string;
    impact: string;
  }>;
  options: {
    hosts: Array<{
      id: string;
      adapter: string;
      version: string;
      current: boolean;
      compatible: boolean;
      limitations: string[];
    }>;
    effectModes: EffectMode[];
    packs: Array<{
      id: string;
      version: string;
      layer: string;
      selected: boolean;
      base: boolean;
      selectable: boolean;
      summary: string;
      effects: string[];
      dependencies: string[];
      requiredCapabilities: string[];
      scenarioCount: number;
    }>;
  };
  evidenceImpact: {
    state: 'preserved' | 'invalidated' | 'unknown';
    reason: string;
  };
  diagnostics: Array<{
    code: string;
    severity: 'error' | 'warning' | 'info';
    subject: string;
    message: string;
    remediation: string;
  }>;
  apply: { supported: false; reason: string };
}

export interface ConfigurationChangeInspection {
  $contract: 'soter://contracts/configuration-change-inspection/v1';
  contractVersion: '1.0.0';
  plan: { id: string; fingerprint: string };
  configuration: {
    name: string;
    sourceKind: 'tracked-template' | 'private-active';
    baselineLockFingerprint: string;
    candidateLockFingerprint: string;
    candidateGraphFingerprint: string;
    observedLockFingerprint: string | null;
    applicability: 'current' | 'stale' | 'applied';
  };
  scope: {
    fingerprint: string;
    changes: Array<{
      id: string;
      category: 'host' | 'pack' | 'binding' | 'source' | 'authority' | 'effect-policy' | 'secret-reference' | 'setting';
      subject: string;
      state: 'added' | 'removed' | 'changed';
      beforeDescriptor: string | null;
      afterDescriptor: string | null;
      beforeFingerprint: string | null;
      afterFingerprint: string | null;
    }>;
  };
  request: null | {
    id: string;
    fingerprint: string;
    createdAt: string;
    expiresAt: string;
    state: 'awaiting' | 'expired' | 'confirmed';
  };
  confirmation: null | {
    id: string;
    fingerprint: string;
    confirmedAt: string;
    actor: string;
  };
  consumption: null | {
    id: string;
    fingerprint: string;
    state: 'reserved' | 'started';
  };
  checkpoint: null | {
    id: string;
    fingerprint: string;
    state: 'prepared' | 'applying' | 'verifying' | 'completed' | 'rolling-back' | 'rolled-back' | 'needs-attention';
    phase: string;
    updatedAt: string;
    reasonCode: string | null;
  };
  resume: {
    classification: 'safe' | 'requires-review' | 'unavailable';
    reasonCode: string;
    reason: string;
    permittedNextAction: 'request-confirmation' | 'confirm' | 'apply' | 'inspect-checkpoint' | 'none';
  };
  authority: { kind: 'inspection-only'; grantsExecution: false; grantsProviderWrite: false };
}

export interface ConfigurationChangeError {
  code: string;
  message: string;
}

export type ConfigurationChangeResult =
  | { ok: true; inspection: ConfigurationChangeInspection }
  | { ok: false; error: ConfigurationChangeError };

export interface ConfigurationChangeReferences {
  planId: string;
  requestId?: string;
  confirmationId?: string;
  checkpointId?: string;
}

export interface HostRealizationInspection {
  $contract: 'soter://contracts/host-realization-inspection/v1';
  contractVersion: '1.0.0';
  plan: {
    id: string;
    fingerprint: string;
    createdAt: string;
    validUntil: string;
    applicability: 'current' | 'stale' | 'expired' | 'applied';
  };
  target: { fingerprint: string };
  host: {
    id: string;
    adapter: string;
    definition: { id: string; version: string; fingerprint: string };
    generator: { id: string; version: string; fingerprint: string };
  };
  configuration: { name: string; lockFingerprint: string; graphFingerprint: string };
  scope: {
    fingerprint: string;
    outputs: Array<{
      id: string;
      sequence: number;
      path: string;
      role: 'instructions' | 'skills' | 'tools' | 'lifecycle' | 'configuration';
      action: 'create' | 'replace' | 'remove';
      mode: string | null;
      beforeFingerprint: string | null;
      afterFingerprint: string | null;
    }>;
  };
  request: null | { id: string; fingerprint: string; state: 'pending' | 'current' | 'expired' | 'confirmed' | 'reserved' | 'started'; at: string | null };
  confirmation: null | { id: string; fingerprint: string; state: 'confirmed'; at: string; actor: string };
  consumption: null | { id: string; fingerprint: string; state: 'pending' | 'current' | 'expired' | 'confirmed' | 'reserved' | 'started'; at: string | null };
  checkpoint: null | {
    id: string;
    fingerprint: string;
    state: 'prepared' | 'applying' | 'verifying' | 'completed' | 'rolling-back' | 'rolled-back' | 'needs-attention';
    phase: 'prepared' | 'directories' | 'outputs' | 'manifest' | 'verifying' | 'rollback' | 'terminal';
    currentOutputId: string | null;
    outputs: Array<{ id: string; sequence: number; state: 'pending' | 'applied' | 'verified' | 'rolled-back' }>;
    failure: null | { reasonCode: string; summary: string };
  };
  resume: {
    classification: 'safe' | 'requires-review' | 'unavailable';
    reasonCode: string;
    reason: string;
    permittedNextAction: 'request-confirmation' | 'confirm' | 'start' | 'execute-checkpoint' | 'recover-checkpoint' | 'inspect-checkpoint' | 'replan' | 'none';
  };
  claims: {
    localProjection: 'unknown' | 'passed';
    hostLaunch: 'unknown';
    toolDiscovery: 'unknown';
    authentication: 'unknown';
    providerReachability: 'unknown';
    connectedBehavior: 'unknown';
    health: 'unknown';
  };
  inspectionFingerprint: string;
}

export type HostRealizationResult =
  | { ok: true; inspection: HostRealizationInspection }
  | { ok: false; error: { code: string; message: string } };

export interface HostRealizationReferences {
  planId: string;
  requestId?: string;
  confirmationId?: string;
  consumptionId?: string;
  checkpointId?: string;
}

export interface DistributionLimitation {
  code: string;
  summary: string;
}

export interface DistributionLegalBoundary {
  publisher: { state: 'unasserted' };
  license: { state: 'no-assertion' };
  publicationEligibility: 'not-evaluated';
  redistributionEligibility: 'not-evaluated';
  marketplaceEligibility: 'not-evaluated';
  legalSufficiency: 'not-evaluated';
}

export interface DistributionTrustBoundary {
  state: 'unsigned-untrusted';
  signature: 'absent';
}

export interface PackReleaseInspection {
  $contract: 'soter://contracts/pack-release-inspection/v1';
  contractVersion: '1.0.0';
  kind: 'pack-release';
  release: {
    id: string;
    version: string;
    layer: 'kernel' | 'core' | 'context' | 'automation' | 'integration';
    releaseStage: 'experimental' | 'preview' | 'stable' | 'deprecated';
    evidenceMaturity: 'declared' | 'fixture-proven' | 'contained-proven' | 'live-proven';
    summary: string;
    capsuleDigest: string;
    createdAt: string;
    generator: { id: string; version: string; fingerprint: string };
    manifestFingerprint: string;
    sourceInputFingerprint: string;
  };
  integrity: { state: 'passed'; reasonCode: 'PACK_RELEASE_BYTES_VERIFIED'; inventoryFingerprint: string };
  sourceComparison:
    | { state: 'passed'; reasonCode: 'PACK_RELEASE_SOURCE_MATCH' }
    | { state: 'failed'; reasonCode: 'PACK_RELEASE_SOURCE_MISMATCH' }
    | { state: 'unknown'; reasonCode: 'PACK_RELEASE_SOURCE_NOT_EVALUATED' };
  provenance:
    | {
      kind: 'git';
      revision: string;
      remoteLocatorFingerprint: string | null;
      exactInputState: 'clean' | 'dirty' | 'unknown';
      inputFingerprint: string;
      reproducibilityClaim: 'contained-determinism-only';
    }
    | {
      kind: 'filesystem';
      revision: null;
      remoteLocatorFingerprint: null;
      exactInputState: 'unknown';
      inputFingerprint: string;
      reproducibilityClaim: 'contained-determinism-only';
    };
  packageIntent:
    | { state: 'present'; private: boolean; sourceFingerprint: string; interpretation: 'packaging-intent-only' }
    | { state: 'absent'; private: null; sourceFingerprint: null; interpretation: 'packaging-intent-only' }
    | { state: 'unavailable'; private: null; sourceFingerprint: string | null; interpretation: 'packaging-intent-only' };
  legal: DistributionLegalBoundary;
  trust: DistributionTrustBoundary;
  inventory: Array<{
    path: string;
    role: 'manifest' | 'definition' | 'implementation' | 'projection' | 'evaluation' | 'fixture' | 'migration';
    mode: '0644' | '0755';
    bytes: number;
    contentFingerprint: string;
  }>;
  constraints: {
    dependencies: Array<{ pack: string; version: string; optional: boolean; reason: string }>;
    capabilities: {
      requires: Array<{ id: string; version: string; optional: boolean; reason: string }>;
      provides: Array<{ id: string; version: string }>;
    };
    authorities: Array<{ role: 'definition' | 'instance' | 'provider' | 'projection' | 'evidence'; subject: string; required: boolean }>;
    effects: Array<'read' | 'disclosure' | 'write' | 'dispatch' | 'destructive'>;
    compatibility: { baseContract: string; hosts: string[] };
  };
  evidenceReferences: Array<{
    id: string;
    fingerprint: string;
    graphFingerprint: string;
    result: 'passed';
    privacyScope: 'shareable' | 'public';
    validUntil: string | null;
    applicableManifestFingerprint: string;
    limitations: string[];
  }>;
  claims: {
    localReleaseBytes: 'passed';
    dependencyResolution: 'not-evaluated';
    installed: 'unknown';
    configured: 'unknown';
    ready: 'unknown';
    verified: 'unknown';
    healthy: 'unknown';
    networkAvailability: 'unknown';
    publisherIdentity: 'not-evaluated';
    publicationAuthority: 'not-evaluated';
    redistributionAuthority: 'not-evaluated';
    marketplaceEligibility: 'not-evaluated';
    trust: 'not-evaluated';
  };
  authority: {
    install: false;
    configure: false;
    realizeHost: false;
    publish: false;
    redistribute: false;
    marketplace: false;
    trust: false;
  };
  privacy: {
    capsuleBytesIncluded: false;
    sourceRootIncluded: false;
    privateStateIncluded: false;
    credentialValuesIncluded: false;
    rawProviderResponsesIncluded: false;
    activeConfigurationIncluded: false;
  };
  limitations: DistributionLimitation[];
  inspectionFingerprint: string;
}

export interface BundleInspection {
  $contract: 'soter://contracts/bundle-inspection/v1';
  contractVersion: '1.0.0';
  kind: 'bundle';
  bundle: {
    id: string;
    version: string;
    summary: string;
    releaseStage: 'experimental' | 'preview' | 'stable' | 'deprecated';
    evidenceMaturity: 'declared';
    digest: string;
    createdAt: string;
    target: { baseContract: string; hosts: string[] };
  };
  integrity: { state: 'passed'; reasonCode: 'BUNDLE_BYTES_VERIFIED' };
  resolution:
    | {
      state: 'resolved';
      reasonCode: 'BUNDLE_RESOLVED';
      catalogFingerprint: string;
      resolutionFingerprint: string;
      blockers: [];
    }
    | {
      state: 'blocked';
      reasonCode: 'BUNDLE_BLOCKED';
      catalogFingerprint: string;
      resolutionFingerprint: string;
      blockers: Array<{ code: string; referenceId: string | null; pack: string; summary: string }>;
    };
  references: Array<({
    id: string;
    pack: string;
    selection: { kind: 'exact'; version: string; capsuleDigest: string } | { kind: 'compatible'; version: string };
    reason: string;
    compatibilityLimitations: string[];
  } & ({
    state: 'selected';
    selectedRelease: {
      pack: string;
      version: string;
      capsuleDigest: string;
      releaseStage: 'experimental' | 'preview' | 'stable' | 'deprecated';
      evidenceMaturity: 'declared' | 'fixture-proven' | 'contained-proven' | 'live-proven';
    };
  } | { state: 'blocked'; selectedRelease: null }))>;
  aggregate: {
    packs: string[];
    dependencies: Array<{ consumer: string; pack: string; version: string; optional: boolean }>;
    authorities: string[];
    effects: Array<'read' | 'disclosure' | 'write' | 'dispatch' | 'destructive'>;
    compatibleHosts: string[];
  };
  legal: DistributionLegalBoundary;
  trust: DistributionTrustBoundary;
  claims: {
    localBundleBytes: 'passed';
    referencedReleaseBytes: 'passed' | 'unknown';
    installed: 'unknown';
    configured: 'unknown';
    ready: 'unknown';
    verified: 'unknown';
    healthy: 'unknown';
    networkAvailability: 'unknown';
    publisherIdentity: 'not-evaluated';
    publicationAuthority: 'not-evaluated';
    redistributionAuthority: 'not-evaluated';
    marketplaceEligibility: 'not-evaluated';
    trust: 'not-evaluated';
  };
  authority: {
    install: false;
    configure: false;
    realizeHost: false;
    publish: false;
    redistribute: false;
    marketplace: false;
    trust: false;
    autoUpdate: false;
  };
  privacy: {
    capsuleBytesIncluded: false;
    sourcePathsIncluded: false;
    privateStateIncluded: false;
    credentialValuesIncluded: false;
    activeConfigurationIncluded: false;
  };
  limitations: DistributionLimitation[];
  inspectionFingerprint: string;
}

export interface DistributionInspectionError {
  code: string;
  message: string;
}

export type PackReleaseInspectionResult =
  | { ok: true; inspection: PackReleaseInspection }
  | { ok: false; error: DistributionInspectionError };

export type BundleInspectionResult =
  | { ok: true; inspection: BundleInspection }
  | { ok: false; error: DistributionInspectionError };

export interface PackInstallInspection {
  $contract: 'soter://contracts/pack-install-inspection/v1';
  contractVersion: '1.0.0';
  kind: 'pack-install';
  plan: null | {
    id: string;
    fingerprint: string;
    createdAt: string;
    validUntil: string;
    targetFingerprint: string;
    baseContract: string;
    runtimeFingerprint: string;
    releases: Array<{
      pack: string;
      version: string;
      layer: 'kernel' | 'core' | 'context' | 'automation' | 'integration';
      capsuleDigest: string;
      manifestFingerprint: string;
      releaseStage: 'experimental' | 'preview' | 'stable' | 'deprecated';
      evidenceMaturity: 'declared' | 'fixture-proven' | 'contained-proven' | 'live-proven';
      legal: { publisher: 'unasserted'; license: 'no-assertion'; legalSufficiency: 'not-evaluated' };
      trust: { state: 'unsigned-untrusted'; signature: 'absent' };
    }>;
    bundle: {
      state: 'absent' | 'present';
      id: string | null;
      version: string | null;
      digest: string | null;
      resolutionFingerprint: string | null;
    };
    dependencyCheck: {
      state: 'passed';
      reasonCode: 'PACK_INSTALL_DEPENDENCIES_RESOLVED';
      rows: Array<{
        consumer: string;
        dependency: string;
        requiredRange: string;
        optional: boolean;
        selectedVersion: string | null;
        state: 'satisfied' | 'degraded';
        reasonCode: 'PACK_INSTALL_DEPENDENCY_SATISFIED' | 'PACK_INSTALL_OPTIONAL_DEPENDENCY_ABSENT';
      }>;
      fingerprint: string;
    };
    effects: Array<{
      id: string;
      sequence: number;
      action: 'create' | 'replace' | 'remove';
      pack: string;
      role: 'manifest' | 'definition' | 'implementation' | 'projection' | 'evaluation' | 'fixture' | 'migration';
      migrationRole: boolean;
      beforeFingerprint: string | null;
      afterFingerprint: string | null;
      reasonCode: 'PACK_INSTALL_FILE_CREATE' | 'PACK_INSTALL_FILE_REPLACE' | 'PACK_INSTALL_FILE_REMOVE';
      effectFingerprint: string;
    }>;
    scopeFingerprint: string;
  };
  request: null | {
    id: string;
    fingerprint: string;
    createdAt: string;
    expiresAt: string;
    reason: string;
    state: 'current' | 'expired';
  };
  confirmation: null | { id: string; fingerprint: string; confirmedAt: string; actor: string };
  consumption: null | { id: string; fingerprint: string; state: 'reserved' | 'started'; checkpointId: string };
  checkpoint: null | {
    id: string;
    fingerprint: string;
    state: 'prepared' | 'applying' | 'committing' | 'completed' | 'rolling-back' | 'rolled-back' | 'failed' | 'needs-attention';
    reasonCode: string;
    currentStep: string | null;
    completedPrefix: string[];
    pendingSteps: string[];
    manifestState: 'pending' | 'written' | 'verified' | 'rolled-back';
    blocker: string | null;
  };
  resume: {
    classification: 'safe' | 'requires-review' | 'unavailable';
    reasonCode: string;
    reason: string;
    permittedNextAction: 'create-request' | 'renew-request' | 'confirm-request' | 'start-install' | 'execute-checkpoint' | 'recover-checkpoint' | 'inspect-install' | 'none';
  };
  claims: {
    localReleaseBytes: 'passed';
    dependencyConstraints: 'passed';
    localMaterialization: 'unknown' | 'passed' | 'failed';
    installedRegistry: 'unknown' | 'passed' | 'failed';
    configured: 'unknown';
    hostRealization: 'unknown';
    npmDependencies: 'not-evaluated';
    ready: 'unknown';
    verified: 'unknown';
    healthy: 'unknown';
    networkAvailability: 'unknown';
    publisherIdentity: 'not-evaluated';
    legalSufficiency: 'not-evaluated';
    trust: 'not-evaluated';
  };
  authority: {
    fetch: false;
    install: false;
    upgrade: false;
    uninstall: false;
    configure: false;
    realizeHost: false;
    executeMigration: false;
    runPackageManager: false;
    network: false;
    publish: false;
    trust: false;
  };
  privacy: {
    targetRootIncluded: false;
    capsulePathsIncluded: false;
    capsuleBytesIncluded: false;
    priorBytesIncluded: false;
    candidateBytesIncluded: false;
    rawManagedManifestIncluded: false;
    privateStateIncluded: false;
    credentialValuesIncluded: false;
    rawProviderResponsesIncluded: false;
  };
  limitations: string[];
  inspectionFingerprint: string;
}

export type PackInstallResult =
  | { ok: true; inspection: PackInstallInspection }
  | { ok: false; error: { code: string; message: string } };

export interface PackInstallReferences {
  planId?: string;
  requestId?: string;
  confirmationId?: string;
  consumptionId?: string;
  checkpointId?: string;
}

declare global {
  interface Window {
    soterStudio: {
      getWorkspaceSnapshot(): Promise<InspectionSnapshot>;
      refreshWorkspaceSnapshot(): Promise<InspectionSnapshot>;
      inspectLocalPackRelease(): Promise<PackReleaseInspectionResult>;
      inspectLocalBundle(): Promise<BundleInspectionResult>;
      preparePackInstall(): Promise<PackInstallResult>;
      beginPackInstallRequest(request: { planId: string }): Promise<PackInstallResult>;
      confirmPackInstallRequest(request: { requestId: string; confirmed: true }): Promise<PackInstallResult>;
      startPackInstall(request: { confirmationId: string }): Promise<PackInstallResult>;
      executePackInstall(request: { checkpointId: string; confirmed: true }): Promise<PackInstallResult>;
      recoverPackInstall(request: { checkpointId: string; confirmed: true }): Promise<PackInstallResult>;
      inspectPackInstall(request: PackInstallReferences): Promise<PackInstallResult>;
      previewConfiguration(request: ConfigurationPreviewRequest): Promise<ConfigurationPreview>;
      prepareConfigurationChange(request: { name: string; candidateConfiguration: Record<string, unknown> }): Promise<ConfigurationChangeResult>;
      beginConfigurationChangeRequest(request: { planId: string; reason: string }): Promise<ConfigurationChangeResult>;
      confirmConfigurationChangeRequest(request: { requestId: string; confirmed: true }): Promise<ConfigurationChangeResult>;
      startConfigurationChange(request: { confirmationId: string }): Promise<ConfigurationChangeResult>;
      executeConfigurationChange(request: { checkpointId: string; confirmed: true }): Promise<ConfigurationChangeResult>;
      recoverConfigurationChange(request: { checkpointId: string; confirmed: true }): Promise<ConfigurationChangeResult>;
      inspectConfigurationChange(request: ConfigurationChangeReferences): Promise<ConfigurationChangeResult>;
      prepareHostRealization(request: { configurationName: string }): Promise<HostRealizationResult>;
      beginHostRealizationRequest(request: { planId: string }): Promise<HostRealizationResult>;
      confirmHostRealizationRequest(request: { requestId: string; confirmed: true }): Promise<HostRealizationResult>;
      startHostRealization(request: { confirmationId: string }): Promise<HostRealizationResult>;
      executeHostRealization(request: { checkpointId: string; confirmed: true }): Promise<HostRealizationResult>;
      recoverHostRealization(request: { checkpointId: string; confirmed: true }): Promise<HostRealizationResult>;
      inspectHostRealization(request: HostRealizationReferences): Promise<HostRealizationResult>;
      getOperatorActivity(request: { requestId?: string; approvalId?: string; checkpointId?: string }): Promise<OperatorInspection>;
      getPreparedWork(request: { workId: string }): Promise<PreparedWork>;
      getPreparedWorkReview(request: { workId: string }): Promise<PreparedWorkReviewResult>;
      getPreparedWorkDerivedReview(request: { workId: string }): Promise<PreparedWorkDerivedReviewResult>;
      createPreparedReviewBatch(request: { workId: string; actionIds: string[] }): Promise<PreparedReviewBatchCreateResult>;
      getPreparedReviewBatchMaterial(request: { batchId: string }): Promise<PreparedReviewBatchMaterialResult>;
      createPreparedConnectedPlan(request: { batchId: string }): Promise<PreparedConnectedPlanResult>;
      getPreparedConnectedPlan(request: { planId: string }): Promise<PreparedConnectedPlanResult>;
      getConnectedApprovalReview(request: { requestId: string }): Promise<ConnectedApprovalReviewResult>;
      getAutomationProposal(request: AutomationProposalRequest): Promise<AutomationProposalResult>;
      getAutomationProposalMaterial(request: AutomationProposalRequest): Promise<AutomationProposalMaterialResult>;
      previewProposalConnectedBatch(request: ProposalConnectedBatchRequest): Promise<ProposalConnectedBatchResult>;
      beginProposalConnectedApproval(request: {
        proposal: AutomationProposalRequest;
        preview: ProposalConnectedBatchPreview;
      }): Promise<ProposalConnectedApprovalResult>;
      prepareAutomationRun(request: { automationId: string; configurationName: string; configurationBasis: ConfigurationBasis; preparationMode: PreparationMode; input: Record<string, string | boolean | string[]> }): Promise<PreparedWork>;
      confirmConnectedApproval(request: { requestId: string; approvalId: string; reason?: string; confirmed: true }): Promise<ConnectedOperatorActionResult>;
      startConnectedTransaction(request: { approvalId: string }): Promise<ConnectedOperatorActionResult>;
      prepareConnectedReconciliation(request: { checkpointId: string }): Promise<OperatorInspection>;
      onWorkspaceInvalidated(callback: () => void): () => void;
    };
  }
}
