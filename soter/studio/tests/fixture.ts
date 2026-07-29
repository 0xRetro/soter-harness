import type { Activity, AutomationProposal, AutomationProposalMaterial, BundleInspection, Configuration, ConfigurationChangeInspection, ConfigurationPreview, ConfigurationPreviewRequest, HostRealizationInspection, InspectionSnapshot, OperatorInspection, PackInstallInspection, PackReleaseInspection, PreparedConnectedPlan, PreparedReviewAction, PreparedReviewBatch, PreparedReviewBatchMaterial, PreparedReviewRow, PreparedWork, PreparedWorkDerivedReviewMaterial, PreparedWorkReviewMaterial, ProposalConnectedBatchPreview, Workflow } from '../renderer/src/types';
// @ts-expect-error Canonical Core helper is a checked JavaScript module without declarations.
import { fingerprintJson } from '../../core/lib/canonical-json.mjs';
import emailDerivedReviewDefinition from '../../automations/email-triage/derived-review.json';
import projectPulseDerivedReviewDefinition from '../../automations/project-pulse/derived-review.json';

const fp = (digit: string) => `sha256:${digit.repeat(64)}`;

function finalizePreparedWork(work: PreparedWork): PreparedWork {
  if (work.preview.fingerprint !== null) {
    const unsignedPreview = structuredClone(work.preview);
    delete (unsignedPreview as Partial<typeof unsignedPreview>).fingerprint;
    work.preview.fingerprint = fingerprintJson(unsignedPreview);
  }
  const unsignedWork = structuredClone(work);
  delete (unsignedWork as Partial<typeof unsignedWork>).fingerprint;
  work.fingerprint = fingerprintJson(unsignedWork);
  return work;
}

function operatorPreparationProjection(): NonNullable<Workflow['operator']>['preparation'] {
  return {
    supported: true,
    boundary: 'explicit private preparation modes only; mode facts grant no provider-call, approval, continuation, execution, write, readiness, verification, proof, maturity, or migration authority',
    workStates: ['draft', 'preparing', 'needs-input', 'ready-for-review', 'ready-for-acquisition'],
    modes: [{
      id: 'contained',
      configurationBases: ['tracked-contained', 'private-active'],
      resultState: 'ready-for-review',
      availability: { state: 'available' },
      boundary: 'private fixture-contained preparation only; no connected provider call, approval, execution, write, proof, maturity, or migration authority'
    }, {
      id: 'connected-acquisition',
      configurationBases: ['private-active'],
      resultState: 'ready-for-acquisition',
      availability: { state: 'available' },
      boundary: 'stages exact private input and the current active lock only; no provider call, acquired context, approval, continuation, execution, write, readiness, verification, proof, maturity, or migration authority'
    }]
  };
}

const operationPlan: Activity = {
  id: 'checkpoint.plan.fixture',
  source: 'runtime',
  kind: 'operation-plan',
  label: 'Fixture sequential plan',
  state: 'blocked',
  createdAt: '2026-07-16T12:00:00.000Z',
  updatedAt: '2026-07-16T12:04:00.000Z',
  host: 'codex',
  provider: 'provider.integration.notion.mcp',
  capability: 'crm.records.update',
  configurationLockFingerprint: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  graphFingerprint: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  recoveryId: 'checkpoint.plan.fixture',
  timeline: ['completed', 'requested', 'pending', 'blocked', 'failed'].map((state, index) => ({
    id: `step.${index + 1}`,
    sequence: index + 1,
    label: `Plan step ${index + 1}`,
    state,
    kind: 'operation-step',
    at: '2026-07-16T12:00:00.000Z',
    capability: 'crm.records.update',
    provider: 'provider.integration.notion.mcp',
    authority: 'authority.crm.instance',
    inputFingerprint: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    outputFingerprint: state === 'completed' ? 'sha256:4444444444444444444444444444444444444444444444444444444444444444' : null,
    details: index === 1 ? 'Current step' : 'Sequential plan step'
  })),
  evidence: []
};

export function emailConnectedAcquisitionActivityFixture(): Activity {
  return {
    id: 'checkpoint.email-triage.connected-acquisition.synthetic',
    automationId: 'automation.email-triage',
    source: 'runtime',
    kind: 'operation-plan',
    label: 'Plan Email Triage Connected Acquisition Synthetic',
    state: 'requested',
    createdAt: '2026-07-16T20:00:00.000Z',
    updatedAt: '2026-07-16T20:00:01.000Z',
    host: 'codex',
    provider: 'provider.integration.gmail.mcp',
    capability: 'mail.threads.read',
    configurationLockFingerprint: fp('8'),
    graphFingerprint: fp('9'),
    recoveryId: 'checkpoint.email-triage.connected-acquisition.synthetic',
    timeline: [
      {
        id: 'checkpoint.email-triage.connected-acquisition.synthetic:step.mail-message-search',
        sequence: 1,
        label: 'Resolve the exact bounded provider-message identity set and explicit pagination state.',
        state: 'completed',
        kind: 'operation-step',
        at: '2026-07-16T20:00:01.000Z',
        capability: 'mail.messages.search',
        provider: 'provider.integration.gmail.mcp',
        authority: 'authority.mail.instance',
        inputFingerprint: fp('a'),
        outputFingerprint: fp('b'),
        details: 'Sequential plan step'
      },
      {
        id: 'checkpoint.email-triage.connected-acquisition.synthetic:step.mail-thread-expansion',
        sequence: 2,
        label: 'Expand only exact searched messages and their bounded thread siblings without classification.',
        state: 'requested',
        kind: 'operation-step',
        at: '2026-07-16T20:00:01.000Z',
        capability: 'mail.threads.read',
        provider: 'provider.integration.gmail.mcp',
        authority: 'authority.mail.instance',
        inputFingerprint: fp('c'),
        outputFingerprint: null,
        details: 'Current step'
      }
    ],
    evidence: []
  };
}

function projectPulseExecution(runId: string, evidenceId: string) {
  return {
    source: 'fixture' as const,
    result: 'passed',
    observedAt: '2026-07-15T12:00:00.000Z',
    runId,
    evidenceIds: [evidenceId],
    capabilityOrder: {
      expected: [
        'projects.records.read',
        'projects.records.read',
        'tasks.records.read',
        'documents.content.read'
      ],
      observed: [
        'projects.records.read',
        'projects.records.read',
        'tasks.records.read',
        'documents.content.read'
      ],
      state: 'passed'
    },
    effectModes: {
      expected: { read: 'allow', disclosure: 'allow', write: 'confirm', dispatch: 'prohibit', destructive: 'prohibit' },
      observed: { read: 'allow', disclosure: 'allow', write: 'confirm', dispatch: 'prohibit', destructive: 'prohibit' },
      state: 'passed'
    },
    coverage: {
      outcome: { passed: 4, total: 4 },
      invariant: { passed: 4, total: 4 },
      evidence: { passed: 4, total: 4 }
    },
    limitations: ['Fixture execution does not establish connected provider readiness or write behavior.']
  };
}

export function studioFixture(): InspectionSnapshot {
  return {
    $contract: 'soter://contracts/workspace-inspection/v1',
    contractVersion: '1.0.0',
    workspace: { name: 'Contained Soter Fixture', root: '.', mode: 'read-only' },
    census: { configurations: 2, packs: 3, capabilities: 1, providers: 1, hosts: 1, scenarios: 4, migrations: 2, fixtureActivity: 1, runtimeActivity: 1 },
    proof: {
      source: 'offline-doctor',
      observedAt: '2026-07-16T12:00:00.000Z',
      states: { valid: 'passed', ready: 'unknown', verified: 'unknown', healthy: 'unknown' },
      checks: [
        { id: 'kernel.graph-valid', claim: 'Graph valid', state: 'passed', details: 'Graph contracts passed.', evidenceIds: [] },
        { id: 'host.credentials-ready', claim: 'Credentials ready', state: 'skipped', details: 'Not inspected offline.', evidenceIds: [] },
        { id: 'behavior.evidence-current', claim: 'Evidence current', state: 'unknown', details: 'Behavior is not established.', evidenceIds: [] },
        { id: 'runtime.health-current', claim: 'Runtime healthy', state: 'skipped', details: 'Connected health was not observed.', evidenceIds: [] }
      ],
      diagnostics: [],
      evidenceIds: []
    },
    configurations: [{
      name: 'meeting-intake',
      status: 'declared-static',
      lockState: 'current',
      configurationBasis: 'tracked-contained',
      host: 'codex',
      maturity: {
        verified: 'unknown',
        reasonCode: 'CONFIGURATION_MATURITY_INCOMPLETE',
        host: {
          id: 'host.codex', claim: 'declared', state: 'declared', result: 'unknown', reasonCode: 'MATURITY_DECLARED', requiredLevel: null, evidenceIds: [], evidence: [],
          basis: 'The manifest makes no behavioral maturity claim beyond its static declaration.',
          limitations: ['No subject-scoped behavior evidence is currently required or applied.'],
          remediation: 'Run a passed subject-scoped static evaluation against the current lock before advancing this claim.'
        },
        selections: [
          {
            id: 'automation.meeting-intake', claim: 'declared', state: 'declared', result: 'unknown', reasonCode: 'MATURITY_DECLARED', requiredLevel: null,
            evidenceIds: [], evidence: [],
            basis: 'The canonical verifier reports a declared manifest claim and no behavioral maturity support.',
            limitations: ['No subject-scoped behavior evidence is applied to this declared claim.'],
            remediation: 'Retain the declaration until a canonical subject-scoped maturity rule and applicable evidence exist.'
          },
          {
            id: 'integration.notion', claim: 'declared', state: 'declared', result: 'unknown', reasonCode: 'MATURITY_DECLARED', requiredLevel: null, evidenceIds: [], evidence: [],
            basis: 'The manifest makes no behavioral maturity claim beyond its static declaration.',
            limitations: ['No subject-scoped behavior evidence is currently required or applied.'],
            remediation: 'Run a passed subject-scoped static evaluation against the current lock before advancing this claim.'
          }
        ]
      },
      selections: [
        { id: 'automation.meeting-intake', version: '0.1.0', layer: 'automation', source: 'user', reason: 'Selected grounded Meeting Intake preparation and private complete-group review; no Meeting-summary or Task-fold write authority is granted.' },
        { id: 'context.crm', version: '0.1.0', layer: 'context', source: 'dependency', reason: 'Portable organization identity.' },
        { id: 'context.projects', version: '0.1.0', layer: 'context', source: 'dependency', reason: 'Portable Project identity.' },
        { id: 'context.tasks', version: '0.1.0', layer: 'context', source: 'dependency', reason: 'Portable Task identity and update meaning.' },
        { id: 'context.meetings', version: '0.1.0', layer: 'context', source: 'dependency', reason: 'Portable Meeting and summary meaning.' },
        { id: 'integration.notion', version: '0.2.0', layer: 'integration', source: 'binding', reason: 'Selected record and document provider.' },
        { id: 'integration.otter', version: '0.1.0', layer: 'integration', source: 'binding', reason: 'Selected transcript provider.' }
      ],
      bindings: [
        { capability: 'meeting.transcript.read', providerPack: 'integration.otter', authorities: ['authority.otter.provider'], effects: ['read', 'disclosure'], reason: 'Exact transcript read binding.' },
        { capability: 'meetings.records.read', providerPack: 'integration.notion', authorities: ['authority.meetings.definition', 'authority.meetings.instance'], effects: ['read', 'disclosure'], reason: 'Exact Meeting read binding.' },
        { capability: 'documents.content.read', providerPack: 'integration.notion', authorities: ['authority.meetings.definition', 'authority.tasks.definition', 'authority.meetings.instance'], effects: ['read', 'disclosure'], reason: 'Exact configured policy-body and read-only Meeting document-body binding; it grants no write authority.' },
        { capability: 'crm.records.read', providerPack: 'integration.notion', authorities: ['authority.crm.definition', 'authority.crm.instance'], effects: ['read', 'disclosure'], reason: 'Exact CRM organization read binding.' },
        { capability: 'projects.records.read', providerPack: 'integration.notion', authorities: ['authority.projects.definition', 'authority.projects.instance'], effects: ['read', 'disclosure'], reason: 'Exact Project read binding.' },
        { capability: 'tasks.records.read', providerPack: 'integration.notion', authorities: ['authority.tasks.definition', 'authority.tasks.instance'], effects: ['read', 'disclosure'], reason: 'Exact Task read binding.' }
      ],
      authorities: [
        { id: 'authority.meetings.definition', role: 'definition', subject: 'meetings.records', reason: 'Meeting-summary policy authority.' },
        { id: 'authority.meetings.instance', role: 'instance', subject: 'meetings.records', reason: 'Meeting record authority.' },
        { id: 'authority.crm.definition', role: 'definition', subject: 'crm.records', reason: 'CRM policy authority.' },
        { id: 'authority.crm.instance', role: 'instance', subject: 'crm.records', reason: 'CRM organization authority.' },
        { id: 'authority.projects.definition', role: 'definition', subject: 'projects.records', reason: 'Project policy authority.' },
        { id: 'authority.projects.instance', role: 'instance', subject: 'projects.records', reason: 'Project record authority.' },
        { id: 'authority.tasks.definition', role: 'definition', subject: 'tasks.records', reason: 'Task-fold policy authority.' },
        { id: 'authority.tasks.instance', role: 'instance', subject: 'tasks.records', reason: 'Task record authority.' },
        { id: 'authority.otter.provider', role: 'provider', subject: 'meeting.transcript', reason: 'Transcript provider authority.' }
      ],
      effectPolicies: [
        { effect: 'read', mode: 'allow', reason: 'Reads are allowed.' },
        { effect: 'disclosure', mode: 'allow', reason: 'Private disclosure is allowed.' },
        { effect: 'write', mode: 'confirm', reason: 'The selected Integration exposes separately governed writes, but Meeting Intake declares no write capability. COMPLETE_MEETING_READBACK_UNAVAILABLE holds its complete group before proposal selection, batch, approval, start, checkpoint, provider write, or verification.' },
        { effect: 'dispatch', mode: 'prohibit', reason: 'Dispatch is prohibited.' },
        { effect: 'destructive', mode: 'prohibit', reason: 'Destructive effects are prohibited.' }
      ],
      graphFingerprint: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      lockFingerprint: 'sha256:1111111111111111111111111111111111111111111111111111111111111111'
    }, {
      name: 'project-pulse',
      status: 'declared-static',
      lockState: 'current',
      configurationBasis: 'tracked-contained',
      host: 'codex',
      maturity: {
        verified: 'unknown',
        reasonCode: 'CONFIGURATION_MATURITY_INCOMPLETE',
        host: {
          id: 'host.codex', claim: 'declared', state: 'declared', result: 'unknown', reasonCode: 'MATURITY_DECLARED', requiredLevel: null, evidenceIds: [], evidence: [],
          basis: 'The manifest makes no behavioral maturity claim beyond its static declaration.',
          limitations: ['No subject-scoped behavior evidence is currently required or applied.'],
          remediation: 'Run a passed subject-scoped static evaluation against the current lock before advancing this claim.'
        },
        selections: [{
          id: 'automation.project-pulse', claim: 'declared', state: 'declared', result: 'unknown', reasonCode: 'MATURITY_DECLARED', requiredLevel: null,
          evidenceIds: [], evidence: [],
          basis: 'The canonical verifier reports a declared manifest claim and no behavioral maturity support.',
          limitations: ['No subject-scoped behavior evidence is applied to this declared claim.'],
          remediation: 'Retain the declaration until a canonical subject-scoped maturity rule and applicable evidence exist.'
        }]
      },
      selections: [
        { id: 'automation.project-pulse', version: '0.1.0', layer: 'automation', source: 'user', reason: 'Selected grounded review and confirmation-gated write outcome.' },
      { id: 'integration.notion', version: '0.2.0', layer: 'integration', source: 'binding', reason: 'Selected record and document provider.' }
      ],
      bindings: [
        { capability: 'projects.records.read', providerPack: 'integration.notion', authorities: ['authority.projects.definition', 'authority.projects.instance'], effects: ['read'], reason: 'Exact Project policy and record-read binding.' },
        { capability: 'tasks.records.read', providerPack: 'integration.notion', authorities: ['authority.tasks.instance'], effects: ['read'], reason: 'Exact promoted-Task read binding.' },
        { capability: 'documents.content.read', providerPack: 'integration.notion', authorities: ['authority.projects.instance'], effects: ['read'], reason: 'Exact project-document read binding.' },
        { capability: 'documents.content.update', providerPack: 'integration.notion', authorities: ['authority.projects.instance'], effects: ['write'], reason: 'Confirmation-gated document update binding.' },
        { capability: 'projects.records.create', providerPack: 'integration.notion', authorities: ['authority.projects.instance'], effects: ['write'], reason: 'Confirmation-gated Project status creation binding.' }
      ],
      authorities: [
        { id: 'authority.projects.definition', role: 'definition', subject: 'projects.records', reason: 'Project policy authority.' },
        { id: 'authority.projects.instance', role: 'instance', subject: 'projects.records', reason: 'Project record authority.' },
        { id: 'authority.tasks.instance', role: 'instance', subject: 'tasks.records', reason: 'Task record authority.' }
      ],
      effectPolicies: [
        { effect: 'read', mode: 'allow', reason: 'Reads are allowed.' },
        { effect: 'disclosure', mode: 'allow', reason: 'Private disclosure is allowed.' },
        { effect: 'write', mode: 'confirm', reason: 'The exact document/status batch requires confirmation.' },
        { effect: 'dispatch', mode: 'prohibit', reason: 'Dispatch is prohibited.' },
        { effect: 'destructive', mode: 'prohibit', reason: 'Destructive effects are prohibited.' }
      ],
      graphFingerprint: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
      lockFingerprint: 'sha256:6666666666666666666666666666666666666666666666666666666666666666'
    }],
    catalog: [
      { id: 'configuration.meeting-intake', kind: 'configuration', group: 'configuration', label: 'Meeting Intake', summary: 'Exact selected graph.', version: null, state: 'current', selected: true, effects: ['read', 'disclosure', 'write', 'dispatch', 'destructive'], limitations: ['Configuration policy is not Automation write authority.'] },
      { id: 'automation.meeting-intake', kind: 'pack', group: 'automation', label: 'Automation Meeting Intake', summary: 'Grounded private complete-group review held before write authority.', version: '0.1.0', state: 'declared', selected: true, effects: ['read', 'disclosure'], limitations: [] },
      { id: 'automation.project-pulse', kind: 'pack', group: 'automation', label: 'Automation Project Pulse', summary: 'Grounded project status workflow.', version: '0.1.0', state: 'declared', selected: true, effects: ['read', 'disclosure', 'write'], limitations: [] },
      { id: 'meetings.records.read', kind: 'capability', group: 'capability', label: 'Meetings Records Read', summary: 'Read Meeting records.', version: '1.0.0', state: 'portable', selected: true, effects: ['read'], limitations: [] },
      { id: 'provider.integration.notion.mcp', kind: 'provider', group: 'connected', label: 'Provider Integration Notion Mcp', summary: 'Connected provider.', version: '0.2.0', state: 'connected', selected: true, effects: ['read', 'write'], limitations: ['Writes require exact Core authority and verification.'] },
      { id: 'host.codex', kind: 'host', group: 'host', label: 'Host Codex', summary: 'Codex host.', version: '0.3.1', state: 'declared', selected: true, effects: [], limitations: [] }
    ],
    graph: {
      nodes: [
        { id: 'configuration.meeting-intake', kind: 'configuration', group: 'configuration', label: 'Meeting Intake', summary: 'Exact selected graph.', selected: true, state: 'current' },
        { id: 'automation.meeting-intake', kind: 'pack', group: 'automation', label: 'Automation Meeting Intake', summary: 'Grounded private complete-group review held before write authority.', selected: true, state: 'declared' },
        { id: 'automation.project-pulse', kind: 'pack', group: 'automation', label: 'Automation Project Pulse', summary: 'Grounded project status workflow.', selected: true, state: 'declared' },
        { id: 'meetings.records.read', kind: 'capability', group: 'capability', label: 'Meetings Records Read', summary: 'Read Meeting records.', selected: true, state: 'portable' },
        { id: 'provider.integration.notion.mcp', kind: 'provider', group: 'connected', label: 'Provider Integration Notion Mcp', summary: 'Connected provider.', selected: true, state: 'connected' },
        { id: 'host.codex', kind: 'host', group: 'host', label: 'Host Codex', summary: 'Codex host.', selected: true, state: 'declared' },
        { id: 'configuration.meeting-intake:authority:authority.meetings.instance', kind: 'authority', group: 'authority', label: 'Authority Meetings Instance', summary: 'Meeting instance authority.', selected: true, state: 'declared' }
      ],
      edges: [
        { id: 'selects:config:auto', kind: 'selects', source: 'configuration.meeting-intake', target: 'automation.meeting-intake', label: 'user' },
        { id: 'requires:auto:cap', kind: 'requires', source: 'automation.meeting-intake', target: 'meetings.records.read', label: '1.0.0' },
        { id: 'implements:provider:cap', kind: 'implements', source: 'provider.integration.notion.mcp', target: 'meetings.records.read', label: '1.0.0' },
        { id: 'authority:configuration.meeting-intake:cap:authority', kind: 'authority', source: 'meetings.records.read', target: 'configuration.meeting-intake:authority:authority.meetings.instance', label: 'authorized by' }
      ]
    },
    workflows: [{
      id: 'automation.meeting-intake',
      label: 'Automation Meeting Intake',
      summary: 'Turns one recorded meeting into a grounded private review of a Meeting summary and linked Task fold, then holds the complete write group because complete fields-and-body read-back is unavailable.',
      version: '0.1.0',
      configuration: 'meeting-intake',
      configurationBasis: 'tracked-contained',
      host: 'codex',
      hostCompatibility: {
        claude: { state: 'compatible' },
        codex: { state: 'compatible' }
      },
      effects: ['read', 'disclosure'],
      requiredCapabilities: ['meeting.transcript.read', 'meetings.records.read', 'crm.records.read', 'projects.records.read', 'tasks.records.read', 'documents.content.read'],
      dependencies: ['context.crm', 'context.projects', 'context.tasks', 'context.meetings', 'core.runtime'],
      bindings: ['meeting.transcript.read → integration.otter', 'meetings.records.read → integration.notion', 'crm.records.read → integration.notion', 'projects.records.read → integration.notion', 'tasks.records.read → integration.notion', 'documents.content.read → integration.notion'],
      operator: {
        inputContract: {
          id: 'input.automation.meeting-intake', version: '1.0.0', additionalInputs: false,
          fields: [{
            id: 'meeting', label: 'Transcript meeting reference',
            description: 'Provider meeting identifier used with the private recording reference to select one exact transcript.',
            type: 'reference', required: true, exposure: 'identifier',
            reference: { subject: 'meeting.transcript', authorityRole: 'provider' },
            constraints: { minLength: 3, maxLength: 120, pattern: '^meeting\\.[a-z0-9]+(?:-[a-z0-9]+)*$' },
            examples: ['meeting.fixture-001']
          }, {
            id: 'recordingUri', label: 'Recording reference',
            description: 'Private canonical recording URI used to identify the exact transcript source; preparation and later execution remain separately bounded.',
            type: 'uri', required: true, exposure: 'private', examples: ['https://otter.ai/u/meeting_fixture_001']
          }, {
            id: 'operatorGoal', label: 'Desired outcome',
            description: 'Optional private note reserved for later cited judgment; this contained preparation binds its fingerprint but does not interpret the raw value.',
            type: 'string', required: false, exposure: 'private', constraints: { maxLength: 500 }
          }]
        },
        preparation: operatorPreparationProjection()
      },
      scenarios: [{
        id: 'meeting-intake.happy-path',
        status: 'declared-not-executed',
        intent: 'operate',
        outcomes: ['meeting-summary-and-task.private-review-available', 'complete-write-group.held', 'source-meeting.attributed', 'no-execution-authority.created'],
        invariants: ['transcript-grounded', 'complete-group-never-partially-executed', 'complete-readback-required', 'no-write-authority'],
        evidence: ['source-provenance', 'private-complete-group-review', 'complete-meeting-readback-unavailable', 'zero-authority-state'],
        sourceCases: ['.claude/evals/processing-a-meeting/happy-path.md'],
        migrationState: 'target-native',
        execution: null
      }],
      migration: {
        id: 'meeting-intake.prototype-to-v1',
        state: 'migrated',
        limitations: ['Legacy source cases are fingerprinted tombstones only; no operational fallback remains. Contained evidence does not establish connected readiness, verification, or health.']
      }
    }, {
      id: 'automation.project-pulse',
      label: 'Automation Project Pulse',
      summary: 'Builds a grounded, privately reviewable project-status and milestone batch.',
      version: '0.1.0',
      configuration: 'project-pulse',
      configurationBasis: 'tracked-contained',
      host: 'codex',
      hostCompatibility: {
        claude: { state: 'compatible' },
        codex: { state: 'compatible' }
      },
      effects: ['read', 'disclosure', 'write'],
      requiredCapabilities: ['projects.records.read', 'tasks.records.read', 'documents.content.read', 'documents.content.update', 'projects.records.create'],
      dependencies: ['context.projects', 'context.tasks', 'core.runtime'],
      bindings: [
        'projects.records.read → integration.notion',
        'tasks.records.read → integration.notion',
        'documents.content.read → integration.notion',
        'documents.content.update → integration.notion',
        'projects.records.create → integration.notion'
      ],
      operator: {
        inputContract: {
          id: 'input.automation.project-pulse',
          version: '1.0.0',
          fields: [{
            id: 'project', label: 'Project reference',
            description: 'Exact authoritative project resource identity whose task relations and document body will be reviewed.',
            type: 'reference', required: true, exposure: 'identifier',
            reference: { subject: 'projects.records.project', authorityRole: 'instance' },
            constraints: { minLength: 3, maxLength: 500 },
            examples: ['https://www.notion.so/11111111111111111111111111111111']
          }, {
            id: 'statusDate', label: 'Status date',
            description: 'Private exact calendar date covered by the proposed status entry; relative date phrases are not accepted.',
            type: 'date', required: true, exposure: 'private'
          }, {
            id: 'visibility', label: 'Visibility',
            description: 'Portable audience classification allowed by the selected Projects policy.',
            type: 'enum', required: true, exposure: 'identifier',
            options: ['Internal', 'Agent', 'Public']
          }, {
            id: 'health', label: 'Project health judgment',
            description: 'Required human judgment for the status headline. Automation checks it against exact task and milestone contradictions but never invents it from task counts.',
            type: 'enum', required: true, exposure: 'identifier',
            options: ['on-track', 'at-risk', 'off-track']
          }, {
            id: 'healthMilestones', label: 'Health milestone titles',
            description: 'Optional private exact milestone-title set whose health tags should be changed to support the human judgment. Every title must resolve once in the current project document.',
            type: 'string-list', required: false, exposure: 'private',
            constraints: { minItems: 1, maxItems: 20, itemMinLength: 1, itemMaxLength: 200 }
          }, {
            id: 'operatorGoal', label: 'Operator note',
            description: 'Optional private operator intent; Core fingerprints it for the receipt and never stores or projects the raw value.',
            type: 'string', required: false, exposure: 'private', constraints: { maxLength: 500 }
          }],
          additionalInputs: false
        },
        preparation: operatorPreparationProjection()
      },
      scenarios: [{
        id: 'project-pulse.happy-path',
        status: 'executed-passed',
        intent: 'operate',
        outcomes: ['project-progress.grounded', 'health-judgment.checked', 'status-record.previewed'],
        invariants: ['no-write-before-batch-confirmation'],
        evidence: ['project-source-provenance'],
        sourceCases: ['.claude/evals/updating-project-status/happy-path.md'],
        migrationState: 'migrated',
        execution: projectPulseExecution('run.project-pulse.happy-fixture', 'evidence.project-pulse.scenario-happy.fixture')
      }, {
        id: 'project-pulse.no-invented-progress',
        status: 'executed-passed',
        intent: 'operate',
        outcomes: ['supported-progress.reported', 'unsupported-percentage.declined'],
        invariants: ['no-fabricated-percentage'],
        evidence: ['unsupported-claim-disposition'],
        sourceCases: ['.claude/evals/updating-project-status/invariant-no-invented-progress.md'],
        migrationState: 'migrated',
        execution: projectPulseExecution('run.project-pulse.no-invented-progress-fixture', 'evidence.project-pulse.scenario-no-invented-progress.fixture')
      }, {
        id: 'project-pulse.pressure-on-track',
        status: 'executed-passed',
        intent: 'operate',
        outcomes: ['contradicting-risk.surfaced', 'honest-status.previewed'],
        invariants: ['user-request-does-not-dictate-health'],
        evidence: ['requested-vs-observed-health'],
        sourceCases: ['.claude/evals/updating-project-status/pressure-just-say-on-track.md'],
        migrationState: 'migrated',
        execution: projectPulseExecution('run.project-pulse.pressure-on-track-fixture', 'evidence.project-pulse.scenario-pressure-on-track.fixture')
      }],
      migration: { id: 'project-pulse.prototype-to-v1', state: 'migrated', limitations: ['Contained evidence does not establish live provider readiness, verification, or health.'] }
    }],
    activity: [{
      id: 'run.meeting-intake.fixture',
      source: 'fixture',
      kind: 'run',
      label: 'Prepare fixture meeting intake.',
      state: 'effects-established',
      createdAt: '2026-07-15T12:00:00.000Z',
      updatedAt: '2026-07-15T12:00:00.000Z',
      host: 'codex',
      provider: null,
      capability: null,
      configurationLockFingerprint: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      graphFingerprint: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      recoveryId: null,
      timeline: [{ id: 'checkpoint.effects', sequence: 1, label: 'Effects established', state: 'passed', kind: 'checkpoint', at: '2026-07-15T12:00:00.000Z', capability: null, provider: null, authority: null, inputFingerprint: null, outputFingerprint: null, details: 'Policies evaluated.' }],
      evidence: [{ id: 'evidence.fixture', claim: 'Fixture preparation captured policy.', result: 'passed', level: 'fixture', createdAt: '2026-07-15T12:00:00.000Z', limitations: ['Does not establish provider readiness.'] }]
    }, operationPlan],
    diagnostics: []
  };
}

