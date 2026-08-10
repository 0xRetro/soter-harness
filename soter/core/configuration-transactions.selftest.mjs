import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '../kernel/verify.mjs';
import {
  beginConfigurationChangeRequest,
  confirmConfigurationChangeRequest,
  describeConfigurationOnboarding,
  executeConfigurationChange,
  inspectConfigurationChange,
  prepareConfigurationChange,
  prepareConfigurationOnboarding,
  prepareConfigurationChangeExecution,
  recoverConfigurationChange,
  resumeConfigurationChangeExecution
} from './configuration-transactions.mjs';
import { fingerprintJson, readJson, writeJson } from './lib/canonical-json.mjs';
import { containsCredentialMaterial } from './host-runtime.mjs';
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
  configurationChangeConfirmationStatePath,
  configurationChangeConsumptionStatePath,
  configurationChangePlanStatePath,
  configurationTransactionCheckpointStatePath,
  removeActiveConfigurationLockState,
  readConfigurationTransactionCheckpointState,
  writeActiveConfigurationLockState,
  writeConfigurationTransactionCheckpointState
} from './runtime-state.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATED = '2026-07-16T15:00:00.000Z';
const CONFIRMED = '2026-07-16T15:01:00.000Z';
const EXPIRES = '2026-07-16T15:10:00.000Z';
const APPLIED = '2026-07-16T15:02:00.000Z';
const ONBOARDING_MAX_STRING_LENGTH_FOR_SELFTEST = 4096;
const ONBOARDING_MAX_COLLECTION_ITEMS_FOR_SELFTEST = 100;
const ONBOARDING_MAX_INPUT_BYTES_FOR_SELFTEST = 256 * 1024;
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

function soterSyntheticCredentialFixture(value) {
  return value;
}

function sealOnboardingInput(description, valueForSlot = null) {
  const defaultValue = (slot, index) => {
    if (slot.field === 'conversationId') return 'C0123456789';
    if (slot.field === 'workspaceId') return 'T0123456789';
    if (slot.field === 'threadRootMessageId') return '1720000000.000001';
    if (slot.field === 'oldestInclusive') return '2026-08-10T11:00:00.000Z';
    if (slot.field === 'latestExclusive') return '2026-08-10T12:00:00.000Z';
    if (slot.type === 'uri') {
      if (slot.family === 'setting'
        && slot.subject === 'integration.notion'
        && slot.id.includes('.targets.')) {
        return 'collection://' + String(index + 1).padStart(32, '0');
      }
      return slot.subject === 'integration.notion'
        ? 'notion://onboarding-selftest-' + index
        : 'gmail://onboarding-selftest-' + index;
    }
    if (slot.type === 'string') return 'onboarding-selftest-' + index;
    if (slot.type === 'email') return 'operator' + index + '@soter.test';
    if (slot.type === 'date') return '2026-08-10';
    if (slot.type === 'date-time') return '2026-08-10T12:00:00.000Z';
    if (slot.type === 'integer') return slot.constraints.minimum || 1;
    if (slot.type === 'boolean') return true;
    if (slot.type === 'enum') return slot.options[0];
    if (slot.type === 'string-list') {
      const count = Math.max(1, slot.constraints.minItems || 0);
      return Array.from({ length: count }, (_item, itemIndex) => (
        slot.itemType === 'email'
          ? 'operator' + index + '-' + itemIndex + '@soter.test'
          : slot.itemType === 'uri'
            ? 'gmail://onboarding-selftest-list-' + index + '-' + itemIndex
            : slot.itemType === 'date'
              ? '2026-08-' + String(10 + itemIndex).padStart(2, '0')
              : slot.itemType === 'date-time'
                ? '2026-08-10T' + String(12 + itemIndex).padStart(2, '0') + ':00:00.000Z'
                : 'onboarding-selftest-' + index + '-' + itemIndex
      ));
    }
    if (slot.type === 'records') {
      return [{
        fields: slot.fields.map((field, fieldIndex) => ({
          id: field.id,
          state: field.required ? 'provided' : 'omitted',
          ...(field.required ? {
            type: field.type,
            value: defaultValue(field, index * 100 + fieldIndex)
          } : {})
        }))
      }];
    }
    if (slot.type === 'group') {
      return {
        fields: slot.fields.map((field, fieldIndex) => ({
          id: field.id,
          state: field.required ? 'provided' : 'omitted',
          ...(field.required ? {
            type: field.type,
            value: defaultValue(field, index * 100 + fieldIndex)
          } : {})
        }))
      };
    }
    if (slot.type === 'provider-mapping-set') {
      return {
        mappingSetFingerprint: slot.mappingSetFingerprint,
        scopes: slot.scopes.map((scope, scopeIndex) => ({
          id: scope.id,
          scopeFingerprint: scope.scopeFingerprint,
          state: 'mapped',
          providerProperty: 'Provider Property ' + scopeIndex,
          ...(scope.field.optionMappingRequired ? {
            options: [{
              portable: 'portable-option-' + scopeIndex,
              provider: 'Provider Option ' + scopeIndex
            }]
          } : {})
        }))
      };
    }
    throw new Error('Unsupported onboarding selftest slot type.');
  };
  const slots = description.slots.map((slot, index) => {
    const suppliedValue = valueForSlot ? valueForSlot(slot, index, defaultValue) : undefined;
    if (!slot.required && suppliedValue === undefined) return { id: slot.id, state: 'omitted' };
    return {
      id: slot.id,
      state: 'provided',
      type: slot.type,
      value: suppliedValue === undefined ? defaultValue(slot, index) : suppliedValue
    };
  });
  const unsigned = {
    $contract: 'soter://contracts/configuration-onboarding-input/v1',
    contractVersion: '1.0.0',
    configuration: {
      name: description.configuration.name,
      descriptionFingerprint: description.descriptionFingerprint
    },
    slots
  };
  return { ...unsigned, inputFingerprint: fingerprintJson(unsigned) };
}

function resealOnboardingInput(input) {
  const unsigned = structuredClone(input);
  delete unsigned.inputFingerprint;
  input.inputFingerprint = fingerprintJson(unsigned);
  return input;
}

function expectOnboardingError(run, expectedCode, message) {
  let observed = null;
  try {
    run();
  } catch (error) {
    observed = error.code;
    assert(!/Users|soter-fixture|sentinel|@soter\.test/i.test(error.message),
      'Onboarding rejection diagnostics exposed private or fixture material.');
  }
  assert(observed === expectedCode, message);
}

