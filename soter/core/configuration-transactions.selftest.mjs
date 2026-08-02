import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  beginConfigurationChangeRequest,
  confirmConfigurationChangeRequest,
  executeConfigurationChange,
  inspectConfigurationChange,
  prepareConfigurationChange,
  prepareConfigurationChangeExecution,
  recoverConfigurationChange
} from './configuration-transactions.mjs';
import { fingerprintJson, readJson, writeJson } from './lib/canonical-json.mjs';
import { fingerprintLock, resolveConfiguration } from './resolve.mjs';
import {
  privateConfigurationStatePath,
  readPrivateConfigurationState,
  removePrivateConfigurationState,
  writePrivateConfigurationState
} from './private-configurations.mjs';
import { prepareAutomationRun } from './prepared-work.mjs';
import {
  activeConfigurationLockStatePath,
  configurationChangeConsumptionStatePath,
  configurationChangePlanStatePath,
  configurationTransactionCheckpointStatePath,
  removeActiveConfigurationLockState,
  readConfigurationTransactionCheckpointState,
  writeActiveConfigurationLockState
} from './runtime-state.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATED = '2026-07-16T15:00:00.000Z';
const CONFIRMED = '2026-07-16T15:01:00.000Z';
const EXPIRES = '2026-07-16T15:10:00.000Z';
const APPLIED = '2026-07-16T15:02:00.000Z';
const TASK_GROUNDING_FIELDS = [
  'sourceMeetingUris',
  'sourceQuotes',
  'sourceSummaryFingerprints'
];
const TASK_NOTION_FIELDS = [
  ['title', 'Name', 'title'],
  ['status', 'Status', 'status'],
  ['context', 'Context', 'select'],
  ['projectUris', 'Project', 'relation'],
  ['assigneeIds', 'Assigned To', 'person'],
  ['nextActionOn', 'Next Action', 'date']
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function copyRoot(root, prefix) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(root, temporary, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      return relative !== '.git'
        && !relative.startsWith('.git' + path.sep)
        && relative !== '.soter'
        && !relative.startsWith('.soter' + path.sep);
    }
  });
  return temporary;
}

function candidate(root, marker) {
  const file = path.join(root, 'soter/configurations/meeting-intake.config.json');
  const value = readJson(file);
  value.host = {
    id: 'claude',
    adapter: 'host.claude',
    version: '0.3.1',
    reason: 'Exercise the exact local configuration transaction through the declared Claude projection.'
  };
  value.authorities = value.authorities.map((authority) => authority.id === 'authority.crm.instance'
    ? { ...authority, uri: 'notion://private-configuration-' + marker }
    : authority);
  return value;
}

function historicalActiveLock(lock) {
  const value = structuredClone(lock);
  value.packs[0].manifestFingerprint = 'sha256:' + '1'.repeat(64);
  delete value.graphFingerprint;
  value.graphFingerprint = fingerprintJson(value);
  return value;
}

function reseal(value, property) {
  const unsigned = structuredClone(value);
  delete unsigned[property];
  value[property] = fingerprintJson(unsigned);
  return value;
}

function taskOptionMappingCandidate(root, statusProvider, contextProvider) {
  const file = path.join(root, 'soter/configurations/task-capture.config.json');
  const value = readJson(file);
  value.settings['integration.notion'].optionMappings = [
    {
      mapping: 'mapping.integration.notion.tasks-records',
      recordType: 'task',
      field: 'status',
      mode: 'exact-bijection',
      entries: [{ portable: 'To Do', provider: statusProvider }]
    },
    {
      mapping: 'mapping.integration.notion.tasks-records',
      recordType: 'task',
      field: 'context',
      mode: 'exact-bijection',
      entries: [{ portable: 'Project', provider: contextProvider }]
    },
    {
      mapping: 'mapping.integration.notion.projects-records',
      recordType: 'project',
      field: 'projectType',
      mode: 'exact-bijection',
      entries: [{
        portable: 'Internal Project',
        provider: 'PRIVATE_PROVIDER_PROJECT_TYPE_CONFIGURATION_SENTINEL'
      }]
    },
    {
      mapping: 'mapping.integration.notion.projects-records',
      recordType: 'project',
      field: 'status',
      mode: 'exact-bijection',
      entries: [{
        portable: 'Active',
        provider: 'PRIVATE_PROVIDER_PROJECT_STATUS_CONFIGURATION_SENTINEL'
      }]
    }
  ];
  return value;
}

function taskFieldBindingCandidate(root, statusProvider, contextProvider) {
  const value = taskOptionMappingCandidate(root, statusProvider, contextProvider);
  value.settings['integration.notion'].targets.tasks
    = 'collection://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const mapping = readJson(path.join(
    root,
    'soter/integrations/notion/tasks-records.mapping.json'
  ));
  const task = mapping.recordTypes.find((record) => record.id === 'task');
  value.settings['integration.notion'].fieldBindings = task.fields.map((field) => ({
    mapping: mapping.id,
    recordType: task.id,
    field: field.portable,
    state: 'mapped',
    provider: field.provider
  }));
  return value;
}

function projectPageReviewFieldBindingCandidate(root) {
  const value = readJson(path.join(
    root,
    'soter/configurations/project-page-review.config.json'
  ));
  value.settings['integration.notion'].targets.projects
    = 'collection://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  value.settings['integration.notion'].targets.tasks
    = 'collection://cccccccccccccccccccccccccccccccc';
  value.settings['integration.notion'].optionMappings = [
    {
      mapping: 'mapping.integration.notion.projects-records',
      recordType: 'project',
      field: 'projectType',
      mode: 'exact-bijection',
      entries: [{
        portable: 'Internal Project',
        provider: 'PRIVATE_PROJECT_REVIEW_TYPE_SENTINEL'
      }]
    },
    {
      mapping: 'mapping.integration.notion.projects-records',
      recordType: 'project',
      field: 'status',
      mode: 'exact-bijection',
      entries: [{
        portable: 'Active',
        provider: 'PRIVATE_PROJECT_REVIEW_STATUS_SENTINEL'
      }]
    },
    {
      mapping: 'mapping.integration.notion.tasks-records',
      recordType: 'task',
      field: 'status',
      mode: 'exact-bijection',
      entries: [{
        portable: 'To Do',
        provider: 'PRIVATE_TASK_REVIEW_STATUS_SENTINEL'
      }]
    },
    {
      mapping: 'mapping.integration.notion.tasks-records',
      recordType: 'task',
      field: 'context',
      mode: 'exact-bijection',
      entries: [{
        portable: 'Project',
        provider: 'PRIVATE_TASK_REVIEW_CONTEXT_SENTINEL'
      }]
    }
  ];
  value.settings['integration.notion'].fieldBindings = [
    ['soter/integrations/notion/projects-records.mapping.json', 'project'],
    ['soter/integrations/notion/tasks-records.mapping.json', 'task']
  ].flatMap(([relative, recordType]) => {
    const mapping = readJson(path.join(root, relative));
    const record = mapping.recordTypes.find((item) => item.id === recordType);
    return record.fields.map((field) => ({
      mapping: mapping.id,
      recordType,
      field: field.portable,
      state: 'mapped',
      provider: field.provider
    }));
  });
  return value;
}

function prepareAuthority(
  root,
  suffix,
  candidateConfiguration,
  configurationName = 'meeting-intake'
) {
  const planId = 'configuration-change-plan.' + suffix;
  const requestId = 'configuration-change-request.' + suffix;
  const confirmationId = 'configuration-change-confirmation.' + suffix;
  const checkpointId = 'checkpoint.configuration.' + suffix;
  const prepared = prepareConfigurationChange({
    root,
    name: configurationName,
    candidateConfiguration,
    id: planId,
    createdAt: CREATED
  });
  const request = beginConfigurationChangeRequest({
    root,
    planId,
    id: requestId,
    reason: 'Request confirmation for the exact selftest configuration candidate.',
    createdAt: CREATED,
    expiresAt: EXPIRES
  });
  const confirmation = confirmConfigurationChangeRequest({
    root,
    requestId,
    id: confirmationId,
    actor: { type: 'local-operator', id: 'operator.selftest' },
    reason: 'Confirm the exact selftest configuration candidate for local application.',
    confirmedAt: CONFIRMED
  });
  const execution = prepareConfigurationChangeExecution({
    root,
    confirmationId,
    checkpointId,
    at: APPLIED
  });
  return { planId, requestId, confirmationId, checkpointId, prepared, request, confirmation, execution };
}