export function operatorInspectionFixture(state: 'awaiting-approval' | 'approved-not-started' | 'running' = 'awaiting-approval'): OperatorInspection {
  const fingerprint = (digit: string) => `sha256:${digit.repeat(64)}`;
  const confirmed = state !== 'awaiting-approval';
  const running = state === 'running';
  return {
    $contract: 'soter://contracts/operator-inspection/v1', contractVersion: '1.0.0', generatedAt: '2026-07-16T12:00:00.000Z',
    activity: { id: 'activity.project-pulse.ui-test', automationId: 'automation.project-pulse', workId: 'work.project-pulse.ui-test', workState: state, phase: running ? 'execution' : 'approval', runId: 'run.project-pulse.ui-test' },
    configuration: { name: 'project-pulse', path: 'soter/configurations/project-pulse.config.json', lockPath: 'soter/fixtures/project-pulse/project-pulse.lock.json', configurationBasis: 'private-active', lockFingerprint: fingerprint('1'), graphFingerprint: fingerprint('2'), host: 'codex', applicability: { state: 'current', expectedLockFingerprint: fingerprint('1'), observedLockFingerprint: fingerprint('1'), reasonCode: 'LOCK_CURRENT' } },
    scope: { changeSet: { id: 'changeset.project-pulse.ui-test', fingerprint: fingerprint('3') }, batch: { id: 'batch.project-pulse.ui-test', fingerprint: fingerprint('4') }, effects: ['write'], authorities: ['authority.projects.instance'], recordIds: ['record.project-pulse'], changes: [{ id: 'operation.project-pulse.update', recordId: 'record.project-pulse', effect: 'projects.records.create', beforeFingerprint: null, afterFingerprint: fingerprint('5') }] },
    approval: { state: running ? 'consumed' : confirmed ? 'confirmed' : 'awaiting', request: { id: 'approval-request.project-pulse.ui-test', fingerprint: fingerprint('6'), requestedAt: '2026-07-16T12:00:00.000Z', expiresAt: '2026-07-16T12:10:00.000Z' }, confirmation: confirmed ? { id: 'approval.project-pulse.ui-test', fingerprint: fingerprint('7'), confirmedAt: '2026-07-16T12:01:00.000Z', actor: 'local-studio-operator' } : null, consumption: running ? { id: 'approval-consumption.project-pulse.ui-test', state: 'started', startedAt: '2026-07-16T12:02:00.000Z', checkpointId: 'checkpoint.transaction.project-pulse.ui-test', checkpointFingerprint: fingerprint('8') } : null, reasonCode: running ? 'APPROVAL_CONSUMED' : confirmed ? 'APPROVAL_CONFIRMED_NOT_STARTED' : 'APPROVAL_REQUEST_PENDING' },
    capabilities: { steps: [{ id: 'operation.project-pulse.update', sequence: 1, capability: 'projects.records.create', authority: 'authority.projects.instance', effects: ['write'], state: running ? 'current' : 'pending' }], completedPrefix: [], current: running ? { stepId: 'operation.project-pulse.update', stage: 'write', callId: 'call.project-pulse.ui-test', reconciliationId: null } : null, pending: running ? [] : ['operation.project-pulse.update'] },
    blockers: [], checkpoint: running ? { id: 'checkpoint.transaction.project-pulse.ui-test', fingerprint: fingerprint('8'), state: 'requested', updatedAt: '2026-07-16T12:02:00.000Z' } : null,
    resume: running ? { classification: 'safe', reasonCode: 'CURRENT_CALL_PENDING', reason: 'Only the exact current checkpoint call is authorized to continue.', permittedNextAction: 'execute-current-call' } : confirmed ? { classification: 'safe', reasonCode: 'APPROVAL_CONFIRMED_NOT_STARTED', reason: 'The current exact approval may be consumed once to create its bound checkpoint.', permittedNextAction: 'start-transaction' } : { classification: 'unavailable', reasonCode: 'APPROVAL_REQUEST_PENDING', reason: 'The exact request has not been confirmed.', permittedNextAction: 'confirm-approval' },
    continuationRequest: running ? { kind: 'execute-current-call', checkpointId: 'checkpoint.transaction.project-pulse.ui-test', checkpointFingerprint: fingerprint('8'), callId: 'call.project-pulse.ui-test', requestFingerprint: fingerprint('9') } : null,
    verification: { state: running ? 'unknown' : 'not-started', criteria: [{ id: 'verification.operation.project-pulse.update.record', state: 'pending', reasonCode: 'VERIFICATION_PENDING', observedFingerprint: null }], observedFingerprint: null },
    compensation: { state: 'not-required', plan: [], completedStepIds: [], remainingStepIds: [], restoredFingerprint: null },
    families: { proof: { state: 'not-evaluated', reasonCode: 'FAMILY_NOT_EVALUATED_BY_OPERATOR_INSPECTION' }, maturity: { state: 'not-evaluated', reasonCode: 'FAMILY_NOT_EVALUATED_BY_OPERATOR_INSPECTION' }, migration: { state: 'not-evaluated', reasonCode: 'FAMILY_NOT_EVALUATED_BY_OPERATOR_INSPECTION' } },
    privacy: { scope: 'private-derived', rawProviderResponseIncluded: false, credentialValuesIncluded: false }, inspectionFingerprint: fingerprint('a')
  };
}

export function operatorRecoveryInspectionFixture(state: 'blocked' | 'checkpoint-stale' | 'verification-failed' | 'basis-unavailable'): OperatorInspection {
  const inspection = operatorInspectionFixture('running');
  const fingerprint = (digit: string) => `sha256:${digit.repeat(64)}`;
  inspection.activity.workState = state === 'verification-failed' ? 'verification-failed' : 'blocked';
  inspection.activity.phase = state === 'verification-failed'
    ? 'verification'
    : state === 'blocked' ? 'reconciliation' : 'execution';
  inspection.capabilities.steps = [
    { id: 'operation.project-pulse.prior-update', sequence: 1, capability: 'documents.content.update', authority: 'authority.projects.instance', effects: ['write'], state: 'applied' },
    { id: 'operation.project-pulse.update', sequence: 2, capability: 'documents.content.update', authority: 'authority.projects.instance', effects: ['write'], state: 'needs-attention' },
    { id: 'operation.project-pulse.summary', sequence: 3, capability: 'projects.records.create', authority: 'authority.projects.instance', effects: ['write'], state: 'pending' }
  ];
  inspection.capabilities.completedPrefix = ['operation.project-pulse.prior-update'];
  inspection.capabilities.current = null;
  inspection.capabilities.pending = ['operation.project-pulse.summary'];
  inspection.checkpoint = {
    id: 'checkpoint.transaction.project-pulse.ui-test',
    fingerprint: fingerprint('8'),
    state: 'needs-attention',
    updatedAt: '2026-07-16T12:04:00.000Z'
  };
  inspection.blockers = [{
    reasonCode: state === 'basis-unavailable' ? 'CONFIGURATION_BASIS_NOT_PRIVATE_ACTIVE' : state === 'checkpoint-stale' ? 'CHECKPOINT_STALE' : state === 'verification-failed' ? 'READ_AFTER_WRITE_MISMATCH' : 'RECONCILIATION_AVAILABLE',
    summary: state === 'basis-unavailable' ? 'Connected continuation requires an exact private-active configuration basis.' : state === 'checkpoint-stale' ? 'The exact lock no longer applies.' : 'The external effect needs one exact read-only observation.',
    details: [{ key: 'checkpointId', value: inspection.checkpoint.id }],
    requiredInputs: state === 'verification-failed' ? ['verified record identity'] : [],
    requiredPermissions: state === 'blocked' ? ['projects.records.read'] : []
  }];
  inspection.verification = {
    state: state === 'verification-failed' ? 'failed' : 'unknown',
    criteria: [{
      id: 'verification.operation.project-pulse.update.record',
      state: state === 'verification-failed' ? 'failed' : 'unknown',
      reasonCode: state === 'verification-failed' ? 'READ_AFTER_WRITE_MISMATCH' : 'VERIFICATION_PENDING',
      observedFingerprint: state === 'verification-failed' ? fingerprint('b') : null
    }],
    observedFingerprint: state === 'verification-failed' ? fingerprint('b') : null
  };
  inspection.compensation = {
    state: 'not-required', plan: [], completedStepIds: [], remainingStepIds: [], restoredFingerprint: null
  };
  if (state === 'checkpoint-stale') {
    inspection.configuration.applicability = {
      state: 'stale', expectedLockFingerprint: fingerprint('c'), observedLockFingerprint: fingerprint('1'), reasonCode: 'CHECKPOINT_STALE'
    };
    inspection.resume = {
      classification: 'unavailable', reasonCode: 'CHECKPOINT_STALE', reason: 'The exact lock is not currently applicable; no execution continuation is authorized.', permittedNextAction: 'rebuild-work'
    };
    inspection.continuationRequest = null;
  } else if (state === 'basis-unavailable') {
    inspection.configuration.configurationBasis = 'tracked-contained';
    inspection.resume = {
      classification: 'unavailable',
      reasonCode: 'CONFIGURATION_BASIS_NOT_PRIVATE_ACTIVE',
      reason: 'Connected continuation requires an exact private-active configuration basis.',
      permittedNextAction: 'inspect-checkpoint'
    };
    inspection.continuationRequest = null;
  } else {
    inspection.resume = {
      classification: 'safe', reasonCode: 'RECONCILIATION_AVAILABLE', reason: 'Core authorizes preparation of one read-only reconciliation for the unresolved ambiguity.', permittedNextAction: 'prepare-reconciliation'
    };
    inspection.continuationRequest = {
      kind: 'prepare-reconciliation', checkpointId: inspection.checkpoint.id, checkpointFingerprint: fingerprint('8'), callId: null, requestFingerprint: fingerprint('e')
    };
  }
  return inspection;
}

export function connectedActivityFixture(): Activity {
  const inspection = operatorInspectionFixture();
  return { id: inspection.activity.id, automationId: inspection.activity.automationId, source: 'runtime', kind: 'connected-transaction', label: 'Automation Project Pulse', state: inspection.activity.workState, createdAt: inspection.approval.request.requestedAt, updatedAt: inspection.generatedAt, host: inspection.configuration.host, provider: null, capability: null, configurationLockFingerprint: inspection.configuration.lockFingerprint, graphFingerprint: inspection.configuration.graphFingerprint, recoveryId: null, operatorRef: { requestId: inspection.approval.request.id, approvalId: null, checkpointId: null }, timeline: [], evidence: [] };
}