function copyRoot(root, prefix) {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
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
    ...value.host,
    reason: 'Exercise the exact local configuration transaction through the declared Codex projection.'
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

    const onboarding = copyRoot(root, 'soter-configuration-onboarding-');
    roots.push(onboarding);
    const descriptionSchema = readJson(path.join(
      onboarding,
      'soter/contracts/configuration-onboarding-description.schema.json'
    ));
    const inputSchema = readJson(path.join(
      onboarding,
      'soter/contracts/configuration-onboarding-input.schema.json'
    ));
    const taskOnboarding = describeConfigurationOnboarding({
      root: onboarding,
      name: 'task-capture'
    });
    const projectOnboarding = describeConfigurationOnboarding({
      root: onboarding,
      name: 'project-capture'
    });
    const slackOnboarding = describeConfigurationOnboarding({
      root: onboarding,
      name: 'slack-conversation-review'
    });
    const emailOnboarding = describeConfigurationOnboarding({
      root: onboarding,
      name: 'email-triage'
    });
    for (const description of [taskOnboarding, projectOnboarding, slackOnboarding, emailOnboarding]) {
      const serialized = JSON.stringify(description);
      assert(validateJsonSchema(description, descriptionSchema).length === 0
        && description.descriptionFingerprint === fingerprintJson((() => {
          const unsigned = structuredClone(description);
          delete unsigned.descriptionFingerprint;
          return unsigned;
        })())
        && new Set(description.slots.map((slot) => slot.id)).size === description.slots.length
        && !/(?:soter-fixture|\.example|\/Users\/|\.soter\/|"pattern"|"default"|"examples?"|"value")/i.test(serialized),
      'Onboarding description was not closed, unique, fingerprinted, and sanitized.');
      for (const slot of description.slots) {
        assert(new Set((slot.fields || []).map((field) => field.id)).size
          === (slot.fields || []).length,
        'Onboarding description retained duplicate repeatable-record field IDs.');
      }
    }
    assert(taskOnboarding.slots.some((slot) => slot.family === 'instance-authority-uri'
      && slot.type === 'uri'
      && slot.required === true)
      && taskOnboarding.slots.some((slot) => slot.family === 'source-input')
      && slackOnboarding.slots.some((slot) => slot.field === 'readinessProbe'
        && slot.type === 'group'
        && slot.required === false
        && slot.fields.map((field) => field.id).join(',')
          === 'conversationId,latestExclusive,oldestInclusive,threadRootMessageId'
        && slot.fields.every((field) => field.required === true))
      && emailOnboarding.slots.some((slot) => slot.type === 'string-list'),
    'Onboarding description did not derive exact authority, source, and setting slot families.');
    const taskPolicyIdsSlot = taskOnboarding.slots.find((slot) => (
      slot.family === 'source-input'
        && slot.subject === 'source.policy.task-capture'
        && slot.field === 'ids'
    ));
    const projectProfileIdsSlot = projectOnboarding.slots.find((slot) => (
      slot.family === 'source-input'
        && slot.subject === 'source.profile.project-capture'
        && slot.field === 'ids'
    ));
    assert(taskPolicyIdsSlot?.type === 'string-list'
      && taskPolicyIdsSlot.required === true
      && taskPolicyIdsSlot.constraints.minItems === 1
      && taskPolicyIdsSlot.constraints.maxItems === 1
      && projectProfileIdsSlot?.type === 'string-list'
      && projectProfileIdsSlot.required === true
      && projectProfileIdsSlot.constraints.minItems === 2
      && projectProfileIdsSlot.constraints.maxItems === 2,
    'Tracked source replacements did not project as required exact-cardinality lists.');
    const absentOptionalSource = copyRoot(root, 'soter-configuration-onboarding-absent-source-');
    roots.push(absentOptionalSource);
    const taskReadCapabilityPath = path.join(
      absentOptionalSource,
      'soter/capabilities/tasks.records.read.json'
    );
    const taskReadCapability = readJson(taskReadCapabilityPath);
    taskReadCapability.inputSchema.properties.relatedIds = {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: { type: 'string' }
    };
    writeJson(taskReadCapabilityPath, taskReadCapability);
    const absentOptionalDescription = describeConfigurationOnboarding({
      root: absentOptionalSource,
      name: 'task-capture'
    });
    assert(!absentOptionalDescription.slots.some((slot) => (
      slot.family === 'source-input'
        && slot.subject === 'source.policy.task-capture'
        && slot.field === 'relatedIds'
    )), 'An absent optional capability property was exposed as private onboarding input.');

    const taskRequiredTargets = taskOnboarding.slots.filter((slot) => (
      slot.family === 'setting'
        && slot.subject === 'integration.notion'
        && slot.id.includes('.targets.')
        && slot.required
    ));
    const slackRequiredTargets = slackOnboarding.slots.filter((slot) => (
      slot.family === 'setting'
        && slot.subject === 'integration.notion'
        && slot.id.includes('.targets.')
        && slot.required
    ));
    assert(taskRequiredTargets.map((slot) => slot.field).join(',') === 'policies,projects,tasks'
      && slackRequiredTargets.map((slot) => slot.field).join(',') === 'policies',
      'Selected resolution did not promote the exact template-required target identities.');
    const taskMappingSlot = taskOnboarding.slots.find((slot) => (
      slot.type === 'provider-mapping-set'
    ));
    const slackMappingSlot = slackOnboarding.slots.find((slot) => (
      slot.type === 'provider-mapping-set'
    ));
    assert(taskMappingSlot
      && taskMappingSlot.scopes.length === 14
      && taskMappingSlot.scopes.filter((scope) => scope.field.optionMappingRequired).length === 4
      && new Set(taskMappingSlot.scopes.map((scope) => scope.id)).size === 14
      && taskMappingSlot.scopes.every((scope) => [
        scope.id,
        scope.activation.subject,
        scope.activation.target,
        scope.record.subject,
        scope.record.type,
        scope.field.id
      ].every((identifier) => !containsCredentialMaterial(identifier)))
      && slackMappingSlot
      && slackMappingSlot.scopes.length === 1
      && slackMappingSlot.scopes[0].record.type === 'conversation-review-policy'
      && slackMappingSlot.scopes[0].field.id === 'name'
      && slackMappingSlot.scopes.every((scope) => !scope.field.optionMappingRequired)
      && slackMappingSlot.scopes.every((scope) => scope.record.type !== 'channel'),
    'Provider mapping onboarding did not derive the exact selected Automation record scopes.');
    const taskMinimalInput = sealOnboardingInput(taskOnboarding);
    const projectMinimalInput = sealOnboardingInput(projectOnboarding);
    const slackMinimalInput = sealOnboardingInput(slackOnboarding);
    const assertSourceInputRejected = ({
      description,
      input,
      name,
      subject,
      suffix,
      mutate,
      message
    }) => {
      const hostile = structuredClone(input);
      const sourceSlot = hostile.slots.find((slot) => (
        slot.id === description.slots.find((candidateSlot) => (
          candidateSlot.family === 'source-input'
            && candidateSlot.subject === subject
            && candidateSlot.field === 'ids'
        ))?.id
      ));
      assert(sourceSlot, 'Expected exact source-input slot is missing from the selftest description.');
      mutate(sourceSlot);
      resealOnboardingInput(hostile);
      const planId = 'configuration-change-plan.onboarding-source-' + suffix + '-selftest';
      expectOnboardingError(() => prepareConfigurationOnboarding({
        root: onboarding,
        name,
        input: hostile,
        id: planId,
        createdAt: CREATED
      }), 'CONFIGURATION_ONBOARDING_INPUT_INVALID', message);
      assert(!fs.existsSync(configurationChangePlanStatePath(onboarding, planId)),
        'Invalid source replacement input created plan state.');
    };
    assertSourceInputRejected({
      description: taskOnboarding,
      input: taskMinimalInput,
      name: 'task-capture',
      subject: 'source.policy.task-capture',
      suffix: 'task-omitted',
      mutate(slot) {
        delete slot.type;
        delete slot.value;
        slot.state = 'omitted';
      },
      message: 'An omitted tracked Task policy replacement was accepted.'
    });
    assertSourceInputRejected({
      description: taskOnboarding,
      input: taskMinimalInput,
      name: 'task-capture',
      subject: 'source.policy.task-capture',
      suffix: 'task-two',
      mutate(slot) {
        slot.value.push('policy.tasks.additional');
      },
      message: 'A two-item Task policy replacement escaped its exact 1..1 cardinality.'
    });
    assertSourceInputRejected({
      description: projectOnboarding,
      input: projectMinimalInput,
      name: 'project-capture',
      subject: 'source.profile.project-capture',
      suffix: 'project-one',
      mutate(slot) {
        slot.value = slot.value.slice(0, 1);
      },
      message: 'A one-item Project Capture profile replacement escaped its exact 2..2 cardinality.'
    });
    assertSourceInputRejected({
      description: projectOnboarding,
      input: projectMinimalInput,
      name: 'project-capture',
      subject: 'source.profile.project-capture',
      suffix: 'project-three',
      mutate(slot) {
        slot.value.push('profile.project-capture.additional');
      },
      message: 'A three-item Project Capture profile replacement escaped its exact 2..2 cardinality.'
    });
    const taskMinimalPlanId = 'configuration-change-plan.onboarding-task-minimal-selftest';
    const projectMinimalPlanId = 'configuration-change-plan.onboarding-project-minimal-selftest';
    const slackMinimalPlanId = 'configuration-change-plan.onboarding-slack-minimal-selftest';
    const taskMinimalInspection = prepareConfigurationOnboarding({
      root: onboarding,
      name: 'task-capture',
      input: taskMinimalInput,
      id: taskMinimalPlanId,
      createdAt: CREATED
    });
    const projectMinimalInspection = prepareConfigurationOnboarding({
      root: onboarding,
      name: 'project-capture',
      input: projectMinimalInput,
      id: projectMinimalPlanId,
      createdAt: CREATED
    });
    const slackMinimalInspection = prepareConfigurationOnboarding({
      root: onboarding,
      name: 'slack-conversation-review',
      input: slackMinimalInput,
      id: slackMinimalPlanId,
      createdAt: CREATED
    });
    assert(taskMinimalInspection.resume.reasonCode === 'CONFIGURATION_PLAN_CURRENT'
      && projectMinimalInspection.resume.reasonCode === 'CONFIGURATION_PLAN_CURRENT'
      && slackMinimalInspection.resume.reasonCode === 'CONFIGURATION_PLAN_CURRENT',
    'A minimal complete input did not materialize a valid selected configuration plan.');
    const taskMinimalPlan = readJson(configurationChangePlanStatePath(onboarding, taskMinimalPlanId));
    const slackMinimalPlan = readJson(configurationChangePlanStatePath(onboarding, slackMinimalPlanId));
    const taskNotion = taskMinimalPlan.candidateConfiguration.settings['integration.notion'];
    const slackNotion = slackMinimalPlan.candidateConfiguration.settings['integration.notion'];
    const taskPrivateMappingValues = taskMinimalInput.slots.find((slot) => (
      slot.type === 'provider-mapping-set'
    )).value.scopes.flatMap((scope) => [
      scope.providerProperty,
      ...(scope.options || []).flatMap((entry) => [entry.portable, entry.provider])
    ]).filter(Boolean);
    const sanitizedMinimalInspections = JSON.stringify([
      taskMinimalInspection,
      slackMinimalInspection
    ]);
    assert(taskNotion.fieldBindings.length === 14
      && taskNotion.optionMappings.length === 4
      && slackNotion.fieldBindings.length === 1
      && !Object.hasOwn(slackNotion, 'optionMappings')
      && slackNotion.fieldBindings[0].recordType === 'conversation-review-policy'
      && taskPrivateMappingValues.every((value) => !sanitizedMinimalInspections.includes(value))
      && !sanitizedMinimalInspections.includes('collection://')
      && !sanitizedMinimalInspections.includes('providerProperty')
      && !sanitizedMinimalInspections.includes('fieldBindings'),
    'Private provider mappings were not reconstructed exactly or escaped sanitized inspection.');

    const taskMappingSlotIndex = taskMinimalInput.slots.findIndex((slot) => (
      slot.type === 'provider-mapping-set'
    ));
    const taskMappingInputValue = (input) => input.slots[taskMappingSlotIndex].value;
    const assertTaskMappingRejected = (suffix, mutate, message) => {
      const input = structuredClone(taskMinimalInput);
      mutate(taskMappingInputValue(input));
      resealOnboardingInput(input);
      const planId = 'configuration-change-plan.onboarding-mapping-' + suffix + '-selftest';
      expectOnboardingError(() => prepareConfigurationOnboarding({
        root: onboarding,
        name: 'task-capture',
        input,
        id: planId,
        createdAt: CREATED
      }), 'CONFIGURATION_ONBOARDING_INPUT_INVALID', message);
      assert(!fs.existsSync(configurationChangePlanStatePath(onboarding, planId)),
        'Invalid provider mapping input created plan state.');
    };
    assertTaskMappingRejected('missing', (value) => value.scopes.pop(),
      'A missing provider mapping scope was accepted.');
    assertTaskMappingRejected('duplicate', (value) => {
      value.scopes[1] = structuredClone(value.scopes[0]);
    }, 'A duplicate provider mapping scope was accepted.');
    assertTaskMappingRejected('reordered', (value) => {
      [value.scopes[0], value.scopes[1]] = [value.scopes[1], value.scopes[0]];
    }, 'Reordered provider mapping scopes were accepted.');
    assertTaskMappingRejected('unknown', (value) => {
      value.scopes[0].id = 'provider-mapping.unknown.record.field';
    }, 'An unknown provider mapping scope was accepted.');
    assertTaskMappingRejected('mapping-drift', (value) => {
      value.mappingSetFingerprint = 'sha256:' + '1'.repeat(64);
    }, 'A stale provider mapping set fingerprint was accepted.');
    assertTaskMappingRejected('context-drift', (value) => {
      value.scopes[0].scopeFingerprint = 'sha256:' + '2'.repeat(64);
    }, 'A stale mapping or Context scope fingerprint was accepted.');
    const slackMappingValue = slackMinimalInput.slots.find((slot) => (
      slot.type === 'provider-mapping-set'
    )).value;
    assertTaskMappingRejected('cross-substitution', (value) => {
      value.scopes[0] = structuredClone(slackMappingValue.scopes[0]);
    }, 'A cross-mapping provider scope substitution was accepted.');
    const requiredMappingIndex = taskMappingSlot.scopes.findIndex((scope) => scope.field.required);
    const optionMappingIndex = taskMappingSlot.scopes.findIndex((scope) => (
      scope.field.optionMappingRequired
    ));
    const plainMappingIndex = taskMappingSlot.scopes.findIndex((scope) => (
      !scope.field.optionMappingRequired
    ));
    assertTaskMappingRejected('mapped-without-property', (value) => {
      delete value.scopes[plainMappingIndex].providerProperty;
    }, 'A mapped provider scope without a property was accepted.');
    assertTaskMappingRejected('unavailable-with-value', (value) => {
      value.scopes[plainMappingIndex].state = 'unavailable';
    }, 'An unavailable provider scope with a property was accepted.');
    assertTaskMappingRejected('required-unavailable', (value) => {
      value.scopes[requiredMappingIndex].state = 'unavailable';
      delete value.scopes[requiredMappingIndex].providerProperty;
      delete value.scopes[requiredMappingIndex].options;
    }, 'A required provider mapping field was marked unavailable.');
    assertTaskMappingRejected('missing-options', (value) => {
      delete value.scopes[optionMappingIndex].options;
    }, 'A configured-bijection scope without options was accepted.');
    assertTaskMappingRejected('non-bijective-options', (value) => {
      const first = value.scopes[optionMappingIndex].options[0];
      value.scopes[optionMappingIndex].options.push({
        portable: first.portable,
        provider: first.provider + ' Changed'
      });
    }, 'A non-bijective provider option map was accepted.');
    assertTaskMappingRejected('wrong-option-scope', (value) => {
      value.scopes[plainMappingIndex].options = [{
        portable: 'portable-wrong-scope',
        provider: 'Provider Wrong Scope'
      }];
    }, 'Provider options were accepted on a non-option field.');
    for (const [suffix, privateValue] of [
      ['credential', soterSyntheticCredentialFixture(
        'xoxb-test-fixture-onboarding-mapping-sentinel'
      )],
      ['file-uri', 'file:///Users/private/onboarding-mapping'],
      ['fixture', 'soter-fixture://private/onboarding-mapping']
    ]) {
      assertTaskMappingRejected(suffix, (value) => {
        value.scopes[plainMappingIndex].providerProperty = privateValue;
      }, 'Hostile private provider mapping material was accepted: ' + suffix + '.');
    }

    const repeatedTaskInspection = prepareConfigurationOnboarding({
      root: onboarding,
      name: 'task-capture',
      input: taskMinimalInput,
      id: taskMinimalPlanId,
      createdAt: CREATED
    });
    assert(repeatedTaskInspection.plan.fingerprint === taskMinimalInspection.plan.fingerprint,
      'Exact provider mapping onboarding re-entry was not idempotent.');
    const changedTaskMappingInput = structuredClone(taskMinimalInput);
    taskMappingInputValue(changedTaskMappingInput).scopes[plainMappingIndex].providerProperty
      = 'Changed Provider Property';
    resealOnboardingInput(changedTaskMappingInput);
    expectOnboardingError(() => prepareConfigurationOnboarding({
      root: onboarding,
      name: 'task-capture',
      input: changedTaskMappingInput,
      id: taskMinimalPlanId,
      createdAt: CREATED
    }), 'CONFIGURATION_PLAN_CONFLICT',
    'Changed provider mapping input re-entered an existing exact plan.');

    const emailInput = sealOnboardingInput(emailOnboarding);
    assert(validateJsonSchema(emailInput, inputSchema).length === 0,
      'Closed private onboarding input did not satisfy its registered contract.');
    const emailInspection = prepareConfigurationOnboarding({
      root: onboarding,
      name: 'email-triage',
      input: emailInput,
      id: 'configuration-change-plan.onboarding-email-selftest',
      createdAt: CREATED
    });
    const repeatedEmailInspection = prepareConfigurationOnboarding({
      root: onboarding,
      name: 'email-triage',
      input: emailInput,
      id: 'configuration-change-plan.onboarding-email-selftest',
      createdAt: CREATED
    });
    assert(emailInspection.configuration.applicability === 'current'
      && emailInspection.resume.reasonCode === 'CONFIGURATION_PLAN_CURRENT'
      && emailInspection.resume.permittedNextAction === 'request-confirmation'
      && repeatedEmailInspection.plan.fingerprint === emailInspection.plan.fingerprint
      && !JSON.stringify(emailInspection).includes('@soter.test')
      && !Object.hasOwn(emailInspection, 'candidateConfiguration'),
    'Private onboarding did not seal one sanitized current configuration transaction plan.');

    const forgedInputFingerprint = structuredClone(emailInput);
    forgedInputFingerprint.inputFingerprint = 'sha256:' + '0'.repeat(64);
    expectOnboardingError(
      () => prepareConfigurationOnboarding({
        root: onboarding,
        name: 'email-triage',
        input: forgedInputFingerprint,
        id: 'configuration-change-plan.onboarding-forged-input-selftest',
        createdAt: CREATED
      }),
      'CONFIGURATION_ONBOARDING_INPUT_INVALID',
      'Forged onboarding input fingerprint was accepted.'
    );
    const duplicateInput = structuredClone(emailInput);
    duplicateInput.slots[1] = {
      ...duplicateInput.slots[1],
      id: duplicateInput.slots[0].id,
      value: duplicateInput.slots[1].value
    };
    resealOnboardingInput(duplicateInput);
    expectOnboardingError(
      () => prepareConfigurationOnboarding({
        root: onboarding,
        name: 'email-triage',
        input: duplicateInput,
        id: 'configuration-change-plan.onboarding-duplicate-input-selftest',
        createdAt: CREATED
      }),
      'CONFIGURATION_ONBOARDING_INPUT_INVALID',
      'Duplicate onboarding slot ID with distinct typed content was accepted.'
    );
    const reorderedInput = structuredClone(emailInput);
    reorderedInput.slots.reverse();
    resealOnboardingInput(reorderedInput);
    expectOnboardingError(
      () => prepareConfigurationOnboarding({
        root: onboarding,
        name: 'email-triage',
        input: reorderedInput,
        id: 'configuration-change-plan.onboarding-reordered-input-selftest',
        createdAt: CREATED
      }),
      'CONFIGURATION_ONBOARDING_INPUT_INVALID',
      'Reordered onboarding input was accepted.'
    );
    const substitutedTypeInput = structuredClone(emailInput);
    substitutedTypeInput.slots[0] = {
      id: substitutedTypeInput.slots[0].id,
      state: 'provided',
      type: 'string',
      value: 'not-an-authority-uri'
    };
    resealOnboardingInput(substitutedTypeInput);
    expectOnboardingError(
      () => prepareConfigurationOnboarding({
        root: onboarding,
        name: 'email-triage',
        input: substitutedTypeInput,
        id: 'configuration-change-plan.onboarding-type-substitution-selftest',
        createdAt: CREATED
      }),
      'CONFIGURATION_ONBOARDING_INPUT_INVALID',
      'Onboarding slot type substitution was accepted.'
    );
    const omittedRequiredInput = structuredClone(emailInput);
    omittedRequiredInput.slots[0] = { id: omittedRequiredInput.slots[0].id, state: 'omitted' };
    resealOnboardingInput(omittedRequiredInput);
    expectOnboardingError(
      () => prepareConfigurationOnboarding({
        root: onboarding,
        name: 'email-triage',
        input: omittedRequiredInput,
        id: 'configuration-change-plan.onboarding-required-omission-selftest',
        createdAt: CREATED
      }),
      'CONFIGURATION_ONBOARDING_INPUT_INVALID',
      'Required onboarding slot omission was accepted.'
    );
    const crossedConfigurationInput = structuredClone(emailInput);
    crossedConfigurationInput.configuration.name = 'task-capture';
    resealOnboardingInput(crossedConfigurationInput);
    expectOnboardingError(
      () => prepareConfigurationOnboarding({
        root: onboarding,
        name: 'email-triage',
        input: crossedConfigurationInput,
        id: 'configuration-change-plan.onboarding-crossed-configuration-selftest',
        createdAt: CREATED
      }),
      'CONFIGURATION_ONBOARDING_INPUT_INVALID',
      'Cross-configuration onboarding input was accepted.'
    );
    const changedReentryInput = structuredClone(emailInput);
    changedReentryInput.slots[1].value = ['changed-operator@soter.test'];
    resealOnboardingInput(changedReentryInput);
    expectOnboardingError(
      () => prepareConfigurationOnboarding({
        root: onboarding,
        name: 'email-triage',
        input: changedReentryInput,
        id: 'configuration-change-plan.onboarding-email-selftest',
        createdAt: CREATED
      }),
      'CONFIGURATION_PLAN_CONFLICT',
      'Changed exact onboarding input re-entered an existing plan ID.'
    );

    const rawSlackCredential = soterSyntheticCredentialFixture(
      'xoxb-test-fixture-abcdefghijklmnop'
    );
    const percentSlackCredential = [...rawSlackCredential]
      .map((character) => '%' + character.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('');
    const unicodeSlackCredential = '\\u0078\\u006f\\u0078\\u0062'
      + rawSlackCredential.slice(4);
    let deeplyEncodedSlackCredential = percentSlackCredential;
    for (let depth = 0; depth < 4; depth += 1) {
      deeplyEncodedSlackCredential = encodeURIComponent(deeplyEncodedSlackCredential);
    }
    assert(containsCredentialMaterial(rawSlackCredential)
      && containsCredentialMaterial(percentSlackCredential)
      && containsCredentialMaterial(unicodeSlackCredential)
      && containsCredentialMaterial(deeplyEncodedSlackCredential)
      && !containsCredentialMaterial('xoxb-mode'),
    'Canonical credential detection did not cover bounded Slack token encodings exactly.');

    const slackGroup = slackOnboarding.slots.find((slot) => slot.type === 'group');
    assert(slackGroup?.field === 'readinessProbe'
      && slackGroup.fields.length === 4,
    'Slack readinessProbe was not represented as one closed optional group.');

    const authoritySlotIndex = emailInput.slots.findIndex(
      (slot) => slot.state === 'provided' && slot.type === 'uri'
    );
    const addressSlotIndex = emailInput.slots.findIndex(
      (slot) => slot.state === 'provided' && slot.type === 'string-list'
    );
    const assertEmailInputRejected = (input, suffix, message) => {
      resealOnboardingInput(input);
      const planId = 'configuration-change-plan.onboarding-email-' + suffix + '-selftest';
      expectOnboardingError(
        () => prepareConfigurationOnboarding({
          root: onboarding,
          name: 'email-triage',
          input,
          id: planId,
          createdAt: CREATED
        }),
        'CONFIGURATION_ONBOARDING_INPUT_INVALID',
        message
      );
      assert(!fs.existsSync(configurationChangePlanStatePath(onboarding, planId)),
        'Invalid bounded onboarding input created plan state.');
    };
    const rawCredentialInput = structuredClone(emailInput);
    rawCredentialInput.slots[authoritySlotIndex].value = 'gmail://private.invalid/'
      + rawSlackCredential;
    assertEmailInputRejected(
      rawCredentialInput,
      'raw-credential',
      'Raw credential-shaped private authority input was accepted.'
    );
    const encodedCredentialInput = structuredClone(emailInput);
    encodedCredentialInput.slots[authoritySlotIndex].value = 'gmail://private.invalid/'
      + percentSlackCredential;
    assertEmailInputRejected(
      encodedCredentialInput,
      'encoded-credential',
      'Encoded credential-shaped private authority input was accepted.'
    );
    const pathInput = structuredClone(emailInput);
    pathInput.slots[addressSlotIndex].value = ['/Users/private/onboarding-address'];
    assertEmailInputRejected(pathInput, 'private-path', 'Private path input was accepted.');
    const invalidEmailListInput = structuredClone(emailInput);
    invalidEmailListInput.slots[addressSlotIndex].value = ['not-an-email'];
    assertEmailInputRejected(
      invalidEmailListInput,
      'invalid-email-list',
      'A syntactically invalid Gmail selfAddresses item was accepted.'
    );
    for (const [kind, localFileUri] of [
      ['file-users', 'file:///Users/private/onboarding-value'],
      ['file-tmp', 'file:/tmp/onboarding-value'],
      ['file-localhost', 'file://localhost/etc/onboarding-value']
    ]) {
      const localFileInput = structuredClone(emailInput);
      localFileInput.slots[authoritySlotIndex].value = localFileUri;
      assertEmailInputRejected(
        localFileInput,
        kind,
        'A URI-wrapped local file path was accepted as private onboarding input.'
      );
    }
    const providerUriInput = structuredClone(emailInput);
    providerUriInput.slots[authoritySlotIndex].value = 'https://provider.invalid/resource';
    resealOnboardingInput(providerUriInput);
    assert(prepareConfigurationOnboarding({
      root: onboarding,
      name: 'email-triage',
      input: providerUriInput,
      id: 'configuration-change-plan.onboarding-provider-uri-selftest',
      createdAt: CREATED
    }).resume.reasonCode === 'CONFIGURATION_PLAN_CURRENT',
    'A legitimate non-file provider URI was rejected.');
    const oversizedStringInput = structuredClone(emailInput);
    oversizedStringInput.slots[authoritySlotIndex].value = 'gmail://'
      + 'a'.repeat(ONBOARDING_MAX_STRING_LENGTH_FOR_SELFTEST + 1);
    assertEmailInputRejected(
      oversizedStringInput,
      'oversized-string',
      'A 4097-character onboarding string was accepted.'
    );
    const oversizedListInput = structuredClone(emailInput);
    oversizedListInput.slots[addressSlotIndex].value = Array.from(
      { length: ONBOARDING_MAX_COLLECTION_ITEMS_FOR_SELFTEST + 1 },
      (_value, index) => 'operator' + index + '@soter.test'
    );
    assertEmailInputRejected(
      oversizedListInput,
      'oversized-list',
      'A 101-item onboarding list was accepted.'
    );
    const oversizedAggregateInput = structuredClone(emailInput);
    oversizedAggregateInput.slots[addressSlotIndex].value = Array.from(
      { length: ONBOARDING_MAX_COLLECTION_ITEMS_FOR_SELFTEST },
      (_value, index) => 'a'.repeat(3000) + index + '@soter.test'
    );
    assertEmailInputRejected(
      oversizedAggregateInput,
      'oversized-aggregate',
      'An onboarding input exceeding the aggregate byte bound was accepted.'
    );

    const optionalOnboarding = copyRoot(root, 'soter-configuration-onboarding-optional-');
    roots.push(optionalOnboarding);
    const gmailSettingsPath = path.join(
      optionalOnboarding,
      'soter/integrations/gmail/settings.json'
    );
    const optionalSettings = readJson(gmailSettingsPath);
    optionalSettings.schema.properties.onboardingMode = {
      type: 'string',
      enum: ['bounded', 'manual']
    };
    optionalSettings.schema.properties.integerGroup = {
      type: 'object',
      additionalProperties: false,
      required: ['value'],
      properties: {
        value: { type: 'integer' }
      }
    };
    optionalSettings.schema.properties.readinessProbe = {
      type: 'object',
      additionalProperties: false,
      required: [
        'conversationId',
        'latestExclusive',
        'oldestInclusive',
        'threadRootMessageId'
      ],
      properties: {
        conversationId: { type: 'string', minLength: 1 },
        latestExclusive: { type: 'string', minLength: 1 },
        oldestInclusive: { type: 'string', minLength: 1 },
        threadRootMessageId: { type: 'string', minLength: 1 }
      }
    };
    optionalSettings.schema.properties.listValidationGroup = {
      type: 'object',
      additionalProperties: false,
      required: ['calendarDates', 'contactEmails', 'moments', 'resourceUris'],
      properties: {
        calendarDates: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', format: 'date' }
        },
        contactEmails: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', format: 'email' }
        },
        moments: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', format: 'date-time' }
        },
        resourceUris: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', format: 'uri' }
        }
      }
    };
    optionalSettings.schema.properties.onboardingReviewers = {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['aliases', 'email'],
        properties: {
          aliases: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', format: 'email' }
          },
          email: { type: 'string', format: 'email' },
          active: { type: 'boolean' }
        }
      }
    };
    writeJson(gmailSettingsPath, optionalSettings);
    const optionalDescription = describeConfigurationOnboarding({
      root: optionalOnboarding,
      name: 'email-triage'
    });
    const optionalEnum = optionalDescription.slots.find((slot) => slot.field === 'onboardingMode');
    const optionalIntegerGroup = optionalDescription.slots.find(
      (slot) => slot.field === 'integerGroup'
    );
    const optionalRecords = optionalDescription.slots.find(
      (slot) => slot.field === 'onboardingReviewers'
    );
    const optionalGroup = optionalDescription.slots.find(
      (slot) => slot.field === 'readinessProbe'
    );
    const optionalListGroup = optionalDescription.slots.find(
      (slot) => slot.field === 'listValidationGroup'
    );
    assert(optionalEnum?.required === false
      && optionalEnum.type === 'enum'
      && optionalIntegerGroup?.required === false
      && optionalIntegerGroup.type === 'group'
      && optionalIntegerGroup.fields[0].type === 'integer'
      && optionalIntegerGroup.fields[0].constraints.minimum === Number.MIN_SAFE_INTEGER
      && optionalIntegerGroup.fields[0].constraints.maximum === Number.MAX_SAFE_INTEGER
      && optionalRecords?.required === false
      && optionalRecords.type === 'records'
      && optionalRecords.fields.map((field) => field.id).join(',') === 'active,aliases,email'
      && optionalGroup?.required === false
      && optionalGroup.type === 'group'
      && optionalGroup.fields.length === 4
      && optionalGroup.fields.every((field) => field.required === true)
      && optionalListGroup?.required === false
      && optionalListGroup.type === 'group'
      && optionalListGroup.fields.every((field) => field.type === 'string-list'),
    'Closed optional enum and repeatable-record schemas were not projected deterministically.');
    const optionalInput = sealOnboardingInput(optionalDescription);
    const optionalInspection = prepareConfigurationOnboarding({
      root: optionalOnboarding,
      name: 'email-triage',
      input: optionalInput,
      id: 'configuration-change-plan.onboarding-optional-selftest',
      createdAt: CREATED
    });
    assert(optionalInspection.resume.reasonCode === 'CONFIGURATION_PLAN_CURRENT',
      'Declared optional onboarding slots could not be omitted exactly.');
    const completeGroupInput = sealOnboardingInput(
      optionalDescription,
      (slot, index, defaultValue) => slot.type === 'group'
        ? defaultValue(slot, index)
        : undefined
    );
    const completeGroupInspection = prepareConfigurationOnboarding({
      root: optionalOnboarding,
      name: 'email-triage',
      input: completeGroupInput,
      id: 'configuration-change-plan.onboarding-group-complete-selftest',
      createdAt: CREATED
    });
    assert(completeGroupInspection.resume.reasonCode === 'CONFIGURATION_PLAN_CURRENT',
      'A complete atomic optional onboarding group was not accepted.');
    const groupSlotIndex = completeGroupInput.slots.findIndex(
      (slot) => slot.id === optionalGroup.id
    );
    const assertGroupRejected = (input, suffix, message) => {
      resealOnboardingInput(input);
      const planId = 'configuration-change-plan.onboarding-group-' + suffix + '-selftest';
      expectOnboardingError(
        () => prepareConfigurationOnboarding({
          root: optionalOnboarding,
          name: 'email-triage',
          input,
          id: planId,
          createdAt: CREATED
        }),
        'CONFIGURATION_ONBOARDING_INPUT_INVALID',
        message
      );
      assert(!fs.existsSync(configurationChangePlanStatePath(optionalOnboarding, planId)),
        'Invalid atomic group created onboarding plan state.');
    };
    const partialGroupInput = structuredClone(completeGroupInput);
    partialGroupInput.slots[groupSlotIndex].value.fields.pop();
    assertGroupRejected(partialGroupInput, 'partial', 'Partial onboarding group was accepted.');
    const duplicateGroupInput = structuredClone(completeGroupInput);
    duplicateGroupInput.slots[groupSlotIndex].value.fields[1] = structuredClone(
      duplicateGroupInput.slots[groupSlotIndex].value.fields[0]
    );
    assertGroupRejected(duplicateGroupInput, 'duplicate', 'Duplicate onboarding group field was accepted.');
    const reorderedGroupInput = structuredClone(completeGroupInput);
    reorderedGroupInput.slots[groupSlotIndex].value.fields.reverse();
    assertGroupRejected(reorderedGroupInput, 'reordered', 'Reordered onboarding group fields were accepted.');
    const completeListGroupInput = sealOnboardingInput(
      optionalDescription,
      (slot, index, defaultValue) => slot.field === 'listValidationGroup'
        ? defaultValue(slot, index)
        : undefined
    );
    assert(prepareConfigurationOnboarding({
      root: optionalOnboarding,
      name: 'email-triage',
      input: completeListGroupInput,
      id: 'configuration-change-plan.onboarding-group-list-valid-selftest',
      createdAt: CREATED
    }).resume.reasonCode === 'CONFIGURATION_PLAN_CURRENT',
    'Valid formatted string lists in an atomic group were rejected.');
    const listGroupSlotIndex = completeListGroupInput.slots.findIndex(
      (slot) => slot.id === optionalListGroup.id
    );
    for (const [fieldId, invalidValue, suffix] of [
      ['calendarDates', ['2026-02-30'], 'date'],
      ['contactEmails', ['not-an-email'], 'email'],
      ['moments', ['2026-02-30T12:00:00.000Z'], 'date-time'],
      ['resourceUris', ['file://localhost/tmp/private'], 'uri']
    ]) {
      const invalidListGroupInput = structuredClone(completeListGroupInput);
      invalidListGroupInput.slots[listGroupSlotIndex].value.fields.find(
        (field) => field.id === fieldId
      ).value = invalidValue;
      assertGroupRejected(
        invalidListGroupInput,
        'list-' + suffix,
        'An invalid formatted string-list item in a group was accepted.'
      );
    }
    const optionalIntegerInput = sealOnboardingInput(
      optionalDescription,
      (slot, index, defaultValue) => slot.field === 'integerGroup'
        ? defaultValue(slot, index)
        : undefined
    );
    const optionalIntegerInspection = prepareConfigurationOnboarding({
      root: optionalOnboarding,
      name: 'email-triage',
      input: optionalIntegerInput,
      id: 'configuration-change-plan.onboarding-safe-integer-selftest',
      createdAt: CREATED
    });
    assert(optionalIntegerInspection.resume.reasonCode === 'CONFIGURATION_PLAN_CURRENT',
      'A safe bounded onboarding integer was not accepted.');
    const unsafeIntegerInput = structuredClone(optionalIntegerInput);
    const integerSlotIndex = unsafeIntegerInput.slots.findIndex(
      (slot) => slot.id === optionalIntegerGroup.id
    );
    unsafeIntegerInput.slots[integerSlotIndex].value.fields[0].value = Number.MAX_SAFE_INTEGER + 1;
    resealOnboardingInput(unsafeIntegerInput);
    const unsafeIntegerPlanId = 'configuration-change-plan.onboarding-unsafe-integer-selftest';
    expectOnboardingError(
      () => prepareConfigurationOnboarding({
        root: optionalOnboarding,
        name: 'email-triage',
        input: unsafeIntegerInput,
        id: unsafeIntegerPlanId,
        createdAt: CREATED
      }),
      'CONFIGURATION_ONBOARDING_INPUT_INVALID',
      'An unsafe onboarding integer was accepted.'
    );
    assert(!fs.existsSync(configurationChangePlanStatePath(optionalOnboarding, unsafeIntegerPlanId)),
      'Unsafe onboarding integer created plan state.');
    const oversizedRecordsInput = sealOnboardingInput(
      optionalDescription,
      (slot, index, defaultValue) => slot.type === 'records'
        ? defaultValue(slot, index)
        : undefined
    );
    const recordsSlotIndex = oversizedRecordsInput.slots.findIndex(
      (slot) => slot.id === optionalRecords.id
    );
    oversizedRecordsInput.slots[recordsSlotIndex].value = Array.from(
      { length: ONBOARDING_MAX_COLLECTION_ITEMS_FOR_SELFTEST + 1 },
      () => structuredClone(oversizedRecordsInput.slots[recordsSlotIndex].value[0])
    );
    resealOnboardingInput(oversizedRecordsInput);
    const oversizedRecordsPlanId = 'configuration-change-plan.onboarding-oversized-records-selftest';
    expectOnboardingError(
      () => prepareConfigurationOnboarding({
        root: optionalOnboarding,
        name: 'email-triage',
        input: oversizedRecordsInput,
        id: oversizedRecordsPlanId,
        createdAt: CREATED
      }),
      'CONFIGURATION_ONBOARDING_INPUT_INVALID',
      'A 101-record onboarding value was accepted.'
    );
    assert(!fs.existsSync(configurationChangePlanStatePath(optionalOnboarding, oversizedRecordsPlanId)),
      'Oversized onboarding records created plan state.');
    const completeRecordsInput = sealOnboardingInput(
      optionalDescription,
      (slot, index, defaultValue) => slot.field === 'onboardingReviewers'
        ? defaultValue(slot, index)
        : undefined
    );
    assert(prepareConfigurationOnboarding({
      root: optionalOnboarding,
      name: 'email-triage',
      input: completeRecordsInput,
      id: 'configuration-change-plan.onboarding-record-list-valid-selftest',
      createdAt: CREATED
    }).resume.reasonCode === 'CONFIGURATION_PLAN_CURRENT',
    'A valid formatted string list in a repeatable record was rejected.');
    const completeRecordsSlot = completeRecordsInput.slots.find(
      (slot) => slot.id === optionalRecords.id
    );
    completeRecordsSlot.value[0].fields.find((field) => field.id === 'aliases').value
      = ['not-an-email'];
    resealOnboardingInput(completeRecordsInput);
    expectOnboardingError(
      () => prepareConfigurationOnboarding({
        root: optionalOnboarding,
        name: 'email-triage',
        input: completeRecordsInput,
        id: 'configuration-change-plan.onboarding-record-list-invalid-selftest',
        createdAt: CREATED
      }),
      'CONFIGURATION_ONBOARDING_INPUT_INVALID',
      'An invalid formatted string-list item in a repeatable record was accepted.'
    );

    const cliOnboarding = copyRoot(root, 'soter-configuration-onboarding-cli-');
    roots.push(cliOnboarding);
    const cliDescription = describeConfigurationOnboarding({
      root: cliOnboarding,
      name: 'email-triage'
    });
    const cliInput = sealOnboardingInput(cliDescription);
    const externalInputDirectory = fs.mkdtempSync(path.join(
      fs.realpathSync(os.tmpdir()),
      'soter-configuration-onboarding-input-'
    ));
    roots.push(externalInputDirectory);
    const externalInputPath = path.join(externalInputDirectory, 'onboarding-input.json');
    writeJson(externalInputPath, cliInput);
    if (process.platform !== 'win32') fs.chmodSync(externalInputPath, 0o600);
    const cliPath = path.join(cliOnboarding, 'soter/core/cli.mjs');
    const describedByCli = spawnSync(process.execPath, [
      cliPath,
      'configuration-onboarding-describe',
      '--root', cliOnboarding,
      '--configuration', 'email-triage',
      '--json'
    ], { cwd: cliOnboarding, encoding: 'utf8' });
    assert(describedByCli.status === 0
      && describedByCli.stderr === ''
      && JSON.parse(describedByCli.stdout).descriptionFingerprint
        === cliDescription.descriptionFingerprint,
    'CLI did not return the exact sanitized onboarding description.');
    const plannedByCli = spawnSync(process.execPath, [
      cliPath,
      'configuration-onboarding-plan',
      '--root', cliOnboarding,
      '--configuration', 'email-triage',
      '--input', externalInputPath,
      '--plan-id', 'configuration-change-plan.onboarding-cli-selftest',
      '--at', CREATED,
      '--json'
    ], { cwd: cliOnboarding, encoding: 'utf8' });
    const cliInspection = plannedByCli.status === 0 ? JSON.parse(plannedByCli.stdout) : null;
    assert(plannedByCli.status === 0
      && plannedByCli.stderr === ''
      && cliInspection?.resume.reasonCode === 'CONFIGURATION_PLAN_CURRENT'
      && !plannedByCli.stdout.includes('@soter.test')
      && !plannedByCli.stdout.includes(externalInputPath),
    'CLI did not privately construct one exact sanitized onboarding plan.');
    const relativeInputRejected = spawnSync(process.execPath, [
      cliPath,
      'configuration-onboarding-plan',
      '--root', cliOnboarding,
      '--configuration', 'email-triage',
      '--input', 'onboarding-input.json',
      '--at', CREATED,
      '--json'
    ], { cwd: cliOnboarding, encoding: 'utf8' });
    const repositoryInputRejected = spawnSync(process.execPath, [
      cliPath,
      'configuration-onboarding-plan',
      '--root', cliOnboarding,
      '--configuration', 'email-triage',
      '--input', path.join(cliOnboarding, 'soter/configurations/email-triage.config.json'),
      '--at', CREATED,
      '--json'
    ], { cwd: cliOnboarding, encoding: 'utf8' });
    assert(relativeInputRejected.status === 1
      && repositoryInputRejected.status === 1
      && /configuration-onboarding-plan input is invalid/.test(relativeInputRejected.stderr)
      && /configuration-onboarding-plan input is invalid/.test(repositoryInputRejected.stderr)
      && !relativeInputRejected.stderr.includes('onboarding-input.json')
      && !repositoryInputRejected.stderr.includes('email-triage.config.json'),
    'CLI accepted a relative/repository onboarding input or exposed its path.');
    if (process.platform !== 'win32') {
      const hostileInputs = [];
      const wrongModePath = path.join(
        externalInputDirectory,
        'PRIVATE_ONBOARDING_WRONG_MODE_SENTINEL.json'
      );
      writeJson(wrongModePath, cliInput);
      fs.chmodSync(wrongModePath, 0o644);
      hostileInputs.push(['wrong-mode', wrongModePath]);

      const symlinkPath = path.join(
        externalInputDirectory,
        'PRIVATE_ONBOARDING_SYMLINK_SENTINEL.json'
      );
      fs.symlinkSync(externalInputPath, symlinkPath);
      hostileInputs.push(['symlink', symlinkPath]);

      const hardlinkSource = path.join(externalInputDirectory, 'hardlink-source.json');
      const hardlinkPath = path.join(
        externalInputDirectory,
        'PRIVATE_ONBOARDING_HARDLINK_SENTINEL.json'
      );
      writeJson(hardlinkSource, cliInput);
      fs.chmodSync(hardlinkSource, 0o600);
      fs.linkSync(hardlinkSource, hardlinkPath);
      hostileInputs.push(['hardlink', hardlinkPath]);

      const oversizedWhitespacePath = path.join(
        externalInputDirectory,
        'PRIVATE_ONBOARDING_OVERSIZED_WHITESPACE_SENTINEL.json'
      );
      fs.writeFileSync(
        oversizedWhitespacePath,
        ' '.repeat(ONBOARDING_MAX_INPUT_BYTES_FOR_SELFTEST) + JSON.stringify(cliInput)
      );
      fs.chmodSync(oversizedWhitespacePath, 0o600);
      hostileInputs.push(['oversized-whitespace', oversizedWhitespacePath]);

      const oversizedDuplicatePath = path.join(
        externalInputDirectory,
        'PRIVATE_ONBOARDING_OVERSIZED_DUPLICATE_SENTINEL.json'
      );
      const serializedCliInput = JSON.stringify(cliInput);
      fs.writeFileSync(
        oversizedDuplicatePath,
        '{"$contract":"'
          + 'x'.repeat(ONBOARDING_MAX_INPUT_BYTES_FOR_SELFTEST)
          + '",'
          + serializedCliInput.slice(1)
      );
      fs.chmodSync(oversizedDuplicatePath, 0o600);
      hostileInputs.push(['oversized-duplicate', oversizedDuplicatePath]);

      for (const [kind, hostilePath] of hostileInputs) {
        const planId = 'configuration-change-plan.onboarding-cli-' + kind + '-selftest';
        const rejected = spawnSync(process.execPath, [
          cliPath,
          'configuration-onboarding-plan',
          '--root', cliOnboarding,
          '--configuration', 'email-triage',
          '--input', hostilePath,
          '--plan-id', planId,
          '--at', CREATED,
          '--json'
        ], { cwd: cliOnboarding, encoding: 'utf8' });
        assert(rejected.status === 1
          && /configuration-onboarding-plan input is invalid/.test(rejected.stderr)
          && !/PRIVATE_ONBOARDING|WRONG_MODE|SYMLINK|HARDLINK/i.test(rejected.stderr)
          && !fs.existsSync(configurationChangePlanStatePath(cliOnboarding, planId)),
        'CLI ' + kind + ' onboarding input did not fail closed before plan state.');
      }
    }

    const contradictoryOnboarding = copyRoot(root, 'soter-configuration-onboarding-bounds-');
    roots.push(contradictoryOnboarding);
    const contradictorySettingsPath = path.join(
      contradictoryOnboarding,
      'soter/integrations/gmail/settings.json'
    );
    const contradictorySettings = readJson(contradictorySettingsPath);
    contradictorySettings.schema.properties.selfAddresses.minItems = 2;
    contradictorySettings.schema.properties.selfAddresses.maxItems = 1;
    writeJson(contradictorySettingsPath, contradictorySettings);
    expectOnboardingError(
      () => describeConfigurationOnboarding({
        root: contradictoryOnboarding,
        name: 'email-triage'
      }),
      'CONFIGURATION_ONBOARDING_UNAVAILABLE',
      'Contradictory onboarding constraint bounds were projected.'
    );

    const hostileEnumOnboarding = copyRoot(root, 'soter-configuration-onboarding-enum-');
    roots.push(hostileEnumOnboarding);
    const hostileSettingsPath = path.join(
      hostileEnumOnboarding,
      'soter/integrations/gmail/settings.json'
    );
    const hostileSettings = readJson(hostileSettingsPath);
    hostileSettings.schema.properties.onboardingMode = {
      type: 'string',
      enum: ['/Users/private/onboarding-value']
    };
    writeJson(hostileSettingsPath, hostileSettings);
    expectOnboardingError(
      () => describeConfigurationOnboarding({
        root: hostileEnumOnboarding,
        name: 'email-triage'
      }),
      'CONFIGURATION_ONBOARDING_UNAVAILABLE',
      'Private/path-like enum option was projected in a sanitized description.'
    );
    for (const [kind, credentialValue] of [
      ['raw', rawSlackCredential],
      ['percent', percentSlackCredential],
      ['unicode', unicodeSlackCredential]
    ]) {
      hostileSettings.schema.properties.onboardingMode.enum = [credentialValue];
      writeJson(hostileSettingsPath, hostileSettings);
      expectOnboardingError(
        () => describeConfigurationOnboarding({
          root: hostileEnumOnboarding,
          name: 'email-triage'
        }),
        'CONFIGURATION_ONBOARDING_UNAVAILABLE',
        'A ' + kind + ' credential-shaped public enum option was projected.'
      );
    }
    hostileSettings.schema.properties.onboardingMode.enum = ['bounded-control'];
    writeJson(hostileSettingsPath, hostileSettings);
    assert(describeConfigurationOnboarding({
      root: hostileEnumOnboarding,
      name: 'email-triage'
    }).slots.some((slot) => slot.options?.includes('bounded-control')),
    'A benign public onboarding control was rejected as credential material.');

    const hostilePublicIdentifier = soterSyntheticCredentialFixture(
      'xoxb-test-fixture-public-identifier-sentinel'
    );
    assert(containsCredentialMaterial(hostilePublicIdentifier),
      'The hostile public identifier fixture was not credential-shaped.');
    const hostileSettingsIdentifierOnboarding = copyRoot(
      root,
      'soter-configuration-onboarding-settings-identifier-'
    );
    roots.push(hostileSettingsIdentifierOnboarding);
    const hostileIdentifierSettingsPath = path.join(
      hostileSettingsIdentifierOnboarding,
      'soter/integrations/gmail/settings.json'
    );
    const hostileIdentifierSettings = readJson(hostileIdentifierSettingsPath);
    hostileIdentifierSettings.schema.properties[hostilePublicIdentifier] = {
      type: 'string',
      minLength: 1,
      maxLength: 64
    };
    writeJson(hostileIdentifierSettingsPath, hostileIdentifierSettings);
    const hostileIdentifierConfigurationPath = path.join(
      hostileSettingsIdentifierOnboarding,
      'soter/configurations/email-triage.config.json'
    );
    const hostileIdentifierConfiguration = readJson(hostileIdentifierConfigurationPath);
    hostileIdentifierConfiguration.settings['integration.gmail'][hostilePublicIdentifier]
      = 'soter-fixture-public-identifier.example';
    writeJson(hostileIdentifierConfigurationPath, hostileIdentifierConfiguration);
    const hostileSettingsIdentifierPlanId =
      'configuration-change-plan.onboarding-hostile-settings-identifier-selftest';
    expectOnboardingError(
      () => describeConfigurationOnboarding({
        root: hostileSettingsIdentifierOnboarding,
        name: 'email-triage'
      }),
      'CONFIGURATION_ONBOARDING_UNAVAILABLE',
      'A credential-shaped governed settings property entered a public description.'
    );
    assert(!fs.existsSync(configurationChangePlanStatePath(
      hostileSettingsIdentifierOnboarding,
      hostileSettingsIdentifierPlanId
    )), 'A rejected governed settings identifier created plan state.');

    const benignSettingsIdentifierOnboarding = copyRoot(
      root,
      'soter-configuration-onboarding-benign-settings-identifier-'
    );
    roots.push(benignSettingsIdentifierOnboarding);
    const benignIdentifierSettingsPath = path.join(
      benignSettingsIdentifierOnboarding,
      'soter/integrations/gmail/settings.json'
    );
    const benignIdentifierSettings = readJson(benignIdentifierSettingsPath);
    const benignPublicIdentifier = 'publicOnboardingField';
    benignIdentifierSettings.schema.properties[benignPublicIdentifier] = {
      type: 'string',
      minLength: 1,
      maxLength: 64
    };
    writeJson(benignIdentifierSettingsPath, benignIdentifierSettings);
    const benignIdentifierConfigurationPath = path.join(
      benignSettingsIdentifierOnboarding,
      'soter/configurations/email-triage.config.json'
    );
    const benignIdentifierConfiguration = readJson(benignIdentifierConfigurationPath);
    benignIdentifierConfiguration.settings['integration.gmail'][benignPublicIdentifier]
      = 'soter-fixture-public-identifier.example';
    writeJson(benignIdentifierConfigurationPath, benignIdentifierConfiguration);
    assert(describeConfigurationOnboarding({
      root: benignSettingsIdentifierOnboarding,
      name: 'email-triage'
    }).slots.some((slot) => slot.field === benignPublicIdentifier),
    'A benign governed settings property identifier was rejected.');

    const replaceExactStringValue = (value, before, after) => {
      if (value === before) return after;
      if (Array.isArray(value)) {
        return value.map((item) => replaceExactStringValue(item, before, after));
      }
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
          key,
          replaceExactStringValue(item, before, after)
        ]));
      }
      return value;
    };
    const rewriteTaskPortableFieldIdentifier = (testRoot, nextIdentifier) => {
      for (const relative of [
        'soter/integrations/notion/tasks-records.mapping.json',
        'soter/contexts/tasks/records.model.json',
        'soter/packs/automation.task-capture/pack.json',
        'soter/configurations/task-capture.config.json'
      ]) {
        const file = path.join(testRoot, relative);
        writeJson(file, replaceExactStringValue(readJson(file), 'title', nextIdentifier));
      }
    };
    const hostileMappingIdentifierOnboarding = copyRoot(
      root,
      'soter-configuration-onboarding-hostile-mapping-identifier-'
    );
    roots.push(hostileMappingIdentifierOnboarding);
    rewriteTaskPortableFieldIdentifier(
      hostileMappingIdentifierOnboarding,
      hostilePublicIdentifier
    );
    const hostileMappingIdentifierPlanId =
      'configuration-change-plan.onboarding-hostile-mapping-identifier-selftest';
    expectOnboardingError(
      () => describeConfigurationOnboarding({
        root: hostileMappingIdentifierOnboarding,
        name: 'task-capture'
      }),
      'CONFIGURATION_ONBOARDING_UNAVAILABLE',
      'A credential-shaped provider/Context field identifier entered a public description.'
    );
    assert(!fs.existsSync(configurationChangePlanStatePath(
      hostileMappingIdentifierOnboarding,
      hostileMappingIdentifierPlanId
    )), 'A rejected provider/Context field identifier created plan state.');

    const crossedBooleanDescription = structuredClone(emailOnboarding);
    crossedBooleanDescription.slots[0] = {
      ...crossedBooleanDescription.slots[0],
      family: 'setting',
      type: 'boolean',
      constraints: { pattern: 'unsafe' }
    };
    const crossedRecordDescription = structuredClone(optionalDescription);
    const recordIndex = crossedRecordDescription.slots.findIndex(
      (slot) => slot.type === 'records'
    );
    crossedRecordDescription.slots[recordIndex].constraints.minLength = 1;
    assert(validateJsonSchema(crossedBooleanDescription, descriptionSchema).length > 0
      && validateJsonSchema(crossedRecordDescription, descriptionSchema).length > 0,
    'Onboarding description schema accepted incompatible kind constraints.');

    const bootstrap = copyRoot(root, 'soter-configuration-bootstrap-');
    roots.push(bootstrap);
    const bootstrapTemplatePath = path.join(
      bootstrap,
      'soter/configurations/meeting-intake.config.json'
    );
    const bootstrapTemplateText = fs.readFileSync(bootstrapTemplatePath, 'utf8');
    const bootstrapCandidate = readJson(bootstrapTemplatePath);
    const bootstrapAuthority = prepareAuthority(
      bootstrap,
      'exact-template-bootstrap-selftest',
      bootstrapCandidate
    );
    const bootstrapPlan = bootstrapAuthority.prepared.plan;
    const bootstrapInitialization = bootstrapPlan.changes.find(
      (change) => change.id === 'configuration-change.lock.active'
    );
    assert(bootstrapPlan.configuration.currentSourceKind === 'tracked-template'
      && bootstrapPlan.priorActiveLock.state === 'absent'
      && bootstrapPlan.target.requestedPath === path.resolve(bootstrap)
      && bootstrapPlan.target.realPath === fs.realpathSync(bootstrap)
      && bootstrapPlan.configuration.permissions.privateDirectories === '0700'
      && bootstrapPlan.configuration.permissions.desiredConfiguration === '0600'
      && bootstrapPlan.configuration.permissions.activeLock === '0600'
      && bootstrapPlan.configuration.permissions.authorityFiles === '0600'
      && bootstrapPlan.configuration.currentDocumentFingerprint
        === bootstrapPlan.configuration.candidateDocumentFingerprint
      && bootstrapPlan.changes.length === 1
      && bootstrapInitialization?.category === 'lock'
      && bootstrapInitialization.state === 'added'
      && bootstrapInitialization.beforeDescriptor === null
      && bootstrapInitialization.beforeFingerprint === null
      && bootstrapInitialization.afterDescriptor === 'candidate-active-lock'
      && bootstrapInitialization.afterFingerprint
        === bootstrapPlan.configuration.candidateLockFingerprint,
    'Clean exact-template initialization did not produce one truthful absent-to-active lock scope.');
    for (const [value, schemaName] of [
      [bootstrapPlan, 'configuration-change-plan.schema.json'],
      [bootstrapAuthority.request.request, 'configuration-change-request.schema.json'],
      [bootstrapAuthority.execution.checkpoint, 'configuration-transaction-checkpoint.schema.json']
    ]) {
      const schema = readJson(path.join(bootstrap, 'soter/contracts', schemaName));
      assert(validateJsonSchema(value, schema).length === 0,
        schemaName + ' rejected exact-template initialization authority.');
    }
    assert(bootstrapAuthority.execution.checkpoint.state === 'prepared'
      && bootstrapAuthority.execution.checkpoint.phase === 'prepared'
      && bootstrapAuthority.execution.checkpoint.failure === null
      && bootstrapAuthority.execution.checkpoint.observation.sourceKind === 'tracked-template',
    'Exact-template initialization did not start from one durable absent-state checkpoint.');
    const bootstrapCompleted = executeConfigurationChange({
      root: bootstrap,
      checkpointId: bootstrapAuthority.checkpointId,
      at: APPLIED
    });
    assert(bootstrapCompleted.state === 'completed'
      && bootstrapCompleted.phase === 'terminal'
      && bootstrapCompleted.failure === null
      && fingerprintJson(readPrivateConfigurationState(bootstrap, 'meeting-intake').configuration)
        === fingerprintJson(bootstrapCandidate)
      && fingerprintLock(readJson(activeConfigurationLockStatePath(bootstrap, 'meeting-intake')))
        === bootstrapPlan.configuration.candidateLockFingerprint
      && fs.readFileSync(bootstrapTemplatePath, 'utf8') === bootstrapTemplateText,
    'Exact-template initialization did not atomically establish the exact private-active state.');
    assertPrivateModes(bootstrap, bootstrapAuthority.planId, 'meeting-intake');
    const bootstrapReentry = prepareAuthority(
      bootstrap,
      'exact-template-bootstrap-selftest',
      bootstrapCandidate
    );
    assert(bootstrapReentry.execution.checkpoint.state === 'completed'
      && bootstrapReentry.prepared.plan.planFingerprint === bootstrapPlan.planFingerprint,
    'Exact initialization authority did not permit exact completed re-entry.');
    const completedBootstrapInspection = inspectConfigurationChange({
      root: bootstrap,
      planId: bootstrapAuthority.planId,
      requestId: bootstrapAuthority.requestId,
      confirmationId: bootstrapAuthority.confirmationId,
      consumptionId: bootstrapAuthority.execution.consumption.id,
      checkpointId: bootstrapAuthority.checkpointId,
      at: APPLIED
    });
    const bootstrapInspectionSchema = readJson(path.join(
      bootstrap,
      'soter/contracts/configuration-change-inspection.schema.json'
    ));
    assert(completedBootstrapInspection.resume.classification === 'unavailable'
      && completedBootstrapInspection.resume.reasonCode === 'CONFIGURATION_APPLY_COMPLETED'
      && completedBootstrapInspection.resume.permittedNextAction === 'none'
      && completedBootstrapInspection.configuration.observedLockFingerprint
        === bootstrapPlan.configuration.candidateLockFingerprint
      && completedBootstrapInspection.configuration.observedResolution.state === 'resolved'
      && completedBootstrapInspection.configuration.observedResolution.fingerprint
        === bootstrapPlan.configuration.candidateLockFingerprint
      && validateJsonSchema(completedBootstrapInspection, bootstrapInspectionSchema).length === 0,
    'Completed bootstrap did not project one terminal unavailable inspection.');
    const crossedResolvedObservation = structuredClone(completedBootstrapInspection);
    crossedResolvedObservation.configuration.observedResolution.fingerprint = null;
    assert(validateJsonSchema(
      crossedResolvedObservation,
      bootstrapInspectionSchema
    ).length > 0,
    'Inspection schema accepted resolved observation without a fingerprint.');
    const crossedUnavailableObservation = structuredClone(completedBootstrapInspection);
    crossedUnavailableObservation.configuration.observedResolution = {
      state: 'unavailable',
      fingerprint: bootstrapPlan.configuration.candidateLockFingerprint
    };
    assert(validateJsonSchema(
      crossedUnavailableObservation,
      bootstrapInspectionSchema
    ).length > 0,
    'Inspection schema accepted unavailable observation with a fingerprint.');
    const hostileCompletedInspection = structuredClone(completedBootstrapInspection);
    hostileCompletedInspection.resume = {
      classification: 'safe',
      reasonCode: 'CONFIGURATION_CHECKPOINT_RECOVERABLE',
      reason: 'Hostile crossed guidance falsely advertises checkpoint recovery.',
      permittedNextAction: 'inspect-checkpoint'
    };
    assert(validateJsonSchema(hostileCompletedInspection, bootstrapInspectionSchema).length > 0,
      'Inspection schema accepted a completed checkpoint as recoverable authority.');
    const applyingWithCompletedResume = structuredClone(completedBootstrapInspection);
    applyingWithCompletedResume.checkpoint.state = 'applying';
    applyingWithCompletedResume.checkpoint.phase = 'prepared';
    applyingWithCompletedResume.checkpoint.reasonCode = null;
    applyingWithCompletedResume.resume = {
      classification: 'unavailable',
      reasonCode: 'CONFIGURATION_APPLY_COMPLETED',
      reason: 'The exact configuration transaction is complete.',
      permittedNextAction: 'none'
    };
    assert(validateJsonSchema(
      applyingWithCompletedResume,
      bootstrapInspectionSchema
    ).length > 0,
    'Inspection schema accepted applying checkpoint state with exact completed guidance.');
    const pathLikePlanInspection = structuredClone(completedBootstrapInspection);
    pathLikePlanInspection.plan.id = '/Users/private/configuration-change-plan.json';
    assert(validateJsonSchema(pathLikePlanInspection, bootstrapInspectionSchema).length > 0,
      'Inspection schema accepted a private path as its plan identifier.');
    const pathLikeConfigurationInspection = structuredClone(completedBootstrapInspection);
    pathLikeConfigurationInspection.configuration.name = '/Users/private/configuration.json';
    assert(validateJsonSchema(
      pathLikeConfigurationInspection,
      bootstrapInspectionSchema
    ).length > 0,
    'Inspection schema accepted a private path as its configuration identifier.');
    const pathLikeChangeInspection = structuredClone(completedBootstrapInspection);
    pathLikeChangeInspection.scope.changes[0].id = '/Users/private/configuration-change.json';
    assert(validateJsonSchema(pathLikeChangeInspection, bootstrapInspectionSchema).length > 0,
      'Inspection schema accepted a private path as its change identifier.');
    const pathLikeSubjectInspection = structuredClone(completedBootstrapInspection);
    pathLikeSubjectInspection.scope.changes[0].subject = '/Users/private/change-subject';
    assert(validateJsonSchema(pathLikeSubjectInspection, bootstrapInspectionSchema).length > 0,
      'Inspection schema accepted a private path as its change subject.');
    let bootstrapReuseRejected = false;
    try {
      prepareConfigurationChangeExecution({
        root: bootstrap,
        confirmationId: bootstrapAuthority.confirmationId,
        checkpointId: 'checkpoint.configuration.exact-template-bootstrap-reuse-selftest',
        at: APPLIED
      });
    } catch (error) {
      bootstrapReuseRejected = error.code === 'CONFIGURATION_CONFIRMATION_ALREADY_CONSUMED';
    }
    assert(bootstrapReuseRejected,
      'Exact-template initialization confirmation was reusable by another checkpoint.');
    let bootstrapNoopRejected = false;
    try {
      prepareConfigurationChange({
        root: bootstrap,
        name: 'meeting-intake',
        candidateConfiguration: bootstrapCandidate,
        id: 'configuration-change-plan.exact-template-bootstrap-noop-selftest',
        createdAt: CREATED
      });
    } catch (error) {
      bootstrapNoopRejected = error.code === 'CONFIGURATION_CHANGE_EMPTY';
    }
    assert(bootstrapNoopRejected,
      'An unchanged private-active configuration produced a second initialization plan.');

    const falseCompletedCheckpoint = structuredClone(bootstrapCompleted);
    falseCompletedCheckpoint.observation = structuredClone(
      bootstrapAuthority.execution.checkpoint.observation
    );
    reseal(falseCompletedCheckpoint, 'checkpointFingerprint');
    writeJson(
      configurationTransactionCheckpointStatePath(bootstrap, bootstrapAuthority.checkpointId),
      falseCompletedCheckpoint
    );
    let falseCompletedRejected = false;
    try {
      executeConfigurationChange({
        root: bootstrap,
        checkpointId: bootstrapAuthority.checkpointId,
        at: APPLIED
      });
    } catch (error) {
      falseCompletedRejected = error.code === 'CONFIGURATION_CHECKPOINT_MALFORMED'
        || error.code === 'CONFIGURATION_CHECKPOINT_BINDING_INVALID';
    }
    assert(falseCompletedRejected,
      'Re-sealed completed checkpoint retained pre-effect observation and falsely completed.');

    const crossedCheckpoint = structuredClone(bootstrapCompleted);
    crossedCheckpoint.phase = 'prepared';
    reseal(crossedCheckpoint, 'checkpointFingerprint');
    const checkpointSchema = readJson(path.join(
      bootstrap,
      'soter/contracts/configuration-transaction-checkpoint.schema.json'
    ));
    assert(validateJsonSchema(crossedCheckpoint, checkpointSchema).length > 0,
      'Checkpoint schema accepted completed state with prepared phase.');
    writeJson(
      configurationTransactionCheckpointStatePath(bootstrap, bootstrapAuthority.checkpointId),
      crossedCheckpoint
    );
    let crossedCheckpointRejected = false;
    try {
      executeConfigurationChange({
        root: bootstrap,
        checkpointId: bootstrapAuthority.checkpointId,
        at: APPLIED
      });
    } catch (error) {
      crossedCheckpointRejected = error.code === 'CONFIGURATION_CHECKPOINT_MALFORMED'
        || error.code === 'CONFIGURATION_CHECKPOINT_BINDING_INVALID';
    }
    assert(crossedCheckpointRejected,
      'Re-sealed completed checkpoint with prepared phase falsely completed without effects.');

    const bootstrapRollback = copyRoot(root, 'soter-configuration-bootstrap-rollback-');
    roots.push(bootstrapRollback);
    const bootstrapRollbackCandidate = readJson(path.join(
      bootstrapRollback,
      'soter/configurations/meeting-intake.config.json'
    ));
    const bootstrapRollbackAuthority = prepareAuthority(
      bootstrapRollback,
      'exact-template-bootstrap-rollback-selftest',
      bootstrapRollbackCandidate
    );
    const unknownBootstrapState = structuredClone(bootstrapRollbackCandidate);
    unknownBootstrapState.host.reason
      = 'Unknown partial bootstrap state must restore the exact absent private baseline.';
    writePrivateConfigurationState(
      bootstrapRollback,
      'meeting-intake',
      unknownBootstrapState
    );
    let bootstrapDriftRejected = false;
    try {
      executeConfigurationChange({
        root: bootstrapRollback,
        checkpointId: bootstrapRollbackAuthority.checkpointId,
        at: APPLIED
      });
    } catch (error) {
      bootstrapDriftRejected = error.code === 'CONFIGURATION_PLAN_STALE';
    }
    assert(bootstrapDriftRejected,
      'Unknown partial exact-template initialization state was executable as current.');
    const bootstrapRolledBack = recoverConfigurationChange({
      root: bootstrapRollback,
      checkpointId: bootstrapRollbackAuthority.checkpointId,
      at: APPLIED
    });
    const repeatedBootstrapRollback = recoverConfigurationChange({
      root: bootstrapRollback,
      checkpointId: bootstrapRollbackAuthority.checkpointId,
      at: APPLIED
    });
    assert(bootstrapRolledBack.state === 'rolled-back'
      && bootstrapRolledBack.phase === 'terminal'
      && bootstrapRolledBack.failure !== null
      && repeatedBootstrapRollback.checkpointFingerprint
        === bootstrapRolledBack.checkpointFingerprint
      && !fs.lstatSync(
        privateConfigurationStatePath(bootstrapRollback, 'meeting-intake'),
        { throwIfNoEntry: false }
      )
      && !fs.lstatSync(
        activeConfigurationLockStatePath(bootstrapRollback, 'meeting-intake'),
        { throwIfNoEntry: false }
      ),
    'Exact-template initialization recovery did not restore and verify prior absence.');
    const falseRolledBackCheckpoint = structuredClone(bootstrapRolledBack);
    falseRolledBackCheckpoint.observation = structuredClone(bootstrapCompleted.observation);
    reseal(falseRolledBackCheckpoint, 'checkpointFingerprint');
    writeJson(
      configurationTransactionCheckpointStatePath(
        bootstrapRollback,
        bootstrapRollbackAuthority.checkpointId
      ),
      falseRolledBackCheckpoint
    );
    let falseRolledBackRejected = false;
    try {
      recoverConfigurationChange({
        root: bootstrapRollback,
        checkpointId: bootstrapRollbackAuthority.checkpointId,
        at: APPLIED
      });
    } catch (error) {
      falseRolledBackRejected = error.code === 'CONFIGURATION_CHECKPOINT_BINDING_INVALID';
    }
    assert(falseRolledBackRejected,
      'Re-sealed rolled-back checkpoint retained candidate observation as prior state.');

    const expiredBootstrap = copyRoot(root, 'soter-configuration-bootstrap-expired-');
    roots.push(expiredBootstrap);
    const expiredBootstrapCandidate = readJson(path.join(
      expiredBootstrap,
      'soter/configurations/meeting-intake.config.json'
    ));
    const expiredBootstrapPlan = prepareConfigurationChange({
      root: expiredBootstrap,
      name: 'meeting-intake',
      candidateConfiguration: expiredBootstrapCandidate,
      id: 'configuration-change-plan.exact-template-bootstrap-expired-selftest',
      createdAt: CREATED
    });
    const expiredBootstrapRequest = beginConfigurationChangeRequest({
      root: expiredBootstrap,
      planId: expiredBootstrapPlan.plan.id,
      id: 'configuration-change-request.exact-template-bootstrap-expired-selftest',
      reason: 'Exercise confirmed bootstrap inspection after its exact request expires.',
      createdAt: CREATED,
      expiresAt: EXPIRES
    });
    const expiredBootstrapConfirmation = confirmConfigurationChangeRequest({
      root: expiredBootstrap,
      requestId: expiredBootstrapRequest.request.id,
      id: 'configuration-change-confirmation.exact-template-bootstrap-expired-selftest',
      actor: { type: 'local-operator', id: 'operator.selftest' },
      reason: 'Confirm before expiry but deliberately delay execution start.',
      confirmedAt: CONFIRMED
    });
    const absentResumeConsumptionPath = configurationChangeConsumptionStatePath(
      expiredBootstrap,
      'configuration-change-consumption.exact-template-bootstrap-expired-selftest'
    );
    const absentResumeCheckpointPath = configurationTransactionCheckpointStatePath(
      expiredBootstrap,
      'checkpoint.configuration.exact-template-bootstrap-resume-selftest'
    );
    let absentResumeRejected = false;
    try {
      resumeConfigurationChangeExecution({
        root: expiredBootstrap,
        confirmationId: expiredBootstrapConfirmation.confirmation.id,
        checkpointId: 'checkpoint.configuration.exact-template-bootstrap-resume-selftest',
        at: APPLIED
      });
    } catch (error) {
      absentResumeRejected = error.code === 'CONFIGURATION_CONSUMPTION_MISSING';
    }
    assert(absentResumeRejected
      && !fs.lstatSync(absentResumeConsumptionPath, { throwIfNoEntry: false })
      && !fs.lstatSync(absentResumeCheckpointPath, { throwIfNoEntry: false }),
    'Configuration start re-entry minted a fresh consumption or checkpoint.');
    const expiredBootstrapInspection = inspectConfigurationChange({
      root: expiredBootstrap,
      planId: expiredBootstrapPlan.plan.id,
      requestId: expiredBootstrapRequest.request.id,
      confirmationId: expiredBootstrapConfirmation.confirmation.id,
      at: '2026-07-16T15:11:00.000Z'
    });
    assert(expiredBootstrapInspection.resume.classification === 'unavailable'
      && expiredBootstrapInspection.resume.reasonCode === 'CONFIGURATION_REQUEST_EXPIRED'
      && expiredBootstrapInspection.resume.permittedNextAction === 'request-confirmation',
    'Expired confirmed bootstrap inspection falsely projected safe apply authority.');

    const linkedBootstrap = copyRoot(root, 'soter-configuration-bootstrap-linked-');
    roots.push(linkedBootstrap);
    const linkedBootstrapCandidate = readJson(path.join(
      linkedBootstrap,
      'soter/configurations/meeting-intake.config.json'
    ));
    const linkedBootstrapPlan = prepareConfigurationChange({
      root: linkedBootstrap,
      name: 'meeting-intake',
      candidateConfiguration: linkedBootstrapCandidate,
      id: 'configuration-change-plan.exact-template-bootstrap-linked-selftest',
      createdAt: CREATED
    });
    const linkedBootstrapPlanPath = configurationChangePlanStatePath(
      linkedBootstrap,
      linkedBootstrapPlan.plan.id
    );
    const linkedBootstrapPlanBackup = linkedBootstrapPlanPath + '.backup';
    if (process.platform !== 'win32') {
      fs.chmodSync(linkedBootstrapPlanPath, 0o644);
      let unsafePlanModeRejected = false;
      try {
        inspectConfigurationChange({
          root: linkedBootstrap,
          planId: linkedBootstrapPlan.plan.id,
          at: APPLIED
        });
      } catch {
        unsafePlanModeRejected = true;
      }
      assert(unsafePlanModeRejected,
        'Configuration authority plan with unsafe mode was accepted on re-entry.');
      fs.chmodSync(linkedBootstrapPlanPath, 0o600);
    }
    fs.renameSync(linkedBootstrapPlanPath, linkedBootstrapPlanBackup);
    fs.symlinkSync(path.basename(linkedBootstrapPlanBackup), linkedBootstrapPlanPath);
    let linkedPlanRejected = false;
    try {
      inspectConfigurationChange({
        root: linkedBootstrap,
        planId: linkedBootstrapPlan.plan.id,
        at: APPLIED
      });
    } catch {
      linkedPlanRejected = true;
    }
    assert(linkedPlanRejected, 'Linked configuration authority plan was accepted on re-entry.');
    fs.unlinkSync(linkedBootstrapPlanPath);
    fs.renameSync(linkedBootstrapPlanBackup, linkedBootstrapPlanPath);
    const linkedBootstrapHardlink = path.join(linkedBootstrap, 'linked-bootstrap-plan.json');
    fs.linkSync(linkedBootstrapPlanPath, linkedBootstrapHardlink);
    let hardlinkedPlanRejected = false;
    try {
      inspectConfigurationChange({
        root: linkedBootstrap,
        planId: linkedBootstrapPlan.plan.id,
        at: APPLIED
      });
    } catch {
      hardlinkedPlanRejected = true;
    }
    assert(hardlinkedPlanRejected, 'Hardlinked configuration authority plan was accepted on re-entry.');
    fs.unlinkSync(linkedBootstrapHardlink);
    const exactLinkedBootstrapPlan = readJson(linkedBootstrapPlanPath);
    const wrongActiveLockPathPlan = structuredClone(exactLinkedBootstrapPlan);
    wrongActiveLockPathPlan.configuration.activeLockPath
      = '.soter/state/configuration-locks/email-triage.json';
    reseal(wrongActiveLockPathPlan, 'planFingerprint');
    writeJson(linkedBootstrapPlanPath, wrongActiveLockPathPlan);
    let wrongActiveLockPathRejected = false;
    try {
      inspectConfigurationChange({
        root: linkedBootstrap,
        planId: linkedBootstrapPlan.plan.id,
        at: APPLIED
      });
    } catch (error) {
      wrongActiveLockPathRejected = error.code === 'CONFIGURATION_PLAN_TAMPERED';
    }
    assert(wrongActiveLockPathRejected,
      'A re-sealed plan claimed a different schema-valid active-lock path.');
    writeJson(linkedBootstrapPlanPath, exactLinkedBootstrapPlan);
    const replayedBootstrap = copyRoot(root, 'soter-configuration-bootstrap-replayed-');
    roots.push(replayedBootstrap);
    fs.cpSync(
      path.join(linkedBootstrap, '.soter'),
      path.join(replayedBootstrap, '.soter'),
      { recursive: true }
    );
    if (process.platform !== 'win32') {
      for (const directory of [
        path.join(replayedBootstrap, '.soter'),
        path.join(replayedBootstrap, '.soter/state'),
        path.dirname(configurationChangePlanStatePath(
          replayedBootstrap,
          linkedBootstrapPlan.plan.id
        ))
      ]) fs.chmodSync(directory, 0o700);
      fs.chmodSync(
        configurationChangePlanStatePath(replayedBootstrap, linkedBootstrapPlan.plan.id),
        0o600
      );
    }
    let replayedPlanRejected = false;
    try {
      inspectConfigurationChange({
        root: replayedBootstrap,
        planId: linkedBootstrapPlan.plan.id,
        at: APPLIED
      });
    } catch (error) {
      replayedPlanRejected = error.code === 'CONFIGURATION_TARGET_DRIFT';
    }
    assert(replayedPlanRejected,
      'A sealed configuration authority plan replayed into another consumer root.');
    if (process.platform !== 'win32') {
      const linkedConfigurationsDirectory = path.dirname(
        privateConfigurationStatePath(linkedBootstrap, 'meeting-intake')
      );
      fs.mkdirSync(linkedConfigurationsDirectory, { mode: 0o700 });
      const danglingDesiredPath = privateConfigurationStatePath(
        linkedBootstrap,
        'meeting-intake'
      );
      fs.symlinkSync('missing-private-configuration.json', danglingDesiredPath);
      let danglingDesiredRejected = false;
      try {
        prepareConfigurationChange({
          root: linkedBootstrap,
          name: 'meeting-intake',
          candidateConfiguration: linkedBootstrapCandidate,
          id: 'configuration-change-plan.exact-template-bootstrap-dangling-leaf-selftest',
          createdAt: CREATED
        });
      } catch {
        danglingDesiredRejected = true;
      }
      assert(danglingDesiredRejected,
        'Dangling private desired-configuration symlink was treated as absence.');
      fs.unlinkSync(danglingDesiredPath);
      fs.rmdirSync(linkedConfigurationsDirectory);
      fs.symlinkSync(
        path.join(linkedBootstrap, 'missing-external-configurations'),
        linkedConfigurationsDirectory
      );
      let danglingParentRejected = false;
      try {
        prepareConfigurationChange({
          root: linkedBootstrap,
          name: 'meeting-intake',
          candidateConfiguration: linkedBootstrapCandidate,
          id: 'configuration-change-plan.exact-template-bootstrap-dangling-parent-selftest',
          createdAt: CREATED
        });
      } catch {
        danglingParentRejected = true;
      }
      assert(danglingParentRejected,
        'Dangling private configuration-directory symlink was treated as clean absence.');
      fs.unlinkSync(linkedConfigurationsDirectory);
    }

    if (process.platform !== 'win32') {
      const rollbackSymlink = copyRoot(root, 'soter-configuration-bootstrap-symlink-rollback-');
      roots.push(rollbackSymlink);
      const rollbackSymlinkCandidate = readJson(path.join(
        rollbackSymlink,
        'soter/configurations/meeting-intake.config.json'
      ));
      const rollbackSymlinkAuthority = prepareAuthority(
        rollbackSymlink,
        'exact-template-bootstrap-symlink-rollback-selftest',
        rollbackSymlinkCandidate
      );
      const externalConfigurationDirectory = fs.mkdtempSync(path.join(
        os.tmpdir(),
        'soter-external-configuration-sentinel-'
      ));
      roots.push(externalConfigurationDirectory);
      fs.chmodSync(externalConfigurationDirectory, 0o700);
      const externalSentinel = path.join(externalConfigurationDirectory, 'meeting-intake.json');
      const externalSentinelText = 'EXTERNAL_CONFIGURATION_SENTINEL\n';
      fs.writeFileSync(externalSentinel, externalSentinelText, { mode: 0o600 });
      const configurationsDirectory = path.dirname(
        privateConfigurationStatePath(rollbackSymlink, 'meeting-intake')
      );
      fs.symlinkSync(externalConfigurationDirectory, configurationsDirectory);
      let rollbackSymlinkRejected = false;
      try {
        recoverConfigurationChange({
          root: rollbackSymlink,
          checkpointId: rollbackSymlinkAuthority.checkpointId,
          at: APPLIED
        });
      } catch (error) {
        rollbackSymlinkRejected = error.code === 'CONFIGURATION_ROLLBACK_FAILED';
      }
      const rollbackSymlinkCheckpoint = readConfigurationTransactionCheckpointState(
        rollbackSymlink,
        rollbackSymlinkAuthority.checkpointId
      ).checkpoint;
      assert(rollbackSymlinkRejected
        && rollbackSymlinkCheckpoint.state === 'needs-attention'
        && rollbackSymlinkCheckpoint.phase === 'terminal'
        && rollbackSymlinkCheckpoint.failure.reasonCode === 'CONFIGURATION_ROLLBACK_FAILED'
        && fs.readFileSync(externalSentinel, 'utf8') === externalSentinelText
        && (fs.statSync(externalSentinel).mode & 0o7777) === 0o600,
      'Rollback followed swapped private ancestry or changed the external sentinel.');
    }

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
      && beforeInspection.configuration.observedLockFingerprint === null
      && beforeInspection.configuration.observedResolution.state === 'resolved'
      && beforeInspection.configuration.observedResolution.fingerprint
        === authority.prepared.plan.configuration.currentLockFingerprint
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
    for (const missingAncestors of [
      ['request'],
      ['confirmation'],
      ['request', 'confirmation']
    ]) {
      const orphanedInspection = structuredClone(beforeInspection);
      for (const property of missingAncestors) orphanedInspection[property] = null;
      assert(validateJsonSchema(orphanedInspection, inspectionSchema).length > 0,
        `Configuration inspection schema accepted ${missingAncestors.join(' and ')} missing from a consumed checkpoint.`);
    }
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

    const crossedAuthority = copyRoot(root, 'soter-configuration-crossed-authority-');
    roots.push(crossedAuthority);
    const crossedAuthorityA = prepareAuthority(
      crossedAuthority,
      'crossed-authority-a-selftest',
      candidate(crossedAuthority, 'crossed-authority-a')
    );
    const crossedAuthorityB = prepareAuthority(
      crossedAuthority,
      'crossed-authority-b-selftest',
      candidate(crossedAuthority, 'crossed-authority-b')
    );
    const crossedCheckpointA = readJson(configurationTransactionCheckpointStatePath(
      crossedAuthority,
      crossedAuthorityA.checkpointId
    ));
    const crossedCheckpointBPath = configurationTransactionCheckpointStatePath(
      crossedAuthority,
      crossedAuthorityB.checkpointId
    );
    const crossedAuthorityCheckpoint = readJson(crossedCheckpointBPath);
    crossedAuthorityCheckpoint.plan = structuredClone(crossedCheckpointA.plan);
    crossedAuthorityCheckpoint.configuration = structuredClone(crossedCheckpointA.configuration);
    crossedAuthorityCheckpoint.observation = structuredClone(crossedCheckpointA.observation);
    reseal(crossedAuthorityCheckpoint, 'checkpointFingerprint');
    writeJson(crossedCheckpointBPath, crossedAuthorityCheckpoint);
    const crossedConsumptionPath = configurationChangeConsumptionStatePath(
      crossedAuthority,
      crossedAuthorityB.execution.consumption.id
    );
    const crossedConsumption = readJson(crossedConsumptionPath);
    crossedConsumption.checkpointFingerprint
      = crossedAuthorityCheckpoint.checkpointFingerprint;
    reseal(crossedConsumption, 'consumptionFingerprint');
    writeJson(crossedConsumptionPath, crossedConsumption);
    let crossedAuthorityRejected = false;
    try {
      executeConfigurationChange({
        root: crossedAuthority,
        checkpointId: crossedAuthorityB.checkpointId,
        at: APPLIED
      });
    } catch (error) {
      crossedAuthorityRejected = error.code === 'CONFIGURATION_CHECKPOINT_BINDING_INVALID';
    }
    assert(crossedAuthorityRejected
      && !fs.lstatSync(
        privateConfigurationStatePath(crossedAuthority, 'meeting-intake'),
        { throwIfNoEntry: false }
      )
      && !fs.lstatSync(
        activeConfigurationLockStatePath(crossedAuthority, 'meeting-intake'),
        { throwIfNoEntry: false }
      ),
    'A crossed but independently valid authority chain applied another plan.');

    if (process.platform !== 'win32') {
      const exclusiveWrite = copyRoot(root, 'soter-configuration-exclusive-write-');
      roots.push(exclusiveWrite);
      const exclusiveWriteAuthority = prepareAuthority(
        exclusiveWrite,
        'exclusive-checkpoint-write-selftest',
        candidate(exclusiveWrite, 'exclusive-checkpoint-write')
      );
      const exclusiveCheckpointPath = configurationTransactionCheckpointStatePath(
        exclusiveWrite,
        exclusiveWriteAuthority.checkpointId
      );
      const exclusiveCheckpoint = readJson(exclusiveCheckpointPath);
      const checkpointBytes = fs.readFileSync(exclusiveCheckpointPath);
      const checkpointMode = fs.statSync(exclusiveCheckpointPath).mode & 0o7777;
      const originalDateNow = Date.now;
      try {
        for (const linkKind of ['symlink', 'hardlink']) {
          const fixedTime = linkKind === 'symlink' ? 1721143200001 : 1721143200002;
          const sentinelPath = path.join(
            exclusiveWrite,
            'external-' + linkKind + '-checkpoint-sentinel.txt'
          );
          const sentinelBytes = Buffer.from('EXTERNAL_CHECKPOINT_' + linkKind.toUpperCase() + '_SENTINEL\n');
          fs.writeFileSync(sentinelPath, sentinelBytes, { mode: 0o600 });
          fs.chmodSync(sentinelPath, 0o600);
          const temporaryPath = exclusiveCheckpointPath
            + '.' + process.pid + '.' + fixedTime + '.tmp';
          if (linkKind === 'symlink') fs.symlinkSync(sentinelPath, temporaryPath);
          else fs.linkSync(sentinelPath, temporaryPath);
          Date.now = () => fixedTime;
          let linkedTemporaryRejected = false;
          try {
            writeConfigurationTransactionCheckpointState(
              exclusiveWrite,
              exclusiveCheckpoint
            );
          } catch {
            linkedTemporaryRejected = true;
          }
          assert(linkedTemporaryRejected
            && fs.readFileSync(sentinelPath).equals(sentinelBytes)
            && (fs.statSync(sentinelPath).mode & 0o7777) === 0o600
            && fs.readFileSync(exclusiveCheckpointPath).equals(checkpointBytes)
            && fs.lstatSync(exclusiveCheckpointPath).isFile()
            && fs.lstatSync(exclusiveCheckpointPath).nlink === 1
            && (fs.statSync(exclusiveCheckpointPath).mode & 0o7777) === checkpointMode,
          'Exclusive checkpoint rewrite followed a planted ' + linkKind + ' temporary.');
          fs.unlinkSync(temporaryPath);
        }
      } finally {
        Date.now = originalDateNow;
      }
    }

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
    const reservationCheckpointPath = configurationTransactionCheckpointStatePath(
      reservation,
      reservationAuthority.checkpointId
    );
    const preparedReservationCheckpoint = readJson(reservationCheckpointPath);
    reservedConsumption.updatedAt = reservedConsumption.createdAt;
    reservedConsumption.state = 'reserved';
    reservedConsumption.checkpointFingerprint = null;
    delete reservedConsumption.consumptionFingerprint;
    reservedConsumption.consumptionFingerprint = fingerprintJson(reservedConsumption);
    writeJson(consumptionPath, reservedConsumption);

    const reservationConfirmationPath = configurationChangeConfirmationStatePath(
      reservation,
      reservationAuthority.confirmationId
    );
    const exactReservationConfirmation = readJson(reservationConfirmationPath);
    const earlyReservationConfirmation = structuredClone(exactReservationConfirmation);
    earlyReservationConfirmation.confirmedAt = '2026-07-16T14:59:00.000Z';
    reseal(earlyReservationConfirmation, 'confirmationFingerprint');
    writeJson(reservationConfirmationPath, earlyReservationConfirmation);
    let earlyReservationConfirmationRejected = false;
    try {
      inspectConfigurationChange({
        root: reservation,
        planId: reservationAuthority.planId,
        confirmationId: reservationAuthority.confirmationId,
        at: APPLIED
      });
    } catch (error) {
      earlyReservationConfirmationRejected
        = error.code === 'CONFIGURATION_CONFIRMATION_BINDING_INVALID';
    }
    assert(earlyReservationConfirmationRejected,
      'A re-sealed confirmation predating its request entered the authority chain.');
    writeJson(reservationConfirmationPath, exactReservationConfirmation);

    const lateReservedConsumption = structuredClone(reservedConsumption);
    lateReservedConsumption.createdAt = '2026-07-16T15:11:00.000Z';
    lateReservedConsumption.updatedAt = lateReservedConsumption.createdAt;
    reseal(lateReservedConsumption, 'consumptionFingerprint');
    writeJson(consumptionPath, lateReservedConsumption);
    let lateReservationRejected = false;
    try {
      inspectConfigurationChange({
        root: reservation,
        planId: reservationAuthority.planId,
        consumptionId: reservationAuthority.execution.consumption.id,
        at: '2026-07-16T16:00:00.000Z'
      });
    } catch (error) {
      lateReservationRejected = error.code === 'CONFIGURATION_CONSUMPTION_BINDING_INVALID';
    }
    assert(lateReservationRejected,
      'A re-sealed reservation created after request expiry retained resume authority.');
    writeJson(consumptionPath, reservedConsumption);

    const reservedPreparedInspection = inspectConfigurationChange({
      root: reservation,
      planId: reservationAuthority.planId,
      requestId: reservationAuthority.requestId,
      confirmationId: reservationAuthority.confirmationId,
      consumptionId: reservationAuthority.execution.consumption.id,
      at: '2026-07-16T16:00:00.000Z'
    });
    assert(reservedPreparedInspection.consumption.state === 'reserved'
      && reservedPreparedInspection.checkpoint.state === 'prepared'
      && reservedPreparedInspection.resume.classification === 'safe'
      && reservedPreparedInspection.resume.reasonCode
        === 'CONFIGURATION_RESERVED_CHECKPOINT_PREPARED'
      && reservedPreparedInspection.resume.permittedNextAction === 'resume-start',
    'Reserved start with an exact prepared checkpoint did not project exact re-entry.');
    const mismatchedResumeCheckpointId
      = 'checkpoint.configuration.reservation-mismatched-selftest';
    const reservedConsumptionBytes = fs.readFileSync(consumptionPath);
    const reservedCheckpointBytes = fs.readFileSync(reservationCheckpointPath);
    const mismatchedInspectionConsumption = structuredClone(reservedConsumption);
    mismatchedInspectionConsumption.checkpointId = mismatchedResumeCheckpointId;
    reseal(mismatchedInspectionConsumption, 'consumptionFingerprint');
    writeJson(consumptionPath, mismatchedInspectionConsumption);
    let mismatchedInspectionBindingRejected = false;
    try {
      inspectConfigurationChange({
        root: reservation,
        planId: reservationAuthority.planId,
        consumptionId: reservationAuthority.execution.consumption.id,
        checkpointId: reservationAuthority.checkpointId,
        at: '2026-07-16T16:00:00.000Z'
      });
    } catch (error) {
      mismatchedInspectionBindingRejected
        = error.code === 'CONFIGURATION_INSPECTION_BINDING_INVALID';
    }
    writeJson(consumptionPath, reservedConsumption);
    assert(mismatchedInspectionBindingRejected
      && fs.readFileSync(reservationCheckpointPath).equals(reservedCheckpointBytes),
    'Core inspection accepted a consumption checkpoint ID crossed with another checkpoint.');
    let mismatchedResumeRejected = false;
    try {
      resumeConfigurationChangeExecution({
        root: reservation,
        confirmationId: reservationAuthority.confirmationId,
        checkpointId: mismatchedResumeCheckpointId,
        at: '2026-07-16T16:00:00.000Z'
      });
    } catch (error) {
      mismatchedResumeRejected
        = error.code === 'CONFIGURATION_CONFIRMATION_ALREADY_CONSUMED';
    }
    assert(mismatchedResumeRejected
      && fs.readFileSync(consumptionPath).equals(reservedConsumptionBytes)
      && fs.readFileSync(reservationCheckpointPath).equals(reservedCheckpointBytes)
      && !fs.lstatSync(
        configurationTransactionCheckpointStatePath(reservation, mismatchedResumeCheckpointId),
        { throwIfNoEntry: false }
      ),
    'Configuration start re-entry ignored the reservation-bound checkpoint ID.');

    for (const hostileField of ['configuration', 'observation']) {
      const hostileReservationCheckpoint = structuredClone(preparedReservationCheckpoint);
      if (hostileField === 'configuration') {
        hostileReservationCheckpoint.configuration.currentDocumentFingerprint
          = hostileReservationCheckpoint.configuration.candidateDocumentFingerprint;
      } else {
        hostileReservationCheckpoint.observation = {
          sourceKind: 'private-active',
          templateFingerprint: reservationAuthority.prepared.plan.configuration.templateFingerprint,
          documentFingerprint: reservationAuthority.prepared.plan.configuration.candidateDocumentFingerprint,
          activeLockFingerprint: reservationAuthority.prepared.plan.configuration.candidateLockFingerprint,
          resolutionFingerprint: reservationAuthority.prepared.plan.configuration.candidateLockFingerprint
        };
      }
      reseal(hostileReservationCheckpoint, 'checkpointFingerprint');
      writeJson(reservationCheckpointPath, hostileReservationCheckpoint);
      let hostileReservationCheckpointRejected = false;
      try {
        prepareConfigurationChangeExecution({
          root: reservation,
          confirmationId: reservationAuthority.confirmationId,
          checkpointId: reservationAuthority.checkpointId,
          at: '2026-07-16T16:00:00.000Z'
        });
      } catch (error) {
        hostileReservationCheckpointRejected
          = error.code === 'CONFIGURATION_CHECKPOINT_BINDING_INVALID';
      }
      const stillReserved = readJson(consumptionPath);
      assert(hostileReservationCheckpointRejected
        && stillReserved.state === 'reserved'
        && stillReserved.consumptionFingerprint === reservedConsumption.consumptionFingerprint,
      'A re-sealed prepared checkpoint with hostile ' + hostileField
        + ' stranded its one-time reservation.');
    }
    writeJson(reservationCheckpointPath, preparedReservationCheckpoint);

    const reservationTemplatePath = path.join(
      reservation,
      'soter/configurations/meeting-intake.config.json'
    );
    const reservationTemplateText = fs.readFileSync(reservationTemplatePath, 'utf8');
    const driftedReservationTemplate = readJson(reservationTemplatePath);
    driftedReservationTemplate.host.reason
      = 'A reserved exact start must not survive tracked-template drift.';
    writeJson(reservationTemplatePath, driftedReservationTemplate);
    const driftedReservedPreparedInspection = inspectConfigurationChange({
      root: reservation,
      planId: reservationAuthority.planId,
      consumptionId: reservationAuthority.execution.consumption.id,
      at: '2026-07-16T16:00:00.000Z'
    });
    const reservedCheckpointBytesBeforeRejectedStart = fs.readFileSync(
      reservationCheckpointPath
    );
    let driftedReservedPreparedRejected = false;
    try {
      prepareConfigurationChangeExecution({
        root: reservation,
        confirmationId: reservationAuthority.confirmationId,
        checkpointId: reservationAuthority.checkpointId,
        at: '2026-07-16T16:00:00.000Z'
      });
    } catch (error) {
      driftedReservedPreparedRejected = error.code === 'CONFIGURATION_PLAN_STALE';
    }
    assert(driftedReservedPreparedInspection.configuration.applicability === 'stale'
      && driftedReservedPreparedInspection.resume.classification === 'unavailable'
      && driftedReservedPreparedInspection.resume.reasonCode === 'CONFIGURATION_TEMPLATE_DRIFT'
      && driftedReservedPreparedInspection.resume.permittedNextAction === 'none'
      && driftedReservedPreparedRejected
      && readJson(consumptionPath).state === 'reserved'
      && fs.readFileSync(reservationCheckpointPath).equals(
        reservedCheckpointBytesBeforeRejectedStart
      )
      && !fs.lstatSync(
        privateConfigurationStatePath(reservation, 'meeting-intake'),
        { throwIfNoEntry: false }
      ),
    'Reserved prepared start ignored plan drift or mutated its exact authority state.');
    fs.writeFileSync(reservationTemplatePath, reservationTemplateText);

    const invalidReservationCheckpoint = structuredClone(preparedReservationCheckpoint);
    invalidReservationCheckpoint.phase = 'terminal';
    reseal(invalidReservationCheckpoint, 'checkpointFingerprint');
    writeJson(reservationCheckpointPath, invalidReservationCheckpoint);
    let invalidReservationCheckpointRejected = false;
    try {
      inspectConfigurationChange({
        root: reservation,
        planId: reservationAuthority.planId,
        consumptionId: reservationAuthority.execution.consumption.id,
        at: '2026-07-16T16:00:00.000Z'
      });
    } catch (error) {
      invalidReservationCheckpointRejected
        = error.code === 'CONFIGURATION_CHECKPOINT_MALFORMED'
          || error.code === 'CONFIGURATION_CHECKPOINT_BINDING_INVALID';
    }
    assert(invalidReservationCheckpointRejected,
      'Reserved start ignored its malformed or crossed existing checkpoint.');
    writeJson(reservationCheckpointPath, preparedReservationCheckpoint);
    fs.rmSync(reservationCheckpointPath);

    writeJson(reservationTemplatePath, driftedReservationTemplate);
    const driftedReservedInspection = inspectConfigurationChange({
      root: reservation,
      planId: reservationAuthority.planId,
      consumptionId: reservationAuthority.execution.consumption.id,
      at: '2026-07-16T16:00:00.000Z'
    });
    let driftedReservedRejected = false;
    try {
      prepareConfigurationChangeExecution({
        root: reservation,
        confirmationId: reservationAuthority.confirmationId,
        checkpointId: reservationAuthority.checkpointId,
        at: '2026-07-16T16:00:00.000Z'
      });
    } catch (error) {
      driftedReservedRejected = error.code === 'CONFIGURATION_PLAN_STALE';
    }
    assert(driftedReservedInspection.configuration.applicability === 'stale'
      && driftedReservedInspection.checkpoint === null
      && driftedReservedInspection.resume.classification === 'unavailable'
      && driftedReservedInspection.resume.reasonCode === 'CONFIGURATION_TEMPLATE_DRIFT'
      && driftedReservedInspection.resume.permittedNextAction === 'none'
      && driftedReservedRejected
      && readJson(consumptionPath).state === 'reserved'
      && !fs.lstatSync(reservationCheckpointPath, { throwIfNoEntry: false })
      && !fs.lstatSync(
        privateConfigurationStatePath(reservation, 'meeting-intake'),
        { throwIfNoEntry: false }
      ),
    'Reserved checkpoint-free start minted authority or effects after plan drift.');
    fs.writeFileSync(reservationTemplatePath, reservationTemplateText);

    const reservedInspection = inspectConfigurationChange({
      root: reservation,
      planId: reservationAuthority.planId,
      requestId: reservationAuthority.requestId,
      confirmationId: reservationAuthority.confirmationId,
      consumptionId: reservationAuthority.execution.consumption.id,
      at: '2026-07-16T16:00:00.000Z'
    });
    assert(reservedInspection.consumption.state === 'reserved'
      && reservedInspection.consumption.checkpointId === reservationAuthority.checkpointId
      && reservedInspection.checkpoint === null
      && reservedInspection.resume.classification === 'safe'
      && reservedInspection.resume.reasonCode === 'CONFIGURATION_CONSUMPTION_RESERVED'
      && reservedInspection.resume.permittedNextAction === 'resume-start',
    'Expired reserved start crash window did not project exact re-entry guidance.');
    const reservationInspectionSchema = readJson(path.join(
      reservation,
      'soter/contracts/configuration-change-inspection.schema.json'
    ));
    const hostileReservedInspection = structuredClone(reservedInspection);
    hostileReservedInspection.resume = {
      classification: 'safe',
      reasonCode: 'CONFIGURATION_CONFIRMATION_CURRENT',
      reason: 'Hostile crossed guidance falsely advertises a fresh apply.',
      permittedNextAction: 'apply'
    };
    assert(validateJsonSchema(hostileReservedInspection, reservationInspectionSchema).length > 0,
      'Inspection schema accepted reserved consumption as fresh apply authority.');
    const resumedReservation = resumeConfigurationChangeExecution({
      root: reservation,
      confirmationId: reservationAuthority.confirmationId,
      checkpointId: reservationAuthority.checkpointId,
      at: '2026-07-16T16:00:00.000Z'
    });
    assert(resumedReservation.consumption.state === 'started'
      && resumedReservation.checkpoint.state === 'prepared',
    'Crash recovery did not resume the same reserved one-time configuration start.');
    const startedPreparedInspection = inspectConfigurationChange({
      root: reservation,
      planId: reservationAuthority.planId,
      consumptionId: reservationAuthority.execution.consumption.id,
      checkpointId: reservationAuthority.checkpointId,
      at: '2026-07-16T16:00:00.000Z'
    });
    const startedPreparedWithPlanResume = structuredClone(startedPreparedInspection);
    startedPreparedWithPlanResume.resume = {
      classification: 'safe',
      reasonCode: 'CONFIGURATION_PLAN_CURRENT',
      reason: 'The exact configuration plan is current and may be submitted for confirmation.',
      permittedNextAction: 'request-confirmation'
    };
    assert(validateJsonSchema(startedPreparedInspection, reservationInspectionSchema).length === 0
      && validateJsonSchema(
        startedPreparedWithPlanResume,
        reservationInspectionSchema
      ).length > 0,
    'Inspection schema accepted started prepared checkpoint state with exact plan guidance.');
    fs.rmSync(reservationCheckpointPath);
    const missingStartedCheckpointInspection = inspectConfigurationChange({
      root: reservation,
      planId: reservationAuthority.planId,
      consumptionId: reservationAuthority.execution.consumption.id,
      at: '2026-07-16T16:00:00.000Z'
    });
    assert(missingStartedCheckpointInspection.consumption.state === 'started'
      && missingStartedCheckpointInspection.checkpoint === null
      && missingStartedCheckpointInspection.resume.classification === 'requires-review'
      && missingStartedCheckpointInspection.resume.reasonCode === 'CONFIGURATION_CHECKPOINT_MISSING'
      && missingStartedCheckpointInspection.resume.permittedNextAction === 'none',
    'Started consumption with a missing checkpoint falsely projected fresh apply authority.');
    assert(validateJsonSchema(
      missingStartedCheckpointInspection,
      reservationInspectionSchema
    ).length === 0,
      'Inspection schema rejected the intentional consumed-start missing-checkpoint state.');
    const hostileMissingCheckpointInspection = structuredClone(
      missingStartedCheckpointInspection
    );
    hostileMissingCheckpointInspection.resume = {
      classification: 'safe',
      reasonCode: 'CONFIGURATION_CONFIRMATION_CURRENT',
      reason: 'Hostile crossed guidance falsely advertises a fresh apply.',
      permittedNextAction: 'apply'
    };
    assert(validateJsonSchema(
      hostileMissingCheckpointInspection,
      reservationInspectionSchema
    ).length > 0,
      'Inspection schema accepted started consumption with no checkpoint as apply authority.');

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

    const unavailableBaseline = copyRoot(root, 'soter-configuration-unavailable-baseline-');
    roots.push(unavailableBaseline);
    const unavailableAdapterPath = path.join(
      unavailableBaseline,
      'soter/hosts/codex/adapter.json'
    );
    const currentAdapter = readJson(unavailableAdapterPath);
    const historicalAdapter = { ...currentAdapter, version: '0.3.1' };
    const unavailableConfigurationsDirectory = path.join(
      unavailableBaseline,
      'soter/configurations'
    );
    const currentCodexConfigurations = fs.readdirSync(unavailableConfigurationsDirectory)
      .filter((name) => name.endsWith('.config.json'))
      .flatMap((name) => {
        const file = path.join(unavailableConfigurationsDirectory, name);
        const configuration = readJson(file);
        return configuration.host?.id === 'codex'
          && configuration.host?.adapter === currentAdapter.id
          && configuration.host?.version === currentAdapter.version
          ? [{ file, configuration }]
          : [];
      });
    for (const entry of currentCodexConfigurations) {
      writeJson(entry.file, {
        ...entry.configuration,
        host: { ...entry.configuration.host, version: historicalAdapter.version }
      });
    }
    writeJson(unavailableAdapterPath, historicalAdapter);
    const unavailableTemplatePath = path.join(
      unavailableBaseline,
      'soter/configurations/meeting-intake.config.json'
    );
    const historicalDesired = readJson(unavailableTemplatePath);
    historicalDesired.host.version = historicalAdapter.version;
    writePrivateConfigurationState(
      unavailableBaseline,
      'meeting-intake',
      historicalDesired
    );
    const unavailableDesiredPath = privateConfigurationStatePath(
      unavailableBaseline,
      'meeting-intake'
    );
    const historicalUnavailableLock = resolveConfiguration({
      root: unavailableBaseline,
      configPath: unavailableDesiredPath
    });
    writeActiveConfigurationLockState(
      unavailableBaseline,
      'meeting-intake',
      historicalUnavailableLock
    );
    writeJson(unavailableAdapterPath, currentAdapter);
    for (const entry of currentCodexConfigurations) {
      writeJson(entry.file, entry.configuration);
    }
    const currentUnavailableCandidate = readJson(unavailableTemplatePath);
    const malformedHistoricalDesired = structuredClone(historicalDesired);
    delete malformedHistoricalDesired.host.reason;
    const malformedHistoricalLock = structuredClone(historicalUnavailableLock);
    malformedHistoricalLock.configuration.fingerprint = fingerprintJson(
      malformedHistoricalDesired
    );
    delete malformedHistoricalLock.graphFingerprint;
    malformedHistoricalLock.graphFingerprint = fingerprintJson(malformedHistoricalLock);
    writePrivateConfigurationState(
      unavailableBaseline,
      'meeting-intake',
      malformedHistoricalDesired
    );
    writeActiveConfigurationLockState(
      unavailableBaseline,
      'meeting-intake',
      malformedHistoricalLock
    );
    let malformedHistoricalDesiredRejected = false;
    try {
      prepareConfigurationChange({
        root: unavailableBaseline,
        name: 'meeting-intake',
        candidateConfiguration: currentUnavailableCandidate,
        id: 'configuration-change-plan.malformed-unavailable-baseline-selftest',
        createdAt: CREATED
      });
    } catch (error) {
      malformedHistoricalDesiredRejected
        = error.code === 'CONFIGURATION_PRIVATE_STATE_INVALID';
    }
    assert(malformedHistoricalDesiredRejected,
      'A malformed historical desired document was accepted as an upgrade baseline.');
    writePrivateConfigurationState(
      unavailableBaseline,
      'meeting-intake',
      historicalDesired
    );
    writeActiveConfigurationLockState(
      unavailableBaseline,
      'meeting-intake',
      historicalUnavailableLock
    );
    const unavailableAuthority = prepareAuthority(
      unavailableBaseline,
      'unavailable-baseline-selftest',
      currentUnavailableCandidate
    );
    const unavailablePlan = unavailableAuthority.prepared.plan;
    const unavailableHostChange = unavailablePlan.changes.find(
      (change) => change.id === 'configuration-change.host.adapter'
    );
    const unavailablePreparedInspection = inspectConfigurationChange({
      root: unavailableBaseline,
      planId: unavailableAuthority.planId,
      checkpointId: unavailableAuthority.checkpointId,
      at: APPLIED
    });
    assert(unavailablePlan.configuration.currentLockFingerprint
        === fingerprintLock(historicalUnavailableLock)
      && unavailablePlan.priorActiveLock.fingerprint
        === fingerprintLock(historicalUnavailableLock)
      && unavailableHostChange?.state === 'changed'
      && unavailableHostChange.beforeFingerprint === fingerprintJson(historicalDesired.host)
      && unavailableHostChange.afterFingerprint === fingerprintJson(currentUnavailableCandidate.host)
      && unavailablePreparedInspection.configuration.applicability === 'current'
      && unavailablePreparedInspection.configuration.observedLockFingerprint
        === fingerprintLock(historicalUnavailableLock)
      && unavailablePreparedInspection.configuration.observedResolution.state === 'unavailable'
      && unavailablePreparedInspection.configuration.observedResolution.fingerprint === null,
    'An unavailable exact historical resolution was not preserved as the reviewed rollback baseline.');
    const completedUnavailableUpgrade = executeConfigurationChange({
      root: unavailableBaseline,
      checkpointId: unavailableAuthority.checkpointId,
      at: APPLIED
    });
    const unavailableInspection = inspectConfigurationChange({
      root: unavailableBaseline,
      planId: unavailableAuthority.planId,
      checkpointId: unavailableAuthority.checkpointId,
      at: APPLIED
    });
    assert(completedUnavailableUpgrade.state === 'completed'
      && unavailableInspection.configuration.applicability === 'applied'
      && unavailableInspection.configuration.observedLockFingerprint
        === unavailablePlan.configuration.candidateLockFingerprint
      && unavailableInspection.configuration.observedResolution.state === 'resolved'
      && unavailableInspection.configuration.observedResolution.fingerprint
        === unavailablePlan.configuration.candidateLockFingerprint
      && readPrivateConfigurationState(unavailableBaseline, 'meeting-intake')
        .configuration.host.version === currentAdapter.version
      && fingerprintLock(readJson(activeConfigurationLockStatePath(
        unavailableBaseline,
        'meeting-intake'
      ))) === unavailablePlan.configuration.candidateLockFingerprint,
    'The governed configuration upgrade did not replace an unavailable historical resolution exactly.');

    const mismatchedPrivateBaseline = prepareConfigurationChange({
      root: unavailableBaseline,
      name: 'meeting-intake',
      candidateConfiguration: candidate(unavailableBaseline, 'mismatched-private-baseline'),
      id: 'configuration-change-plan.mismatched-private-baseline-selftest',
      createdAt: CREATED
    });
    const mismatchedPrivateBaselinePath = configurationChangePlanStatePath(
      unavailableBaseline,
      mismatchedPrivateBaseline.plan.id
    );
    const mismatchedPrivateBaselinePlan = readJson(mismatchedPrivateBaselinePath);
    const alternativeHistoricalLock = historicalActiveLock(
      mismatchedPrivateBaselinePlan.currentLock
    );
    mismatchedPrivateBaselinePlan.priorActiveLock = {
      state: 'present',
      fingerprint: fingerprintLock(alternativeHistoricalLock),
      lock: alternativeHistoricalLock
    };
    reseal(mismatchedPrivateBaselinePlan, 'planFingerprint');
    writeJson(mismatchedPrivateBaselinePath, mismatchedPrivateBaselinePlan);
    let mismatchedPrivateBaselineRejected = false;
    try {
      inspectConfigurationChange({
        root: unavailableBaseline,
        planId: mismatchedPrivateBaseline.plan.id,
        at: APPLIED
      });
    } catch (error) {
      mismatchedPrivateBaselineRejected = error.code === 'CONFIGURATION_PLAN_TAMPERED';
    }
    assert(mismatchedPrivateBaselineRejected,
      'A re-sealed private plan with different current and rollback locks was accepted.');

    const unavailableRecovery = copyRoot(
      unavailableBaseline,
      'soter-configuration-unavailable-recovery-'
    );
    roots.push(unavailableRecovery);
    writePrivateConfigurationState(
      unavailableRecovery,
      'meeting-intake',
      historicalDesired
    );
    writeActiveConfigurationLockState(
      unavailableRecovery,
      'meeting-intake',
      historicalUnavailableLock
    );
    const unavailableRecoveryAuthority = prepareAuthority(
      unavailableRecovery,
      'unavailable-recovery-selftest',
      readJson(path.join(
        unavailableRecovery,
        'soter/configurations/meeting-intake.config.json'
      ))
    );
    const unknownUnavailableState = structuredClone(historicalDesired);
    unknownUnavailableState.host.reason
      = 'An ambiguous partial upgrade must restore the exact historical private baseline.';
    writePrivateConfigurationState(
      unavailableRecovery,
      'meeting-intake',
      unknownUnavailableState
    );
    const rolledBackUnavailable = recoverConfigurationChange({
      root: unavailableRecovery,
      checkpointId: unavailableRecoveryAuthority.checkpointId,
      at: APPLIED
    });
    const rolledBackUnavailableInspection = inspectConfigurationChange({
      root: unavailableRecovery,
      planId: unavailableRecoveryAuthority.planId,
      checkpointId: unavailableRecoveryAuthority.checkpointId,
      at: APPLIED
    });
    assert(rolledBackUnavailable.state === 'rolled-back'
      && rolledBackUnavailable.observation.resolutionFingerprint === null
      && fingerprintJson(readPrivateConfigurationState(
        unavailableRecovery,
        'meeting-intake'
      ).configuration) === fingerprintJson(historicalDesired)
      && fingerprintLock(readJson(activeConfigurationLockStatePath(
        unavailableRecovery,
        'meeting-intake'
      ))) === fingerprintLock(historicalUnavailableLock)
      && rolledBackUnavailableInspection.checkpoint.state === 'rolled-back'
      && rolledBackUnavailableInspection.configuration.applicability === 'current'
      && rolledBackUnavailableInspection.configuration.observedLockFingerprint
        === fingerprintLock(historicalUnavailableLock)
      && rolledBackUnavailableInspection.configuration.observedResolution.state === 'unavailable'
      && rolledBackUnavailableInspection.configuration.observedResolution.fingerprint === null,
    'Ambiguous upgrade recovery did not restore and truthfully inspect the unavailable baseline.');

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
      && refreshPlan.plan.priorActiveLock.fingerprint
        !== refreshPlan.plan.configuration.candidateLockFingerprint
      && refreshPlan.plan.configuration.currentLockFingerprint
        === fingerprintLock(historicalRefreshLock)
      && preparedRefreshInspection.configuration.baselineLockFingerprint
        === fingerprintLock(historicalRefreshLock)
      && preparedRefreshInspection.configuration.observedLockFingerprint
        === fingerprintLock(historicalRefreshLock)
      && preparedRefreshInspection.configuration.observedResolution.state === 'resolved'
      && preparedRefreshInspection.configuration.observedResolution.fingerprint
        === refreshPlan.plan.configuration.candidateLockFingerprint
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
      && missingActiveInspection.configuration.observedLockFingerprint === null
      && missingActiveInspection.configuration.observedResolution.state === 'resolved'
      && missingActiveInspection.configuration.observedResolution.fingerprint
        === refreshPlan.plan.configuration.candidateLockFingerprint,
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
      && refreshInspection.configuration.observedResolution.state === 'resolved'
      && refreshInspection.configuration.observedResolution.fingerprint
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
      needsAttentionCheckpoint.failure.summary
        = 'HOSTILE_PRIVATE_PATH_SENTINEL /Users/private/secrets.json';
      reseal(needsAttentionCheckpoint, 'checkpointFingerprint');
      writeJson(failedRollbackCheckpointFile, needsAttentionCheckpoint);
      const needsAttentionInspection = inspectConfigurationChange({
        root: refreshed,
        planId: failedRollbackAuthority.planId,
        consumptionId: failedRollbackAuthority.execution.consumption.id,
        checkpointId: failedRollbackAuthority.checkpointId,
        at: APPLIED
      });
      assert(needsAttentionInspection.resume.classification === 'requires-review'
        && needsAttentionInspection.resume.reasonCode
          === 'CONFIGURATION_CHECKPOINT_REQUIRES_REVIEW'
        && needsAttentionInspection.resume.reason
          === 'The exact durable configuration checkpoint requires local operator review.'
        && needsAttentionInspection.resume.permittedNextAction === 'inspect-checkpoint'
        && !JSON.stringify(needsAttentionInspection).includes('HOSTILE_PRIVATE_PATH_SENTINEL')
        && !JSON.stringify(needsAttentionInspection).includes('/Users/private'),
      'Sanitized checkpoint inspection exposed a persisted private failure summary.');
      const needsAttentionWithSafeResume = structuredClone(needsAttentionInspection);
      needsAttentionWithSafeResume.resume = {
        classification: 'safe',
        reasonCode: 'CONFIGURATION_CHECKPOINT_RECOVERABLE',
        reason: 'Core can inspect and reconcile the exact durable configuration checkpoint.',
        permittedNextAction: 'inspect-checkpoint'
      };
      assert(validateJsonSchema(
        needsAttentionWithSafeResume,
        reservationInspectionSchema
      ).length > 0,
      'Inspection schema accepted needs-attention checkpoint state with exact safe guidance.');
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