function assertPrivateModes(root, planId, configurationName) {
  if (process.platform === 'win32') return;
  const planFile = configurationChangePlanStatePath(root, planId);
  assert((fs.statSync(planFile).mode & 0o7777) === 0o600, 'Configuration plan is not mode 0600.');
  assert((fs.statSync(path.dirname(planFile)).mode & 0o7777) === 0o700,
    'Configuration plan directory is not mode 0700.');
  const lockFile = activeConfigurationLockStatePath(root, configurationName);
  if (fs.existsSync(lockFile)) {
    assert((fs.statSync(lockFile).mode & 0o7777) === 0o600, 'Active configuration lock is not mode 0600.');
    assert((fs.statSync(path.dirname(lockFile)).mode & 0o7777) === 0o700,
      'Active configuration lock directory is not mode 0700.');
  }
  const desiredFile = privateConfigurationStatePath(root, configurationName);
  if (fs.existsSync(desiredFile)) {
    assert((fs.statSync(desiredFile).mode & 0o7777) === 0o600,
      'Private desired configuration is not mode 0600.');
    assert((fs.statSync(path.dirname(desiredFile)).mode & 0o7777) === 0o700,
      'Private desired configuration directory is not mode 0700.');
  }
}

export async function selftestConfigurationTransactions(root = defaultRoot) {
  const roots = [];
  try {
    const happy = copyRoot(root, 'soter-configuration-transaction-');
    roots.push(happy);
    const configPath = path.join(happy, 'soter/configurations/meeting-intake.config.json');
    const fixtureLockPath = path.join(happy, 'soter/fixtures/meeting-intake/meeting-intake.lock.json');
    const originalConfiguration = readJson(configPath);
    const originalConfigurationText = fs.readFileSync(configPath, 'utf8');
    const fixtureLockText = fs.readFileSync(fixtureLockPath, 'utf8');
    const portableEmailTemplate = readJson(path.join(
      happy,
      'soter/configurations/email-triage.config.json'
    ));
    const portableSelfAddresses = portableEmailTemplate.settings['integration.gmail'].selfAddresses;
    assert(portableSelfAddresses.length >= 1
      && portableSelfAddresses.every((address) => address.endsWith('.example'))
      && !JSON.stringify(portableEmailTemplate).includes('@soterlabs.com'),
    'Tracked configuration template retained user-specific mailbox identities.');
    const privateMarker = 'HOSTILE_PRIVATE_CONFIGURATION_SENTINEL';
    const exactCandidate = candidate(happy, privateMarker);
    const authority = prepareAuthority(happy, 'happy-selftest', exactCandidate);
    for (const [value, schemaName] of [
      [authority.prepared.plan, 'configuration-change-plan.schema.json'],
      [authority.request.request, 'configuration-change-request.schema.json'],
      [authority.execution.checkpoint, 'configuration-transaction-checkpoint.schema.json']
    ]) {
      const schema = readJson(path.join(happy, 'soter/contracts', schemaName));
      assert(validateJsonSchema(value, schema).length === 0,
        schemaName + ' rejected the exact private configuration transaction document.');
    }
    assertPrivateModes(happy, authority.planId, 'meeting-intake');
    const beforeInspection = inspectConfigurationChange({
      root: happy,
      planId: authority.planId,
      requestId: authority.requestId,
      confirmationId: authority.confirmationId,
      consumptionId: authority.execution.consumption.id,
      checkpointId: authority.checkpointId,
      at: APPLIED
    });
    assert(beforeInspection.resume.permittedNextAction === 'inspect-checkpoint',
      'Prepared configuration checkpoint did not project checkpoint-only continuation guidance.');
    assert(!JSON.stringify(beforeInspection).includes(privateMarker)
      && !JSON.stringify(beforeInspection).includes('notion://'),
    'Sanitized configuration inspection exposed private configuration values.');
    assert(!JSON.stringify(authority.request.request).includes(privateMarker)
      && !JSON.stringify(authority.execution.checkpoint).includes(privateMarker),
    'Request or checkpoint exposed private desired configuration values.');
    assert(beforeInspection.configuration.sourceKind === 'tracked-template'
      && !Object.hasOwn(beforeInspection.configuration, 'path')
      && !JSON.stringify(beforeInspection).includes('.soter/state')
      && !JSON.stringify(beforeInspection).includes('soter/configurations/'),
    'Sanitized configuration inspection exposed a private or portable configuration path.');
    const hostileInspection = structuredClone(beforeInspection);
    hostileInspection.configuration.candidateConfiguration = exactCandidate;
    hostileInspection.configuration.path = '.soter/state/configurations/meeting-intake.json';
    hostileInspection.scope.changes[0].before = 'HOSTILE_RAW_BEFORE_SENTINEL';
    hostileInspection.scope.changes[0].after = 'HOSTILE_RAW_AFTER_SENTINEL';
    hostileInspection.scope.changes[0].uri = 'notion://HOSTILE_PRIVATE_URI_SENTINEL';
    const inspectionSchema = readJson(path.join(
      happy,
      'soter/contracts/configuration-change-inspection.schema.json'
    ));
    assert(validateJsonSchema(hostileInspection, inspectionSchema).length >= 5,
      'Sanitized configuration inspection schema accepted raw configuration escape fields.');
    const completed = executeConfigurationChange({
      root: happy,
      checkpointId: authority.checkpointId,
      at: APPLIED
    });
    assert(completed.state === 'completed', 'Exact configuration transaction did not complete.');
    assert(fingerprintJson(readPrivateConfigurationState(happy, 'meeting-intake').configuration)
        === fingerprintJson(exactCandidate),
    'Exact candidate was not written to private desired configuration.');
    assert(fs.readFileSync(configPath, 'utf8') === originalConfigurationText,
      'Configuration transaction overwrote the portable tracked template.');
    const activeLock = readJson(activeConfigurationLockStatePath(happy, 'meeting-intake'));
    const resolved = resolveConfiguration({
      root: happy,
      configPath: privateConfigurationStatePath(happy, 'meeting-intake')
    });
    assert(fingerprintLock(activeLock) === fingerprintLock(resolved),
      'Private active lock does not equal the exact post-apply resolution.');
    assert(fs.readFileSync(fixtureLockPath, 'utf8') === fixtureLockText,
      'Configuration transaction changed checked-in fixture lock evidence.');
    assertPrivateModes(happy, authority.planId, 'meeting-intake');
    const afterInspection = inspectConfigurationChange({
      root: happy,
      planId: authority.planId,
      requestId: authority.requestId,
      confirmationId: authority.confirmationId,
      consumptionId: authority.execution.consumption.id,
      checkpointId: authority.checkpointId,
      at: APPLIED
    });
    assert(afterInspection.configuration.applicability === 'applied'
      && afterInspection.configuration.sourceKind === 'private-active'
      && afterInspection.checkpoint.state === 'completed'
      && afterInspection.resume.permittedNextAction === 'none',
    'Completed configuration inspection projected incorrect lifecycle state.');
    const repeatedPlan = prepareConfigurationChange({
      root: happy,
      name: 'meeting-intake',
      candidateConfiguration: exactCandidate,
      id: authority.planId,
      createdAt: CREATED
    });
    const repeatedRequest = beginConfigurationChangeRequest({
      root: happy,
      planId: authority.planId,
      id: authority.requestId,
      reason: 'Request confirmation for the exact selftest configuration candidate.',
      createdAt: CREATED,
      expiresAt: EXPIRES
    });
    const repeatedConfirmation = confirmConfigurationChangeRequest({
      root: happy,
      requestId: authority.requestId,
      id: authority.confirmationId,
      actor: { type: 'local-operator', id: 'operator.selftest' },
      reason: 'Confirm the exact selftest configuration candidate for local application.',
      confirmedAt: CONFIRMED
    });
    const repeatedExecution = prepareConfigurationChangeExecution({
      root: happy,
      confirmationId: authority.confirmationId,
      checkpointId: authority.checkpointId,
      at: '2026-07-16T16:00:00.000Z'
    });
    assert(repeatedPlan.plan.planFingerprint === authority.prepared.plan.planFingerprint
      && repeatedRequest.request.requestFingerprint === authority.request.request.requestFingerprint
      && repeatedConfirmation.confirmation.confirmationFingerprint
        === authority.confirmation.confirmation.confirmationFingerprint
      && repeatedExecution.checkpoint.state === 'completed',
    'Exact configuration transaction re-entry was not idempotent after completion and expiry.');
    let reuseRejected = false;
    try {
      prepareConfigurationChangeExecution({
        root: happy,
        confirmationId: authority.confirmationId,
        checkpointId: 'checkpoint.configuration.reuse-selftest',
        at: APPLIED
      });
    } catch (error) {
      reuseRejected = error.code === 'CONFIGURATION_CONFIRMATION_ALREADY_CONSUMED';
    }
    assert(reuseRejected, 'One-time configuration confirmation was reusable.');

    const optionMappings = copyRoot(root, 'soter-configuration-option-mappings-');
    roots.push(optionMappings);
    const taskConfigPath = path.join(
      optionMappings,
      'soter/configurations/task-capture.config.json'
    );
    const trackedTaskConfigurationText = fs.readFileSync(taskConfigPath, 'utf8');
    const trackedTaskLock = resolveConfiguration({
      root: optionMappings,
      configPath: taskConfigPath
    });
    const privateStatus = 'PRIVATE_PROVIDER_STATUS_CONFIGURATION_SENTINEL';
    const privateContext = 'PRIVATE_PROVIDER_CONTEXT_CONFIGURATION_SENTINEL';
    const taskCandidate = taskOptionMappingCandidate(
      optionMappings,
      privateStatus,
      privateContext
    );
    for (const [suffix, mutate] of [
      ['duplicate-option-scope', (value) => {
        const duplicate = structuredClone(
          value.settings['integration.notion'].optionMappings[0]
        );
        duplicate.entries = [{
          portable: 'In Progress',
          provider: 'PRIVATE_PROVIDER_STATUS_DUPLICATE_SCOPE_SENTINEL'
        }];
        value.settings['integration.notion'].optionMappings.push(duplicate);
      }],
      ['non-bijective-option-values', (value) => {
        value.settings['integration.notion'].optionMappings[0].entries.push({
          portable: 'In Progress',
          provider: privateStatus
        });
      }],
      ['unresolved-option-scope', (value) => {
        value.settings['integration.notion'].optionMappings[0].mapping
          = 'mapping.integration.notion.nonexistent';
      }],
      ['incomplete-option-scope-set', (value) => {
        value.settings['integration.notion'].optionMappings
          = value.settings['integration.notion'].optionMappings.filter((scope) => {
            return !(scope.mapping === 'mapping.integration.notion.tasks-records'
              && scope.recordType === 'task'
              && scope.field === 'context');
          });
      }],
      ['missing-option-scope-set', (value) => {
        delete value.settings['integration.notion'].optionMappings;
        value.settings['integration.notion'].targets.tasks
          = 'collection://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      }],
      ['trailing-option-control', (value) => {
        value.settings['integration.notion'].optionMappings[0].entries[0].provider
          = 'PRIVATE_PROVIDER_STATUS_TRAILING_CONTROL_SENTINEL\u007f';
      }]
    ]) {
      const invalidCandidate = structuredClone(taskCandidate);
      mutate(invalidCandidate);
      const invalidPlanId = 'configuration-change-plan.' + suffix;
      let rejected = false;
      try {
        prepareConfigurationChange({
          root: optionMappings,
          name: 'task-capture',
          candidateConfiguration: invalidCandidate,
          id: invalidPlanId,
          createdAt: CREATED
        });
      } catch (error) {
        rejected = error.code === 'CONFIGURATION_CANDIDATE_INVALID'
          && (suffix === 'trailing-option-control'
            ? /SOTER_PACK_SETTINGS_SCHEMA/.test(error.message)
            : /SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT/.test(error.message));
      }
      assert(rejected
        && !fs.existsSync(configurationChangePlanStatePath(
          optionMappings,
          invalidPlanId
        )),
      'Configuration planning admitted an invalid exact option bijection: ' + suffix + '.');
    }
    const fieldBindingCandidate = taskFieldBindingCandidate(
      optionMappings,
      privateStatus,
      privateContext
    );
    for (const [suffix, mutate, schemaFailure = false] of [
      ['duplicate-field-scope', (value) => {
        const duplicate = structuredClone(
          value.settings['integration.notion'].fieldBindings[0]
        );
        duplicate.provider = 'PRIVATE_PROVIDER_DUPLICATE_FIELD_SCOPE_SENTINEL';
        value.settings['integration.notion'].fieldBindings.push(duplicate);
      }],
      ['duplicate-provider-property', (value) => {
        const bindings = value.settings['integration.notion'].fieldBindings;
        const title = bindings.find((binding) => binding.field === 'title');
        bindings.find((binding) => binding.field === 'status').provider = title.provider;
      }],
      ['unresolved-field-scope', (value) => {
        value.settings['integration.notion'].fieldBindings[0].mapping
          = 'mapping.integration.notion.nonexistent';
      }],
      ['incomplete-field-scope-set', (value) => {
        value.settings['integration.notion'].fieldBindings
          = value.settings['integration.notion'].fieldBindings.filter((binding) => {
            return binding.field !== 'nextActionOn';
          });
      }],
      ['missing-field-scope-set', (value) => {
        delete value.settings['integration.notion'].fieldBindings;
      }],
      ['required-create-field-unavailable', (value) => {
        const binding = value.settings['integration.notion'].fieldBindings
          .find((item) => item.field === 'title');
        delete binding.provider;
        binding.state = 'unavailable';
        binding.reasonCode = 'PROVIDER_PROPERTY_UNAVAILABLE';
      }],
      ['option-scope-for-unavailable-field', (value) => {
        const binding = value.settings['integration.notion'].fieldBindings
          .find((item) => item.field === 'context');
        delete binding.provider;
        binding.state = 'unavailable';
        binding.reasonCode = 'PROVIDER_PROPERTY_UNAVAILABLE';
      }],
      ['fixture-target-field-binding', (value) => {
        value.settings['integration.notion'].fieldBindings.push({
          mapping: 'mapping.integration.notion.projects-records',
          recordType: 'project',
          field: 'name',
          state: 'mapped',
          provider: 'PRIVATE_FIXTURE_TARGET_PROVIDER_FIELD_SENTINEL'
        });
      }],
      ['trailing-field-control', (value) => {
        value.settings['integration.notion'].fieldBindings
          .find((binding) => binding.state === 'mapped').provider
          = 'PRIVATE_PROVIDER_FIELD_TRAILING_CONTROL_SENTINEL\u007f';
      }, true]
    ]) {
      const invalidCandidate = structuredClone(fieldBindingCandidate);
      mutate(invalidCandidate);
      const invalidPlanId = 'configuration-change-plan.' + suffix;
      let rejected = false;
      try {
        prepareConfigurationChange({
          root: optionMappings,
          name: 'task-capture',
          candidateConfiguration: invalidCandidate,
          id: invalidPlanId,
          createdAt: CREATED
        });
      } catch (error) {
        rejected = error.code === 'CONFIGURATION_CANDIDATE_INVALID'
          && (schemaFailure
            ? /SOTER_PACK_SETTINGS_SCHEMA/.test(error.message)
            : /SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT/.test(error.message));
      }
      assert(rejected
        && !fs.existsSync(configurationChangePlanStatePath(
          optionMappings,
          invalidPlanId
        )),
      'Configuration planning admitted an invalid provider field binding: ' + suffix + '.');
    }
    const projectReviewMappings = copyRoot(
      root,
      'soter-configuration-project-review-field-mappings-'
    );
    roots.push(projectReviewMappings);
    const projectReviewCandidate = projectPageReviewFieldBindingCandidate(
      projectReviewMappings
    );
    const projectReviewPlan = prepareConfigurationChange({
      root: projectReviewMappings,
      name: 'project-page-review',
      candidateConfiguration: projectReviewCandidate,
      id: 'configuration-change-plan.project-review-field-bindings-selftest',
      createdAt: CREATED
    });
    const taskMapping = readJson(path.join(
      projectReviewMappings,
      'soter/integrations/notion/tasks-records.mapping.json'
    ));
    const taskRecordMapping = taskMapping.recordTypes.find((record) => record.id === 'task');
    const taskContextModel = readJson(path.join(
      projectReviewMappings,
      'soter/contexts/tasks/records.model.json'
    ));
    const portableTask = taskContextModel.recordTypes.find((record) => record.id === 'task');
    const taskReviewBindings = projectReviewCandidate
      .settings['integration.notion'].fieldBindings
      .filter((binding) => binding.mapping === taskMapping.id
        && binding.recordType === taskRecordMapping.id);
    assert(/^sha256:[a-f0-9]{64}$/.test(projectReviewPlan.plan.planFingerprint)
      && fingerprintJson(taskRecordMapping.fields.map((field) => [
        field.portable,
        field.provider,
        field.providerType
      ])) === fingerprintJson(TASK_NOTION_FIELDS)
      && fingerprintJson(taskReviewBindings.map((binding) => [
        binding.field,
        binding.provider,
        binding.state
      ])) === fingerprintJson(TASK_NOTION_FIELDS.map(([portable, provider]) => [
        portable,
        provider,
        'mapped'
      ]))
      && fingerprintJson(taskRecordMapping.content) === fingerprintJson({
        portable: 'body',
        provider: 'page-content',
        providerType: 'markdown'
      })
      && portableTask.content.kind === 'markdown'
      && TASK_GROUNDING_FIELDS.every((field) => {
        return portableTask.fields.some((candidateField) => candidateField.id === field)
          && !taskRecordMapping.fields.some((providerField) => providerField.portable === field)
          && !taskReviewBindings.some((binding) => binding.field === field);
      }),
    'Read-only Project-page configuration did not preserve the exact six-field Task mapping, markdown page-content body, and intentionally unmapped portable grounding fields.');
    for (const groundingField of TASK_GROUNDING_FIELDS) {
      const invalidCandidate = structuredClone(projectReviewCandidate);
      invalidCandidate.settings['integration.notion'].fieldBindings.push({
        mapping: taskMapping.id,
        recordType: taskRecordMapping.id,
        field: groundingField,
        state: 'unavailable',
        reasonCode: 'PROVIDER_PROPERTY_UNAVAILABLE'
      });
      const invalidPlanId = 'configuration-change-plan.project-review-unmapped-'
        + groundingField.replace(/[A-Z]/g, (character) => '-' + character.toLowerCase());
      let rejected = false;
      try {
        prepareConfigurationChange({
          root: projectReviewMappings,
          name: 'project-page-review',
          candidateConfiguration: invalidCandidate,
          id: invalidPlanId,
          createdAt: CREATED
        });
      } catch (error) {
        rejected = error.code === 'CONFIGURATION_CANDIDATE_INVALID'
          && /SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT/.test(error.message);
      }
      assert(rejected
        && !fs.existsSync(configurationChangePlanStatePath(
          projectReviewMappings,
          invalidPlanId
        )),
      'Read-only Project-page configuration admitted obsolete provider binding for portable grounding field: '
        + groundingField + '.');
    }
    for (const [suffix, mapping, recordType, field] of [
      [
        'project-review-project-name-unavailable',
        'mapping.integration.notion.projects-records',
        'project',
        'name'
      ],
      [
        'project-review-task-title-unavailable',
        'mapping.integration.notion.tasks-records',
        'task',
        'title'
      ],
      [
        'project-review-task-status-unavailable',
        'mapping.integration.notion.tasks-records',
        'task',
        'status'
      ]
    ]) {
      const invalidCandidate = structuredClone(projectReviewCandidate);
      const binding = invalidCandidate.settings['integration.notion'].fieldBindings
        .find((item) => item.mapping === mapping
          && item.recordType === recordType
          && item.field === field);
      delete binding.provider;
      binding.state = 'unavailable';
      binding.reasonCode = 'PROVIDER_PROPERTY_UNAVAILABLE';
      const invalidPlanId = 'configuration-change-plan.' + suffix;
      let rejected = false;
      try {
        prepareConfigurationChange({
          root: projectReviewMappings,
          name: 'project-page-review',
          candidateConfiguration: invalidCandidate,
          id: invalidPlanId,
          createdAt: CREATED
        });
      } catch (error) {
        rejected = error.code === 'CONFIGURATION_CANDIDATE_INVALID'
          && /SOTER_PACK_SETTINGS_SEMANTIC_INVARIANT/.test(error.message);
      }
      assert(rejected
        && !fs.existsSync(configurationChangePlanStatePath(
          projectReviewMappings,
          invalidPlanId
        )),
      'Read-only Project-page configuration admitted unavailable non-nullable field: '
        + recordType + '.' + field + '.');
    }
    const fieldBindingPlan = prepareConfigurationChange({
      root: optionMappings,
      name: 'task-capture',
      candidateConfiguration: fieldBindingCandidate,
      id: 'configuration-change-plan.field-bindings-selftest',
      createdAt: CREATED
    });
    const fieldBindingInspection = inspectConfigurationChange({
      root: optionMappings,
      planId: fieldBindingPlan.plan.id,
      at: CREATED
    });
    const sanitizedFieldBindingInspection = JSON.stringify(fieldBindingInspection);
    assert(!sanitizedFieldBindingInspection.includes('fieldBindings')
      && !sanitizedFieldBindingInspection.includes('PRIVATE_PROVIDER')
      && !sanitizedFieldBindingInspection.includes('Source Meetings')
      && !sanitizedFieldBindingInspection.includes('Grounding'),
    'Sanitized configuration inspection exposed private provider field bindings.');
    const optionAuthority = prepareAuthority(
      optionMappings,
      'option-mappings-selftest',
      taskCandidate,
      'task-capture'
    );
    const privatePlan = readJson(configurationChangePlanStatePath(
      optionMappings,
      optionAuthority.planId
    ));
    assert(JSON.stringify(privatePlan).includes(privateStatus)
      && JSON.stringify(privatePlan).includes(privateContext),
    'Private configuration plan did not retain the exact provider option values.');
    const optionInspection = inspectConfigurationChange({
      root: optionMappings,
      planId: optionAuthority.planId,
      requestId: optionAuthority.requestId,
      confirmationId: optionAuthority.confirmationId,
      consumptionId: optionAuthority.execution.consumption.id,
      checkpointId: optionAuthority.checkpointId,
      at: APPLIED
    });
    const sanitizedOptionDocuments = JSON.stringify({
      inspection: optionInspection,
      request: optionAuthority.request.request,
      checkpoint: optionAuthority.execution.checkpoint
    });
    assert(![
      privateStatus,
      privateContext,
      'PRIVATE_PROVIDER_PROJECT_TYPE_CONFIGURATION_SENTINEL',
      'PRIVATE_PROVIDER_PROJECT_STATUS_CONFIGURATION_SENTINEL'
    ].some((value) => sanitizedOptionDocuments.includes(value))
      && !sanitizedOptionDocuments.includes('optionMappings')
      && !sanitizedOptionDocuments.includes('.soter/state'),
    'Sanitized configuration authority exposed private provider option mappings.');
    const settingChanges = optionInspection.scope.changes.filter(
      (change) => change.category === 'setting'
    );
    assert(settingChanges.length === 1
      && settingChanges[0].id === 'configuration-change.setting.integration.notion'
      && settingChanges[0].beforeFingerprint === fingerprintJson(
        readJson(taskConfigPath).settings['integration.notion']
      )
      && settingChanges[0].afterFingerprint === fingerprintJson(
        taskCandidate.settings['integration.notion']
      )
      && !Object.hasOwn(settingChanges[0], 'before')
      && !Object.hasOwn(settingChanges[0], 'after'),
    'Private option mappings were not reduced to one exact fingerprint-only settings change.');
    const completedOptionMappings = executeConfigurationChange({
      root: optionMappings,
      checkpointId: optionAuthority.checkpointId,
      at: APPLIED
    });
    const activeTaskConfiguration = readPrivateConfigurationState(
      optionMappings,
      'task-capture'
    ).configuration;
    const activeTaskLock = readJson(activeConfigurationLockStatePath(
      optionMappings,
      'task-capture'
    ));
    assert(completedOptionMappings.state === 'completed'
      && fingerprintJson(activeTaskConfiguration) === fingerprintJson(taskCandidate)
      && fingerprintJson(
        activeTaskLock.settings['integration.notion'].optionMappings
      ) === fingerprintJson(
        taskCandidate.settings['integration.notion'].optionMappings
      )
      && fingerprintLock(activeTaskLock) !== fingerprintLock(trackedTaskLock)
      && fs.readFileSync(taskConfigPath, 'utf8') === trackedTaskConfigurationText,
    'Configuration transaction did not bind private option mappings without changing the tracked template.');
    assertPrivateModes(optionMappings, optionAuthority.planId, 'task-capture');

    const reservation = copyRoot(root, 'soter-configuration-reservation-');
    roots.push(reservation);
    const reservationAuthority = prepareAuthority(
      reservation,
      'reservation-selftest',
      candidate(reservation, 'reservation')
    );
    const consumptionPath = configurationChangeConsumptionStatePath(
      reservation,
      reservationAuthority.execution.consumption.id
    );
    const reservedConsumption = readJson(consumptionPath);
    reservedConsumption.updatedAt = reservedConsumption.createdAt;
    reservedConsumption.state = 'reserved';
    reservedConsumption.checkpointFingerprint = null;
    delete reservedConsumption.consumptionFingerprint;
    reservedConsumption.consumptionFingerprint = fingerprintJson(reservedConsumption);
    writeJson(consumptionPath, reservedConsumption);
    fs.rmSync(configurationTransactionCheckpointStatePath(
      reservation,
      reservationAuthority.checkpointId
    ));
    const resumedReservation = prepareConfigurationChangeExecution({
      root: reservation,
      confirmationId: reservationAuthority.confirmationId,
      checkpointId: reservationAuthority.checkpointId,
      at: APPLIED
    });
    assert(resumedReservation.consumption.state === 'started'
      && resumedReservation.checkpoint.state === 'prepared',
    'Crash recovery did not resume the same reserved one-time configuration start.');

    const stale = copyRoot(root, 'soter-configuration-stale-');
    roots.push(stale);
    const staleCandidate = candidate(stale, 'stale');
    writePrivateConfigurationState(stale, 'meeting-intake', readJson(
      path.join(stale, 'soter/configurations/meeting-intake.config.json')
    ));
    const staleCurrentLock = resolveConfiguration({
      root: stale,
      configPath: privateConfigurationStatePath(stale, 'meeting-intake')
    });
    writeActiveConfigurationLockState(stale, 'meeting-intake', {
      ...staleCurrentLock,
      graphFingerprint: 'sha256:' + '0'.repeat(64)
    });
    let activeLockRejected = false;
    try {
      prepareConfigurationChange({
        root: stale,
        name: 'meeting-intake',
        candidateConfiguration: staleCandidate,
        id: 'configuration-change-plan.active-lock-stale-selftest',
        createdAt: CREATED
      });
    } catch (error) {
      activeLockRejected = error.code === 'CONFIGURATION_ACTIVE_LOCK_STALE';
    }
    assert(activeLockRejected, 'A stale private active lock was silently replaced by a new plan.');

    const activeLockSafety = copyRoot(root, 'soter-configuration-lock-safety-');
    roots.push(activeLockSafety);
    const activeLockSafetyCandidate = candidate(activeLockSafety, 'lock-safety-current');
    const activeLockSafetyAuthority = prepareAuthority(
      activeLockSafety,
      'lock-safety-initial-selftest',
      activeLockSafetyCandidate
    );
    executeConfigurationChange({
      root: activeLockSafety,
      checkpointId: activeLockSafetyAuthority.checkpointId,
      at: APPLIED
    });
    const activeLockSafetyFile = activeConfigurationLockStatePath(
      activeLockSafety,
      'meeting-intake'
    );
    const activeLockSafetyDirectory = path.dirname(activeLockSafetyFile);
    const assertUnsafeActiveLockRejected = (suffix) => {
      const planId = 'configuration-change-plan.lock-safety-' + suffix + '-selftest';
      let rejected = false;
      try {
        prepareConfigurationChange({
          root: activeLockSafety,
          name: 'meeting-intake',
          candidateConfiguration: candidate(activeLockSafety, 'lock-safety-' + suffix),
          id: planId,
          createdAt: CREATED
        });
      } catch (error) {
        rejected = error.code === 'CONFIGURATION_ACTIVE_LOCK_STALE';
      }
      assert(rejected
        && !fs.existsSync(configurationChangePlanStatePath(activeLockSafety, planId)),
      'Unsafe active-lock ' + suffix + ' state was read or produced a plan.');
    };
    if (process.platform !== 'win32') {
      fs.chmodSync(activeLockSafetyFile, 0o644);
      assertUnsafeActiveLockRejected('mode');
      fs.chmodSync(activeLockSafetyFile, 0o600);
      fs.chmodSync(activeLockSafetyFile, 0o1600);
      assertUnsafeActiveLockRejected('special-mode');
      fs.chmodSync(activeLockSafetyFile, 0o600);
      fs.chmodSync(activeLockSafetyDirectory, 0o755);
      assertUnsafeActiveLockRejected('parent-mode');
      fs.chmodSync(activeLockSafetyDirectory, 0o700);
    }
    const activeLockHardlink = path.join(
      activeLockSafety,
      'outside-active-lock-hardlink.json'
    );
    fs.linkSync(activeLockSafetyFile, activeLockHardlink);
    assertUnsafeActiveLockRejected('hardlink');
    fs.rmSync(activeLockHardlink);
    const activeLockBackup = path.join(
      activeLockSafetyDirectory,
      'meeting-intake.backup'
    );
    fs.renameSync(activeLockSafetyFile, activeLockBackup);
    fs.symlinkSync(path.basename(activeLockBackup), activeLockSafetyFile);
    assertUnsafeActiveLockRejected('symlink');
    fs.rmSync(activeLockSafetyFile);
    fs.renameSync(activeLockBackup, activeLockSafetyFile);
    const exactSafetyLock = readJson(activeLockSafetyFile);
    for (const [suffix, mutate] of [
      ['name-binding', (lock) => { lock.configuration.name = 'other-configuration'; }],
      ['path-binding', (lock) => {
        lock.configuration.path = '.soter/state/configurations/other-configuration.json';
      }],
      ['document-binding', (lock) => {
        lock.configuration.fingerprint = 'sha256:' + '2'.repeat(64);
      }]
    ]) {
      const invalidBindingLock = structuredClone(exactSafetyLock);
      mutate(invalidBindingLock);
      delete invalidBindingLock.graphFingerprint;
      invalidBindingLock.graphFingerprint = fingerprintJson(invalidBindingLock);
      writeActiveConfigurationLockState(
        activeLockSafety,
        'meeting-intake',
        invalidBindingLock
      );
      assertUnsafeActiveLockRejected(suffix);
    }
    const duplicatePackLock = structuredClone(exactSafetyLock);
    duplicatePackLock.packs.push({
      ...structuredClone(duplicatePackLock.packs[0]),
      manifestFingerprint: 'sha256:' + '3'.repeat(64)
    });
    delete duplicatePackLock.graphFingerprint;
    duplicatePackLock.graphFingerprint = fingerprintJson(duplicatePackLock);
    writeActiveConfigurationLockState(
      activeLockSafety,
      'meeting-intake',
      duplicatePackLock
    );
    assertUnsafeActiveLockRejected('duplicate-pack');
    writeActiveConfigurationLockState(
      activeLockSafety,
      'meeting-intake',
      exactSafetyLock
    );

    const refreshed = copyRoot(root, 'soter-configuration-lock-refresh-');
    roots.push(refreshed);
    const refreshCandidate = candidate(refreshed, 'lock-refresh');
    const initialRefreshAuthority = prepareAuthority(
      refreshed,
      'lock-refresh-initial-selftest',
      refreshCandidate
    );
    executeConfigurationChange({
      root: refreshed,
      checkpointId: initialRefreshAuthority.checkpointId,
      at: APPLIED
    });
    const currentRefreshLock = readJson(
      activeConfigurationLockStatePath(refreshed, 'meeting-intake')
    );
    const historicalRefreshLock = historicalActiveLock(currentRefreshLock);
    writeActiveConfigurationLockState(refreshed, 'meeting-intake', historicalRefreshLock);
    const hybridCandidate = candidate(refreshed, 'lock-refresh-hybrid');
    const hybridRefreshPlan = prepareConfigurationChange({
      root: refreshed,
      name: 'meeting-intake',
      candidateConfiguration: hybridCandidate,
      id: 'configuration-change-plan.lock-refresh-hybrid-selftest',
      createdAt: CREATED
    });
    const historicalAuthority = historicalRefreshLock.authorities.find(
      (authority) => authority.id === 'authority.crm.instance'
    );
    const currentAuthority = currentRefreshLock.authorities.find(
      (authority) => authority.id === 'authority.crm.instance'
    );
    const candidateAuthority = hybridRefreshPlan.plan.candidateLock.authorities.find(
      (authority) => authority.id === 'authority.crm.instance'
    );
    const hybridAuthorityDelta = hybridRefreshPlan.plan.changes.find(
      (change) => change.category === 'resolution'
        && change.subject === 'authority.authority.crm.instance'
    );
    assert(hybridAuthorityDelta?.beforeFingerprint === fingerprintJson(historicalAuthority)
      && hybridAuthorityDelta.afterFingerprint === fingerprintJson(candidateAuthority)
      && hybridAuthorityDelta.afterFingerprint !== fingerprintJson(currentAuthority),
    'Hybrid graph refresh described the fresh baseline instead of the exact final candidate lock.');
    const refreshPlan = prepareConfigurationChange({
      root: refreshed,
      name: 'meeting-intake',
      candidateConfiguration: refreshCandidate,
      id: 'configuration-change-plan.lock-refresh-selftest',
      createdAt: CREATED
    });
    const activeLockChange = refreshPlan.plan.changes.find(
      (change) => change.id === 'configuration-change.lock.active'
    );
    const packResolutionChange = refreshPlan.plan.changes.find(
      (change) => change.category === 'resolution'
        && change.subject.startsWith('pack.')
    );
    const preparedRefreshInspection = inspectConfigurationChange({
      root: refreshed,
      planId: refreshPlan.plan.id,
      at: APPLIED
    });
    assert(activeLockChange?.category === 'lock'
      && activeLockChange.beforeFingerprint
        === fingerprintLock(historicalRefreshLock)
      && activeLockChange.afterFingerprint
        === refreshPlan.plan.configuration.candidateLockFingerprint
      && packResolutionChange?.state === 'changed'
      && refreshPlan.plan.configuration.currentDocumentFingerprint
        === refreshPlan.plan.configuration.candidateDocumentFingerprint
      && refreshPlan.plan.configuration.currentLockFingerprint
        === refreshPlan.plan.configuration.candidateLockFingerprint
      && preparedRefreshInspection.configuration.baselineLockFingerprint
        === fingerprintLock(historicalRefreshLock)
      && preparedRefreshInspection.configuration.observedLockFingerprint
        === fingerprintLock(historicalRefreshLock)
      && preparedRefreshInspection.configuration.candidateLockFingerprint
        === refreshPlan.plan.configuration.candidateLockFingerprint,
    'Graph drift did not produce truthful exact active-lock and resolved-graph refresh scope.');
    removeActiveConfigurationLockState(refreshed, 'meeting-intake');
    const missingActiveInspection = inspectConfigurationChange({
      root: refreshed,
      planId: refreshPlan.plan.id,
      at: APPLIED
    });
    assert(missingActiveInspection.configuration.applicability === 'stale'
      && missingActiveInspection.configuration.observedLockFingerprint === null,
    'Missing private active lock was misreported as the fresh computed resolution.');
    writeActiveConfigurationLockState(refreshed, 'meeting-intake', historicalRefreshLock);
    const refreshRequest = beginConfigurationChangeRequest({
      root: refreshed,
      planId: refreshPlan.plan.id,
      id: 'configuration-change-request.lock-refresh-selftest',
      reason: 'Request confirmation for one exact stale graph-lock refresh.',
      createdAt: CREATED,
      expiresAt: EXPIRES
    });
    const refreshConfirmation = confirmConfigurationChangeRequest({
      root: refreshed,
      requestId: refreshRequest.request.id,
      id: 'configuration-change-confirmation.lock-refresh-selftest',
      actor: { type: 'local-operator', id: 'operator.selftest' },
      reason: 'Confirm one exact stale graph-lock refresh.',
      confirmedAt: CONFIRMED
    });
    const refreshExecution = prepareConfigurationChangeExecution({
      root: refreshed,
      confirmationId: refreshConfirmation.confirmation.id,
      checkpointId: 'checkpoint.configuration.lock-refresh-selftest',
      at: APPLIED
    });
    const refreshDesiredFile = privateConfigurationStatePath(refreshed, 'meeting-intake');
    const desiredBeforeRefresh = fs.readFileSync(refreshDesiredFile);
    const desiredStatBeforeRefresh = fs.statSync(refreshDesiredFile);
    const completedRefresh = executeConfigurationChange({
      root: refreshed,
      checkpointId: refreshExecution.checkpoint.id,
      at: APPLIED
    });
    const desiredStatAfterRefresh = fs.statSync(refreshDesiredFile);
    const refreshedActiveLock = readJson(
      activeConfigurationLockStatePath(refreshed, 'meeting-intake')
    );
    const refreshInspection = inspectConfigurationChange({
      root: refreshed,
      planId: refreshPlan.plan.id,
      checkpointId: refreshExecution.checkpoint.id,
      at: APPLIED
    });
    assert(completedRefresh.state === 'completed'
      && fingerprintLock(refreshedActiveLock)
        === refreshPlan.plan.configuration.candidateLockFingerprint
      && refreshInspection.configuration.applicability === 'applied'
      && refreshInspection.configuration.baselineLockFingerprint
        === fingerprintLock(historicalRefreshLock)
      && refreshInspection.configuration.observedLockFingerprint
        === refreshPlan.plan.configuration.candidateLockFingerprint
      && fs.readFileSync(refreshDesiredFile).equals(desiredBeforeRefresh)
      && desiredStatAfterRefresh.ino === desiredStatBeforeRefresh.ino
      && desiredStatAfterRefresh.mtimeMs === desiredStatBeforeRefresh.mtimeMs
      && completedRefresh.phase === 'terminal'
      && !JSON.stringify(refreshInspection).includes('notion://private-configuration'),
    'The exact lock-only refresh changed the desired file or produced an untruthful inspection.');

    let currentRefreshRejected = false;
    try {
      prepareConfigurationChange({
        root: refreshed,
        name: 'meeting-intake',
        candidateConfiguration: refreshCandidate,
        id: 'configuration-change-plan.lock-refresh-noop-selftest',
        createdAt: CREATED
      });
    } catch (error) {
      currentRefreshRejected = error.code === 'CONFIGURATION_CHANGE_EMPTY';
    }
    assert(currentRefreshRejected,
      'A current active lock was incorrectly accepted as another refresh transaction.');

    writeActiveConfigurationLockState(refreshed, 'meeting-intake', historicalRefreshLock);
    const rollbackRefreshPlan = prepareConfigurationChange({
      root: refreshed,
      name: 'meeting-intake',
      candidateConfiguration: refreshCandidate,
      id: 'configuration-change-plan.lock-refresh-rollback-selftest',
      createdAt: CREATED
    });
    const rollbackRefreshRequest = beginConfigurationChangeRequest({
      root: refreshed,
      planId: rollbackRefreshPlan.plan.id,
      id: 'configuration-change-request.lock-refresh-rollback-selftest',
      reason: 'Exercise exact rollback of a historical active lock.',
      createdAt: CREATED,
      expiresAt: EXPIRES
    });
    const rollbackRefreshConfirmation = confirmConfigurationChangeRequest({
      root: refreshed,
      requestId: rollbackRefreshRequest.request.id,
      id: 'configuration-change-confirmation.lock-refresh-rollback-selftest',
      actor: { type: 'local-operator', id: 'operator.selftest' },
      reason: 'Confirm the exact rollback exercise.',
      confirmedAt: CONFIRMED
    });
    const rollbackRefreshExecution = prepareConfigurationChangeExecution({
      root: refreshed,
      confirmationId: rollbackRefreshConfirmation.confirmation.id,
      checkpointId: 'checkpoint.configuration.lock-refresh-rollback-selftest',
      at: APPLIED
    });
    const unknownRefreshState = structuredClone(refreshCandidate);
    unknownRefreshState.host.reason
      = 'An unknown partial lock refresh must restore the exact historical active lock.';
    writePrivateConfigurationState(refreshed, 'meeting-intake', unknownRefreshState);
    const rolledBackRefresh = recoverConfigurationChange({
      root: refreshed,
      checkpointId: rollbackRefreshExecution.checkpoint.id,
      at: APPLIED
    });
    assert(rolledBackRefresh.state === 'rolled-back'
      && fingerprintJson(readPrivateConfigurationState(
        refreshed,
        'meeting-intake'
      ).configuration) === fingerprintJson(refreshCandidate)
      && fingerprintLock(readJson(
        activeConfigurationLockStatePath(refreshed, 'meeting-intake')
      )) === fingerprintLock(historicalRefreshLock),
    'Lock-refresh recovery did not restore the exact prior desired state and historical lock.');

    const missingLockRowFile = configurationChangePlanStatePath(
      refreshed,
      rollbackRefreshPlan.plan.id
    );
    const missingLockRowPlan = readJson(missingLockRowFile);
    missingLockRowPlan.changes = missingLockRowPlan.changes.filter(
      (change) => change.category !== 'lock'
    );
    missingLockRowPlan.scopeFingerprint = fingerprintJson(missingLockRowPlan.changes);
    reseal(missingLockRowPlan, 'planFingerprint');
    writeJson(missingLockRowFile, missingLockRowPlan);
    let missingLockRowRejected = false;
    try {
      inspectConfigurationChange({
        root: refreshed,
        planId: rollbackRefreshPlan.plan.id,
        at: APPLIED
      });
    } catch (error) {
      missingLockRowRejected = error.code === 'CONFIGURATION_PLAN_TAMPERED';
    }
    assert(missingLockRowRejected,
      'A re-signed refresh plan omitted its exact active-lock row.');

    for (const activeState of ['candidate', 'prior']) {
      writeActiveConfigurationLockState(
        refreshed,
        'meeting-intake',
        historicalRefreshLock
      );
      const directionAuthority = prepareAuthority(
        refreshed,
        'lock-refresh-rolling-' + activeState + '-selftest',
        refreshCandidate
      );
      if (activeState === 'candidate') {
        writeActiveConfigurationLockState(
          refreshed,
          'meeting-intake',
          directionAuthority.prepared.plan.candidateLock
        );
      }
      const directionCheckpointFile = configurationTransactionCheckpointStatePath(
        refreshed,
        directionAuthority.checkpointId
      );
      const directionCheckpoint = readJson(directionCheckpointFile);
      directionCheckpoint.state = 'rolling-back';
      directionCheckpoint.phase = 'rollback-active-lock';
      directionCheckpoint.failure = {
        reasonCode: 'CONFIGURATION_RECOVERY_ROLLBACK',
        summary: 'Continue an exact planted in-progress lock-refresh rollback.'
      };
      reseal(directionCheckpoint, 'checkpointFingerprint');
      writeJson(directionCheckpointFile, directionCheckpoint);
      const directionRecovery = recoverConfigurationChange({
        root: refreshed,
        checkpointId: directionAuthority.checkpointId,
        at: APPLIED
      });
      const repeatedDirectionRecovery = recoverConfigurationChange({
        root: refreshed,
        checkpointId: directionAuthority.checkpointId,
        at: APPLIED
      });
      assert(directionRecovery.state === 'rolled-back'
        && repeatedDirectionRecovery.checkpointFingerprint
          === directionRecovery.checkpointFingerprint
        && fingerprintLock(readJson(
          activeConfigurationLockStatePath(refreshed, 'meeting-intake')
        )) === fingerprintLock(historicalRefreshLock),
      'Recovery reversed an in-progress rollback from the ' + activeState + ' lock state.');
    }

    for (const recoveryState of ['prepared', 'applying', 'verifying']) {
      writeActiveConfigurationLockState(
        refreshed,
        'meeting-intake',
        historicalRefreshLock
      );
      const recoveryAuthority = prepareAuthority(
        refreshed,
        'lock-refresh-' + recoveryState + '-selftest',
        refreshCandidate
      );
      if (recoveryState === 'verifying') {
        writeActiveConfigurationLockState(
          refreshed,
          'meeting-intake',
          recoveryAuthority.prepared.plan.candidateLock
        );
      }
      if (recoveryState !== 'prepared') {
        const recoveryCheckpointFile = configurationTransactionCheckpointStatePath(
          refreshed,
          recoveryAuthority.checkpointId
        );
        const recoveryCheckpoint = readJson(recoveryCheckpointFile);
        recoveryCheckpoint.state = recoveryState;
        recoveryCheckpoint.phase = recoveryState === 'applying'
          ? 'configuration-unchanged'
          : 'verifying';
        reseal(recoveryCheckpoint, 'checkpointFingerprint');
        writeJson(recoveryCheckpointFile, recoveryCheckpoint);
      }
      const recoveredState = recoverConfigurationChange({
        root: refreshed,
        checkpointId: recoveryAuthority.checkpointId,
        at: APPLIED
      });
      assert(recoveredState.state === 'completed'
        && fingerprintLock(readJson(
          activeConfigurationLockStatePath(refreshed, 'meeting-intake')
        )) === recoveryAuthority.prepared.plan.configuration.candidateLockFingerprint,
      'Exact ' + recoveryState + ' lock-refresh recovery did not complete the candidate.');
    }

    if (process.platform !== 'win32') {
      writeActiveConfigurationLockState(
        refreshed,
        'meeting-intake',
        historicalRefreshLock
      );
      const failedRollbackAuthority = prepareAuthority(
        refreshed,
        'lock-refresh-rollback-failure-selftest',
        refreshCandidate
      );
      writeActiveConfigurationLockState(
        refreshed,
        'meeting-intake',
        failedRollbackAuthority.prepared.plan.candidateLock
      );
      const failedRollbackCheckpointFile = configurationTransactionCheckpointStatePath(
        refreshed,
        failedRollbackAuthority.checkpointId
      );
      const failedRollbackCheckpoint = readJson(failedRollbackCheckpointFile);
      failedRollbackCheckpoint.state = 'rolling-back';
      failedRollbackCheckpoint.phase = 'rollback-active-lock';
      failedRollbackCheckpoint.failure = {
        reasonCode: 'CONFIGURATION_RECOVERY_ROLLBACK',
        summary: 'Plant a private active-lock permission failure during rollback.'
      };
      reseal(failedRollbackCheckpoint, 'checkpointFingerprint');
      writeJson(failedRollbackCheckpointFile, failedRollbackCheckpoint);
      const refreshLockDirectory = path.dirname(
        activeConfigurationLockStatePath(refreshed, 'meeting-intake')
      );
      fs.chmodSync(refreshLockDirectory, 0o755);
      let rollbackFailureRejected = false;
      try {
        recoverConfigurationChange({
          root: refreshed,
          checkpointId: failedRollbackAuthority.checkpointId,
          at: APPLIED
        });
      } catch (error) {
        rollbackFailureRejected = error.code === 'CONFIGURATION_ROLLBACK_FAILED';
      }
      fs.chmodSync(refreshLockDirectory, 0o700);
      const needsAttentionCheckpoint = readJson(failedRollbackCheckpointFile);
      assert(rollbackFailureRejected
        && needsAttentionCheckpoint.state === 'needs-attention'
        && needsAttentionCheckpoint.failure.reasonCode
          === 'CONFIGURATION_ROLLBACK_FAILED',
      'Lock-refresh rollback failure did not persist a needs-attention checkpoint.');
    }

    removeActiveConfigurationLockState(stale, 'meeting-intake');
    removePrivateConfigurationState(stale, 'meeting-intake');
    const stalePlan = prepareConfigurationChange({
      root: stale,
      name: 'meeting-intake',
      candidateConfiguration: staleCandidate,
      id: 'configuration-change-plan.stale-selftest',
      createdAt: CREATED
    });
    const drifted = readJson(path.join(stale, 'soter/configurations/meeting-intake.config.json'));
    drifted.effectPolicies.read.reason = 'A different local edit makes the prepared exact configuration plan stale.';
    writeJson(path.join(stale, 'soter/configurations/meeting-intake.config.json'), drifted);
    let staleRejected = false;
    try {
      beginConfigurationChangeRequest({
        root: stale,
        planId: stalePlan.plan.id,
        id: 'configuration-change-request.stale-selftest',
        reason: 'This request must fail because its exact current configuration drifted.',
        createdAt: CREATED,
        expiresAt: EXPIRES
      });
    } catch (error) {
      staleRejected = error.code === 'CONFIGURATION_PLAN_STALE';
    }
    assert(staleRejected, 'Configuration drift did not invalidate the exact plan before request.');

    const expired = copyRoot(root, 'soter-configuration-expired-');
    roots.push(expired);
    const expiredPlan = prepareConfigurationChange({
      root: expired,
      name: 'meeting-intake',
      candidateConfiguration: candidate(expired, 'expired'),
      id: 'configuration-change-plan.expired-selftest',
      createdAt: CREATED
    });
    beginConfigurationChangeRequest({
      root: expired,
      planId: expiredPlan.plan.id,
      id: 'configuration-change-request.expired-selftest',
      reason: 'Exercise rejection of an expired exact configuration change request.',
      createdAt: CREATED,
      expiresAt: '2026-07-16T15:00:30.000Z'
    });
    let expiryRejected = false;
    try {
      confirmConfigurationChangeRequest({
        root: expired,
        requestId: 'configuration-change-request.expired-selftest',
        id: 'configuration-change-confirmation.expired-selftest',
        actor: { type: 'local-operator', id: 'operator.selftest' },
        reason: 'This confirmation is deliberately outside the exact request window.',
        confirmedAt: CONFIRMED
      });
    } catch (error) {
      expiryRejected = error.code === 'CONFIGURATION_REQUEST_EXPIRED';
    }
    assert(expiryRejected, 'Expired configuration request was confirmable.');

    const recovered = copyRoot(root, 'soter-configuration-recovery-');
    roots.push(recovered);
    const recoveryCandidate = candidate(recovered, 'recovery');
    const recoveryAuthority = prepareAuthority(recovered, 'recovery-selftest', recoveryCandidate);
    writePrivateConfigurationState(recovered, 'meeting-intake', recoveryCandidate);
    const recoveredCheckpoint = recoverConfigurationChange({
      root: recovered,
      checkpointId: recoveryAuthority.checkpointId,
      at: APPLIED
    });
    assert(recoveredCheckpoint.state === 'completed'
      && hasActiveLock(recovered, 'meeting-intake'),
    'Recovery did not complete a checkpoint after the candidate configuration write.');

    const rolledBack = copyRoot(root, 'soter-configuration-rollback-');
    roots.push(rolledBack);
    const rollbackCandidate = candidate(rolledBack, 'rollback');
    const rollbackAuthority = prepareAuthority(rolledBack, 'rollback-selftest', rollbackCandidate);
    const unknown = readJson(path.join(rolledBack, 'soter/configurations/meeting-intake.config.json'));
    unknown.host.reason = 'An unrecognized partial write must never be adopted as the prepared candidate.';
    writePrivateConfigurationState(rolledBack, 'meeting-intake', unknown);
    const rollbackCheckpoint = recoverConfigurationChange({
      root: rolledBack,
      checkpointId: rollbackAuthority.checkpointId,
      at: APPLIED
    });
    assert(rollbackCheckpoint.state === 'rolled-back'
      && fingerprintJson(readJson(path.join(rolledBack, 'soter/configurations/meeting-intake.config.json')))
        === fingerprintJson(originalConfiguration)
      && !fs.existsSync(privateConfigurationStatePath(rolledBack, 'meeting-intake'))
      && !fs.existsSync(activeConfigurationLockStatePath(rolledBack, 'meeting-intake')),
    'Unknown partial configuration state was not rolled back to the exact prior state.');

    const tampered = copyRoot(root, 'soter-configuration-tamper-');
    roots.push(tampered);
    const tamperedPlan = prepareConfigurationChange({
      root: tampered,
      name: 'meeting-intake',
      candidateConfiguration: candidate(tampered, 'tamper'),
      id: 'configuration-change-plan.tamper-selftest',
      createdAt: CREATED
    });
    const planPath = configurationChangePlanStatePath(tampered, tamperedPlan.plan.id);
    const invalidPlan = readJson(planPath);
    invalidPlan.candidateConfiguration.authorities[0].uri = 'notion://tampered-after-fingerprint';
    writeJson(planPath, invalidPlan);
    let tamperRejected = false;
    try {
      inspectConfigurationChange({
        root: tampered,
        planId: tamperedPlan.plan.id,
        at: APPLIED
      });
    } catch (error) {
      tamperRejected = error.code === 'CONFIGURATION_PLAN_TAMPERED';
    }
    assert(tamperRejected, 'Tampered private configuration plan was accepted.');

    const hiddenScopePlan = prepareConfigurationChange({
      root: tampered,
      name: 'meeting-intake',
      candidateConfiguration: candidate(tampered, 'hidden-scope'),
      id: 'configuration-change-plan.hidden-scope-selftest',
      createdAt: CREATED
    });
    const hiddenScopePath = configurationChangePlanStatePath(
      tampered,
      hiddenScopePlan.plan.id
    );
    const hiddenScopeDocument = readJson(hiddenScopePath);
    hiddenScopeDocument.changes = [{
      id: 'configuration-change.lock.active',
      category: 'lock',
      subject: 'active-lock',
      state: 'changed',
      beforeDescriptor: 'prior-active-lock',
      afterDescriptor: 'candidate-active-lock',
      beforeFingerprint: hiddenScopeDocument.configuration.currentLockFingerprint,
      afterFingerprint: hiddenScopeDocument.configuration.candidateLockFingerprint
    }];
    hiddenScopeDocument.scopeFingerprint = fingerprintJson(hiddenScopeDocument.changes);
    reseal(hiddenScopeDocument, 'planFingerprint');
    writeJson(hiddenScopePath, hiddenScopeDocument);
    let hiddenScopeRejected = false;
    try {
      inspectConfigurationChange({
        root: tampered,
        planId: hiddenScopePlan.plan.id,
        at: APPLIED
      });
    } catch (error) {
      hiddenScopeRejected = error.code === 'CONFIGURATION_PLAN_TAMPERED';
    }
    assert(hiddenScopeRejected,
      'A re-signed private plan hid real candidate changes behind a forged lock-only scope.');

    const noFallback = copyRoot(root, 'soter-configuration-no-fallback-');
    roots.push(noFallback);
    const noFallbackCandidate = candidate(noFallback, 'no-fallback');
    const noFallbackAuthority = prepareAuthority(
      noFallback,
      'no-fallback-selftest',
      noFallbackCandidate
    );
    const activatedNoFallback = executeConfigurationChange({
      root: noFallback,
      checkpointId: noFallbackAuthority.checkpointId,
      at: APPLIED
    });
    assert(activatedNoFallback.state === 'completed',
      'No-fallback fixture did not activate its private desired configuration.');
    const driftedPrivate = structuredClone(noFallbackCandidate);
    driftedPrivate.host.reason = 'Private desired-state drift must invalidate the exact active lock.';
    writePrivateConfigurationState(noFallback, 'meeting-intake', driftedPrivate);
    let privateDriftRejected = false;
    try {
      prepareConfigurationChange({
        root: noFallback,
        name: 'meeting-intake',
        candidateConfiguration: candidate(noFallback, 'drift-replacement'),
        id: 'configuration-change-plan.private-drift-selftest',
        createdAt: CREATED
      });
    } catch (error) {
      privateDriftRejected = error.code === 'CONFIGURATION_ACTIVE_LOCK_STALE';
    }
    assert(privateDriftRejected,
      'Private desired-configuration drift did not invalidate its exact active lock.');
    writePrivateConfigurationState(noFallback, 'meeting-intake', noFallbackCandidate);
    removePrivateConfigurationState(noFallback, 'meeting-intake');
    let missingPrivateRejected = false;
    try {
      prepareConfigurationChange({
        root: noFallback,
        name: 'meeting-intake',
        candidateConfiguration: candidate(noFallback, 'missing-private'),
        id: 'configuration-change-plan.missing-private-selftest',
        createdAt: CREATED
      });
    } catch (error) {
      missingPrivateRejected = error.code === 'CONFIGURATION_PRIVATE_STATE_UNBOUND';
    }
    assert(missingPrivateRejected,
      'Missing private desired state silently fell back to the tracked template while an active lock existed.');
    let preparedWorkFallbackRejected = false;
    try {
      await prepareAutomationRun({
        root: noFallback,
        automationId: 'automation.meeting-intake',
        configurationName: 'meeting-intake',
        configurationBasis: 'private-active',
        input: {},
        createdAt: APPLIED
      });
    } catch (error) {
      preparedWorkFallbackRejected = /tracked fallback is prohibited/.test(error.message);
    }
    assert(preparedWorkFallbackRejected,
      'Prepared work silently used a tracked configuration after private desired state disappeared.');
    fs.writeFileSync(
      privateConfigurationStatePath(noFallback, 'meeting-intake'),
      '{not-json\n',
      { mode: 0o600 }
    );
    let malformedPrivateRejected = false;
    try {
      await prepareAutomationRun({
        root: noFallback,
        automationId: 'automation.meeting-intake',
        configurationName: 'meeting-intake',
        configurationBasis: 'private-active',
        input: {},
        createdAt: APPLIED
      });
    } catch (error) {
      malformedPrivateRejected = /tracked fallback is prohibited/.test(error.message);
    }
    assert(malformedPrivateRejected,
      'Malformed private desired state silently fell back to the tracked template.');

    const desiredWithoutLock = copyRoot(root, 'soter-configuration-desired-without-lock-');
    roots.push(desiredWithoutLock);
    writePrivateConfigurationState(
      desiredWithoutLock,
      'meeting-intake',
      candidate(desiredWithoutLock, 'desired-without-lock')
    );
    for (const configurationBasis of ['tracked-contained', 'private-active']) {
      let desiredWithoutLockRejected = false;
      try {
        await prepareAutomationRun({
          root: desiredWithoutLock,
          automationId: 'automation.meeting-intake',
          configurationName: 'meeting-intake',
          configurationBasis,
          input: {},
          createdAt: APPLIED
        });
      } catch (error) {
        desiredWithoutLockRejected = /must either both exist or both be absent/.test(error.message);
      }
      assert(desiredWithoutLockRejected,
        'Private desired state without an active lock silently selected '
          + configurationBasis + ' preparation.');
    }

    const permissionDrift = copyRoot(root, 'soter-configuration-permission-drift-');
    roots.push(permissionDrift);
    const permissionAuthority = prepareAuthority(
      permissionDrift,
      'permission-drift-selftest',
      candidate(permissionDrift, 'permission-drift')
    );
    executeConfigurationChange({
      root: permissionDrift,
      checkpointId: permissionAuthority.checkpointId,
      at: APPLIED
    });
    if (process.platform !== 'win32') {
      const privateFile = privateConfigurationStatePath(permissionDrift, 'meeting-intake');
      for (const unsafeMode of [0o644]) {
        fs.chmodSync(privateFile, unsafeMode);
        let permissionRejected = false;
        try {
          resolveConfiguration({
            root: permissionDrift,
            configPath: privateFile
          });
        } catch (error) {
          permissionRejected = error.code === 'CONFIGURATION_PRIVATE_STATE_PERMISSIONS_INVALID';
        }
        assert(permissionRejected,
          'Unsafe private desired-configuration mode ' + unsafeMode.toString(8) + ' was accepted.');
        fs.chmodSync(privateFile, 0o600);
      }
    }

    const replaceRollback = copyRoot(root, 'soter-configuration-private-rollback-');
    roots.push(replaceRollback);
    const firstAuthority = prepareAuthority(
      replaceRollback,
      'private-first-selftest',
      candidate(replaceRollback, 'private-first')
    );
    executeConfigurationChange({ root: replaceRollback, checkpointId: firstAuthority.checkpointId, at: APPLIED });
    const firstPrivate = readPrivateConfigurationState(
      replaceRollback,
      'meeting-intake'
    ).configuration;
    const firstActiveLock = readJson(activeConfigurationLockStatePath(replaceRollback, 'meeting-intake'));
    const secondAuthority = prepareAuthority(
      replaceRollback,
      'private-second-selftest',
      candidate(replaceRollback, 'private-second')
    );
    const unknownReplacement = structuredClone(firstPrivate);
    unknownReplacement.host.reason = 'An unknown private replacement must roll back to the exact prior private state.';
    writePrivateConfigurationState(replaceRollback, 'meeting-intake', unknownReplacement);
    const restoredPrivate = recoverConfigurationChange({
      root: replaceRollback,
      checkpointId: secondAuthority.checkpointId,
      at: APPLIED
    });
    assert(restoredPrivate.state === 'rolled-back'
      && fingerprintJson(readPrivateConfigurationState(replaceRollback, 'meeting-intake').configuration)
        === fingerprintJson(firstPrivate)
      && fingerprintLock(readJson(activeConfigurationLockStatePath(replaceRollback, 'meeting-intake')))
        === fingerprintLock(firstActiveLock),
    'Rollback did not restore the exact prior private desired configuration and active lock.');

    const persistedCheckpoint = readConfigurationTransactionCheckpointState(
      recovered,
      recoveryAuthority.checkpointId
    ).checkpoint;
    assert(!JSON.stringify(persistedCheckpoint).includes('notion://private-configuration'),
      'Checkpoint persisted private desired configuration values.');
    process.stdout.write('Configuration transaction selftest passed.\n');
    return true;
  } catch (error) {
    process.stderr.write('CONFIGURATION TRANSACTION SELFTEST FAIL: ' + (error.stack || error.message) + '\n');
    return false;
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
}

function hasActiveLock(root, name) {
  return fs.existsSync(activeConfigurationLockStatePath(root, name));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  selftestConfigurationTransactions().then((passed) => {
    if (!passed) process.exitCode = 1;
  });
}