export function configurationPreviewFixture(request: ConfigurationPreviewRequest = {
  name: 'meeting-intake',
  configurationBasis: 'tracked-contained'
}): ConfigurationPreview {
  const host = request.draft?.hostAdapter || 'host.codex';
  const addPacks = request.draft?.addPacks || [];
  const effects = {
    read: 'allow', disclosure: 'allow', write: 'confirm', dispatch: 'prohibit', destructive: 'prohibit',
    ...request.draft?.effectPolicies
  };
  const currentEffects = { read: 'allow', disclosure: 'allow', write: 'confirm', dispatch: 'prohibit', destructive: 'prohibit' };
  const changed = host !== 'host.codex' || addPacks.length > 0
    || Object.entries(effects).some(([effect, mode]) => currentEffects[effect as keyof typeof currentEffects] !== mode);
  const fingerprint = changed
    ? 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    : 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
  return {
    $contract: 'soter://contracts/configuration-preview/v1',
    contractVersion: '1.0.0',
    configuration: {
      name: 'meeting-intake', sourcePath: 'soter/configurations/meeting-intake.config.json',
      configurationBasis: request.configurationBasis, host: 'host.codex',
      lockFingerprint: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      graphFingerprint: 'sha256:2222222222222222222222222222222222222222222222222222222222222222'
    },
    draft: {
      valid: true, changed, host, addedPacks: addPacks, lockFingerprint: fingerprint,
      graphFingerprint: changed
        ? 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        : 'sha256:2222222222222222222222222222222222222222222222222222222222222222'
    },
    changes: [
      {
        category: 'host', subject: 'host.adapter', state: host === 'host.codex' ? 'unchanged' : 'changed',
        before: 'host.codex', after: host,
        impact: host === 'host.codex' ? 'The active host projection is unchanged.' : 'Host projections and exact-lock evidence must be re-established.'
      },
      ...Object.entries(effects).map(([effect, mode]) => ({
        category: 'effect-policy' as const,
        subject: effect,
        state: currentEffects[effect as keyof typeof currentEffects] === mode ? 'unchanged' as const : 'changed' as const,
        before: currentEffects[effect as keyof typeof currentEffects],
        after: mode,
        impact: currentEffects[effect as keyof typeof currentEffects] === mode ? 'No policy change.' : `The ${effect} effect changes policy.`
      })),
      ...addPacks.map((id) => ({
        category: 'pack' as const,
        subject: id,
        state: 'changed' as const,
        before: 'not selected',
        after: 'selected',
        impact: 'Adds the pack and its exact artifact fingerprints to the candidate lock.'
      }))
    ],
    options: {
      hosts: [
        { id: 'claude', adapter: 'host.claude', version: '0.3.1', current: false, compatible: true, limitations: ['Conformance is declared.'] },
        { id: 'codex', adapter: 'host.codex', version: '0.3.1', current: true, compatible: true, limitations: ['Conformance is declared.'] }
      ],
      effectModes: ['allow', 'confirm', 'prohibit'],
      packs: [
        {
          id: 'automation.meeting-intake', version: '0.1.0', layer: 'automation', selected: true, base: false, selectable: false,
          summary: 'Grounded private Meeting summary and Task-fold review held before write authority.',
          effects: ['read', 'disclosure'], dependencies: ['context.crm', 'context.projects', 'context.tasks', 'context.meetings', 'core.runtime'],
          requiredCapabilities: ['meeting.transcript.read', 'meetings.records.read', 'crm.records.read', 'projects.records.read', 'tasks.records.read', 'documents.content.read'], scenarioCount: 1
        },
        {
          id: 'automation.project-pulse', version: '0.1.0', layer: 'automation', selected: false, base: false, selectable: true,
          summary: 'Builds a grounded project status brief.', effects: ['read', 'disclosure'], dependencies: ['context.projects', 'context.tasks', 'core.runtime'],
          requiredCapabilities: ['projects.records.read', 'tasks.records.read'], scenarioCount: 3
        },
        {
          id: 'core.runtime', version: '0.1.0', layer: 'core', selected: true, base: true, selectable: false,
          summary: 'Core runtime.', effects: [], dependencies: ['kernel.soter'], requiredCapabilities: [], scenarioCount: 0
        }
      ]
    },
    evidenceImpact: {
      state: changed ? 'invalidated' : 'preserved',
      reason: changed ? 'Evidence is bound to the current exact lock; this draft requires new applicable evidence.' : 'Evidence applicability is unchanged.'
    },
    diagnostics: [],
    apply: { supported: false, reason: 'Studio previews configuration impact only; applying remains deferred.' }
  };
}

export function configurationChangeInspectionFixture(stage: 'plan' | 'request' | 'confirmed' | 'started' | 'completed' | 'needs-attention' = 'plan'): ConfigurationChangeInspection {
  const requested = stage !== 'plan';
  const confirmed = ['confirmed', 'started', 'completed', 'needs-attention'].includes(stage);
  const started = ['started', 'completed', 'needs-attention'].includes(stage);
  const completed = stage === 'completed';
  const needsAttention = stage === 'needs-attention';
  const resume = completed
    ? { classification: 'unavailable' as const, reasonCode: 'CONFIGURATION_APPLY_COMPLETED', reason: 'The exact configuration transaction is complete.', permittedNextAction: 'none' as const }
    : needsAttention
      ? { classification: 'requires-review' as const, reasonCode: 'CONFIGURATION_ROLLBACK_FAILED', reason: 'The exact prior configuration state could not be restored automatically.', permittedNextAction: 'inspect-checkpoint' as const }
      : started
        ? { classification: 'safe' as const, reasonCode: 'CONFIGURATION_CHECKPOINT_RECOVERABLE', reason: 'Core can inspect and reconcile the exact durable configuration checkpoint.', permittedNextAction: 'inspect-checkpoint' as const }
        : confirmed
          ? { classification: 'safe' as const, reasonCode: 'CONFIGURATION_CONFIRMATION_CURRENT', reason: 'The exact confirmation is current and has not been consumed.', permittedNextAction: 'apply' as const }
          : requested
            ? { classification: 'safe' as const, reasonCode: 'CONFIGURATION_REQUEST_AWAITING_CONFIRMATION', reason: 'The exact configuration request is awaiting local operator confirmation.', permittedNextAction: 'confirm' as const }
            : { classification: 'safe' as const, reasonCode: 'CONFIGURATION_PLAN_CURRENT', reason: 'The exact configuration plan is current and may be submitted for confirmation.', permittedNextAction: 'request-confirmation' as const };
  return {
    $contract: 'soter://contracts/configuration-change-inspection/v1',
    contractVersion: '1.0.0',
    plan: { id: 'configuration-change-plan.meeting-intake.ui-test', fingerprint: fp('1') },
    configuration: {
      name: 'meeting-intake',
      sourceKind: completed ? 'private-active' : 'tracked-template',
      baselineLockFingerprint: fp('2'),
      candidateLockFingerprint: fp('3'),
      candidateGraphFingerprint: fp('4'),
      observedLockFingerprint: completed ? fp('3') : fp('2'),
      applicability: completed ? 'applied' : 'current'
    },
    scope: {
      fingerprint: fp('5'),
      changes: [{
        id: 'configuration-change.host-adapter', category: 'host', subject: 'host.adapter', state: 'changed',
        beforeDescriptor: 'host.codex', afterDescriptor: 'host.claude',
        beforeFingerprint: fp('6'), afterFingerprint: fp('7')
      }]
    },
    request: requested ? {
      id: 'configuration-change-request.meeting-intake.ui-test', fingerprint: fp('8'),
      createdAt: '2026-07-16T15:00:00.000Z', expiresAt: '2026-07-16T15:10:00.000Z',
      state: confirmed ? 'confirmed' : 'awaiting'
    } : null,
    confirmation: confirmed ? {
      id: 'configuration-change-confirmation.meeting-intake.ui-test', fingerprint: fp('9'),
      confirmedAt: '2026-07-16T15:02:00.000Z', actor: 'local-studio-operator'
    } : null,
    consumption: started ? {
      id: 'configuration-change-consumption.meeting-intake.ui-test', fingerprint: fp('a'), state: 'started'
    } : null,
    checkpoint: started ? {
      id: 'checkpoint.configuration.meeting-intake.ui-test', fingerprint: fp('b'),
      state: completed ? 'completed' : needsAttention ? 'needs-attention' : 'prepared',
      phase: completed || needsAttention ? 'terminal' : 'prepared',
      updatedAt: '2026-07-16T15:03:00.000Z',
      reasonCode: needsAttention ? 'CONFIGURATION_ROLLBACK_FAILED' : null
    } : null,
    resume,
    authority: { kind: 'inspection-only', grantsExecution: false, grantsProviderWrite: false }
  };
}

export function hostRealizationInspectionFixture(stage: 'plan' | 'request' | 'request-expired' | 'confirmed' | 'started' | 'recoverable' | 'completed' | 'stale' | 'expired' | 'needs-attention' = 'plan'): HostRealizationInspection {
  const requested = !['plan', 'stale', 'expired'].includes(stage);
  const confirmed = ['confirmed', 'started', 'recoverable', 'completed', 'needs-attention'].includes(stage);
  const started = ['started', 'recoverable', 'completed', 'needs-attention'].includes(stage);
  const completed = stage === 'completed';
  const recoverable = stage === 'recoverable';
  const needsAttention = stage === 'needs-attention';
  const applicability = completed ? 'applied' : stage === 'stale' ? 'stale' : stage === 'expired' ? 'expired' : 'current';
  const resume = completed
    ? { classification: 'unavailable' as const, reasonCode: 'HOST_REALIZATION_COMPLETED', reason: 'The exact deterministic local projection is complete.', permittedNextAction: 'none' as const }
    : needsAttention
      ? { classification: 'requires-review' as const, reasonCode: 'HOST_REALIZATION_OUTPUT_DRIFT', reason: 'Checkpoint state requires exact local inspection before any further action.', permittedNextAction: 'inspect-checkpoint' as const }
      : recoverable
        ? { classification: 'safe' as const, reasonCode: 'HOST_REALIZATION_CHECKPOINT_RECOVERABLE', reason: 'The exact checkpoint may continue through Core recovery.', permittedNextAction: 'recover-checkpoint' as const }
        : started
          ? { classification: 'safe' as const, reasonCode: 'HOST_REALIZATION_CHECKPOINT_READY', reason: 'The one-time start is bound to an exact prepared checkpoint.', permittedNextAction: 'execute-checkpoint' as const }
          : confirmed
            ? { classification: 'safe' as const, reasonCode: 'HOST_REALIZATION_CONFIRMATION_CURRENT', reason: 'The exact confirmation may be consumed once before its request expires.', permittedNextAction: 'start' as const }
            : stage === 'request-expired'
              ? { classification: 'unavailable' as const, reasonCode: 'HOST_REALIZATION_REQUEST_EXPIRED', reason: 'The exact confirmation request expired.', permittedNextAction: 'request-confirmation' as const }
              : requested
              ? { classification: 'safe' as const, reasonCode: 'HOST_REALIZATION_CONFIRMATION_PENDING', reason: 'The exact expiring request is awaiting local operator confirmation.', permittedNextAction: 'confirm' as const }
              : applicability === 'current'
                ? { classification: 'safe' as const, reasonCode: 'HOST_REALIZATION_PLAN_CURRENT', reason: 'The exact private plan is current and may request confirmation.', permittedNextAction: 'request-confirmation' as const }
                : { classification: 'unavailable' as const, reasonCode: applicability === 'expired' ? 'HOST_REALIZATION_PLAN_EXPIRED' : 'HOST_REALIZATION_PLAN_STALE', reason: 'The private host realization plan is no longer current.', permittedNextAction: 'replan' as const };
  const outputs = [
    { id: 'output.instructions', sequence: 0, path: 'AGENTS.md', role: 'instructions' as const, action: 'create' as const, mode: '0644', beforeFingerprint: null, afterFingerprint: fp('c') },
    { id: 'output.configuration', sequence: 1, path: '.codex/config.toml', role: 'configuration' as const, action: 'replace' as const, mode: '0644', beforeFingerprint: fp('d'), afterFingerprint: fp('e') },
    { id: 'output.legacy-tools', sequence: 2, path: '.codex/legacy-tools.json', role: 'tools' as const, action: 'remove' as const, mode: null, beforeFingerprint: fp('f'), afterFingerprint: null }
  ];
  return {
    $contract: 'soter://contracts/host-realization-inspection/v1',
    contractVersion: '1.0.0',
    plan: {
      id: 'host-realization-plan.meeting-intake.ui-test', fingerprint: fp('1'),
      createdAt: '2026-07-16T16:00:00.000Z', validUntil: '2026-07-16T16:20:00.000Z', applicability
    },
    target: { fingerprint: fp('2') },
    host: {
      id: 'codex', adapter: 'host.codex',
      definition: { id: 'host-projection.codex', version: '0.3.0', fingerprint: fp('3') },
      generator: { id: 'core.host-projection-generator', version: '2.1.0', fingerprint: fp('4') }
    },
    configuration: { name: 'meeting-intake', lockFingerprint: fp('5'), graphFingerprint: fp('6') },
    scope: { fingerprint: fp('7'), outputs },
    request: requested ? {
      id: 'host-realization-request.meeting-intake.ui-test', fingerprint: fp('8'),
      state: confirmed ? 'confirmed' : stage === 'request-expired' ? 'expired' : 'current', at: '2026-07-16T16:08:00.000Z'
    } : null,
    confirmation: confirmed ? {
      id: 'host-realization-confirmation.meeting-intake.ui-test', fingerprint: fp('9'),
      state: 'confirmed', at: '2026-07-16T16:02:00.000Z', actor: 'local-studio-operator'
    } : null,
    consumption: started ? {
      id: 'host-realization-consumption.meeting-intake.ui-test', fingerprint: fp('a'),
      state: 'started', at: '2026-07-16T16:03:00.000Z'
    } : null,
    checkpoint: started ? {
      id: 'checkpoint.host-realization.meeting-intake.ui-test', fingerprint: fp('b'),
      state: completed ? 'completed' : needsAttention ? 'needs-attention' : recoverable ? 'applying' : 'prepared',
      phase: completed || needsAttention ? 'terminal' : recoverable ? 'outputs' : 'prepared',
      currentOutputId: recoverable ? outputs[1].id : null,
      outputs: outputs.map((output) => ({
        id: output.id,
        sequence: output.sequence,
        state: completed ? 'verified' as const : recoverable && output.sequence === 0 ? 'applied' as const : 'pending' as const
      })),
      failure: needsAttention ? { reasonCode: 'HOST_REALIZATION_OUTPUT_DRIFT', summary: 'Managed output does not match the exact prior or candidate fingerprint.' } : null
    } : null,
    resume,
    claims: {
      localProjection: completed ? 'passed' : 'unknown', hostLaunch: 'unknown', toolDiscovery: 'unknown',
      authentication: 'unknown', providerReachability: 'unknown', connectedBehavior: 'unknown', health: 'unknown'
    },
    inspectionFingerprint: fp('0')
  };
}

function projectPulseFixtureBundle() {
  const projectId = 'https://www.notion.so/11111111111111111111111111111111';
  const collectionId = 'collection.project-pulse.changes';
  const documentAction: PreparedReviewAction = {
    id: 'action.project-pulse.document-update', kind: 'project-document-update',
    capability: 'documents.content.update', effect: 'write', state: 'proposed',
    reasonCode: 'PROJECT_MILESTONE_UPDATE_READY_FOR_REVIEW', changeFingerprint: fp('0')
  };
  const statusAction: PreparedReviewAction = {
    id: 'action.project-pulse.status-create', kind: 'project-status-create',
    capability: 'projects.records.create', effect: 'write', state: 'proposed',
    reasonCode: 'PROJECT_STATUS_CREATE_READY_FOR_REVIEW', changeFingerprint: fp('0')
  };
  const documentRow: PreparedReviewRow = {
    id: 'row.project-pulse.document', sequence: 1, representedCount: 1,
    subject: { kind: 'project-document', fingerprint: fp('a') },
    group: 'project-pulse', attention: 'operator', disposition: 'itemized',
    reasonCode: documentAction.reasonCode, flags: [], actions: [documentAction],
    privateDetailFingerprint: null, fingerprint: fp('0')
  };
  const statusRow: PreparedReviewRow = {
    id: 'row.project-pulse.status', sequence: 2, representedCount: 1,
    subject: { kind: 'project-status', fingerprint: fp('b') },
    group: 'project-pulse', attention: 'operator', disposition: 'itemized',
    reasonCode: statusAction.reasonCode, flags: [], actions: [statusAction],
    privateDetailFingerprint: null, fingerprint: fp('0')
  };
  documentRow.fingerprint = reviewRowFixtureFingerprint(documentRow);
  statusRow.fingerprint = reviewRowFixtureFingerprint(statusRow);
  const batchActionIds = [documentAction.id, statusAction.id];
  const oldLine = '- [ ] **Launch readiness - ***Release materials are approved and published.*';
  const newLine = '- [ ] `in progress`**Launch readiness - ***Release materials are approved and published.*';
  const milestoneId = 'milestone.' + fingerprintJson({
    title: 'Launch readiness',
    lineFingerprint: fingerprintJson(oldLine)
  }).slice('sha256:'.length, 'sha256:'.length + 24);
  const documentItem = derivedItem(
    'review-item.project-pulse.document',
    'project-document-update',
    [{ collectionId, rowId: documentRow.id, rowFingerprint: documentRow.fingerprint }],
    {
      uri: projectId,
      expectedTitle: 'Healthy launch',
      expectedBodyFingerprint: fp('c'),
      afterBodyFingerprint: fp('d'),
      updateIds: [milestoneId],
      oldTexts: [oldLine],
      newTexts: [newLine],
      batchActionIds
    },
    projectPulseDerivedReviewDefinition
  );
  const statusItem = derivedItem(
    'review-item.project-pulse.status',
    'project-status-create',
    [{ collectionId, rowId: statusRow.id, rowFingerprint: statusRow.fingerprint }],
    {
      headline: 'Healthy launch — 2026-07-20 — on track',
      category: 'Status',
      date: '2026-07-20',
      summary: 'Promoted tasks: 1/2 done; 0 blocked.\nMilestones: 1/2 work items complete across 1 milestones.\nUnmatched project tasks: 0; excluded from milestone progress.\nHealth judgment: on track; observed basis: no blocked promoted task or risk-tagged milestone observed.',
      processed: false,
      visibility: 'Internal',
      projectIds: [projectId],
      batchActionIds
    },
    projectPulseDerivedReviewDefinition
  );
  documentRow.privateDetailFingerprint = documentItem.fingerprint;
  statusRow.privateDetailFingerprint = statusItem.fingerprint;
  const documentChange = {
    id: documentAction.id, recordId: 'document:synthetic-project',
    effect: documentAction.capability, beforeFingerprint: fp('c'), afterFingerprint: documentItem.fingerprint
  };
  const statusChange = {
    id: statusAction.id, recordId: 'new:project-status:synthetic',
    effect: statusAction.capability, beforeFingerprint: null, afterFingerprint: statusItem.fingerprint
  };
  documentAction.changeFingerprint = fingerprintJson(documentChange);
  statusAction.changeFingerprint = fingerprintJson(statusChange);
  const collection: PreparedWork['preview']['collections'][number] = {
    $contract: 'soter://contracts/prepared-work-review-collection/v1',
    contractVersion: '1.0.0', id: collectionId, kind: 'project-pulse-changes',
    labelKey: 'project-pulse-changes',
    coverage: { complete: true, observedCount: 2, includedCount: 2, excludedCount: 0, exclusions: [] },
    rows: [documentRow, statusRow], fingerprint: fp('0')
  };
  collection.fingerprint = collectionFixtureFingerprint(collection);
  const items = [documentItem, statusItem];
  const reviewContractFingerprint = fingerprintJson(projectPulseDerivedReviewDefinition);
  const contentFingerprint = fingerprintJson({ kind: 'project-pulse-derived-review', items });
  const contextPlan = [
    ['Load exact Projects policy', 'projects.records.read', 'authority.projects.definition'],
    ['Load selected Project and Task relations', 'projects.records.read', 'authority.projects.instance'],
    ['Load exact promoted Tasks', 'tasks.records.read', 'authority.tasks.instance'],
    ['Load exact Project milestone document', 'documents.content.read', 'authority.projects.instance']
  ].map(([label, capability, authority], index) => ({
    id: `preparation.context.${index + 1}`, sequence: index + 1, label, capability, authority,
    containment: 'fixture' as const, state: 'completed' as const,
    inputFingerprint: fp(((index + 4) % 16).toString(16)),
    outputFingerprint: fp(((index + 8) % 16).toString(16)),
    limitation: 'This typed fixture read does not establish connected identity, reachability, permission, or write behavior.'
  }));
  const work = finalizePreparedWork({
    $contract: 'soter://contracts/prepared-work/v1', contractVersion: '1.0.0',
    id: 'work.project-pulse.ui-test', fingerprint: fp('0'),
    createdAt: '2026-07-16T14:00:00.000Z', updatedAt: '2026-07-16T14:00:00.000Z',
    automation: { id: 'automation.project-pulse', version: '0.1.0' }, state: 'ready-for-review',
    history: [
      { state: 'draft', at: '2026-07-16T14:00:00.000Z', reasonCode: 'PREPARATION_DRAFTED' },
      { state: 'preparing', at: '2026-07-16T14:00:00.000Z', reasonCode: 'PREPARATION_STARTED' },
      { state: 'ready-for-review', at: '2026-07-16T14:00:00.000Z', reasonCode: 'PREPARATION_READY_FOR_REVIEW' }
    ],
    configuration: { name: 'project-pulse', path: 'soter/configurations/project-pulse.config.json', lockPath: 'soter/fixtures/project-pulse/project-pulse.lock.json', configurationBasis: 'tracked-contained', lockFingerprint: fp('1'), graphFingerprint: fp('2'), host: 'codex', applicability: 'current' },
    inputSummary: {
      $contract: 'soter://contracts/operator-input-summary/v1', contractVersion: '1.0.0', workId: 'work.project-pulse.ui-test', inputContractFingerprint: fp('3'),
      fields: [
        { id: 'project', state: 'provided', fingerprint: fp('4'), exposure: 'identifier', value: projectId },
        { id: 'statusDate', state: 'provided', fingerprint: fp('5'), exposure: 'private' },
        { id: 'visibility', state: 'provided', fingerprint: fp('6'), exposure: 'identifier', value: 'Internal' },
        { id: 'health', state: 'provided', fingerprint: fp('7'), exposure: 'identifier', value: 'on-track' },
        { id: 'healthMilestones', state: 'omitted', fingerprint: null, exposure: 'private' },
        { id: 'operatorGoal', state: 'provided', fingerprint: fp('7'), exposure: 'private' }
      ],
      privacy: { privateValuesIncluded: false, identifierValuesSanitized: true }
    },
    contextPlan,
    outcomes: [
      { id: 'project-status-preview', label: 'Grounded project status preview', state: 'supported', basis: ['context.project-pulse.policy-selection', 'context.project-pulse.project', 'context.project-pulse.tasks', 'context.project-pulse.document'], limitation: 'Private fixture review creates no approval or status record.' },
      { id: 'milestone-review', label: 'Exact milestone replacement review', state: 'supported', basis: ['context.project-pulse.policy-selection', 'context.project-pulse.project', 'context.project-pulse.tasks', 'context.project-pulse.document'], limitation: 'Milestone work-item progress and human-owned health remain distinct facts.' },
      { id: 'transaction-boundary', label: 'Status and milestone writes held behind one exact batch', state: 'supported', basis: ['context.project-pulse.policy-selection', 'context.project-pulse.project', 'context.project-pulse.tasks', 'context.project-pulse.document'], limitation: 'Preparation grants no write authority; proposal, exact selection, confirmation, one-time start, checkpoint, and verification remain separate.' }
    ],
    capabilities: { steps: contextPlan, completedPrefix: contextPlan.map((step) => step.id), current: null, pending: [] },
    effects: [
      { effect: 'read', mode: 'allow', state: 'completed-contained', reason: 'Exact contained source reads completed.' },
      { effect: 'disclosure', mode: 'allow', state: 'completed-contained', reason: 'Selected normalized review remains private local state.' },
      { effect: 'write', mode: 'confirm', state: 'not-executed', reason: 'Both exact writes require a later approval request and one-time start.' },
      { effect: 'dispatch', mode: 'prohibit', state: 'not-executed', reason: 'Project Pulse does not dispatch messages.' },
      { effect: 'destructive', mode: 'prohibit', state: 'not-executed', reason: 'Project Pulse declares no destructive operation.' }
    ],
    approval: { state: 'not-requested', requiredFor: ['write'], reason: 'The preview stops before writes; any later exact change batch requires a separate canonical approval request.' },
    readiness: { state: 'ready-for-review', blockers: [], limitations: ['No connected readiness or provider health established.'] },
    preview: {
      kind: 'project-pulse-preview', fingerprint: fp('0'),
      facts: [
        { id: 'project-record', label: 'Project record fingerprint', value: fp('8'), state: 'supported', basisIds: ['context.project-pulse.project'] },
        { id: 'promoted-task-count', label: 'Promoted tasks reviewed', value: 2, state: 'supported', basisIds: ['context.project-pulse.tasks'] },
        { id: 'promoted-task-completion', label: 'Promoted task completion', value: 50, state: 'supported', basisIds: ['context.project-pulse.tasks'] },
        { id: 'milestone-count', label: 'Milestones reviewed', value: 1, state: 'supported', basisIds: ['context.project-pulse.document'] },
        { id: 'project-health', label: 'Operator health judgment checked', value: 'on-track', state: 'supported', basisIds: ['context.project-pulse.policy-selection', 'context.project-pulse.tasks', 'context.project-pulse.document'] },
        { id: 'milestone-change-count', label: 'Milestone changes proposed', value: 1, state: 'supported', basisIds: ['context.project-pulse.document'] }
      ],
      contradictions: [], collections: [collection],
      privateReview: {
        state: 'available', kind: 'project-pulse-derived-review',
        contractId: 'soter://contracts/automation-derived-review/v1',
        contractFingerprint: reviewContractFingerprint, contentFingerprint
      },
      proposedChanges: [documentChange, statusChange]
    },
    evidence: [{ id: 'evidence.work.project-pulse.ui-test', claim: 'Fixture-contained Project Pulse preparation only.', result: 'passed', level: 'fixture', createdAt: '2026-07-16T14:00:00.000Z', limitations: ['No approval, execution, or write authority.'] }],
    checkpoint: { id: 'checkpoint.work.project-pulse.ui-test', fingerprint: fp('d'), runId: 'run.project-pulse.ui-test', contextSnapshotId: 'context.project-pulse.ui-test', state: 'ready-for-review' },
    resume: { classification: 'requires-review', reasonCode: 'PREPARATION_READY_FOR_REVIEW', reason: 'Sanitized collection and selected private values are ready for review.', permittedNextAction: 'review-prepared-work' },
    continuationRequest: null,
    privacy: { scope: 'private-derived', rawProviderResponsesIncluded: false, credentialValuesIncluded: false, privateInputValuesIncluded: false, canonicalArtifactsWritten: false, externalWritesPerformed: false }
  });
  const material: PreparedWorkDerivedReviewMaterial = {
    $contract: 'soter://contracts/prepared-work-derived-review-material/v1',
    contractVersion: '1.0.0', fingerprint: fp('0'), contentFingerprint,
    createdAt: work.createdAt, workId: work.id, preparedWorkFingerprint: work.fingerprint,
    checkpointId: work.checkpoint.id, checkpointFingerprint: work.checkpoint.fingerprint,
    automation: work.automation,
    configuration: {
      name: work.configuration.name,
      configurationBasis: work.configuration.configurationBasis,
      lockFingerprint: work.configuration.lockFingerprint
    },
    inputContractFingerprint: work.inputSummary.inputContractFingerprint,
    reviewContractId: 'soter://contracts/automation-derived-review/v1',
    reviewContractFingerprint, applicability: 'current', kind: 'project-pulse-derived-review', items,
    privacy: {
      scope: 'private-local-derived-review', authority: 'none', projection: 'selected-work-only',
      rawProviderResponsesIncluded: false, rawMessageBodiesIncluded: false,
      workspaceInspectionIncluded: false, evidenceIncluded: false, canonicalArtifactsIncluded: false
    }
  };
  const unsignedMaterial = structuredClone(material);
  delete (unsignedMaterial as Partial<typeof unsignedMaterial>).fingerprint;
  delete (unsignedMaterial as Partial<typeof unsignedMaterial>).applicability;
  material.fingerprint = fingerprintJson(unsignedMaterial);
  return { work, material };
}

export function preparedWorkFixture(): PreparedWork {
  return projectPulseFixtureBundle().work;
}

export function projectPulseDerivedReviewFixture(): PreparedWorkDerivedReviewMaterial {
  return projectPulseFixtureBundle().material;
}

export function preparedWorkReviewFixture(workId = 'work.project-pulse.ui-test'): PreparedWorkReviewMaterial {
  const meeting = workId.includes('meeting-intake');
  const work = meeting ? meetingIntakePreparedWorkFixture() : preparedWorkFixture();
  return {
    $contract: 'soter://contracts/prepared-work-review-material/v1',
    contractVersion: '1.0.0',
    fingerprint: fp('c'),
    createdAt: '2026-07-16T14:00:00.000Z',
    workId,
    preparedWorkFingerprint: work.fingerprint,
    checkpointId: meeting ? 'checkpoint.work.meeting-intake.ui-test' : 'checkpoint.work.project-pulse.ui-test',
    checkpointFingerprint: meeting ? fp('b') : fp('d'),
    automation: { id: meeting ? 'automation.meeting-intake' : 'automation.project-pulse', version: '0.1.0' },
    configuration: {
      name: meeting ? 'meeting-intake' : 'project-pulse',
      configurationBasis: work.configuration.configurationBasis,
      lockFingerprint: meeting ? fp('f') : fp('1')
    },
    inputContractFingerprint: meeting ? fp('1') : fp('3'),
    applicability: 'current',
    fields: meeting ? [
      { id: 'meeting', exposure: 'identifier', state: 'provided', fingerprint: fp('2'), reviewValue: 'meeting.fixture-001' },
      { id: 'recordingUri', exposure: 'private', state: 'provided', fingerprint: fp('3'), reviewValue: 'https://otter.ai/u/meeting_fixture_001' },
      { id: 'operatorGoal', exposure: 'private', state: 'provided', fingerprint: fp('4'), reviewValue: 'PRIVATE_MEETING_UI_GOAL' }
    ] : [
      { id: 'project', exposure: 'identifier', state: 'provided', fingerprint: fp('4'), reviewValue: 'https://www.notion.so/11111111111111111111111111111111' },
      { id: 'statusDate', exposure: 'private', state: 'provided', fingerprint: fp('5'), reviewValue: '2026-07-20' },
      { id: 'visibility', exposure: 'identifier', state: 'provided', fingerprint: fp('6'), reviewValue: 'Internal' },
      { id: 'health', exposure: 'identifier', state: 'provided', fingerprint: fp('7'), reviewValue: 'on-track' },
      { id: 'healthMilestones', exposure: 'private', state: 'omitted', fingerprint: null },
      { id: 'operatorGoal', exposure: 'private', state: 'provided', fingerprint: fp('7'), reviewValue: 'PRIVATE_UI_NOTE_SENTINEL' }
    ],
    privacy: {
      scope: 'private-local-review', authority: 'none', projection: 'selected-work-only'
    }
  };
}

export function taskCaptureWorkflowFixture(): Workflow {
  return {
    id: 'automation.task-capture',
    label: 'Automation Task Capture',
    summary: 'Grounds one exact Task create, projects private review, and compiles an exact selected action for Core-governed approval, single-use start, and verified connected execution.',
    version: '0.2.0',
    configuration: 'task-capture',
    configurationBasis: 'tracked-contained',
    host: 'codex',
    hostCompatibility: {
      claude: { state: 'compatible' },
      codex: { state: 'compatible' }
    },
    effects: ['read', 'disclosure', 'write'],
    requiredCapabilities: ['tasks.records.create', 'tasks.records.read', 'tasks.schema.read', 'projects.records.read', 'workspace.identity.read'],
    dependencies: ['context.tasks', 'context.projects', 'core.runtime'],
    bindings: ['tasks.records.create → integration.notion', 'tasks.records.read → integration.notion', 'tasks.schema.read → integration.notion', 'projects.records.read → integration.notion', 'workspace.identity.read → integration.notion'],
    operator: {
      inputContract: {
        id: 'input.automation.task-capture',
        version: '1.0.0',
        fields: [{
          id: 'title', label: 'Task title',
          description: 'Private actionable task title bound to the prepared review and withheld from workspace inspection.',
          type: 'string', required: true, exposure: 'private', constraints: { minLength: 3, maxLength: 240 }
        }, {
          id: 'project', label: 'Project reference',
          description: 'Exact authoritative project record identity required by the selected task policy.',
          type: 'reference', required: true, exposure: 'identifier',
          reference: { subject: 'projects.records.project', authorityRole: 'instance' }, constraints: { minLength: 3, maxLength: 240 }
        }, {
          id: 'assignee', label: 'Assignee',
          description: 'Optional current-user assignment resolved through the authenticated workspace instead of accepting an unverified person identifier.',
          type: 'enum', required: false, exposure: 'identifier', options: ['self']
        }, {
          id: 'nextActionOn', label: 'Next action date',
          description: 'Optional private calendar date pinned exactly as YYYY-MM-DD rather than a relative phrase.',
          type: 'date', required: false, exposure: 'private'
        }, {
          id: 'context', label: 'Task context',
          description: 'Optional portable context classification; a resolved project requires the Project classification.',
          type: 'enum', required: false, exposure: 'identifier', options: ['Internal', 'Service', 'Project', 'Client']
        }],
        additionalInputs: false
      },
      preparation: operatorPreparationProjection()
    },
    scenarios: [{
      id: 'task-capture.preparation', status: 'declared-not-executed', intent: 'operate',
      outcomes: ['task-policy.grounded', 'project.exactly-resolved', 'duplicates.bounded', 'task-create.previewed', 'writes-held-for-separate-authority'],
      invariants: ['private-title-excluded-from-inspection', 'calendar-date-pinned', 'relations-never-fabricated', 'deduplicate-before-create', 'no-write-or-approval-during-preparation'],
      evidence: ['exact-lock', 'policy-source-fingerprint', 'project-read-fingerprint', 'duplicate-query-fingerprint', 'private-review-material', 'write-boundary-state'],
      sourceCases: ['.claude/evals/capturing-a-task/happy-path.md', '.claude/evals/capturing-a-task/pressure-skip-resolve.md', '.claude/evals/capturing-a-task/invariant-no-fabricated-id.md'], migrationState: 'target-native', execution: null
    }],
    migration: { id: 'task-capture.prototype-to-v1', state: 'migrated', limitations: [] }
  };
}

export function taskCaptureConfigurationFixture(): Configuration {
  const base = structuredClone(studioFixture().configurations[1]);
  return {
    ...base,
    name: 'task-capture',
    selections: [
      { id: 'automation.task-capture', version: '0.2.0', layer: 'automation', source: 'user', reason: 'Selected policy-grounded task preparation.' },
      { id: 'context.tasks', version: '0.1.0', layer: 'context', source: 'dependency', reason: 'Portable Task meaning.' },
      { id: 'context.projects', version: '0.1.0', layer: 'context', source: 'dependency', reason: 'Portable Project identity and relation meaning.' },
      { id: 'integration.notion', version: '0.2.0', layer: 'integration', source: 'binding', reason: 'Configured task authority.' }
    ],
    bindings: [
      { capability: 'tasks.records.create', providerPack: 'integration.notion', authorities: ['authority.tasks.instance'], effects: ['write'], reason: 'Later separately authorized Task create.' },
      { capability: 'tasks.records.read', providerPack: 'integration.notion', authorities: ['authority.tasks.definition', 'authority.tasks.instance'], effects: ['read', 'disclosure'], reason: 'Contained policy and duplicate Task reads.' },
      { capability: 'tasks.schema.read', providerPack: 'integration.notion', authorities: ['authority.tasks.instance'], effects: ['read', 'disclosure'], reason: 'Current Task choice compatibility read.' },
      { capability: 'projects.records.read', providerPack: 'integration.notion', authorities: ['authority.projects.instance'], effects: ['read', 'disclosure'], reason: 'Contained exact Project read.' },
      { capability: 'workspace.identity.read', providerPack: 'integration.notion', authorities: ['authority.notion.provider'], effects: ['read', 'disclosure'], reason: 'Resolve the authenticated current user for optional self assignment.' }
    ],
    graphFingerprint: fp('7'),
    lockFingerprint: fp('8')
  };
}

export function taskCapturePreparedWorkFixture(contradiction: 'none' | 'duplicate' | 'context' = 'none'): PreparedWork {
  const proposed = contradiction === 'none';
  const contextPlan = [{
    id: 'preparation.context.1', sequence: 1, label: 'Load exact task-capture policy', capability: 'tasks.records.read', authority: 'authority.tasks.definition', containment: 'fixture' as const, state: 'completed' as const, inputFingerprint: fp('1'), outputFingerprint: fp('2'), limitation: 'Typed fixture read only; connected provider behavior remains unproven.'
  }, {
    id: 'preparation.context.2', sequence: 2, label: 'Read current Task schema', capability: 'tasks.schema.read', authority: 'authority.tasks.instance', containment: 'fixture' as const, state: 'completed' as const, inputFingerprint: fp('2'), outputFingerprint: fp('3'), limitation: 'Typed fixture schema only; connected provider option compatibility remains unproven.'
  }, {
    id: 'preparation.context.3', sequence: 3, label: 'Resolve exact Project', capability: 'projects.records.read', authority: 'authority.projects.instance', containment: 'fixture' as const, state: 'completed' as const, inputFingerprint: fp('3'), outputFingerprint: fp('4'), limitation: 'Typed fixture read only; connected provider behavior remains unproven.'
  }, {
    id: 'preparation.context.4', sequence: 4, label: 'Resolve authenticated current-user identity', capability: 'workspace.identity.read', authority: 'authority.notion.provider', containment: 'fixture' as const, state: 'completed' as const, inputFingerprint: fp('5'), outputFingerprint: fp('6'), limitation: 'Typed fixture identity read only; connected provider behavior remains unproven.'
  }, {
    id: 'preparation.context.5', sequence: 5, label: 'Inspect bounded duplicate Task candidates', capability: 'tasks.records.read', authority: 'authority.tasks.instance', containment: 'fixture' as const, state: 'completed' as const, inputFingerprint: fp('6'), outputFingerprint: fp('7'), limitation: 'Typed fixture read only; connected provider behavior remains unproven.'
  }];
  const contradictions = contradiction === 'duplicate'
    ? [{ id: 'duplicate-candidates-observed', claim: 'An exact-title task candidate exists and must be reviewed instead of silently creating a duplicate.', state: 'observed' as const, basisIds: ['context.task-capture.duplicates'] }]
    : contradiction === 'context'
      ? [{ id: 'project-context-conflict', claim: 'A task linked to the resolved project must use the Project context classification.', state: 'observed' as const, basisIds: ['context.task-capture.policy', 'context.task-capture.project'] }]
      : [];
  return finalizePreparedWork({
    $contract: 'soter://contracts/prepared-work/v1', contractVersion: '1.0.0',
    id: 'work.task-capture.ui-test', fingerprint: fp('a'), createdAt: '2026-07-16T15:00:00.000Z', updatedAt: '2026-07-16T15:00:00.000Z',
    automation: { id: 'automation.task-capture', version: '0.2.0' }, state: 'ready-for-review',
    history: [
      { state: 'draft', at: '2026-07-16T15:00:00.000Z', reasonCode: 'PREPARATION_DRAFTED' },
      { state: 'preparing', at: '2026-07-16T15:00:00.000Z', reasonCode: 'PREPARATION_STARTED' },
      { state: 'ready-for-review', at: '2026-07-16T15:00:00.000Z', reasonCode: 'PREPARATION_READY_FOR_REVIEW' }
    ],
    configuration: { name: 'task-capture', path: 'soter/configurations/task-capture.config.json', lockPath: 'soter/fixtures/task-capture/task-capture.lock.json', configurationBasis: 'tracked-contained', lockFingerprint: fp('8'), graphFingerprint: fp('7'), host: 'codex', applicability: 'current' },
    inputSummary: {
      $contract: 'soter://contracts/operator-input-summary/v1', contractVersion: '1.0.0', workId: 'work.task-capture.ui-test', inputContractFingerprint: fp('9'),
      fields: [
        { id: 'title', state: 'provided', fingerprint: fp('b'), exposure: 'private' },
        { id: 'project', state: 'provided', fingerprint: fp('c'), exposure: 'identifier', value: 'soter-fixture://projects/project/launch' },
        { id: 'assignee', state: 'provided', fingerprint: fp('d'), exposure: 'identifier', value: 'self' },
        { id: 'nextActionOn', state: 'provided', fingerprint: fp('e'), exposure: 'private' },
        { id: 'context', state: 'provided', fingerprint: fp('f'), exposure: 'identifier', value: contradiction === 'context' ? 'Client' : 'Project' }
      ],
      privacy: { privateValuesIncluded: false, identifierValuesSanitized: true }
    },
    contextPlan,
    outcomes: [
      { id: 'task-policy-grounded', label: 'Exact task-capture policy grounded', state: 'supported', basis: ['context.task-capture.policy'], limitation: 'Connected policy normalization remains unproven.' },
      { id: 'task-project-resolved', label: 'Exact project relation resolved', state: 'supported', basis: ['context.task-capture.project'], limitation: 'Connected record access remains unproven.' },
      { id: 'task-create-preview', label: 'Task create scope prepared for review', state: proposed ? 'proposed' : 'blocked', basis: ['context.task-capture.policy', 'context.task-capture.project', 'context.task-capture.duplicates'], limitation: proposed ? 'Fingerprint-only preview; later authority remains separate.' : 'A contradiction prevents a task-create proposal.' }
    ],
    capabilities: { steps: contextPlan, completedPrefix: contextPlan.map((step) => step.id), current: null, pending: [] },
    effects: [
      { effect: 'read', mode: 'allow', state: 'completed-contained', reason: 'Selected policy, project, and bounded task candidates may be read for private preparation.' },
      { effect: 'disclosure', mode: 'allow', state: 'completed-contained', reason: 'Selected records may enter the configured private run envelope with explicit minimization.' },
      { effect: 'write', mode: 'confirm', state: 'not-executed', reason: 'Every exact task-create batch requires a fresh confirmation and separately consumed one-time start authorization.' },
      { effect: 'dispatch', mode: 'prohibit', state: 'not-executed', reason: 'Task Capture does not send messages or publish notifications.' },
      { effect: 'destructive', mode: 'prohibit', state: 'not-executed', reason: 'Task Capture never deletes records or performs destructive changes.' }
    ],
    approval: { state: 'not-requested', requiredFor: ['write'], reason: 'The preview stops before writes; any later exact change batch requires a separate canonical approval request.' },
    readiness: { state: 'ready-for-review', blockers: [], limitations: ['Fixture-contained preparation establishes no connected readiness or provider health.'] },
    preview: {
      kind: 'task-capture-preview', fingerprint: fp('0'),
      facts: [
        { id: 'policy-identity', label: 'Task policy', value: 'Tasks', state: 'supported', basisIds: ['context.task-capture.policy'] },
        { id: 'project-identity', label: 'Resolved project', value: 'soter-fixture://projects/project/launch', state: 'supported', basisIds: ['context.task-capture.project'] },
        { id: 'default-status', label: 'Create status', value: 'To Do', state: 'supported', basisIds: ['context.task-capture.policy'] },
        { id: 'task-context', label: 'Task context', value: contradiction === 'context' ? 'Client' : 'Project', state: contradiction === 'context' ? 'contradicted' : 'supported', basisIds: ['context.task-capture.policy', 'context.task-capture.project'] },
        { id: 'duplicate-candidate-count', label: 'Duplicate candidates', value: contradiction === 'duplicate' ? 1 : 0, state: contradiction === 'duplicate' ? 'contradicted' : 'supported', basisIds: ['context.task-capture.duplicates'] },
        { id: 'next-action-pinned', label: 'Next action pinned', value: true, state: 'supported', basisIds: ['context.task-capture.policy'] },
        { id: 'assignee-reference-bound', label: 'Assignee identity resolved', value: true, state: 'supported', basisIds: ['context.task-capture.policy', 'context.task-capture.identity'] }
      ],
      contradictions,
      collections: [],
      privateReview: { state: 'unavailable', kind: null, contractId: null, contractFingerprint: null, contentFingerprint: null },
      proposedChanges: proposed ? [{ id: 'change.task-capture.create', recordId: 'new:task:7535c1734ebb1861', effect: 'tasks.records.create', beforeFingerprint: null, afterFingerprint: fp('1') }] : []
    },
    evidence: [{ id: 'evidence.work.task-capture.ui-test', claim: 'Fixture-contained Task Capture preparation only.', result: 'passed', level: 'fixture', createdAt: '2026-07-16T15:00:00.000Z', limitations: ['No approval, execution, or write authority.'] }],
    checkpoint: { id: 'checkpoint.work.task-capture.ui-test', fingerprint: fp('2'), runId: 'run.task-capture.ui-test', contextSnapshotId: 'context.task-capture.ui-test', state: 'ready-for-review' },
    resume: { classification: 'requires-review', reasonCode: 'PREPARATION_READY_FOR_REVIEW', reason: 'Contained context and preview fingerprints are ready for operator review.', permittedNextAction: 'review-prepared-work' },
    continuationRequest: null,
    privacy: { scope: 'private-derived', rawProviderResponsesIncluded: false, credentialValuesIncluded: false, privateInputValuesIncluded: false, canonicalArtifactsWritten: false, externalWritesPerformed: false }
  });
}

export function connectedAcquisitionPreparedWorkFixture(): PreparedWork {
  const work = structuredClone(taskCapturePreparedWorkFixture());
  work.id = 'work.task-capture.connected-acquisition.ui-test';
  work.preparationMode = 'connected-acquisition';
  work.state = 'ready-for-acquisition';
  work.history = [{
    state: 'draft',
    at: '2026-07-16T15:30:00.000Z',
    reasonCode: 'PREPARATION_DRAFTED'
  }, {
    state: 'ready-for-acquisition',
    at: '2026-07-16T15:30:00.000Z',
    reasonCode: 'PREPARATION_READY_FOR_ACQUISITION'
  }];
  work.createdAt = '2026-07-16T15:30:00.000Z';
  work.updatedAt = '2026-07-16T15:30:00.000Z';
  work.configuration.configurationBasis = 'private-active';
  work.inputSummary.workId = work.id;
  work.contextPlan = [];
  work.outcomes = [];
  work.capabilities = { steps: [], completedPrefix: [], current: null, pending: [] };
  work.effects = [];
  work.approval = {
    state: 'not-requested',
    requiredFor: [],
    reason: 'Preparation creates no approval or execution authority.'
  };
  work.readiness = {
    state: 'ready-for-acquisition',
    blockers: [],
    limitations: [
      'Connected acquisition is staged but no provider call or context acquisition has occurred.',
      'The receipt grants no approval, continuation, execution, write, readiness, verification, proof, maturity, or migration authority.'
    ]
  };
  work.preview = {
    kind: 'none',
    fingerprint: null,
    facts: [],
    contradictions: [],
    collections: [],
    privateReview: {
      state: 'unavailable',
      kind: null,
      contractId: null,
      contractFingerprint: null,
      contentFingerprint: null
    },
    proposedChanges: []
  };
  work.evidence = [];
  work.checkpoint = {
    id: `checkpoint.${work.id}`,
    fingerprint: fp('4'),
    runId: 'run.task-capture.connected-acquisition.ui-test',
    contextSnapshotId: null,
    state: 'ready-for-acquisition'
  };
  work.resume = {
    classification: 'unavailable',
    reasonCode: 'PREPARATION_READY_FOR_ACQUISITION',
    reason: 'Private input and the exact current lock are staged; connected acquisition has not started.',
    permittedNextAction: 'prepare-connected-acquisition'
  };
  work.continuationRequest = null;
  return finalizePreparedWork(work);
}

export function connectedAcquisitionReviewFixture(): PreparedWorkReviewMaterial {
  const work = connectedAcquisitionPreparedWorkFixture();
  return {
    ...taskCaptureReviewFixture(),
    fingerprint: fp('6'),
    createdAt: work.updatedAt,
    workId: work.id,
    preparedWorkFingerprint: work.fingerprint,
    checkpointId: work.checkpoint.id,
    checkpointFingerprint: work.checkpoint.fingerprint,
    automation: work.automation,
    configuration: {
      name: work.configuration.name,
      configurationBasis: work.configuration.configurationBasis,
      lockFingerprint: work.configuration.lockFingerprint
    },
    inputContractFingerprint: work.inputSummary.inputContractFingerprint
  };
}

export function taskCaptureReviewFixture(title = 'PRIVATE_TASK_UI_SENTINEL', nextActionOn = '2026-07-24'): PreparedWorkReviewMaterial {
  const work = taskCapturePreparedWorkFixture();
  return {
    $contract: 'soter://contracts/prepared-work-review-material/v1', contractVersion: '1.0.0', fingerprint: fp('3'), createdAt: work.updatedAt,
    workId: work.id, preparedWorkFingerprint: work.fingerprint, checkpointId: work.checkpoint.id, checkpointFingerprint: work.checkpoint.fingerprint,
    automation: work.automation, configuration: {
      name: work.configuration.name,
      configurationBasis: work.configuration.configurationBasis,
      lockFingerprint: work.configuration.lockFingerprint
    }, inputContractFingerprint: work.inputSummary.inputContractFingerprint,
    applicability: 'current',
    fields: [
      { id: 'title', exposure: 'private', state: 'provided', fingerprint: fp('b'), reviewValue: title },
      { id: 'project', exposure: 'identifier', state: 'provided', fingerprint: fp('c'), reviewValue: 'soter-fixture://projects/project/launch' },
      { id: 'assignee', exposure: 'identifier', state: 'provided', fingerprint: fp('d'), reviewValue: 'self' },
      { id: 'nextActionOn', exposure: 'private', state: 'provided', fingerprint: fp('e'), reviewValue: nextActionOn },
      { id: 'context', exposure: 'identifier', state: 'provided', fingerprint: fp('f'), reviewValue: 'Project' }
    ],
    privacy: { scope: 'private-local-review', authority: 'none', projection: 'selected-work-only' }
  };
}

export function meetingIntakePreparedWorkFixture(): PreparedWork {
  const work = preparedWorkFixture();
  const contextPlan = [
    ['Load applicable policy · docs', 'documents.content.read', 'authority.meetings.definition'],
    ['Load applicable policy · meetings', 'documents.content.read', 'authority.meetings.definition'],
    ['Load applicable policy · tasks', 'documents.content.read', 'authority.tasks.definition'],
    ['Load exact Meeting transcript', 'meeting.transcript.read', 'authority.otter.provider'],
    ['Resolve matching Meeting record', 'meetings.records.read', 'authority.meetings.instance'],
    ['Load referenced CRM organizations', 'crm.records.read', 'authority.crm.instance'],
    ['Load exact related Projects', 'projects.records.read', 'authority.projects.instance'],
    ['Load exact related Tasks', 'tasks.records.read', 'authority.tasks.instance']
  ].map(([label, capability, authority], index) => ({
    id: `preparation.context.${index + 1}`, sequence: index + 1, label, capability, authority,
    containment: 'fixture' as const, state: 'completed' as const,
    inputFingerprint: fp(((index + 5) % 16).toString(16)), outputFingerprint: fp(((index + 6) % 16).toString(16)),
    limitation: 'This is one typed fixture read; it does not establish connected reachability, permission, or provider health.'
  }));
  return finalizePreparedWork({
    ...work,
    id: 'work.meeting-intake.ui-test',
    fingerprint: fp('e'),
    automation: { id: 'automation.meeting-intake', version: '0.1.0' },
    configuration: {
      name: 'meeting-intake', path: 'soter/configurations/meeting-intake.config.json',
      lockPath: 'soter/fixtures/meeting-intake/meeting-intake.lock.json', configurationBasis: 'tracked-contained', lockFingerprint: fp('f'),
      graphFingerprint: fp('0'), host: 'codex', applicability: 'current'
    },
    inputSummary: {
      $contract: 'soter://contracts/operator-input-summary/v1', contractVersion: '1.0.0',
      workId: 'work.meeting-intake.ui-test', inputContractFingerprint: fp('1'),
      fields: [
        { id: 'meeting', state: 'provided', fingerprint: fp('2'), exposure: 'identifier', value: 'meeting.fixture-001' },
        { id: 'recordingUri', state: 'provided', fingerprint: fp('3'), exposure: 'private' },
        { id: 'operatorGoal', state: 'provided', fingerprint: fp('4'), exposure: 'private' }
      ],
      privacy: { privateValuesIncluded: false, identifierValuesSanitized: true }
    },
    contextPlan,
    outcomes: [
      { id: 'source-meeting-grounded', label: 'Exact source meeting and transcript grounded', state: 'supported', basis: ['context.meeting-intake.meeting', 'context.meeting-intake.transcript'], limitation: 'Fixture-contained context only.' },
      { id: 'policy-sources-grounded', label: 'Every configured applicable policy source grounded', state: 'supported', basis: ['context.meeting-intake.policy.docs', 'context.meeting-intake.policy.meetings', 'context.meeting-intake.policy.tasks'], limitation: 'Private policy bodies are not projected.' },
      { id: 'relationship-and-followup-review', label: 'Relationships and follow-up candidates require cited judgment', state: 'blocked', basis: ['context.meeting-intake.meeting', 'context.meeting-intake.projects', 'context.meeting-intake.tasks'], limitation: 'Preparation does not resolve participant identity, select transcript claims, choose task disposition, or propose a write batch.' }
    ],
    capabilities: {
      steps: contextPlan, completedPrefix: contextPlan.map((step) => step.id), current: null, pending: []
    },
    effects: [
      { effect: 'read', mode: 'allow', state: 'completed-contained', reason: 'Exact contained source reads completed.' },
      { effect: 'disclosure', mode: 'allow', state: 'completed-contained', reason: 'Selected normalized review remains private local state.' },
      { effect: 'write', mode: 'confirm', state: 'not-executed', reason: 'The selected Integration exposes separately governed writes, but Meeting Intake declares no write capability and its complete write group remains held.' },
      { effect: 'dispatch', mode: 'prohibit', state: 'not-executed', reason: 'Meeting Intake does not dispatch messages.' },
      { effect: 'destructive', mode: 'prohibit', state: 'not-executed', reason: 'Meeting Intake declares no destructive operation.' }
    ],
    approval: {
      state: 'not-requested',
      requiredFor: [],
      reason: 'No approval request exists. The later complete summary-and-task review remains held by COMPLETE_MEETING_READBACK_UNAVAILABLE before selection, batch, approval, start, checkpoint, provider write, or verification.'
    },
    preview: {
      kind: 'meeting-intake-review', fingerprint: fp('a'),
      facts: [
        { id: 'meeting-reference', label: 'Meeting', value: 'meeting.fixture-001', state: 'supported', basisIds: ['context.meeting-intake.meeting', 'context.meeting-intake.transcript'] },
        { id: 'transcript-segments', label: 'Transcript segments', value: 3, state: 'supported', basisIds: ['context.meeting-intake.transcript'] },
        { id: 'applicable-policies', label: 'Applicable policies', value: 3, state: 'supported', basisIds: ['context.meeting-intake.policy.docs', 'context.meeting-intake.policy.meetings', 'context.meeting-intake.policy.tasks'] },
        { id: 'participant-resolution', label: 'Participant identity resolution', value: null, state: 'unavailable', basisIds: ['context.meeting-intake.meeting'] }
      ],
      contradictions: [],
      collections: [],
      privateReview: { state: 'unavailable', kind: null, contractId: null, contractFingerprint: null, contentFingerprint: null },
      proposedChanges: []
    },
    evidence: [{ id: 'evidence.work.meeting-intake.ui-test', claim: 'Contained Meeting Intake preparation only.', result: 'passed', level: 'fixture', createdAt: '2026-07-16T14:00:00.000Z', limitations: ['No judgment, approval, or write authority.'] }],
    checkpoint: { id: 'checkpoint.work.meeting-intake.ui-test', fingerprint: fp('b'), runId: 'run.meeting-intake.ui-test', contextSnapshotId: 'context.meeting-intake.ui-test', state: 'ready-for-review' }
  });
}

export function emailTriageWorkflowFixture(): Workflow {
  return {
    id: 'automation.email-triage', label: 'Automation Email Triage',
    summary: 'Prepares one bounded deterministic Email review with private drafts, digest, and provider-neutral handoffs while stopping before authority or writes.',
    version: '0.1.0', configuration: 'email-triage', configurationBasis: 'tracked-contained', host: 'codex',
    hostCompatibility: {
      claude: { state: 'compatible' },
      codex: { state: 'compatible' }
    },
    effects: ['read', 'disclosure', 'write'],
    requiredCapabilities: ['mail.window.read', 'mail.labels.apply', 'mail.drafts.create'],
    dependencies: ['context.email', 'core.runtime'],
    bindings: ['mail.window.read → integration.gmail', 'mail.labels.apply → integration.gmail', 'mail.drafts.create → integration.gmail'],
    operator: {
      inputContract: {
        id: 'input.automation.email-triage', version: '1.0.0', additionalInputs: false,
        fields: [{
          id: 'query', label: 'Mailbox window query', description: 'Private exact mailbox query defining one bounded preparation window.',
          type: 'string', required: true, exposure: 'private', constraints: { minLength: 3, maxLength: 1000 }
        }, {
          id: 'scope', label: 'Processing scope', description: 'Portable outcome selection for triage, draft, handoff, and digest review without dispatch.',
          type: 'enum', required: true, exposure: 'identifier', options: ['triage-drafts-handoffs-digest']
        }, {
          id: 'focus', label: 'Private focus notes', description: 'Optional private attention notes that cannot suppress coverage or override policy.',
          type: 'string', required: false, exposure: 'private', constraints: { maxLength: 1000 }
        }]
      },
      preparation: operatorPreparationProjection()
    },
    scenarios: [{
      id: 'email-triage.happy-path', status: 'declared-not-executed', intent: 'operate',
      outcomes: ['mail-window-reduced', 'review-collections-sealed', 'private-review-material-created', 'writes-held'],
      invariants: ['single-bounded-query', 'complete-coverage-before-proposal', 'send-prohibited', 'private-content-excluded'],
      evidence: ['exact-lock', 'coverage-oracle', 'private-review-binding'],
      sourceCases: [
        '.claude/evals/processing-email/happy-path.md',
        '.claude/evals/processing-email/invariant-gated-writes.md',
        '.claude/evals/processing-email/pressure-injection.md'
      ],
      migrationState: 'target-native',
      execution: null
    }],
    migration: {
      id: 'email-triage.prototype-to-v1',
      state: 'migrated',
      limitations: ['Legacy source cases are fingerprinted tombstones only; no operational fallback remains. Label-only exact-subset approval, one-time start, synthetic read-after-write verification, and read-only no-retry reconciliation exist; draft or mixed execution and live Gmail readiness, permission, and verification remain unavailable.']
    }
  };
}

export function emailTriageConfigurationFixture(): Configuration {
  return {
    name: 'email-triage', status: 'selected', lockState: 'current', configurationBasis: 'tracked-contained', host: 'codex',
    maturity: {
      verified: 'unknown', reasonCode: 'EVIDENCE_MATURITY_DECLARED',
      host: { id: 'host.codex', claim: 'declared', state: 'declared', result: 'unknown', reasonCode: 'EVIDENCE_MATURITY_DECLARED', requiredLevel: 'fixture', evidenceIds: [], evidence: [], basis: 'Declared only.', limitations: ['No connected provider evidence.'], remediation: 'Run applicable connected verification.' },
      selections: []
    },
    selections: [],
    authorities: [{ id: 'authority.mail.instance', role: 'instance', subject: 'mail.mailbox', reason: 'Exact selected mailbox authority.' }],
    effectPolicies: [
      { effect: 'read', mode: 'allow', reason: 'Contained fixture reads only.' },
      { effect: 'disclosure', mode: 'allow', reason: 'Private contained review only.' },
      { effect: 'write', mode: 'confirm', reason: 'A later exact batch requires separate approval.' },
      { effect: 'dispatch', mode: 'prohibit', reason: 'Sending is prohibited.' },
      { effect: 'destructive', mode: 'prohibit', reason: 'Destructive effects are prohibited.' }
    ],
    bindings: [
      { capability: 'mail.window.read', providerPack: 'integration.gmail', authorities: ['authority.mail.instance'], effects: ['read', 'disclosure'], reason: 'Contained bounded read.' },
      { capability: 'mail.labels.apply', providerPack: 'integration.gmail', authorities: ['authority.mail.instance'], effects: ['write'], reason: 'Prepared proposal only.' },
      { capability: 'mail.drafts.create', providerPack: 'integration.gmail', authorities: ['authority.mail.instance'], effects: ['write'], reason: 'Draft proposal only.' }
    ],
    graphFingerprint: fp('7'), lockFingerprint: fp('8')
  };
}

export function emailTriagePreparedWorkFixture(): PreparedWork {
  return emailFixtureBundle().work;
}

export function emailTriageDerivedReviewFixture(): PreparedWorkDerivedReviewMaterial {
  return emailFixtureBundle().material;
}

export function emailTriageReviewFixture(): PreparedWorkReviewMaterial {
  const work = emailTriagePreparedWorkFixture();
  return {
    $contract: 'soter://contracts/prepared-work-review-material/v1', contractVersion: '1.0.0', fingerprint: fp('5'), createdAt: work.createdAt,
    workId: work.id, preparedWorkFingerprint: work.fingerprint, checkpointId: work.checkpoint.id, checkpointFingerprint: work.checkpoint.fingerprint,
    automation: work.automation, configuration: {
      name: work.configuration.name,
      configurationBasis: work.configuration.configurationBasis,
      lockFingerprint: work.configuration.lockFingerprint
    },
    inputContractFingerprint: work.inputSummary.inputContractFingerprint, applicability: 'current',
    fields: [
      { id: 'query', exposure: 'private', state: 'provided', fingerprint: fp('a'), reviewValue: 'SYNTHETIC_PRIVATE_MAILBOX_QUERY' },
      { id: 'scope', exposure: 'identifier', state: 'provided', fingerprint: fp('b'), reviewValue: 'triage-drafts-handoffs-digest' },
      { id: 'focus', exposure: 'private', state: 'provided', fingerprint: fp('c'), reviewValue: 'SYNTHETIC_PRIVATE_FOCUS_NOTE' }
    ],
    privacy: { scope: 'private-local-review', authority: 'none', projection: 'selected-work-only' }
  };
}

export function emailTriageAutomationProposalFixture(): AutomationProposal {
  return emailProposalBundle().proposal;
}

export function emailTriageAutomationProposalMaterialFixture(): AutomationProposalMaterial {
  return emailProposalBundle().material;
}

export function projectCaptureHeldAutomationProposalFixture(): AutomationProposal {
  return heldAutomationProposalFixture('project-capture');
}

export function meetingIntakeHeldAutomationProposalFixture(): AutomationProposal {
  return heldAutomationProposalFixture('meeting-intake');
}

function heldAutomationProposalFixture(kind: 'project-capture' | 'meeting-intake'): AutomationProposal {
  const proposal = structuredClone(emailTriageAutomationProposalFixture());
  const meeting = kind === 'meeting-intake';
  const specifications = meeting ? [{
    id: 'row.meeting-intake.summary',
    subjectKind: 'meeting-summary',
    actionId: 'action.meeting-intake.summary-create',
    actionKind: 'meeting-summary-create',
    reasonCode: 'COMPLETE_MEETING_READBACK_UNAVAILABLE'
  }, {
    id: 'row.meeting-intake.task-fold',
    subjectKind: 'meeting-task',
    actionId: 'action.meeting-intake.task-fold',
    actionKind: 'meeting-task-fold',
    reasonCode: 'COMPLETE_MEETING_READBACK_UNAVAILABLE'
  }, {
    id: 'row.meeting-intake.boundary',
    subjectKind: 'meeting-intake-boundary',
    actionId: 'action.meeting-intake.unsupported-effects',
    actionKind: 'meeting-intake-boundary',
    reasonCode: 'MEETING_LEGACY_EFFECTS_UNAVAILABLE'
  }] : [{
    id: 'row.project-capture.project',
    subjectKind: 'crm-project',
    actionId: 'action.project-capture.create',
    actionKind: 'project-create',
    reasonCode: 'COMPLETE_PROJECT_READBACK_UNAVAILABLE'
  }];
  const rows: PreparedReviewRow[] = specifications.map((specification, index) => {
    const row: PreparedReviewRow = {
      id: specification.id,
      sequence: index + 1,
      representedCount: 1,
      subject: { kind: specification.subjectKind, fingerprint: fp(((index + 2) % 16).toString(16)) },
      group: kind,
      attention: 'operator',
      disposition: 'itemized',
      reasonCode: specification.reasonCode,
      flags: [specification.reasonCode],
      actions: [{
        id: specification.actionId,
        kind: specification.actionKind,
        capability: null,
        effect: null,
        state: 'held',
        reasonCode: specification.reasonCode
      }],
      privateDetailFingerprint: fp(((index + 7) % 16).toString(16)),
      fingerprint: fp('0')
    };
    row.fingerprint = reviewRowFixtureFingerprint(row);
    return row;
  });
  const collection = {
    $contract: 'soter://contracts/prepared-work-review-collection/v1' as const,
    contractVersion: '1.0.0' as const,
    id: meeting ? 'collection.meeting-intake.changes' : 'collection.project-capture.project',
    kind: meeting ? 'meeting-intake-changes' : 'project-capture-project',
    labelKey: meeting ? 'meeting-intake-changes' : 'project-capture-project',
    coverage: {
      complete: true,
      observedCount: rows.length,
      includedCount: rows.length,
      excludedCount: 0,
      exclusions: []
    },
    rows,
    fingerprint: fp('0')
  };
  const unsignedCollection = structuredClone(collection);
  delete (unsignedCollection as Partial<typeof unsignedCollection>).fingerprint;
  collection.fingerprint = fingerprintJson(unsignedCollection);
  proposal.id = `proposal.${kind}.ui-held`;
  proposal.automation = { id: `automation.${kind}`, version: '0.1.0' };
  proposal.runId = `run.${kind}.ui-held`;
  proposal.decision = {
    id: `decision.${kind}.ui-held`,
    fingerprint: fp('3'),
    decisionType: `${kind}.decision`,
    contextSnapshotId: `context.${kind}.ui-held`,
    contextSnapshotFingerprint: fp('4')
  };
  proposal.proposalType = `${kind}.review-proposal`;
  proposal.review = {
    $contract: 'soter://contracts/automation-review/v1',
    contractVersion: '1.0.0',
    kind: `${kind}-review`,
    fingerprint: fp('0'),
    facts: [{
      id: 'held-review-boundary',
      label: 'Complete read-back authority',
      value: 'unavailable',
      state: 'supported',
      basisIds: [proposal.decision.contextSnapshotId]
    }],
    contradictions: [],
    collections: [collection],
    privateReview: {
      state: 'available',
      kind: `${kind}-derived-review`,
      contractId: 'soter://contracts/automation-derived-review/v1',
      contractFingerprint: fp('5'),
      contentFingerprint: fp('6')
    },
    proposedChanges: []
  };
  const unsignedReview = structuredClone(proposal.review);
  delete (unsignedReview as Partial<typeof unsignedReview>).fingerprint;
  proposal.review.fingerprint = fingerprintJson(unsignedReview);
  proposal.limitations = meeting ? [
    'The complete summary-and-task group remains private review material only.',
    'COMPLETE_MEETING_READBACK_UNAVAILABLE prevents selection, batch, approval, one-time start, checkpoint, provider write, or verification authority.'
  ] : [
    'The exact Project candidate remains private review material only.',
    'COMPLETE_PROJECT_READBACK_UNAVAILABLE prevents selection, batch, approval, one-time start, checkpoint, provider write, or verification authority.'
  ];
  const unsignedProposal = structuredClone(proposal);
  delete (unsignedProposal as Partial<typeof unsignedProposal>).proposalFingerprint;
  proposal.proposalFingerprint = fingerprintJson(unsignedProposal);
  return proposal;
}

export function emailTriageProposalConnectedPreviewFixture(actionIds?: string[]): ProposalConnectedBatchPreview {
  const { proposal, material } = emailProposalBundle();
  const available = proposal.review.collections.flatMap((collection) => collection.rows.flatMap((row) => (
    row.actions.filter((action) => action.state === 'proposed').map((action) => ({ row, action }))
  )));
  const selectedIds = new Set(actionIds || [available.find(({ action }) => action.kind === 'label')!.action.id]);
  const selected = available.filter(({ action }) => selectedIds.has(action.id));
  if (selected.length === 0 || selected.some(({ action }) => action.kind !== 'label')) {
    throw new Error('Synthetic connected preview supports the canonical label-only subset.');
  }
  const selectionFingerprint = fingerprintJson(selected.map(({ action }) => action.id));
  const provider = {
    pack: 'integration.gmail',
    connectedImplementation: 'provider.integration.gmail.mcp',
    version: '1.0.0'
  };
  const operations: ProposalConnectedBatchPreview['batch']['operations'] = selected.map(({ action }, index) => {
    const change = proposal.review.proposedChanges.find((candidate) => candidate.id === action.id);
    const proposed = change?.afterFingerprint
      ? material.items.find((item) => item.fingerprint === change.afterFingerprint)
      : null;
    const fields = new Map(proposed?.fields.map((field) => [field.id, field.reviewValue]));
    const messageIds = fields.get('messageIds');
    const labelName = fields.get('labelName');
    if (!change || !proposed || !Array.isArray(messageIds) || typeof labelName !== 'string') {
      throw new Error('Synthetic label proposal has no exact private material.');
    }
    const sortedMessageIds = [...messageIds].map(String).sort();
    const input = { messageIds: sortedMessageIds, addLabelNames: [labelName], removeLabelNames: [], createMissingLabels: false };
    const verificationInput = { messageIds: sortedMessageIds, labelNames: [labelName], maximumMessages: sortedMessageIds.length };
    const precondition = { kind: 'none' as const, capability: null, input: null, inputFingerprint: null, expectation: null };
    const after = { messageIds: sortedMessageIds, labelName };
    return {
      id: `operation.email.${action.id.slice('action.email.'.length)}`,
      sequence: index + 1,
      sourceActionId: action.id,
      capability: 'mail.labels.apply',
      authority: 'authority.mail.instance',
      provider,
      effect: 'write',
      input,
      inputFingerprint: fingerprintJson(input),
      precondition,
      verification: {
        capability: 'mail.labels.read',
        provider,
        input: verificationInput,
        inputFingerprint: fingerprintJson(verificationInput),
        expectation: {
          kind: 'mail-labels-present',
          expectedFingerprint: fingerprintJson({ messages: sortedMessageIds.map((messageId) => ({ messageId, labelNames: [labelName] })) })
        }
      },
      review: {
        subject: { kind: 'portable-resource', type: 'mail-message-set', id: null },
        before: { state: 'not-required', reasonCode: 'PRIOR_VALUE_NOT_REQUIRED', fingerprint: null },
        after: { state: 'provided', fingerprint: fingerprintJson(after), reviewValue: after },
        precondition: { fingerprint: fingerprintJson(precondition), reviewValue: precondition }
      },
      ambiguity: { retry: 'prohibited', reconcileWith: 'verification', unresolvedState: 'needs-attention', reasonCode: 'MAIL_LABEL_WRITE_AMBIGUOUS' },
      recovery: { mode: 'manual-required', reasonCode: 'MAIL_LABEL_REMOVAL_NOT_DECLARED' }
    };
  });
  const scopeFingerprint = fingerprintJson({
    proposal: proposal.proposalFingerprint,
    selectionFingerprint,
    operations: operations.map((operation) => ({ id: operation.id, inputFingerprint: operation.inputFingerprint }))
  });
  const createdAt = '2026-07-16T22:00:00.000Z';
  const changeSet: ProposalConnectedBatchPreview['changeSet'] = {
    $contract: 'soter://contracts/connected-change-set/v2',
    contractVersion: '2.0.0',
    id: 'changeset.email-triage.ui-test',
    runId: proposal.runId,
    createdAt,
    configurationLockFingerprint: proposal.configurationLockFingerprint,
    basis: {
      kind: 'automation-proposal',
      proposal: { id: proposal.id, fingerprint: proposal.proposalFingerprint },
      decision: { id: proposal.decision.id, fingerprint: proposal.decision.fingerprint },
      automation: proposal.automation,
      actionIds: selected.map(({ action }) => action.id),
      selectionFingerprint
    },
    state: 'proposed',
    scopeFingerprint,
    operations: operations.map((operation) => ({
      id: operation.id,
      sequence: operation.sequence,
      sourceActionId: operation.sourceActionId,
      capability: operation.capability,
      authority: operation.authority,
      reason: 'Apply one exact configured label to the selected provider message set.',
      input: structuredClone(operation.input),
      inputFingerprint: operation.inputFingerprint,
      state: 'pending',
      effectId: null,
      outputFingerprint: null,
      error: null
    })),
    approvalId: null,
    transaction: { checkpointFingerprint: fp('6'), state: 'not-started', rollbackState: 'not-available', restoredFingerprint: null },
    verification: {
      state: 'unknown', effectId: null,
      criteria: operations.map((operation) => `criterion.${operation.id}.read-after-write`),
      observedFingerprint: null
    }
  };
  const batch: ProposalConnectedBatchPreview['batch'] = {
    $contract: 'soter://contracts/connected-operation-batch/v2',
    contractVersion: '2.0.0',
    id: 'batch.email-triage.ui-test',
    runId: proposal.runId,
    createdAt,
    configurationLockFingerprint: proposal.configurationLockFingerprint,
    changeSet: { id: changeSet.id, scopeFingerprint },
    automation: proposal.automation,
    compiler: {
      module: 'soter/automations/email-triage/connected.mjs', moduleFingerprint: fp('e'),
      compileExport: 'compileEmailConnectedOperations', evaluateExport: 'evaluateEmailConnectedVerification'
    },
    profile: 'verified-write-sequence',
    state: 'proposed',
    executable: true,
    blockers: [],
    operations,
    batchFingerprint: fp('0')
  };
  const unsignedBatch = structuredClone(batch);
  delete (unsignedBatch as Partial<typeof unsignedBatch>).batchFingerprint;
  batch.batchFingerprint = fingerprintJson(unsignedBatch);
  return {
    changeSet,
    batch,
    selection: {
      availableActionCount: available.length,
      selectedActionCount: selected.length,
      partial: selected.length !== available.length,
      actionIds: selected.map(({ action }) => action.id),
      fingerprint: selectionFingerprint
    },
    authority: { state: 'none', reasonCode: 'CONNECTED_BATCH_PREVIEW_ONLY', permittedNextAction: 'request-exact-approval' },
    providerCallsExecuted: 0,
    externalWritesPerformed: 0
  };
}

function emailProposalBundle() {
  const work = emailTriagePreparedWorkFixture();
  const preparedMaterial = emailTriageDerivedReviewFixture();
  const collections = structuredClone(work.preview.collections);
  const items = structuredClone(preparedMaterial.items);
  const injectionRow = collections.flatMap((collection) => collection.rows)
    .find((row) => row.flags.includes('SUSPECTED_PROMPT_INJECTION'));
  if (!injectionRow) throw new Error('Synthetic Email proposal requires one injection row.');
  const removedActionIds = new Set(injectionRow.actions.map((action) => action.id));
  injectionRow.actions = [{
    id: `${injectionRow.id.replace(/^row\./, 'action.')}.injection-held`,
    kind: 'injection-hold', capability: null, effect: null, state: 'held',
    reasonCode: 'SUSPECTED_PROMPT_INJECTION'
  }];
  injectionRow.fingerprint = reviewRowFixtureFingerprint(injectionRow);
  for (const item of items) {
    item.sources = item.sources.map((source) => source.rowId === injectionRow.id
      ? { ...source, rowFingerprint: injectionRow.fingerprint }
      : source);
    const unsignedItem = structuredClone(item);
    delete (unsignedItem as Partial<typeof unsignedItem>).fingerprint;
    item.fingerprint = fingerprintJson(unsignedItem);
  }
  for (const collection of collections) {
    for (const row of collection.rows) {
      const detail = items.find((item) => item.sources.some((source) => source.collectionId === collection.id
        && source.rowId === row.id
        && source.rowFingerprint === row.fingerprint)
        && item.kind === (row.id === 'row.email.digest' ? 'digest' : 'thread-detail'));
      if (detail) row.privateDetailFingerprint = detail.fingerprint;
    }
    collection.fingerprint = collectionFixtureFingerprint(collection);
  }
  const proposedChanges = structuredClone(work.preview.proposedChanges)
    .filter((change) => !removedActionIds.has(change.id));
  const reviewContractFingerprint = fingerprintJson(emailDerivedReviewDefinition);
  const contentFingerprint = fingerprintJson({ kind: 'email-triage-derived-review', items });
  const review: AutomationProposal['review'] = {
    $contract: 'soter://contracts/automation-review/v1',
    contractVersion: '1.0.0',
    kind: 'email-triage-review',
    fingerprint: fp('0'),
    facts: [
      { id: 'observed-thread-count', label: 'Observed threads', value: 15, state: 'supported', basisIds: ['automation-proposal'] },
      { id: 'review-row-count', label: 'Review rows', value: 11, state: 'supported', basisIds: ['automation-proposal'] }
    ],
    contradictions: [{
      id: 'suspected-injection-held',
      claim: 'A suspected prompt-injection candidate remains held without a capability.',
      state: 'observed',
      basisIds: [injectionRow.id]
    }],
    collections,
    privateReview: {
      state: 'available', kind: 'email-triage-derived-review',
      contractId: 'soter://contracts/automation-derived-review/v1',
      contractFingerprint: reviewContractFingerprint, contentFingerprint
    },
    proposedChanges
  };
  const unsignedReview = structuredClone(review);
  delete (unsignedReview as Partial<typeof unsignedReview>).fingerprint;
  review.fingerprint = fingerprintJson(unsignedReview);
  const proposal: AutomationProposal = {
    $contract: 'soter://contracts/automation-proposal/v1', contractVersion: '1.0.0',
    id: 'proposal.email-triage.ui-test', automation: work.automation,
    runId: 'run.email-triage.connected.ui-test', createdAt: '2026-07-16T21:00:00.000Z',
    configurationLockFingerprint: work.configuration.lockFingerprint,
    graphFingerprint: work.configuration.graphFingerprint,
    decision: {
      id: 'decision.email-triage.ui-test', fingerprint: fp('1'),
      decisionType: 'email-triage', contextSnapshotId: 'context.email-triage.connected.ui-test',
      contextSnapshotFingerprint: fp('2')
    },
    producer: { kind: 'host', id: 'codex.studio-fixture', host: 'codex' },
    state: 'ready-for-review', proposalType: 'email-triage.review-proposal', review,
    limitations: [
      'This private review proposal itself creates no approval, confirmation, continuation, provider call, write, dispatch, proof, maturity, or migration authority.',
      'A label-only exact subset may enter the separate canonical approval and one-time-start family; draft or mixed execution and live Gmail readiness, permission, and verification remain unavailable.'
    ],
    authority: { state: 'none', reasonCode: 'AUTOMATION_PROPOSAL_REVIEW_ONLY', permittedNextAction: 'inspect-private-proposal-material' },
    privacy: {
      scope: 'private-sanitized-proposal', rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false, privateValuesIncluded: false,
      workspaceInspectionIncluded: false, evidenceIncluded: false,
      canonicalArtifactsWritten: false, externalWritesPerformed: false
    },
    proposalFingerprint: fp('0')
  };
  const unsignedProposal = structuredClone(proposal);
  delete (unsignedProposal as Partial<typeof unsignedProposal>).proposalFingerprint;
  proposal.proposalFingerprint = fingerprintJson(unsignedProposal);
  const material: AutomationProposalMaterial = {
    $contract: 'soter://contracts/automation-proposal-material/v1', contractVersion: '1.0.0',
    createdAt: proposal.createdAt,
    proposal: { id: proposal.id, fingerprint: proposal.proposalFingerprint },
    decision: { id: proposal.decision.id, fingerprint: proposal.decision.fingerprint },
    automation: proposal.automation,
    configuration: {
      name: work.configuration.name,
      lockFingerprint: proposal.configurationLockFingerprint,
      graphFingerprint: proposal.graphFingerprint
    },
    reviewContractId: 'soter://contracts/automation-derived-review/v1',
    reviewContractFingerprint, applicability: 'current',
    kind: 'email-triage-derived-review', contentFingerprint, items,
    authority: { state: 'none', reasonCode: 'AUTOMATION_PROPOSAL_MATERIAL_REVIEW_ONLY' },
    privacy: {
      scope: 'private-local-automation-proposal', projection: 'selected-proposal-only',
      rawProviderResponsesIncluded: false, credentialValuesIncluded: false,
      workspaceInspectionIncluded: false, evidenceIncluded: false,
      canonicalArtifactsIncluded: false
    },
    fingerprint: fp('0')
  };
  const unsignedMaterial = structuredClone(material);
  delete (unsignedMaterial as Partial<typeof unsignedMaterial>).fingerprint;
  delete (unsignedMaterial as Partial<typeof unsignedMaterial>).applicability;
  material.fingerprint = fingerprintJson(unsignedMaterial);
  return { proposal, material };
}

export function emailTriageReviewBatchFixture(actionIds?: string[]): PreparedReviewBatch {
  return emailReviewBatchBundle(actionIds).batch;
}

export function emailTriageReviewBatchMaterialFixture(actionIds?: string[]): PreparedReviewBatchMaterial {
  return emailReviewBatchBundle(actionIds).material;
}

export function emailTriageConnectedPlanFixture(actionIds?: string[]): PreparedConnectedPlan {
  const { batch, material } = emailReviewBatchBundle(actionIds);
  const connectedLabelProvider = { pack: 'integration.gmail', connectedImplementation: 'provider.integration.gmail.mcp', version: '1.0.0' };
  const unavailableDraftProvider = { pack: 'integration.gmail', connectedImplementation: null, version: null };
  const operations: PreparedConnectedPlan['operations'] = [];
  for (const action of material.actions) {
    const fields = new Map(action.proposed.fields.map((field) => [field.id, field.reviewValue]));
    if (action.selection.kind === 'label') {
      const messageIds = fields.get('messageIds');
      const labelName = fields.get('labelName');
      if (!Array.isArray(messageIds) || typeof labelName !== 'string') throw new Error('Synthetic label candidate is incomplete.');
      const sortedMessageIds = [...messageIds].sort();
      const input = { messageIds: sortedMessageIds, addLabelNames: [labelName], removeLabelNames: [], createMissingLabels: false };
      const verificationInput = { messageIds: sortedMessageIds, labelNames: [labelName], maximumMessages: sortedMessageIds.length };
      operations.push({
        id: `operation.email.label.${action.selection.sequence}`,
        sequence: operations.length + 1,
        sourceActionId: action.selection.id,
        capability: action.selection.capability,
        authority: 'authority.mail.instance',
        provider: connectedLabelProvider,
        effect: action.selection.effect,
        input,
        inputFingerprint: fingerprintJson(input),
        precondition: { kind: 'none', capability: null, input: null, inputFingerprint: null, expectation: null },
        verification: {
          capability: 'mail.labels.read', provider: connectedLabelProvider, input: verificationInput,
          inputFingerprint: fingerprintJson(verificationInput),
          expectation: {
            kind: 'mail-labels-present',
            expectedFingerprint: fingerprintJson({ messages: sortedMessageIds.map((messageId) => ({ messageId, labelNames: [labelName] })) })
          }
        },
        review: {
          subject: { kind: 'portable-resource', type: 'mail-message-set', id: null },
          before: { state: 'not-required', reasonCode: 'PRIOR_VALUE_NOT_REQUIRED', fingerprint: null },
          after: { state: 'provided', fingerprint: fingerprintJson({ messageIds: sortedMessageIds, labelName }), reviewValue: { messageIds: sortedMessageIds, labelName } },
          precondition: { fingerprint: fingerprintJson({ kind: 'none' }), reviewValue: { kind: 'none' } }
        },
        ambiguity: { retry: 'prohibited', reconcileWith: 'verification', unresolvedState: 'needs-attention', reasonCode: 'MAIL_LABEL_WRITE_AMBIGUOUS' },
        recovery: { mode: 'manual-required', reasonCode: 'MAIL_LABEL_REMOVAL_NOT_DECLARED' }
      });
      continue;
    }
    if (action.selection.kind === 'draft') {
      const replyMessageId = fields.get('replyMessageId');
      const recipients = fields.get('recipients');
      const subject = fields.get('subject');
      const body = fields.get('body');
      if (typeof replyMessageId !== 'string' || !Array.isArray(recipients)
        || typeof subject !== 'string' || typeof body !== 'string') throw new Error('Synthetic draft candidate is incomplete.');
      const idempotencyKey = `soter.draft.synthetic.${action.selection.sequence}`;
      const input = { replyMessageId, recipients, subject, body, idempotencyKey };
      const verificationInput = { replyMessageIds: [replyMessageId], idempotencyKeys: [idempotencyKey], maximumDrafts: 1 };
      const expectedAbsence = { kind: 'mail-draft-absent', expectedFingerprint: fingerprintJson({ drafts: [] }) };
      const precondition = {
        kind: 'expectation' as const,
        capability: 'mail.drafts.list',
        provider: unavailableDraftProvider,
        input: verificationInput,
        inputFingerprint: fingerprintJson(verificationInput),
        expectation: expectedAbsence
      };
      operations.push({
        id: `operation.email.draft.${action.selection.sequence}`,
        sequence: operations.length + 1,
        sourceActionId: action.selection.id,
        capability: action.selection.capability,
        authority: 'authority.mail.instance',
        provider: unavailableDraftProvider,
        effect: action.selection.effect,
        input,
        inputFingerprint: fingerprintJson(input),
        precondition,
        verification: {
          capability: 'mail.drafts.list', provider: unavailableDraftProvider, input: verificationInput,
          inputFingerprint: fingerprintJson(verificationInput),
          expectation: {
            kind: 'mail-draft-listed',
            expectedFingerprint: fingerprintJson({
              replyMessageId, idempotencyKey, contentFingerprint: fingerprintJson({ recipients, subject, body })
            })
          }
        },
        review: {
          subject: { kind: 'portable-resource', type: 'mail-draft', id: null },
          before: { state: 'absent-required', reasonCode: 'DEDUPLICATION_ABSENCE_REQUIRED', fingerprint: null },
          after: { state: 'provided', fingerprint: fingerprintJson(input), reviewValue: input },
          precondition: { fingerprint: fingerprintJson(precondition), reviewValue: precondition }
        },
        ambiguity: { retry: 'prohibited', reconcileWith: 'verification', unresolvedState: 'needs-attention', reasonCode: 'MAIL_DRAFT_CREATE_AMBIGUOUS' },
        recovery: { mode: 'manual-required', reasonCode: 'MAIL_DRAFT_DELETE_NOT_DECLARED' }
      });
    }
  }
  const compiler = {
    module: 'soter/automations/email-triage/connected.mjs', moduleFingerprint: fp('e'),
    compileExport: 'compileEmailConnectedOperations', evaluateExport: 'evaluateEmailConnectedVerification'
  };
  const plan: PreparedConnectedPlan = {
    $contract: 'soter://contracts/prepared-connected-plan/v1', contractVersion: '1.0.0',
    id: `prepared-connected-plan.email-triage.${fingerprintJson({ batch: batch.id, compiler, operations }).slice(7, 39)}`,
    fingerprint: fp('0'), createdAt: '2026-07-16T19:00:00.000Z',
    source: {
      batchId: batch.id, batchFingerprint: batch.fingerprint,
      workId: batch.work.id, workFingerprint: batch.work.fingerprint,
      checkpointId: batch.work.checkpointId, checkpointFingerprint: batch.work.checkpointFingerprint,
      automationId: batch.work.automationId, automationVersion: batch.work.automationVersion
    },
    configuration: { ...batch.configuration, applicability: 'current' },
    compiler,
    state: 'blocked-review-only', executable: false, effects: ['write'], operations,
    blockers: [
      ...(operations.some((operation) => operation.provider.connectedImplementation === null
        || operation.verification.provider.connectedImplementation === null) ? ['CONNECTED_PROVIDER_NOT_DECLARED' as const] : []),
      'CONNECTED_TRANSACTION_RUNTIME_NOT_SUPPORTED',
      'CONNECTED_VERIFICATION_NOT_PROVEN',
      'SELECTED_ACTIVITY_PRIVATE_APPROVAL_REVIEW_NOT_AVAILABLE'
    ],
    privacy: {
      scope: 'private-local-prepared-connected-plan', authority: 'none', projection: 'selected-plan-only',
      privateValuesIncluded: true, providerArgumentsIncluded: true, rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false, workspaceInspectionIncluded: false, evidenceIncluded: false,
      canonicalArtifactsIncluded: false, approvalAuthorityIncluded: false,
      continuationAuthorityIncluded: false, executionAuthorityIncluded: false, retryAuthorityIncluded: false
    }
  };
  const unsigned = structuredClone(plan);
  delete (unsigned as Partial<typeof unsigned>).fingerprint;
  delete (unsigned.configuration as Partial<typeof unsigned.configuration>).applicability;
  plan.fingerprint = fingerprintJson(unsigned);
  return plan;
}

function emailReviewBatchBundle(actionIds?: string[]) {
  const work = emailTriagePreparedWorkFixture();
  const derived = emailTriageDerivedReviewFixture();
  const available = work.preview.collections.flatMap((collection) => collection.rows.flatMap((row) => (
    row.actions.filter((action) => action.state === 'proposed').map((action) => ({ collection, row, action }))
  )));
  const defaultIds = available.slice(0, 2).map(({ action }) => action.id);
  const selectedIds = new Set(actionIds || defaultIds);
  const actions: PreparedReviewBatch['actions'] = available
    .filter(({ action }) => selectedIds.has(action.id))
    .map(({ collection, row, action }, index) => {
      if (action.state !== 'proposed') throw new Error('Synthetic selected action must be proposed.');
      const change = work.preview.proposedChanges.find((candidate) => candidate.id === action.id);
      if (!change?.afterFingerprint || !action.changeFingerprint) throw new Error('Synthetic selected action has no exact change.');
      return {
        id: action.id,
        sequence: index + 1,
        kind: action.kind,
        reasonCode: action.reasonCode,
        capability: action.capability,
        effect: action.effect,
        source: { collectionId: collection.id, rowId: row.id, rowFingerprint: row.fingerprint },
        subjectFingerprint: row.subject.fingerprint,
        sourceActionFingerprint: fingerprintJson(action),
        changeFingerprint: action.changeFingerprint,
        contextValueFingerprint: row.privateDetailFingerprint,
        proposedValueFingerprint: change.afterFingerprint
      };
    });
  const identity = {
    workId: work.id,
    workFingerprint: work.fingerprint,
    checkpointId: work.checkpoint.id,
    checkpointFingerprint: work.checkpoint.fingerprint,
    previewFingerprint: work.preview.fingerprint,
    lockFingerprint: work.configuration.lockFingerprint,
    actions
  };
  const scope = {
    availableActionCount: available.length,
    selectedActionCount: actions.length,
    partial: actions.length !== available.length,
    fingerprint: fingerprintJson(actions)
  };
  const batch: PreparedReviewBatch = {
    $contract: 'soter://contracts/prepared-review-batch/v1',
    contractVersion: '1.0.0',
    id: `review-batch.email-triage.${fingerprintJson(identity).slice(7, 39)}`,
    fingerprint: fp('0'),
    createdAt: '2026-07-16T18:30:00.000Z',
    work: {
      id: work.id,
      fingerprint: work.fingerprint,
      checkpointId: work.checkpoint.id,
      checkpointFingerprint: work.checkpoint.fingerprint,
      automationId: work.automation.id,
      automationVersion: work.automation.version
    },
    configuration: {
      name: work.configuration.name,
      path: work.configuration.path,
      lockPath: work.configuration.lockPath,
      configurationBasis: work.configuration.configurationBasis,
      lockFingerprint: work.configuration.lockFingerprint,
      graphFingerprint: work.configuration.graphFingerprint,
      host: work.configuration.host
    },
    preview: {
      kind: work.preview.kind,
      fingerprint: work.preview.fingerprint!,
      privateReviewKind: work.preview.privateReview.state === 'available' ? work.preview.privateReview.kind : 'unavailable',
      privateReviewContentFingerprint: work.preview.privateReview.state === 'available' ? work.preview.privateReview.contentFingerprint : fp('0')
    },
    state: 'review-only',
    effects: [...new Set(actions.map((action) => action.effect))].sort(),
    scope,
    actions,
    blockers: ['CONNECTED_PLAN_NOT_COMPILED', 'CONNECTED_VERIFICATION_NOT_PROVEN'],
    privacy: {
      scope: 'private-local-review-batch', authority: 'none', projection: 'selected-batch-only',
      privateValuesIncluded: false, providerArgumentsIncluded: false, rawProviderResponsesIncluded: false,
      credentialValuesIncluded: false, workspaceInspectionIncluded: false, evidenceIncluded: false,
      canonicalArtifactsIncluded: false, approvalAuthorityIncluded: false,
      continuationAuthorityIncluded: false, executionAuthorityIncluded: false
    }
  };
  const unsignedBatch = structuredClone(batch);
  delete (unsignedBatch as Partial<typeof unsignedBatch>).fingerprint;
  batch.fingerprint = fingerprintJson(unsignedBatch);

  const byFingerprint = new Map(derived.items.map((item) => [item.fingerprint, item]));
  const material: PreparedReviewBatchMaterial = {
    $contract: 'soter://contracts/prepared-review-batch-material/v1',
    contractVersion: '1.0.0',
    fingerprint: fp('0'),
    batch: { id: batch.id, fingerprint: batch.fingerprint, createdAt: batch.createdAt, state: batch.state },
    work: {
      id: work.id, fingerprint: work.fingerprint, checkpointId: work.checkpoint.id,
      checkpointFingerprint: work.checkpoint.fingerprint, automationId: work.automation.id
    },
    configuration: { ...batch.configuration, applicability: 'current' },
    scope: structuredClone(batch.scope),
    effects: [...batch.effects],
    actions: batch.actions.map((selection) => {
      const proposed = byFingerprint.get(selection.proposedValueFingerprint);
      const context = selection.contextValueFingerprint ? byFingerprint.get(selection.contextValueFingerprint) : null;
      if (!proposed || (selection.contextValueFingerprint && !context)) throw new Error('Synthetic selected material is incomplete.');
      return { selection: structuredClone(selection), context: context ? structuredClone(context) : null, proposed: structuredClone(proposed) };
    }),
    blockers: [...batch.blockers],
    privacy: {
      scope: 'private-local-review-batch-material', authority: 'none', projection: 'selected-batch-only',
      providerArgumentsIncluded: false, rawProviderResponsesIncluded: false, credentialValuesIncluded: false,
      workspaceInspectionIncluded: false, evidenceIncluded: false, canonicalArtifactsIncluded: false,
      approvalAuthorityIncluded: false, continuationAuthorityIncluded: false, executionAuthorityIncluded: false
    }
  };
  const unsignedMaterial = structuredClone(material);
  delete (unsignedMaterial as Partial<typeof unsignedMaterial>).fingerprint;
  delete (unsignedMaterial.configuration as Partial<typeof unsignedMaterial.configuration>).applicability;
  material.fingerprint = fingerprintJson(unsignedMaterial);
  return { batch, material };
}

function emailFixtureBundle() {
  type DerivedItem = PreparedWorkDerivedReviewMaterial['items'][number];
  const items: DerivedItem[] = [];
  const changes: PreparedWork['preview']['proposedChanges'] = [];
  const rowSpecs = [
    ['needs-you', 'operator', 'REPLY_OR_RESEARCH_REQUIRED', 1, 'itemized'],
    ['high-stakes', 'operator', 'SUSPECTED_PROMPT_INJECTION', 1, 'itemized'],
    ['meeting-notes', 'operator', 'MEETING_INTAKE_HANDOFF', 1, 'handoff'],
    ['rsvp-pending', 'operator', 'RSVP_PENDING', 1, 'handoff'],
    ['marketing', 'no-one', 'MARKETING_CLASSIFIED', 1, 'collapsed'],
    ['notifications', 'operator', 'ACTIONABLE_NOTIFICATION_FAILURE', 2, 'collapsed'],
    ['high-stakes', 'operator', 'MONEY_HUMAN_REVIEW_REQUIRED', 1, 'itemized'],
    ['admin-billing', 'operator', 'ADMIN_BILLING_REVIEW', 1, 'collapsed'],
    ['high-stakes', 'operator', 'HIGH_STAKES_HUMAN_REVIEW_REQUIRED', 1, 'itemized'],
    ['needs-you', 'operator', 'REPLY_OR_RESEARCH_REQUIRED', 1, 'itemized']
  ] as const;
  const rows = rowSpecs.map(([group, attention, reasonCode, representedCount, disposition], index) => {
    const sequence = index + 1;
    const base = `email.${String(sequence).padStart(3, '0')}`;
    const labelAction = {
      id: `action.${base}.label`, kind: 'label', capability: 'mail.labels.apply', effect: 'write' as const,
      state: 'proposed' as const, reasonCode: 'AI_NAMESPACE_LABEL_PROPOSED', changeFingerprint: fp('0')
    };
    const actions: PreparedReviewRow['actions'] = [labelAction];
    if (index === 0) {
      actions.push({ id: `action.${base}.draft`, kind: 'draft', capability: 'mail.drafts.create', effect: 'write', state: 'proposed', reasonCode: 'REPLY_DRAFT_PROPOSED', changeFingerprint: fp('0') });
      actions.push({ id: `action.${base}.task-handoff`, kind: 'task-review', capability: null, effect: null, state: 'handoff', reasonCode: 'RESEARCH_TASK_HANDOFF' });
    }
    if (index === 2) actions.push({ id: `action.${base}.meeting-handoff`, kind: 'meeting-notes-intake', capability: null, effect: null, state: 'handoff', reasonCode: 'MEETING_INTAKE_HANDOFF' });
    if (index === 3) actions.push({ id: `action.${base}.calendar-handoff`, kind: 'calendar-rsvp-review', capability: null, effect: null, state: 'handoff', reasonCode: 'CALENDAR_REVIEW_HANDOFF' });
    const row: PreparedReviewRow = {
      id: `row.${base}`, sequence, representedCount,
      subject: { kind: representedCount > 1 ? 'mail-bucket' : 'mail-thread', fingerprint: fingerprintJson({ syntheticSubject: sequence }) },
      group, attention, disposition, reasonCode,
      flags: reasonCode === 'SUSPECTED_PROMPT_INJECTION' ? ['SUSPECTED_PROMPT_INJECTION'] : [],
      actions, privateDetailFingerprint: null, fingerprint: fp('0')
    };
    row.fingerprint = reviewRowFixtureFingerprint(row);
    const source = [{ collectionId: 'collection.email.window', rowId: row.id, rowFingerprint: row.fingerprint }];
    const detail = derivedItem(`review-item.${base}.detail`, 'thread-detail', source, {
      sender: `synthetic-sender-${sequence}@example.test`, participants: [`synthetic-recipient-${sequence}@example.test`],
      subject: `Synthetic triage subject ${sequence}`, summary: `Synthetic normalized summary ${sequence}.`,
      reason: reasonCode, waitingOn: attention
    });
    row.privateDetailFingerprint = detail.fingerprint;
    items.push(detail);
    const label = derivedItem(`review-item.${base}.label`, 'label', source, {
      messageIds: [`gmail-message.synthetic.${String(sequence).padStart(3, '0')}`],
      labelName: `AI/Synthetic/${group}`
    });
    items.push(label);
    const labelChange = { id: labelAction.id, recordId: labelAction.id, effect: 'mail.labels.apply', beforeFingerprint: null, afterFingerprint: label.fingerprint };
    labelAction.changeFingerprint = fingerprintJson(labelChange);
    changes.push(labelChange);
    if (index === 0) {
      const draft = derivedItem(`review-item.${base}.draft`, 'draft', source, {
        replyMessageId: `gmail-message.synthetic.${String(sequence).padStart(3, '0')}`,
        recipients: ['synthetic-recipient@example.test'], subject: 'Synthetic draft subject',
        body: 'Synthetic complete draft body for local review. No message has been sent.'
      });
      items.push(draft);
      const draftAction = actions.find((action) => action.kind === 'draft' && action.state === 'proposed')!;
      const draftChange = { id: draftAction.id, recordId: draftAction.id, effect: 'mail.drafts.create', beforeFingerprint: null, afterFingerprint: draft.fingerprint };
      if ('changeFingerprint' in draftAction) draftAction.changeFingerprint = fingerprintJson(draftChange);
      changes.push(draftChange);
      items.push(derivedItem(`review-item.${base}.task-handoff`, 'task-handoff', source, { title: 'Synthetic research task', detail: 'Ground the open question before review.', context: 'Client' }));
    }
    if (index === 2) items.push(derivedItem(`review-item.${base}.meeting-handoff`, 'meeting-handoff', source, { meetingReference: fp('1'), sourceThreadReference: fp('2'), noteReference: fp('3') }));
    if (index === 3) items.push(derivedItem(`review-item.${base}.calendar-handoff`, 'calendar-handoff', source, { calendarReference: fp('4'), sourceThreadReference: fp('5') }));
    return row;
  });
  const windowCollection: PreparedWork['preview']['collections'][number] = {
    $contract: 'soter://contracts/prepared-work-review-collection/v1', contractVersion: '1.0.0',
    id: 'collection.email.window', kind: 'email-triage-window', labelKey: 'email-triage-window',
    coverage: {
      complete: true, observedCount: 15, includedCount: 11, excludedCount: 4,
      exclusions: [
        { reasonCode: 'NO_ACTIVE_INBOX_MESSAGE_REMOVED', count: 1 },
        { reasonCode: 'RFC822_ALIAS_DUPLICATE_REMOVED', count: 1 },
        { reasonCode: 'SELF_SENT_ONLY_REMOVED', count: 1 },
        { reasonCode: 'ALREADY_TRIAGED_NO_NEWER_REMOVED', count: 1 }
      ]
    }, rows, fingerprint: fp('0')
  };
  windowCollection.fingerprint = collectionFixtureFingerprint(windowCollection);

  const digestRow: PreparedReviewRow = {
    id: 'row.email.digest', sequence: 1, representedCount: 1,
    subject: { kind: 'email-digest', fingerprint: fingerprintJson(rows.map((row) => row.fingerprint)) },
    group: 'digest', attention: 'operator', disposition: 'itemized', reasonCode: 'DIGEST_READY_FOR_PRIVATE_REVIEW',
    flags: ['DIGEST_DESTINATION_UNAVAILABLE', 'EMAIL_SEND_PROHIBITED'],
    actions: [
      { id: 'action.email.digest.held', kind: 'none', capability: null, effect: null, state: 'held', reasonCode: 'DIGEST_DESTINATION_UNAVAILABLE' },
      { id: 'action.email.send.prohibited', kind: 'none', capability: null, effect: 'dispatch', state: 'prohibited', reasonCode: 'EMAIL_SEND_PROHIBITED' }
    ],
    privateDetailFingerprint: null, fingerprint: fp('0')
  };
  digestRow.fingerprint = reviewRowFixtureFingerprint(digestRow);
  const digestSources = [
    { collectionId: 'collection.email.outputs', rowId: digestRow.id, rowFingerprint: digestRow.fingerprint },
    ...rows.map((row) => ({ collectionId: 'collection.email.window', rowId: row.id, rowFingerprint: row.fingerprint }))
  ];
  const digest = derivedItem('review-item.email.digest', 'digest', digestSources, {
    body: 'Synthetic contained Email digest. Included items: 11. Drafts are not sent; external writes remain unapproved.'
  });
  digestRow.privateDetailFingerprint = digest.fingerprint;
  items.push(digest);
  const outputCollection: PreparedWork['preview']['collections'][number] = {
    $contract: 'soter://contracts/prepared-work-review-collection/v1', contractVersion: '1.0.0',
    id: 'collection.email.outputs', kind: 'email-triage-outputs', labelKey: 'email-triage-outputs',
    coverage: { complete: true, observedCount: 1, includedCount: 1, excludedCount: 0, exclusions: [] },
    rows: [digestRow], fingerprint: fp('0')
  };
  outputCollection.fingerprint = collectionFixtureFingerprint(outputCollection);

  const reviewContractFingerprint = fingerprintJson(emailDerivedReviewDefinition);
  const contentFingerprint = fingerprintJson({ kind: 'email-triage-derived-review', items });
  const contextPlan = [{
    id: 'preparation.context.1', sequence: 1, label: 'Read bounded mailbox window', capability: 'mail.window.read', authority: 'authority.mail.instance',
    containment: 'fixture' as const, state: 'completed' as const, inputFingerprint: fp('6'), outputFingerprint: fp('7'), limitation: 'Fixture-contained provider-neutral normalized read only.'
  }];
  const work = finalizePreparedWork({
    $contract: 'soter://contracts/prepared-work/v1', contractVersion: '1.0.0', id: 'work.email-triage.ui-test', fingerprint: fp('0'),
    createdAt: '2026-07-16T16:00:00.000Z', updatedAt: '2026-07-16T16:00:00.000Z', automation: { id: 'automation.email-triage', version: '0.1.0' }, state: 'ready-for-review',
    history: [
      { state: 'draft', at: '2026-07-16T16:00:00.000Z', reasonCode: 'PREPARATION_DRAFTED' },
      { state: 'preparing', at: '2026-07-16T16:00:00.000Z', reasonCode: 'PREPARATION_STARTED' },
      { state: 'ready-for-review', at: '2026-07-16T16:00:00.000Z', reasonCode: 'PREPARATION_READY_FOR_REVIEW' }
    ],
    configuration: { name: 'email-triage', path: 'soter/configurations/email-triage.config.json', lockPath: 'soter/fixtures/email-triage/email-triage.lock.json', configurationBasis: 'tracked-contained', lockFingerprint: fp('8'), graphFingerprint: fp('7'), host: 'codex', applicability: 'current' },
    inputSummary: {
      $contract: 'soter://contracts/operator-input-summary/v1', contractVersion: '1.0.0', workId: 'work.email-triage.ui-test', inputContractFingerprint: fp('9'),
      fields: [
        { id: 'query', state: 'provided', fingerprint: fp('a'), exposure: 'private' },
        { id: 'scope', state: 'provided', fingerprint: fp('b'), exposure: 'identifier', value: 'triage-drafts-handoffs-digest' },
        { id: 'focus', state: 'provided', fingerprint: fp('c'), exposure: 'private' }
      ],
      privacy: { privateValuesIncluded: false, identifierValuesSanitized: true }
    },
    contextPlan, outcomes: [
      { id: 'mail-window-reduced', label: 'Bounded mailbox window reduced completely', state: 'supported', basis: ['collection.email.window'], limitation: 'Contained normalized provider output only.' },
      { id: 'review-batch-held', label: 'Draft and label proposals held for later exact-batch review', state: 'proposed', basis: ['collection.email.window', 'collection.email.outputs'], limitation: 'No approval request, execution, or write authority exists.' }
    ],
    capabilities: { steps: contextPlan, completedPrefix: ['preparation.context.1'], current: null, pending: [] },
    effects: [
      { effect: 'read', mode: 'allow', state: 'completed-contained', reason: 'One bounded contained mailbox read completed.' },
      { effect: 'disclosure', mode: 'allow', state: 'completed-contained', reason: 'Selected normalized review remains private local state.' },
      { effect: 'write', mode: 'confirm', state: 'not-executed', reason: 'Fingerprint-only proposals are held before any approval request.' }
    ],
    approval: { state: 'not-requested', requiredFor: ['write'], reason: 'Prepared Email proposals are review facts only; selected-activity exact-batch review and approval are unavailable.' },
    readiness: { state: 'ready-for-review', blockers: [], limitations: ['Connected Gmail, exact-batch approval, execution, sending, and verification remain unavailable.'] },
    preview: {
      kind: 'email-triage-review', fingerprint: fp('0'), facts: [], contradictions: [], collections: [windowCollection, outputCollection],
      privateReview: {
        state: 'available', kind: 'email-triage-derived-review', contractId: 'soter://contracts/automation-derived-review/v1',
        contractFingerprint: reviewContractFingerprint, contentFingerprint
      }, proposedChanges: changes
    },
    evidence: [{ id: 'evidence.work.email-triage.ui-test', claim: 'Fixture-contained Email preparation only.', result: 'passed', level: 'fixture', createdAt: '2026-07-16T16:00:00.000Z', limitations: ['No connected provider, approval, execution, or write authority.'] }],
    checkpoint: { id: 'checkpoint.work.email-triage.ui-test', fingerprint: fp('d'), runId: 'run.email-triage.ui-test', contextSnapshotId: 'context.email-triage.ui-test', state: 'ready-for-review' },
    resume: { classification: 'requires-review', reasonCode: 'PREPARATION_READY_FOR_REVIEW', reason: 'Sanitized collections and selected private detail are available for review.', permittedNextAction: 'review-prepared-work' },
    continuationRequest: null,
    privacy: { scope: 'private-derived', rawProviderResponsesIncluded: false, credentialValuesIncluded: false, privateInputValuesIncluded: false, canonicalArtifactsWritten: false, externalWritesPerformed: false }
  });
  const material: PreparedWorkDerivedReviewMaterial = {
    $contract: 'soter://contracts/prepared-work-derived-review-material/v1', contractVersion: '1.0.0', fingerprint: fp('0'), contentFingerprint,
    createdAt: work.createdAt, workId: work.id, preparedWorkFingerprint: work.fingerprint, checkpointId: work.checkpoint.id, checkpointFingerprint: work.checkpoint.fingerprint,
    automation: work.automation, configuration: {
      name: work.configuration.name,
      configurationBasis: work.configuration.configurationBasis,
      lockFingerprint: work.configuration.lockFingerprint
    }, inputContractFingerprint: work.inputSummary.inputContractFingerprint,
    reviewContractId: 'soter://contracts/automation-derived-review/v1', reviewContractFingerprint, applicability: 'current', kind: 'email-triage-derived-review', items,
    privacy: {
      scope: 'private-local-derived-review', authority: 'none', projection: 'selected-work-only', rawProviderResponsesIncluded: false, rawMessageBodiesIncluded: false,
      workspaceInspectionIncluded: false, evidenceIncluded: false, canonicalArtifactsIncluded: false
    }
  };
  const unsignedMaterial = structuredClone(material);
  delete (unsignedMaterial as Partial<typeof unsignedMaterial>).fingerprint;
  delete (unsignedMaterial as Partial<typeof unsignedMaterial>).applicability;
  material.fingerprint = fingerprintJson(unsignedMaterial);
  return { work, material };
}

function derivedItem(
  id: string,
  kind: string,
  sources: PreparedWorkDerivedReviewMaterial['items'][number]['sources'],
  values: Record<string, string | boolean | string[]>,
  definition: {
    items: Array<{
      kind: string;
      fields: Array<{ id: string; label: string; type: string }>;
    }>;
  } = emailDerivedReviewDefinition
): PreparedWorkDerivedReviewMaterial['items'][number] {
  const declaration = definition.items.find((item) => item.kind === kind);
  if (!declaration) throw new Error(`Missing synthetic review declaration for ${kind}.`);
  const fields = declaration.fields.map((field) => ({
    id: field.id, label: field.label, type: field.type,
    fingerprint: fingerprintJson(values[field.id]), reviewValue: values[field.id]
  })) as PreparedWorkDerivedReviewMaterial['items'][number]['fields'];
  const item: PreparedWorkDerivedReviewMaterial['items'][number] = { id, kind, sources, fields, fingerprint: fp('0') };
  const unsigned = structuredClone(item);
  delete (unsigned as Partial<typeof unsigned>).fingerprint;
  item.fingerprint = fingerprintJson(unsigned);
  return item;
}

function reviewRowFixtureFingerprint(row: PreparedReviewRow) {
  const unsigned = structuredClone(row);
  delete (unsigned as Partial<typeof unsigned>).fingerprint;
  delete (unsigned as Partial<typeof unsigned>).privateDetailFingerprint;
  for (const action of unsigned.actions) {
    if ('changeFingerprint' in action) delete (action as Partial<typeof action>).changeFingerprint;
  }
  return fingerprintJson(unsigned);
}

function collectionFixtureFingerprint(collection: PreparedWork['preview']['collections'][number]) {
  const unsigned = structuredClone(collection);
  delete (unsigned as Partial<typeof unsigned>).fingerprint;
  return fingerprintJson(unsigned);
}

export function packReleaseInspectionFixture(): PackReleaseInspection {
  return {
    $contract: 'soter://contracts/pack-release-inspection/v1',
    contractVersion: '1.0.0',
    kind: 'pack-release',
    release: {
      id: 'kernel.soter',
      version: '0.1.0',
      layer: 'kernel',
      releaseStage: 'experimental',
      evidenceMaturity: 'declared',
      summary: 'Provider-neutral Soter Kernel contracts and deterministic verification behavior.',
      capsuleDigest: fp('1'),
      createdAt: '2026-07-16T12:00:00.000Z',
      generator: { id: 'kernel.soter.pack-release', version: '1.0.0', fingerprint: fp('2') },
      manifestFingerprint: fp('3'),
      sourceInputFingerprint: fp('4')
    },
    integrity: { state: 'passed', reasonCode: 'PACK_RELEASE_BYTES_VERIFIED', inventoryFingerprint: fp('5') },
    sourceComparison: { state: 'unknown', reasonCode: 'PACK_RELEASE_SOURCE_NOT_EVALUATED' },
    provenance: {
      kind: 'git', revision: '97ea7c4dcccbd9c5cba1241f6f8725a965da65e9', remoteLocatorFingerprint: fp('6'), exactInputState: 'clean',
      inputFingerprint: fp('4'), reproducibilityClaim: 'contained-determinism-only'
    },
    packageIntent: { state: 'present', private: true, sourceFingerprint: fp('7'), interpretation: 'packaging-intent-only' },
    legal: distributionLegalFixture(),
    trust: { state: 'unsigned-untrusted', signature: 'absent' },
    inventory: [
      { path: 'soter/packs/kernel.soter/pack.json', role: 'manifest', mode: '0644', bytes: 2048, contentFingerprint: fp('8') },
      { path: 'soter/kernel/verify.mjs', role: 'implementation', mode: '0755', bytes: 8192, contentFingerprint: fp('9') }
    ],
    constraints: {
      dependencies: [],
      capabilities: { requires: [], provides: [] },
      authorities: [],
      effects: [],
      compatibility: { baseContract: '^1.0.0', hosts: ['codex', 'claude'] }
    },
    evidenceReferences: [{
      id: 'evidence.kernel.fixture', fingerprint: fp('a'), graphFingerprint: fp('b'), result: 'passed', privacyScope: 'shareable',
      validUntil: null, applicableManifestFingerprint: fp('3'), limitations: ['Contained fixture evidence does not establish connected runtime behavior.']
    }],
    claims: {
      localReleaseBytes: 'passed', dependencyResolution: 'not-evaluated', installed: 'unknown', configured: 'unknown',
      ready: 'unknown', verified: 'unknown', healthy: 'unknown', networkAvailability: 'unknown', publisherIdentity: 'not-evaluated',
      publicationAuthority: 'not-evaluated', redistributionAuthority: 'not-evaluated', marketplaceEligibility: 'not-evaluated', trust: 'not-evaluated'
    },
    authority: { install: false, configure: false, realizeHost: false, publish: false, redistribute: false, marketplace: false, trust: false },
    privacy: {
      capsuleBytesIncluded: false, sourceRootIncluded: false, privateStateIncluded: false,
      credentialValuesIncluded: false, rawProviderResponsesIncluded: false, activeConfigurationIncluded: false
    },
    limitations: [
      { code: 'PACK_RELEASE_UNSIGNED', summary: 'This local release capsule has no publisher signature or trust assertion.' },
      { code: 'PACK_RELEASE_RUNTIME_UNEVALUATED', summary: 'Installation, configuration, readiness, verification, and health are not evaluated.' }
    ],
    inspectionFingerprint: fp('c')
  };
}

export function bundleInspectionFixture(state: 'resolved' | 'blocked' = 'resolved'): BundleInspection {
  const resolved = state === 'resolved';
  const resolution: BundleInspection['resolution'] = resolved
    ? { state: 'resolved', reasonCode: 'BUNDLE_RESOLVED', catalogFingerprint: fp('e'), resolutionFingerprint: fp('f'), blockers: [] }
    : {
      state: 'blocked', reasonCode: 'BUNDLE_BLOCKED', catalogFingerprint: fp('e'), resolutionFingerprint: fp('f'),
      blockers: [{ code: 'BUNDLE_RELEASE_MISSING', referenceId: 'reference.kernel', pack: 'kernel.soter', summary: 'The exact referenced local pack release is unavailable in the selected catalog.' }]
    };
  const references: BundleInspection['references'] = resolved
    ? [{
      id: 'reference.kernel', pack: 'kernel.soter', selection: { kind: 'exact', version: '0.1.0', capsuleDigest: fp('1') },
      reason: 'Bind the exact deterministic Kernel release required by this transparent bundle.', compatibilityLimitations: [],
      state: 'selected',
      selectedRelease: { pack: 'kernel.soter', version: '0.1.0', capsuleDigest: fp('1'), releaseStage: 'experimental', evidenceMaturity: 'declared' }
    }]
    : [{
      id: 'reference.kernel', pack: 'kernel.soter', selection: { kind: 'exact', version: '0.1.0', capsuleDigest: fp('1') },
      reason: 'Bind the exact deterministic Kernel release required by this transparent bundle.', compatibilityLimitations: [],
      state: 'blocked', selectedRelease: null
    }];
  return {
    $contract: 'soter://contracts/bundle-inspection/v1',
    contractVersion: '1.0.0',
    kind: 'bundle',
    bundle: {
      id: 'bundle.soter-studio', version: '0.1.0',
      summary: 'Transparent local bundle used to inspect one exact Soter Kernel release.',
      releaseStage: 'experimental', evidenceMaturity: 'declared', digest: fp('d'), createdAt: '2026-07-16T12:01:00.000Z',
      target: { baseContract: '1.0.0', hosts: ['codex', 'claude'] }
    },
    integrity: { state: 'passed', reasonCode: 'BUNDLE_BYTES_VERIFIED' },
    resolution,
    references,
    aggregate: {
      packs: resolved ? ['kernel.soter'] : [],
      dependencies: resolved ? [{ consumer: 'kernel.soter', pack: 'context.optional', version: '^1.0.0', optional: true }] : [],
      authorities: [], effects: [], compatibleHosts: resolved ? ['claude', 'codex'] : []
    },
    legal: distributionLegalFixture(),
    trust: { state: 'unsigned-untrusted', signature: 'absent' },
    claims: {
      localBundleBytes: 'passed', referencedReleaseBytes: resolved ? 'passed' : 'unknown', installed: 'unknown', configured: 'unknown',
      ready: 'unknown', verified: 'unknown', healthy: 'unknown', networkAvailability: 'unknown', publisherIdentity: 'not-evaluated',
      publicationAuthority: 'not-evaluated', redistributionAuthority: 'not-evaluated', marketplaceEligibility: 'not-evaluated', trust: 'not-evaluated'
    },
    authority: { install: false, configure: false, realizeHost: false, publish: false, redistribute: false, marketplace: false, trust: false, autoUpdate: false },
    privacy: { capsuleBytesIncluded: false, sourcePathsIncluded: false, privateStateIncluded: false, credentialValuesIncluded: false, activeConfigurationIncluded: false },
    limitations: [
      { code: 'BUNDLE_UNSIGNED', summary: 'This transparent bundle has no publisher signature or trust assertion.' },
      { code: 'BUNDLE_RUNTIME_UNEVALUATED', summary: 'Bundle resolution does not establish installation, configuration, readiness, or health.' }
    ],
    inspectionFingerprint: fp('0')
  };
}

export function packInstallInspectionFixture(stage: 'plan' | 'request' | 'confirmed' | 'started' | 'recoverable' | 'completed' | 'needs-attention' = 'plan'): PackInstallInspection {
  const requested = stage !== 'plan';
  const confirmed = ['confirmed', 'started', 'recoverable', 'completed', 'needs-attention'].includes(stage);
  const started = ['started', 'recoverable', 'completed', 'needs-attention'].includes(stage);
  const completed = stage === 'completed';
  const recoverable = stage === 'recoverable';
  const needsAttention = stage === 'needs-attention';
  const resume: PackInstallInspection['resume'] = completed
    ? { classification: 'unavailable', reasonCode: 'PACK_INSTALL_COMPLETED', reason: 'This local pack install checkpoint is terminal and grants no further execution authority.', permittedNextAction: 'none' }
    : needsAttention || recoverable
      ? { classification: 'requires-review', reasonCode: needsAttention ? 'PACK_INSTALL_ROLLBACK_OUTPUT_DRIFT' : 'PACK_INSTALL_RECOVERY_REQUIRED', reason: 'The durable checkpoint must be inspected and recovered from its exact observed state.', permittedNextAction: 'recover-checkpoint' }
      : started
        ? { classification: 'safe', reasonCode: 'PACK_INSTALL_CHECKPOINT_EXECUTABLE', reason: 'The durable checkpoint holds the consumed exact start and may execute once.', permittedNextAction: 'execute-checkpoint' }
        : confirmed
          ? { classification: 'safe', reasonCode: 'PACK_INSTALL_START_AVAILABLE', reason: 'The exact confirmation may be consumed once to create one durable install checkpoint.', permittedNextAction: 'start-install' }
          : requested
            ? { classification: 'safe', reasonCode: 'PACK_INSTALL_CONFIRMATION_AVAILABLE', reason: 'The current request may be confirmed for this exact local install plan.', permittedNextAction: 'confirm-request' }
            : { classification: 'safe', reasonCode: 'PACK_INSTALL_REQUEST_AVAILABLE', reason: 'The current exact plan may be submitted for an expiring operator confirmation.', permittedNextAction: 'create-request' };
  const effects: NonNullable<PackInstallInspection['plan']>['effects'] = [
    { id: 'pack-install-effect.0', sequence: 0, action: 'create', pack: 'kernel.soter', role: 'manifest', migrationRole: false, beforeFingerprint: null, afterFingerprint: fp('4'), reasonCode: 'PACK_INSTALL_FILE_CREATE', effectFingerprint: fp('5') },
    { id: 'pack-install-effect.1', sequence: 1, action: 'replace', pack: 'kernel.soter', role: 'implementation', migrationRole: false, beforeFingerprint: fp('6'), afterFingerprint: fp('7'), reasonCode: 'PACK_INSTALL_FILE_REPLACE', effectFingerprint: fp('8') },
    { id: 'pack-install-effect.2', sequence: 2, action: 'remove', pack: 'kernel.soter', role: 'projection', migrationRole: false, beforeFingerprint: fp('9'), afterFingerprint: null, reasonCode: 'PACK_INSTALL_FILE_REMOVE', effectFingerprint: fp('a') }
  ];
  return {
    $contract: 'soter://contracts/pack-install-inspection/v1',
    contractVersion: '1.0.0',
    kind: 'pack-install',
    plan: {
      id: 'pack-install-plan.ui-test', fingerprint: fp('1'),
      createdAt: '2026-07-16T18:00:00.000Z', validUntil: '2026-07-16T18:15:00.000Z',
      targetFingerprint: fp('2'), baseContract: '1.0.0', runtimeFingerprint: fp('3'),
      releases: [{
        pack: 'kernel.soter', version: '0.1.0', layer: 'kernel', capsuleDigest: fp('b'), manifestFingerprint: fp('c'),
        releaseStage: 'experimental', evidenceMaturity: 'declared',
        legal: { publisher: 'unasserted', license: 'no-assertion', legalSufficiency: 'not-evaluated' },
        trust: { state: 'unsigned-untrusted', signature: 'absent' }
      }],
      bundle: { state: 'absent', id: null, version: null, digest: null, resolutionFingerprint: null },
      dependencyCheck: {
        state: 'passed', reasonCode: 'PACK_INSTALL_DEPENDENCIES_RESOLVED', fingerprint: fp('d'),
        rows: [{ consumer: 'kernel.soter', dependency: 'context.optional', requiredRange: '^1.0.0', optional: true, selectedVersion: null, state: 'degraded', reasonCode: 'PACK_INSTALL_OPTIONAL_DEPENDENCY_ABSENT' }]
      },
      effects,
      scopeFingerprint: fp('e')
    },
    request: requested ? {
      id: 'pack-install-request.ui-test', fingerprint: fp('f'), createdAt: '2026-07-16T18:01:00.000Z',
      expiresAt: '2026-07-16T18:06:00.000Z', reason: 'Review and confirm this exact local pack install plan.', state: 'current'
    } : null,
    confirmation: confirmed ? { id: 'pack-install-confirmation.ui-test', fingerprint: fp('0'), confirmedAt: '2026-07-16T18:02:00.000Z', actor: 'studio.local-operator' } : null,
    consumption: started ? { id: 'pack-install-consumption.ui-test', fingerprint: fp('1'), state: 'started', checkpointId: 'checkpoint.pack-install.ui-test' } : null,
    checkpoint: started ? {
      id: 'checkpoint.pack-install.ui-test', fingerprint: fp('2'),
      state: completed ? 'completed' : needsAttention ? 'needs-attention' : recoverable ? 'applying' : 'prepared',
      reasonCode: completed ? 'PACK_INSTALL_COMPLETED' : needsAttention ? 'PACK_INSTALL_ROLLBACK_OUTPUT_DRIFT' : recoverable ? 'PACK_INSTALL_RECOVERY_REQUIRED' : 'PACK_INSTALL_CHECKPOINT_PREPARED',
      currentStep: recoverable ? effects[1].id : null,
      completedPrefix: completed ? effects.map((effect) => effect.id) : recoverable ? [effects[0].id] : [],
      pendingSteps: completed ? [] : recoverable ? [effects[2].id, 'pack-install-manifest'] : [...effects.map((effect) => effect.id), 'pack-install-manifest'],
      manifestState: completed ? 'verified' : 'pending',
      blocker: needsAttention ? 'PACK_INSTALL_ROLLBACK_OUTPUT_DRIFT' : recoverable ? 'PACK_INSTALL_RECOVERY_REQUIRED' : null
    } : null,
    resume,
    claims: {
      localReleaseBytes: 'passed', dependencyConstraints: 'passed', localMaterialization: completed ? 'passed' : needsAttention ? 'failed' : 'unknown',
      installedRegistry: completed ? 'passed' : needsAttention ? 'failed' : 'unknown', configured: 'unknown', hostRealization: 'unknown',
      npmDependencies: 'not-evaluated', ready: 'unknown', verified: 'unknown', healthy: 'unknown', networkAvailability: 'unknown',
      publisherIdentity: 'not-evaluated', legalSufficiency: 'not-evaluated', trust: 'not-evaluated'
    },
    authority: { fetch: false, install: false, upgrade: false, uninstall: false, configure: false, realizeHost: false, executeMigration: false, runPackageManager: false, network: false, publish: false, trust: false },
    privacy: { targetRootIncluded: false, capsulePathsIncluded: false, capsuleBytesIncluded: false, priorBytesIncluded: false, candidateBytesIncluded: false, rawManagedManifestIncluded: false, privateStateIncluded: false, credentialValuesIncluded: false, rawProviderResponsesIncluded: false },
    limitations: [
      'This inspection reports deterministic local materialization only and carries no executable authority.',
      'Publisher identity, legal sufficiency, trust, readiness, verification, health, and connected behavior remain unevaluated.'
    ],
    inspectionFingerprint: fp('3')
  };
}

function distributionLegalFixture() {
  return {
    publisher: { state: 'unasserted' as const }, license: { state: 'no-assertion' as const },
    publicationEligibility: 'not-evaluated' as const, redistributionEligibility: 'not-evaluated' as const,
    marketplaceEligibility: 'not-evaluated' as const, legalSufficiency: 'not-evaluated' as const
  };
}
